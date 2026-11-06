/**
 * 클라우드 야간 세션에 넘길 공개 CUELO 저장소의 열린 이슈(2026-11-06 사용자 선택 「이슈 해결 + 기존 기능 개선」).
 * 인증 없이 공개 REST API를 한 번만 읽는다. 이슈 글은 누구나 쓸 수 있으므로 지시가 아닌 기록으로만 프롬프트에 싣는다.
 */
import { CUELO_RELEASES_URL } from "../omp-updates";
import { maskSecrets } from "./sessions";

/** 한 번에 읽는 행 수(PR이 섞여 온다). 다음 쪽이 있으면 부분 목록으로 표시한다. */
const PAGE_SIZE = 50;
/** 프롬프트에 싣는 이슈 수 */
export const ISSUE_LIMIT = 20;
const TITLE_LIMIT = 200;
const BODY_LIMIT = 1_200;
const REQUEST_TIMEOUT_MS = 10_000;

/** 기존 릴리스 주소(`CUELO_RELEASES_URL`)의 `owner/repo`. github.com 주소가 아니면 null이고 조회하지 않는다. */
export function publicRepoSlug(releasesUrl: string = CUELO_RELEASES_URL): string | null {
  let url: URL;
  try {
    url = new URL(releasesUrl);
  } catch {
    return null;
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/?$/.exec(url.pathname);
  return url.protocol === "https:" && url.hostname === "github.com" && match ? `${match[1]}/${match[2]}` : null;
}

export const CUELO_PUBLIC_REPO = publicRepoSlug();

export interface OpenIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: number;
  /** 가리고 자른 본문 앞부분 */
  excerpt: string;
  /** 본문을 잘랐는지 */
  clipped: boolean;
}

export type IssueLookup =
  | {
    status: "ok";
    repo: string;
    issues: OpenIssue[];
    /** 다음 쪽이 있거나, 상한으로 잘랐거나, 읽지 못한 행이 있어 모든 열린 이슈가 아닐 수 있음 */
    partial: boolean;
  }
  | { status: "unavailable"; repo: string | null; reason: string };

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

function clean(text: string, limit: number): { text: string; clipped: boolean } {
  const masked = maskSecrets(text).replace(/\r\n?/g, "\n").trim();
  return masked.length > limit ? { text: `${masked.slice(0, limit)}…`, clipped: true } : { text: masked, clipped: false };
}

function parseIssue(r: Record<string, unknown>, repo: string): OpenIssue | null {
  if (!Number.isSafeInteger(r.number) || (r.number as number) <= 0) return null;
  const number = r.number as number;
  const url = `https://github.com/${repo}/issues/${number}`;
  if (r.html_url !== url) return null;
  const date = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "");
  const user = r.user && typeof r.user === "object" ? (r.user as Record<string, unknown>).login : null;
  const body = clean(typeof r.body === "string" ? r.body : "", BODY_LIMIT);
  return {
    number,
    title: clean(typeof r.title === "string" ? r.title : "", TITLE_LIMIT).text.replace(/\s+/g, " "),
    url,
    author: typeof user === "string" && /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(user) ? user : "알 수 없음",
    labels: (Array.isArray(r.labels) ? r.labels : [])
      .map((l) => (l && typeof l === "object" ? (l as Record<string, unknown>).name : null))
      .filter((name): name is string => typeof name === "string")
      .map((name) => clean(name, 50).text.replace(/\s+/g, " "))
      .slice(0, 10),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    comments: Number.isSafeInteger(r.comments) && (r.comments as number) >= 0 ? (r.comments as number) : 0,
    excerpt: body.text,
    clipped: body.clipped,
  };
}

/**
 * 공개 CUELO 저장소의 열린 이슈를 최근 만든 순으로 한 번 읽는다. 읽지 못하면 이유와 함께 unavailable이고, 열린 이슈가
 * 없으면 ok와 빈 목록이다. 다음 쪽이 있거나 상한으로 잘랐으면 partial이다. 인증 정보는 보내지 않는다.
 */
export async function collectOpenIssues(fetcher: Fetcher = fetch, repo: string | null = CUELO_PUBLIC_REPO): Promise<IssueLookup> {
  if (!repo) return { status: "unavailable", repo: null, reason: "공개 저장소 주소를 알 수 없음" };
  let response: Response;
  try {
    response = await fetcher(`https://api.github.com/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=${PAGE_SIZE}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "cuelo-nightly" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: "unavailable", repo, reason: `요청 실패: ${error instanceof Error ? error.name : "알 수 없는 오류"}` };
  }
  if (!response.ok) return { status: "unavailable", repo, reason: `HTTP ${response.status}` };
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "unavailable", repo, reason: "응답이 JSON이 아님" };
  }
  if (!Array.isArray(payload)) return { status: "unavailable", repo, reason: "응답이 이슈 목록이 아님" };
  // 이슈 목록 API는 PR도 돌려준다. PR은 빼고, 이슈로 읽지 못한 행이 있으면 부분 목록으로 둔다(빈 목록으로 보이지 않게).
  const rows = payload.filter((raw) => !(raw && typeof raw === "object" && "pull_request" in raw && raw.pull_request !== undefined));
  const all = rows.flatMap((raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? parseIssue(raw as Record<string, unknown>, repo) ?? [] : []));
  const hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "");
  return { status: "ok", repo, issues: all.slice(0, ISSUE_LIMIT), partial: hasNext || all.length > ISSUE_LIMIT || all.length < rows.length };
}
