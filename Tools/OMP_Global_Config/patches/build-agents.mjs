// 서브에이전트 정의 `agent/agents/*.md` 를 `agent/sop/` 조각에서 만든다.
//
// 손으로 관리하던 역할 파일에는 같은 문장이 반복돼 있었다. 한 곳만 고치고 나머지를
// 잊는 사고가 실제로 났으므로, 공통 문장은 `agent/sop/_common.md` 같은 조각에 한 번만
// 쓰고 여기서 합친다. 단일 Maker의 모델은 @impl, 기본 추론은 medium이다.
// 발주 전 Main이 고른 tasks[].model의 concrete effort suffix가 생성 기본값보다 우선한다.
//
//   node patches/build-agents.mjs           조각에서 다시 만들어 덮어쓴다
//   node patches/build-agents.mjs --check   현재 파일이 재생성 결과와 같은지만 확인한다
//
// 산출물에는 시각·호스트명·경로가 들어가지 않는다. 집과 사무실 PC 가 같은 커밋에서
// 바이트까지 같은 파일을 만들어야 git 이 조용하다. 머리말 다음의 도장 주석에 든
// `source-hash` 는 파일 자신의 해시라서, 어긋난 파일이 손편집인지 원본만 바뀐 것인지
// 실행 없이도 갈라낼 수 있다.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 역할 -> 곁들일 계열 조각. 여기가 유일한 정본이다. `agent/sop/` 의 밑줄 없는 조각
// 목록과 양방향으로 대조하므로, 한쪽만 늘리면 생성이 멈춘다. 위임 가능한 child 역할은
// Maker 하나이고 Main은 SubAgent가 아니라 정의 파일이 없다.
const ROLES = {
	maker: ["_writer"],
};

// 모든 역할이 마지막에 붙이는 조각.
const CommonFragment = "_common";

// verify.ps1 의 effort 접미사 정규식과 같은 목록이어야 한다.
const Efforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
const EffortPattern = new RegExp(`:(${Efforts.join("|")})$`);

// 모든 역할의 모델은 조각의 `model: "@<별칭>"` 과 config.yml 의 `modelRoles` 가 정한다.
// task.agentModelOverrides 로만 모델을 받는 역할은 더 이상 없다.

const StampMarker = "<!-- omp-global-config:generated source-hash=";
const HashPlaceholder = "SELF";
const HashLength = 12;

const Status = {
	same: "일치",
	wrote: "생성",
	edited: "어긋남(손편집)",
	stale: "어긋남(원본 변경 - 재생성 필요)",
};

const MirrorRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SopDir = join(MirrorRoot, "agent", "sop");
const AgentsDir = join(MirrorRoot, "agent", "agents");
const ConfigPath = join(MirrorRoot, "agent", "config.yml");

const problems = [];

/** 검증 실패를 모은다. 하나라도 있으면 아무 파일도 쓰지 않고 끝낸다. */
function fail(message) {
	problems.push(message);
}

/**
 * 입력 정규화는 여기 한 곳에서만 한다. BOM 과 CRLF 가 섞여 들어오면 두 PC 가 서로
 * 다른 바이트를 만들고, 그러면 git 이 매번 diff 를 낸다.
 */
