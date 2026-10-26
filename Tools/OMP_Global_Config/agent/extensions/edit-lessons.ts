import { posix, win32 } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MEMORY_SECRET_PATTERN } from "./lib/memory-excerpt";
import { onSessionLifecycle } from "./lib/session-identity";

// 2026-10-17: 저장 교훈은 첫 턴 recall(`<memories>`)과 요청별 docmap-route로만 닿는다. 파일 경로에 묶인 교훈
// (예: `setup.ps1 -ValidateOnly`는 배포 전에 먼저 돌린다)은 그 파일을 고치는 순간에 필요한데, 그때는 어디서도 다시 오르지 않는다
// (doc/history/2026/10/05-memory-application, 10/04-memory-followup). 그래서 `edit`·`write`가 호출될 때 대상 경로로 기억을 찾아
// 그 도구 호출 직후 다음 모델 요청에 단서로 붙인다(tool_call `additionalContext`, 비차단).
// 안내는 단서일 뿐이다. 도구를 막지 않고, 기억 검색이 없거나 실패하거나 제한 시간을 넘으면 아무것도 붙이지 않는다.
//
// 질의·필터 근거(doc/history/2026/10/17-edit-lessons, 은행 사본 실측): 경로를 담은 교훈 123건·파일 81개에서 질의는 상대 경로 그대로가
// basename만이나 둘을 이은 것보다 낫거나 같았다(상위 8개 안 91/80/92쌍). 검색 결과의 content는 Mnemopi 회상 미리보기라 500자에서 잘려 오므로
// 파일명이 뒤쪽에 있는 교훈은 basename 필터에서 빠진다(상위 8의 91쌍 중 35쌍). 그 필터를 풀면 그 경로를 가리키지 않는 교훈이 대부분이 되어
// (보인 243건 중 169건) 단서가 묻히므로 필터는 유지한다. 본문은 공백만 정리해 미리보기 그대로 싣는다(`<memories>`도 원문을 싣는다).
//
// 2026-10-25 보강(doc/history/2026/10/25-harness-gaps/maker-EditLessonsRecall):
// (1) 미리보기가 잘렸고(`…`로 끝남) basename이 미리보기에 없는 후보는 `memory://<id>` 해석기(InternalUrlRouter, core가 `read memory://<id>`에 쓰는
//     것)로 전문을 읽어 같은 basename 필터를 건다. ExtensionContext.memory에는 id로 읽는 API가 없고 DB 파일은 직접 읽지 않는다.
//     전문에서만 걸린 교훈은 미리보기 뒤에 basename 둘레 발췌를 덧붙인다. 비밀 패턴은 전문에도 건다.
// (2) 경로를 찾아 본 것으로 표시하는 때는 검색이 끝난 때(결과 또는 정상 빈 결과)뿐이다. 시간 초과·오류·기억 없음·전문 읽기 실패는 다음
//     편집에서 다시 찾되, 같은 경로의 시도는 세션당 EDIT_LESSONS_MAX_ATTEMPTS(2)번까지다(무응답 기억이 편집마다 최대 1.5초를 먹지 않게).

export interface EditLessonsDeps {
  /** 기억 검색 대기 상한. 테스트만 짧게 준다. 기본은 EDIT_LESSONS_SEARCH_TIMEOUT_MS다. */
  searchTimeoutMs?: number;
  /** 기억 id의 전문(미리보기가 아닌 본문)을 읽는다. 읽지 못하면 던진다. 테스트만 바꾼다. 기본은 `memory://<id>` 해석기다. */
  readMemory?: (ctx: ExtensionContext, id: string, signal: AbortSignal) => Promise<string>;
}

/** 한 경로의 검색(검색 + 잘린 후보의 전문 읽기) 전체 대기 상한. 넘으면 아무것도 더 붙이지 않고 도구는 그대로 진행한다. */
export const EDIT_LESSONS_SEARCH_TIMEOUT_MS = 1_500;
/** 경로 하나에 붙이는 기억 상한. */
export const EDIT_LESSONS_PER_PATH = 3;
/** 같은 경로를 한 세션에서 끝내지 못한 채 시도하는 상한(첫 시도 + 재시도 1번). */
export const EDIT_LESSONS_MAX_ATTEMPTS = 2;
const SEARCH_LIMIT = 8;
const LESSON_SOURCES = new Set(["coding-agent-learn", "coding-agent-retain"]);
/** 전문 읽기 뒤 미리보기에 덧붙이는 basename 둘레 발췌의 앞뒤 글자 수. */
const SNIPPET_RADIUS = 60;

