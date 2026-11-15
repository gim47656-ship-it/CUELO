import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// lab_screen_find가 처음 쓰일 때 집, 사무실, 클라우드에서 같은 방식으로 OCR 실행 환경을 갖춘다:
// ~/.omp/python-env에 rapidocr_onnxruntime(고정 버전)과 ~/.omp/ocr-models의 한국어 인식 모델 두 파일(sha256 확인).
// 검출 모델은 rapidocr_onnxruntime 휠에 들어 있다.

export const RAPIDOCR_SPEC = "rapidocr_onnxruntime==1.4.4";

// RapidOCR default_models.yaml v3.10.0의 Korean PP-OCRv5 mobile 인식 모델과 사전.
export const MODEL_FILES = [
  {
    name: "korean_PP-OCRv5_rec_mobile.onnx",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile.onnx",
    sha256: "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b",
  },
  {
    name: "ppocrv5_korean_dict.txt",
    url: "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv5/rec/korean_PP-OCRv5_rec_mobile/ppocrv5_korean_dict.txt",
    sha256: "a88071c68c01707489baa79ebe0405b7beb5cca229f4fc94cc3ef992328802d7",
  },
] as const;

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SetupDeps {
  pythonEnv: string;
  modelsDir: string;
  run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal }): Promise<Run>;
  download(url: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export function runProcess(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = options.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
  child.on("error", (error) => {
    clearTimeout(timer);
    resolve({ code: -1, stdout, stderr: stderr || String(error) });
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? -1, stdout, stderr });
  });
  return promise;
}

export function realSetupDeps(): SetupDeps {
  const omp = join(homedir(), ".omp");
  return {
    pythonEnv: join(omp, "python-env"),
    modelsDir: join(omp, "ocr-models"),
    run: runProcess,
    async download(url, signal) {
      const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(120_000), redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const tail = (run: Run) => (run.stderr || run.stdout).trim().slice(-400);

export interface Ready {
  python: string;
  modelsDir: string;
  /** 이번 호출에서 새로 한 준비 단계. 이미 갖춰져 있었으면 비어 있다. */
  steps: string[];
}

/** 실행 환경을 갖춘다. 실패하면 사람에게 보여 줄 이유를 담은 Error를 던진다. */
export async function ensureReady(deps: SetupDeps, signal?: AbortSignal): Promise<Ready> {
  const steps: string[] = [];
  const python = join(deps.pythonEnv, "bin", "python");
  if (!existsSync(python)) {
    const fresh = !existsSync(deps.pythonEnv);
    const venv = await deps.run("python3", ["-m", "venv", deps.pythonEnv], { timeoutMs: 120_000, signal });
    if (venv.code !== 0 || !existsSync(python)) {
      // 반쯤 만든 환경(bin/python은 있고 pip는 없음)이 남으면 다음 호출이 생성을 건너뛴다. 이번에 새로 만든 폴더면 통째로,
      // 원래 있던 폴더면 이번 시도가 만든 bin/python만 지워 다음 호출이 venv 생성을 다시 하게 한다.
      await rm(fresh ? deps.pythonEnv : python, { recursive: fresh, force: true });
      throw new Error(`파이썬 환경(${deps.pythonEnv})을 만들지 못했다: ${tail(venv)}`);
    }
    steps.push(`파이썬 환경 생성(${deps.pythonEnv})`);
  }
  const probe = await deps.run(python, ["-c", "import rapidocr_onnxruntime"], { timeoutMs: 60_000, signal });
  if (probe.code !== 0) {
    const install = await deps.run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-q", RAPIDOCR_SPEC], { timeoutMs: 600_000, signal });
    if (install.code !== 0) throw new Error(`${RAPIDOCR_SPEC} 설치에 실패했다: ${tail(install)}`);
    steps.push(`${RAPIDOCR_SPEC} 설치`);
  }
  await mkdir(deps.modelsDir, { recursive: true });
  for (const model of MODEL_FILES) {
    const path = join(deps.modelsDir, model.name);
    if (existsSync(path) && sha256(await readFile(path)) === model.sha256) continue;
    let bytes: Uint8Array;
    try {
      bytes = await deps.download(model.url, signal);
    } catch (error) {
      throw new Error(`${model.name} 다운로드 실패(${model.url}): ${error instanceof Error ? error.message : String(error)}`);
    }
    const got = sha256(bytes);
    if (got !== model.sha256) throw new Error(`${model.name}의 sha256이 맞지 않아 버렸다(기대 ${model.sha256}, 받은 값 ${got}).`);
    const partial = `${path}.partial-${process.pid}`;
    try {
      await writeFile(partial, bytes);
      await rename(partial, path);
    } finally {
      await rm(partial, { force: true });
    }
    steps.push(`${model.name} 다운로드(sha256 확인)`);
  }
  return { python, modelsDir: deps.modelsDir, steps };
}
