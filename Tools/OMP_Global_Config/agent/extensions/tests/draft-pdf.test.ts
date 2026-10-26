import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "../../tools/ego-browser/index";
import { findPdfBackend, renderPdf, type PdfDeps } from "../draft/pdf";

// 검증 범위: ego lite 우선·127일 때만 Edge·ego 오류는 Edge로 숨기지 않음·네트워크 차단 순서·TaskSpace 정리·임시 폴더 삭제 실패 경고.
// 실제 ego lite·Edge 인쇄와 네트워크 차단 효과는 여기서 증명하지 않는다(실제 스모크는 작업 기록 참고).
const PDF = Buffer.from("%PDF-1.7\nfake");
const signal = new AbortController().signal;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Behavior = (input: string, args: string[], dir: string) => Promise<ExecResult> | ExecResult;

function harness(behavior: Behavior, winDir = "") {
  const calls: { args: string[]; input: string }[] = [];
  const edge: string[] = [];
  let dir = "";
  const exec: Exec = async (args, input) => {
    calls.push({ args, input });
    return behavior(input, args, dir);
  };
  const deps: PdfDeps = {
    exec,
    makeWork: async () => {
      dir = mkdtempSync(join(tmpdir(), "draft-pdf-test-"));
      dirs.push(dir);
      return { dir, winDir: winDir || dir };
    },
    remove: async (path) => rmSync(path, { recursive: true, force: true }),
    renderEdge: async (html) => { edge.push(html); return { pdf: Buffer.from("%PDF-edge"), warnings: [] }; },
  };
  return { calls, edge, deps, dirOf: () => dir };
}
const ok = (): ExecResult => ({ code: 0, stdout: "", stderr: "", killed: false });
const writesPdf: Behavior = (_input, args, dir) => {
  // 인쇄 스크립트(nodejs 본문에 printToPDF가 있는 호출)만 PDF를 만든다. 정리 스크립트는 만들지 않는다.
  if (args[0] === "nodejs" && _input.includes("Page.printToPDF")) writeFileSync(join(dir, "out.pdf"), PDF);
  return ok();
};

