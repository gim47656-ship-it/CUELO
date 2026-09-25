import type { OmpWebReleaseInfo, OmpWebUpdateResponse } from "@/lib/api-types";

export const CUELO_RELEASES_URL = "https://github.com/gim47656-ship-it/CUELO/releases";
export const CUELO_GITHUB_RELEASE_API_URL = "https://api.github.com/repos/gim47656-ship-it/CUELO/releases/latest";

const RELEASE_CACHE_SECONDS = 60 * 60;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_CHANGELOG_LENGTH = 40_000;

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
}

interface GitHubReleasePayload {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

interface UpdateStatusOptions {
  currentAppVersion?: string;
  fetcher?: Fetcher;
}

function parseVersion(value: unknown): ParsedVersion | null {
  const normalized = String(value ?? "").trim().replace(/^[^0-9]*/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(normalized);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

function canonicalVersion(value: unknown): string | null {
  const parsed = parseVersion(value);
  if (!parsed) return null;
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease ? `${core}-${parsed.prerelease.join(".")}` : core;
}

/** Compare SemVer-like values without throwing on malformed upstream data. */
export function compareVersions(left: unknown, right: unknown): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number(leftPart);
      const rightNumber = Number(rightPart);
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function isNewerVersion(latest: string | null, current: string | null): boolean {
  return Boolean(latest && current && compareVersions(latest, current) > 0);
}

function releaseFromPayload(payload: GitHubReleasePayload): OmpWebReleaseInfo {
  const version = canonicalVersion(payload.tag_name);
  if (!version) throw new Error("The CUELO release did not contain a valid version tag");

  const tagName = typeof payload.tag_name === "string" && payload.tag_name.trim()
    ? payload.tag_name.trim()
    : `v${version}`;
  const htmlUrl = typeof payload.html_url === "string" && payload.html_url.startsWith(`${CUELO_RELEASES_URL}/`)
    ? payload.html_url
    : `${CUELO_RELEASES_URL}/tag/${encodeURIComponent(tagName)}`;
  const body = typeof payload.body === "string" ? payload.body.slice(0, MAX_CHANGELOG_LENGTH) : "";

  return {
    version,
    tagName,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : tagName,
    body,
    htmlUrl,
    publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
  };
}

/** Latest CUELO release, or null when the repository has not published one (HTTP 404). */
async function fetchLatestRelease(fetcher: Fetcher): Promise<GitHubReleasePayload | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(CUELO_GITHUB_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "cuelo-update-check",
      },
      signal: controller.signal,
      // Next.js caches this server-side request so every browser tab does not
      // consume a GitHub API request. The injected fetcher in tests ignores it.
      next: { revalidate: RELEASE_CACHE_SECONDS },
    } as RequestInit & { next: { revalidate: number } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Update source returned HTTP ${response.status}`);
    return await response.json() as GitHubReleasePayload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getOmpWebUpdateStatus(options: UpdateStatusOptions = {}): Promise<OmpWebUpdateResponse> {
  const fetcher = options.fetcher ?? fetch;
  const currentAppVersion = canonicalVersion(options.currentAppVersion ?? process.env.NEXT_PUBLIC_APP_VERSION) ?? "unknown";

  const payload = await fetchLatestRelease(fetcher);
  const latestRelease = payload ? releaseFromPayload(payload) : null;

  return {
    currentAppVersion,
    latestRelease,
    updateAvailable: isNewerVersion(latestRelease?.version ?? null, currentAppVersion),
    checkedAt: new Date().toISOString(),
  };
}