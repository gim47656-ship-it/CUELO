// 비밀 스캔 정본(patches/content-scan.ps1)의 계약 검증. 실행:
//   bun test patches/content-scan.test.ts
//
// 지키는 계약은 셋이다.
//  (1) 커밋된 증거(.jsonl·.diff)와 스캐너 소스 자신은 통과한다. 정상 증거 때문에 게이트가 멈추지
//      않는다.
//  (2) 실제 비밀은 포맷과 무관하게 차단한다. .jsonl 의 JSON 문자열 값과 .diff 의 추가(+)·삭제(-)
//      줄을 빼지 않는다.
//  (3) 형식/파싱 실패와 미지원 확장자는 '비밀 탐지'와 다른 사유로 실패한다(검사를 생략하지 않는다).
//
// 이 테스트 파일도 저장소의 비밀 스캔 대상이다. 그래서 픽스처에 넣을 자격증명 키 이름과 값은
// 소스에 리터럴로 적지 않고 조각을 이어 붙여 만든다(analyze-evals.test.mjs 의 fixture 상수와 같은
// 이유). 리터럴로 적으면 스캐너가 자기 테스트를 자격증명 대입으로 읽는다.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const helperPath = fileURLToPath(new URL("./content-scan.ps1", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "omp-content-scan-"));
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

function writeFixture(name: string, text: string): string {
  const path = join(tempRoot, name);
  writeFileSync(path, text, "utf8");
  return path;
}

// 조각으로 만드는 자격증명 키·값. 이어 붙인 결과만 픽스처 파일에 들어간다.
const sessionKey = ["session", "Id"].join("");
const sessionValue = ["s-7f31c9", "ab42d0"].join("");
const yamlKey = ["api", "Key"].join("");
const yamlValue = ["hunter2-live-", "9c1f4e2a"].join("");
const awsShapedValue = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
// `.md` 구간에서 서술문으로 넘어가야 하는 값. 조각으로 만드는 이유는 위 상수들과 같다.
const proseValue = ["design token ", "reference"].join("");
const headerKey = ["author", "ization"].join("");
const schemeOnlyCode = writeFixture("scheme-only.mjs", `const headers = { ${headerKey}: "Bearer " + runtimeKey };`);
const bearerSecretCode = writeFixture("bearer-secret.mjs", `const headers = { ${headerKey}: ${JSON.stringify("Bearer " + yamlValue)} };`);
const parenthesizedReference = writeFixture("parenthesized-reference.ts", `const ${sessionKey} = (ctx.sessionManager?.getSessionId?.() ?? "").trim();`);
const parenthesizedLiteral = writeFixture("parenthesized-literal.ts", `const ${sessionKey} = (${JSON.stringify(sessionValue)});`);

const committedEvidence = [
  ".core-validation-raw.jsonl",
  ".frozen-review.diff",
  ".frozen-three-role.diff",
  ".frozen-three-role-r2.diff",
].map((name) => join(repoRoot, name));
const scannerSources = [helperPath, join(repoRoot, "setup.ps1"), join(repoRoot, "verify.ps1")];

