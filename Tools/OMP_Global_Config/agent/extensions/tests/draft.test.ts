import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { draftDocument, type DraftCompletion } from "../draft";

const GEMINI = "google-antigravity/gemini-3.8-flash";
const DEEPSEEK = "b-ai/deepseek-v4.1-flash";
const directories: string[] = [];
const signal = new AbortController().signal;
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "draft-fixture-"));
  directories.push(cwd);
  return cwd;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context(cwd: string): ExtensionContext { return { cwd } as ExtensionContext; }

/** 중앙 디렉터리를 따라 ZIP 항목을 풀고 CRC를 대조한다. */
function unzip(file: Buffer): Map<string, string> {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = file.readUInt16LE(end + 10);
  let cursor = file.readUInt32LE(end + 16);
  const entries = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(file.readUInt32LE(cursor)).toBe(0x02014b50);
    const crc = file.readUInt32LE(cursor + 16);
    const packed = file.readUInt32LE(cursor + 20);
    const nameLength = file.readUInt16LE(cursor + 28);
    const extra = file.readUInt16LE(cursor + 30);
    const comment = file.readUInt16LE(cursor + 32);
    const local = file.readUInt32LE(cursor + 42);
    const name = file.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    expect(file.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
    const raw = inflateRawSync(file.subarray(start, start + packed));
    expect(Bun.hash.crc32(raw)).toBe(crc);
    entries.set(name, raw.toString("utf8"));
    cursor += 46 + nameLength + extra + comment;
  }
  return entries;
}

/** 의존성 없는 XML 정형성 검사: 태그 짝, 속성 문법, 엔티티, 맨 '<'·'&'를 본다. */
function assertWellFormed(xml: string, part: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  const stack: string[] = [];
  const markup = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let match: RegExpExecArray | null;
  let roots = 0;
  while ((match = markup.exec(body))) {
    const [, closing, name, , selfClosing, text, stray] = match;
    if (stray) throw new Error(`${part}: 잘못된 태그 near ${body.slice(match.index, match.index + 40)}`);
    if (text !== undefined) {
      if (!stack.length && text.trim()) throw new Error(`${part}: 루트 밖 텍스트`);
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text)) throw new Error(`${part}: 잘못된 엔티티`);
      continue;
    }
    if (closing) {
      if (stack.pop() !== name) throw new Error(`${part}: 닫는 태그 ${name} 불일치`);
    } else if (!selfClosing) {
      if (!stack.length) roots++;
      stack.push(name!);
    } else if (!stack.length) roots++;
  }
  if (stack.length) throw new Error(`${part}: 닫히지 않은 ${stack.join(",")}`);
  expect(roots).toBe(1);
}

