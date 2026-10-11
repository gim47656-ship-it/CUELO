import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as zod from "@oh-my-pi/omptype/zod";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";

// 2026-10-09: `windows_build`의 파라미터 이름이 `properties`였고, 코어 ark→wire 변환이 그 안의
// `properties: {}`를 `properties: true`로 바꿨다. 도구 목록은 매 요청에 실리므로 Anthropic·Codex가
// 모든 요청을 거절했다. 도구 단위 테스트로는 보이지 않는 결함이라, 실제로 등록되는 모든 도구를
// 코어 변환에 넣어 JSON Schema 키워드 자리의 값 타입을 확인한다.

type WireTool = Parameters<typeof toolWireSchema>[0];
interface Registered {
  source: string;
  tool: WireTool;
}

const agentDir = fileURLToPath(new URL("../../", import.meta.url));
const registered: Registered[] = [];

// 등록 경로 밖의 API는 아무 일도 하지 않는 호출 가능한 값으로 돌려준다. 이 테스트는 schema만 본다.
const inert: object = new Proxy(function inertApi() {}, {
  get: (_target, key) => (key === "then" ? undefined : inert),
  apply: () => inert,
});

function fakeApi(source: string): object {
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "zod") return zod;
        if (key === "registerTool") return (tool: WireTool) => registered.push({ source, tool });
        if (key === "then") return undefined;
        return inert;
      },
    },
  );
}

function entryFiles(): string[] {
  const files: string[] = [];
  const extensions = join(agentDir, "extensions");
  for (const entry of readdirSync(extensions, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test.")) files.push(join(extensions, entry.name));
    else if (entry.isDirectory() && existsSync(join(extensions, entry.name, "index.ts"))) files.push(join(extensions, entry.name, "index.ts"));
  }
  const tools = join(agentDir, "tools");
  for (const entry of readdirSync(tools, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(tools, entry.name, "index.ts"))) files.push(join(tools, entry.name, "index.ts"));
  }
  return files.sort();
}

function isWireTool(value: unknown): value is WireTool {
  return typeof value === "object" && value !== null && "name" in value && typeof value.name === "string" && "parameters" in value;
}

type SchemaNode = { [keyword: string]: unknown };
const SUBSCHEMA_KEYS = ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"];
const SUBSCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SUBSCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"];

// wire 출력은 JSON이다. 배열·null이 아닌 객체가 schema 노드이고, `true`/`false`는 boolean schema라 건너뛴다.
function keywordProblems(value: unknown, path: string, out: string[]): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  const node = value as SchemaNode;
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = node[key];
    if (!(key in node)) continue;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      out.push(`${path}.${key} = ${JSON.stringify(map)}`);
      continue;
    }
    for (const [name, schema] of Object.entries(map)) keywordProblems(schema, `${path}.${key}.${name}`, out);
  }
  if ("required" in node && !Array.isArray(node.required)) out.push(`${path}.required = ${JSON.stringify(node.required)}`);
  if ("enum" in node && !Array.isArray(node.enum)) out.push(`${path}.enum = ${JSON.stringify(node.enum)}`);
  if ("type" in node && typeof node.type !== "string" && !Array.isArray(node.type)) out.push(`${path}.type = ${JSON.stringify(node.type)}`);
  for (const key of SUBSCHEMA_KEYS) keywordProblems(node[key], `${path}.${key}`, out);
  for (const key of SUBSCHEMA_LIST_KEYS) {
    const list = node[key];
    if (Array.isArray(list)) list.forEach((schema, index) => keywordProblems(schema, `${path}.${key}[${index}]`, out));
  }
  return out;
}

for (const file of entryFiles()) {
  const source = file.slice(agentDir.length).replaceAll("\\", "/");
  // 확장·도구 목록은 디렉터리에서 발견하므로 정적 import로 쓸 수 없다.
  const mod: Record<string, unknown> = await import(file);
  const entry = mod.default;
  if (typeof entry !== "function") continue;
  const result: unknown = await entry(fakeApi(source));
  for (const tool of Array.isArray(result) ? result : [result]) if (isWireTool(tool)) registered.push({ source, tool });
}

