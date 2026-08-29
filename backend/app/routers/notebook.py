import datetime
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..database import get_db
from ..kernel_manager import kernel_manager
from ..models import Book, Notebook, NotebookCell, Section
from ..schemas import NotebookCellCreate, NotebookCellOut, NotebookCellUpdate, NotebookOut

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["notebook"])


def _load_book(db: Session, book_id: int) -> Book:
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


def _get_or_create_notebook(db: Session, book_id: int, section_id: int | None = None) -> Notebook:
    _load_book(db, book_id)
    nb = db.scalar(select(Notebook).where(Notebook.book_id == book_id, Notebook.section_id == section_id))
    if nb is None:
        title = "Notebook"
        if section_id is not None:
            section = db.get(Section, section_id)
            if section is not None:
                title = section.title[:397]
            else:
                raise HTTPException(status_code=404, detail="Section not found")
        nb = Notebook(book_id=book_id, section_id=section_id, title=title)
        db.add(nb)
        db.commit()
        db.refresh(nb)
    return nb


def _load_notebook(db: Session, notebook_id: int) -> Notebook:
    nb = db.get(Notebook, notebook_id)
    if nb is None:
        raise HTTPException(status_code=404, detail="Notebook not found")
    return nb


def _load_cell(db: Session, notebook_id: int, cell_id: int) -> NotebookCell:
    cell = db.get(NotebookCell, cell_id)
    if cell is None or cell.notebook_id != notebook_id:
        raise HTTPException(status_code=404, detail="Cell not found")
    return cell


def _next_ord(db: Session, notebook_id: int) -> int:
    max_ord = db.scalar(
        select(NotebookCell.ord).where(NotebookCell.notebook_id == notebook_id).order_by(NotebookCell.ord.desc()).limit(1)
    )
    return (-1 if max_ord is None else max_ord) + 1


def _reorder(db: Session, notebook_id: int) -> None:
    cells = list(
        db.scalars(select(NotebookCell).where(NotebookCell.notebook_id == notebook_id).order_by(NotebookCell.ord))
    )
    for i, cell in enumerate(cells):
        cell.ord = i
    db.commit()


@router.get("/books/{book_id}/notebook", response_model=NotebookOut)
def get_notebook(book_id: int, db: Session = Depends(get_db)):
    nb = _get_or_create_notebook(db, book_id)
    cells = list(db.scalars(select(NotebookCell).where(NotebookCell.notebook_id == nb.id).order_by(NotebookCell.ord)))
    nb.cells = cells
    return nb


@router.get("/books/{book_id}/sections/{section_id}/notebook", response_model=NotebookOut)
def get_section_notebook(book_id: int, section_id: int, db: Session = Depends(get_db)):
    nb = _get_or_create_notebook(db, book_id, section_id)
    cells = list(db.scalars(select(NotebookCell).where(NotebookCell.notebook_id == nb.id).order_by(NotebookCell.ord)))
    nb.cells = cells
    return nb


@router.post("/notebooks/{notebook_id}/cells", response_model=NotebookCellOut, status_code=201)
def add_cell(notebook_id: int, body: NotebookCellCreate, db: Session = Depends(get_db)):
    _load_notebook(db, notebook_id)
    existing = list(
        db.scalars(select(NotebookCell).where(NotebookCell.notebook_id == notebook_id).order_by(NotebookCell.ord))
    )
    pos = len(existing)
    if body.after_cell_id is not None:
        after = db.get(NotebookCell, body.after_cell_id)
        if after is not None and after.notebook_id == notebook_id:
            pos = next((i for i, c in enumerate(existing) if c.id == after.id), len(existing)) + 1
    cell = NotebookCell(
        notebook_id=notebook_id,
        ord=pos,
        cell_type=body.cell_type if body.cell_type in ("code", "markdown") else "code",
        source=body.source,
        status="idle",
    )
    existing.insert(pos, cell)
    for i, c in enumerate(existing):
        c.ord = i
    db.add(cell)
    db.commit()
    db.refresh(cell)
    return cell


@router.patch("/notebooks/{notebook_id}/cells/{cell_id}", response_model=NotebookCellOut)
def update_cell(notebook_id: int, cell_id: int, body: NotebookCellUpdate, db: Session = Depends(get_db)):
    cell = _load_cell(db, notebook_id, cell_id)
    if body.cell_type is not None and body.cell_type in ("code", "markdown"):
        cell.cell_type = body.cell_type
    if body.source is not None:
        cell.source = body.source
        cell.output = None
        cell.error = None
        cell.status = "idle"
    db.commit()
    db.refresh(cell)
    return cell


@router.delete("/notebooks/{notebook_id}/cells/{cell_id}", status_code=204)
def delete_cell(notebook_id: int, cell_id: int, db: Session = Depends(get_db)):
    cell = _load_cell(db, notebook_id, cell_id)
    db.delete(cell)
    db.commit()
    _reorder(db, notebook_id)


@router.post("/notebooks/{notebook_id}/cells/{cell_id}/run", response_model=NotebookCellOut)
def run_cell(notebook_id: int, cell_id: int, db: Session = Depends(get_db)):
    cell = _load_cell(db, notebook_id, cell_id)

    prior = list(
        db.scalars(
            select(NotebookCell)
            .where(NotebookCell.notebook_id == notebook_id, NotebookCell.ord < cell.ord)
            .order_by(NotebookCell.ord)
        )
    )
    for p in prior:
        if p.cell_type == "code" and p.status == "idle" and not p.output:
            _run_one(db, kernel_manager, p)

    result = _run_one(db, kernel_manager, cell)
    db.refresh(cell)
    return cell


