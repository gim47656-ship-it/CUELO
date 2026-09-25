import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";


const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const maintenance = await jiti.import("./update-maintenance.ts");
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
