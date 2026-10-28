"""슬롭 게이트용 문서 텍스트 추출. 사용: python extract.py <path>. 표준 출력은 JSON {"text": ...} 한 줄이다.

관리 Python 환경(~/.omp/python-env)의 python-pptx·python-docx·openpyxl·pymupdf만 쓴다. hwpx는 zip 안 XML을 읽는다.
화면에 보이는 글만 뽑는다: 슬라이드·표·머리말·시트 셀·PDF 쪽 텍스트. 발표자 노트는 [notes]로 표시해 함께 싣는다.
"""
import json
import re
import sys
import zipfile
from pathlib import Path


def pptx_text(path):
    from pptx import Presentation

    out = []
    for number, slide in enumerate(Presentation(path).slides, 1):
        out.append(f"[slide {number}]")
        for shape in slide.shapes:
            if shape.has_text_frame:
                out.extend(p.text for p in shape.text_frame.paragraphs if p.text.strip())
            if getattr(shape, "has_table", False) and shape.has_table:
                for row in shape.table.rows:
                    out.append(" | ".join(cell.text for cell in row.cells))
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame.text.strip():
            out.append("[notes] " + slide.notes_slide.notes_text_frame.text)
    return "\n".join(out)


def docx_text(path):
    from docx import Document

    doc = Document(path)
    out = [p.text for p in doc.paragraphs if p.text.strip()]
    for table in doc.tables:
        for row in table.rows:
            out.append(" | ".join(cell.text for cell in row.cells))
    for section in doc.sections:
        for part in (section.header, section.footer):
            out.extend(p.text for p in part.paragraphs if p.text.strip())
    return "\n".join(out)


def xlsx_text(path):
    from openpyxl import load_workbook

    out = []
    for sheet in load_workbook(path, data_only=True, read_only=True).worksheets:
        out.append(f"[sheet {sheet.title}]")
        for row in sheet.iter_rows(values_only=True):
            cells = ["" if value is None else str(value) for value in row]
            if any(cell.strip() for cell in cells):
                out.append(" | ".join(cells))
    return "\n".join(out)


def pdf_text(path):
    import pymupdf

    with pymupdf.open(path) as doc:
        return "\n".join(f"[page {number}]\n{page.get_text()}" for number, page in enumerate(doc, 1))


def hwpx_text(path):
    out = []
    with zipfile.ZipFile(path) as archive:
        names = sorted(n for n in archive.namelist() if re.match(r"Contents/section\d+\.xml$", n))
        for name in names:
            xml = archive.read(name).decode("utf-8", "replace")
            for paragraph in re.findall(r"<hp:p\b.*?</hp:p>", xml, re.S):
                text = "".join(re.findall(r"<hp:t[^>]*>(.*?)</hp:t>", paragraph, re.S))
                text = re.sub(r"<[^>]+>", "", text)
                if text.strip():
                    out.append(text)
    return "\n".join(out)


READERS = {".pptx": pptx_text, ".docx": docx_text, ".xlsx": xlsx_text, ".pdf": pdf_text, ".hwpx": hwpx_text}

if __name__ == "__main__":
    target = sys.argv[1]
    reader = READERS.get(Path(target).suffix.lower())
    if reader is None:
        print(json.dumps({"error": f"unsupported format {Path(target).suffix}"}))
        sys.exit(2)
    print(json.dumps({"text": reader(target)}, ensure_ascii=False))
