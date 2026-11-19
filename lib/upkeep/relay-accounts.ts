/**
 * 이 PC의 AI Studio 중계기(`aistudio2api.service`, provider `aistudio`) 계정 상태. 2026-11-19 사용자 요청: 계정 7개 가운데 6개가
 * Google 계정 인증 요구(HTTP 403)로 막히고 남은 하나가 하루 한도(429)에 걸렸는데 아무도 알리지 않았다. 중계기 로그에서 계정마다
 * 마지막 상태를 읽어 쓸 수 있는 계정 수, 인증 요구, 한도 대기를 아침 보고(`morning.ts`)에 싣는다. 계정 메일은 앞 네 글자만 남긴다.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const RELAY_UNIT = "aistudio2api.service";
/** 인증 요구는 풀릴 때까지 다시 시도되지 않아 로그가 끊긴다. 며칠째 막힌 계정도 보이게 이 날 수만큼 거슬러 읽는다. */
export const RELAY_WINDOW_DAYS = 7;
export const RELAY_VERIFY_URL = "https://aistudio.google.com/verify-account";
const MESSAGES = ["계정 쿨다운", "계정 전환", "요청 완료", "요청에 실패했습니다", "프로토콜 런타임 준비 완료"];

export interface RelayAccount {
  /** 계정 전체 주소. 막힘 비교(`relaySignature`)에만 쓰고 프롬프트에는 싣지 않는다. */
  id: string;
  /** 메일 앞 네 글자와 말줄임표 */
  label: string;
  /** 인증 요구가 마지막 성공보다 뒤에 있으면 verify, 아니면 아직 풀리지 않은 한도 대기가 있으면 cooldown */
  state: "ok" | "verify" | "cooldown";
  /** 인증 요구가 처음 찍힌 시각(ISO). 그 뒤 성공이 없었다. */
  since?: string;
  /** 아직 풀리지 않은 모델별 한도 대기와 풀리는 시각(ISO) */
  cooldowns?: { model: string; until: string }[];
}

export interface RelayStatus {
  /** 마지막 시작 때 중계기가 불러온 계정 수. 시작 기록이 창 밖이면 null */
  total: number | null;
  /** 창 안에서 기록이 남은 계정 */
  accounts: RelayAccount[];
  usable: number;
  verify: number;
  cooldown: number;
}

/** 프롬프트에 싣는 가린 이름. 앞 네 글자만 자른 뒤, 로그 값이므로 그중 주소에 쓰는 글자만 남긴다. */
export function maskAccount(email: string): string {
  return `${email.split("@")[0].slice(0, 4).replace(/[^A-Za-z0-9._+-]/g, "")}…`;
}

const VERIFY_RE = /must be verified/;
/** 한도 대기의 모델 이름. 로그 값이 프롬프트에 그대로 들어가므로 모양이 다른 값은 버린다. */
const MODEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * `journalctl -o cat`의 JSON 줄들(오래된 것부터)로 계정마다 마지막 상태를 정한다. 성공한 요청은 인증 요구와 그 모델의 한도 대기를
 * 지우고, 인증 요구는 처음 찍힌 시각을 잇는다. 한도는 모델마다 따로라 다른 모델의 성공은 대기를 지우지 않는다. 풀리는 시각이 지난
 * 대기는 쓸 수 있는 것으로 본다(그 뒤 실패하면 다시 기록된다). 성공, 인증 요구, 한도 대기 중 하나도 없는 계정은 상태를 모르므로
 * 세지 않는다(중계기는 막힌 계정을 재시작 뒤 다시 시도하지 않아, 시작 기록마다 계정을 비우지 않는다).
 */
