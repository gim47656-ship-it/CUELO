import { posix, win32 } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { MEMORY_SECRET_PATTERN } from "./lib/memory-excerpt";

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

export interface EditLessonsDeps {
  /** 기억 검색 대기 상한. 테스트만 짧게 준다. 기본은 EDIT_LESSONS_SEARCH_TIMEOUT_MS다. */
  searchTimeoutMs?: number;
}

/** 한 호출의 기억 검색 대기 상한. 넘으면 아무것도 붙이지 않고 도구는 그대로 진행한다. */
export const EDIT_LESSONS_SEARCH_TIMEOUT_MS = 1_500;
/** 경로 하나에 붙이는 기억 상한. */
export const EDIT_LESSONS_PER_PATH = 3;
const SEARCH_LIMIT = 8;
const LESSON_SOURCES = new Set(["coding-agent-learn", "coding-agent-retain"]);

interface MemoryItem {
  id?: string;
  content: string;
  source?: string;
  timestamp?: string;
  score?: number;
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

/** 검색 결과에서 이 경로에 묶인 교훈 후보만 남긴다(출처·basename 일치·id 필요). 같은 id는 처음 것만 둔다. */
function lessonItems(items: readonly MemoryItem[], base: string): MemoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (typeof item?.id !== "string" || item.id.length === 0 || seen.has(item.id)) return false;
    if (typeof item.content !== "string" || typeof item.source !== "string" || !LESSON_SOURCES.has(item.source) || !item.content.includes(base)) return false;
    seen.add(item.id);
    return true;
  });
}

export function createEditLessons(deps: EditLessonsDeps = {}) {
  const searchTimeoutMs = deps.searchTimeoutMs ?? EDIT_LESSONS_SEARCH_TIMEOUT_MS;

  return function editLessons(pi: ExtensionAPI): void {
    /** 이 세션에서 이미 찾아 본 경로와 이미 붙인(또는 비밀 패턴으로 가린) 기억 id. */
    const lookedUp = new Set<string>();
    const attached = new Set<string>();
    let sessionGeneration = 0;
    const reset = (): void => {
      sessionGeneration++;
      lookedUp.clear();
      attached.clear();
    };
    pi.on("session_start", reset);
    pi.on("session_shutdown", reset);

    /** 경로 하나의 후보 기억. 검색 없음·오류·제한 시간·빈 결과는 undefined. */
    const search = async (ctx: ExtensionContext, path: string): Promise<MemoryItem[] | undefined> => {
      const memory = ctx.memory;
      if (!memory) return undefined;
      const controller = new AbortController();
      const { promise: timeout, resolve: expire } = Promise.withResolvers<undefined>();
      const timer = setTimeout(() => {
        controller.abort();
        expire(undefined);
      }, searchTimeoutMs);
      try {
        const result = await Promise.race([memory.search(path, { limit: SEARCH_LIMIT, signal: controller.signal }), timeout]);
        return result?.items?.length ? (result.items as MemoryItem[]) : undefined;
      } catch (error) {
        pi.logger.debug("edit-lessons: 기억 검색 없이 진행", { path, error: error instanceof Error ? error.message : String(error) });
        return undefined;
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
          const target = relativeTarget(ctx.cwd, path);
          if (!target || lookedUp.has(target)) continue;
          lookedUp.add(target);
          targets.push(target);
        }
        if (targets.length === 0) return;
        const generation = sessionGeneration;
        const found = await Promise.all(targets.map((target) => search(ctx, target)));
        // 기다리는 사이 세션이 바뀌었으면(session_start·session_shutdown) 이 결과는 옛 세션 것이라 집합을 건드리지 않고 버린다.
        if (generation !== sessionGeneration) return;
        const sections: string[] = [];
        for (const [index, target] of targets.entries()) {
          const items = found[index];
          if (!items) continue;
          const fresh = lessonItems(items, target.slice(target.lastIndexOf("/") + 1)).filter((item) => !attached.has(item.id!));
          const withheld = fresh.filter((item) => MEMORY_SECRET_PATTERN.test(item.content));
          const shown = fresh.filter((item) => !MEMORY_SECRET_PATTERN.test(item.content))
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, EDIT_LESSONS_PER_PATH);
          if (shown.length + withheld.length === 0) continue;
          for (const item of [...shown, ...withheld]) attached.add(item.id!);
          const lines = [`[edit-lessons] ${target}에 묶인 기억 ${shown.length + withheld.length}건. 단서일 뿐이며 현재 지시·정본·승인이 우선한다. 원문은 memory://<id>로 읽는다.`];
          for (const item of shown) {
            const date = item.timestamp?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
            lines.push(`- ${item.content.replace(/\s+/g, " ").trim()} (id: ${item.id}${date ? `, ${date}` : ""})`);
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