describe("draft PDF 백엔드", () => {
  test("ego lite가 있으면 ego TaskSpace 스크립트로 인쇄하고 Edge는 부르지 않는다", async () => {
    const h = harness(writesPdf);
    const { pdf, warnings } = await renderPdf("<h1>한글 시험</h1>", signal, h.deps);
    expect(pdf.equals(PDF)).toBe(true);
    expect(warnings).toEqual([]);
    expect(h.edge).toEqual([]);
    expect(h.calls).toHaveLength(1);
    const { args, input } = h.calls[0]!;
    expect(args).toEqual(["nodejs"]);
    // 호출마다 새 전용 공간, 사용자 기본 프로필(profileId 없음), 인쇄 옵션, 실패해도 닫는 finally.
    expect(input).toMatch(/taskSpace\("cuelo-draft-pdf-[0-9a-f]{8}"\)/);
    expect(input).not.toContain("profileId");
    expect(input).toContain('"Page.printToPDF", { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false }');
    expect(input).toMatch(/\} finally \{\n\s+await task\.finish\(\{ keep: \[\] \}\);/);
    // 임시 HTML은 끝나면 지워진다.
    expect(existsSync(h.dirOf())).toBe(false);
  });

  test("사용자 프로필이므로 goto 전에 http·https·ws·wss 요청을 막고 페이지 스크립트를 끈다(WebSocket은 URL 차단으로 안 막힘)", async () => {
    const h = harness(writesPdf);
    await renderPdf("<img src='https://example.com/x.png'>", signal, h.deps);
    const input = h.calls[0]!.input;
    const enable = input.indexOf('page.cdp("Network.enable"');
    const block = input.indexOf('"Network.setBlockedURLs", { urls: ["http://*", "https://*", "ws://*", "wss://*"] }');
    const noScript = input.indexOf('"Emulation.setScriptExecutionDisabled", { value: true }');
    const goto = input.indexOf("page.goto(");
    expect(enable).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(enable);
    expect(noScript).toBeGreaterThan(block);
    expect(goto).toBeGreaterThan(noScript);
  });

  test("HTML 파일 URL과 출력 경로는 Windows 경로로 스크립트에 들어간다", async () => {
    const h = harness(writesPdf, "C:\\Users\\x\\My Temp\\cuelo-draft-x");
    await renderPdf("<p>x</p>", signal, h.deps);
    const input = h.calls[0]!.input;
    expect(input).toContain('"file:///C:/Users/x/My%20Temp/cuelo-draft-x/page.html"');
    expect(input).toContain('"C:\\\\Users\\\\x\\\\My Temp\\\\cuelo-draft-x\\\\out.pdf"');
  });

  test("래퍼가 127로 끝나면(ego lite 없음) 기존 Edge 경로로 인쇄한다", async () => {
    const h = harness(() => ({ code: 127, stdout: "", stderr: "ego-browser: ego lite가 설치돼 있지 않다", killed: false }));
    const { pdf } = await renderPdf("<p>x</p>", signal, h.deps);
    expect(pdf.toString("latin1")).toBe("%PDF-edge");
    expect(h.edge).toEqual(["<p>x</p>"]);
    expect(h.calls).toHaveLength(1);
  });

  test("ego-browser 실행 파일이 없으면(ENOENT) Edge 경로로 인쇄한다", async () => {
    const h = harness(() => { throw Object.assign(new Error("spawn ego-browser ENOENT"), { code: "ENOENT" }); });
    await renderPdf("<p>x</p>", signal, h.deps);
    expect(h.edge).toHaveLength(1);
  });

  test("ego가 127이 아닌 코드로 실패하면 ego 오류로 끝나고 Edge로 바꾸지 않는다", async () => {
    const h = harness(() => ({ code: 1, stdout: "", stderr: "TypeError: boom", killed: false }));
    await expect(renderPdf("<p>x</p>", signal, h.deps)).rejects.toThrow(/ego lite PDF 인쇄 실패\(exit 1.*boom/);
    expect(h.edge).toEqual([]);
    expect(existsSync(h.dirOf())).toBe(false);
  });

  test("ego가 PDF를 만들지 않았거나 PDF가 아니면 ego 오류로 끝나고 Edge로 바꾸지 않는다", async () => {
    const missing = harness(() => ok());
    await expect(renderPdf("<p>x</p>", signal, missing.deps)).rejects.toThrow(/ego lite가 PDF 파일을 만들지 않았/);
    const junk = harness((_i, _a, dir) => { writeFileSync(join(dir, "out.pdf"), "not a pdf"); return ok(); });
    await expect(renderPdf("<p>x</p>", signal, junk.deps)).rejects.toThrow(/ego lite 출력이 PDF가 아닙니다/);
    expect(missing.edge.concat(junk.edge)).toEqual([]);
  });

  test("시간 초과로 죽으면 이름으로 TaskSpace를 찾아 닫고, 닫았다고 알리며 ego 오류로 끝난다", async () => {
    let n = 0;
    const h = harness(() => (++n === 1 ? { code: -1, stdout: "", stderr: "", killed: true } : ok()));
    const error = await renderPdf("<p>x</p>", signal, h.deps).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/ego lite PDF 인쇄가 .*끝나지 않았/);
    expect((error as Error).message).not.toContain("may remain");
    expect(h.edge).toEqual([]);
    expect(h.calls).toHaveLength(2);
    const name = /taskSpace\("(cuelo-draft-pdf-[0-9a-f]{8})"\)/.exec(h.calls[0]!.input)![1]!;
    expect(h.calls[1]!.input).toContain(`space.name === "${name}"`);
    expect(h.calls[1]!.input).toContain("finish({ keep: [] })");
    expect((error as Error).message).toContain(name);
  });

  test("시간 초과 뒤 정리도 실패하면 오류에 TaskSpace가 남아 있을 수 있다고 적는다", async () => {
    let n = 0;
    const h = harness(() => (++n === 1 ? { code: -1, stdout: "", stderr: "", killed: true } : { code: 2, stdout: "", stderr: "cleanup boom", killed: false }));
    const error = (await renderPdf("<p>x</p>", signal, h.deps).catch((e: Error) => e)) as Error;
    const name = /taskSpace\("(cuelo-draft-pdf-[0-9a-f]{8})"\)/.exec(h.calls[0]!.input)![1]!;
    expect(error.message).toContain(`TaskSpace ${name} may remain`);
    expect(error.message).toContain("cleanup boom");
    expect(h.edge).toEqual([]);
  });

  test("exec가 ENOENT가 아닌 이유로 던지면 ego 오류로 끝나고 정리를 돌린다(정리 성공 시 may remain 없음)", async () => {
    let n = 0;
    const h = harness(() => { if (++n === 1) throw new Error("pipe broke"); return ok(); });
    const error = (await renderPdf("<p>x</p>", signal, h.deps).catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/^ego lite PDF 인쇄 실패: pipe broke/);
    expect(error.message).not.toContain("may remain");
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.input).toContain("listTaskSpaces()");
    expect(h.edge).toEqual([]);
  });

  test("exec가 던진 뒤 정리도 던지면 TaskSpace가 남아 있을 수 있다고 적는다", async () => {
    const h = harness(() => { throw new Error("pipe broke"); });
    const error = (await renderPdf("<p>x</p>", signal, h.deps).catch((e: Error) => e)) as Error;
    const name = /taskSpace\("(cuelo-draft-pdf-[0-9a-f]{8})"\)/.exec(h.calls[0]!.input)![1]!;
    expect(error.message).toContain("pipe broke");
    expect(error.message).toContain(`TaskSpace ${name} may remain`);
    expect(h.edge).toEqual([]);
  });

  test("임시 폴더를 지우지 못해도 PDF는 돌려주고 남은 Windows 경로를 경고로 남긴다", async () => {
    const h = harness(writesPdf, "C:\\Users\\x\\Temp\\cuelo-draft-left");
    h.deps.remove = async () => { throw new Error("EBUSY: locked"); };
    const { pdf, warnings } = await renderPdf("<p>x</p>", signal, h.deps);
    expect(pdf.equals(PDF)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("C:\\Users\\x\\Temp\\cuelo-draft-left");
    expect(warnings[0]).toContain("EBUSY");
  });

  test("호출마다 TaskSpace 이름이 다르다", async () => {
    const h = harness(writesPdf);
    await renderPdf("<p>1</p>", signal, h.deps);
    await renderPdf("<p>2</p>", signal, h.deps);
    const names = h.calls.map((call) => /taskSpace\("([^"]+)"\)/.exec(call.input)![1]);
    expect(new Set(names).size).toBe(2);
  });
});

