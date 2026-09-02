import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)


def is_libreoffice_available() -> bool:
    return shutil.which("soffice") is not None or shutil.which("libreoffice") is not None


def _libreoffice_bin() -> str | None:
    for b in ("soffice", "libreoffice"):
        p = shutil.which(b)
        if p:
            return p
    return None


def convert_pptx_to_pdf(pptx_path: Path | str, dest_dir: Path | None = None) -> Path:
    """Convert PPTX to PDF via LibreOffice headless.

    Returns path to the generated PDF.
    Raises RuntimeError with a user-friendly message if LibreOffice is missing or conversion fails.
    """
    pptx_path = Path(pptx_path)
    if not pptx_path.exists():
        raise FileNotFoundError(f"PPTX not found: {pptx_path}")

    dest_dir = Path(dest_dir) if dest_dir else pptx_path.parent
    dest_dir.mkdir(parents=True, exist_ok=True)

    expected_pdf = dest_dir / f"{pptx_path.stem}.pdf"

    bin_path = _libreoffice_bin()
    if not bin_path:
        raise RuntimeError(
            "LibreOffice is not installed — PPTX preview requires it. "
            "Install LibreOffice (https://www.libreoffice.org/download/) and ensure 'soffice' is on PATH, "
            "or upload the slides as PDF instead. Text extraction for chat/search will still work without LibreOffice."
        )

    # Use a temp dir as output to avoid collisions, then move.
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        cmd = [
            bin_path,
            "--headless",
            "--nologo",
            "--nofirststartwizard",
            "--convert-to",
            "pdf",
            "--outdir",
            str(tmp_path),
            str(pptx_path),
        ]
        logger.info("Converting PPTX to PDF: %s", " ".join(cmd))
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"PPTX conversion timed out: {e}") from e
        except Exception as e:
            raise RuntimeError(f"PPTX conversion failed: {e}") from e

        if result.returncode != 0:
            logger.warning("LibreOffice conversion failed (%s): %s %s", result.returncode, result.stderr, result.stdout)
            raise RuntimeError(f"PPTX conversion failed (exit {result.returncode}): {result.stderr or result.stdout}")

        tmp_pdf = tmp_path / f"{pptx_path.stem}.pdf"
        if not tmp_pdf.exists():
            # Some versions produce lowercase
            candidates = list(tmp_path.glob("*.pdf"))
            if not candidates:
                raise RuntimeError(f"PPTX conversion produced no PDF: stdout={result.stdout} stderr={result.stderr}")
            tmp_pdf = candidates[0]

        # Move to dest
        if expected_pdf.exists():
            expected_pdf.unlink()
        shutil.move(str(tmp_pdf), str(expected_pdf))
        return expected_pdf
