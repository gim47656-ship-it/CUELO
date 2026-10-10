import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";


/** 직전 세대 프로세스가 끝난 것으로 확인된 상황의 probe. */
const dead = () => ({ state: "dead" });
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const maintenance = await jiti.import("./update-maintenance.ts");
// child_process 대역: jiti alias는 내장 모듈에 적용되지 않으므로, update-maintenance.ts(상대 import 없음)의 사본에서
// child_process specifier만 시험용 모듈로 바꿔 읽는다. 원본 파일과 운영 코드는 그대로다.
const stubDirectory = await mkdtemp(join(tmpdir(), "ompweb-child-process-stub-"));
const stubPath = join(stubDirectory, "child-process.mjs");
await writeFile(stubPath, "export const spawnSync = (...args) => globalThis.__cueloCimStub(...args);\n", "utf8");
const maintenanceSource = await readFile(new URL("./update-maintenance.ts", import.meta.url), "utf8");
assert.ok(maintenanceSource.includes('from "node:child_process"'), "child_process import를 찾지 못해 대역을 걸 수 없다");
const stubbedPath = join(stubDirectory, "update-maintenance.ts");
await writeFile(stubbedPath, maintenanceSource.replace('from "node:child_process"', `from ${JSON.stringify(stubPath)}`), "utf8");
const stubbedMaintenance = await jiti.import(stubbedPath);
test.after(() => rm(stubDirectory, { recursive: true, force: true }));
const { renderUpdateWaitPage } = await jiti.import("./update-wait-page.ts");
const client = await jiti.import("./update-maintenance-client.ts");
/* update-wake는 rpc-manager를 통해 pi 런타임을 끌어오므로 Bun에서만 import된다.
   `node --test`에서도 이 파일이 그대로 통과하도록, 그 모듈이 필요한 테스트만 건너뛴다. */
const wake = typeof Bun === "undefined" ? null : await jiti.import("./update-wake.ts");
const WAKE_MODULE_SKIP = wake ? undefined : "update-wake는 Bun 런타임에서만 import된다";

async function writeJson(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `\uFEFF${JSON.stringify(value)}\n`, "utf8");
}

async function withExternalRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "ompweb-maintenance-"));
  const previous = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previous === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT;
    else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previous;
    delete process.env.CUELO_DEPLOY_REQUEST_ID;
    delete process.env.CUELO_DEPLOY_STAGE_HASH;
    delete process.env.CUELO_DEPLOY_MARKER_PATH;
    await rm(root, { recursive: true, force: true });
  }
}

test("공유 request/command receipt로 drain, parked, exact resume identity를 잇는다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "a".repeat(32);
    const stageHash = "b".repeat(64);
    const clientId = "client_identity_1234567890";
    const maintenanceDirectory = join(root, "maintenance", requestId);
    const requestPath = join(root, "requests", `${requestId}.json`);
    const resultPath = join(root, "results", `${requestId}.json`);
    const transactionReceiptPath = join(root, "transactions", `${requestId}.json`);
    await writeJson(requestPath, {
      schemaVersion: 2,
      completionContractVersion: 1,
      requestId,
      preparedStagePrefix: join(root, "stage"),
      stageTransactionPath: join(root, "stage", "stage-transaction.json"),
      maintenanceDirectory,
      transactionReceiptPath,
      resultPath,
    });
    await writeJson(join(root, "active.json"), { schemaVersion: 2, requestId, requestPath });

    const idle = maintenance.registerUpdateClient({
      clientId,
      sessionId: "session-a",
      resumeUrl: "/?session=session-a",
    });
    assert.equal(idle.phase, "IDLE");

    await writeJson(join(maintenanceDirectory, "command.json"), {
      schemaVersion: 2,
      requestId,
      stageHash,
      phase: "DRAINING",
      revision: 1,
      updatedAtUtc: new Date().toISOString(),
    });
    const draining = maintenance.registerUpdateClient({
      clientId,
      sessionId: "session-a",
      resumeUrl: "/?session=session-a",
    });

    assert.deepEqual(draining, { phase: "DRAINING", requestId, stageHash });
    assert.deepEqual(maintenance.getUpdateMutationBlock(), { requestId, stageHash, phase: "DRAINING" });

    const parked = maintenance.markUpdateClientParked({ requestId, stageHash, clientId });
    assert.equal(parked.sessionId, "session-a");
    const parkedReceipt = JSON.parse(await readFile(join(maintenanceDirectory, "clients", `${clientId}.parked.json`), "utf8"));
    assert.equal(parkedReceipt.resumeUrl, "/?session=session-a");
    await writeJson(join(maintenanceDirectory, "command.json"), {
      schemaVersion: 2,
      requestId,
      stageHash,
      phase: "CUTOVER",
      revision: 3,
      updatedAtUtc: new Date().toISOString(),
    });
    assert.equal(
      maintenance.markUpdateClientParked({ requestId, stageHash, clientId }).clientId,
      clientId,
      "CUTOVER quiet window에 도착한 기존 탭도 같은 maintenance page에 진입해야 한다",
    );

    const markerPath = join(root, "live-package", ".ompweb-deployment.json");
    await writeJson(markerPath, { schemaVersion: 1, requestId, stageHash, transactionId: "transaction-a" });
    process.env.CUELO_DEPLOY_REQUEST_ID = requestId;
    process.env.CUELO_DEPLOY_STAGE_HASH = stageHash;
    process.env.CUELO_DEPLOY_MARKER_PATH = markerPath;
    const serviceReady = maintenance.getUpdateStatus(requestId, stageHash);
    assert.equal(serviceReady.phase, "SERVICE_READY");
    assert.equal(serviceReady.service.ready, true);
    assert.equal(serviceReady.mutationBlocked, true);
    assert.equal(maintenance.registerUpdateClient({
      clientId,
      sessionId: "session-a",
      resumeUrl: "/?session=session-a",
    }).phase, "CUTOVER");

    maintenance.markUpdateClientResumed({ requestId, stageHash, clientId, sessionId: "session-a" });
    const resumed = JSON.parse(await readFile(join(maintenanceDirectory, "clients", `${clientId}.resumed.json`), "utf8"));
    assert.equal(resumed.sessionId, "session-a");

    await writeJson(transactionReceiptPath, {
      schemaVersion: 2,
      kind: "ompweb-runtime-transaction",
      requestId,
      stageHash,
      phase: "RESUME_CONFIRMED",
      success: true,
      deployment: {
        completionContractVersion: 1,
        completed: true,
        writeSafe: true,
        completedAtUtc: new Date().toISOString(),
        requestId,
        stageHash,
        service: { ready: true, exact: true, requestId, stageHash },
        resume: { status: "confirmed", targetCount: 1, confirmedCount: 1 },
        rollback: { packagePresent: true, transactionRecorded: true },
        cleanup: { owner: "runtime-transaction", ownerPid: process.pid, progressPath: join(maintenanceDirectory, "cleanup.json") },
      },
    });
    assert.deepEqual(
      maintenance.getUpdateMutationBlock(),
      { requestId, stageHash, phase: "CUTOVER" },
      "rollback package/shim/transaction 실체가 없는 조작 completion은 쓰기를 열지 않는다",
    );

    const rollbackDirectory = join(root, "npm-prefix", ".cuelo-rollback-test");
    const rollbackPackage = join(rollbackDirectory, "cuelo");
    const rollbackShims = join(rollbackDirectory, "shims");
    const rollbackTransaction = join(rollbackDirectory, "transaction.json");
    await mkdir(rollbackPackage, { recursive: true });
    await mkdir(rollbackShims, { recursive: true });
    for (const name of ["cuelo", "cuelo.cmd", "cuelo.ps1"]) {
      await writeFile(join(rollbackShims, name), "rollback shim\n", "utf8");
    }
    await writeJson(rollbackTransaction, { schemaVersion: 2, transactionId: "transaction-a" });
    const cleanup = {
      schemaVersion: 1,
      owner: "runtime-transaction",
      ownerPid: process.pid,
      requestId,
      stageHash,
      phase: "ARTIFACT_CLEANUP",
      status: "running",
      reason: null,
      startedAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      finishedAtUtc: null,
      currentTarget: ".cuelo-stage-old",
      completedCount: 0,
      totalCount: 2,
      removedCount: 0,
      keptCount: 0,
      elapsedSeconds: 1.25,
      failures: [],
    };
    const cleanupPath = join(maintenanceDirectory, "cleanup.json");
    await writeJson(cleanupPath, cleanup);
    const deployment = {
      completionContractVersion: 1,
      completed: true,
      writeSafe: true,
      completedAtUtc: new Date().toISOString(),
      requestId,
      stageHash,
      service: { ready: true, exact: true, requestId, stageHash },
      resume: { status: "confirmed", targetCount: 1, confirmedCount: 1 },
      rollback: {
        packagePresent: true,
        transactionRecorded: true,
        transactionPath: rollbackTransaction,
        packagePath: rollbackPackage,
        shimDirectory: rollbackShims,
        backedUpShims: ["cuelo", "cuelo.cmd", "cuelo.ps1"],
      },
      cleanup: { owner: "runtime-transaction", ownerPid: process.pid, progressPath: cleanupPath },
    };
    await writeJson(transactionReceiptPath, {
      schemaVersion: 2,
      kind: "ompweb-runtime-transaction",
      requestId,
      stageHash,
      phase: "RESUME_CONFIRMED",
      success: true,
      deployment,
      cleanup,
    });
    const released = maintenance.getUpdateStatus(requestId, stageHash);
    assert.equal(released.phase, "SERVICE_READY");
    assert.equal(released.terminalStatus, null);
    assert.equal(released.deploymentCompleted, true);
    assert.equal(released.writeSafe, true);
    assert.equal(released.mutationBlocked, false);
    assert.equal(released.cleanup.status, "running");
    assert.equal(released.cleanup.currentTarget, ".cuelo-stage-old");
    assert.equal(maintenance.registerUpdateClient({
      clientId,
      sessionId: "session-a",
      resumeUrl: "/?session=session-a",
    }).phase, "IDLE");

    await writeFile(cleanupPath, "{}\n", "utf8");
    const progressUnavailable = maintenance.getUpdateStatus(requestId, stageHash);
    assert.equal(progressUnavailable.deploymentCompleted, true);
    assert.equal(progressUnavailable.writeSafe, true);
    assert.equal(progressUnavailable.mutationBlocked, false);
    assert.equal(progressUnavailable.cleanup, null, "가변 cleanup progress 손상은 완료된 배포를 다시 잠그지 않는다");

    // rename 전 설치에서 올라온 배포는 옛 omp-web 패키지를 rollback으로 백업하고, 정리는
    // 승인 대기로 끝난다. 둘 다 완료로 읽지 못하면 대기 화면이 영영 복귀하지 않는다.
    const legacyRollbackDirectory = join(root, "npm-prefix", ".cuelo-rollback-legacy");
    const legacyPackage = join(legacyRollbackDirectory, "omp-web");
    const legacyShims = join(legacyRollbackDirectory, "shims");
    const legacyTransaction = join(legacyRollbackDirectory, "transaction.json");
    await mkdir(legacyPackage, { recursive: true });
    await mkdir(legacyShims, { recursive: true });
    for (const name of ["omp-web", "omp-web.cmd", "omp-web.ps1"]) {
      await writeFile(join(legacyShims, name), "rollback shim\n", "utf8");
    }
    await writeJson(legacyTransaction, { schemaVersion: 2, transactionId: "transaction-legacy" });
    const cleanupPending = {
      ...cleanup,
      status: "pending-approval",
      reason: "사용자 승인 전에는 삭제하지 않는다.",
      currentTarget: null,
      finishedAtUtc: new Date().toISOString(),
    };
    await writeJson(cleanupPath, cleanupPending);
    await writeJson(transactionReceiptPath, {
      schemaVersion: 2,
      kind: "ompweb-runtime-transaction",
      requestId,
      stageHash,
      phase: "RESUME_CONFIRMED",
      success: true,
      deployment: {
        ...deployment,
        rollback: {
          packagePresent: true,
          transactionRecorded: true,
          transactionPath: legacyTransaction,
          packagePath: legacyPackage,
          shimDirectory: legacyShims,
          backedUpShims: ["omp-web", "omp-web.cmd", "omp-web.ps1"],
        },
      },
      cleanup: cleanupPending,
    });
    const legacy = maintenance.getUpdateStatus(requestId, stageHash);
    assert.equal(legacy.deploymentCompleted, true, "옛 omp-web rollback 백업도 배포 완료로 읽는다");
    assert.equal(legacy.writeSafe, true);
    assert.equal(legacy.cleanup.status, "pending-approval");

    const cleanupFailed = {
      ...cleanup,
      status: "failed",
      currentTarget: null,
      completedCount: 2,
      removedCount: 1,
      keptCount: 1,
      elapsedSeconds: 5.5,
      finishedAtUtc: new Date().toISOString(),
      failures: [{ target: ".cuelo-rollback-old", reason: "사용 중" }],
    };
    await writeJson(cleanupPath, cleanupFailed);
    await writeJson(transactionReceiptPath, {
      schemaVersion: 2,
      kind: "ompweb-runtime-transaction",
      requestId,
      stageHash,
      phase: "RESUME_CONFIRMED",
      success: true,
      deployment,
      cleanup: cleanupFailed,
    });
    const cleanupFailureStatus = maintenance.getUpdateStatus(requestId, stageHash);
    assert.equal(cleanupFailureStatus.cleanup.status, "failed");
    assert.equal(cleanupFailureStatus.mutationBlocked, false);
  });
});

