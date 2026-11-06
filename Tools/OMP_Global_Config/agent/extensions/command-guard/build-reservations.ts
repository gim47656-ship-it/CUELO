import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BUILD_RESERVATION_MS = 120_000;
export const BUILD_TOMBSTONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface BuildReservation {
  createdAt: number;
  cwd: string;
  sessionId: string;
}

export interface BuildReservationStore {
  /** undefined means acquired (or a logged filesystem failure); an existing reservation means refuse. */
  reserve(build: Omit<BuildReservation, "createdAt">): BuildReservation | undefined;
}

/**
 * Publishing revision N with link() is exclusive and readers see complete JSON.
 * Keep the latest revision and one day of older tombstones. After publication, recheck the highest
 * revision so a delayed contender cannot acquire a pruned old revision over a newer claim (ABA).
 */
export function createBuildReservationStore(
  directory = join(homedir(), ".omp", "agent", "build-reservations"),
  now: () => number = Date.now,
  log: (message: string) => void = (message) => console.warn(message),
  publish: (source: string, destination: string) => void = linkSync,
): BuildReservationStore {
  return {
    reserve(build) {
      let temporary: string | undefined;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        while (true) {
          const revisions = readdirSync(directory).filter((entry) => /^\d+\.json$/.test(entry));
          const revision = revisions.reduce((max, entry) => Math.max(max, Number(entry.slice(0, -5))), 0);
          for (const entry of revisions) {
            if (Number(entry.slice(0, -5)) >= revision) continue;
            const path = join(directory, entry);
            try {
              if (now() - statSync(path).mtimeMs >= BUILD_TOMBSTONE_RETENTION_MS) unlinkSync(path);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
          if (revision > 0) {
            const text = readFileSync(join(directory, `${revision}.json`), "utf8");
            let last: BuildReservation | undefined;
            try {
              last = JSON.parse(text) as BuildReservation;
              if (!last || !Number.isFinite(last.createdAt) || last.createdAt > now()) {
                throw new Error("Invalid or future build reservation timestamp");
              }
            } catch (error) {
              // Keep the revision tombstone, but do not let power-loss-corrupted content disable future claims.
              log(`[BuildConcurrencyGuard] 손상된 빌드 예약 ${revision}을 건너뜁니다: ${String(error)}`);
              last = undefined;
            }
            if (last && now() - last.createdAt < BUILD_RESERVATION_MS) return last;
          }
          temporary = mkdtempSync(join(directory, ".claim-"));
          const source = join(temporary, "reservation.json");
          writeFileSync(source, JSON.stringify({ ...build, createdAt: now() }), { flag: "wx", mode: 0o600 });
          try {
            publish(source, join(directory, `${revision + 1}.json`));
            const highest = readdirSync(directory).reduce(
              (max, entry) => /^\d+\.json$/.test(entry) ? Math.max(max, Number(entry.slice(0, -5))) : max, 0,
            );
            if (highest === revision + 1) return undefined;
            // A delayed publish reused a pruned older revision. Inspect the newer winner, never allow on this claim.
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            // A competing session published this revision first; re-read that complete reservation.
          } finally {
            rmSync(temporary, { recursive: true, force: true });
            temporary = undefined;
          }
        }
      } catch (error) {
        log(`[BuildConcurrencyGuard] 빌드 예약 파일 오류로 예약 검사를 건너뜁니다: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      } finally {
        if (temporary) {
          try { rmSync(temporary, { recursive: true, force: true }); }
          catch (error) { log(`[BuildConcurrencyGuard] 임시 예약 파일 정리 실패: ${String(error)}`); }
        }
      }
    },
  };
}
