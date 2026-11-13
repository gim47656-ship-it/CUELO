import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type BusySnapshot = { writtenAt: number; pid: number; port: number | null; cwds: string[]; unresolved: number; appDir: string };
export const BUSY_MAX_AGE_MS = 120_000;
export function readBusySnapshots(agentDir: string, now = Date.now()): BusySnapshot[] {
  const dir = join(agentDir, "cuelo-busy-cwds");
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const snapshots: BusySnapshot[] = [];
  for (const name of names) {
    if (!/^\d+(?:-\d+)?\.json$/.test(name)) continue;
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) continue;
      const s = JSON.parse(readFileSync(fd, "utf8")) as BusySnapshot;
      if (!Number.isInteger(s.pid) || s.pid <= 0 || !(s.port === null || (Number.isInteger(s.port) && s.port > 0 && s.port <= 65535)) ||
        name !== (s.port === null ? `${s.pid}.json` : `${s.port}-${s.pid}.json`) ||
        !Number.isFinite(s.writtenAt) || s.writtenAt > now || now - s.writtenAt >= BUSY_MAX_AGE_MS ||
        !Array.isArray(s.cwds) || !s.cwds.every((p) => typeof p === "string" && p.startsWith("/")) ||
        !Number.isInteger(s.unresolved) || s.unresolved < 0 || typeof s.appDir !== "string" || !s.appDir.startsWith("/")) continue;
      try { process.kill(s.pid, 0); } catch (error) {
        // EPERM means the process exists but this process cannot inspect it.
        if ((error as NodeJS.ErrnoException).code !== "EPERM") continue;
      }
      snapshots.push(s);
    } catch { /* Unreadable, symlinked, malformed or stale snapshots never prove idle. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return snapshots;
}
