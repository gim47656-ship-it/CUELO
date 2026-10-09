import { parseMarkdown, plainText, type Block, type ListItem, type Run } from "./markdown";
import { zip } from "./zip";

// draft의 xlsx·docx 작성기. 외부 패키지 없이 최소 OOXML 부품만 만든다.
// 공통 글꼴은 한글이 깨지지 않는 맑은 고딕이다.

const FONT = "Malgun Gothic";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// XML 1.0이 허용하지 않는 제어 문자와 외톨이 surrogate는 지운다(Excel·Word가 파일 전체를 거부한다).
const INVALID_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(text: string): string {
  return text.replace(INVALID_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV를 엄격히 파싱한다. 따옴표 불일치나 행마다 다른 열 수는 오류다. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      if (src[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false; afterQuote = true; continue;
    }
    if (ch === ",") { row.push(field); field = ""; afterQuote = false; continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = ""; afterQuote = false; continue;
    }
    if (afterQuote) throw new Error(`CSV ${rows.length + 1}행: 닫는 따옴표 뒤에 문자 "${ch}"가 있습니다.`);
    if (ch === '"') {
      if (field) throw new Error(`CSV ${rows.length + 1}행: 값 중간에 따옴표가 있습니다.`);
      quoted = true; continue;
    }
    field += ch;
  }
  if (quoted) throw new Error("CSV: 닫히지 않은 따옴표가 있습니다.");
  if (field || row.length || afterQuote) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((cells) => !(cells.length === 1 && cells[0] === ""));
  if (!nonEmpty.length) throw new Error("CSV가 비어 있습니다.");
  const width = nonEmpty[0]!.length;
  const bad = nonEmpty.findIndex((cells) => cells.length !== width);
  if (bad >= 0) throw new Error(`CSV ${bad + 1}행의 열 수(${nonEmpty[bad]!.length})가 첫 행(${width})과 다릅니다.`);
  return nonEmpty;
}

// ---------------------------------------------------------------- XLSX

export type Cell = string | number | boolean | null;
export interface Sheet { name: string; header: boolean; rows: Cell[][] }

/** 모델이 낸 JSON 통합 문서를 검증해 정규화한다. 시트 이름은 Excel 규칙에 맞게 고친다. */
export function parseWorkbook(text: string): Sheet[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) {
    throw new Error(`xlsx JSON 파싱 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sheets = data && typeof data === "object" && "sheets" in data ? data.sheets : undefined;
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('xlsx JSON에 "sheets" 배열이 없습니다.');
  const used = new Set<string>();
  return sheets.map((sheet: unknown, index) => {
    if (!sheet || typeof sheet !== "object" || !("rows" in sheet) || !Array.isArray(sheet.rows)) throw new Error(`xlsx 시트 ${index + 1}에 "rows" 배열이 없습니다.`);
    const rows = sheet.rows.map((row: unknown, r) => {
      if (!Array.isArray(row)) throw new Error(`xlsx 시트 ${index + 1}의 ${r + 1}행이 배열이 아닙니다.`);
      return row.map((cell: unknown, c): Cell => {
        if (cell === null || cell === "") return null;
        if (typeof cell === "number" || typeof cell === "boolean") return cell;
        // Excel 셀 한도. 조용히 자르지 않고 시도 실패로 돌린다.
        if (typeof cell === "string" && cell.length <= 32_767) return cell;
        throw new Error(`xlsx 시트 ${index + 1} ${r + 1}행 ${c + 1}열: 32767자 이하 문자열·숫자·불리언·null만 허용됩니다.`);
      });
    });
    const rawName = "name" in sheet && typeof sheet.name === "string" ? sheet.name : "";
    let name = rawName.replace(/[[\]:*?/\\]/g, "_").replace(/^'+|'+$/g, "").trim().slice(0, 31);
    if (!name || name.toLowerCase() === "history") name = `Sheet${index + 1}`;
    for (let n = 2, base = name; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)}_${n}`;
    used.add(name.toLowerCase());
    return { name, header: !("header" in sheet && sheet.header === false), rows };
  });
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** 한글·전각 문자는 두 칸으로 센 표시 폭. 열 너비 추정에만 쓴다. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return width;
}

