import { join } from "node:path";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { getRpcSession, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { LOUNGE_MEMBERS } from "./roster";
import { LoungeRoomEngine } from "./room";
import { createFileLoungeStore } from "./store";
import { createLoungeInvoker } from "./provider";

/** 작업 내용은 읽지 않는다. 실행 여부·모델·실제 active credential identity만 비교한다. */
export function workingLoungeMemberIds(bindings: Readonly<Record<string, number>>): ReadonlySet<string> {
  const working = new Set<string>();
  for (const sessionId of getRunningRpcSessionIds()) {
    const session = getRpcSession(sessionId)?.inner;
    const model = session?.model;
    if (!session || !model) continue;
    const accounts = session.modelRegistry.authStorage?.oauth.accounts(model.provider, session.sessionId) ?? [];
    const active = accounts.find((account) => account.active);
    for (const member of LOUNGE_MEMBERS) {
      if (member.provider !== model.provider || member.model !== model.id) continue;
      if (active && bindings[member.id] === active.credentialId) working.add(member.id);
    }
  }
  return working;
}

declare global {
  var __cueloLoungePromise: Promise<LoungeRoomEngine> | undefined;
}

/** HMR에도 동일 room single-flight·generation을 유지한다. 조회만으로 자동 발언을 재개하지 않는다. */
export function getLounge(): Promise<LoungeRoomEngine> {
  globalThis.__cueloLoungePromise ??= getOmpRuntime().then((runtime) => new LoungeRoomEngine({
    store: createFileLoungeStore(join(runtime.agentDir, "cuelo-lounge", "room-main.json")),
    invoker: createLoungeInvoker(runtime),
    workingMemberIds: workingLoungeMemberIds,
    autoTalkBlockReason: () => getRunningRpcSessionIds().length > 0 ? "작업이 실행 중이라 자동 발언을 쉬고 있어요." : undefined,
  })).catch((error) => {
    globalThis.__cueloLoungePromise = undefined;
    throw error;
  });
  return globalThis.__cueloLoungePromise;
}
