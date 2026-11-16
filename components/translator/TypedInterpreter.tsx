"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { INTERPRETER_TEXT_MAX_CHARS, INTERPRETER_TEXT_HISTORY_LINES, type InterpreterProfile } from "@/lib/translator-context";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import styles from "./TypedInterpreter.module.css";
import { readInterpreterTextEvents } from "./read-text-stream";
import { LineAssist } from "./LineAssist";
import { useLineAssist, type AssistSettings } from "./useLineAssist";
import type { ShowCardContent } from "./ShowCard";
import { hasNumericMismatch } from "@/lib/translator-numbers";

interface Turn { id: number; source: TranslatorLanguage; target: TranslatorLanguage; original: string; translation: string; /** Hangul reading of a ja/th/vi translation; display only. */ reading?: string }

export function TypedInterpreter({ mine, theirs, profile, visible, assistSettings, onShow }: { mine: TranslatorLanguage; theirs: TranslatorLanguage; profile: InterpreterProfile; visible: boolean; assistSettings: AssistSettings; onShow: (card: ShowCardContent) => void }) {
  const { tt } = useTranslatorText();
  const [source, setSource] = useState(mine.code);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"live-auth" | "live-upstream" | null>(null);
  const [provisional, setProvisional] = useState<Turn | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  /** Requests whose line is already committed and only the Hangul reading is still arriving. */
  const readingRef = useRef(new Set<AbortController>());
  const nextTurn = useRef(0);
  const composing = useRef(false);
  const latest = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const from = source === mine.code ? mine : theirs;
  const to = source === mine.code ? theirs : mine;
  // The other person's lines need no interpretation for replies or nuance, so their help starts the moment
  // the line is sent, under the same key the committed turn keeps. My lines wait for the interpretation to check.
  const assistLine = (id: number, source: TranslatorLanguage, original: string, translation?: string) => {
    const speaker = source.code === mine.code ? "mine" as const : "theirs" as const;
    return { id: String(id), mine: mine.code, theirs: theirs.code, speaker, text: original, ...(speaker === "mine" ? { interpretation: translation } : {}) };
  };
  const assistLines = [
    ...turns.map((turn) => assistLine(turn.id, turn.source, turn.original, turn.translation)),
    ...(provisional && provisional.source.code === theirs.code ? [assistLine(provisional.id, provisional.source, provisional.original)] : []),
  ];
  const assists = useLineAssist(assistLines, assistSettings, { profile, history: turns.flatMap((turn) => [{ role: "user" as const, text: turn.original }, { role: "assistant" as const, text: turn.translation }]).slice(-INTERPRETER_TEXT_HISTORY_LINES) }, visible);
  const latestOther = assistLines.findLast((line) => line.speaker === "theirs")?.id;

  useEffect(() => {
    const stopReadings = () => { for (const reading of readingRef.current) reading.abort(); readingRef.current.clear(); };
    if (!visible) { requestRef.current?.abort(); requestRef.current = null; stopReadings(); setPending(false); setProvisional(null); }
    return () => { requestRef.current?.abort(); requestRef.current = null; stopReadings(); };
  }, [visible]);
  useEffect(() => { if (visible) latest.current?.scrollIntoView({ block: "nearest" }); }, [turns, visible, provisional?.translation]);

  const changeDirection = (code: string) => {
    requestRef.current?.abort(); requestRef.current = null;
    setPending(false); setProvisional(null); setError(null); setSource(code);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (composing.current || requestRef.current || !draft.trim()) return;
    const controller = new AbortController(); requestRef.current = controller;
    setPending(true); setError(null);
    const original = draft.trim();
    setProvisional({ id: nextTurn.current, source: from, target: to, original, translation: "" });
    // Set once the translation is committed; the Hangul reading may still follow and is attached later.
    let committed: number | null = null;
    try {
      const response = await fetch("/api/live/interpret/text", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ mine: mine.code, theirs: theirs.code, source: from.code, profile, text: original,
          history: turns.flatMap((turn) => [{ role: "user", text: turn.original }, { role: "assistant", text: turn.translation }]).slice(-INTERPRETER_TEXT_HISTORY_LINES) }),
      });
      if (!response.ok) {
        const failure = await response.json();
        if (requestRef.current === controller && !controller.signal.aborted) setError(failure.error === "live-auth" ? "live-auth" : "live-upstream");
        return;
      }
      if (!response.body || !response.headers.get("Content-Type")?.includes("text/event-stream")) throw new Error("Invalid translation response");
      for await (const event of readInterpreterTextEvents(response.body)) {
        // After the commit this request no longer owns the form; only leaving the screen (abort) stops the reading.
        if (controller.signal.aborted || (committed === null && requestRef.current !== controller)) return;
        if (event.type === "delta") {
          if (committed === null) setProvisional((previous) => previous ? { ...previous, translation: previous.translation + event.text } : null);
        } else if (event.type === "error") {
          if (committed === null) setError(event.error);
        } else {
          if (event.source !== from.code || event.target !== to.code) throw new Error("Invalid translation direction");
          const reading = event.type === "done" ? event.reading : undefined;
          if (committed === null) {
            const id = nextTurn.current++;
            committed = id;
            setTurns((previous) => [...previous, { id, source: from, target: to, original, translation: event.text, ...(reading ? { reading } : {}) }].slice(-INTERPRETER_TEXT_HISTORY_LINES / 2));
            setProvisional(null);
            setDraft("");
            // The form is free for the next line while the Hangul reading is still on its way.
            readingRef.current.add(controller);
            requestRef.current = null; setPending(false); textarea.current?.focus();
          } else if (reading) {
            const id = committed;
            setTurns((previous) => previous.map((turn) => turn.id === id ? { ...turn, reading } : turn));
          }
        }
      }
    } catch {
      // A failure after the translation was committed only loses the optional reading.
      if (requestRef.current === controller && !controller.signal.aborted && committed === null) setError("live-upstream");
    } finally {
      readingRef.current.delete(controller);
      if (requestRef.current === controller) { requestRef.current = null; setPending(false); setProvisional(null); textarea.current?.focus(); }
    }
  };

  return <div className={styles.root} hidden={!visible}>
    <div className={styles.results} role="log" aria-label={tt("translator.conversation")}>
      {turns.map((turn) => <article className={styles.turn} key={turn.id}>
        <p className={styles.label}>{tt("translator.original")} — {turn.source.nativeName}</p>
        <p className={styles.original} lang={turn.source.tag}>{turn.original}</p>
        <p className={styles.label}>{tt("translator.translation")} — {turn.target.nativeName}</p>
        <p className={styles.translation} lang={turn.target.tag}>{turn.translation}</p>
        {turn.reading ? <p className={styles.reading} lang="ko">{turn.reading}</p> : null}
        <LineAssist result={assists.get(String(turn.id))} showReplies={assistSettings.replies && String(turn.id) === latestOther}
          meaning={assistSettings.meaning} numericMismatch={assistSettings.meaning && turn.source.code === mine.code && hasNumericMismatch(turn.original, turn.translation)}
          mine={mine} theirs={theirs} onShow={onShow} />
      </article>)}
      {provisional ? <article className={styles.turn} aria-busy="true">
        <p className={styles.label}>{tt("translator.original")} — {provisional.source.nativeName}</p>
        <p className={styles.original} lang={provisional.source.tag}>{provisional.original}</p>
        <p className={styles.label}>{tt("translator.typePending")} — {provisional.target.nativeName}</p>
        <p className={styles.translation} lang={provisional.target.tag}>{provisional.translation}</p>
      </article> : null}
      <div ref={latest} />
    </div>
    <form className={styles.composer} onSubmit={submit}>
      <div className={styles.direction}>
        <label>{tt("translator.source")}<select value={source} onChange={(event) => changeDirection(event.target.value)}>
          <option value={mine.code}>{mine.nativeName}</option><option value={theirs.code}>{theirs.nativeName}</option>
        </select></label>
        <button type="button" onClick={() => changeDirection(to.code)}>{tt("translator.swapDirection")}</button>
        <span aria-live="polite">→ {to.nativeName}</span>
      </div>
      <label className={styles.field}>{tt("translator.typeLabel")}
        <textarea ref={textarea} value={draft} lang={from.tag} maxLength={INTERPRETER_TEXT_MAX_CHARS} rows={3} readOnly={pending} aria-busy={pending}
          placeholder={tt("translator.typePlaceholder")} onChange={(event) => setDraft(event.target.value)}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} />
      </label>
      {error ? <p className={styles.error} role="alert">{tt(error === "live-auth" ? "translator.typeAuth" : "translator.typeError")}</p> : null}
      <button className={styles.submit} type="submit" data-focus-halo disabled={pending || !draft.trim()}>{tt(pending ? "translator.typePending" : "translator.typeSubmit")}</button>
    </form>
  </div>;
}
