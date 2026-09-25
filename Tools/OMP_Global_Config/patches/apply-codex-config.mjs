// Codex CLI(`~/.codex/config.toml`) 설정 고정.
//
// 이 파일은 이 저장소 밖에 있고 PC마다 내용이 다르다(`notify` 절대 경로, `[projects.*]`
// trust_level 등). 그래서 파일을 미러링하지 않고 필요한 키만 제자리에서 맞춘다.
//
//   node apply-codex-config.mjs           적용
//   node apply-codex-config.mjs --check   적용 여부만 확인
//   node apply-codex-config.mjs --revert  컨텍스트 키 제거(Codex 기본값 272K 복귀)
//
// 종료 코드: 0 정상, 1 적용 필요, 2 Codex CLI 설정 없음.
// setup.ps1 은 2를 실패가 아니라 SKIP 으로 처리한다.
//
// TOML 최상위 키는 반드시 첫 `[section]` 헤더보다 앞에 있어야 한다. 뒤에 두면 그
// 섹션의 키로 해석된다. 삽입 위치를 그 경계 안으로 제한하는 이유다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TARGET = process.env.OMP_CODEX_CONFIG ?? join(homedir(), ".codex", "config.toml");

/**
 * 별도 Codex CLI(`~/.codex/config.toml`)에 적용하는 운영 선택이다. 512K window와 460K
 * auto-compact 값을 유지하며, OMP의 Astra model override나 공식 권장 sweet spot을 뜻하지 않는다.
 */
const DESIRED = {
	model_context_window: 512000,
	model_auto_compact_token_limit: 460000,
};

/** 활성 상태로 두지 않을 키. 값은 지우지 않고 주석 처리해 되켤 수 있게 남긴다. */
const DISABLED = ["service_tier"];

const mode = process.argv.includes("--revert") ? "revert" : process.argv.includes("--check") ? "check" : "apply";

if (!existsSync(TARGET)) {
	console.error(`NOTFOUND  Codex CLI 설정이 없다: ${TARGET}`);
	console.error("          Codex CLI 미설치이거나 아직 한 번도 실행하지 않은 PC다.");
	process.exit(2);
}

const raw = readFileSync(TARGET, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

/** 첫 `[section]` 헤더 위치. 최상위 키는 이 앞에만 둘 수 있다. */
const boundary = (() => {
	const i = lines.findIndex(l => /^\s*\[/.test(l));
	return i === -1 ? lines.length : i;
})();

const isActive = (line, key) => new RegExp(`^\\s*${key}\\s*=`).test(line);
const findActive = key => {
	for (let i = 0; i < boundary; i++) if (isActive(lines[i], key)) return i;
	return -1;
};

const issues = [];
for (const [key, value] of Object.entries(DESIRED)) {
	const i = findActive(key);
	if (i === -1) issues.push({ kind: "missing", key, value });
	else if (lines[i].trim() !== `${key} = ${value}`) issues.push({ kind: "wrong", key, value, at: i });
}
for (const key of DISABLED) {
	const i = findActive(key);
	if (i !== -1) issues.push({ kind: "enabled", key, at: i });
}

const label = { missing: "없음", wrong: "값 다름", enabled: "켜져 있음" };
for (const issue of issues) console.log(`  ${label[issue.kind].padEnd(9)} ${issue.key}`);

if (mode === "check") {
	if (mode === "check" && issues.length === 0) {
		for (const key of Object.keys(DESIRED)) console.log(`  일치      ${key}`);
		for (const key of DISABLED) console.log(`  꺼짐      ${key}`);
	}
	console.log(issues.length === 0 ? "APPLIED  전부 일치" : "MISSING  적용 필요");
	process.exit(issues.length === 0 ? 0 : 1);
}

if (mode === "revert") {
	let removed = 0;
	for (const key of Object.keys(DESIRED)) {
		const i = findActive(key);
		if (i === -1) continue;
		lines[i] = `# ${lines[i]}`;
		removed++;
	}
	writeFileSync(TARGET, lines.join(eol), "utf8");
	console.log(
		removed > 0
			? `복원 완료. 컨텍스트 키 ${removed}개를 주석 처리했다. Codex 기본값 272K 로 돌아간다.`
			: "복원할 것이 없다.",
	);
	process.exit(0);
}

if (issues.length === 0) {
	console.log("SKIP  이미 일치한다.");
	process.exit(0);
}

// 값이 틀린 키는 제자리에서 고치고, 켜져 있는 키는 주석 처리한다.
for (const issue of issues) {
	if (issue.kind === "wrong") lines[issue.at] = `${issue.key} = ${issue.value}`;
	else if (issue.kind === "enabled") lines[issue.at] = `# ${lines[issue.at]}`;
}

// revert 와 apply 를 반복하면 주석 처리된 옛 사본이 쌓인다. 관리 키의 주석 사본만
// 지운다. `service_tier` 의 주석 줄은 되켜는 방법을 남기는 것이므로 건드리지 않는다.
// 앞의 제자리 수정이 끝난 뒤에 지워야 issues 의 인덱스가 어긋나지 않는다.
const stale = new RegExp(`^\\s*#\\s*(${Object.keys(DESIRED).join("|")})\\s*=`);
for (let i = boundary - 1; i >= 0; i--) if (stale.test(lines[i])) lines.splice(i, 1);

// 없는 키는 최상위 영역 끝에 넣는다. 첫 `[section]` 앞이어야 유효하다.
const missing = issues.filter(i => i.kind === "missing");
if (missing.length > 0) {
	const block = missing.map(i => `${i.key} = ${i.value}`);
	// 위에서 줄을 지웠으므로 경계를 다시 계산한다.
	const head = lines.findIndex(l => /^\s*\[/.test(l));
	let insertAt = head === -1 ? lines.length : head;
	while (insertAt > 0 && lines[insertAt - 1].trim() === "") insertAt--;
	// 마커는 한 번만 둔다. 없을 때만 붙이지 않으면 왕복마다 한 줄씩 쌓인다.
	const marker = "# OMP_Global_Config 관리 항목. 근거는 미러 README 의 컨텍스트 제한 절.";
	const prefix = lines.slice(0, insertAt).includes(marker) ? [] : [marker];
	lines.splice(insertAt, 0, ...prefix, ...block);
}

writeFileSync(TARGET, lines.join(eol), "utf8");
for (const issue of issues) console.log(`  적용 ${issue.key}`);
console.log("적용 완료. 다음 codex 실행부터 반영된다.");