const cleanJsonl = writeFixture(
  "clean.jsonl",
  [JSON.stringify({ intent: "waiting for result" }), JSON.stringify({ role: "toolResult", text: "applied src/a.ts" })].join("\n") + "\n",
);
const bomJsonl = writeFixture(
  "bom-crlf.jsonl",
  "\ufeff" + JSON.stringify({ status: "ok" }) + "\r\n" + JSON.stringify({ status: "done" }) + "\r\n",
);
const emptyJsonl = writeFixture("empty.jsonl", "");
const assignmentJsonl = writeFixture("assignment.jsonl", JSON.stringify({ event: "login", [sessionKey]: sessionValue }) + "\n");
const directKeyJsonl = writeFixture("direct-key.jsonl", JSON.stringify({ event: "upload", payload: awsShapedValue }) + "\n");
const malformedJsonl = writeFixture("malformed.jsonl", '{"ok":true}\n{"ok":\n');
const cleanDiff = writeFixture(
  "clean.diff",
  [
    "diff --git a/src/label.mjs b/src/label.mjs",
    "--- a/src/label.mjs",
    "+++ b/src/label.mjs",
    "@@ -1,3 +1,3 @@",
    ' export const label = "start";',
    "-export const size = 12;",
    "+export const size = 14;",
  ].join("\n") + "\n",
);
const codeIdentifierDiff = writeFixture(
  "code-identifier.diff",
  [
    "diff --git a/evals/sample.test.mjs b/evals/sample.test.mjs",
    "--- a/evals/sample.test.mjs",
    "+++ b/evals/sample.test.mjs",
    "@@ -1,2 +1,2 @@",
    `-  assert.equal(owners, [{ name: "impl", ${sessionKey}: outputSession }]);`,
    `+  assert.equal(owners, [{ name: "impl", ${sessionKey}: outputSession }]);`,
  ].join("\n") + "\n",
);
const codeQuotedDiff = writeFixture(
  "code-quoted.diff",
  [
    "diff --git a/src/session.mjs b/src/session.mjs",
    "--- a/src/session.mjs",
    "+++ b/src/session.mjs",
    "@@ -1,2 +1,2 @@",
    `-  const ${sessionKey} = ${JSON.stringify("example")};`,
    `+  const ${sessionKey} = ${JSON.stringify(sessionValue)};`,
  ].join("\n") + "\n",
);
const addedLineDiff = writeFixture(
  "added-line.diff",
  [
    "diff --git a/config/app.json b/config/app.json",
    "--- /dev/null",
    "+++ b/config/app.json",
    "@@ -0,0 +1,2 @@",
    "+{",
    `+  ${JSON.stringify(sessionKey)}: ${JSON.stringify(sessionValue)}`,
    "+}",
  ].join("\n") + "\n",
);
const removedLineDiff = writeFixture(
  "removed-line.diff",
  [
    "diff --git a/config/app.yml b/config/app.yml",
    "--- a/config/app.yml",
    "+++ b/config/app.yml",
    "@@ -1,2 +1,2 @@",
    `-  ${yamlKey}: ${JSON.stringify(yamlValue)}`,
    `+  ${yamlKey}: ${JSON.stringify("example")}`,
  ].join("\n") + "\n",
);
const deletedCodeDiff = writeFixture(
  "deleted-code.diff",
  [
    "diff --git a/scripts/report.mjs b/scripts/report.mjs",
    "deleted file mode 100644",
    "--- a/scripts/report.mjs",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    `-const owners = [{ name: "impl", ${sessionKey}: outputSession }];`,
    "-export { owners };",
  ].join("\n") + "\n",
);
const bodyHeaderDiff = writeFixture(
  "body-header.diff",
  [
    "diff --git a/docs/notes.md b/docs/notes.md",
    "--- a/docs/notes.md",
    "+++ b/docs/notes.md",
    "@@ -1,2 +1,2 @@",
    "--- src/notes.ts",
    `+  secret: "${proseValue}"`,
  ].join("\n") + "\n",
);
const malformedDiff = writeFixture("malformed.diff", "this is not a diff\nplain text\n");
const unsupportedFile = writeFixture("unsupported.bin", "plain text\n");

// 판정은 정본 스크립트 하나로 모은다. 스캐너를 다시 구현하지 않고 실제 함수를 한 번만 호출한다.
function scanAll(paths: string[]): Record<string, string | null> {
  const list = paths.map((path) => `'${path.replace(/'/g, "''")}'`).join(",");
  const command = [
    `. '${helperPath.replace(/'/g, "''")}'`,
    "$result = [ordered]@{}",
    `foreach ($path in @(${list})) { $result[$path] = Get-SuspiciousContentReason $path }`,
    "$result | ConvertTo-Json -Compress",
  ].join("; ");
  const result = Bun.spawnSync({
    cmd: ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`content-scan.ps1 사유 조회 실패: exit ${result.exitCode}\n${stderr}`);
  }
  return JSON.parse(result.stdout.toString().trim()) as Record<string, string | null>;
}