interface MemoryItem {
  id?: string;
  content: string;
  source?: string;
  timestamp?: string;
  score?: number;
  /** 전문을 읽어 basename이 확인된 후보의 전문. 비밀 패턴 검사와 발췌에만 쓴다. */
  fullText?: string;
}

/** 한 경로의 검색 결과. complete가 false면(시간 초과·오류·기억 없음·전문 읽기 실패) 다음 편집에서 다시 찾는다. */
interface Lookup {
  complete: boolean;
  items: MemoryItem[];
}

/** `memory://<id>` 해석 결과의 YAML front matter(`---` … `---`)를 떼어 행 본문만 남긴다. */
function stripFrontMatter(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n\n", 3);
  return end < 0 ? text : text.slice(end + 6);
}

/** core의 `memory://<id>` 해석기로 전문을 읽는다(호출 세션에 묶여 그 세션의 기억 은행에서만 찾는다). */
async function readFullMemory(ctx: ExtensionContext, id: string, signal: AbortSignal): Promise<string> {
  // 정적 import가 안 되는 이유: 이 확장은 core가 실행 중일 때만 해석되는 core 모듈에 기대고(다른 확장도 같은 방식으로 지연 import한다),
  // 기억 전문이 필요한 드문 경우에만 불러 확장 로드·테스트가 core 내부 모듈 그래프에 묶이지 않게 한다. 실패하면 호출부가 잡아 재시도 대상으로 둔다.
  const { InternalUrlRouter } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
  const resource = await InternalUrlRouter.instance().resolve(`memory://${id}`, {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    signal,
  });
  return stripFrontMatter(resource.content);
}

/** 입력의 `paths`(문자열 배열)와 `path`를 입력 순서대로 모은다. */
function inputPaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const raw: unknown[] = [...(Array.isArray(record.paths) ? record.paths : []), record.path];
  const paths: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && !paths.includes(trimmed)) paths.push(trimmed);
  }
  return paths;
}

/**
 * 입력 경로를 cwd 기준으로 정규화한다(역슬래시→`/`, `.`·`..` 정리). cwd 아래면 cwd 기준 `/` 경로, 밖이면 정규화한 절대 경로(`/` 구분).
 * cwd가 없으면 준 문자열을 posix로 정규화만 한다. 같은 파일을 가리키는 다른 표기가 같은 검색·중복 키가 되게 한다.
 */
export function relativeTarget(cwd: string | undefined, path: string): string {
  // 호스트 플랫폼이 아니라 cwd(없으면 입력)의 모양으로 경로 규칙을 고른다. Windows 러너에서 POSIX 입력에 드라이브가 붙지 않게 한다.
  const p = /^[A-Za-z]:[\\/]/.test(cwd ?? path) ? win32 : posix;
  const slashed = path.replace(/\\/g, "/");
  if (!cwd) return p.normalize(slashed).replace(/\\/g, "/");
  const abs = p.resolve(cwd, slashed);
  const rel = p.relative(cwd, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${p.sep}`) || p.isAbsolute(rel)) return abs.replace(/\\/g, "/");
  return rel.split(p.sep).join("/");
}

/** `scheme://…`·`scheme:/…`(단일 슬래시 별칭). 한 글자 scheme은 Windows 드라이브(`C:/…`)라 뺀다. */
const URI_TARGET_RE = /^[A-Za-z][A-Za-z0-9+.-]+:\//;
/** core가 받아 주는, URL 앞에 경로가 붙은 철자(`/repo/local://x`). */
const PREFIXED_URI_TARGET_RE = /[\\/][A-Za-z][A-Za-z0-9+.-]+:\/\/(?=[^/]|$)/;

/** `file://` URI를 로컬 경로로 푼다(드라이브 `file:///C:/x`→`C:/x`, 호스트는 UNC `//host/x`). 풀 수 없으면 undefined. */
function fileUriPath(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    const path = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return undefined;
  }
}

/**
 * edit·write 입력 경로가 가리키는 교훈 검색 대상(`relativeTarget` 형식). 파일이 아니면 undefined다.
 * 파일은 실제 경로와 `file://`뿐이다. `proc://<id>/kill`·`agent://Main`·`conflict://1`·`local://…`·`xd://…` 같은 core 내부·원격 URI는
 * 프로젝트 파일이 아니라서 경로로 접으면 basename(`kill`·`Main`·`1`)이 무관한 기억에 걸린다(2026-10-26 관측, 블록의 22%).
 */
export function lessonTarget(cwd: string | undefined, path: string): string | undefined {
  if (/^file:\/\//i.test(path)) {
    const local = fileUriPath(path);
    return local === undefined ? undefined : relativeTarget(cwd, local);
  }
  if (URI_TARGET_RE.test(path) || PREFIXED_URI_TARGET_RE.test(path)) return undefined;
  return relativeTarget(cwd, path);
}

/** 검색 결과에서 교훈 후보만 남긴다(출처·id 필요, 같은 id는 처음 것만). basename 필터는 부르는 쪽이 건다. */
function lessonCandidates(items: readonly MemoryItem[]): MemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (typeof item?.id !== "string" || item.id.length === 0 || seen.has(item.id)) return false;
    if (typeof item.content !== "string" || typeof item.source !== "string" || !LESSON_SOURCES.has(item.source)) return false;
    seen.add(item.id);
    return true;
  });
}

