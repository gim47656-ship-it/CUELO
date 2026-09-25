/**
 * 6 Pro(SHION) 상담 기록을 읽는 쪽.
 *
 * 브라우저 자동 상담의 성공 답변은 `omp_publish_reply`가 session-native custom entry로
 * 남기는 것이 정본이다. 이 JSONL은 sessionId가 붙은 실패·운영 기록이고, 화면은 현재
 * sessionId와 정확히 일치하는 실패만 보조 발화로 읽는다.
 *
 * 줄 모양의 정본은 shim 쪽이고, 여기서는 **화면이 쓰는 필드만** 받아 검사한다. sessionId가
 * 없는 과거 기록과 모양이 틀린 줄은 통째로 버린다.
 */

/** 상담 한 건. 요청 프롬프트는 기록되지 않으므로 여기에도 없다. */
export interface Web6ConsultRecord {
  /** 상담 요청을 보낸 현재 OMP 세션. 이 값 없는 과거 기록은 귀속하지 않는다. */
  sessionId: string;
  /** 상담 요청이 shim 에 들어온 시각(epoch ms). 어느 턴에 세울지 고르는 근거다. */
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  model: string;
  status: "ok" | "failed";
  /** ChatGPT 대화 id. 같은 대화에서 온 상담을 한 화자로 묶는다. 실패하면 없을 수 있다. */
  conversationId?: string;
  /** 상담 응답 전문. 성공한 상담에만 있다. */
  text?: string;
  /** 실패 사유. 실패한 상담에만 있다. */
  error?: string;
}

export const WEB6_CONSULTS_ENDPOINT = "/api/web6/consults";

/**
 * 기록 한 건을 화면이 쓰는 모양으로. 파일을 읽는 라우트와 응답을 받는 브라우저가 같은
 * 판정을 쓰도록 여기 하나만 둔다. 읽을 수 없으면 `null` 이다.
 */
export function parseConsultRecord(value: unknown): Web6ConsultRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;

  const sessionId = typeof fields.sessionId === "string" ? fields.sessionId.trim() : "";
  if (!sessionId) return null;
  const startedAt = fields.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  const status = fields.status;
  if (status !== "ok" && status !== "failed") return null;

  const finishedAt = typeof fields.finishedAt === "number" && Number.isFinite(fields.finishedAt)
    ? fields.finishedAt
    : startedAt;
  const { conversationId, text, error } = fields;
  return {
    sessionId,
    startedAt,
    finishedAt,
    elapsedMs: typeof fields.elapsedMs === "number" && Number.isFinite(fields.elapsedMs)
      ? fields.elapsedMs
      : finishedAt - startedAt,
    model: typeof fields.model === "string" ? fields.model : "",
    status,
    conversationId: typeof conversationId === "string" && conversationId !== "" ? conversationId : undefined,
    text: typeof text === "string" && text !== "" ? text : undefined,
    error: typeof error === "string" && error !== "" ? error : undefined,
  };
}

/** JSONL 한 줄. 깨진 줄은 `null` 이다 — 쓰는 중에 잘린 마지막 줄이 여기에 걸린다. */
export function parseConsultLine(line: string): Web6ConsultRecord | null {
  try {
    return parseConsultRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

export type Web6Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HanseWeb6Client {
  /** 현재 세션의 최근 상담 목록. 기록이 없으면 빈 배열이다(오류가 아니다). */
  listConsults(sessionId: string, signal?: AbortSignal): Promise<Web6ConsultRecord[]>;
}

export function createHanseWeb6Client(
  fetchImpl: Web6Fetch = (input, init) => fetch(input, init),
  endpoint = WEB6_CONSULTS_ENDPOINT,
): HanseWeb6Client {
  return {
    async listConsults(sessionId, signal) {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) throw new Error("sessionId가 필요하다");
      const url = `${endpoint}?sessionId=${encodeURIComponent(normalizedSessionId)}`;
      const response = await fetchImpl(url, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as unknown;
      const consults = body && typeof body === "object" && "consults" in body
        ? (body as { consults: unknown }).consults
        : null;
      if (!Array.isArray(consults)) throw new Error("consults 배열이 아니다");
      // 라우트가 이미 검사한 모양이지만 화면이 쓰는 필드는 여기서 한 번 더 좁힌다 —
      // 믿을 수 없는 항목 하나가 대화창에 `undefined` 로 떠오르는 것보다 낫다.
      return consults.flatMap((entry) => {
        const record = parseConsultRecord(entry);
        return record?.sessionId === normalizedSessionId ? [record] : [];
      });
    },
  };
}