test("marker나 session identity가 다르면 resume receipt를 만들지 않는다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "c".repeat(32);
    const stageHash = "d".repeat(64);
    const clientId = "client_identity_abcdefghij";
    const maintenanceDirectory = join(root, "maintenance", requestId);
    await writeJson(join(root, "requests", `${requestId}.json`), {
      schemaVersion: 2,
      requestId,
      preparedStagePrefix: join(root, "stage"),
      stageTransactionPath: join(root, "stage", "stage-transaction.json"),
      maintenanceDirectory,
      transactionReceiptPath: join(root, "transactions", `${requestId}.json`),
      resultPath: join(root, "results", `${requestId}.json`),
    });
    maintenance.registerUpdateClient({ clientId, sessionId: "session-a", resumeUrl: "/?session=session-a" });
    process.env.CUELO_DEPLOY_REQUEST_ID = requestId;
    process.env.CUELO_DEPLOY_STAGE_HASH = stageHash;
    process.env.CUELO_DEPLOY_MARKER_PATH = join(root, "missing-marker.json");
    assert.equal(maintenance.getDeployedServiceIdentity().ready, false);
    assert.throws(
      () => maintenance.markUpdateClientResumed({ requestId, stageHash, clientId, sessionId: "session-b" }),
      /deployed service identity mismatch/,
    );
  });
});


test("runtime activity는 PID별 공유 receipt로 기록된다", async () => {
  await withExternalRoot(async (root) => {
    maintenance.recordRuntimeActivity(["session-b", "session-a", "session-a"]);
    const receipt = JSON.parse(await readFile(join(root, "runtime-activity", `${process.pid}.json`), "utf8"));
    assert.deepEqual(receipt.runningSessionIds, ["session-a", "session-b"]);
    assert.equal(receipt.processId, process.pid);
  });
});

function writeActivity(root, pid, { origin, startedAtMs, running = [], waiting = [], consumed = false, marked = true }) {
  return writeJson(join(root, "runtime-activity", `${pid}.json`), {
    schemaVersion: 2,
    processId: pid,
    processStartedAtUtc: new Date(startedAtMs).toISOString(),
    updatedAtUtc: new Date(startedAtMs + 1000).toISOString(),
    runningSessionIds: running,
    ...(marked ? { recovery: { eligible: true, origin, startedAtMs, waitingSessionIds: waiting, ...(consumed ? { consumedAtUtc: "2026-10-05T00:00:00.000Z" } : {}) } } : {}),
  });
}

test("서버로 표시된 프로세스의 영수증만 복구 표식·고정 세대 식별·답 대기 목록을 갖는다", async () => {
  await withExternalRoot(async (root) => {
    const path = join(root, "runtime-activity", `${process.pid}.json`);
    maintenance.recordRuntimeActivity(["session-a"]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).recovery, undefined, "표시 전에는 자동 복구 대상이 아니다");
    try {
      const server = maintenance.markRuntimeActivityServer("http://127.0.0.1:30141");
      maintenance.recordRuntimeActivity(["session-b", "session-a"], ["session-a", "not-running"]);
      const receipt = JSON.parse(await readFile(path, "utf8"));
      assert.deepEqual(receipt.recovery, { eligible: true, origin: "http://127.0.0.1:30141", startedAtMs: server.startedAtMs, waitingSessionIds: ["session-a"] });
      maintenance.recordRuntimeActivity(["session-a"]);
      assert.equal(JSON.parse(await readFile(path, "utf8")).recovery.startedAtMs, server.startedAtMs, "세대 식별은 호출마다 흔들리지 않는다");
    } finally {
      globalThis.__cueloRuntimeServer = undefined;
    }
  });
});

test("직전 서버 세대는 같은 origin의 가장 최근 표시 영수증 하나뿐이고 더 오래된 running을 찾아 올라가지 않는다", async () => {
  await withExternalRoot(async (root) => {
    const origin = "http://127.0.0.1:30141";
    const own = 5_000_000;
    await writeActivity(root, 100, { origin, startedAtMs: 1_000_000, running: ["old-running"] });
    await writeActivity(root, 101, { origin: "http://127.0.0.1:9999", startedAtMs: 4_000_000, running: ["other-origin"] });
    await writeActivity(root, 102, { origin, startedAtMs: 4_500_000, running: ["legacy-unmarked"], marked: false });
    await writeActivity(root, 103, { origin, startedAtMs: 6_000_000, running: ["future"] });
    await writeActivity(root, 104, { origin, startedAtMs: 3_000_000, running: ["s1", "s2"], waiting: ["s2"] });
    assert.deepEqual(maintenance.readPriorGenerationActivity(origin, own, dead), { processId: 104, startedAtMs: 3_000_000, runningSessionIds: ["s1", "s2"], waitingSessionIds: ["s2"] });

    await writeActivity(root, 105, { origin, startedAtMs: 4_000_000, running: [] });
    assert.equal(maintenance.readPriorGenerationActivity(origin, own, dead)?.runningSessionIds.length, 0, "가장 최근 세대가 비었으면 비어 있다");
    await writeActivity(root, 106, { origin, startedAtMs: 4_200_000, running: ["consumed"], consumed: true });
    assert.equal(maintenance.readPriorGenerationActivity(origin, own, dead), null, "소비된 최근 세대 뒤로 더 오래된 running을 찾지 않는다");
  });
});

test("소비 표시는 같은 세대 영수증에만 하고 PID가 재사용돼 덮인 현재 세대는 건드리지 않는다", async () => {
  await withExternalRoot(async (root) => {
    const origin = "http://127.0.0.1:30141";
    await writeActivity(root, 200, { origin, startedAtMs: 1_000_000, running: ["s1"] });
    const prior = maintenance.readPriorGenerationActivity(origin, 9_000_000, dead);
    // 같은 PID가 새 세대로 재사용돼 영수증을 덮었다.
    await writeActivity(root, 200, { origin, startedAtMs: 2_000_000, running: ["current"] });
    assert.equal(maintenance.markPriorGenerationConsumed(prior, 2_000_000), false);
    assert.equal(JSON.parse((await readFile(join(root, "runtime-activity", "200.json"), "utf8")).replace(/^\uFEFF/, "")).recovery.consumedAtUtc, undefined);

    await writeActivity(root, 201, { origin, startedAtMs: 1_500_000, running: ["s2"] });
    const second = maintenance.readPriorGenerationActivity(origin, 1_900_000, dead);
    assert.equal(maintenance.markPriorGenerationConsumed(second, 1_900_000), true);
    assert.equal(maintenance.readPriorGenerationActivity(origin, 1_900_000, dead), null);
  });
});

