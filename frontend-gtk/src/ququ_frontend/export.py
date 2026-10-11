"""转录历史导出 — txt / json（标准库），docx / pdf（可选依赖）。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _rows_to_plain(rows: list[dict[str, Any]]) -> str:
    lines = []
    for r in rows:
        lines.append(r.get("text", ""))
        if r.get("created_at"):
            lines.append(f"  [{r['created_at']}]")
    return "\n\n".join(lines)


def export(rows: list[dict[str, Any]], fmt: str, out_path: Path) -> Path:
    fmt = fmt.lower()
    if fmt == "txt":
        out_path.write_text(_rows_to_plain(rows), encoding="utf-8")
    elif fmt == "json":
        out_path.write_text(
            json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    elif fmt == "docx":
        _export_docx(rows, out_path)
    elif fmt == "pdf":
        _export_pdf(rows, out_path)
    else:
        raise ValueError(f"不支持的导出格式: {fmt}")
    return out_path


def _export_docx(rows: list[dict[str, Any]], out_path: Path) -> None:
    try:
        from docx import Document  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError("导出 docx 需要 python-docx，请 `uv add python-docx`") from e
    doc = Document()
    for r in rows:
        if r.get("text"):
            doc.add_paragraph(r["text"])
    doc.save(str(out_path))


def _export_pdf(rows: list[dict[str, Any]], out_path: Path) -> None:
    try:
        from reportlab.lib.pagesizes import A4  # noqa: PLC0415
        from reportlab.pdfbase import pdfmetrics  # noqa: PLC0415
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont  # noqa: PLC0415
        from reportlab.platypus import Paragraph, SimpleDocTemplate  # noqa: PLC0415
        from reportlab.lib.styles import ParagraphStyle  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError("导出 pdf 需要 reportlab，请 `uv add reportlab`") from e

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    doc = SimpleDocTemplate(str(out_path), pagesize=A4)
    style = ParagraphStyle("cn", fontName="STSong-Light", fontSize=11, leading=16)
    story = [Paragraph(r["text"], style) for r in rows if r.get("text")]
    doc.build(story)