const reasons = scanAll([
  ...committedEvidence,
  ...scannerSources,
  cleanJsonl,
  bomJsonl,
  emptyJsonl,
  assignmentJsonl,
  directKeyJsonl,
  malformedJsonl,
  cleanDiff,
  codeIdentifierDiff,
  codeQuotedDiff,
  addedLineDiff,
  removedLineDiff,
  deletedCodeDiff,
  bodyHeaderDiff,
  malformedDiff,
  unsupportedFile,
  schemeOnlyCode,
  bearerSecretCode,
  parenthesizedReference,
  parenthesizedLiteral,
]);

describe("커밋된 증거", () => {
  test("정상 .jsonl·.diff 증거와 스캐너 소스는 통과한다", () => {
    const failed = [...committedEvidence, ...scannerSources].filter((path) => reasons[path] !== null);
    expect(failed.map((path) => `${path} :: ${reasons[path]}`)).toEqual([]);
  });
});

describe("비밀 탐지", () => {
  test("JSON 문자열 값과 diff 추가(+)·삭제(-) 줄의 비밀을 차단한다", () => {
    expect(reasons[assignmentJsonl]).toBe("Matched credential-like assignment");
    expect(reasons[directKeyJsonl]).toStartWith("Matched secret pattern");
    expect(reasons[addedLineDiff]).toBe("Matched credential-like assignment");
    expect(reasons[removedLineDiff]).toBe("Matched credential-like assignment");
    expect(reasons[codeQuotedDiff]).toBe("Matched credential-like assignment");
  });

  test("사유에 발견값과 키 실제값을 넣지 않는다", () => {
    for (const reason of [reasons[assignmentJsonl], reasons[directKeyJsonl], reasons[removedLineDiff], reasons[codeQuotedDiff]]) {
      expect(reason).not.toContain(sessionValue);
      expect(reason).not.toContain(sessionKey);
      expect(reason).not.toContain(yamlValue);
      expect(reason).not.toContain(awsShapedValue);
    }
  });
});

describe("예외와 경계", () => {
  test("HTTP scheme만 있는 코드 문자열과 실제 bearer credential을 구분한다", () => {
    expect(reasons[schemeOnlyCode]).toBeNull();
    expect(reasons[bearerSecretCode]).toStartWith("Matched secret pattern");
  });
  test("괄호 안 변수 참조는 허용하되 괄호로 감싼 비밀 문자열은 차단한다", () => {
    expect(reasons[parenthesizedReference]).toBeNull();
    expect(reasons[parenthesizedLiteral]).not.toBeNull();
  });
  test("코드 파일 diff 의 따옴표 없는 식별자는 비밀 리터럴로 보지 않는다", () => {
    expect(reasons[codeIdentifierDiff]).toBeNull();
  });

  test("지워진 파일 구간도 `---` 원본 확장자를 물려받는다", () => {
    expect(reasons[deletedCodeDiff]).toBeNull();
  });

  test("본문의 `--`·`++` 로 시작하는 줄은 구간 확장자를 바꾸지 않는다", () => {
    expect(reasons[bodyHeaderDiff]).toBeNull();
  });

  test("형식/파싱 실패와 미지원 확장자는 비밀 탐지와 구분해 실패한다", () => {
    expect(reasons[malformedJsonl]).toStartWith("Malformed JSONL");
    expect(reasons[malformedDiff]).toBe("Malformed diff (no git diff header)");
    expect(reasons[unsupportedFile]).toBe("Unsupported file type: .bin");
  });

  test("비밀이 없는 jsonl·diff 는 형식이 정상이면 통과한다", () => {
    expect(reasons[cleanJsonl]).toBeNull();
    expect(reasons[bomJsonl]).toBeNull();
    expect(reasons[emptyJsonl]).toBeNull();
    expect(reasons[cleanDiff]).toBeNull();
  });
});
