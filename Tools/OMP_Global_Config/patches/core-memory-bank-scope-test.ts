// mnemopi 회상 은행 범위(doc/history/2026/10/29-recall-bottlenecks). 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core copy> bun run patches/core-memory-bank-scope-test.ts
// [1] legacy 은행 스캔 상한(64)은 working_memory 가 있는 은행만 센다. 빈 은행·읽을 수 없는 은행이 앞을 채워도 뒤의 안전한 같은-cwd 은행에 닿는다.
// [2] 빈 것으로 기억한 은행도 기록이 생기면(파일 서명이 바뀌면) 다시 본다.
// [3] 저장소 하위 폴더 세션은 git 루트의 프로젝트 은행이 이미 있으면 회상 은행에 더한다. 쓰기 은행은 하위 폴더 은행 그대로이고,
//     루트 은행 DB 가 없으면 더하지도 만들지도 않는다.
// [4] 기억이 있는 은행은 cwd 판정 질의가 실패해도(깨진 metadata) 상한에 센다.
// 네트워크·`~/.omp` 접근 없음(임시 폴더). 동적 import 는 OMP_CORE_PATCH_TARGET 이 고른 core 사본을 읽기 위해서다.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import type * as NodeFs from "node:fs";
import { join, resolve } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET required (scratch core only)");
const core = resolve(target, "src");
// The scan walks banks/ in readdirSync order, which the filesystem decides. The test hands the banks back with every
// empty bank first so the cap is reached deterministically, the way this PC's 372 empty banks crowd the first 64 slots.
// Test seam: Bun builds a module's `import * as fs` bindings from the CommonJS node:fs object when node:fs is first
// linked as ESM, so this file reaches it only through require (no static node:fs import here) and patches it before
// the core module below is imported.
const nodeFs: typeof NodeFs = require("node:fs");
const realReaddir = nodeFs.readdirSync;
let banksDir = "";
const reorderedReaddir = (path: string, options?: unknown) => {
	const entries = realReaddir(path as never, options as never) as unknown as { name: string }[];
	return path === banksDir ? [...entries].sort((a, b) => a.name.localeCompare(b.name)) : entries;
};
nodeFs.readdirSync = reorderedReaddir as typeof nodeFs.readdirSync;
const config = await import(`${core}/mnemopi/config.ts`);

const root = nodeFs.mkdtempSync(join(tmpdir(), "bank-scope-"));
const memDir = join(root, "memories", "mnemopi");
const dbPath = join(memDir, "mnemopi.db");
banksDir = join(memDir, "banks");

function makeBank(name: string, cwds: string[]): string {
	const dir = join(banksDir, name);
	nodeFs.mkdirSync(dir, { recursive: true });
	const file = join(dir, "mnemopi.db");
	const db = new Database(file, { create: true });
	db.run("PRAGMA journal_mode=WAL");
	db.run("CREATE TABLE IF NOT EXISTS working_memory (id INTEGER PRIMARY KEY, metadata_json TEXT)");
	for (const cwd of cwds) db.query("INSERT INTO working_memory (metadata_json) VALUES (?)").run(JSON.stringify({ cwd }));
	db.close();
	return file;
}

