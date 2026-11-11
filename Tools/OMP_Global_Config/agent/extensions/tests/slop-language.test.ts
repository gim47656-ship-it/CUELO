import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSlopRecords, sha256 } from "../lib/slop-gate";
import { reviewFiles, resolveFindings, SPLIT_CHARS, type Complete, type SlopDeps } from "../slop-gate/review";
import { extractVisible } from "../slop-gate/extract";

// 언어 범위(2026-11-11 사용자 선택 language_scoped): 기준(humanizer·stop-slop)이 없는 언어의 글은 영어 기준으로 심사하지 않고,
// 디자인 심사는 돌되 통과는 없다. 언어 판별은 같은 필수 reviewer 자리가 답한다(여기서는 결정론 가짜).

const roots: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "slop-language-test-"));
  writeFileSync(join(dir, ".slop-gate.json"), JSON.stringify({ visible: ["*.md"] }));
  roots.push(dir);
  return dir;
};
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const signal = new AbortController().signal;

const ES = "El proceso de medición de la pieza e ingreso del código de barras se realiza en el siguiente orden. Coloque la pieza sobre la mesa y espere la señal verde antes de presionar el botón de inicio.\n".repeat(4);
const IT = "Il processo di misurazione del pezzo e la lettura del codice a barre avvengono nel seguente ordine. Appoggiare il pezzo sul banco e attendere il segnale verde prima di premere il pulsante di avvio.\n".repeat(4);
const EN = "Place the part on the table and wait for the green light before you press the start button. The gauge stores each reading in the daily file and shows the last ten values on the screen.\n".repeat(4);
const KO = "저장 버튼을 누르면 파일이 내려받기 폴더에 들어간다.\n한 번 더 누르면 같은 이름 뒤에 번호가 붙는다. 실패하면 빨간 줄로 이유를 보여 준다.\n";

/** 가짜 reviewer: 모든 답에 artifact별 findings와 languages를 함께 싣는다(심사 답은 languages를, 언어 판별 답은 findings를 읽지 않는다). */
function fake(options: { findings?: (body: string) => { quote: string; rule: string; fix: string }[]; failLanguage?: "throw" | "omit" | "empty" } = {}) {
  const all: { system: string; prompt: string }[] = [];
  const complete: Complete = async (family, system, prompt) => {
    all.push({ system, prompt });
    const identifying = system.includes("\"languages\"");
    if (identifying && options.failLanguage === "throw") throw new Error("language outage");
    const files = [...prompt.matchAll(/<artifact id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/artifact>/g)].map(([, id, body]) => {
      const languages = [/medición|siguiente/.test(body!) && "es", /misurazione|seguente/.test(body!) && "it", /[가-힣]/.test(body!) && "ko", /\bthe\b/.test(body!) && "en"].filter(Boolean);
      return { id, findings: identifying ? [] : options.findings?.(body!) ?? [], ...(identifying && options.failLanguage === "omit" ? {} : { languages: identifying && options.failLanguage === "empty" ? [] : languages }) };
    });
    return { model: `fixture/${family}`, text: JSON.stringify({ files }) };
  };
  return { all, complete, reviews: () => all.filter((call) => !call.system.includes("\"languages\"")) };
}
const deps = (cwd: string, complete: Complete, extra: Partial<SlopDeps> = {}): SlopDeps => ({ cwd, ledgerPath: join(cwd, "ledger.jsonl"), complete, mainModel: "anthropic/fixture-author", head: async () => undefined, ...extra });
const passes = (cwd: string) => readSlopRecords(join(cwd, "ledger.jsonl")).filter((record) => record.type === "slop-pass");
const STOP_SLOP = '<rubric name="stop-slop">';

