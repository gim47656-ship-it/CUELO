// 매직 키워드(`ultrathink`, `orchestrate`, `workflowz`) 알림 문구에 내 규칙을 덧붙인다.
//
// 대상은 이 저장소 밖의 전역 npm 패키지 `@oh-my-pi/pi-coding-agent` 의
// `src/prompts/system/*-notice.md` 다. omp-web 은 이 소스를 그대로 실행하므로 파일을
// 고치면 다음 세션부터 반영된다. `omp.exe`(TUI)는 컴파일된 바이너리라 영향이 없다.
//
//   node apply-notices.mjs           적용
//   node apply-notices.mjs --check   적용 여부만 확인
//   node apply-notices.mjs --revert  덧붙인 블록 제거(업스트림 원문으로)
//
// 업스트림 문구는 손대지 않는다. `</system-notice>` 바로 앞에 마커로 감싼 블록만
// 넣거나 갱신한다. 그래서 omp-web 을 업데이트해 문구가 바뀌어도 병합 충돌이 없고,
// 업스트림 개선을 조용히 덮어쓰지도 않는다. 내용은 미러의 `notices/<키워드>.md` 다.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BEGIN = "<!-- omp-global-config:notice-begin -->";
const END = "<!-- omp-global-config:notice-end -->";
const CLOSING = "</system-notice>";

// 미러 `notices/<이름>.md` -> 패키지 `src/prompts/system/<파일>`
const NOTICES = [
	{ name: "ultrathink", target: "ultrathink-notice.md" },
	{ name: "orchestrate", target: "orchestrate-notice.md" },
	{ name: "workflow", target: "workflow-notice.md" },
];

const MirrorRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 전역 npm 설치 위치는 PC마다 다르다. apply-core-patch.mjs 와 같은 순서로 찾는다.
 * 같은 패키지를 두 스크립트가 다르게 고르면 한쪽만 반영돼 원인 찾기가 어려워진다.
 */
function resolveTarget() {
	const probe = "src/prompts/system/ultrathink-notice.md";
	const seen = [];
	const add = p => {
		if (p && !seen.includes(p)) seen.push(p);
	};

	if (process.env.OMP_CORE_PATCH_TARGET) return process.env.OMP_CORE_PATCH_TARGET;

	const roots = [join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules")];
	for (const root of roots) {
		add(join(root, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"));
		add(join(root, "@oh-my-pi/pi-coding-agent"));
	}
	let found = seen.find(p => existsSync(join(p, probe)));
	if (found) return found;

	try {
		const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: true }).trim();
		add(join(npmRoot, "omp-web/node_modules/@oh-my-pi/pi-coding-agent"));
		add(join(npmRoot, "@oh-my-pi/pi-coding-agent"));
	} catch {
		// npm 이 없으면 위 후보만으로 판단한다.
	}
	return seen.find(p => existsSync(join(p, probe)));
}

/** 미러 파일에서 주석과 공백을 걷어낸 실제 주입 본문. 비면 주입하지 않는다. */
function readBlock(name) {
	const path = join(MirrorRoot, "notices", `${name}.md`);
	if (!existsSync(path)) return "";
	const text = readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "");
	return text.trim();
}

/** 마커 블록을 제거한 원문. 적용 전 상태를 계산할 때와 --revert 에 쓴다. */
function stripBlock(text) {
	const begin = text.indexOf(BEGIN);
	if (begin === -1) return text;
	const end = text.indexOf(END, begin);
	if (end === -1) return text;
	return (text.slice(0, begin) + text.slice(end + END.length)).replace(/\n{3,}/g, "\n\n");
}

/**
 * 원문의 마지막 `</system-notice>` 바로 앞에 블록을 넣는다. 닫는 태그가 없으면
 * (업스트림이 형식을 바꾼 경우) 맨 뒤에 붙인다 — 알림 자체는 여전히 전달된다.
 */
function merge(original, block) {
	const base = stripBlock(original);
	if (!block) return base;
	const wrapped = `${BEGIN}\n${block}\n${END}`;
	const at = base.lastIndexOf(CLOSING);
	if (at === -1) return `${base.trimEnd()}\n\n${wrapped}\n`;
	return `${base.slice(0, at).trimEnd()}\n\n${wrapped}\n${base.slice(at)}`;
}

const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--revert") ? "revert" : "apply";
const target = resolveTarget();
if (!target) {
	console.log("SKIP  omp-web 전역 설치를 찾지 못했다 (알림 문구 대상 없음).");
	process.exit(2);
}
console.log(`  대상 ${target}`);

let changed = 0;
let missing = 0;
let drift = 0;
for (const notice of NOTICES) {
	const path = join(target, "src/prompts/system", notice.target);
	if (!existsSync(path)) {
		console.log(`  없음         ${notice.target} (업스트림이 파일을 옮겼다)`);
		missing++;
		continue;
	}
	const current = readFileSync(path, "utf8");
	const wanted = mode === "revert" ? stripBlock(current) : merge(current, readBlock(notice.name));
	if (current === wanted) {
		console.log(`  일치         ${notice.target}`);
		continue;
	}
	if (mode === "check") {
		console.log(`  어긋남       ${notice.target}`);
		drift++;
		continue;
	}
	writeFileSync(path, wanted);
	console.log(`  ${mode === "revert" ? "복원" : "적용"}         ${notice.target}`);
	changed++;
}

if (missing > 0) process.exit(1);
if (mode === "check") process.exit(drift > 0 ? 1 : 0);
console.log(changed > 0 ? "완료. omp-web 을 재시작하면 새 세션에 반영된다." : "이미 적용돼 있다.");
process.exit(0);
