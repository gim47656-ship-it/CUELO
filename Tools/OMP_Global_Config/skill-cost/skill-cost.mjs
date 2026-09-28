#!/usr/bin/env bun
// Read-only skill context cost report, the omp counterpart of Claude Code's `/skill-doctor`.
//
// omp injects only each skill's name and a shortened description into the system prompt; the
// SKILL.md body enters the context each time a session reads `skill://<name>`. So the cost that
// matters is body size x reads, which this script measures from session history. No network or
// model calls; nothing is written.
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Token estimate without a tokenizer: ASCII runs cost about 4 characters per token, other
 * characters (Hangul, CJK) about 1 token each. Good enough to rank skills, not to bill.
 */
export function estimateTokens(text) {
	let ascii = 0;
	let other = 0;
	for (const ch of text) {
		if (ch.charCodeAt(0) < 128) ascii += 1;
		else other += 1;
	}
	return Math.ceil(ascii / 4) + other;
}

function frontmatterDescription(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) return "";
	const lines = match[1].split(/\r?\n/);
	const start = lines.findIndex((line) => /^description:/.test(line));
	if (start < 0) return "";
	const parts = [lines[start].replace(/^description:\s*/, "")];
	for (const line of lines.slice(start + 1)) {
		if (/^[\w-]+:/.test(line)) break;
		parts.push(line.trim());
	}
	return parts
		.join(" ")
		.replace(/^[>|][-+]?\s*/, "")
		.replace(/^["']|["']$/g, "")
		.trim();
}

/** Sum of the file sizes under a skill directory other than SKILL.md, in tokens. */
function referenceTokens(dir) {
	let total = 0;
	const walk = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (full !== path.join(dir, "SKILL.md") && /\.(md|txt|json|ya?ml|csv)$/i.test(entry.name)) {
				total += estimateTokens(fs.readFileSync(full, "utf8"));
			}
		}
	};
	walk(dir);
	return total;
}

export function listSkills(roots) {
	const skills = new Map();
	for (const { label, dir } of roots) {
		if (!fs.existsSync(dir)) continue;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const file = path.join(dir, entry.name, "SKILL.md");
			if (!fs.existsSync(file) || skills.has(entry.name)) continue;
			const text = fs.readFileSync(file, "utf8");
			skills.set(entry.name, {
				name: entry.name,
				root: label,
				descriptionTokens: estimateTokens(frontmatterDescription(text)),
				bodyTokens: estimateTokens(text),
				referenceTokens: referenceTokens(path.join(dir, entry.name)),
				disabledForModel: /^disable-model-invocation:\s*true\s*$/m.test(text),
			});
		}
	}
	return skills;
}

function sessionFiles(dir, sinceMs) {
	const files = [];
	const walk = (current) => {
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl") && fs.statSync(full).mtimeMs >= sinceMs) files.push(full);
		}
	};
	walk(dir);
	return files;
}

// A read is a `read` toolCall block in an assistant message whose path is `skill://<name>`
// (SKILL.md) or `skill://<name>/<file>`. Lines are parsed as JSON: the same call also appears
// escaped inside signatures, and grep/read results over session files quote it again, so a
// text match would count copies as reads.
const SKILL_PATH = /^skill:\/\/([a-z0-9][a-z0-9-]*)(\/.+)?$/;

function skillReadsInLine(line) {
	if (!line.includes("skill://") || !line.includes('"toolCall"')) return [];
	let entry;
	try {
		entry = JSON.parse(line);
	} catch {
		return [];
	}
	const message = entry?.type === "message" ? entry.message : undefined;
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
	const found = [];
	for (const block of message.content) {
		if (block?.type !== "toolCall" || block.name !== "read") continue;
		const match = SKILL_PATH.exec(String(block.arguments?.path ?? "").split(":raw")[0]);
		if (match) found.push({ name: match[1], subFile: Boolean(match[2]) });
	}
	return found;
}

export function countReads(sessionsDir, sinceMs) {
	const reads = new Map();
	const files = sessionFiles(sessionsDir, sinceMs);
	for (const file of files) {
		const seen = new Set();
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			for (const { name, subFile } of skillReadsInLine(line)) {
				const row = reads.get(name) ?? { reads: 0, subFileReads: 0, sessions: 0 };
				if (subFile) row.subFileReads += 1;
				else row.reads += 1;
				if (!seen.has(name)) {
					seen.add(name);
					row.sessions += 1;
				}
				reads.set(name, row);
			}
		}
	}
	return { reads, sessionCount: files.length };
}

