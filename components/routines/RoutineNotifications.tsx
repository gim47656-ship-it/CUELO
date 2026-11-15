"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readApiError } from "./board-store";
import styles from "./RoutineView.module.css";

type PushState = { on: boolean; browser: boolean; blocked: string | null; known: boolean };
function unavailable(): string | null {
  if (!window.isSecureContext) return "보안 연결(HTTPS)에서만 알림을 켤 수 있습니다.";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && !window.matchMedia("(display-mode: standalone)").matches && !("standalone" in navigator && navigator.standalone)) return "iOS에서는 홈 화면에 추가한 뒤 알림을 켤 수 있습니다.";
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return "이 브라우저에서는 알림을 지원하지 않습니다.";
  return null;
}
export function RoutineNotifications({ requestPermission }: { requestPermission: () => Promise<NotificationPermission | null> }) {
  const [state, setState] = useState<PushState>({ on: false, browser: false, blocked: null, known: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const inspect = useCallback(async (clearError = true) => {
    const blocked = unavailable();
    if (blocked) { setState({ on: false, browser: false, blocked, known: true }); if (clearError) setError(null); return; }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      let subscribed = false;
      if (subscription) {
        const res = await fetch(`/api/push/subscriptions?endpoint=${encodeURIComponent(subscription.endpoint)}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await readApiError(res));
        const body: { subscribed: boolean } = await res.json();
        subscribed = body.subscribed;
      }
      setState({ on: !!subscription && subscribed && Notification.permission === "granted", browser: !!subscription, known: true, blocked: Notification.permission === "denied" ? "알림 권한이 차단되어 있습니다. 브라우저 사이트 설정에서 알림을 허용해 주세요." : null });
      if (clearError) setError(null);
    } catch (e) {
      setState((previous) => ({ ...previous, known: false }));
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void inspect();
    const refresh = () => { if (!working.current) void inspect(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [inspect]);
  const change = async (turnOn: boolean) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      if (turnOn && await requestPermission() !== "granted") { await inspect(); return; }
      const registration = await navigator.serviceWorker.getRegistration() ?? await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!turnOn) {
        if (subscription) {
          const res = await fetch("/api/push/subscriptions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
          if (!res.ok) throw new Error(await readApiError(res));
          await subscription.unsubscribe();
        }
      } else {
        if (!subscription) {
          const res = await fetch("/api/push/public-key", { cache: "no-store" });
          if (!res.ok) throw new Error(await readApiError(res));
          const body: { publicKey: string } = await res.json();
          const raw = atob(body.publicKey.replace(/-/g, "+").replace(/_/g, "/"));
          const key = Uint8Array.from(raw, (char) => char.charCodeAt(0));
          subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
        const res = await fetch("/api/push/subscriptions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: subscription.toJSON() }) });
        if (!res.ok) throw new Error(await readApiError(res));
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { await inspect(false); setBusy(false); working.current = false; }
  };
  return <section className={styles.notifications} aria-label="이 기기에서 알림 받기">
    <div className={styles.notificationRow}>
      <button type="button" role="switch" aria-checked={state.on} aria-describedby="routine-push-hint routine-push-state" className={styles.pushSwitch} disabled={busy || !!state.blocked || !state.known} onClick={() => void change(!state.on)}><span className={styles.switchTrack} data-on={state.on}><span /></span>이 기기에서 알림 받기</button>
      <span id="routine-push-state" className={styles.hint} role="status">{busy ? "설정을 변경하고 있습니다." : !state.known ? "일부 상태를 확인할 수 없습니다." : state.on ? "켜짐" : "꺼짐"}</span>
    </div>
    <p id="routine-push-hint" className={state.blocked ? styles.notice : styles.hint} role={state.blocked ? "status" : undefined}>{state.blocked ?? "이 기기와 현재 CUELO 주소에만 적용됩니다."}</p>
    {state.known && state.browser && !state.on && !state.blocked ? <div className={styles.composerActions}><p className={styles.hint}>브라우저 알림 구독은 유지되어 있으나 서버 알림 설정이 꺼져 있습니다.</p><button type="button" className={styles.button} disabled={busy} onClick={() => void change(false)}>취소</button></div> : null}
    {error ? <div className={styles.error} role="alert">{error}<div className={styles.composerActions}><button type="button" className={styles.button} disabled={busy} onClick={() => { setError(null); void inspect(); }}>다시 확인</button></div></div> : null}
  </section>;
}