test("직전 세대 프로세스가 살아 있거나 확인되지 않으면 대상이 아니고, PID가 다른 프로세스로 재사용됐으면 대상이다", async () => {
  await withExternalRoot(async (root) => {
    const origin = "port:30141";
    await writeActivity(root, 300, { origin, startedAtMs: 1_000_000, running: ["s1"] });
    const seen = [];
    const probeWith = (identity) => (pid) => { seen.push(pid); return identity; };
    // 같은 세대가 아직 살아 있다(시작 시각이 영수증 세대와 허용치 안에서 같다).
    assert.equal(maintenance.readPriorGenerationActivity(origin, 9_000_000, probeWith({ state: "alive", startedAtMs: 1_001_500 })), null);
    // PID가 재사용됐다: 같은 PID지만 시작 시각이 다르다.
    assert.equal(maintenance.readPriorGenerationActivity(origin, 9_000_000, probeWith({ state: "alive", startedAtMs: 5_000_000 }))?.processId, 300);
    // 확인하지 못하면 수동 경계(fail-closed).
    assert.equal(maintenance.readPriorGenerationActivity(origin, 9_000_000, probeWith({ state: "unknown" })), null);
    assert.deepEqual(seen, [300, 300, 300]);
    // 복구할 세션이 없는 세대는 프로세스를 조회하지 않는다.
    await writeActivity(root, 301, { origin, startedAtMs: 2_000_000, running: [] });
    seen.length = 0;
    assert.equal(maintenance.readPriorGenerationActivity(origin, 9_000_000, probeWith({ state: "unknown" }))?.runningSessionIds.length, 0);
    assert.deepEqual(seen, []);
  });
});

/** `probeProcessIdentity`가 부르는 CIM 조회(`spawnSync`)와 플랫폼만 대체해 한 분기를 결정론적으로 실행한다. 실제 OS 조회는 .omp 네이티브 smoke가 맡는다. */
function withCimResult(result, run) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [];
  globalThis.__cueloCimStub = (command, args) => {
    calls.push([command, args]);
    return result;
  };
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    run(calls);
  } finally {
    delete globalThis.__cueloCimStub;
    Object.defineProperty(process, "platform", platform);
  }
}

test("살아 있는 pid의 CIM 시작 시각을 alive identity로 돌려준다", () => {
  withCimResult({ status: 0, stdout: "2026-10-05T02:00:00.0000000Z\r\n" }, (calls) => {
    assert.deepEqual(stubbedMaintenance.probeProcessIdentity(process.pid), { state: "alive", startedAtMs: Date.parse("2026-10-05T02:00:00.000Z") });
    assert.match(calls[0][1].at(-1), new RegExp(`ProcessId=${process.pid}`));
  });
});

test("CIM 조회가 성공했는데 결과가 비어 있으면 dead, 조회가 실패·시간 초과·해석 불가면 unknown이다", () => {
  withCimResult({ status: 0, stdout: "" }, () => assert.deepEqual(stubbedMaintenance.probeProcessIdentity(process.pid), { state: "dead" }));
  withCimResult({ status: 1, stdout: "" }, () => assert.deepEqual(stubbedMaintenance.probeProcessIdentity(process.pid), { state: "unknown" }));
  withCimResult({ error: new Error("ETIMEDOUT"), status: null, stdout: "" }, () => assert.deepEqual(stubbedMaintenance.probeProcessIdentity(process.pid), { state: "unknown" }));
  withCimResult({ status: 0, stdout: "not-a-date" }, () => assert.deepEqual(stubbedMaintenance.probeProcessIdentity(process.pid), { state: "unknown" }));
});

test("존재하지 않는 pid는 CIM을 부르지 않고 dead다", () => {
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  withCimResult({ status: 0, stdout: "2026-10-05T02:00:00.000Z" }, (calls) => {
    assert.deepEqual(stubbedMaintenance.probeProcessIdentity(gone), { state: "dead" });
    assert.equal(calls.length, 0);
  });
});

test("유효하지 않은 pid는 확인 불가(unknown)로 두어 자동 복구하지 않는다", () => {
  assert.deepEqual(maintenance.probeProcessIdentity(0), { state: "unknown" });
});

/**
 * 자동 재개 대상 세션이 확정된, 완료된 배포 한 건을 만든다. `initiatorSessionId`를
 * 주지 않으면 launcher 호출자가 세션을 명시하지 않은 경우를 재현한다.
 */
async function setupCompletedDeployment(root, { requestId, stageHash, initiatorSessionId }) {
  const maintenanceDirectory = join(root, "maintenance", requestId);
  const requestPath = join(root, "requests", `${requestId}.json`);
  const resultPath = join(root, "results", `${requestId}.json`);
  const transactionReceiptPath = join(root, "transactions", `${requestId}.json`);
  await writeJson(requestPath, {
    schemaVersion: 2,
    completionContractVersion: 1,
    requestId,
    preparedStagePrefix: join(root, "stage"),
    stageTransactionPath: join(root, "stage", "stage-transaction.json"),
    maintenanceDirectory,
    transactionReceiptPath,
    resultPath,
    initiatorSessionId: initiatorSessionId ?? null,
    initiatorSessionSource: initiatorSessionId ? "explicit" : "absent",
  });
  await writeJson(join(root, "active.json"), { schemaVersion: 2, requestId, requestPath });
  await writeJson(join(maintenanceDirectory, "command.json"), {
    schemaVersion: 2,
    requestId,
    stageHash,
    phase: "CUTOVER",
    revision: 3,
    updatedAtUtc: new Date().toISOString(),
  });

  const markerPath = join(root, "live-package", ".ompweb-deployment.json");
  await writeJson(markerPath, { schemaVersion: 1, requestId, stageHash, transactionId: "transaction-wake" });
  process.env.CUELO_DEPLOY_REQUEST_ID = requestId;
  process.env.CUELO_DEPLOY_STAGE_HASH = stageHash;
  process.env.CUELO_DEPLOY_MARKER_PATH = markerPath;

  const rollbackDirectory = join(root, "npm-prefix", `.cuelo-rollback-${requestId.slice(0, 8)}`);
  const rollbackPackage = join(rollbackDirectory, "cuelo");
  const rollbackShims = join(rollbackDirectory, "shims");
  const rollbackTransaction = join(rollbackDirectory, "transaction.json");
  await mkdir(rollbackPackage, { recursive: true });
  await mkdir(rollbackShims, { recursive: true });
  for (const name of ["cuelo", "cuelo.cmd", "cuelo.ps1"]) {
    await writeFile(join(rollbackShims, name), "rollback shim\n", "utf8");
  }
  await writeJson(rollbackTransaction, { schemaVersion: 2, transactionId: "transaction-wake" });

  const cleanupPath = join(maintenanceDirectory, "cleanup.json");
  const deployment = {
    completionContractVersion: 1,
    completed: true,
    writeSafe: true,
    completedAtUtc: new Date().toISOString(),
    requestId,
    stageHash,
    service: { ready: true, exact: true, requestId, stageHash },
    resume: { status: "confirmed", targetCount: 1, confirmedCount: 1 },
    rollback: {
      packagePresent: true,
      transactionRecorded: true,
      transactionPath: rollbackTransaction,
      packagePath: rollbackPackage,
      shimDirectory: rollbackShims,
      backedUpShims: ["cuelo", "cuelo.cmd", "cuelo.ps1"],
    },
    cleanup: { owner: "runtime-transaction", ownerPid: process.pid, progressPath: cleanupPath },
  };
  return { maintenanceDirectory, transactionReceiptPath, deployment };
}

async function completeDeployment(transactionReceiptPath, requestId, stageHash, deployment) {
  await writeJson(transactionReceiptPath, {
    schemaVersion: 2,
    kind: "ompweb-runtime-transaction",
    requestId,
    stageHash,
    phase: "RESUME_CONFIRMED",
    success: true,
    deployment,
  });
}

const WAKE_SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER_SESSION = "99999999-8888-4777-8666-555555555555";

test("업데이트를 시작한 세션만 request당 한 번 자동 재개한다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "e".repeat(32);
    const stageHash = "f".repeat(64);
    const clientId = "client_wake_1234567890abc";
    const { maintenanceDirectory, transactionReceiptPath, deployment } = await setupCompletedDeployment(root, {
      requestId,
      stageHash,
      initiatorSessionId: WAKE_SESSION,
    });

    const incomplete = maintenance.claimUpdateWake({
      requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false,
    });
    assert.deepEqual(incomplete, { wake: false, reason: "deployment-incomplete" }, "배포가 완료되지 않았으면 깨우지 않는다");

    await completeDeployment(transactionReceiptPath, requestId, stageHash, deployment);

    assert.deepEqual(
      maintenance.claimUpdateWake({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: true }),
      { wake: false, reason: "user-already-active" },
      "사용자가 이미 그 세션을 이어가고 있으면 끼어들지 않는다",
    );

    assert.deepEqual(
      maintenance.claimUpdateWake({ requestId, stageHash, clientId, sessionId: OTHER_SESSION, sessionBusy: false }),
      { wake: true, requestId, stageHash, sessionId: WAKE_SESSION },
      "복귀 탭이 다른 세션을 보고 있어도 업데이트 주도 세션을 깨운다",
    );
    const claim = JSON.parse(await readFile(join(maintenanceDirectory, "wake", `${WAKE_SESSION}.json`), "utf8"));
    assert.equal(claim.sessionId, WAKE_SESSION);

    assert.deepEqual(
      maintenance.claimUpdateWake({
        requestId, stageHash, clientId: "client_wake_second_tab_00", sessionId: WAKE_SESSION, sessionBusy: false,
      }),
      { wake: false, reason: "already-claimed" },
      "같은 request에서 두 번째 복귀 확정은 다시 깨우지 않는다",
    );
  });
});