describe("언어 범위: 기준이 없는 언어는 영어 기준으로 심사하지 않고 통과도 없다", () => {
  test("스페인어 글은 stop-slop으로 보내지 않고, 통과 없이 미지원 오류를 낸다(명시한 lang도 우회가 아니다)", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "guia.md"), ES);
    for (const lang of [undefined, "en"] as const) {
      const reviewer = fake();
      const out = await reviewFiles(["guia.md"], lang, deps(cwd, reviewer.complete), signal);
      expect(out.files[0]).toMatchObject({ status: "error" });
      expect(out.files[0]!.error).toContain("no pass");
      expect(out.files[0]!.error).toContain("unsupported language(s): es");
      for (const call of reviewer.all) expect(call.system).not.toContain(STOP_SLOP);
    }
    expect(passes(cwd)).toEqual([]);
  });

  test("다른 라틴 문자 언어(이탈리아어) html은 디자인 심사만 받고, 그 지적은 진단일 뿐 resolve로도 통과가 되지 않는다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "guida.html"), `<html><body><p>${IT}</p><div class="card">x</div></body></html>`);
    const reviewer = fake({ findings: () => [{ quote: "x", rule: "kill-ai-slop: card grid", fix: "plain list" }] });
    const out = await reviewFiles(["guida.html"], undefined, deps(cwd, reviewer.complete), signal);
    const design = reviewer.reviews();
    expect(design.length).toBeGreaterThan(0);
    for (const call of design) {
      expect(call.system).toContain('<rubric name="kill-ai-slop">');
      expect(call.system).not.toContain(STOP_SLOP);
      expect(call.system).not.toContain('<rubric name="humanizer">');
    }
    expect(out.files[0]).toMatchObject({ status: "error", diagnosticFindings: [{ quote: "x" }] });
    expect(out.files[0]!.error).toContain("unsupported language(s): it");
    const id = out.files[0]!.diagnosticFindings![0]!.id;
    expect(resolveFindings(out.reviewId!, [{ id, status: "refuted", evidence: "디자인 지적은 의도한 카드다, 반박한다" }], { ledgerPath: join(cwd, "ledger.jsonl") }).passed).toEqual([]);
    expect(passes(cwd)).toEqual([]);
  });

  test("한국어·영어·한영 혼합 글은 맞는 기준으로 심사받고 깨끗하면 통과한다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "ko.md"), KO);
    writeFileSync(join(cwd, "en.md"), EN);
    writeFileSync(join(cwd, "mixed.md"), `${KO}${EN}`);
    const reviewer = fake();
    const out = await reviewFiles(["ko.md", "en.md", "mixed.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(out.files.map((file) => [file.file, file.status])).toEqual([["ko.md", "pass"], ["en.md", "pass"], ["mixed.md", "pass"]]);
    const systemFor = (marker: string) => reviewer.reviews().filter((call) => call.prompt.includes(marker)).map((call) => call.system).join("\n");
    expect(systemFor('path="ko.md"')).toContain('<rubric name="humanizer">');
    expect(systemFor('path="en.md"')).toContain(STOP_SLOP);
    expect(systemFor('path="mixed.md"')).toContain(STOP_SLOP);
    expect(systemFor('path="mixed.md"')).toContain('<rubric name="humanizer">');
    expect(passes(cwd).map((record) => record.sha256).sort()).toEqual([sha256(KO), sha256(EN), sha256(`${KO}${EN}`)].sort());
  });

  test("언어 판별이 실패하거나 언어를 빠뜨리면 통과가 없고, 자연어가 없다는 답만으로 글뿐인 파일이 통과하지도 않는다", async () => {
    for (const [failLanguage, file, text] of [["throw", "en.md", EN], ["omit", "en.md", EN], ["empty", "ko.md", KO], ["empty", "en.md", EN]] as const) {
      const cwd = scratch();
      writeFileSync(join(cwd, file), text);
      const out = await reviewFiles([file], undefined, deps(cwd, fake({ failLanguage }).complete), signal);
      expect(out.files[0]).toMatchObject({ status: "error" });
      expect(passes(cwd)).toEqual([]);
    }
  });

  test("언어 판별도 한국어 글까지 빠짐없이, 심사와 같은 필수 자리·slot으로 묻는다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "ko.md"), KO);
    const seen: { identifying: boolean; family: string; slot?: string }[] = [];
    const inner = fake().complete;
    const complete: Complete = async (family, system, prompt, sig, slot) => {
      seen.push({ identifying: system.includes("\"languages\""), family, slot });
      return inner(family, system, prompt, sig, slot);
    };
    const out = await reviewFiles(["ko.md"], undefined, deps(cwd, complete, { slopSlots: { openai: "openai-codex/fixture-luna" } }), signal);
    expect(out.files[0]).toMatchObject({ status: "pass" });
    expect(seen).toEqual([{ identifying: true, family: "openai", slot: "slopReviewOpenAI" }, { identifying: false, family: "openai", slot: "slopReviewOpenAI" }]);
  });

  test("html 원문 층도 판별한다: 보이는 영어 글은 그대로인데 script 안 문구만 스페인어로 바뀌면(전체·delta 모두) 통과가 없다", async () => {
    const cwd = scratch();
    const page = (label: string, extra = "") => `<html><body>\n<p>Place the part on the table and wait for the green light before you press the start button.</p>\n${extra}<script>\nshowToast("${label}");\n</script>\n</body></html>\n`;
    writeFileSync(join(cwd, "before.html"), page("Press the green button to continue the measurement."));
    writeFileSync(join(cwd, "whole.html"), page("Presione el botón verde para continuar con la medición."));
    writeFileSync(join(cwd, "delta.html"), page("Presione el botón verde para continuar con la medición.", "<p>The new screen shows the last ten readings.</p>\n"));
    const before = await extractVisible(join(cwd, "before.html"));
    for (const [file, head] of [["whole.html", async () => undefined], ["delta.html", async () => before]] as const) {
      const reviewer = fake();
      const out = await reviewFiles([file], undefined, deps(cwd, reviewer.complete, { head }), signal);
      expect(out.files[0]).toMatchObject({ status: "error", error: expect.stringContaining("unsupported language(s): es") });
      for (const call of reviewer.all) expect(call.system).not.toContain(STOP_SLOP);
    }
    expect(passes(cwd)).toEqual([]);
  });

  test("큰 파일은 앞부분만 보고 판별하지 않는다: 한국어 뒤 끝부분의 스페인어도 통과를 막는다", async () => {
    const cwd = scratch();
    const text = `${KO.repeat(Math.ceil((SPLIT_CHARS * 1.5) / KO.length))}${ES}`;
    writeFileSync(join(cwd, "big.md"), text);
    const reviewer = fake();
    const out = await reviewFiles(["big.md"], undefined, deps(cwd, reviewer.complete), signal);
    expect(out.files[0]).toMatchObject({ status: "error" });
    expect(out.files[0]!.error).toContain("unsupported language(s): es");
    expect(passes(cwd)).toEqual([]);
  });

  test("짧은 스페인어 문장 하나만 든 html도 글자 수가 적다는 이유로 디자인 심사만으로 통과하지 않는다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "aviso.html"), "<html><body><p>Presione el botón verde para continuar con la medición.</p></body></html>");
    const reviewer = fake();
    const out = await reviewFiles(["aviso.html"], undefined, deps(cwd, reviewer.complete), signal);
    expect(out.files[0]).toMatchObject({ status: "error" });
    expect(out.files[0]!.error).toContain("unsupported language(s): es");
    expect(passes(cwd)).toEqual([]);
  });

  test("lang 힌트가 글의 언어와 다르면 다른 언어 기준을 씌우지 않고 기준 없음 오류로 통과가 없다", async () => {
    const cwd = scratch();
    writeFileSync(join(cwd, "en.md"), EN);
    writeFileSync(join(cwd, "ko.md"), KO);
    for (const [file, lang, wrong] of [["en.md", "ko", "humanizer"], ["ko.md", "en", "stop-slop"]] as const) {
      const reviewer = fake();
      const out = await reviewFiles([file], lang, deps(cwd, reviewer.complete), signal);
      expect(out.files[0]).toMatchObject({ status: "error" });
      expect(out.files[0]!.error).toContain("no rubric applies");
      for (const call of reviewer.all) expect(call.system).not.toContain(`<rubric name="${wrong}">`);
    }
    expect(passes(cwd)).toEqual([]);
  });
});
