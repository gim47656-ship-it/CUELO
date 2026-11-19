// Run with OMP_CORE_PATCH_TARGET set to the patched 19 core. Optionally use
// OMP_LEGACY_ARTIFACT_CORE to allocate the fixture with the pristine 18.22.2 manager.
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
// Load the requested physical SDK packages, not the workspace resolver's copy.
const src = (file: string, root = target) => pathToFileURL(join(root!, "src", file)).href;
const { InternalUrlRouter, sessionResolveContext } = await import(src("internal-urls/index.ts"));
const { ReadTool } = await import(src("tools/read.ts"));
const { Settings } = await import(src("config/settings.ts"));
const { resolveLocalRoot } = await import(src("internal-urls/local-root.ts"));

const root = await mkdtemp(join(tmpdir(), "omp-legacy-spill-"));
try {
	const artifacts = join(root, "session");
	const options = { getArtifactsDir: () => artifacts, getSessionId: () => "legacy-probe" };
	const local = resolveLocalRoot(options);
	await mkdir(local, { recursive: true });
	const legacyCore = process.env.OMP_LEGACY_ARTIFACT_CORE;
	if (legacyCore) {
		const { ArtifactManager } = await import(src("session/artifacts.ts", legacyCore));
		const manager = new ArtifactManager(artifacts);
		assert.equal(await manager.save("LEGACY-FIRST\nLEGACY-SECOND\n", "old/tool"), "0");
	} else {
		await writeFile(join(artifacts, "0.old_tool.log"), "LEGACY-FIRST\nLEGACY-SECOND\n");
	}
	await writeFile(join(local, "0.log"), "CURRENT-SPILL\n");
	await writeFile(join(local, "1.log"), "ONLY-CURRENT\n");
	await writeFile(join(artifacts, "1.md"), "SIDECAR\n");
	await writeFile(join(artifacts, "0.a.b.log"), "NOT-A-LEGACY-NAME\n");
	await writeFile(join(root, "outside.log"), "OUTSIDE\n");
	if (process.platform !== "win32") {
		await symlink(join(root, "outside.log"), join(artifacts, "2.bash.log"));
		await link(join(root, "outside.log"), join(artifacts, "3.bash.log"));
	}
	await mkdir(join(artifacts, "4.bash.log"));
	await writeFile(join(artifacts, "5.bash.log"), "FIRST\n");
	await writeFile(join(artifacts, "5.read.log"), "SECOND\n");
	const session = {
		cwd: root, hasUI: false, getSessionFile: () => `${artifacts}.jsonl`,
		localProtocolOptions: options, settings: Settings.isolated({}),
	};
	const tool = new ReadTool(session);
	const router = InternalUrlRouter.instance();
	const context = sessionResolveContext(session);
	const read = async (path: string): Promise<string> => {
		const result = await tool.execute("legacy-read", { path });
		if (result.isError) throw new Error(JSON.stringify(result.content));
		return result.content.map((block: { text?: string }) => block.text ?? "").join("\n");
	};
	if (process.platform !== "linux") {
		await assert.rejects(() => read("artifact://0"), /Legacy artifact reads require Linux/);
		assert.match(await read("local://0.log:raw:1"), /CURRENT-SPILL/);
		assert.equal(router.fileWritable("artifact://0"), false);
		console.log("Legacy artifact reads fail closed on this platform; native local:// remains available.");
		process.exitCode = 0;
	} else {
	const selected = await read("artifact://0:raw:2");
	assert.match(selected, /LEGACY-SECOND/);
	assert.doesNotMatch(selected, /LEGACY-FIRST|CURRENT-SPILL/);
	assert.match(await read("local://0.log:raw:1"), /CURRENT-SPILL/);
	assert.equal((await router.resolve("artifact://0", context)).content, "LEGACY-FIRST\nLEGACY-SECOND\n");
	await assert.rejects(() => read("artifact://1"), /Legacy artifact 1 not found/);
	await assert.rejects(() => read("artifact://0/.."), /requires a numeric ID/);
	await assert.rejects(() => read("artifact://0%2F.."), /requires a numeric ID/);
	if (process.platform !== "win32") {
		await assert.rejects(() => read("artifact://2"), /not a regular file inside this session/);
		await assert.rejects(() => read("artifact://3"), /not a regular file inside this session/);
	}
	await assert.rejects(() => read("artifact://4"), /not a regular file inside this session/);
	await assert.rejects(() => read("artifact://5"), /matches multiple files/);
	if (process.platform === "linux") {
		await writeFile(join(artifacts, "6.bash.log"), "LARGE-FIRST\n" + "filler\n".repeat(1_300_000));
		await assert.rejects(() => router.resolve("artifact://6", context), /full-resource read limit/);
		assert.match(await read("artifact://6:raw:1"), /LARGE-FIRST/);
	}
	await assert.rejects(() => router.resolve("artifact://0"), /No session - legacy artifacts unavailable/);
	assert.equal(router.fileWritable("artifact://0"), false);
	assert.deepEqual(router.writeTier("artifact://0", "replacement", session), {
		tier: "write", policy: "deny", reason: "artifact:// URLs are read-only",
	});
	console.log(`Legacy and current spill IDs resolve separately; native selectors, missing IDs, containment, and write denial held${legacyCore ? " (actual v18 allocator)" : ""}.`);
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
