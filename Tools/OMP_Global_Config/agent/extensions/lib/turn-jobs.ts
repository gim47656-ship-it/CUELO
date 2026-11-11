// 이 세션 Main이 띄운 실행 중 bash·eval job과 이름 붙은 bash 서비스를 본다. jev-runtime(정리 전 자기 job 점유 차단)과
// unreaped-jobs 플러그인(턴 끝 미회수 안내)이 같은 관측을 쓴다. 이름 붙은 서비스는 AsyncJobManager 행이 아니어서 bash·proc 결과로만 보인다.
// 전역 AGENTS.md 「`yield` 직전 띄운 job 회수·취소」를 글 대신 지키는 안내이며 막지 않는다(2026-11-11 사용자 결정: 안내).
import { eligible } from "./job-observation";

const STARTED = /^(?:running|ready|starting|restarting)$/u;
const LISTED_ACTIVE = /^(?:running|ready|starting|restarting|stopping)$/u;
const ENDED = /^(?:exited|failed)$/u;
const SHOWN = 8;

function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

export interface ServiceToolResult {
  toolName: string;
  isError?: boolean;
  input?: unknown;
  details?: unknown;
}

/** 이 세션이 bash `name`으로 띄워 아직 끝났다고 관측되지 않은 서비스. 값은 띄운 명령이다. */
export class LiveServices {
  readonly #services = new Map<string, string>();

  /** bash 결과에는 그 호출의 명령을 함께 넘긴다. */
  observe(event: ServiceToolResult, command = ""): void {
    if (event.isError) return;
    if (event.toolName === "bash") {
      const service = fieldOf(event.details, "service");
      const name = fieldOf(service, "name");
      if (typeof name !== "string" || !name) return;
      if (STARTED.test(String(fieldOf(service, "state")))) this.#services.set(name, command);
      else this.#services.delete(name);
      return;
    }
    if (event.toolName !== "read" && event.toolName !== "write") return;
    const path = fieldOf(event.input, "path");
    if (typeof path !== "string" || !/^proc:\/\//u.test(path)) return;
    const proc = fieldOf(event.details, "proc");
    const daemon = fieldOf(proc, "daemon");
    const name = fieldOf(daemon, "name");
    if (typeof name === "string" && ENDED.test(String(fieldOf(daemon, "state")))) this.#services.delete(name);
    if (event.toolName !== "read" || !/^proc:\/\/\/?$/u.test(path)) return;
    const daemons = fieldOf(proc, "daemons");
    if (!Array.isArray(daemons)) return;
    const active = new Set(daemons.flatMap((item) => {
      const serviceName = fieldOf(item, "name");
      return typeof serviceName === "string" && LISTED_ACTIVE.test(String(fieldOf(item, "state"))) ? [serviceName] : [];
    }));
    for (const serviceName of [...this.#services.keys()]) {
      if (!active.has(serviceName)) this.#services.delete(serviceName);
    }
  }

  /** `test_session`이 맡은 서비스처럼 이 세션이 더는 회수 대상으로 보지 않는 이름을 뺀다. */
  forget(name: string): void {
    this.#services.delete(name);
  }

  entries(): IterableIterator<[string, string]> {
    return this.#services.entries();
  }

  names(): string[] {
    return [...this.#services.keys()];
  }

  clear(): void {
    this.#services.clear();
  }
}

/** 턴 끝에 남은 job·서비스를 한 번만 알린다. 같은 실행(id·시작 시각)과 같은 서비스 이름은 세션 안에서 다시 알리지 않는다. */
export class UnreapedJobs {
  readonly #notified = new Set<string>();

  note(running: readonly unknown[], services: readonly string[]): string | undefined {
    const fresh: string[] = [];
    for (const raw of running) {
      const job = eligible(raw);
      if (!job) continue;
      const key = `job:${job.id}@${job.startTime}`;
      if (this.#notified.has(key)) continue;
      this.#notified.add(key);
      fresh.push(job.id);
    }
    for (const name of services) {
      const key = `service:${name}`;
      if (this.#notified.has(key)) continue;
      this.#notified.add(key);
      fresh.push(`${name}(서비스)`);
    }
    if (fresh.length === 0) return undefined;
    const more = fresh.length > SHOWN ? ` 외 ${fresh.length - SHOWN}개` : "";
    return `아직 실행 중: ${fresh.slice(0, SHOWN).join(", ")}${more}. 회수하거나 취소하고, 일부러 남긴다면 보고 첫 문장에 진행 중이라고 적어라.`;
  }

  reset(): void {
    this.#notified.clear();
  }
}