test("initiator를 명시하지 않은 배포는 깨우지 않고 그 이유를 남긴다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "1".repeat(32);
    const stageHash = "2".repeat(64);
    const clientId = "client_wake_absent_0000000";
    const { maintenanceDirectory, transactionReceiptPath, deployment } = await setupCompletedDeployment(root, {
      requestId,
      stageHash,
      initiatorSessionId: null,
    });
    await completeDeployment(transactionReceiptPath, requestId, stageHash, deployment);

    assert.deepEqual(
      maintenance.claimUpdateWake({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false }),
      { wake: false, reason: "no-initiator" },
      "주도 세션을 추론하지 않는다",
    );
    const skipped = JSON.parse(await readFile(join(maintenanceDirectory, "wake", `${clientId}.skipped.json`), "utf8"));
    assert.equal(skipped.reason, "no-initiator");
    assert.equal(skipped.initiatorSessionSource, "absent");
  });
});

// 2026-09-22 request 0d09e703…: claim은 남았는데 발화가 도착하지 않아 세션이 멈춰 있었다.
// claim이 발화 전에 찍히므로, 실패한 쪽이 반납하지 않으면 그 request는 아무도 못 깨운다.
test("발화에 실패한 claim은 반납되고 실패 이유가 남는다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "3".repeat(32);
    const stageHash = "4".repeat(64);
    const clientId = "client_wake_release_00000";
    const { maintenanceDirectory, transactionReceiptPath, deployment } = await setupCompletedDeployment(root, {
      requestId,
      stageHash,
      initiatorSessionId: WAKE_SESSION,
    });
    await completeDeployment(transactionReceiptPath, requestId, stageHash, deployment);

    assert.deepEqual(
      maintenance.claimUpdateWake({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false }),
      { wake: true, requestId, stageHash, sessionId: WAKE_SESSION },
    );

    maintenance.releaseUpdateWakeClaim({
      requestId,
      stageHash,
      clientId,
      sessionId: WAKE_SESSION,
      stage: "resume",
      error: new Error("session record not found"),
    });

    const failed = JSON.parse(await readFile(join(maintenanceDirectory, "wake", `${WAKE_SESSION}.failed.json`), "utf8"));
    assert.equal(failed.stage, "resume");
    assert.equal(failed.error.message, "session record not found");

    assert.deepEqual(
      maintenance.claimUpdateWake({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false }),
      { wake: true, requestId, stageHash, sessionId: WAKE_SESSION },
      "반납된 claim은 다음 복귀 확정이 다시 가져갈 수 있다",
    );
  });
});

/**
 * 종료 result를 가진 업데이트 request 하나를 만든다. drain 실패는 live runtime을 바꾸지
 * 않으므로 배포 완료 receipt(transaction)는 없고, result 파일만 종료 기록을 갖는다.
 * `initiatorSessionId`를 주지 않으면 launcher 호출자가 세션을 명시하지 않은 경우를 재현한다.
 */
async function setupTerminalRequest(root, { requestId, stageHash, initiatorSessionId, terminalStatus, terminalError }) {
  const maintenanceDirectory = join(root, "maintenance", requestId);
  const resultPath = join(root, "results", `${requestId}.json`);
  await writeJson(join(root, "requests", `${requestId}.json`), {
    schemaVersion: 2,
    completionContractVersion: 1,
    requestId,
    preparedStagePrefix: join(root, "stage"),
    stageTransactionPath: join(root, "stage", "stage-transaction.json"),
    maintenanceDirectory,
    transactionReceiptPath: join(root, "transactions", `${requestId}.json`),
    resultPath,
    initiatorSessionId: initiatorSessionId ?? null,
    initiatorSessionSource: initiatorSessionId ? "explicit" : "absent",
  });
  await writeJson(join(maintenanceDirectory, "command.json"), {
    schemaVersion: 2,
    requestId,
    stageHash,
    phase: "DRAINING",
    revision: 2,
    updatedAtUtc: new Date().toISOString(),
  });
  await writeJson(resultPath, { schemaVersion: 2, requestId, status: terminalStatus, error: terminalError });
  return { maintenanceDirectory, resultPath };
}

test("실패 통지는 서버가 result로 실패를 재판정해 request당 한 번만 통과한다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "5".repeat(32);
    const stageHash = "6".repeat(64);
    const clientId = "client_failure_notice_0000";
    const terminalError = "CUELO drain 시간 초과 (120s): runningSessions=01a0c991-9053-75e5-933d-d77cff2d7e40 parked=0/0. live runtime은 변경하지 않았다.";
    const { maintenanceDirectory, resultPath } = await setupTerminalRequest(root, {
      requestId, stageHash, initiatorSessionId: WAKE_SESSION, terminalStatus: "failed", terminalError,
    });

    await rm(resultPath, { force: true });
    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false }),
      { notice: false, reason: "no-terminal-result" },
      "종료 기록이 없으면 실패로 단정하지 않는다",
    );

    assert.throws(
      () => maintenance.claimUpdateFailureNotice({
        requestId, stageHash, clientId: "../../escape_client_id", sessionId: WAKE_SESSION, sessionBusy: false,
      }),
      /invalid update client identity/,
      "clientId는 기록 파일 이름이 되므로 경로를 벗어나는 값은 쓰기 전에 거부한다",
    );

    await writeJson(resultPath, { schemaVersion: 2, requestId, status: "failed", error: terminalError });
    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false }),
      { notice: true, requestId, stageHash, sessionId: WAKE_SESSION, terminalError },
    );
    const claim = JSON.parse(await readFile(join(maintenanceDirectory, "wake", `${WAKE_SESSION}.failure.json`), "utf8"));
    assert.equal(claim.terminalStatus, "failed");
    assert.equal(claim.sessionId, WAKE_SESSION);

    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({
        requestId, stageHash, clientId: "client_failure_notice_second", sessionId: WAKE_SESSION, sessionBusy: false,
      }),
      { notice: false, reason: "already-claimed" },
      "같은 request의 두 번째 실패 관측은 다시 알리지 않는다",
    );

    // 발화가 터지면 claim을 반납해 다음 관측이 다시 시도할 수 있어야 한다.
    maintenance.releaseUpdateFailureNoticeClaim({
      requestId, stageHash, clientId, sessionId: WAKE_SESSION, stage: "prompt", error: new Error("session record not found"),
    });
    const failureError = JSON.parse(await readFile(join(maintenanceDirectory, "wake", `${WAKE_SESSION}.failure-error.json`), "utf8"));
    assert.equal(failureError.stage, "prompt");
    assert.equal(failureError.error.message, "session record not found");
    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false }),
      { notice: true, requestId, stageHash, sessionId: WAKE_SESSION, terminalError },
      "반납된 claim은 다음 실패 관측이 다시 가져갈 수 있다",
    );
  });
});

test("실패 통지는 성공 배포와 initiator 규칙에서 성공 Wake와 독립이다", async () => {
  await withExternalRoot(async (root) => {
    // 성공한 배포: result가 성공이면 대기 화면이 실패라 주장해도 통지하지 않는다.
    const succeededId = "7".repeat(32);
    const succeededHash = "8".repeat(64);
    const succeeded = await setupCompletedDeployment(root, {
      requestId: succeededId, stageHash: succeededHash, initiatorSessionId: WAKE_SESSION,
    });
    await completeDeployment(succeeded.transactionReceiptPath, succeededId, succeededHash, succeeded.deployment);
    await writeJson(join(root, "results", `${succeededId}.json`), {
      schemaVersion: 2, requestId: succeededId, status: "succeeded", error: null,
    });
    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({
        requestId: succeededId, stageHash: succeededHash, clientId: "client_failure_succeeded", sessionId: WAKE_SESSION, sessionBusy: false,
      }),
      { notice: false, reason: "deployment-succeeded" },
      "result가 성공이면 클라이언트 주장과 무관하게 통지하지 않는다",
    );
    assert.deepEqual(
      maintenance.claimUpdateWake({
        requestId: succeededId, stageHash: succeededHash, clientId: "client_failure_succeeded", sessionId: WAKE_SESSION, sessionBusy: false,
      }),
      { wake: true, requestId: succeededId, stageHash: succeededHash, sessionId: WAKE_SESSION },
      "실패 통지의 skip 기록은 성공 Wake claim을 막지 않는다",
    );

    const absentId = "9".repeat(32);
    const absentHash = "a".repeat(64);
    await setupTerminalRequest(root, {
      requestId: absentId, stageHash: absentHash, initiatorSessionId: null, terminalStatus: "failed", terminalError: "boom",
    });
    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({
        requestId: absentId, stageHash: absentHash, clientId: "client_failure_no_initiator", sessionId: WAKE_SESSION, sessionBusy: false,
      }),
      { notice: false, reason: "no-initiator" },
      "주도 세션을 추론하지 않는다",
    );

    const mixedId = "b".repeat(32);
    const mixedHash = "c".repeat(64);
    const mixed = await setupTerminalRequest(root, {
      requestId: mixedId, stageHash: mixedHash, initiatorSessionId: WAKE_SESSION, terminalStatus: "failed", terminalError: "boom",
    });
    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({
        requestId: mixedId, stageHash: mixedHash, clientId: "client_failure_busy", sessionId: WAKE_SESSION, sessionBusy: true,
      }),
      { notice: false, reason: "user-already-active" },
      "사용자가 이미 그 세션을 이어가고 있으면 끼어들지 않는다",
    );
    const skipped = JSON.parse(await readFile(join(mixed.maintenanceDirectory, "wake", "client_failure_busy.failure-skipped.json"), "utf8"));
    assert.equal(skipped.reason, "user-already-active");
    assert.equal(skipped.initiatorSessionId, WAKE_SESSION);

    // skip은 통지 권리를 점유하지 않는다. 조건이 맞으면 아직 알릴 수 있다.
    assert.deepEqual(
      maintenance.claimUpdateFailureNotice({
        requestId: mixedId, stageHash: mixedHash, clientId: "client_failure_after_skips", sessionId: OTHER_SESSION, sessionBusy: false,
      }),
      { notice: true, requestId: mixedId, stageHash: mixedHash, sessionId: WAKE_SESSION, terminalError: "boom" },
    );
    assert.deepEqual(
      maintenance.claimUpdateWake({
        requestId: mixedId, stageHash: mixedHash, clientId: "client_failure_after_skips", sessionId: WAKE_SESSION, sessionBusy: false,
      }),
      { wake: false, reason: "deployment-incomplete" },
      "실패 claim은 성공 Wake를 already-claimed로 막지 않는다",
    );
  });
});