function texts(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

describe("draft", () => {
  test("cwd 밖·절대·비밀·링크 경로와 기존 파일은 모델 호출 전에 거부하고 overwrite일 때만 덮어쓴다", async () => {
    const cwd = fixture();
    const outside = fixture();
    symlinkSync(outside, join(cwd, "linked"));
    writeFileSync(join(cwd, "report.md"), "OLD");
    let calls = 0;
    const complete: DraftCompletion = async () => { calls++; return "# 새 보고서\n\n본문"; };
    const refused: Array<[string, string]> = [
      ["../escape.md", "'..'"],
      [join(outside, "abs.md"), "상대 경로만"],
      ["C:/Users/x/abs.md", "상대 경로만"],
      [".env.md", "비밀·관리 경로"],
      ["secrets/plan.md", "비밀·관리 경로"],
      [".git/notes.md", "비밀·관리 경로"],
      ["linked/inner.md", "심볼릭 링크"],
      ["report.exe", "지원하지 않는 확장자"],
      ["report.md", "overwrite: true"],
    ];
    for (const [output, reason] of refused) {
      const result = await draftDocument({ instruction: "보고서", output }, context(cwd), signal, complete);
      expect(result.startsWith("model: none")).toBe(true);
      expect(result).toContain(reason);
    }
    expect(calls).toBe(0);
    expect(existsSync(join(outside, "inner.md"))).toBe(false);
    expect(readFileSync(join(cwd, "report.md"), "utf8")).toBe("OLD");

    const replaced = await draftDocument({ instruction: "보고서", output: "report.md", overwrite: true }, context(cwd), signal, complete);
    expect(replaced).toContain("저장: report.md");
    expect(replaced).toContain("덮어씀");
    expect(readFileSync(join(cwd, "report.md"), "utf8")).toBe("# 새 보고서\n\n본문\n");
    const nested = await draftDocument({ instruction: "보고서", output: "docs/new/plan.md" }, context(cwd), signal, complete);
    expect(nested).toContain("저장: docs/new/plan.md");
    expect(nested).toContain("- # 새 보고서");
  });

  test("Gemini 실패나 형식이 깨진 응답은 같은 prompt로 DeepSeek에 한 번만 넘기고, 둘 다 실패하면 저장하지 않는다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "facts.md"), "재고 12개");
    writeFileSync(join(cwd, ".env.local"), "PRIVATE_MARKER");
    const calls: Array<{ prompt: string; model: string }> = [];
    const brokenCsv: DraftCompletion = async (prompt, _ctx, _signal, model) => {
      calls.push({ prompt, model });
      return model === GEMINI ? 'a,b\n"unclosed,1\n' : "```csv\n품목,수량\n장갑,12\n```";
    };
    const csv = await draftDocument({ instruction: "재고표", output: "stock.csv", paths: ["facts.md", ".env.local"] }, context(cwd), signal, brokenCsv);
    expect(calls.map(({ model }) => model)).toEqual([GEMINI, DEEPSEEK]);
    expect(calls[0]!.prompt).toBe(calls[1]!.prompt);
    expect(calls[0]!.prompt).toContain("재고 12개");
    expect(calls[0]!.prompt).not.toContain("PRIVATE_MARKER");
    expect(csv.startsWith(`model: ${DEEPSEEK}`)).toBe(true);
    expect(csv).toContain("Gemini 실패: CSV: 닫히지 않은 따옴표가 있습니다.");
    expect(csv).toContain(".env.local: 비밀 경로 제외");
    expect(readFileSync(join(cwd, "stock.csv"), "utf8")).toBe("\uFEFF품목,수량\n장갑,12\n");

    const called: string[] = [];
    const failed = await draftDocument({ instruction: "요약", output: "summary.md" }, context(cwd), signal, async (_p, _c, _s, model) => {
      called.push(model);
      throw new Error(model === GEMINI ? "Gemini original 429" : "DeepSeek original 403");
    });
    expect(called).toEqual([GEMINI, DEEPSEEK]);
    expect(failed.startsWith("model: none")).toBe(true);
    expect(failed).toContain("Gemini 실패: Gemini original 429");
    expect(failed).toContain("DeepSeek 실패: DeepSeek original 403");
    expect(existsSync(join(cwd, "summary.md"))).toBe(false);
  });

  test("xlsx는 숫자·문자·불리언 셀과 고친 시트 이름을 담은 유효한 OOXML ZIP이다", async () => {
    const cwd = fixture();
    const workbook = { sheets: [
      { name: "구매/계획", header: true, rows: [["품목", "수량", "합격"], ["장갑 <L> & \"M\"", 200, true], ["비고", null, "없음"]] },
      { name: "구매/계획", rows: [["총액", 2090000]] },
    ] };
    const result = await draftDocument({ instruction: "구매 계획", output: "plan.xlsx" }, context(cwd), signal,
      async () => `\`\`\`json\n${JSON.stringify(workbook)}\n\`\`\``);
    expect(result).toContain(`model: ${GEMINI}`);
    expect(result).toContain('시트 "구매_계획": 3행 × 3열');
    const parts = unzip(readFileSync(join(cwd, "plan.xlsx")));
    expect([...parts.keys()][0]).toBe("[Content_Types].xml");
    for (const [name, xml] of parts) assertWellFormed(xml, name);
    expect(parts.get("xl/workbook.xml")).toContain('name="구매_계획"');
    expect(parts.get("xl/workbook.xml")).toContain('name="구매_계획_2"');
    const sheet = parts.get("xl/worksheets/sheet1.xml")!;
    expect(texts(sheet, "t")).toEqual(["품목", "수량", "합격", "장갑 <L> & \"M\"", "비고", "없음"]);
    expect(sheet).toContain('<c r="B2"><v>200</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).not.toContain('r="B3"');
    expect(parts.get("xl/worksheets/sheet2.xml")).toContain("<v>2090000</v>");
  });

  test("docx는 Markdown 제목·서식·목록·표·코드를 WordprocessingML로 옮긴 유효한 ZIP이다", async () => {
    const cwd = fixture();
    const markdown = [
      "# 안전 수칙", "", "이 문서는 **굵게**와 *기울임*, `PLC-01` & 기호를 담습니다.", "",
      "1. 보호구 착용", "2. 전원 차단", "   - 표지판 부착", "", "| 위험 | 조치 |", "| --- | --- |", "| 끼임 | 접근 금지 |", "",
      "```", "log <ok>", "```",
    ].join("\n");
    const result = await draftDocument({ instruction: "안내문", output: "guide.docx" }, context(cwd), signal, async () => markdown);
    expect(result).toContain("저장: guide.docx");
    expect(result).toContain("- # 안전 수칙");
    const parts = unzip(readFileSync(join(cwd, "guide.docx")));
    for (const [name, xml] of parts) assertWellFormed(xml, name);
    const document = parts.get("word/document.xml")!;
    const words = texts(document, "w:t");
    for (const expected of ["안전 수칙", "굵게", "기울임", "PLC-01", " & 기호를 담습니다.", "보호구 착용", "표지판 부착", "위험", "접근 금지", "log <ok>"]) {
      expect(words).toContain(expected);
    }
    expect(document).toContain('<w:pStyle w:val="Heading1"/>');
    expect(document).toMatch(/<w:b\/><\/w:rPr><w:t xml:space="preserve">굵게</);
    expect(document).toMatch(/<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="1"\/><\/w:numPr>/);
    expect(document).toContain("<w:tbl>");
    expect(parts.get("word/numbering.xml")).toContain('w:numFmt w:val="decimal"');
  });
});
