"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  accountIdentities,
  loadSessionAccount,
  providerAccountFace,
  type AccountFace,
  type UsageReport,
} from "@/lib/hanse-resource-client";

/**
 * 대화 기록의 「누가 이 답을 만들었는가」.
 *
 * 사용량 탭은 이미 계정을 얼굴 + 별칭으로 부른다. 대화창이 같은 계정을 다른 이름이나 다른
 * 얼굴로 부르면 두 화면이 같은 것을 가리키는지 사용자가 알 수 없으므로, 배정은 사용량 탭이
 * 쓰는 `accountIdentities()` 한 곳에서만 나온다. 여기서 seed 를 다시 계산하지 않는 이유는
 * 그 함수가 목록에서 계정 순서를 세어 자리를 고르기 때문이다 — 같은 계정이라도 화면에 함께
 * 뜬 계정 목록에 따라 자리가 달라지므로, 목록을 보지 않고 계산한 값은 사용량 탭과 어긋난다.
 *
 * 저장소를 모듈 수준에 두는 것은 `useDisplaySettings` 와 같은 이유다: 메시지 컴포넌트는
 * 수백 개가 뜨므로 읽기 전용 훅만 쓰고, 요청은 화면당 한 번 마운트되는 쪽이 낸다.
 *
 * 저장소는 React 를 모른다 — `syncAccountFaces`·`resolveAccountFace`·`requestSessionPin`
 * 셋이 전부이고, 아래 훅은 `useSyncExternalStore` 로 붙이는 얇은 껍데기다.
 */

export type { AccountFace };

/** 실행 중인 세션이 실제로 쓰고 있다고 런타임이 답한 계정. */
interface SessionPin {
  provider: string;
  credentialId: number;
  /** 이 답을 받은 시각. 세션 안에서 계정이 바뀌었을 수 있으므로 이 값으로 신선도를 잰다. */
  observedAt: number;
}

interface FaceState {
  faces: ReadonlyMap<string, AccountFace>;
  pins: ReadonlyMap<string, SessionPin>;
}

/** 아직 아무것도 모르는 상태. SSR 스냅샷도 이 상태에서 읽는다. */
const EMPTY_STATE: FaceState = { faces: new Map(), pins: new Map() };
const NO_REPORTS: readonly UsageReport[] = [];

/**
 * 다시 묻기까지의 최소 간격. 타이머가 아니라 메시지가 다시 그려질 때만 쓰이는 하한선이다 —
 * 세션 안에서 모델이나 계정을 바꾸면 런타임의 답이 달라지는데 웹은 그 사실을 통지받지
 * 못하므로, 한 번 받은 pin 을 영구히 믿으면 새 계정의 얼굴이 영영 뜨지 않는다. 반대로 매
 * 렌더마다 물으면 요청만 쌓이므로 이 간격이 상한을 만든다. 끝나서 `not-running` 으로 답하는
 * 세션은 사이드카를 읽지 않고 즉시 답하므로 다시 묻는 값이 싸다.
 */
const PIN_RETRY_MS = 30_000;

let state: FaceState = EMPTY_STATE;
let rosterSignature: string | null = null;
const pinAttemptedAt = new Map<string, number>();
const listeners = new Set<() => void>();

/** `useSyncExternalStore` 가 붙잡는 구독. 참조가 흔들리면 매 렌더마다 재구독한다. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: FaceState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function isCredentialId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function accountKey(provider: string, credentialId: number): string {
  return `${provider}:${credentialId}`;
}

/**
 * 사용량 스냅샷을 얼굴 저장소에 흘려 넣는다. 앱의 단일 사용량 구독을 가진 곳에서 한 번만
 * 부른다 — 폴러를 새로 만들지 않는다.
 */
export function syncAccountFaces(reports: readonly UsageReport[] | undefined): void {
  const list = reports ?? NO_REPORTS;
  // 폴러는 60초마다 새 배열을 준다. 배열이 새것이라는 사실은 계정이 달라졌다는 뜻이 아니므로,
  // 얼굴 배정에 실제로 쓰이는 값만 모아 비교한다. 같으면 아무도 다시 그리지 않는다.
  const signature = list
    .map((report) => [
      report.provider,
      report.credentialId ?? "",
      report.metadata?.accountId ?? "",
      report.metadata?.email ?? "",
    ].join("\u0000"))
    .join("|");
  if (signature === rosterSignature) return;
  rosterSignature = signature;

  const identities = accountIdentities(list);
  const faces = new Map<string, AccountFace>();
  list.forEach((report, index) => {
    const credentialId = report.credentialId;
    if (!isCredentialId(credentialId)) return;
    const key = accountKey(report.provider, credentialId);
    // 같은 credential 이 두 번 보고되면 사용량 패널도 앞의 것을 그 계정으로 삼는다.
    if (faces.has(key)) return;
    faces.set(key, { seed: identities[index].seed, alias: identities[index].alias });
  });

  publish({ faces, pins: state.pins });
}