// 2026-09-23: 실패 이유 기록(writeJsonAtomic)이 던지면 claim 삭제에 닿지 못해, 그 request는 다음
// 복귀·실패 관측도 already-claimed로 막혔다. 기록 오류는 지금처럼 호출부로 올라가되 claim은 반납돼야 한다.
test("실패 이유 기록이 깨져도 두 claim은 반납되고, 다른 신원의 반납은 claim을 건드리지 않는다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "2".repeat(32);
    const stageHash = "3".repeat(64);
    const clientId = "client_release_log_broken0";
    const unknownRequestId = "f".repeat(32);
    const promptError = new Error("prompt rejected");
    const { maintenanceDirectory, transactionReceiptPath, deployment } = await setupCompletedDeployment(root, {
      requestId, stageHash, initiatorSessionId: WAKE_SESSION,
    });
    await completeDeployment(transactionReceiptPath, requestId, stageHash, deployment);
    const wakeClaim = () => maintenance.claimUpdateWake({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false });
    assert.deepEqual(wakeClaim(), { wake: true, requestId, stageHash, sessionId: WAKE_SESSION });
    // 기록 경로에 디렉터리가 있으면 원자적 쓰기의 rename이 실패한다.
    await mkdir(join(maintenanceDirectory, "wake", `${WAKE_SESSION}.failed.json`), { recursive: true });

    maintenance.releaseUpdateWakeClaim({
      requestId: unknownRequestId, stageHash, clientId, sessionId: WAKE_SESSION, stage: "prompt", error: promptError,
    });
    maintenance.releaseUpdateWakeClaim({
      requestId, stageHash, clientId, sessionId: OTHER_SESSION, stage: "prompt", error: promptError,
    });
    assert.deepEqual(wakeClaim(), { wake: false, reason: "already-claimed" }, "기록 없는 request나 다른 세션의 반납은 claim을 풀지 않는다");

    assert.throws(
      () => maintenance.releaseUpdateWakeClaim({ requestId, stageHash, clientId, sessionId: WAKE_SESSION, stage: "prompt", error: promptError }),
      (error) => typeof error?.code === "string",
      "기록 오류는 삼키지 않고 호출부로 올라간다",
    );
    assert.deepEqual(wakeClaim(), { wake: true, requestId, stageHash, sessionId: WAKE_SESSION }, "기록이 깨져도 claim은 반납된다");

    const noticeRequestId = "4".repeat(32);
    const noticeStageHash = "5".repeat(64);
    const notice = await setupTerminalRequest(root, {
      requestId: noticeRequestId, stageHash: noticeStageHash, initiatorSessionId: WAKE_SESSION, terminalStatus: "failed", terminalError: "boom",
    });
    const noticeClaim = () => maintenance.claimUpdateFailureNotice({
      requestId: noticeRequestId, stageHash: noticeStageHash, clientId, sessionId: WAKE_SESSION, sessionBusy: false,
    });
    assert.deepEqual(noticeClaim(), {
      notice: true, requestId: noticeRequestId, stageHash: noticeStageHash, sessionId: WAKE_SESSION, terminalError: "boom",
    });
    await mkdir(join(notice.maintenanceDirectory, "wake", `${WAKE_SESSION}.failure-error.json`), { recursive: true });

    maintenance.releaseUpdateFailureNoticeClaim({
      requestId: unknownRequestId, stageHash: noticeStageHash, clientId, sessionId: WAKE_SESSION, stage: "prompt", error: promptError,
    });
    maintenance.releaseUpdateFailureNoticeClaim({
      requestId: noticeRequestId, stageHash: noticeStageHash, clientId, sessionId: OTHER_SESSION, stage: "prompt", error: promptError,
    });
    assert.deepEqual(noticeClaim(), { notice: false, reason: "already-claimed" }, "기록 없는 request나 다른 세션의 반납은 claim을 풀지 않는다");

    assert.throws(
      () => maintenance.releaseUpdateFailureNoticeClaim({
        requestId: noticeRequestId, stageHash: noticeStageHash, clientId, sessionId: WAKE_SESSION, stage: "prompt", error: promptError,
      }),
      (error) => typeof error?.code === "string",
      "기록 오류는 삼키지 않고 호출부로 올라간다",
    );
    assert.deepEqual(noticeClaim(), {
      notice: true, requestId: noticeRequestId, stageHash: noticeStageHash, sessionId: WAKE_SESSION, terminalError: "boom",
    }, "기록이 깨져도 claim은 반납된다");
  });
});

