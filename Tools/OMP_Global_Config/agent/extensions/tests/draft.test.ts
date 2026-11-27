import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { draftDocument, type DraftCompletion } from "../draft";
import { DRAFT_FALLBACK, ROLE_PRIMARY as PRIMARY_ROLE, HelperCallError, type HelperAnswer } from "../skim";

const TEST_MODEL = "openai-codex/gpt-6.1-terra";
const SONNET = "anthropic/claude-sonnet-5-5";
const directories: string[] = [];
const signal = new AbortController().signal;
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "draft-fixture-"));
  directories.push(cwd);
  return cwd;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context(cwd: string): ExtensionContext { return { cwd } as ExtensionContext; }
const reply = (text: string, model: string = TEST_MODEL): HelperAnswer => ({ text, model });
async function draftText(...args: Parameters<typeof draftDocument>): Promise<string> { return (await draftDocument(...args)).text; }

test.each([
  ["503 Service Unavailable", true],
  ["429 usage limit", true],
  ["empty answer", false],
  ["content blocked by safety policy: temporarily unavailable", false],
  ["401 OAuth token expired", false],
  ["403 Your account must be verified (429 retry hint)", false],
] as const)("draft failure %s only reaches the configured alternate when operational", async (failure, fallbackCalled) => {
  const cwd = fixture();
  const primary = TEST_MODEL;
  const fallback = "anthropic/claude-haiku-5-5";
  const called: string[] = [];
  const ctx = { cwd, models: { resolve: (selector: string) => {
    const exact = selector === "@draft" ? primary : selector === "@draftFallback" ? fallback : selector;
    const [provider, id] = exact.split("/");
    return { provider, id };
  } } } as ExtensionContext;
  const result = await withActiveSettings(Settings.isolated({
    modelRoles: { draft: primary, draftFallback: fallback },
  }), () => draftDocument({ instruction: "write", output: "checked.txt" }, ctx, signal, async (_prompt, _ctx, _signal, marker) => {
    if (marker === PRIMARY_ROLE) {
      called.push(primary);
      if (failure === "empty answer") return reply("", primary);
      throw new HelperCallError(failure, primary, { providerFailure: true });
    }
    called.push(typeof marker === "object" ? marker.route : marker === DRAFT_FALLBACK ? fallback : marker);
    return reply("Drafted", fallback);
  }));
  expect(called).toEqual(fallbackCalled ? [primary, fallback] : [primary]);
  expect(result.isError).toBe(!fallbackCalled);
  if (fallbackCalled) expect(result.text).toContain(`model: ${fallback}`);
  else expect(result.savedPath).toBeUndefined();
});

