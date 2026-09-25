#!/usr/bin/env node

// 확장 TypeScript를 함께 검사해 중복 선언 진단(TS2393·TS2300·TS2451)만 보고한다.
// 사용: node patches/check-extension-duplicates.mjs [--root <OMP_Global_Config 경로>]
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let root = defaultRoot;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--root" && args[index + 1]) root = resolve(args[++index]);
  else {
    process.stderr.write(`알 수 없는 인자: ${args[index]}\n`);
    process.exit(2);
  }
}

function listTypeScript(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScript(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

const sourceDirectory = join(root, "agent", "extensions");
const files = listTypeScript(sourceDirectory);
if (files.length === 0) {
  process.stderr.write(`TypeScript 확장 소스가 없습니다: ${sourceDirectory}\n`);
  process.exit(2);
}
const tscArgs = [
  "--package=typescript@5.9.3",
  "tsc",
  "--noEmit",
  "--pretty",
  "false",
  "--skipLibCheck",
  "--target",
  "ES2022",
  "--module",
  "ESNext",
  "--moduleResolution",
  "Bundler",
  ...files,
];
const compiler = spawnSync("bunx", tscArgs, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
if (compiler.error) {
  process.stderr.write(`TypeScript 컴파일러 실행 실패: ${compiler.error.message}\n`);
  process.exit(2);
}
const output = `${compiler.stdout ?? ""}${compiler.stderr ?? ""}`;
const duplicates = output
  .split(/\r?\n/)
  .filter((line) => /error TS(?:2393|2300|2451):/.test(line));
if (duplicates.length > 0) {
  process.stderr.write(`확장 중복 선언 ${duplicates.length}건:\n${duplicates.join("\n")}\n`);
  process.exit(1);
}
if (compiler.status !== 0 && !/error TS(?:\d+):/.test(output)) {
  process.stderr.write(output || `TypeScript 컴파일러 종료 코드 ${compiler.status}\n`);
  process.exit(2);
}
process.stdout.write(`확장 중복 선언 없음 (${files.length}개 TypeScript 파일; TS2393·TS2300·TS2451).\n`);