const wsl = process.platform === "linux" && (!!process.env.WSL_DISTRO_NAME || /microsoft/i.test(readFileSync("/proc/version", "utf8")));
describe.skipIf(!wsl)("draft PDF 사전 확인(WSL)", () => {
  test("ego-browser --version이 성공하면 ego, 다른 실패는 ego lite 확인 실패 오류로 끝난다", async () => {
    const seen: string[][] = [];
    const exec: Exec = async (args) => { seen.push(args); return ok(); };
    expect(await findPdfBackend(signal, exec)).toBe("ego");
    expect(seen).toEqual([["--version"]]);
    const broken: Exec = async () => ({ code: 3, stdout: "", stderr: "crash", killed: false });
    await expect(findPdfBackend(signal, broken)).rejects.toThrow(/ego lite 확인 실패: ego-browser --version exit 3/);
    const thrown: Exec = async () => { throw new Error("spawn EACCES"); };
    await expect(findPdfBackend(signal, thrown)).rejects.toThrow(/^ego lite 확인 실패: spawn EACCES/);
  });
});

describe("draft PDF 경고는 모든 경로에서 살아남는다", () => {
  const leftover = "C:\\Users\\x\\Temp\\cuelo-draft-left";
  const stuck = (deps: PdfDeps) => { deps.remove = async () => { throw new Error("EBUSY: locked"); }; };

  test("인쇄가 실패하면 임시 폴더 경고가 던지는 오류 문구에 붙는다", async () => {
    const h = harness(() => ({ code: 1, stdout: "", stderr: "TypeError: boom", killed: false }), leftover);
    stuck(h.deps);
    const error = (await renderPdf("<p>x</p>", signal, h.deps).catch((e: Error) => e)) as Error;
    expect(error.message).toMatch(/ego lite PDF 인쇄 실패\(exit 1.*boom/s);
    expect(error.message).toContain(`경고: 임시 폴더를 지우지 못했습니다. 직접 지워도 됩니다: ${leftover}`);
    expect(h.edge).toEqual([]);
  });

  test("ego가 없어 Edge로 넘어가면 ego 쪽 임시 폴더 경고가 Edge 결과로 이어진다", async () => {
    const h = harness(() => ({ code: 127, stdout: "", stderr: "", killed: false }), leftover);
    stuck(h.deps);
    const { pdf, warnings } = await renderPdf("<p>x</p>", signal, h.deps);
    expect(pdf.toString("latin1")).toBe("%PDF-edge");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(leftover);
  });

  test("ego 경고가 있는 채 Edge도 실패하면 Edge 오류 문구에 ego 쪽 경고가 붙는다", async () => {
    const h = harness(() => ({ code: 127, stdout: "", stderr: "", killed: false }), leftover);
    stuck(h.deps);
    h.deps.renderEdge = async () => { throw new Error("Edge가 PDF를 만들지 않았습니다."); };
    const error = (await renderPdf("<p>x</p>", signal, h.deps).catch((e: Error) => e)) as Error;
    expect(error.message).toContain("Edge가 PDF를 만들지 않았습니다.");
    expect(error.message).toContain(`경고: 임시 폴더를 지우지 못했습니다. 직접 지워도 됩니다: ${leftover}`);
  });
});