export function parseRelayJournal(lines: readonly string[], now: Date): RelayStatus {
  let total: number | null = null;
  const byEmail = new Map<string, { since?: string; verify: boolean; cooldowns: Map<string, string> }>();
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const msg = row.msg;
    if (msg === "프로토콜 런타임 준비 완료" && Number.isInteger(Number(row.accounts))) {
      total = Number(row.accounts);
      continue;
    }
    const source = row.source;
    if (typeof source !== "string" || !source.includes("@")) continue;
    const request = row.request && typeof row.request === "object" ? row.request as Record<string, unknown> : {};
    // 실제 로그에서 계정 전환은 `cause: "verification"`(HTTP 403)으로, 요청 실패는 오류 문구로만 인증 요구를 알린다.
    const verify = (msg === "계정 전환" && row.cause === "verification" && (row.status === undefined || String(row.status) === "403"))
      || (msg === "요청에 실패했습니다" && typeof request.error === "string" && VERIFY_RE.test(request.error));
    const cooldown = msg === "계정 쿨다운" && typeof row.until === "string" && Number.isFinite(Date.parse(row.until));
    if (!verify && !cooldown && msg !== "요청 완료") continue;
    const account = byEmail.get(source) ?? { verify: false, cooldowns: new Map<string, string>() };
    byEmail.set(source, account);
    if (verify) {
      if (!account.verify) account.since = typeof row.time === "string" ? row.time : undefined;
      account.verify = true;
    } else if (cooldown) {
      account.cooldowns.set(typeof row.scope === "string" ? row.scope : "", row.until as string);
    } else {
      account.verify = false;
      account.since = undefined;
      if (typeof request.model === "string") account.cooldowns.delete(request.model);
    }
  }
  const accounts: RelayAccount[] = [...byEmail].map(([id, account]) => {
    const label = maskAccount(id);
    if (account.verify) return { id, label, state: "verify", ...(account.since ? { since: account.since } : {}) };
    const cooldowns = [...account.cooldowns].filter(([, until]) => Date.parse(until) > now.getTime())
      .map(([model, until]) => ({ model: MODEL_RE.test(model) ? model : "모델 미상", until }));
    return cooldowns.length ? { id, label, state: "cooldown", cooldowns } : { id, label, state: "ok" };
  });
  const verify = accounts.filter((a) => a.state === "verify").length;
  const cooldown = accounts.filter((a) => a.state === "cooldown").length;
  return { total, accounts, usable: accounts.length - verify - cooldown, verify, cooldown };
}

/**
 * 알릴 막힘의 요약. 인증 요구 계정이 바뀌었거나 쓸 수 있는 계정이 없어졌을 때만 달라진다. 막힘이 없으면 null.
 * 중계기가 불러온 계정 수를 모르거나 그보다 적게 봤으면 쓸 수 있는 계정이 없다고 단정하지 않는다.
 */
export function relaySignature(status: RelayStatus): string | null {
  const verify = status.accounts.filter((a) => a.state === "verify").map((a) => a.id).sort();
  const none = status.usable === 0 && status.total !== null && status.accounts.length >= status.total;
  if (!verify.length && !none) return null;
  return JSON.stringify({ verify, none });
}

/**
 * 이 PC의 중계기 상태. 중계기 서비스나 systemd가 없는 PC는 null(경고 없음)이고, 있는데 로그를 읽지 못하거나 계정 기록이 하나도
 * 없으면 null과 경고를 돌려 「확인하지 못한 것」에 싣는다. 모르는 상태를 정상이나 전부 막힘으로 읽지 않는다.
 */
export async function readRelayStatus(now: Date): Promise<{ status: RelayStatus | null; warning?: string }> {
  let load: string;
  try {
    load = (await exec("systemctl", ["--user", "show", RELAY_UNIT, "-p", "LoadState", "--value"], { timeout: 10_000 })).stdout.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: null };
    return { status: null, warning: `AI Studio 중계기 서비스 상태를 확인하지 못했습니다(${error instanceof Error ? error.message : String(error)}).` };
  }
  if (load !== "loaded") return { status: null };
  try {
    const out = (await exec("journalctl", [
      "--user", "-u", RELAY_UNIT, "--since", `-${RELAY_WINDOW_DAYS}d`, "-o", "cat", "--no-pager", "-g", MESSAGES.join("|"),
    ], { timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })).stdout;
    const status = parseRelayJournal(out.split("\n"), now);
    if (!status.accounts.length) return { status: null, warning: `AI Studio 중계기 로그 최근 ${RELAY_WINDOW_DAYS}일에 계정 상태를 알 수 있는 기록이 없어 확인하지 못했습니다.` };
    return { status };
  } catch (error) {
    return { status: null, warning: `AI Studio 중계기 로그를 읽지 못해 계정 상태를 확인하지 못했습니다(${error instanceof Error ? error.message : String(error)}).` };
  }
}