def _run_one(db: Session, km, cell: NotebookCell) -> dict:
    cell.status = "running"
    db.commit()
    try:
        result = km.run(cell.notebook_id, cell.source)
    except Exception as exc:
        logger.exception("Cell run failed for cell %s", cell.id)
        result = {"ok": False, "output": f"Kernel error: {exc}", "restarted": False, "elapsed_ms": 0, "images": [], "variables": []}
    cell.output = result.get("output", "")
    cell.error = None if result.get("ok") else cell.output
    cell.status = "done" if result.get("ok") else "error"
    if cell.cell_type == "code":
        cell.execution_count = (cell.execution_count or 0) + 1
        cell.elapsed_ms = result.get("elapsed_ms", 0)
        cell.last_executed_at = datetime.datetime.now(datetime.timezone.utc)
        cell.images = json.dumps(result.get("images", [])) if result.get("images") else None
        cell.variables = json.dumps(result.get("variables", [])) if result.get("variables") else None
    db.commit()
    return result


def _run_ordered(db: Session, cells: list[NotebookCell]) -> None:
    for c in cells:
        if c.cell_type != "code":
            continue
        _run_one(db, kernel_manager, c)


@router.post("/notebooks/{notebook_id}/run/all", response_model=list[NotebookCellOut])
def run_all(notebook_id: int, db: Session = Depends(get_db)):
    cells = list(
        db.scalars(
            select(NotebookCell)
            .where(NotebookCell.notebook_id == notebook_id)
            .order_by(NotebookCell.ord)
        )
    )
    _run_ordered(db, cells)
    db.commit()
    return cells


@router.post("/notebooks/{notebook_id}/cells/{cell_id}/run_above", response_model=NotebookCellOut)
def run_above(notebook_id: int, cell_id: int, db: Session = Depends(get_db)):
    cell = _load_cell(db, notebook_id, cell_id)
    above = list(
        db.scalars(
            select(NotebookCell)
            .where(NotebookCell.notebook_id == notebook_id, NotebookCell.ord < cell.ord)
            .order_by(NotebookCell.ord)
        )
    )
    _run_ordered(db, above)
    db.commit()
    db.refresh(cell)
    return cell


@router.post("/notebooks/{notebook_id}/cells/{cell_id}/run_below", response_model=NotebookCellOut)
def run_below(notebook_id: int, cell_id: int, db: Session = Depends(get_db)):
    cell = _load_cell(db, notebook_id, cell_id)
    below = list(
        db.scalars(
            select(NotebookCell)
            .where(NotebookCell.notebook_id == notebook_id, NotebookCell.ord >= cell.ord)
            .order_by(NotebookCell.ord)
        )
    )
    _run_ordered(db, below)
    db.commit()
    db.refresh(cell)
    return cell


@router.post("/notebooks/{notebook_id}/cells/{cell_id}/move", response_model=NotebookCellOut)
def move_cell(notebook_id: int, cell_id: int, direction: str = "up", db: Session = Depends(get_db)):
    cell = _load_cell(db, notebook_id, cell_id)
    cells = list(
        db.scalars(
            select(NotebookCell)
            .where(NotebookCell.notebook_id == notebook_id)
            .order_by(NotebookCell.ord)
        )
    )
    idx = next((i for i, c in enumerate(cells) if c.id == cell_id), -1)
    if idx < 0:
        raise HTTPException(status_code=404, detail="Cell not found")
    swap = idx - 1 if direction == "up" else idx + 1
    if 0 <= swap < len(cells):
        cells[idx].ord, cells[swap].ord = cells[swap].ord, cells[idx].ord
        db.commit()
    _reorder(db, notebook_id)
    db.refresh(cell)
    return cell


@router.post("/notebooks/{notebook_id}/cells/{cell_id}/duplicate", response_model=NotebookCellOut, status_code=201)
def duplicate_cell(notebook_id: int, cell_id: int, db: Session = Depends(get_db)):
    cell = _load_cell(db, notebook_id, cell_id)
    db.execute(
        update(NotebookCell)
        .where(NotebookCell.notebook_id == notebook_id, NotebookCell.ord > cell.ord)
        .values(ord=NotebookCell.ord + 1)
    )
    dup = NotebookCell(
        notebook_id=notebook_id,
        ord=cell.ord + 1,
        cell_type=cell.cell_type,
        source=cell.source,
        status="idle",
    )
    db.add(dup)
    db.commit()
    _reorder(db, notebook_id)
    db.refresh(dup)
    return dup


@router.post("/notebooks/{notebook_id}/restart")
def restart_notebook(notebook_id: int, db: Session = Depends(get_db)):
    _load_notebook(db, notebook_id)
    kernel_manager.reset(notebook_id)
    db.execute(
        update(NotebookCell)
        .where(NotebookCell.notebook_id == notebook_id)
        .values(status="idle", output=None, error=None, execution_count=0, elapsed_ms=0, last_executed_at=None, images=None, variables=None)
    )
    db.commit()
    cells = list(
        db.scalars(
            select(NotebookCell)
            .where(NotebookCell.notebook_id == notebook_id)
            .order_by(NotebookCell.ord)
        )
    )
    _run_ordered(db, cells)
    db.commit()
    return {"ok": True} if not cells else cells


@router.post("/notebooks/{notebook_id}/reset")
def reset_notebook(notebook_id: int, db: Session = Depends(get_db)):
    _load_notebook(db, notebook_id)
    kernel_manager.reset(notebook_id)
    db.execute(
        update(NotebookCell)
        .where(NotebookCell.notebook_id == notebook_id)
        .values(status="idle", output=None, error=None)
    )
    db.commit()
    return {"ok": True}
