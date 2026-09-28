import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReport, estimateTokens } from "./skill-cost.mjs";

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cost-"));
	roots.push(agentDir);
	const skill = (dir, name, body) => {
		fs.mkdirSync(path.join(agentDir, dir, name), { recursive: true });
		fs.writeFileSync(path.join(agentDir, dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: Use for ${name} work\n---\n${body}`);
	};
	skill("skills", "big", "x".repeat(4000));
	skill("skills", "small", "y".repeat(40));
	skill("managed-skills", "unused", "z".repeat(400));
	const read = (target) =>
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: target } }] } });
	const session = (name, lines, ageDays = 0) => {
		const file = path.join(agentDir, "sessions", "--proj--", name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		const time = new Date(Date.now() - ageDays * 86_400_000);
		fs.utimesSync(file, time, time);
	};
	session("a.jsonl", [read("skill://small"), read("skill://small"), read("skill://big/references/x.md")]);
	// Copies are not reads: a grep result quoting a session line, and a signature holding the call escaped.
	const quoted = JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "grep", content: [{ type: "text", text: read("skill://big") }] } });
	const signed = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi", textSignature: read("skill://big") }] } });
	session("b.jsonl", [read("skill://big"), quoted, signed, read("skill://gone")]);
	session("old.jsonl", [read("skill://big")], 90);
	return agentDir;
}

describe("skill cost report", () => {
	test("counts reads within the window and ranks by body tokens x reads", () => {
		const report = buildReport({ agentDir: fixture(), days: 30 });
		expect(report.sessionCount).toBe(2);
		const byName = Object.fromEntries(report.rows.map((row) => [row.name, row]));
		expect(byName.big).toMatchObject({ reads: 1, subFileReads: 1, sessions: 2 });
		expect(byName.small).toMatchObject({ reads: 2, sessions: 1 });
		expect(byName.unused).toMatchObject({ reads: 0, sessions: 0, spentTokens: 0, root: "managed" });
		expect(byName.gone).toMatchObject({ reads: 1, root: "not installed here", spentTokens: null });
		expect(byName.big.spentTokens).toBe(byName.big.bodyTokens);
		expect(report.rows.map((row) => row.name)).toEqual(["big", "small", "unused", "gone"]);
	});

	test("older sessions are included when the window covers them", () => {
		const report = buildReport({ agentDir: fixture(), days: 120 });
		expect(report.rows.find((row) => row.name === "big").reads).toBe(2);
	});

	test("estimates non-ASCII text at one token per character", () => {
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("한글")).toBe(2);
	});
});