describe("custom tool wire schemas", () => {
  test("keyword-named record parameters retain object property maps", () => {
    const fields = Object.fromEntries(
      ["properties", "items", "required", "type", "enum", "additionalProperties"].map(name => [
        name, zod.record(zod.string(), zod.string()).optional(),
      ]),
    );
    const wire = toolWireSchema({ name: "original_record_arguments", description: "", parameters: zod.object(fields) });
    expect(keywordProblems(wire, "original_record_arguments", [])).toEqual([]);
    for (const name of Object.keys(fields)) {
      expect((wire.properties as SchemaNode)[name]).toMatchObject({
        type: "object", properties: {}, additionalProperties: { type: "string" },
      });
    }
  });

  test("nested keyword-named schema map entries retain their empty property maps", () => {
    const record = { type: "object", properties: {}, additionalProperties: { type: "string" } };
    const parameters = {
      type: "object",
      properties: {
        properties: { type: "object", properties: { properties: record } },
        items: { type: "array", items: { type: "object", properties: { properties: record } } },
      },
      patternProperties: { properties: record },
      $defs: { properties: record },
      definitions: { properties: record },
    };
    const wire = toolWireSchema({ name: "nested_keyword_maps", description: "", parameters });
    expect(keywordProblems(wire, "nested_keyword_maps", [])).toEqual([]);
    expect(wire.properties).toEqual(parameters.properties);
    expect(wire.patternProperties).toEqual(parameters.patternProperties);
    // The draft upgrader moves legacy definitions into $defs.
    expect(wire.$defs).toEqual(parameters.$defs);
  });

  test("instance data containing schema keywords is not normalized as schemas", () => {
    const data = { properties: { properties: {} }, items: {}, additionalProperties: {} };
    const parameters = {
      type: "object",
      properties: {
        payload: { default: data, const: data, enum: [data], examples: [data] },
      },
    };
    const wire = toolWireSchema({ name: "keyword_instance_data", description: "", parameters });
    expect(wire.properties).toEqual(parameters.properties);
    expect(parameters.properties.payload.default).toEqual(data);
  });

  test("empty schemas and existing boolean schemas keep their supported semantics", () => {
    const parameters = {
      type: "object",
      properties: {
        open: {}, allowed: true, denied: false,
        array: { type: "array", items: {}, prefixItems: [{}, true, false] },
        union: { anyOf: [{}, true, false] },
        condition: { if: {}, then: {}, else: false, not: {} },
      },
      patternProperties: { open: {}, denied: false },
      $defs: { open: {}, denied: false },
      additionalProperties: {},
    };
    const wire = toolWireSchema({ name: "boolean_subschemas", description: "", parameters });
    expect(wire).toEqual({
      type: "object",
      properties: {
        open: true, allowed: true, denied: false,
        array: { type: "array", items: true, prefixItems: [true, true, false] },
        union: { anyOf: [true, true, false] },
        condition: { if: true, then: true, else: false, not: true },
      },
      patternProperties: { open: true, denied: false },
      $defs: { open: true, denied: false },
      additionalProperties: true,
    });
    expect(parameters.additionalProperties).toEqual({});
  });

  test("discovers the registered tools", () => {
    const names = registered.map(({ tool }) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["git_finalize", "windows_build", "skim", "draft", "maker_route", "routing_verdict"]));
  });

  for (const { source, tool } of registered) {
    test(`${tool.name} (${source}) keeps JSON Schema keyword slots well-typed`, () => {
      const wire = toolWireSchema(tool);
      expect(wire.type).toBe("object");
      expect(keywordProblems(wire, tool.name, [])).toEqual([]);
    });
  }
});
