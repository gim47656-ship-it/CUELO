// Isolated SDK lifecycle regression: no live banks, models or credentials.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { settingsLike } from "./core-test-settings";
const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET required");
// The SDK path is runtime-selected so this test exercises the patched copy, not the live installation.
const stateMod = await import(resolve(core, "src/mnemopi/state.ts"));
const { mnemopiBackend } = await import(resolve(core, "src/mnemopi/backend.ts"));
const { LearnTool } = await import(resolve(core, "src/tools/learn.ts"));
await stateMod.loadMnemopi();
await stateMod.loadMnemopiCore();
const root = mkdtempSync(join(tmpdir(), "core-lazy-bank-"));
const states: InstanceType<typeof stateMod.MnemopiSessionState>[] = [];
const config = {
 dbPath: join(root, "mem", "mnemopi.db"), baseBank: "shared", globalBank: "shared", bank: "project", retainBank: "project", recallBanks: ["project", "shared"],
 scoping: "per-project-tagged", autoRecall: true, autoRetain: false, polyphonicRecall: false, enhancedRecall: true, proactiveLinking: false,
 retainEveryNTurns: 1, recallLimit: 8, recallContextTurns: 1, recallMaxQueryChars: 800, debug: false,
 providerOptions: { noEmbeddings: true, llm: false, reconcile: false, debug: false }, llmMode: "none",
};
function open(id: string, cfg = config, aliasOf?: InstanceType<typeof stateMod.MnemopiSessionState>) {
 const session = { sessionId: id, cwd: root, settings: settingsLike({get: (k: string) => k === "memory.backend" ? "mnemopi" : k === "autolearn.enabled" ? true : undefined}),
  sessionManager: { getCwd: () => root, getSessionId: () => id, getEntries: () => [], getBranch: () => [], appendCustomEntry: () => "entry" },
  getXdevToolEntries: () => [], subscribe: () => () => {}, getMnemopiSessionState: () => state };
 const state = new stateMod.MnemopiSessionState({sessionId: id, config: cfg, session, aliasOf});
 stateMod.setMnemopiSessionState(session, state); states.push(state);
 state.attachSessionListeners(); state.promoteEligibleWorkingMemory();
 return {state, session};
}
try {
 mkdirSync(root, {recursive:true});
 const a = open("a"), b = open("b");
 const paths = stateMod.getMnemopiScopedDbPaths(config);
 assert(paths.every((p: string) => !existsSync(p)), "opening a fresh cwd must not create empty banks");
 assert.deepEqual(await a.state.recallResultsScoped("connection port"), []);
 assert.equal(a.state.getScopedMemory("absent"), null);
 assert.equal(a.state.editScopedMemory("update", "absent", {content:"nothing"}).status, "not_found");
 await a.state.forceRetainCurrentSession();
 const status = await mnemopiBackend.status({agentDir:root, session:a.session});
 assert.equal(status.active, true); assert.equal(status.writable, true); assert.equal(status.workingCount, 0);
 assert(paths.every((p: string) => !existsSync(p)), "recall, lookup, empty retention and stats must not create banks");
 const inactiveSession = {...a.session};
 stateMod.setMnemopiSessionState(inactiveSession, undefined);
 const inactive = await mnemopiBackend.status({agentDir:root, session:inactiveSession});
 assert.equal(inactive.active, false); assert.equal(inactive.writable, false);
 console.log("PASS R1-ANT-1 stateless backend remains inactive");
 const lifecycle = open("lifecycle", {...config, autoRetain:true});
 await lifecycle.state.beforeAgentStartPrompt("connection port");
 await mnemopiBackend.preCompactionContext([{role:"user",content:"connection port"}], lifecycle.session.settings, lifecycle.session);
 await lifecycle.state.maybeRetainOnAgentEnd([]);
 await lifecycle.state.dispose();
 assert(paths.every((p: string) => !existsSync(p)), "normal empty lifecycle and default disposal create no bank");
 console.log("PASS R1-ANT-2 empty automatic lifecycle and default dispose");
 const id = a.state.rememberScoped("connection port must close before reopen", {scope:"bank", source:"coding-agent-learn", extract:false});
 assert(existsSync(paths[0]), "first retention persists to the original project path");
 assert(!existsSync(config.dbPath), "project retention does not create the absent global bank");
 assert.equal(b.state.getScopedMemory(id)?.row.content, "connection port must close before reopen", "an already-open peer discovers the newly created bank");
 const bId = b.state.rememberScoped("connection retry must follow close", {scope:"bank", extract:false});
 assert(a.state.getScopedMemory(bId));
 const child = open("child", config, a.state);
 const childId = child.state.rememberScoped("connection child shares project bank", {scope:"bank", extract:false});
 assert(a.state.getScopedMemory(childId));
 await child.state.dispose({consolidate:false});
 assert(a.state.getScopedMemory(id), "alias disposal does not close parent");
 const globalId = a.state.rememberScoped("connection global preference", {scope:"bank", extract:false}, a.state.getGlobalRetainTarget());
 assert(existsSync(config.dbPath));
 assert(b.state.getScopedMemory(globalId));
 const text = await b.state.recallForContext("connection");
 assert(text?.includes(id) && text.includes(globalId), "existing project and global recall remain visible");
 const fresh = open("global-reader", {...config, bank:"other", retainBank:"other", recallBanks:["other", "shared"]});
 const rows = await fresh.state.recallResultsScoped("connection global preference");
 assert(fresh.state.formatScopedRecallContext(rows));
 assert(!existsSync(stateMod.getMnemopiScopedDbPaths(fresh.state.config)[0]), "formatting global results does not create a project bank");
 const learned = open("learner", {...config, bank:"learn", retainBank:"learn", recallBanks:["learn", "shared"]});
 const result = await new LearnTool(learned.session).execute("learn", {memory:"connection preference uses short answers", kind:"preference", topic:"connection-answer-style"});
 const learnedId = /id: ([^,)]+)/.exec(String(result.content[0]?.text))?.[1];
 assert(learnedId && learned.state.getScopedMemory(learnedId), "topic learn creates and stores in the deferred bank");
 await a.state.dispose({consolidate:false}); await b.state.dispose({consolidate:false});
 const reopened = open("reopened");
 assert(reopened.state.getScopedMemory(id) && reopened.state.getScopedMemory(bId) && reopened.state.getScopedMemory(childId), "all writes survive reopening");
 console.log("PASS lazy startup/read/stats, first retain, peer discovery, alias, global recall, topic learn, reopen");
 const closed = open("closed", {...config, dbPath:join(root,"closed","mnemopi.db")});
 await closed.state.dispose({consolidate:false});
 assert.throws(() => closed.state.rememberScoped("late write", {scope:"bank", extract:false}), /closed/i);
 assert(stateMod.getMnemopiScopedDbPaths(closed.state.config).every((p:string) => !existsSync(p)));
 console.log("PASS R1-ANT-3 post-dispose write refuses to reopen a bank");
} finally {
 for (const state of states) await state.dispose({consolidate:false});
 rmSync(root, {recursive:true, force:true});
}
