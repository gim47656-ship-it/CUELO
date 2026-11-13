import { mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { resolveBusy } from "./repo-sync/service";
import type { BusySnapshot } from "./repo-sync/busy-files";
import { getRunningRpcSessionIds, getRpcSessionInfos } from "./rpc-manager";

type Source = { ids: string[]; sessions: { id: string; cwd?: string }[] };
export function startSessionBusyStateWriter(options: { agentDir: string; port?: string; appDir: string; collect: () => Source }) {
  const parsed = Number(options.port);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
  const dir = join(options.agentDir, "cuelo-busy-cwds");
  const path = join(dir, port === null ? `${process.pid}.json` : `${port}-${process.pid}.json`);
  const refresh = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let state: Pick<BusySnapshot, "cwds" | "unresolved">;
    try { const source = options.collect(); state = resolveBusy(source.ids, source.sessions); }
    catch { state = { cwds: [], unresolved: 1 }; }
    writePrivateFileAtomicSync(path, JSON.stringify({ ...state, writtenAt: Date.now(), pid: process.pid, port, appDir: realpathSync(options.appDir) } satisfies BusySnapshot));
  };
  try { refresh(); } catch (error) { console.error("[session-busy-state] initial refresh failed; will retry", error); }
  const timer = setInterval(() => { try { refresh(); } catch (error) { console.error("[session-busy-state] refresh failed", error); } }, 30_000);
  timer.unref();
  const stop = () => { clearInterval(timer); process.removeListener("exit", stop); try { unlinkSync(path); } catch { /* Best-effort shutdown; dead PID snapshots are ignored. */ } };
  process.once("exit", stop);
  return { path, refresh, stop };
}
const globalState = globalThis as typeof globalThis & { __cueloBusyStateWriter?: Promise<unknown> };
export async function ensureSessionBusyStateWriter() {
  return globalState.__cueloBusyStateWriter ??= Promise.resolve(startSessionBusyStateWriter({
    agentDir: getAgentDir(), port: process.env.PORT, appDir: process.env.CUELO_APP_DIR || process.cwd(),
    collect: () => ({ ids: getRunningRpcSessionIds(), sessions: getRpcSessionInfos() }),
  }));
}
