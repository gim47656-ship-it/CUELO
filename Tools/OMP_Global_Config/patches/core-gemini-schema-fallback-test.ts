// Runtime imports deliberately select the pristine/patched isolated package tree.
// OMP_CORE_PATCH_TARGET=<isolated core> GEMINI_SCHEMA_BASELINE=<snapshot> bun run <this file>
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET required (isolated core only)");
const packages = resolve(target, "..");
const { buildModel } = await import(`${packages}/pi-catalog/src/build.ts`);
const { getBundledModel } = await import(`${packages}/pi-catalog/src/models.ts`);
const { convertTools, buildGoogleGenerateContentParams } = await import(`${packages}/pi-ai/src/providers/google-shared.ts`);
const { streamOpenAICompletions } = await import(`${packages}/pi-ai/src/providers/openai-completions.ts`);
const { streamOpenAIResponses } = await import(`${packages}/pi-ai/src/providers/openai-responses.ts`);
const schema = await import(`${packages}/pi-ai/src/utils/schema/index.ts`);
const tools = [
  { name: "mcp__hwpx_add_chart", description: "Add chart", strict: false, parameters: {
    type: "object", properties: { data: { type: "array", items: true } }, required: ["data"] } },
  { name: "mcp__rea_open", description: "Open schema", strict: false, parameters: {
    type: "object", properties: { request: {}, rows: { type: "array" }, flag: false,
      record: { type: "object", additionalProperties: true },
      shape: { anyOf: [true, { type: "string" }] }, unsupported: { type: "string", pattern: "x", default: "x" } } } },
  { name: "mcp__hwpx_replay_document_blueprint", description: "Replay", strict: false, parameters: {
    type: "object", properties: { request: { type: "object", properties: { path: { type: "string" } },
      required: ["bundle", "path", "missing"] } }, required: ["request"] } },
];
const before = JSON.stringify(tools);
const gemini = buildModel({ id: "gemini-4-hydrogen", name: "Gemini", api: "openai-completions", provider: "fixture-gateway",
  baseUrl: "https://fixture.invalid/v1", input: ["text"], reasoning: false, contextWindow: 500000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const native = getBundledModel("google-vertex", "gemini-4-hydrogen");
const context = { tools, messages: [{ role: "user", content: "OK", timestamp: 1 }] };
async function capture(streamer: Function, model: unknown, toolList = tools, requestOptions: Record<string, unknown> = {}): Promise<string> {
  let captured: string | undefined;
  const stream = streamer(model, { ...context, tools: toolList }, {
    apiKey: "fixture", maxTokens: 16,
    onPayload(payload: unknown) { captured = JSON.stringify(payload); throw new Error("Captured before HTTP"); },
    fetch: async () => { throw new Error("Unexpected network request"); },
    ...requestOptions,
  });
  await stream.result();
  assert.ok(captured, "real provider builder must reach onPayload before HTTP");
  return captured;
}
const untouched = {
  openai: await capture(streamOpenAICompletions, buildModel({ id: "gpt-4o-mini", name: "GPT", api: "openai-completions",
    provider: "fixture-gateway", baseUrl: "https://fixture.invalid/v1", input: ["text"], reasoning: false,
    contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  otherApi: await capture(streamOpenAIResponses, getBundledModel("openai", "gpt-4o-mini")),
};
// Captured from pristine 18.20.2 via --baseline; exact request strings, not re-derived expectations.
const baseline = process.env.GEMINI_SCHEMA_BASELINE ?? resolve(import.meta.dir, "core-gemini-schema-baseline.json");
if (process.argv.includes("--baseline")) {
  writeFileSync(baseline, JSON.stringify(untouched));
  console.log("Captured pristine non-Gemini request bodies (OpenAI completions and responses)");
  process.exit(0);
}
const declarations = convertTools(tools, native)[0].functionDeclarations;
const chart = declarations[0].parametersJsonSchema;
assert.equal(typeof chart.properties.data.items, "object", "Gemini items:true must become a representable schema, not a boolean");
assert.ok(chart.properties.data.items.type, "boolean subschema must carry a Gemini type");
const open = declarations[1].parametersJsonSchema.properties;
assert.ok(open.request.type, "open schemas require a type");
assert.ok(open.rows.items.type, "arrays require typed items");
assert.ok(open.flag.type, "false subschemas loosen instead of disabling the tool");
assert.equal(open.unsupported.pattern, undefined, "unsupported validators stay off the wire");
assert.deepEqual(declarations[2].parametersJsonSchema.properties.request.required, ["path"], "required only names declared properties");
assert.equal(declarations.length, tools.length, "all office-pattern tools remain available");
const openaiPayload = JSON.parse(await capture(streamOpenAICompletions, gemini));
assert.equal(openaiPayload.tools.length, tools.length);
assert.deepEqual(openaiPayload.tools.map((tool: {function: {parameters: unknown}}) => tool.function.parameters), declarations.map((tool: {parametersJsonSchema: unknown}) => tool.parametersJsonSchema));
assert.deepEqual(untouched, JSON.parse(readFileSync(baseline, "utf8")), "every byte of both non-Gemini request bodies remains unchanged");
assert.equal(JSON.stringify(tools), before, "canonical tool schemas must not mutate");
const { registerLogSink } = await import(`${packages}/pi-utils/src/logger.ts`);
const warnings: string[] = [];
const disposeLog = registerLogSink((event: {level: string; message: string}) => {
  if (event.level === "warn") warnings.push(event.message);
});
try {
  const invalid = { ...tools[0], name: "bad name" };
  const kept = convertTools([...tools, invalid], native)[0].functionDeclarations;
  assert.equal(kept.length, tools.length, "only the invalid declaration is omitted");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad name.*omitted/);
} finally { disposeLog(); }
const badOnly = [{ ...tools[0], name: "bad name" }];
assert.equal(convertTools(badOnly, native), undefined, "all omissions remove the native tool block");
for (const toolChoice of ["any", { allowedFunctionNames: ["bad name"] }]) {
  const nativeEmpty = buildGoogleGenerateContentParams(native, { ...context, tools: badOnly }, { toolChoice });
  assert.equal(nativeEmpty.config.tools, undefined);
  assert.equal(nativeEmpty.config.toolConfig, undefined, "no forced native choice survives an empty tool roster");
}
const nativeMissing = buildGoogleGenerateContentParams(native, { ...context, tools: [...tools, ...badOnly] },
  { toolChoice: { allowedFunctionNames: ["bad name"] } });
assert.equal(nativeMissing.config.toolConfig, undefined, "an omitted named tool is not force-selectable");
const nativeMixed = buildGoogleGenerateContentParams(native, { ...context, tools: [...tools, ...badOnly] },
  { toolChoice: { allowedFunctionNames: ["bad name", tools[0].name] } });
assert.deepEqual(nativeMixed.config.toolConfig.functionCallingConfig.allowedFunctionNames, [tools[0].name]);
for (const toolChoice of ["auto", "required", { type: "function", function: { name: "bad name" } }]) {
  const empty = JSON.parse(await capture(streamOpenAICompletions, gemini, badOnly, { toolChoice }));
  assert.equal(empty.tools, undefined);
  assert.equal(empty.tool_choice, undefined, "all omissions also remove OpenAI forced/auto choices");
}
const namedMissing = JSON.parse(await capture(streamOpenAICompletions, gemini, [...tools, ...badOnly],
  { toolChoice: { type: "function", function: { name: "bad name" } } }));
assert.equal(namedMissing.tool_choice, undefined);
// Cyclic and scalar roots are unrepresentable: loosen the schema, retain the declaration.
const cyclic: Record<string, unknown> = { type: "object", properties: {} };
(cyclic.properties as Record<string, unknown>).self = cyclic;
assert.doesNotThrow(() => schema.normalizeSchemaForGeminiTool(cyclic));
assert.deepEqual(schema.normalizeSchemaForGeminiTool(42), { type: "object", properties: {} });
const union = schema.normalizeSchemaForGeminiTool({ type: "object", properties: {
  value: { anyOf: [{ type: "string", enum: ["", "known"] }, { type: "number" }], description: "union" },
}, anyOf: [{ required: ["value"] }, { required: ["missing"] }] });
assert.equal(union.anyOf, undefined, "typed union siblings loosen instead of sending invalid anyOf plus type");
const projectedUnion = union.properties.value;
assert.deepEqual(Object.keys(projectedUnion), ["anyOf"], "untyped anyOf must be the only emitted field");
assert.equal(projectedUnion.anyOf[0].enum, undefined, "empty string enums loosen instead of provoking a provider 400");
const nativeUnion = schema.normalizeSchemaForGeminiTool({ type: "object", properties: { value: { type: "string" } },
  anyOf: [{ required: ["value"] }, { required: ["missing"] }] }, "native");
assert.equal(nativeUnion.type, "object");
assert.ok(nativeUnion.anyOf, "native parametersJsonSchema retains JSON-schema unions without gateway expansion");
assert.ok(nativeUnion.anyOf.every((branch: {type: string}) => branch.type === "object"),
  "partial object alternatives must not become incompatible string branches");
assert.deepEqual(nativeUnion.properties, { value: { type: "string" } }, "native projection avoids gateway-only property expansion");
const rootUnion = schema.normalizeSchemaForGeminiTool({ anyOf: [
  { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
  { type: "object", properties: { b: { type: "number" } } },
] }, "native");
assert.equal(rootUnion.type, "object");
assert.deepEqual(rootUnion.properties, { a: { type: "string" }, b: { type: "number" } },
  "native root object unions lower to a permissive object retaining every branch's parameters");
const objectBranches = [
  { type: "object", properties: { a: { type: "string" } } },
  { type: "object", properties: { b: { type: "number" } } },
];
for (const source of [{ type: "object", anyOf: objectBranches }, { oneOf: objectBranches },
  { anyOf: [...objectBranches, { type: "null" }] }]) {
  assert.deepEqual(schema.normalizeSchemaForGeminiTool(source, "native").properties,
    { a: { type: "string" }, b: { type: "number" } }, "typed, oneOf and nullable native root unions preserve parameters");
}
const duplicates = schema.normalizeSchemaForGeminiTool({ anyOf: Array.from({ length: 10 }, () =>
  ({ type: "object", properties: { action: { type: "string" } } })) }, "native");
assert.deepEqual(duplicates.properties.action, { type: "string" }, "identical branch fields do not grow nested anyOf");
const mixedTypes = schema.normalizeSchemaForGeminiTool({ anyOf: [
  { type: "object", properties: { value: { type: "string" } } },
  { type: "object", properties: { value: { type: "number" } } },
  { type: "object", properties: { value: { type: "string" } } },
] }, "native");
assert.deepEqual(mixedTypes.properties.value, { anyOf: [{ type: "string" }, { type: "number" }] },
  "distinct branch fields form a flat deduplicated union");
const alias = JSON.parse(await capture(streamOpenAICompletions, { ...gemini, id: "aliased-hydrogen" }));
assert.ok(alias.tools[0].function.parameters.properties.data.items.type, "catalog lineage selects aliased Gemini models");
const fallback = JSON.parse(await capture(streamOpenAICompletions, { ...gemini, identity: { class: "unknown" } }));
assert.ok(fallback.tools[0].function.parameters.properties.data.items.type, "unclassified gemini- ids use the documented fallback");
const notGemini = JSON.parse(await capture(streamOpenAICompletions, { ...gemini, identity: { class: "openai" } }));
assert.deepEqual(notGemini.tools, JSON.parse(untouched.openai).tools, "explicit non-Gemini lineage overrides misleading id prefixes");
console.log("Gemini native/OpenAI projection, office fixtures, isolation, omission warning and byte-identical non-Gemini bodies verified");