/** 전문에서 basename 둘레를 공백만 정리해 잘라 낸다. */
function snippetAround(fullText: string, base: string): string {
  const at = fullText.indexOf(base);
  const window = fullText.slice(Math.max(0, at - SNIPPET_RADIUS), at + base.length + SNIPPET_RADIUS).replace(/\s+/g, " ").trim();
  return `${at > SNIPPET_RADIUS ? "…" : ""}${window}…`;
}

const TIMED_OUT = Symbol("edit-lessons-timed-out");

export function createEditLessons(deps: EditLessonsDeps = {}) {
  const searchTimeoutMs = deps.searchTimeoutMs ?? EDIT_LESSONS_SEARCH_TIMEOUT_MS;
  const readMemory = deps.readMemory ?? readFullMemory;

  return function editLessons(pi: ExtensionAPI): void {
    /** 이 세션에서 검색을 끝낸 경로, 지금 찾는 중인 경로, 끝내지 못한 시도 횟수, 이미 붙인(또는 비밀 패턴으로 가린) 기억 id. */
    const lookedUp = new Set<string>();
    const inFlight = new Set<string>();
    const attempts = new Map<string, number>();
    const attached = new Set<string>();
    let sessionGeneration = 0;
    const reset = (): void => {
      sessionGeneration++;
      lookedUp.clear();
      inFlight.clear();
      attempts.clear();
      attached.clear();
    };
    onSessionLifecycle(pi, { start: reset });
    pi.on("session_shutdown", reset);

    /**
     * 경로 하나의 교훈 후보: 검색, 그리고 미리보기가 잘렸고 basename이 안 보이는 후보의 전문 읽기까지 한 마감(searchTimeoutMs) 안에서 한다.
     * 던지지 않는다. 검색이 끝나지 못했거나(기억 없음·오류·시간 초과·"사용 불가" 메시지만 온 빈 결과) 전문 읽기가 실패하면 complete=false다.
     */
    const lookup = async (ctx: ExtensionContext, target: string): Promise<Lookup> => {
      const memory = ctx.memory;
      if (!memory) return { complete: false, items: [] };
      const base = target.slice(target.lastIndexOf("/") + 1);
      const controller = new AbortController();
      const { promise: deadline, resolve: expire } = Promise.withResolvers<typeof TIMED_OUT>();
      const timer = setTimeout(() => {
        controller.abort();
        expire(TIMED_OUT);
      }, searchTimeoutMs);
      const within = <T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> => Promise.race([work, deadline]);
      try {
        const result = await within(memory.search(target, { limit: SEARCH_LIMIT, signal: controller.signal }));
        if (result === TIMED_OUT) return { complete: false, items: [] };
        if (!result?.items?.length) return { complete: !result?.message, items: [] };
        const candidates = lessonCandidates(result.items as MemoryItem[]);
        const items = candidates.filter((item) => item.content.includes(base));
        // 미리보기 밖(잘림 표시 `…`)에 파일명이 있을 수 있는 후보만 전문을 읽는다. 온전한 미리보기에 파일명이 없으면 무관하다.
        const clipped = candidates.filter((item) => !item.content.includes(base) && item.content.endsWith("…"));
        let complete = true;
        const reads = await Promise.all(clipped.map(async (item): Promise<MemoryItem | undefined> => {
          try {
            const text = await within(readMemory(ctx, item.id!, controller.signal));
            if (text === TIMED_OUT) {
              complete = false;
              return undefined;
            }
            return typeof text === "string" && text.includes(base) ? { ...item, fullText: text } : undefined;
          } catch (error) {
            complete = false;
            pi.logger.debug("edit-lessons: 기억 전문 읽기 실패", { id: item.id, error: error instanceof Error ? error.message : String(error) });
            return undefined;
          }
        }));
        for (const read of reads) if (read) items.push(read);
        return { complete, items };
      } catch (error) {
        pi.logger.debug("edit-lessons: 기억 검색 없이 진행", { path: target, error: error instanceof Error ? error.message : String(error) });
        return { complete: false, items: [] };
      } finally {
        clearTimeout(timer);
      }
    };

    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      try {
        // 같은 경로·같은 id는 병렬 호출에서도 한 번만 다루도록 await 전에 표시한다.
        const targets: string[] = [];
        for (const path of inputPaths(event.input)) {
          const target = lessonTarget(ctx.cwd, path);
          if (!target || lookedUp.has(target) || inFlight.has(target)) continue;
          inFlight.add(target);
          targets.push(target);
        }
        if (targets.length === 0) return;
        const generation = sessionGeneration;
        const found = await Promise.all(targets.map((target) => lookup(ctx, target)));
        // 기다리는 사이 세션이 바뀌었으면(session_start·session_shutdown) 이 결과는 옛 세션 것이라 집합을 건드리지 않고 버린다.
        if (generation !== sessionGeneration) return;
        const sections: string[] = [];
        for (const [index, target] of targets.entries()) {
          const { complete, items } = found[index]!;
          // 끝난 검색만 "찾아 봤다"로 표시한다. 끝내지 못한 경로는 다음 편집에서 다시 찾되 시도 상한까지만이다.
          inFlight.delete(target);
          const tried = (attempts.get(target) ?? 0) + 1;
          attempts.set(target, tried);
          if (complete || tried >= EDIT_LESSONS_MAX_ATTEMPTS) lookedUp.add(target);
          const fresh = items.filter((item) => !attached.has(item.id!));
          const secret = (item: MemoryItem): boolean => MEMORY_SECRET_PATTERN.test(item.fullText ?? item.content);
          const withheld = fresh.filter(secret);
          const shown = fresh.filter((item) => !secret(item))
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, EDIT_LESSONS_PER_PATH);
          if (shown.length + withheld.length === 0) continue;
          for (const item of [...shown, ...withheld]) attached.add(item.id!);
          const base = target.slice(target.lastIndexOf("/") + 1);
          const lines = [`[edit-lessons] ${target}에 묶인 기억 ${shown.length + withheld.length}건. 단서일 뿐이며 현재 지시·정본·승인이 우선한다. 원문은 memory://<id>로 읽는다.`];
          for (const item of shown) {
            const date = item.timestamp?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
            const excerpt = item.content.replace(/\s+/g, " ").trim();
            // 전문에서만 파일명이 확인된 교훈은 왜 이 파일에 묶였는지 보이도록 파일명 둘레를 덧붙인다.
            const text = item.fullText === undefined ? excerpt : `${excerpt} [전문에서 ${base} 언급: ${snippetAround(item.fullText, base)}]`;
            lines.push(`- ${text} (id: ${item.id}${date ? `, ${date}` : ""})`);
          }
          if (withheld.length > 0) lines.push(`- 비밀 패턴이 있어 보이지 않음: ${withheld.map((item) => item.id).join(", ")}`);
          sections.push(lines.join("\n"));
        }
        if (sections.length === 0) return;
        return { additionalContext: sections.join("\n\n") };
      } catch (error) {
        pi.logger.debug("edit-lessons: 안내 없이 진행", { error: error instanceof Error ? error.message : String(error) });
        return;
      }
    });
  };
}

export default createEditLessons();