test("실패 통지는 살아 있는 idle 세션에 재기동 없이 바로 전달된다", { skip: WAKE_MODULE_SKIP }, async () => {
  await withExternalRoot(async (root) => {
    const requestId = "d".repeat(32);
    const stageHash = "e".repeat(64);
    const clientId = "client_failure_live_0000";
    const terminalError = "CUELO drain 시간 초과 (120s): parked=0/0. live runtime은 변경하지 않았다.";
    const { maintenanceDirectory } = await setupTerminalRequest(root, {
      requestId, stageHash, initiatorSessionId: WAKE_SESSION, terminalStatus: "failed", terminalError,
    });

    // 실패 시점에는 기존 런타임이 그대로 살아 있으므로 대상 세션이 메모리에 idle로 있다.
    const sent = [];
    const previousRegistry = globalThis.__ompSessions;
    globalThis.__ompSessions = new Map([[WAKE_SESSION, {
      isAlive: () => true,
      isRunning: () => false,
      sendInternalPrompt: async (message) => { sent.push(message); },
    }]]);
    try {
      const decision = await wake.notifyUpdateFailureToInitiator({ requestId, stageHash, clientId, sessionId: WAKE_SESSION });
      assert.deepEqual(decision, { notice: true, requestId, stageHash, sessionId: WAKE_SESSION, terminalError });
      assert.equal(sent.length, 1, "살아 있는 세션에 정확히 한 번 보낸다");
      assert.match(sent[0], /\[하네스 통지\]/);
      assert.ok(sent[0].includes(`requestId=${requestId}`));
      assert.ok(sent[0].includes(`stageHash=${stageHash}`));
      assert.ok(sent[0].includes(terminalError), "실패 원인을 그대로 전한다");
      assert.ok(sent[0].includes("live runtime을 변경하지 않았으므로"), "기존 서비스가 그대로일 수 있음을 밝힌다");
      const claim = JSON.parse(await readFile(join(maintenanceDirectory, "wake", `${WAKE_SESSION}.failure.json`), "utf8"));
      assert.equal(claim.terminalStatus, "failed");

      // 두 번째 관측은 이미 claim이 찍혀 다시 보내지 않는다.
      assert.deepEqual(
        await wake.notifyUpdateFailureToInitiator({ requestId, stageHash, clientId: "client_failure_live_second", sessionId: WAKE_SESSION }),
        { notice: false, reason: "already-claimed" },
      );
      assert.equal(sent.length, 1);
    } finally {
      globalThis.__ompSessions = previousRegistry;
    }
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 실제 send()처럼 prompt를 실행 중으로 세운 뒤에 돌아오는 살아 있는 세션. */
function fakeWakeSession() {
  const session = {
    running: false,
    sent: [],
    isAlive: () => true,
    isRunning: () => session.running,
    sendInternalPrompt: async (message) => {
      session.running = true;
      session.sent.push(message);
    },
  };
  return session;
}

/**
 * 발화 경로가 쓰는 프로세스 전역(세션 registry·세션 경로 cache·세션 시작 lock)을 이 테스트 동안만
 * 바꿔 끼운다. 시작 lock에 넣은 promise가 곧 `startRpcSession`의 결과라, 세션 재기동이 끝나는 시점을
 * 테스트가 정한다.
 */
async function withFakeWakeRuntime(root, run) {
  const sessionFile = join(root, "wake-session.jsonl");
  await writeFile(sessionFile, "\n", "utf8");
  const previous = {
    sessions: globalThis.__ompSessions,
    paths: globalThis.__ompSessionPathCache,
    locks: globalThis.__ompStartLocks,
  };
  const sessions = new Map();
  const locks = new Map();
  globalThis.__ompSessions = sessions;
  globalThis.__ompSessionPathCache = new Map([[WAKE_SESSION, sessionFile]]);
  globalThis.__ompStartLocks = locks;
  try {
    await run({ sessions, locks });
  } finally {
    globalThis.__ompSessions = previous.sessions;
    globalThis.__ompSessionPathCache = previous.paths;
    globalThis.__ompStartLocks = previous.locks;
  }
}

// 같은 세션의 두 탭이 거의 동시에 복귀하면, claim을 놓친 탭이 첫 탭의 세션 재기동 중에 답을 받아
// 아직 시작되지 않은 run을 확인하고 놓쳤다.
test("첫 탭의 세션 재기동이 늦어도 두 번째 복귀 탭은 그 발화가 실행 중이 된 뒤에 답을 받는다", { skip: WAKE_MODULE_SKIP }, async () => {
  await withExternalRoot(async (root) => {
    const requestId = "6".repeat(32);
    const stageHash = "7".repeat(64);
    const { transactionReceiptPath, deployment } = await setupCompletedDeployment(root, {
      requestId, stageHash, initiatorSessionId: WAKE_SESSION,
    });
    await completeDeployment(transactionReceiptPath, requestId, stageHash, deployment);
    await withFakeWakeRuntime(root, async ({ locks }) => {
      const session = fakeWakeSession();
      const start = deferred();
      locks.set(WAKE_SESSION, start.promise);

      const first = wake.wakeUpdateInitiatorSession({ requestId, stageHash, clientId: "client_wake_first_tab_000", sessionId: WAKE_SESSION });
      let runningWhenSecondAnswered = null;
      const second = wake.wakeUpdateInitiatorSession({ requestId, stageHash, clientId: "client_wake_second_tab_00", sessionId: WAKE_SESSION })
        .then((decision) => {
          runningWhenSecondAnswered = session.running;
          return decision;
        });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(runningWhenSecondAnswered, null, "첫 탭의 세션 재기동이 끝나기 전에는 두 번째 탭에 답하지 않는다");

      start.resolve({ session, realSessionId: WAKE_SESSION });
      assert.deepEqual(await first, { wake: true, requestId, stageHash, sessionId: WAKE_SESSION });
      assert.deepEqual(await second, { wake: false, reason: "already-claimed" });
      assert.equal(runningWhenSecondAnswered, true, "두 번째 탭은 Wake prompt가 실행 중이 된 뒤에 답을 받는다");
      assert.equal(session.sent.length, 1, "Wake 지시문은 한 번만 보낸다");
    });
  });
});

test("첫 탭의 발화가 실패하면 기다리던 탭은 오류 없이 답을 받고, claim은 다음 복귀가 다시 가져간다", { skip: WAKE_MODULE_SKIP }, async () => {
  await withExternalRoot(async (root) => {
    const requestId = "8".repeat(32);
    const stageHash = "9".repeat(64);
    const { maintenanceDirectory, transactionReceiptPath, deployment } = await setupCompletedDeployment(root, {
      requestId, stageHash, initiatorSessionId: WAKE_SESSION,
    });
    await completeDeployment(transactionReceiptPath, requestId, stageHash, deployment);
    await withFakeWakeRuntime(root, async ({ sessions, locks }) => {
      const start = deferred();
      locks.set(WAKE_SESSION, start.promise);
      const first = wake.wakeUpdateInitiatorSession({ requestId, stageHash, clientId: "client_wake_failed_first0", sessionId: WAKE_SESSION });
      const second = wake.wakeUpdateInitiatorSession({ requestId, stageHash, clientId: "client_wake_failed_second", sessionId: WAKE_SESSION });
      await new Promise((resolve) => setImmediate(resolve));

      start.reject(new Error("session start failed"));
      await assert.rejects(first, /session start failed/, "첫 탭은 기존처럼 원래 오류로 실패한다");
      assert.deepEqual(await second, { wake: false, reason: "already-claimed" }, "기다리던 탭은 첫 탭의 오류를 물려받지 않는다");
      const failed = JSON.parse(await readFile(join(maintenanceDirectory, "wake", `${WAKE_SESSION}.failed.json`), "utf8"));
      assert.equal(failed.stage, "resume");

      const session = fakeWakeSession();
      sessions.set(WAKE_SESSION, session);
      assert.deepEqual(
        await wake.wakeUpdateInitiatorSession({ requestId, stageHash, clientId: "client_wake_retry_third0", sessionId: WAKE_SESSION }),
        { wake: true, requestId, stageHash, sessionId: WAKE_SESSION },
        "반납된 claim은 다음 복귀가 다시 가져가 발화한다",
      );
      assert.equal(session.sent.length, 1);
    });
  });
});

/** 대기 화면 스크립트가 쓰는 만큼만 흉내 낸 DOM. 표시 값은 textContent·hidden으로만 읽는다. */
function makeDocument() {
  const elements = new Map();
  const makeElement = () => ({
    textContent: "",
    hidden: false,
    dataset: {},
    children: [],
    lastElementChild: null,
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
  });
  return {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = makeElement();
        if (id === "steps") {
          element.children = Array.from({ length: 4 }, () => {
            const step = makeElement();
            step.lastElementChild = makeElement();
            return step;
          });
        }
        elements.set(id, element);
      }
      return elements.get(id);
    },
  };
}

/** 페이지의 inline script를 가짜 timer·fetch와 함께 실행한다. timer는 `advance()`가 한 개씩 돌린다. */
function runWaitPage(html, fetchImpl, { storageThrows = false } = {}) {
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  const document = makeDocument();
  const timers = new Map();
  const replaced = [];
  const storage = new Map();
  let nextTimer = 0;
  const run = new Function(
    "document", "fetch", "location", "setTimeout", "clearTimeout", "setInterval", "performance", "sessionStorage",
    script,
  );
  run(
    document,
    fetchImpl,
    { replace(url) { replaced.push(url); } },
    (fn) => { nextTimer += 1; timers.set(nextTimer, fn); return nextTimer; },
    (id) => { timers.delete(id); },
    () => 0,
    { now: () => 0 },
    { setItem: (key, value) => { if (storageThrows) throw new Error("QuotaExceededError"); storage.set(key, String(value)); } },
  );
  return {
    replaced,
    storage,
    text: (id) => document.getElementById(id).textContent,
    hidden: (id) => document.getElementById(id).hidden,
    /** 단계 줄 네 개의 data-state(done·current·pending·stopped). 고리 채움과 같은 값을 읽는다. */
    steps: () => document.getElementById("steps").children.map((step) => step.dataset.state),
    /** 가장 먼저 걸린 timer 하나(= 다음 확인)를 돌린다. 요청 상한 timer는 응답 뒤 지워진다. */
    async advance() {
      const [id, next] = timers.entries().next().value ?? [];
      if (!next) return false;
      timers.delete(id);
      await next();
      // check()가 await한 fetch·json이 끝나도록 microtask를 비운다.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      return true;
    },
  };
}

test("서버가 꺼졌다가 옛 서버로 돌아오면 대기 화면은 '서버 응답 대기'를 벗어나 실패와 원인을 보여 준다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cuelo-wait-page-"));
  const previous = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = root;
  try {
    // 2026-09-28 사고의 파일 모양: command는 CUTOVER에 멈춰 있고 worker가 실패 result를 남겼다.
    const requestId = "3".repeat(32);
    const stageHash = "5".repeat(64);
    const clientId = "wait_page_client_1234567890";
    const maintenanceDirectory = join(root, "maintenance", requestId);
    const requestPath = join(root, "requests", `${requestId}.json`);
    const resultPath = join(root, "results", `${requestId}.json`);
    const terminalError = "설치 폴더 이동이 6회 모두 실패했다: 파일이 다른 프로세스에서 사용되고 있다 (updater exit 0, transaction phase=FAILED)";
    await writeJson(requestPath, {
      schemaVersion: 2,
      completionContractVersion: 1,
      requestId,
      preparedStagePrefix: join(root, "stage"),
      stageTransactionPath: join(root, "stage", "stage-transaction.json"),
      maintenanceDirectory,
      transactionReceiptPath: join(root, "transactions", `${requestId}.json`),
      resultPath,
    });
    await writeJson(join(root, "active.json"), { schemaVersion: 2, requestId, requestPath });
    await writeJson(join(maintenanceDirectory, "command.json"), {
      schemaVersion: 2, requestId, stageHash, phase: "CUTOVER", revision: 3, updatedAtUtc: new Date().toISOString(),
    });

    const html = renderUpdateWaitPage({ requestId, stageHash, clientId, sessionId: null, resumeUrl: "/?session=x" });
    let serverUp = false;
    const polled = [];
    const page = runWaitPage(html, async (url, init) => {
      if (!serverUp) throw new TypeError("Failed to fetch");
      if (init?.method === "POST") return { ok: true, json: async () => ({}) };
      const query = new URL(url, "http://127.0.0.1:30141").searchParams;
      polled.push(Object.fromEntries(query));
      // 실제 route GET과 같은 함수·인자다(app/api/update-maintenance/route.ts).
      const body = maintenance.getUpdateStatus(query.get("requestId") ?? "", (query.get("stageHash") ?? "").toLowerCase());
      return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
    });

    for (let i = 0; i < 3; i += 1) assert.equal(await page.advance(), true);
    assert.equal(page.text("link"), "서버 응답 대기 · 3회");
    assert.equal(page.text("task-title"), "업데이트 상태를 확인하고 있습니다");

    // rollback이 옛 서버를 다시 띄우고 worker가 실패 result를 쓴 뒤의 첫 확인.
    await writeJson(resultPath, { schemaVersion: 2, requestId, status: "failed", phase: "FAILED", error: terminalError });
    serverUp = true;
    assert.equal(await page.advance(), true);

    assert.deepEqual(polled, [{ requestId, stageHash }]);
    assert.equal(page.text("task-title"), "업데이트가 중단되었습니다");
    assert.equal(page.text("status"), `업데이트가 중단되었습니다. ${terminalError}`);
    assert.equal(page.text("link"), "중단");
    // result가 생기면 쓰기 차단이 풀려 돌아가기 버튼을 띄운다. 클릭 없이도 다음 확인에서
    // 서버가 여전히 응답하고 차단이 풀려 있음을 다시 본 뒤 원래 작업 화면으로 돌아간다.
    assert.equal(page.hidden("return-button"), false);
    assert.deepEqual(page.replaced, [], "실패를 처음 본 응답만으로는 바로 이동하지 않는다");
    assert.equal(await page.advance(), true);
    assert.deepEqual(page.replaced, ["/?session=x"]);
    assert.equal(await page.advance(), false, "이동한 뒤에는 더 확인하지 않는다");
  } finally {
    if (previous === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT;
    else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});

/** 실제 route GET이 내는 모양의 실패 응답. 실패 receipt는 서버가 정한 값만 바꿔 넣는다. */
function failedStatus(requestId, stageHash, overrides = {}) {
  return {
    schemaVersion: 2,
    phase: "CUTOVER",
    service: { ready: false, requestId: null, stageHash: null, transactionId: null },
    mutationBlocked: false,
    deploymentCompleted: false,
    writeSafe: false,
    cleanup: null,
    terminalStatus: "failed",
    terminalError: "rollback 완료: 새 버전 응답 확인 실패",
    ...overrides,
  };
}

test("업데이트 실패 뒤 대기 화면은 서버 응답·차단 해제·같은 세션을 확인한 뒤에만 원래 세션으로 자동 복귀한다", async () => {
  const requestId = "6".repeat(32);
  const stageHash = "7".repeat(64);
  const sessionId = "session-original-1";
  const resumeUrl = `/?session=${sessionId}`;
  const html = renderUpdateWaitPage({ requestId, stageHash, clientId: "wait_failed_client_123456", sessionId, resumeUrl });
  const statuses = [
    failedStatus(requestId, stageHash, { mutationBlocked: true }),
    null,
    failedStatus(requestId, stageHash),
    failedStatus(requestId, stageHash),
    failedStatus(requestId, stageHash),
  ];
  let sessionAvailable = false;
  const sessionReads = [];
  const posts = [];
  const page = runWaitPage(html, async (url, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body).action);
      return { ok: true, json: async () => ({ schemaVersion: 2, notice: { notice: true, requestId, stageHash, sessionId, terminalError: null } }) };
    }
    if (url.startsWith("/api/sessions/")) {
      sessionReads.push(url);
      return sessionAvailable
        ? { ok: true, json: async () => ({ sessionId }) }
        : { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }
    const body = statuses.shift();
    if (!body) throw new TypeError("Failed to fetch");
    return { ok: true, json: async () => body };
  });

  // rollback 중이라 쓰기 차단이 남아 있으면 실패를 보여 주되 넘어가지 않는다.
  assert.equal(await page.advance(), true);
  assert.equal(page.text("task-title"), "업데이트가 중단되었습니다");
  assert.equal(page.hidden("return-button"), true);
  assert.deepEqual(page.replaced, []);
  assert.deepEqual(sessionReads, [], "차단이 풀리기 전에는 세션 복귀를 확인하지 않는다");
  // 통지가 원래 세션에 run을 세웠다는 답을 돌아갈 앱이 읽을 기록으로 남긴다.
  assert.deepEqual(JSON.parse(page.storage.get("ompweb-update-failure-return-v1")), {
    schemaVersion: 1, requestId, stageHash, clientId: "wait_failed_client_123456", sessionId, wake: true,
  });
  // 서버 무응답 동안에도 넘어가지 않는다.
  assert.equal(await page.advance(), true);
  assert.deepEqual(page.replaced, []);
  // 차단이 풀린 첫 응답: 돌아가기 버튼과 자동 복귀 안내만 띄운다.
  assert.equal(await page.advance(), true);
  assert.equal(page.hidden("return-button"), false);
  assert.match(page.text("failure-hint"), /자동으로 돌아갑니다/);
  assert.deepEqual(page.replaced, []);
  // 원래 세션을 서버에서 찾지 못하면 이동하지 않고 버튼을 유지한다.
  assert.equal(await page.advance(), true);
  assert.deepEqual(page.replaced, []);
  assert.equal(page.hidden("return-button"), false);
  // 같은 세션이 확인되면 클릭 없이 그 세션 URL로 돌아간다.
  sessionAvailable = true;
  assert.equal(await page.advance(), true);
  assert.deepEqual(page.replaced, [resumeUrl]);
  assert.equal(await page.advance(), false);
  assert.ok(sessionReads.every((url) => url.startsWith(`/api/sessions/${sessionId}?`)), "다른 세션을 읽지 않는다");
  assert.deepEqual(posts, ["failure-notify"], "실패는 resume-confirm으로 성공처럼 확정하지 않고 실패 통지만 한 번 보낸다");
});

