"use client";

import { useRef, useState } from "react";
import { type BoardData, type RoutineDraft, readApiError, refreshRoutineBoard, showRoutineScreen } from "./board-store";
import styles from "./RoutineView.module.css";

export function QuickTask({ data, formatSchedule }: { data: BoardData; formatSchedule: (draft: RoutineDraft) => string }) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<RoutineDraft | null>(null);
  const [oneOff, setOneOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const drafting = useRef(false);
  const saving = useRef(false);
  const generate = async () => {
    if (!text.trim() || drafting.current || busy) return;
    drafting.current = true;
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const res = await fetch("/api/routines/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text.trim() }) });
      if (!res.ok) throw new Error(`${res.status === 502 ? "요청을 처리하지 못했습니다(502). " : ""}${await readApiError(res)}`);
      const result = await res.json() as { draft: RoutineDraft; oneOff: boolean };
      setDraft(result.draft);
      setOneOff(result.oneOff);
      setSavedId(null);
      requestAnimationFrame(() => nameInput.current?.focus());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); drafting.current = false; }
  };
  const save = async () => {
    if (!draft || busy || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    let id = savedId;
    try {
      if (!id) {
        const res = await fetch("/api/routines", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
        if (!res.ok) throw new Error(await readApiError(res));
        const created: { routine: { id: string } } = await res.json();
        id = created.routine.id;
        setSavedId(id);
      }
      if (oneOff && draft.host === data.thisHost) {
        const res = await fetch(`/api/routines/${encodeURIComponent(id)}/run`, { method: "POST" });
        if (!res.ok) throw new Error(`저장은 완료되었지만 실행을 시작하지 못했습니다. 다시 실행해 주세요. ${await readApiError(res)}`);
      }
      setMessage(oneOff ? draft.host === data.thisHost ? "실행을 시작했습니다." : `${draft.host} PC가 켜져 있으면 동기화 후 약 10분 안에 시작합니다.` : "저장했습니다.");
      setDraft(null);
      setText("");
      await refreshRoutineBoard(true);
      setSavedId(null);
      showRoutineScreen({ kind: "board", id });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); await refreshRoutineBoard(true); }
    finally { setBusy(false); saving.current = false; }
  };
  return (
    <section className={styles.quickTask} aria-label="새 일 맡기기">
      <form className={styles.taskInput} onSubmit={(e) => { e.preventDefault(); void generate(); }}>
        <label htmlFor="routine-task">새 일 맡기기</label>
        <textarea id="routine-task" rows={2} maxLength={8000} value={text} disabled={busy || !!savedId} placeholder={"매일 아침 8시에 환율 알려줘\n지금 한 번 오늘 공모주 일정 찾아줘"} aria-describedby="routine-task-hint" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void generate(); }
        }} />
        <div className={styles.composerActions}><span id="routine-task-hint" className={styles.hint}>Enter로 보내기, Shift+Enter로 줄바꿈</span><button className={styles.button} type="submit" data-variant="primary" disabled={busy || !text.trim() || !!savedId}>{busy && !draft ? "초안을 만들고 있습니다." : "새 일 맡기기"}</button></div>
      </form>
      {draft ? <form className={styles.draft} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <h2>초안 확인</h2>
        <fieldset disabled={busy || !!savedId} className={styles.draftFields}>
          <label className={styles.field}>이름<input ref={nameInput} type="text" required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
          <div className={styles.draftMeta}><span>일정: {formatSchedule(draft)}</span><label className={styles.field}>실행 위치<select value={draft.host} onChange={(e) => setDraft({ ...draft, host: e.target.value })}>{[...new Set([...data.hosts, data.thisHost, draft.host])].map((host) => <option key={host} value={host}>{host}</option>)}</select></label></div>
          <label className={styles.field}>요청 내용<textarea required value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} /></label>
        </fieldset>
        {oneOff && draft.host !== data.thisHost ? <p className={styles.hint}>{draft.host} PC가 켜져 있으면 동기화 후 약 10분 안에 시작합니다.</p> : null}
        <div className={styles.composerActions}>
          <button type="button" className={styles.button} disabled={busy} onClick={() => { setDraft(null); if (savedId) setText(""); setSavedId(null); setError(null); }}>취소</button>
          {!savedId ? <button type="button" className={styles.button} disabled={busy} onClick={() => showRoutineScreen({ kind: "form", id: null, draft, oneOff })}>폼으로 자세히</button> : null}
          <button type="submit" className={styles.button} data-variant="primary" disabled={busy}>{busy ? "저장하고 있습니다." : savedId ? "다시 실행" : oneOff ? "지금 한 번 실행" : "저장"}</button>
        </div>
      </form> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.hint} role="status">{message}</p> : null}
    </section>
  );
}
