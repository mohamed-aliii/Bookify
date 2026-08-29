import base64
import json
import logging
import queue
import subprocess
import sys
import threading
import time

logger = logging.getLogger(__name__)

SAFE_PATTERNS = [
    "import os",
    "import subprocess",
    "import shutil",
    "import sys",
    "os.system",
    "eval(",
    "exec(",
    "__import__",
    "importlib",
    "ctypes",
    "socket",
    "requests",
    "urllib",
    "__subclasses__",
    "__globals__",
    "__bases__",
    "getattr(",
    "setattr(",
    "input(",
]

CELL_TIMEOUT_SECONDS = 5

_WORKER_SCRIPT = r"""
import base64
import contextlib
import io
import json
import sys
import time

try:
    import matplotlib
    matplotlib.use("Agg")
except Exception:
    matplotlib = None

_ns = {"__name__": "__main__"}


def _capture_images():
    if matplotlib is None:
        return []
    try:
        import matplotlib.pyplot as plt
        images = []
        for num in plt.get_fignums():
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            buf.seek(0)
            import base64 as _b64
            images.append({
                "mime": "image/png",
                "data": _b64.b64encode(buf.read()).decode("ascii"),
                "width": int(fig.get_figwidth() * fig.dpi),
            })
        plt.close("all")
        return images
    except Exception:
        return []


def _capture_variables():
    out = []
    for name, val in _ns.items():
        if name.startswith("_"):
            continue
        if name in ("__name__", "__builtins__"):
            continue
        try:
            typ = type(val).__name__
        except Exception:
            typ = "?"
        rep = repr(val)
        if len(rep) > 120:
            rep = rep[:117] + "..."
        out.append({"name": name, "type": typ, "value": rep})
    return out


for _line in sys.stdin:
    _line = _line.strip()
    if not _line:
        continue
    _payload = json.loads(base64.b64decode(_line).decode("utf-8"))
    _seq = _payload["seq"]
    _code = _payload["code"]
    _out = io.StringIO()
    _ok = True
    _start = time.monotonic()
    try:
        with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out):
            exec(compile(_code, "<cell>", "exec"), _ns)
        sys.stdout.flush()
    except Exception as _e:
        _ok = False
        _out.write(f"{type(_e).__name__}: {_e}\n")
    _elapsed_ms = int((time.monotonic() - _start) * 1000)
    _result = {
        "seq": _seq,
        "ok": _ok,
        "output": _out.getvalue(),
        "elapsed_ms": _elapsed_ms,
        "images": _capture_images(),
        "variables": _capture_variables(),
    }
    sys.stdout.write(base64.b64encode(
        json.dumps(_result).encode("utf-8")
    ).decode("ascii") + "\n")
    sys.stdout.flush()
"""

_SENTINEL_TIMEOUT = 10


class _Kernel:
    def __init__(self, proc: subprocess.Popen, queue: "queue.Queue"):
        self.proc = proc
        self.queue = queue


class KernelManager:
    """Manages one long-lived Python interpreter process per notebook."""

    def __init__(self) -> None:
        self._kernels: dict[int, _Kernel] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _reader(proc: subprocess.Popen, q: "queue.Queue") -> None:
        try:
            for line in proc.stdout:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    payload = json.loads(base64.b64decode(stripped).decode("utf-8"))
                except Exception:
                    continue
                q.put(payload)
        except Exception:
            pass

    def _start(self, notebook_id: int) -> _Kernel:
        proc = subprocess.Popen(
            [sys.executable, "-I", "-u", "-c", _WORKER_SCRIPT],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        q = queue.Queue()
        thread = threading.Thread(target=self._reader, args=(proc, q), daemon=True)
        thread.start()
        kernel = _Kernel(proc, q)
        self._kernels[notebook_id] = kernel
        return kernel

    def _check_safe(self, code: str) -> str | None:
        for pattern in SAFE_PATTERNS:
            if pattern in code:
                return f"Code contains restricted pattern: {pattern}"
        return None

    def run(self, notebook_id: int, code: str) -> dict:
        blocked = self._check_safe(code)
        if blocked:
            return {"ok": False, "output": blocked, "restarted": False, "elapsed_ms": 0, "images": [], "variables": []}

        with self._lock:
            kernel = self._kernels.get(notebook_id)
            if kernel is None or kernel.proc.poll() is not None:
                kernel = self._start(notebook_id)

            seq = f"{notebook_id}:{int(time.time() * 1000)}"
            payload = base64.b64encode(
                json.dumps({"seq": seq, "code": code}).encode("utf-8")
            ).decode("ascii")

            try:
                kernel.proc.stdin.write(payload + "\n")
                kernel.proc.stdin.flush()
                deadline = time.monotonic() + CELL_TIMEOUT_SECONDS + _SENTINEL_TIMEOUT
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError
                    try:
                        result = kernel.queue.get(timeout=remaining)
                    except queue.Empty:
                        raise TimeoutError
                    if not isinstance(result, dict) or result.get("seq") != seq:
                        continue
                    return {
                        "ok": bool(result.get("ok")),
                        "output": result.get("output", ""),
                        "restarted": False,
                        "elapsed_ms": result.get("elapsed_ms", 0),
                        "images": result.get("images", []),
                        "variables": result.get("variables", []),
                    }
            except (TimeoutError, BrokenPipeError):
                self._kill(notebook_id)
                return {
                    "ok": False,
                    "output": "Execution timed out (kernel restarted).",
                    "restarted": True,
                    "elapsed_ms": 0,
                    "images": [],
                    "variables": [],
                }
            except Exception as exc:
                self._kill(notebook_id)
                logger.exception("Kernel run failed for notebook %s", notebook_id)
                return {"ok": False, "output": f"Kernel error: {exc}", "restarted": True, "elapsed_ms": 0, "images": [], "variables": []}

    def _kill(self, notebook_id: int) -> None:
        kernel = self._kernels.pop(notebook_id, None)
        if kernel is None:
            return
        try:
            kernel.proc.kill()
        except Exception:
            pass
        try:
            kernel.proc.wait(timeout=2)
        except Exception:
            pass

    def reset(self, notebook_id: int) -> None:
        self._kill(notebook_id)

    def shutdown(self) -> None:
        for notebook_id in list(self._kernels.keys()):
            self._kill(notebook_id)


kernel_manager = KernelManager()