function readText(path) {
	return readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

// 동아시아 전각 문자 구간. 리터럴을 루프 안에 두면 매 글자마다 객체가 새로 생긴다.
const WideChar = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** 한글은 터미널에서 두 칸이다. 상태 열을 맞추려면 글자 수가 아니라 칸 수로 세야 한다. */
function displayWidth(text) {
	let width = 0;
	for (const char of text) width += WideChar.test(char) ? 2 : 1;
	return width;
}

const StatusColumn = Math.max(...Object.values(Status).map(displayWidth)) + 2;

/** `  상태<정렬>파일명 <꼬리말>` 한 줄. apply-notices.mjs 와 같은 모양이다. */
function log(status, name, note) {
	const gap = " ".repeat(Math.max(1, StatusColumn - displayWidth(status)));
	console.log(`  ${status}${gap}${name}${note ? `  (${note})` : ""}`);
}

/**
 * `modelRoles:` 블록만 훑는다. verify.ps1 의 Get-ModelRoleMap 과 규칙이 같아야 한다 -
 * 두 코드가 다르게 읽으면 생성은 통과하는데 검사는 떨어지는 상태가 된다.
 */
function readModelRoles() {
	const map = new Map();
	if (!existsSync(ConfigPath)) {
		fail("agent/config.yml 이 없다. effort 를 정할 수 없다.");
		return map;
	}
	let inside = false;
	for (const line of readText(ConfigPath).split("\n")) {
		if (/^modelRoles\s*:/i.test(line)) {
			inside = true;
			continue;
		}
		if (!inside) continue;
		if (/^\S/.test(line)) break;
		const match = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\S.*?)\s*$/.exec(line);
		if (match) map.set(match[1].toLowerCase(), match[2]);
	}
	return map;
}

/** 조각 하나를 읽는다. `agent/sop/` 안의 thinking-level은 역할별 생성 계약과 충돌하므로 금지한다. */
function readFragment(name) {
	const path = join(SopDir, `${name}.md`);
	if (!existsSync(path)) {
		fail(`조각이 없다: agent/sop/${name}.md`);
		return null;
	}
	const text = readText(path);
	if (/(?:^|\n)\s*thinking-level\s*:/.test(text)) {
		fail(`agent/sop/${name}.md 에 thinking-level 이 있다. 역할별 생성 계약은 build-agents.mjs가 정한다.`);
		return null;
	}
	return text;
}

/** `---` 로 감싼 머리말과 본문을 나눈다. 머리말 줄은 손대지 않고 순서 그대로 넘긴다. */
function splitFragment(role, text) {
	const lines = text.split("\n");
	if (lines[0] !== "---") {
		fail(`agent/sop/${role}.md 에 YAML 머리말이 없다.`);
		return null;
	}
	const end = lines.indexOf("---", 1);
	if (end < 0) {
		fail(`agent/sop/${role}.md 의 머리말이 닫히지 않았다.`);
		return null;
	}
	return { front: lines.slice(1, end), body: lines.slice(end + 1).join("\n").trim() };
}

