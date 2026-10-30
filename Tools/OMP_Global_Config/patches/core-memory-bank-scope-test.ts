// mnemopi 회상 은행 범위(doc/history/2026/10/29-recall-bottlenecks). 실행:
//   OMP_CORE_PATCH_TARGET=<patched-core copy> bun run patches/core-memory-bank-scope-test.ts
// [1] legacy 은행 스캔 상한(64)은 working_memory 가 있는 은행만 센다. 빈 은행·읽을 수 없는 은행이 앞을 채워도 뒤의 안전한 같은-cwd 은행에 닿는다.
// [2] 빈 것으로 기억한 은행도 기록이 생기면(파일 서명이 바뀌면) 다시 본다.
// [3] 저장소 하위 폴더 세션은 git 루트의 프로젝트 은행이 이미 있으면 회상 은행에 더한다. 쓰기 은행은 하위 폴더 은행 그대로이고,
//     루트 은행 DB 가 없으면 더하지도 만들지도 않는다.
// [4] 기억이 있는 은행은 cwd 판정 질의가 실패해도(깨진 metadata) 상한에 센다.
// [5] linked worktree 세션은 메인 체크아웃의 같은 자리(루트·하위 폴더) 은행에 쓰고 그 루트 은행을 회상한다. bare 저장소(`.git` 이라는
//     이름이어도, core.bare 를 따옴표·주석과 함께 써도), commondir 가 `.git` 이 아닌 경우, 이 플랫폼이 열 수 없는 Windows gitdir,
//     submodule 식 `.git` 파일, 끊긴 gitdir 은 cwd 그대로다. 저장소·worktree 는 실제 git 으로 만든다.
// 네트워크·`~/.omp` 접근 없음(임시 폴더, git 은 로컬 init·clone·worktree 만). 동적 import 는 OMP_CORE_PATCH_TARGET 이 고른 core 사본을 읽기 위해서다.
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

	console.log("[5] linked worktree 세션은 메인 체크아웃의 같은 자리 은행을 쓰고 회상한다");
	// Real repositories made by git: the helper asks git whether the common dir is bare, so the fixture must be one git accepts.
	const git = (...args: string[]) => {
		const out = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdout: "pipe", stderr: "pipe" });
		if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
	};
	banksDir = join(memDir, "banks");
	const main = join(root, "main");
	nodeFs.mkdirSync(main);
	git("-C", main, "init", "-q");
	git("-C", main, "commit", "-q", "--allow-empty", "-m", "base");
	const mainBank = config.projectBankSegment(main);
	const mainSubBank = config.projectBankSegment(join(main, "Tools", "Sub"));
	makeBank(mainBank, [main]);
	const wtRoot = join(root, "main-worktrees", "wt-a");
	git("-C", main, "worktree", "add", "-q", "-b", "wt/a", wtRoot);
	const wtSub = join(wtRoot, "Tools", "Sub");
	nodeFs.mkdirSync(wtSub, { recursive: true });
	cfg = load(wtRoot);
	assert.equal(cfg.retainBank, mainBank, "a worktree root writes to the main checkout's project bank");
	assert.deepEqual([...cfg.recallBanks], [mainBank, "default"], "a worktree root recalls what the main checkout recalls");
	cfg = load(wtSub);
	assert.equal(cfg.retainBank, mainSubBank, "a worktree subfolder writes to the bank of the same subfolder in the main checkout");
	assert.deepEqual([...cfg.recallBanks], [mainSubBank, "default", mainBank], "a worktree subfolder also recalls the main checkout's root bank");
	assert.equal(nodeFs.existsSync(join(banksDir, config.projectBankSegment(wtRoot))), false, "no worktree bank appears");
	// git 2.48 `worktree.useRelativePaths` writes a relative gitdir; one is rewritten by hand so older git covers it too.
	const wtRel = join(root, "main-worktrees", "wt-rel");
	git("-C", main, "worktree", "add", "-q", "-b", "wt/rel", wtRel);
	nodeFs.writeFileSync(join(wtRel, ".git"), "gitdir: ../../main/.git/worktrees/wt-rel\n");
	assert.equal(load(wtRel).retainBank, mainBank, "a relative gitdir resolves to the main checkout too");
	assert.deepEqual([...load(main).recallBanks], [mainBank, "default"], "the main checkout itself is unchanged");

	const ownBank = (dir: string, why: string) => assert.equal(load(dir).retainBank, config.projectBankSegment(dir), why);
	// Bare repositories have no main checkout, whatever their folder is called and however core.bare is spelled.
	git("clone", "-q", "--bare", main, join(root, "bare.git"));
	const bareWt = join(root, "bare-worktrees", "wt-c");
	git("-C", join(root, "bare.git"), "worktree", "add", "-q", "-b", "wt/c", bareWt);
	ownBank(bareWt, "a bare repository's worktree has no main checkout: it keeps its own bank");
	const store = join(root, "store", ".git");
	git("clone", "-q", "--bare", main, store);
	const storeWt = join(root, "store-worktrees", "wt-g");
	git("-C", store, "worktree", "add", "-q", "-b", "wt/g", storeWt);
	ownBank(storeWt, "a bare repository stored as <dir>/.git has no main checkout either");
	git("config", "--file", join(store, "config"), "--unset", "core.bare");
	nodeFs.appendFileSync(join(store, "config"), '[core]\n\tbare = "true" # bare storage\n');
	ownBank(storeWt, "a quoted core.bare with a trailing comment is still bare");
	// Pointers that never reach git.
	const otherWt = join(root, "other-worktrees", "wt-d");
	const otherAdmin = join(root, "other", "gitstore", "worktrees", "wt-d");
	nodeFs.mkdirSync(otherWt, { recursive: true });
	nodeFs.mkdirSync(otherAdmin, { recursive: true });
	nodeFs.writeFileSync(join(otherWt, ".git"), `gitdir: ${otherAdmin}\n`);
	nodeFs.writeFileSync(join(otherAdmin, "commondir"), "../..\n");
	ownBank(otherWt, "a common dir not named .git keeps its own bank");
	const winWt = join(root, "win-worktrees", "wt-e");
	nodeFs.mkdirSync(winWt, { recursive: true });
	nodeFs.writeFileSync(join(winWt, ".git"), "gitdir: C:/Users/user/src/repo/.git/worktrees/wt-e\n");
	ownBank(winWt, "a Windows drive gitdir this platform cannot open keeps its own bank");
	const module = join(main, "mod");
	nodeFs.mkdirSync(join(main, ".git", "modules", "mod"), { recursive: true });
	nodeFs.mkdirSync(module, { recursive: true });
	nodeFs.writeFileSync(join(module, ".git"), "gitdir: ../.git/modules/mod\n");
	ownBank(module, "a submodule's .git file (no commondir) keeps its own bank");
	const dangling = join(root, "dangling-worktrees", "wt-f");
	nodeFs.mkdirSync(dangling, { recursive: true });
	nodeFs.writeFileSync(join(dangling, ".git"), "gitdir: /nonexistent/repo/.git/worktrees/wt-f\n");
	ownBank(dangling, "a dangling gitdir keeps its own bank");
	console.log("PASS core-memory-bank-scope-test");
} finally {
	nodeFs.readdirSync = realReaddir;
	nodeFs.rmSync(root, { recursive: true, force: true });
}