test("진행 중 단계에서는 넘어가지 않고, 성공은 정확한 서비스 identity와 복귀 확인 뒤에만 이동한다", async () => {
  const requestId = "8".repeat(32);
  const stageHash = "9".repeat(64);
  const sessionId = "session-success-1";
  const resumeUrl = `/?session=${sessionId}`;
  const html = renderUpdateWaitPage({ requestId, stageHash, clientId: "wait_success_client_12345", sessionId, resumeUrl });
  const service = { ready: true, requestId, stageHash, transactionId: "tx-1" };
  const statuses = [
    { ...failedStatus(requestId, stageHash), phase: "DRAINING", mutationBlocked: true, terminalStatus: null, terminalError: null },
    { ...failedStatus(requestId, stageHash), phase: "SERVICE_READY", service, mutationBlocked: true, terminalStatus: null, terminalError: null },
    { ...failedStatus(requestId, stageHash), phase: "SERVICE_READY", service, deploymentCompleted: true, writeSafe: true, terminalStatus: "succeeded", terminalError: null },
  ];
  const posts = [];
  const page = runWaitPage(html, async (url, init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body).action);
      return { ok: true, json: async () => ({}) };
    }
    if (url.startsWith("/api/sessions/")) return { ok: true, json: async () => ({ sessionId }) };
    return { ok: true, json: async () => statuses.shift() };
  });

  assert.equal(await page.advance(), true);
  assert.deepEqual(page.replaced, [], "DRAINING에서는 이동하지 않는다");
  assert.equal(await page.advance(), true);
  assert.deepEqual(page.replaced, [], "새 서비스가 떠도 쓰기 안전 증거 전에는 이동하지 않는다");
  assert.equal(await page.advance(), true);
  assert.deepEqual(page.replaced, [resumeUrl]);
  assert.deepEqual(posts, ["resume-confirm"]);
});

test("실패 통지 응답이 run을 세우지 않았다고 확정할 때만 복귀 기록이 깨우지 않으며, 기록 저장이 막혀도 자동 복귀는 이어진다", async () => {
  const requestId = "a1".repeat(16);
  const stageHash = "b2".repeat(32);
  const sessionId = "session-notice-1";
  const resumeUrl = `/?session=${sessionId}`;
  const cases = [
    { name: "run 세움", notify: async () => ({ ok: true, json: async () => ({ notice: { notice: true, sessionId } }) }), wake: true },
    { name: "다른 탭이 이미 알림", notify: async () => ({ ok: true, json: async () => ({ notice: { notice: false, reason: "already-claimed" } }) }), wake: true },
    { name: "응답 유실", notify: async () => { throw new TypeError("Failed to fetch"); }, wake: true },
    { name: "서버 통지 오류", notify: async () => ({ ok: true, json: async () => ({ notice: { notice: false, reason: "error" } }) }), wake: true },
    { name: "주도 세션 없음", notify: async () => ({ ok: true, json: async () => ({ notice: { notice: false, reason: "no-initiator" } }) }), wake: false },
    { name: "저장 실패", notify: async () => ({ ok: true, json: async () => ({ notice: { notice: true, sessionId } }) }), wake: null, storageThrows: true },
  ];
  for (const item of cases) {
    const html = renderUpdateWaitPage({ requestId, stageHash, clientId: "wait_notice_client_123456", sessionId, resumeUrl });
    let notifications = 0;
    const page = runWaitPage(html, async (url, init) => {
      if (init?.method === "POST") {
        notifications += 1;
        return item.notify();
      }
      if (url.startsWith("/api/sessions/")) return { ok: true, json: async () => ({ sessionId }) };
      return { ok: true, json: async () => failedStatus(requestId, stageHash) };
    }, { storageThrows: item.storageThrows });
    assert.equal(await page.advance(), true, item.name);
    assert.equal(await page.advance(), true, item.name);
    assert.deepEqual(page.replaced, [resumeUrl], item.name);
    assert.equal(notifications, 1, `${item.name}: 실패 통지는 한 번뿐이다`);
    const record = page.storage.get("ompweb-update-failure-return-v1");
    if (item.wake === null) assert.equal(record, undefined, item.name);
    else assert.equal(JSON.parse(record).wake, item.wake, item.name);
  }
});

test("WSL git-revision receipt는 package·shim 없이 쓰기를 열고, revision 형식이나 기록 표시가 틀리면 열지 않는다", async () => {
  await withExternalRoot(async (root) => {
    const requestId = "c".repeat(32);
    const stageHash = "d".repeat(64);
    const maintenanceDirectory = join(root, "maintenance", requestId);
    const transactionReceiptPath = join(root, "transactions", `${requestId}.json`);
    await writeJson(join(root, "requests", `${requestId}.json`), {
      schemaVersion: 2,
      completionContractVersion: 1,
      requestId,
      preparedStagePrefix: "/home/user/cuelo-run",
      stageTransactionPath: "",
      maintenanceDirectory,
      transactionReceiptPath,
      resultPath: join(root, "results", `${requestId}.json`),
    });
    await writeJson(join(root, "active.json"), { schemaVersion: 2, requestId });
    await writeJson(join(maintenanceDirectory, "command.json"), {
      schemaVersion: 2, requestId, stageHash, phase: "CUTOVER", revision: 3, updatedAtUtc: new Date().toISOString(),
    });
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const writeReceipt = (rollback) => writeJson(transactionReceiptPath, {
      schemaVersion: 2,
      kind: "ompweb-runtime-transaction",
      requestId,
      stageHash,
      phase: "RESUME_PENDING",
      success: true,
      deployment: {
        completionContractVersion: 1,
        completed: true,
        writeSafe: true,
        completedAtUtc: new Date().toISOString(),
        requestId,
        stageHash,
        service: { ready: true, exact: true, requestId, stageHash },
        resume: { status: "pending", targetCount: 1, confirmedCount: 0 },
        rollback,
      },
    });

    for (const rollback of [
      { kind: "git-revision", revision: revision.slice(0, 12), transactionRecorded: true },
      { kind: "git-revision", revision: revision.toUpperCase(), transactionRecorded: true },
      { kind: "git-revision", revision },
    ]) {
      await writeReceipt(rollback);
      assert.deepEqual(maintenance.getUpdateMutationBlock(), { requestId, stageHash, phase: "CUTOVER" }, JSON.stringify(rollback));
      assert.equal(maintenance.getUpdateStatus(requestId, stageHash).deploymentCompleted, false, JSON.stringify(rollback));
    }

    await writeReceipt({ kind: "git-revision", revision, transactionRecorded: true });
    assert.equal(maintenance.getUpdateMutationBlock(), null);
    const status = maintenance.getUpdateStatus(requestId, stageHash);
    assert.equal(status.deploymentCompleted, true);
    assert.equal(status.writeSafe, true);
    assert.equal(status.mutationBlocked, false);
  });
});

/**
 * update-state.mjs complete가 남기는 WSL 완료(rollback = 이전 commit)와, AppShell이 그 request로 정하는 상단 줄의
 * 자동 닫힘 시간(updateCleanupAutoHideMs(cleanup.status)). 정리 receipt는 시험마다 직접 쓴다.
 */