/** 머리말을 검증하고 native task effort가 없을 때의 기본 medium을 넣는다. */
function resolveFrontmatter(role, front, modelRoles) {
	const name = front.find((line) => /^name\s*:/.test(line));
	if (!name) {
		fail(`agent/sop/${role}.md 에 name 이 없다.`);
		return null;
	}
	const declared = name.replace(/^name\s*:\s*/, "").trim().replace(/^["']|["']$/g, "");
	if (declared !== role) {
		fail(`agent/sop/${role}.md 의 name(${declared}) 이 파일명(${role}) 과 다르다.`);
		return null;
	}
	const modelIndex = front.findIndex((line) => /^model\s*:/.test(line));
	const alias = modelIndex >= 0 && /^model\s*:\s*"@([A-Za-z_][A-Za-z0-9_]*)"\s*$/.exec(front[modelIndex]);
	if (!alias) {
		fail(`agent/sop/${role}.md 의 model 이 "@<별칭>" 형태가 아니다.`);
		return null;
	}
	const source = `modelRoles.${alias[1]}`;
	const value = modelRoles.get(alias[1].toLowerCase());
	if (value === undefined) {
		fail(`역할 ${role}: config.yml 의 ${source} 이 없다.`);
		return null;
	}
	if (!EffortPattern.test(value)) {
		fail(`역할 ${role}: ${source} = ${value} 에 effort 접미사가 없다.`);
		return null;
	}
	const resolved = front.slice();
	resolved.splice(modelIndex + 1, 0, "thinking-level: medium");
	return resolved;
}

/** 머리말 다음에 오는 도장 주석. `고칠 곳` 은 그 역할이 실제로 쓰는 조각만 적는다. */
function stamp(role, family) {
	const sources = [`agent/sop/${role}.md`, ...family.map((name) => `agent/sop/${name}.md`), `agent/sop/${CommonFragment}.md`];
	return [
		`${StampMarker}${HashPlaceholder}`,
		"  이 파일은 patches/build-agents.mjs 가 만든 빌드 산출물이다. 직접 수정하지 마라.",
		`  고칠 곳: ${sources.join(" · ")}`,
		"  재생성: node patches/build-agents.mjs   검사: node patches/build-agents.mjs --check",
		"-->",
	].join("\n");
}

/**
 * 도장은 항상 머리말 바로 다음 절이다. 그 자리만 본다 - 본문이나 description 에 같은
 * 문자열이 들어 있어도 엉뚱한 곳을 해시 자리로 잡지 않는다.
 */
function stampOffset(text) {
	if (!text.startsWith("---\n")) return -1;
	const front = text.indexOf("\n---\n\n", 3);
	if (front < 0) return -1;
	const at = front + "\n---\n\n".length;
	return text.startsWith(StampMarker, at) ? at : -1;
}

/** 파일에 적힌 해시 12자리. 형태가 어긋나면 null - 도장이 없거나 망가진 파일은 손편집으로 본다. */
function readStampHash(text) {
	const at = stampOffset(text);
	if (at < 0) return null;
	const from = at + StampMarker.length;
	const hash = text.slice(from, from + HashLength);
	return /^[0-9a-f]+$/.test(hash) && hash.length === HashLength ? hash : null;
}

/** 해시 자리를 `SELF` 로 되돌린 본문. 자기 해시 계산은 넣을 때와 검사할 때 같은 씨앗을 써야 한다. */
function seed(text, hash) {
	const at = stampOffset(text);
	if (at < 0) return text;
	const from = at + StampMarker.length;
	return text.slice(0, from) + HashPlaceholder + text.slice(from + hash.length);
}

function hash12(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, HashLength);
}

/** 산출물이 자기 도장과 맞는지. 맞으면 손대지 않은 산출물(=원본이 움직인 것)이다. */
function isIntactProduct(text) {
	const written = readStampHash(text);
	if (!written) return false;
	return hash12(seed(text, written)) === written;
}

/** 머리말 + 도장 + 역할 본문 + 계열 본문 + 공통 본문. 사이는 빈 줄 하나씩, 끝은 개행 하나. */
function compose(front, sections) {
	return `---\n${front.join("\n")}\n---\n\n${sections.map((section) => section.trim()).join("\n\n")}\n`;
}

for (const [label, dir] of [["조각", SopDir], ["산출물", AgentsDir]]) {
	if (existsSync(dir)) continue;
	console.error(`${label} 디렉터리가 없다: ${dir}`);
	process.exit(1);
}

const mode = process.argv.includes("--check") ? "check" : "apply";
console.log(`  대상 ${AgentsDir}`);

// 조각 목록과 ROLES 표를 양방향으로 대조한다. 한쪽에만 있는 이름은 조용히 넘기면
// 안 된다 - 조각을 새로 넣고 표를 잊으면 그 역할은 영원히 만들어지지 않는다.
const tableRoles = Object.keys(ROLES);
const fragmentRoles = readdirSync(SopDir)
	.filter((name) => name.endsWith(".md") && !name.startsWith("_"))
	.map((name) => name.slice(0, -3));
for (const role of fragmentRoles) {
	if (!tableRoles.includes(role)) fail(`agent/sop/${role}.md 에 대응하는 ROLES 표 항목이 없다.`);
}
for (const role of tableRoles) {
	if (!fragmentRoles.includes(role)) fail(`ROLES 표의 ${role} 에 대응하는 agent/sop/${role}.md 가 없다.`);
}

// 조각 원본이 없어진 산출물은 고아다. 지우는 건 사람이 판단할 일이라 여기서는 멈추기만 한다.
for (const file of readdirSync(AgentsDir).filter((name) => name.endsWith(".md"))) {
	if (!tableRoles.includes(file.slice(0, -3))) fail(`agent/agents/${file} 은 조각 원본이 없는 고아다.`);
}

const modelRoles = readModelRoles();
const common = readFragment(CommonFragment);
const families = new Map();
for (const family of new Set(tableRoles.flatMap((role) => ROLES[role]))) {
	families.set(family, readFragment(family));
}

// 전부 메모리에서 만든 뒤에 쓴다. 절반만 새 조각으로 바뀐 상태가 남으면 어느 파일이
// 최신인지 알 수 없다.
const built = [];
for (const role of tableRoles) {
	const text = readFragment(role);
	if (text === null || common === null) continue;
	const parts = splitFragment(role, text);
	if (!parts) continue;
	const front = resolveFrontmatter(role, parts.front, modelRoles);
	if (!front) continue;
	const family = ROLES[role];
	const bodies = family.map((name) => families.get(name)).filter((body) => body !== null && body !== undefined);
	if (bodies.length !== family.length) continue;
	// 해시 자리에 `SELF` 를 박은 완성본을 먼저 만들고, 그 바이트의 SHA-256 앞 12자리를
	// 같은 자리에 되꽂는다. 그래서 파일만 보고 자기 해시를 다시 계산할 수 있다.
	const seeded = compose(front, [stamp(role, family), parts.body, ...bodies, common]);
	const at = stampOffset(seeded);
	if (at < 0) {
		fail(`역할 ${role}: 도장 자리를 찾지 못했다. 조각 머리말이 깨졌다.`);
		continue;
	}
	const from = at + StampMarker.length;
	const output = seeded.slice(0, from) + hash12(seeded) + seeded.slice(from + HashPlaceholder.length);
	built.push({ role, file: `${role}.md`, text: output });
}

if (problems.length > 0 || built.length !== tableRoles.length) {
	for (const problem of problems) console.error(`  실패 ${problem}`);
	console.error("아무 파일도 쓰지 않았다.");
	process.exit(1);
}

let changed = 0;
let drift = 0;
const wrote = [];
try {
	for (const agent of built) {
		const path = join(AgentsDir, agent.file);
		const current = existsSync(path) ? readText(path) : null;
		if (current === agent.text) {
			log(Status.same, agent.file);
			continue;
		}
		if (mode === "check") {
			if (current === null) log(Status.stale, agent.file, "파일이 없다");
			else log(isIntactProduct(current) ? Status.stale : Status.edited, agent.file);
			drift++;
			continue;
		}
		writeFileSync(path, agent.text);
		wrote.push({ path, file: agent.file, previous: current });
		log(Status.wrote, agent.file);
		changed++;
	}
} catch (error) {
	// 권한·디스크·파일 락으로 쓰기가 중간에 깨지면 이미 바꾼 파일을 되돌린다. 역할 파일이
	// 서로 다른 세대로 남으면 어느 것이 최신인지 파일만 보고는 알 수 없다.
	console.error(`  실패 쓰기 중 오류: ${error.message}`);
	const unrestored = [];
	for (const entry of wrote.reverse()) {
		try {
			if (entry.previous === null) rmSync(entry.path);
			else writeFileSync(entry.path, entry.previous);
		} catch (restoreError) {
			unrestored.push(`${entry.file}(${restoreError.message})`);
		}
	}
	if (unrestored.length > 0) console.error(`되돌리지 못했다. 손으로 확인하라: ${unrestored.join(", ")}`);
	else console.error(`바꾼 ${wrote.length}개를 모두 되돌렸다. 원인을 고친 뒤 다시 실행하라.`);
	process.exit(1);
}

if (mode === "check") {
	if (drift > 0) {
		console.error(`어긋난 파일 ${drift}개. node patches/build-agents.mjs 로 다시 만들어라.`);
		process.exit(1);
	}
	console.log("조각과 산출물이 모두 일치한다.");
	process.exit(0);
}
console.log(changed > 0 ? `완료. ${changed}개를 다시 만들었다. .\\setup.ps1 로 전역에 반영하라.` : "이미 조각과 같다.");
process.exit(0);