try {
	nodeFs.mkdirSync(memDir, { recursive: true });
	const legacyCwd = join(root, "legacy-cwd");

	console.log("[1] 빈 은행·읽을 수 없는 은행은 스캔 상한에 세지 않는다");
	for (let i = 0; i < 70; i++) makeBank(`a-empty-${String(i).padStart(3, "0")}`, []);
	// SQLite files without a working_memory table: the probe fails, and that must not consume the cap either.
	for (let i = 0; i < 66; i++) {
		const dir = join(banksDir, `b-notable-${String(i).padStart(3, "0")}`);
		nodeFs.mkdirSync(dir, { recursive: true });
		const db = new Database(join(dir, "mnemopi.db"), { create: true });
		db.run("CREATE TABLE other (id INTEGER)");
		db.close();
	}
	makeBank("m-foreign", ["/somewhere/else"]);
	makeBank("z-legacy", [legacyCwd, legacyCwd]);
	assert.deepEqual(
		[...config.extendRecallWithLegacyBanks(["own"], dbPath, legacyCwd)],
		["own", "z-legacy"],
		"the safe single-cwd bank behind 70 empty and 66 unreadable banks is recalled; the mixed one is not",
	);

	console.log("[2] 빈 은행에 기록이 생기면 다시 본다");
	const late = join(banksDir, "a-empty-005", "mnemopi.db");
	assert.deepEqual([...config.extendRecallWithLegacyBanks(["own"], dbPath, legacyCwd)], ["own", "z-legacy"]);
	const db = new Database(late);
	db.query("INSERT INTO working_memory (metadata_json) VALUES (?)").run(JSON.stringify({ cwd: legacyCwd }));
	db.close();
	assert.deepEqual(
		[...config.extendRecallWithLegacyBanks(["own"], dbPath, legacyCwd)],
		["own", "a-empty-005", "z-legacy"],
		"a bank remembered as empty is probed again once a write changed its files",
	);

	console.log("[3] 하위 폴더 세션은 git 루트의 기존 프로젝트 은행도 회상한다");
	const repo = join(root, "repo");
	const sub = join(repo, "Tools", "Sub");
	nodeFs.mkdirSync(join(repo, ".git"), { recursive: true });
	nodeFs.mkdirSync(sub, { recursive: true });
	const rootBank = config.projectBankSegment(repo);
	const subBank = config.projectBankSegment(sub);
	const load = (cwd: string) => {
		const values: Record<string, unknown> = { "memory.backend": "mnemopi", "mnemopi.scoping": "per-project-tagged", "mnemopi.dbPath": dbPath };
		const settings = { ...createSettingsTestScope(key => values[key]), getCwd: () => cwd };
		return config.loadMnemopiConfig(settings, root);
	};

	let cfg = load(sub);
	assert.equal(cfg.retainBank, subBank, "the write bank stays the subfolder's own bank");
	assert.deepEqual([...cfg.recallBanks], [subBank, "default"], "no root bank database yet: nothing added");
	assert.equal(nodeFs.existsSync(join(banksDir, rootBank)), false, "resolving the scope does not create the root bank");

	makeBank(rootBank, [repo]);
	cfg = load(sub);
	assert.equal(cfg.retainBank, subBank, "the write bank stays the subfolder's own bank");
	assert.deepEqual([...cfg.recallBanks], [subBank, "default", rootBank], "the existing root bank joins the recall set");

	cfg = load(repo);
	assert.deepEqual([...cfg.recallBanks], [rootBank, "default"], "a session at the root keeps its own scope without duplicates");

	const globalValues: Record<string, unknown> = { "memory.backend": "mnemopi", "mnemopi.scoping": "global", "mnemopi.dbPath": dbPath };
	const globalCfg = config.loadMnemopiConfig({ ...createSettingsTestScope(key => globalValues[key]), getCwd: () => sub }, root);
	assert.deepEqual([...globalCfg.recallBanks], ["default"], "global scoping is unchanged");

	console.log("[4] 기억이 있는 은행은 판정 질의가 실패해도 상한에 센다");
	const memDir2 = join(root, "memories2", "mnemopi");
	const dbPath2 = join(memDir2, "mnemopi.db");
	banksDir = join(memDir2, "banks");
	for (let i = 0; i < 64; i++) {
		const file = makeBank(`c-badjson-${String(i).padStart(3, "0")}`, []);
		const db = new Database(file);
		db.query("INSERT INTO working_memory (metadata_json) VALUES (?)").run("{not json");
		db.close();
	}
	makeBank("z-late", [legacyCwd]);
	assert.deepEqual(
		[...config.extendRecallWithLegacyBanks(["own"], dbPath2, legacyCwd)],
		["own"],
		"64 populated banks whose cwd check fails on malformed metadata still fill the cap",
	);
	console.log("PASS core-memory-bank-scope-test");
} finally {
	nodeFs.readdirSync = realReaddir;
	nodeFs.rmSync(root, { recursive: true, force: true });
}
