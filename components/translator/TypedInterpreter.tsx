"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { INTERPRETER_TEXT_MAX_CHARS, INTERPRETER_TEXT_HISTORY_LINES, type InterpreterProfile } from "@/lib/translator-context";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import styles from "./TypedInterpreter.module.css";
import { readInterpreterTextEvents } from "./read-text-stream";

interface Turn { source: TranslatorLanguage; target: TranslatorLanguage; original: string; translation: string }

export function TypedInterpreter({ mine, theirs, profile, visible }: { mine: TranslatorLanguage; theirs: TranslatorLanguage; profile: InterpreterProfile; visible: boolean }) {
  const { tt } = useTranslatorText();
  const [source, setSource] = useState(mine.code);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<"live-auth" | "live-upstream" | null>(null);
  const [provisional, setProvisional] = useState<Turn | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const latest = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const from = source === mine.code ? mine : theirs;
  const to = source === mine.code ? theirs : mine;

  useEffect(() => {
    if (!visible) { requestRef.current?.abort(); requestRef.current = null; setPending(false); setProvisional(null); }
    return () => { requestRef.current?.abort(); requestRef.current = null; };
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
    setProvisional({ source: from, target: to, original, translation: "" });
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
        if (requestRef.current !== controller || controller.signal.aborted) return;
        if (event.type === "delta") {
          setProvisional((previous) => previous ? { ...previous, translation: previous.translation + event.text } : null);
        } else if (event.type === "error") {
          setError(event.error);
        } else {
          if (event.source !== from.code || event.target !== to.code) throw new Error("Invalid translation direction");
          setTurns((previous) => [...previous, { source: from, target: to, original, translation: event.text }].slice(-INTERPRETER_TEXT_HISTORY_LINES / 2));
          setDraft("");
        }
      }
    } catch {
      if (requestRef.current === controller && !controller.signal.aborted) setError("live-upstream");
    } finally {
      if (requestRef.current === controller) { requestRef.current = null; setPending(false); setProvisional(null); textarea.current?.focus(); }
    }
  };

  return <div className={styles.root} hidden={!visible}>
    <div className={styles.results} role="log" aria-label={tt("translator.conversation")}>
      {turns.map((turn, index) => <article className={styles.turn} key={index}>
        <p className={styles.label}>{tt("translator.original")} — {turn.source.nativeName}</p>
        <p className={styles.original} lang={turn.source.tag}>{turn.original}</p>
        <p className={styles.label}>{tt("translator.translation")} — {turn.target.nativeName}</p>
        <p className={styles.translation} lang={turn.target.tag}>{turn.translation}</p>
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
