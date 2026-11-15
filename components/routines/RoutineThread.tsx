"use client";

import { useRef, useState, type ReactNode } from "react";
import type { RoutineReply, RoutineThreadState } from "@/lib/routines/reply";
import { readApiError, refreshRoutineBoard } from "./board-store";
import styles from "./RoutineView.module.css";

function relativeTime(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / 1440)}일 전`;
}
export function RoutineThread({ id, file, host, thisHost, thread, replies, onReply, renderBody }: {
  id: string; file: string; host: string; thisHost: string; thread: RoutineThreadState; replies: RoutineReply[];
  onReply: (reply: RoutineReply) => void; renderBody: (body: string) => ReactNode;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const pending = thread === "pending";
  const waiting = thread === "waiting";
  const send = async () => {
    if (!body.trim() || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/routines/${encodeURIComponent(id)}/posts/${encodeURIComponent(file)}/replies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: body.trim() }) });
      if (!res.ok) throw new Error(await readApiError(res));
      const result: { reply: RoutineReply } = await res.json();
      onReply(result.reply);
      setBody("");
      await refreshRoutineBoard(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); sending.current = false; }
  };
  return <section className={styles.thread} aria-labelledby="routine-thread-title">
    <h3 id="routine-thread-title">답장 <span className={styles.hint}>{replies.length}개</span> {waiting ? <span className={styles.badge} data-status="waiting">답 필요</span> : null}</h3>
    {replies.length ? <ol className={styles.replies}>{replies.map((reply) => <li key={reply.file} data-author={reply.author}>
      <div className={styles.replyMeta}><strong>{reply.author === "user" ? "나" : "루틴"}</strong><span>{reply.host}</span><time dateTime={reply.createdAt} title={new Date(reply.createdAt).toLocaleString()}>{relativeTime(reply.createdAt)}</time>{reply.status && reply.status !== "ok" && (reply.status !== "waiting" || (waiting && reply === replies.at(-1))) ? <span className={styles.badge} data-status={reply.status}>{reply.status === "waiting" ? "답 필요" : reply.status === "failed" ? "실패" : "시간 초과"}</span> : null}</div>
      {renderBody(reply.body)}
    </li>)}</ol> : <p className={styles.hint}>아직 대화가 없습니다.</p>}
    {pending ? <p className={styles.pending} role="status">{host}에서 이어서 처리 중{host !== thisHost ? <span className={styles.hint}>원격 처리는 PC가 켜져 있어야 이어집니다.</span> : null}</p> : null}
    <form className={styles.taskInput} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label htmlFor="routine-reply">답장</label>
      <textarea id="routine-reply" rows={3} maxLength={8000} value={body} disabled={busy} aria-describedby="routine-reply-hint" onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
      <div className={styles.composerActions}><span id="routine-reply-hint" className={styles.hint}>Ctrl+Enter 또는 Cmd+Enter로 답장</span><button className={styles.button} type="submit" data-variant="primary" disabled={busy || !body.trim()}>{busy ? "답장을 보내고 있습니다." : "답장"}</button></div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </form>
  </section>;
}