/** Tokens of the shortened descriptions omp actually injects (whole catalog; keys are opaque). */
function injectedCatalogTokens(agentDir) {
	const file = path.join(agentDir, "skill-descriptions.db");
	if (!fs.existsSync(file)) return null;
	const db = new Database(file, { readonly: true });
	try {
		const rows = db.query("SELECT description FROM skill_descriptions").all();
		return { entries: rows.length, tokens: rows.reduce((sum, row) => sum + estimateTokens(row.description), 0) };
	} finally {
		db.close();
	}
}

export function buildReport({ agentDir, days, now = Date.now() }) {
	const skills = listSkills([
		{ label: "skills", dir: path.join(agentDir, "skills") },
		{ label: "managed", dir: path.join(agentDir, "managed-skills") },
	]);
	const { reads, sessionCount } = countReads(path.join(agentDir, "sessions"), now - days * 86_400_000);
	const rows = [...skills.values()].map((skill) => {
		const usage = reads.get(skill.name) ?? { reads: 0, subFileReads: 0, sessions: 0 };
		return { ...skill, ...usage, spentTokens: skill.bodyTokens * usage.reads };
	});
	// Reads of skills that are no longer installed (bundled, project-local or removed) stay visible.
	for (const [name, usage] of reads) {
		if (!skills.has(name)) rows.push({ name, root: "not installed here", descriptionTokens: null, bodyTokens: null, referenceTokens: null, disabledForModel: false, ...usage, spentTokens: null });
	}
	rows.sort((a, b) => (b.spentTokens ?? -1) - (a.spentTokens ?? -1) || b.reads - a.reads || a.name.localeCompare(b.name));
	return { days, sessionCount, rows, injectedCatalog: injectedCatalogTokens(agentDir) };
}

function formatNumber(value) {
	return value === null || value === undefined ? "-" : value.toLocaleString("en-US");
}

export function formatReport(report) {
	const header = ["skill", "root", "desc", "body", "refs", "reads", "sub", "sessions", "spent"];
	const lines = report.rows.map((row) => [
		row.name + (row.disabledForModel ? " (manual)" : "") + (row.reads === 0 && row.bodyTokens !== null ? " [never read]" : ""),
		row.root,
		formatNumber(row.descriptionTokens),
		formatNumber(row.bodyTokens),
		formatNumber(row.referenceTokens),
		formatNumber(row.reads),
		formatNumber(row.subFileReads),
		formatNumber(row.sessions),
		formatNumber(row.spentTokens),
	]);
	const widths = header.map((title, index) => Math.max(title.length, ...lines.map((line) => line[index].length)));
	const render = (cells) => cells.map((cell, index) => (index < 2 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]))).join("  ");
	const spent = report.rows.reduce((sum, row) => sum + (row.spentTokens ?? 0), 0);
	const catalog = report.injectedCatalog;
	return [
		`Skill context cost, last ${report.days} days, ${formatNumber(report.sessionCount)} session files`,
		"Tokens are estimates: ASCII chars / 4 + one per other character.",
		"desc = frontmatter description (upper bound of the always-on listing), body = SKILL.md per read,",
		"refs = other files in the skill dir, sub = reads of skill://<name>/<file>, spent = body x reads.",
		"",
		render(header),
		...lines.map(render),
		"",
		`Total body tokens read: ${formatNumber(spent)}`,
		catalog
			? `Injected shortened descriptions (skill-descriptions.db): ${formatNumber(catalog.entries)} entries, ${formatNumber(catalog.tokens)} tokens per session`
			: "Injected shortened descriptions: skill-descriptions.db not found",
	].join("\n");
}

function parseArgs(argv) {
	const options = { days: 30, json: false, agentDir: process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent") };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--days") options.days = Number(argv[++index]);
		else if (arg === "--agent-dir") options.agentDir = argv[++index];
		else throw new Error(`Unknown argument: ${arg}\nUsage: bun skill-cost.mjs [--days N] [--json] [--agent-dir DIR]`);
	}
	if (!Number.isFinite(options.days) || options.days <= 0) throw new Error("--days needs a positive number");
	return options;
}

if (import.meta.main) {
	try {
		const options = parseArgs(process.argv.slice(2));
		const report = buildReport(options);
		console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
}