function sheetXml(sheet: Sheet): string {
  const widths: number[] = [];
  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      if (cell === null) return "";
      const ref = `${columnName(c)}${r + 1}`;
      const style = sheet.header && r === 0 ? ' s="1"' : "";
      const shown = typeof cell === "string" ? cell.split("\n").reduce((max, line) => Math.max(max, displayWidth(line)), 0) : String(cell).length;
      widths[c] = Math.max(widths[c] ?? 0, shown);
      if (typeof cell === "number") return `<c r="${ref}"${style}><v>${cell}</v></c>`;
      if (typeof cell === "boolean") return `<c r="${ref}"${style} t="b"><v>${cell ? 1 : 0}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const cols = widths.length
    ? `<cols>${widths.map((width, c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, Math.max(8, (width || 0) + 2))}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const pane = sheet.header && sheet.rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : "";
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

export function xlsx(sheets: readonly Sheet[]): Buffer {
  const sheetTypes = sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
  return zip([
    { name: "[Content_Types].xml", data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetTypes}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
      sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    }<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "xl/styles.xml", data: `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="${FONT}"/><family val="3"/><charset val="129"/></font><font><b/><sz val="11"/><name val="${FONT}"/><family val="3"/><charset val="129"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) })),
  ]);
}

// ---------------------------------------------------------------- DOCX

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const TEXT_WIDTH = 9026; // A4 너비 11906 - 좌우 여백 1440×2 (twip)

function runXml(run: Run, extra = ""): string {
  const props = `${run.bold ? "<w:b/>" : ""}${run.italic ? "<w:i/>" : ""}${run.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ""}${run.href ? '<w:color w:val="0563C1"/><w:u w:val="single"/>' : ""}${extra}`;
  const text = run.href && run.href !== run.text ? `${run.text} (${run.href})` : run.text;
  const body = text.split("\n").map((part) => `<w:t xml:space="preserve">${escapeXml(part)}</w:t>`).join("<w:br/>");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
}

function paragraph(runs: readonly Run[], props = "", runProps = ""): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}${runs.map((run) => runXml(run, runProps)).join("")}</w:p>`;
}

function tableXml(block: Extract<Block, { kind: "table" }>): string {
  const columns = Math.max(1, block.header.length);
  const width = Math.floor(TEXT_WIDTH / columns);
  const cell = (runs: Run[], header: boolean) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' : ""}</w:tcPr>${
    paragraph(runs, '<w:spacing w:after="0"/>', header ? "<w:b/>" : "")}</w:tc>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${
    `<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr>${block.header.map((runs) => cell(runs, true)).join("")}</w:tr>${
    block.rows.map((row) => `<w:tr>${row.map((runs) => cell(runs, false)).join("")}</w:tr>`).join("")}</w:tbl><w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>`;
}

function listXml(items: readonly ListItem[], bulletId: number, orderedId: number): string {
  return items.map((item) => paragraph(item.runs,
    `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${item.ordered ? orderedId : bulletId}"/></w:numPr>`)).join("");
}

function stylesXml(): string {
  const headingSizes = [32, 28, 26, 24, 22, 22];
  const headings = headingSizes.map((size, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${i === 0 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`).join("");
  return `${XML_HEAD}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${headings}`
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="284"/></w:pPr><w:rPr><w:color w:val="404040"/></w:rPr></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="808080"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="808080"/></w:tblBorders></w:tblPr></w:style>'
    + "</w:styles>";
}

function numberingXml(lists: number): string {
  const level = (i: number, format: string, text: string) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + 360 * i}" w:hanging="360"/></w:pPr></w:lvl>`;
  const bullets = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "bullet", "•")}${level(1, "bullet", "◦")}${level(2, "bullet", "▪")}</w:abstractNum>`;
  const ordered = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "decimal", "%1.")}${level(1, "lowerLetter", "%2.")}${level(2, "lowerRoman", "%3.")}</w:abstractNum>`;
  let nums = "";
  // 목록 블록마다 번호 인스턴스를 따로 두어 번호가 1부터 다시 시작하게 한다.
  for (let i = 0; i < lists; i++) {
    nums += `<w:num w:numId="${2 * i + 1}"><w:abstractNumId w:val="0"/></w:num>`;
    nums += `<w:num w:numId="${2 * i + 2}"><w:abstractNumId w:val="1"/>${[0, 1, 2].map((l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="1"/></w:lvlOverride>`).join("")}</w:num>`;
  }
  return `${XML_HEAD}<w:numbering xmlns:w="${W}">${bullets}${ordered}${nums}</w:numbering>`;
}

export function docx(markdown: string, title: string): { file: Buffer; blocks: Block[] } {
  const blocks = parseMarkdown(markdown);
  let lists = 0;
  const body = blocks.map((block) => {
    switch (block.kind) {
      case "heading": return paragraph(block.runs, `<w:pStyle w:val="Heading${block.level}"/>`);
      case "paragraph": return paragraph(block.runs);
      case "list": { lists++; return listXml(block.items, 2 * lists - 1, 2 * lists); }
      case "table": return tableXml(block);
      case "code": return block.lines.map((line) => paragraph(line ? [{ text: line }] : [], '<w:pStyle w:val="Code"/>')).join("");
      case "quote": return paragraph(block.runs, '<w:pStyle w:val="Quote"/>');
      case "rule": return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A6A6A6"/></w:pBdr></w:pPr></w:p>';
    }
  }).join("");
  const docTitle = escapeXml(title || plainText(blocks.find((block) => block.kind === "heading")?.runs ?? []));
  const file = zip([
    { name: "[Content_Types].xml", data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: "docProps/core.xml", data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${docTitle}</dc:title></cp:coreProperties>` },
    { name: "word/_rels/document.xml.rels", data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>` },
    { name: "word/document.xml", data: `${XML_HEAD}<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>` },
    { name: "word/styles.xml", data: stylesXml() },
    { name: "word/numbering.xml", data: numberingXml(Math.max(1, lists)) },
  ]);
  return { file, blocks };
}
