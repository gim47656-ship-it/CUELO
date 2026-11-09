import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// 2026-11-09 사용자 요청: Main(Anthropic 한도)이 파일을 하나씩 read로 훑지 말고, 꼼꼼히 읽는 일은
// skim(다른 모델이 전체를 읽고 답과 근거 경로를 돌려줌)이나 읽기 전용 조사 Maker에 넘기게 유도한다.
// 7일 실측(Main 세션 1,477턴): 한 입력에서 고치지 않은 파일을 3개 이상 읽은 턴 70, 6개 이상 22. read 1,974회 대 skim 13회.
// 사용자 입력 하나에서 고치지 않은 서로 다른 파일을 이 개수째 읽으려 할 때 한 번 안내한다(막지 않는다).
export const EXPLORATION_READS_BEFORE_NUDGE = 4;

const INTERNAL_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const SELECTOR = /:(?:raw|img|conflicts|-?\d[\d,+:-]*(?::raw)?|raw:[\d,+:-]+)$/;
const EDIT_TARGET = /^\[([^\]\n#]+)#[0-9A-Fa-f]{4}\]/gm;

export function reminder(count: number): string {
  return [
    `이번 요청에서 고치지 않을 파일을 벌써 ${count}개째 직접 read하고 있다. Main의 read는 Anthropic 한도를 쓴다.`,
    "넓게 훑는 읽기는 넘긴다: 남은 질문을 `skim`(paths에 디렉터리나 glob, question에 찾을 것과 돌려받을 형태)으로 보내면 다른 모델이 파일 전체를 꼼꼼히 읽고 답과 근거 경로를 돌려준다.",
    "실행이나 여러 단계 확인이 필요한 조사는 읽기 전용 diagnostic Maker에 맡긴다.",
    "직접 read는 skim이 짚은 줄을 확인하거나 고칠 줄을 편집 직전에 볼 때만 쓴다.",
  ].join(" ");
}

export function normalizeReadPath(raw: unknown, cwd: string): string | null {
  if (typeof raw !== "string") return null;
  let path = raw.trim();
  if (!path || INTERNAL_URL.test(path)) return null;
  const query = path.indexOf("?");
  if (query >= 0) path = path.slice(0, query);
  while (SELECTOR.test(path)) path = path.replace(SELECTOR, "");
  if (!path) return null;
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

type Log = (record: Record<string, unknown>) => void;

// 관찰 기록은 플러그인 폴더 밖(에이전트 폴더의 다른 cuelo-*.json 상태 파일 옆)에 둔다. 정식 폴더는 프로필 동기화가 덮는다.
// 시험판(plugin-lab/<id>)과 정식판(cuelo-plugins/<id>) 모두 두 단계 위가 에이전트 폴더다.
export const EVENTS_FILE = "cuelo-scan-nudge-events.jsonl";

const defaultLog: Log = (record) => {
  try {
    appendFileSync(join(import.meta.dir, "..", "..", EVENTS_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // 기록 실패는 안내 동작을 막지 않는다.
  }
};

export function createScanNudge(log: Log = defaultLog) {
  return function scanNudge(pi: ExtensionAPI): void {
    let armed = false;
    let delegated = false;
    let nudged = false;
    let followed = false;
    let explored = new Set<string>();
    let edited = new Set<string>();

    pi.on("input", (event) => {
      // 사용자 입력이 아닌 입력(확장이 넣은 후속 입력 등)은 앞 요청의 읽기 수를 이어받지 않고 안내를 끈다.
      armed = event.source === "interactive" || event.source === "rpc";
      if (!armed) return;
      delegated = false;
      nudged = false;
      followed = false;
      explored = new Set();
      edited = new Set();
    });

    // 먼저 읽고 나중에 고친 파일은 탐색이 아니라 편집 준비였으므로 수에서 뺀다.
    const markEdited = (path: string) => {
      edited.add(path);
      explored.delete(path);
    };

    pi.on("tool_call", (event, ctx) => {
      if (!armed || ctx.agent?.kind === "sub") return;
      const input = (event.input ?? {}) as Record<string, unknown>;
      const cwd = ctx.cwd;
      if (event.toolName === "skim" || event.toolName === "task") {
        delegated = true;
        if (nudged && !followed) {
          followed = true;
          log({ type: "followed", tool: event.toolName, sessionId: ctx.sessionManager?.getSessionId?.() });
        }
        return;
      }
      if (event.toolName === "write") {
        const path = normalizeReadPath(input.path, cwd);
        if (path) markEdited(path);
        return;
      }
      if (event.toolName === "edit") {
        for (const match of String(input.input ?? "").matchAll(EDIT_TARGET)) {
          const path = normalizeReadPath(match[1], cwd);
          if (path) markEdited(path);
        }
        return;
      }
      if (event.toolName !== "read" || nudged || delegated) return;
      const path = normalizeReadPath(input.path, cwd);
      if (!path || edited.has(path)) return;
      explored.add(path);
      if (explored.size < EXPLORATION_READS_BEFORE_NUDGE) return;
      nudged = true;
      log({ type: "nudge", files: explored.size, sessionId: ctx.sessionManager?.getSessionId?.() });
      pi.sendMessage(
        { customType: "scan-nudge", content: reminder(explored.size), display: false, attribution: "agent" },
        { deliverAs: "aside" },
      );
    });
  };
}

export default createScanNudge();