/**
 * 세션이 지금 쓰는 계정을 런타임에 물어 pin 을 세운다. `provider` 는 지금 그리려는 메시지의
 * provider 다 — pin 은 provider 까지 맞아야 얼굴을 내주므로, 다른 provider 의 메시지가 떴다면
 * 그 사이 세션이 갈아탄 것이고 그때는 낡은 pin 을 근거로 삼지 않고 다시 묻는다.
 */
export function requestSessionPin(sessionId: string, provider: string): void {
  const now = Date.now();
  const pin = state.pins.get(sessionId);
  if (pin && pin.provider === provider && now - pin.observedAt < PIN_RETRY_MS) return;

  // 하한선은 세션+provider 마다 따로 센다. 한 provider 에서 막 물었더라도 다른 provider 는
  // 곧바로 물을 수 있어야 새 계정이 낡은 pin 에 막히지 않는다.
  const attemptKey = `${sessionId}\u0000${provider}`;
  const attemptedAt = pinAttemptedAt.get(attemptKey);
  if (attemptedAt !== undefined && now - attemptedAt < PIN_RETRY_MS) return;
  pinAttemptedAt.set(attemptKey, now);

  void loadSessionAccount(sessionId)
    .then((result) => {
      const data = result.data;
      // `resolved` 가 아닌 답(`not-running`·`unresolved`·`unsupported`)은 계정을 특정하지
      // 못했다는 뜻이다. 그 세션의 유일한 활성 계정을 추측하지 않고, 이미 가진 pin 은 남긴다.
      if (!data || data.state !== "resolved") return;
      const { provider: resolvedProvider, credentialId } = data;
      if (typeof resolvedProvider !== "string" || resolvedProvider === "" || !isCredentialId(credentialId)) return;
      const pins = new Map(state.pins);
      pins.set(sessionId, { provider: resolvedProvider, credentialId, observedAt: Date.now() });
      publish({ faces: state.faces, pins });
    })
    .catch(() => {
      // 얼굴은 장식이다. 실패하면 provider·모델 표시로 남고 다음 기회에 다시 묻는다.
    });
}

/**
 * 한 메시지의 계정을 고르는 순서. 위에서 걸리는 것이 없으면 얼굴을 그리지 않는다.
 *
 * 1. 메시지 자신이 기록한 credential — 그 답을 실제로 만든 계정이므로 가장 정확하다.
 * 2. 실행 중인 세션이 쓰고 있다고 런타임이 답한 계정. provider 가 메시지와 같을 때만 쓴다.
 * 3. 얼굴이 예약된 provider — 계정이 구조적으로 하나뿐이라 고를 후보가 하나다. 추측이 아니다.
 * 4. 그 밖에는 모름. 후보가 여럿인 provider 에서 「유일한 활성 계정」을 골라 얼굴을 그리면,
 *    틀렸을 때 사용자는 틀린 것을 알 방법이 없다.
 */
export function resolveAccountFace(
  sessionId: string | undefined,
  provider: string | undefined,
  credentialId: number | undefined,
): AccountFace | null {
  if (!provider) return null;
  if (isCredentialId(credentialId)) {
    const face = state.faces.get(accountKey(provider, credentialId));
    if (face) return face;
  }
  const pin = sessionId ? state.pins.get(sessionId) : undefined;
  if (pin && pin.provider === provider) {
    const face = state.faces.get(accountKey(provider, pin.credentialId));
    if (face) return face;
  }
  return providerAccountFace(provider);
}

/**
 * 사용량 스냅샷을 저장소에 흘려 넣는 자리. 앱의 단일 사용량 구독을 가진 곳에서 한 번만 부른다.
 */
export function useSyncedAccountFaces(reports: readonly UsageReport[] | undefined): void {
  useEffect(() => {
    syncAccountFaces(reports);
  }, [reports]);
}

/**
 * 이 메시지에 그릴 얼굴. 계정을 특정하지 못하면 `null` 이고, 그때 화면에는 얼굴도 별칭도
 * 나오지 않는다. 세션 pin 조회는 메시지가 아니라 세션 단위로 묶이므로 한 세션의 메시지가
 * 몇 개든 요청은 한 번이고, 대신 하한선을 두고 다시 물어 세션 안의 계정 전환을 따라간다.
 */
export function useAccountFace(
  sessionId: string | undefined,
  provider: string | undefined,
  credentialId: number | undefined,
): AccountFace | null {
  const needsPin = Boolean(provider) && !isCredentialId(credentialId) && Boolean(sessionId);

  useEffect(() => {
    if (!needsPin || !sessionId || !provider) return;
    requestSessionPin(sessionId, provider);
  }, [needsPin, sessionId, provider]);

  return useSyncExternalStore(
    subscribe,
    () => resolveAccountFace(sessionId, provider, credentialId),
    () => null,
  );
}