async function wslCompletedUpdate(root) {
  const requestId = "e".repeat(32);
  const stageHash = "f".repeat(64);
  const maintenanceDirectory = join(root, "maintenance", requestId);
  const transactionReceiptPath = join(root, "transactions", `${requestId}.json`);
  await writeJson(join(root, "requests", `${requestId}.json`), {
    schemaVersion: 2,
    completionContractVersion: 1,
    requestId,
    preparedStagePrefix: "/home/user/cuelo-run",
    stageTransactionPath: "",
    maintenanceDirectory,
    transactionReceiptPath,
    resultPath: join(root, "results", `${requestId}.json`),
  });
  await writeJson(join(maintenanceDirectory, "command.json"), {
    schemaVersion: 2, requestId, stageHash, phase: "CUTOVER", revision: 3, updatedAtUtc: new Date().toISOString(),
  });
  await writeJson(transactionReceiptPath, {
    schemaVersion: 2,
    kind: "ompweb-runtime-transaction",
    requestId,
    stageHash,
    phase: "RESUME_PENDING",
    success: true,
    deployment: {
      completionContractVersion: 1,
      completed: true,
      writeSafe: true,
      completedAtUtc: new Date().toISOString(),
      requestId,
      stageHash,
      service: { ready: true, exact: true, requestId, stageHash },
      resume: { status: "pending", targetCount: 0, confirmedCount: 0 },
      rollback: { kind: "git-revision", revision: "0123456789abcdef0123456789abcdef01234567", transactionRecorded: true },
    },
  });
  const now = new Date().toISOString();
  return {
    cleanupPath: join(maintenanceDirectory, "cleanup.json"),
    running: {
      schemaVersion: 1,
      owner: "runtime-transaction",
      runtime: "wsl-git",
      ownerPid: process.pid,
      requestId,
      stageHash,
      phase: "ARTIFACT_CLEANUP",
      status: "running",
      reason: null,
      startedAtUtc: now,
      updatedAtUtc: now,
      finishedAtUtc: null,
      currentTarget: "cuelo-run.prev/.next/server",
      completedCount: 1,
      totalCount: 3,
      removedCount: 1,
      keptCount: 0,
      elapsedSeconds: 0.4,
      freedBytes: 1024,
      failures: [],
    },
    banner() {
      const status = maintenance.getUpdateStatus(requestId, stageHash);
      assert.equal(status.deploymentCompleted, true);
      return { cleanup: status.cleanup, hideMs: client.updateCleanupAutoHideMs(status.cleanup?.status ?? null) };
    },
  };
}

test("WSL 완료의 상단 줄은 정리 receipt가 없어도, 있어도, 정리 실행이 결과 없이 끝나도 스스로 닫힌다", async () => {
  await withExternalRoot(async (root) => {
    const update = await wslCompletedUpdate(root);
    // 2026-10-10 8740d96 배포: 정리 단계가 없는 갱신이라 receipt가 없었고 줄이 영영 남았다.
    const missing = update.banner();
    assert.equal(missing.cleanup, null);
    assert.ok(missing.hideMs > 0, "receipt 없는 완료 줄도 스스로 닫힌다");

    await writeJson(update.cleanupPath, {
      ...update.running, status: "succeeded", currentTarget: null, completedCount: 3, removedCount: 3, finishedAtUtc: new Date().toISOString(),
    });
    const succeeded = update.banner();
    assert.equal(succeeded.cleanup.status, "succeeded");
    assert.ok(succeeded.hideMs > 0);

    // 정리 실행이 살아 있는 동안은 진행 중으로 남고 닫히지 않는다.
    await writeJson(update.cleanupPath, update.running);
    assert.equal(update.banner().cleanup.status, "running");
    assert.equal(update.banner().hideMs, null);

    // 정리 도중 갱신 유닛이 강제로 끝나 결과를 쓰지 못했다. 끝난 실행의 running은 실패로 읽어 줄을 닫는다.
    const exitedPid = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeJson(update.cleanupPath, { ...update.running, ownerPid: exitedPid });
    const orphaned = update.banner();
    assert.equal(orphaned.cleanup.status, "failed");
    assert.equal(orphaned.cleanup.currentTarget, null);
    assert.equal(orphaned.cleanup.failureCount, 1);
    assert.ok(orphaned.hideMs > 0);
  });
});

test("Linux 정리 실행은 부팅·시작 tick이 다르면(재부팅·PID 재사용) 끝난 실행으로 본다", { skip: process.platform !== "linux" }, async () => {
  await withExternalRoot(async (root) => {
    const update = await wslCompletedUpdate(root);
    const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
    const startTicks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    for (const [identity, status] of [
      [{ pid: process.pid, bootId, startTicks }, "running"],
      [{ pid: process.pid, bootId: "previous-boot", startTicks }, "failed"],
      [{ pid: process.pid, bootId, startTicks: startTicks + 1 }, "failed"],
    ]) {
      await writeJson(update.cleanupPath, { ...update.running, ownerIdentity: identity });
      assert.equal(update.banner().cleanup.status, status, JSON.stringify(identity));
    }
  });
});

test("교체(CUTOVER)를 본 뒤 서버가 응답하지 않는 동안 대기 화면은 패키지 교체 단계를 유지한다", async () => {
  const requestId = "8".repeat(32);
  const stageHash = "9".repeat(64);
  const html = renderUpdateWaitPage({ requestId, stageHash, clientId: "wait_cutover_client_12345", sessionId: null, resumeUrl: "/?session=x" });
  const cutover = { ...failedStatus(requestId, stageHash), mutationBlocked: true, terminalStatus: null, terminalError: null };
  let served = false;
  const page = runWaitPage(html, async () => {
    if (served) throw new TypeError("Failed to fetch");
    served = true;
    return { ok: true, json: async () => cutover };
  });

  assert.equal(await page.advance(), true);
  assert.equal(page.text("task-title"), "새 버전으로 교체하고 있습니다");
  for (let i = 0; i < 3; i += 1) assert.equal(await page.advance(), true);
  assert.equal(page.text("task-title"), "새 버전으로 교체하고 있습니다");
  assert.equal(page.text("state"), "업데이트 진행 중");
  assert.equal(page.text("link"), "서버 응답 대기 · 3회");
});

test("교체(CUTOVER)를 읽기 전에 서버가 내려가도 대기 화면은 마지막으로 확인한 단계를 지우지 않는다", async () => {
  // WSL 갱신(update.sh)은 drain이 QUIESCENT를 쓴 직후 cutover가 CUTOVER를 쓰고 곧바로 서비스를 멈춘다. 탭은 QUIESCENT를
  // 본 뒤 5초 간격으로 확인하므로 CUTOVER를 읽기 전에 서버가 사라진다. 2026-10-07 실제 갱신에서는 이때 단계가 모두 '대기'로 돌아갔다.
  const cases = [
    { observed: "DRAINING", title: "실행 중인 세션을 정리하고 있습니다", steps: ["current", "pending", "pending", "pending"] },
    { observed: "QUIESCENT", title: "교체 준비를 마무리하고 있습니다", steps: ["done", "current", "pending", "pending"] },
  ];
  for (const { observed, title, steps } of cases) {
    await withExternalRoot(async (root) => {
      const requestId = "a".repeat(32);
      const stageHash = "c".repeat(64);
      const maintenanceDirectory = join(root, "maintenance", requestId);
      const requestPath = join(root, "requests", `${requestId}.json`);
      const commandPath = join(maintenanceDirectory, "command.json");
      const writeCommand = (phase, revision) => writeJson(commandPath, {
        schemaVersion: 2, requestId, stageHash, phase, revision, updatedAtUtc: new Date().toISOString(),
      });
      await writeJson(requestPath, {
        schemaVersion: 2,
        completionContractVersion: 1,
        requestId,
        preparedStagePrefix: join(root, "stage"),
        stageTransactionPath: join(root, "stage", "stage-transaction.json"),
        maintenanceDirectory,
        transactionReceiptPath: join(root, "transactions", `${requestId}.json`),
        resultPath: join(root, "results", `${requestId}.json`),
      });
      await writeJson(join(root, "active.json"), { schemaVersion: 2, requestId, requestPath });
      await writeCommand(observed, observed === "DRAINING" ? 1 : 2);

      const html = renderUpdateWaitPage({ requestId, stageHash, clientId: "wait_held_client_1234567", sessionId: null, resumeUrl: "/?session=x" });
      let serverUp = true;
      const page = runWaitPage(html, async (url) => {
        if (!serverUp) throw new TypeError("Failed to fetch");
        const query = new URL(url, "http://127.0.0.1:30141").searchParams;
        // 실제 route GET과 같은 함수·인자다(app/api/update-maintenance/route.ts).
        const body = maintenance.getUpdateStatus(query.get("requestId") ?? "", (query.get("stageHash") ?? "").toLowerCase());
        return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) };
      });

      assert.equal(await page.advance(), true);
      assert.equal(page.text("task-title"), title, observed);
      assert.deepEqual(page.steps(), steps, observed);

      // 서비스가 멈췄다. 이 뒤로는 CUTOVER를 읽을 수 없다.
      serverUp = false;
      for (let i = 0; i < 3; i += 1) assert.equal(await page.advance(), true);
      assert.equal(page.text("task-title"), title, `${observed}: 무응답 중에도 마지막으로 본 단계를 유지한다`);
      assert.deepEqual(page.steps(), steps, `${observed}: 못 본 단계를 올리거나 본 단계를 지우지 않는다`);
      assert.equal(page.text("link"), "서버 응답 대기 · 3회", observed);
      assert.match(page.text("status"), /업데이트가 끝났는지 실패했는지는 아직 확인되지 않았습니다/, `${observed}: 결과는 단정하지 않는다`);

      // 서버가 돌아와 교체 단계를 알리면 그때 올라간다.
      await writeCommand("CUTOVER", 3);
      serverUp = true;
      assert.equal(await page.advance(), true);
      assert.deepEqual(page.steps(), ["done", "done", "current", "pending"], observed);
      assert.equal(page.text("link"), "연결됨 · 15초 간격 확인", observed);
    });
  }
});
