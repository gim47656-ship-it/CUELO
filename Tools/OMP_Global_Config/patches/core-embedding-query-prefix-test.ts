// Local E5 query prefixes must compose with the upstream 18.20.3 queryPrefix option.
// OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-embedding-query-prefix-test.ts
// The real embedding module runs with a local initializer fixture; no model or network is used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const target = process.env.OMP_CORE_PATCH_TARGET;
assert.ok(target, "OMP_CORE_PATCH_TARGET must identify the isolated core");
const root = resolve(target, "../pi-mnemopi/src/core");
// Runtime-selected package copies are the boundary under test; static imports would select the installed SDK.
const embeddings = await import(`${root}/embeddings.ts`);
const { withMnemopiRuntimeOptions } = await import(`${root}/runtime-options.ts`);
const hasQueryPrefix = readFileSync(`${root}/runtime-options.ts`, "utf8").includes("queryPrefix?: string;");
const cases: Array<[string, string | undefined, string]> = [["default", undefined, "query: needle-default"]];
if (hasQueryPrefix) cases.push(
	["configured", "query: ", "query: needle-configured"],
	["custom", "Instruct: find\nQuery: ", "Instruct: find\nQuery: needle-custom"],
	["empty", "", "needle-empty"],
);
const saved = process.env.MNEMOPI_EMBEDDING_QUERY_PREFIX;
delete process.env.MNEMOPI_EMBEDDING_QUERY_PREFIX;
try {
	for (const [label, prefix, expected] of cases) {
		const seen: string[] = [];
		embeddings.setLocalModelInitializerForTests(async () => ({
			embed: (texts: readonly string[]) => (async function* () {
				seen.push(...texts);
				yield texts.map(() => [1, 0, 0]);
			})(),
		}));
		await withMnemopiRuntimeOptions({ embeddings: {
			model: "intfloat/multilingual-e5-large", queryPrefix: prefix,
			allowLocal: () => true, allowLocalLoad: () => true,
		} }, () => embeddings.embedQuery(`needle-${label}`));
		console.log(label, JSON.stringify(seen));
		assert.deepEqual(seen, [expected], `${label} query reaches the local embedder exactly once`);
	}
} finally {
	embeddings.resetEmbeddingProviderForTests();
	if (saved === undefined) delete process.env.MNEMOPI_EMBEDDING_QUERY_PREFIX;
	else process.env.MNEMOPI_EMBEDDING_QUERY_PREFIX = saved;
}
console.log(`${cases.length} query prefix cases passed`);