test("an unreadable configured draft primary falls back once without re-resolving it", async () => {
  const cwd = fixture();
  const primary = TEST_MODEL;
  const fallback = "anthropic/claude-haiku-5-5";
  let resolutions = 0;
  const ctx = { cwd, models: { resolve: (selector: string) => {
    if (selector === "@draft") {
      resolutions++;
      throw new Error("fixture: primary model registry unavailable");
    }
    return selector === "@draftFallback" ? { provider: "anthropic", id: "claude-haiku-5-5" } : undefined;
  } } } as ExtensionContext;
  const called: string[] = [];
  const result = await withActiveSettings(Settings.isolated({ modelRoles: { draft: primary, draftFallback: fallback } }), () =>
    draftDocument({ instruction: "write", output: "recovered.txt" }, ctx, signal, async (_prompt, _ctx, _signal, marker) => {
      called.push(typeof marker === "object" ? marker.route : marker === DRAFT_FALLBACK ? fallback : marker);
      return reply("Drafted", fallback);
    }));
  expect(resolutions).toBe(1);
  expect(called).toEqual([fallback]);
  expect(result.text).toContain("fixture: primary model registry unavailable");
  expect(readFileSync(result.savedPath!, "utf8")).toBe("Drafted\n");
});

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
  test("only real saves expose canonical savedPath; non-error no-save and failures do not", async () => {
    const cwd = fixture();
    const output = "doc/history/2026/11/03-save/maker-A.md";
    const complete: DraftCompletion = async () => reply("# Saved\n\nProducer evidence.");
    const saved = await draftDocument({ instruction: "record", output }, context(cwd), signal, complete);
    expect(saved.savedPath).toBe(join(cwd, output));
    expect(readFileSync(saved.savedPath!, "utf8")).toBe("# Saved\n\nProducer evidence.\n");
    for (const blank of [{ instruction: " ", output }, { instruction: "record", output: " " }]) {
      const noSave = await draftDocument({ ...blank, overwrite: true }, context(cwd), signal, complete);
      expect(noSave).toMatchObject({ isError: false, details: { refused: { by: "draft-path" } } });
      expect(noSave.text.split("\n")[0]).toBe("[refused by draft-path] Not executed.");
      expect(noSave.savedPath).toBeUndefined();
    }
    expect(readFileSync(join(cwd, output), "utf8")).toBe("# Saved\n\nProducer evidence.\n");
    const refused = await draftDocument({ instruction: "record", output }, context(cwd), signal, complete);
    expect(refused).toMatchObject({ isError: false, details: { refused: { by: "draft-path" } } });
    expect(refused.text.split("\n")[0]).toBe("[refused by draft-path] Not executed.");
    expect(refused.savedPath).toBeUndefined();
  });

  test("cancellation at the save directory operation is an error without an output file", async () => {
    const cwd = fixture();
    const controller = new AbortController();
    const directory = join(cwd, "docs");
    const mkdir = fsPromises.mkdir;
    const intercept = spyOn(fsPromises, "mkdir").mockImplementation((async (path, options) => {
      if (path === directory) controller.abort(new Error("save cancelled"));
      return mkdir(path, options);
    }) as typeof mkdir);
    try {
      const result = await draftDocument({ instruction: "record", output: "docs/report.md" }, context(cwd), controller.signal, async () => reply("# Draft"));
      expect(controller.signal.aborted).toBe(true);
      expect(result.isError).toBe(true);
      expect(result.details).toBeUndefined();
      expect(result.text).toContain("save cancelled");
      expect(existsSync(join(directory, "report.md"))).toBe(false);
    } finally { intercept.mockRestore(); }
  });

  test("reports the saved path when an overwrite completes before cancellation", async () => {
    const cwd = fixture(), output = join(cwd, "report.md");
    writeFileSync(output, "old");
    const controller = new AbortController();
    const rename = fsPromises.rename;
    const intercept = spyOn(fsPromises, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      controller.abort();
    });
    try {
      const result = await draftDocument({ instruction: "record", output: "report.md", overwrite: true }, context(cwd), controller.signal, async () => reply("# Draft"));
      expect(controller.signal.aborted).toBe(true);
      expect(result).toMatchObject({ isError: false, savedPath: output });
      expect(readFileSync(output, "utf8")).toBe("# Draft\n");
    } finally { intercept.mockRestore(); }
  });

  test("failed no-overwrite writes never expose partial final bytes", async () => {
    const cwd = fixture(), output = join(cwd, "report.md");
    const open = fsPromises.open, write = fsPromises.writeFile;
    const direct = spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === output) handle.writeFile = async () => {
        await handle.write("partial");
        throw new Error("fixture: failed draft write");
      };
      return handle;
    });
    const temporary = spyOn(fsPromises, "writeFile").mockImplementation(async (path) => {
      await write(path, "partial");
      throw new Error("fixture: failed draft write");
    });
    const input = { instruction: "record", output: "report.md" }, complete = async () => reply("# Draft");
    try {
      const failed = await draftDocument(input, context(cwd), signal, complete);
      expect(failed.isError).toBe(true);
      expect(failed.text).toContain("fixture: failed draft write");
      expect(readdirSync(cwd)).toEqual([]);
    } finally { temporary.mockRestore(); direct.mockRestore(); }
    expect(await draftDocument(input, context(cwd), signal, complete)).toMatchObject({ isError: false, savedPath: output });
    expect(readFileSync(output, "utf8")).toBe("# Draft\n");
  });

  test("exclusive publication preserves a concurrent destination", async () => {
    const cwd = fixture(), output = join(cwd, "report.md");
    const result = await draftDocument({ instruction: "record", output: "report.md" }, context(cwd), signal, async () => {
      writeFileSync(output, "other writer");
      return reply("# Draft");
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("EEXIST");
    expect(readdirSync(cwd)).toEqual(["report.md"]);
    expect(readFileSync(output, "utf8")).toBe("other writer");
  });

  test("a filesystem without hard links fails closed without a partial destination", async () => {
    const cwd = fixture();
    const intercept = spyOn(fsPromises, "link").mockRejectedValue(Object.assign(new Error("fixture: links unsupported"), { code: "ENOTSUP" }));
    try {
      const result = await draftDocument({ instruction: "record", output: "report.md" }, context(cwd), signal, async () => reply("# Draft"));
      expect(result.isError).toBe(true);
      expect(result.savedPath).toBeUndefined();
      expect(result.text).toContain("fixture: links unsupported");
      expect(readdirSync(cwd)).toEqual([]);
    } finally { intercept.mockRestore(); }
  });

  test("temp cleanup failure after rename keeps the save receipt and warning", async () => {
    const cwd = fixture(), output = join(cwd, "report.md");
    writeFileSync(output, "old");
    const rm = fsPromises.rm;
    const intercept = spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
      if (String(path).startsWith(join(cwd, ".draft-"))) throw Object.assign(new Error("fixture: cleanup denied"), { code: "EACCES" });
      return rm(path, options);
    });
    try {
      const result = await draftDocument({ instruction: "record", output: "report.md", overwrite: true }, context(cwd), signal, async () => reply("# Draft"));
      expect(result).toMatchObject({ isError: false, savedPath: output });
      expect(result.text).toContain("fixture: cleanup denied");
      expect(readFileSync(output, "utf8")).toBe("# Draft\n");
    } finally { intercept.mockRestore(); }
  });

  test("policy-excluded references refuse, but unreadable references stay errors", async () => {
    const cwd = fixture(), broken = join(cwd, "unreadable.md");
    writeFileSync(join(cwd, "api-key.md"), "fixture text");
    writeFileSync(broken, "fixture text");
    let calls = 0;
    const complete: DraftCompletion = async () => { calls++; return reply("# Draft"); };
    const instruction = "record", output = "report.md";
    const refused = await draftDocument({ instruction, output, paths: ["api-key.md"] }, context(cwd), signal, complete);
    expect(refused).toMatchObject({ isError: false, details: { refused: { by: "draft-path" } } });
    const stat = fsPromises.stat;
    const intercept = spyOn(fsPromises, "stat").mockImplementation((async (path) => {
      if (path === broken) throw Object.assign(new Error("fixture: unreadable reference"), { code: "EACCES" });
      return stat(path);
    }) as typeof stat);
    try {
      const failed = await draftDocument({ instruction, output, paths: ["unreadable.md"] }, context(cwd), signal, complete);
      expect(failed.isError).toBe(true);
      expect(failed.details).toBeUndefined();
      expect(failed.text).toContain("fixture: unreadable reference");
      expect(existsSync(join(cwd, output))).toBe(false);
      expect(calls).toBe(0);
    } finally { intercept.mockRestore(); }
  });

  test("a parent redirected during completion cannot create directories outside the draft cwd", async () => {
    const cwd = fixture(), outside = fixture();
    const result = await draftDocument({ instruction: "record", output: "docs/new/report.md" }, context(cwd), signal, async () => {
      symlinkSync(outside, join(cwd, "docs"), "junction");
      return reply("# Draft");
    });
    expect(result.isError).toBe(true);
    expect(result.savedPath).toBeUndefined();
    expect(existsSync(join(outside, "new"))).toBe(false);
  });
  test("cwd 밖·절대·비밀·링크 경로와 기존 파일은 모델 호출 전에 거부하고 overwrite일 때만 덮어쓴다", async () => {
    const cwd = fixture();
    const outside = fixture();
    symlinkSync(outside, join(cwd, "linked"));
    writeFileSync(join(cwd, "report.md"), "OLD");
    let calls = 0;
    const complete: DraftCompletion = async () => { calls++; return reply("# 새 보고서\n\n본문"); };
    const refused: Array<[string, string]> = [
      ["../escape.md", "'..'"],
      [join(outside, "abs.md"), "cwd 밖"],
      ["C:/Users/x/abs.md", "상대 경로나"],
      [".env.md", "비밀·관리 경로"],
      ["notes/api-key.md", "비밀·관리 경로"],
      [".git/notes.md", "비밀·관리 경로"],
      ["linked/inner.md", "심볼릭 링크"],
      ["report.exe", "지원하지 않는 확장자"],
      ["report.md", "overwrite: true"],
    ];
    for (const [output, reason] of refused) {
      const result = await draftDocument({ instruction: "보고서", output }, context(cwd), signal, complete);
      expect(result).toMatchObject({ isError: false, details: { refused: { by: "draft-path" } } });
      expect(result.text.startsWith("[refused by draft-path] Not executed.\nmodel: none")).toBe(true);
      expect(result.text).toContain(reason);
      expect(result.savedPath).toBeUndefined();
    }
    expect(calls).toBe(0);
    expect(existsSync(join(outside, "abs.md"))).toBe(false);
    expect(existsSync(join(outside, "inner.md"))).toBe(false);
    expect(readFileSync(join(cwd, "report.md"), "utf8")).toBe("OLD");

    const replaced = await draftText({ instruction: "보고서", output: "report.md", overwrite: true }, context(cwd), signal, complete);
    expect(replaced).toContain("저장: report.md");
    expect(replaced).toContain("덮어씀");
    expect(readFileSync(join(cwd, "report.md"), "utf8")).toBe("# 새 보고서\n\n본문\n");
    const nested = await draftText({ instruction: "보고서", output: "docs/new/plan.md" }, context(cwd), signal, complete);
    expect(nested).toContain("저장: docs/new/plan.md");
    expect(nested).toContain("- # 새 보고서");
    // 폴더 이름은 비밀 이름 검사 대상이 아니다(10-29 `29-token-saving/` 작업 기록이 거절됐다). 파일 이름만 본다.
    const dated = await draftText({ instruction: "보고서", output: "doc/29-token-saving/maker-Note.md" }, context(cwd), signal, complete);
    expect(dated).toContain("저장: doc/29-token-saving/maker-Note.md");
    const folder = await draftText({ instruction: "보고서", output: "secrets/plan.md" }, context(cwd), signal, complete);
    expect(folder).toContain("저장: secrets/plan.md");
  });

  test("cwd 안의 절대 경로 output은 상대 경로처럼 저장하고, cwd 밖·cwd 자체·관리 경로는 계속 거부한다", async () => {
    // 11-09 집 PC: cwd 안 절대 경로 output이 「상대 경로만」으로 거절돼 같은 draft를 상대 경로로 다시 불렀다.
    const cwd = fixture();
    const outside = fixture();
    const alias = join(outside, "alias");
    symlinkSync(cwd, alias);
    let calls = 0;
    const complete: DraftCompletion = async () => { calls++; return reply("# 기록\n\n본문"); };
    const absolute = await draftText({ instruction: "기록", output: join(cwd, "doc/history/main.md") }, context(cwd), signal, complete);
    expect(absolute).toContain("저장: doc/history/main.md");
    expect(readFileSync(join(cwd, "doc/history/main.md"), "utf8")).toBe("# 기록\n\n본문\n");
    // 세션 cwd가 링크 경로여도 그 경로로 적은 절대 경로는 cwd 안이다.
    const linked = await draftText({ instruction: "기록", output: join(alias, "doc/linked.md") }, context(alias), signal, complete);
    expect(linked).toContain("저장: doc/linked.md");
    expect(existsSync(join(cwd, "doc/linked.md"))).toBe(true);
    expect(calls).toBe(2);
    const refused: Array<[string, string]> = [
      [join(outside, "abs.md"), "cwd 밖"],
      [cwd, "cwd 밖"],
      [join(cwd, ".git/notes.md"), "비밀·관리 경로"],
      [`${cwd}/a/../b.md`, "'..'"],
    ];
    for (const [output, reason] of refused) {
      const result = await draftText({ instruction: "기록", output }, context(cwd), signal, complete);
      expect(result.startsWith("[refused by draft-path] Not executed.\nmodel: none")).toBe(true);
      expect(result).toContain(reason);
    }
    expect(calls).toBe(2);
    expect(existsSync(join(outside, "abs.md"))).toBe(false);
  });

  test("an outside output names a safe relative retry and a missing session cwd requires reopening", async () => {
    const cwd = fixture();
    const outside = fixture();
    const unexpected: DraftCompletion = async () => { throw new Error("must not call provider"); };
    const output = join(outside, "report.md");
    const refused = await draftDocument({ instruction: "write", output }, context(cwd), signal, unexpected);
    expect(refused).toMatchObject({ isError: false, details: { refused: { by: "draft-path" } } });
    expect(refused.text.split("\n")[0]).toBe("[refused by draft-path] Not executed.");
    expect(refused.text).toContain('output: "report.md"');
    expect(refused.text).toContain(cwd);
    expect(existsSync(output)).toBe(false);
    const missing = await draftDocument({ instruction: "write", output: "report.md" }, context(join(cwd, "missing")), signal, unexpected);
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("세션을");
    expect(missing.text).toContain("ENOENT");
  });

  test("형식이 깨진 응답은 고정 대체(Sonnet)에 한 번만 넘기고, 둘 다 실패하면 저장하지 않는다", async () => {
    const cwd = fixture();
    writeFileSync(join(cwd, "facts.md"), "재고 12개");
    writeFileSync(join(cwd, ".env.local"), "PRIVATE_MARKER");
    const calls: Array<{ prompt: string; model: string }> = [];
    const brokenCsv: DraftCompletion = async (prompt, _ctx, _signal, model) => {
      calls.push({ prompt, model });
      return model === PRIMARY_ROLE ? reply('a,b\n"unclosed,1\n') : reply("```csv\n품목,수량\n장갑,12\n```", String(model));
    };
    const csv = await draftText({ instruction: "재고표", output: "stock.csv", paths: ["facts.md", ".env.local"] }, context(cwd), signal, brokenCsv);
    expect(calls.map(({ model }) => model)).toEqual([PRIMARY_ROLE, SONNET]);
    expect(calls[0]!.prompt).toBe(calls[1]!.prompt);
    expect(calls[0]!.prompt).toContain("재고 12개");
    expect(calls[0]!.prompt).not.toContain("PRIVATE_MARKER");
    expect(csv.startsWith(`model: ${SONNET}`)).toBe(true);
    expect(csv).toContain(`${TEST_MODEL} 실패: CSV: 닫히지 않은 따옴표가 있습니다.`);
    expect(csv).toContain(".env.local: 비밀 경로 제외");
    expect(readFileSync(join(cwd, "stock.csv"), "utf8")).toBe("\uFEFF품목,수량\n장갑,12\n");

    const called: string[] = [];
    const failed = await draftText({ instruction: "요약", output: "summary.md" }, context(cwd), signal, async (_p, _c, _s, model) => {
      called.push(model);
      throw new Error(model === PRIMARY_ROLE ? "primary original 429" : "Sonnet original 403");
    });
    expect(called).toEqual([PRIMARY_ROLE, SONNET]);
    expect(failed.startsWith("model: none")).toBe(true);
    expect(failed).toContain("@draft 실패: primary original 429");
    expect(failed).toContain("Sonnet 실패: Sonnet original 403");
    expect(existsSync(join(cwd, "summary.md"))).toBe(false);
  });

  test("xlsx는 숫자·문자·불리언 셀과 고친 시트 이름을 담은 유효한 OOXML ZIP이다", async () => {
    const cwd = fixture();
    const workbook = { sheets: [
      { name: "구매/계획", header: true, rows: [["품목", "수량", "합격"], ["장갑 <L> & \"M\"", 200, true], ["비고", null, "없음"]] },
      { name: "구매/계획", rows: [["총액", 2090000]] },
    ] };
    const result = await draftText({ instruction: "구매 계획", output: "plan.xlsx" }, context(cwd), signal,
      async () => reply(`\`\`\`json\n${JSON.stringify(workbook)}\n\`\`\``));
    expect(result).toContain(`model: ${TEST_MODEL}`);
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
    const result = await draftText({ instruction: "안내문", output: "guide.docx" }, context(cwd), signal, async () => reply(markdown));
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
