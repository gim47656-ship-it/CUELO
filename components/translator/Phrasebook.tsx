"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import {
  BUILT_IN_PHRASES,
  CUSTOM_PHRASE_MAX,
  CUSTOM_PHRASE_MAX_CHARS,
  PHRASEBOOK_KEY,
  PHRASE_GROUPS,
  builtInText,
  createLimiter,
  phraseCacheKey,
  readPhrasebook,
  withCached,
  type PhrasebookData,
} from "./phrase-store";
import { readInterpreterTextEvents } from "./read-text-stream";
import type { ShowCardContent } from "./ShowCard";

/** 「모두 미리 번역」이 한꺼번에 보내는 요청 수. */
const TRANSLATE_CONCURRENCY = 2;

/** 문장 하나를 내 언어에서 상대 언어로 옮긴다. 타자 통역과 같은 구독 경로(`/api/live/interpret/text`)다. */
async function translatePhrase(text: string, mine: TranslatorLanguage, theirs: TranslatorLanguage, signal: AbortSignal): Promise<string> {
  const response = await fetch("/api/live/interpret/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ mine: mine.code, theirs: theirs.code, source: mine.code, text }),
  });
  if (!response.ok || !response.body) throw new Error(`translate ${response.status}`);
  for await (const event of readInterpreterTextEvents(response.body)) {
    if (event.type === "error") throw new Error(event.error);
    // 다른 방향으로 옮긴 결과는 이 문장의 번역으로 저장하지 않는다(다시 시도할 수 있게 실패로 남긴다).
    if (event.type === "done") {
      if (event.source !== mine.code || event.target !== theirs.code) throw new Error("translate: wrong direction");
      if (event.text.trim()) return event.text.trim();
    }
  }
  throw new Error("translate: no result");
}

function readStored(): PhrasebookData {
  try {
    return readPhrasebook(window.localStorage.getItem(PHRASEBOOK_KEY));
  } catch {
    return readPhrasebook(null);
  }
}

interface Row {
  key: string;
  text: string;
  customId?: string;
}

interface PhrasebookProps {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  onShow: (card: ShowCardContent) => void;
  onClose: () => void;
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * 자주 쓰는 문장. 옮겨 둔 문장은 서버 없이 바로 카드로 띄우고, 아직 옮기지 않은 문장은 누르면 옮긴다.
 * 「모두 미리 번역」으로 데이터가 끊기기 전에 한꺼번에 옮겨 둘 수 있다.
 */
export function Phrasebook({ mine, theirs, onShow, onClose }: PhrasebookProps) {
  const { tt } = useTranslatorText();
  const [data, setData] = useState(readStored);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const [draft, setDraft] = useState("");
  const abortRef = useRef(new AbortController());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const limitRef = useRef(createLimiter(TRANSLATE_CONCURRENCY));
  /** 진행 중인 번역. 같은 문장을 두 번 보내지 않고 기다리던 쪽이 같은 결과를 받는다. */
  const inflightRef = useRef(new Map<string, Promise<string | null>>());
  const dataRef = useRef(data);
  dataRef.current = data;

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    // 카드가 떠 있으면 카드가 앞 단계에서 Escape를 받아 멈추므로 여기까지 오지 않는다.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      controller.abort();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PHRASEBOOK_KEY, JSON.stringify(data));
    } catch {
      // Storage full or blocked: phrases still work for this visit.
    }
  }, [data]);

  const groups = useMemo(() => PHRASE_GROUPS.map((group) => ({
    group,
    rows: BUILT_IN_PHRASES[group].flatMap((phrase): Row[] => {
      const text = builtInText(phrase, mine.code);
      return text ? [{ key: phraseCacheKey(text, mine.code, theirs.code), text }] : [];
    }),
  })).filter(({ rows }) => rows.length > 0), [mine.code, theirs.code]);
  const customRows = useMemo(() => data.custom
    .filter((phrase) => phrase.lang === mine.code)
    .map((phrase): Row => ({ key: phraseCacheKey(phrase.text, mine.code, theirs.code), text: phrase.text, customId: phrase.id })), [data.custom, mine.code, theirs.code]);
  const allRows = useMemo(() => [...groups.flatMap(({ rows }) => rows), ...customRows], [customRows, groups]);
  const uncached = allRows.filter((row) => !data.cache[row.key]);

  const translate = (row: Row): Promise<string | null> => {
    const cached = dataRef.current.cache[row.key];
    if (cached) return Promise.resolve(cached);
    const running = inflightRef.current.get(row.key);
    if (running) return running;
    const signal = abortRef.current.signal;
    setPending((previous) => new Set(previous).add(row.key));
    setFailed((previous) => {
      const next = new Set(previous);
      next.delete(row.key);
      return next;
    });
    const work = limitRef.current(async () => {
      try {
        const translation = await translatePhrase(row.text, mine, theirs, signal);
        setData((previous) => withCached(previous, row.key, translation));
        return translation;
      } catch {
        if (!signal.aborted) setFailed((previous) => new Set(previous).add(row.key));
        return null;
      } finally {
        inflightRef.current.delete(row.key);
        if (!signal.aborted) {
          setPending((previous) => {
            const next = new Set(previous);
            next.delete(row.key);
            return next;
          });
        }
      }
    });
    inflightRef.current.set(row.key, work);
    return work;
  };

  // 카드는 번역해 둔 문장을 누를 때만 연다. 번역을 기다렸다가 저절로 열면 그 기록 칸이 탭 없이 생겨
  // 폰 Chrome의 뒤로가기 키가 그 칸을 건너뛰고 아래 덮개까지 함께 닫는다(11-16 폰 실측). 번역 전
  // 문장은 눌러서 번역만 하고, 줄에 결과가 보이면 한 번 더 눌러 연다.
  const open = (row: Row) => {
    const cached = dataRef.current.cache[row.key];
    if (cached) {
      onShow({ text: cached, language: theirs, note: { text: row.text, language: mine } });
      return;
    }
    void translate(row);
  };

  const translateAll = async () => {
    setBulk(true);
    const keys = new Set<string>();
    const targets = uncached.filter((row) => !keys.has(row.key) && keys.add(row.key));
    await Promise.all(targets.map(translate));
    if (!abortRef.current.signal.aborted) setBulk(false);
  };

  const addPhrase = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim().slice(0, CUSTOM_PHRASE_MAX_CHARS);
    if (!text) return;
    setData((previous) => previous.custom.some((phrase) => phrase.lang === mine.code && phrase.text === text)
      ? previous
      : { ...previous, custom: [...previous.custom, { id: `${Date.now().toString(36)}-${previous.custom.length}`, text, lang: mine.code }].slice(-CUSTOM_PHRASE_MAX) });
    setDraft("");
  };

  const removePhrase = (id: string) => {
    setData((previous) => ({ ...previous, custom: previous.custom.filter((phrase) => phrase.id !== id) }));
  };

  const renderRow = (row: Row) => {
    const translation = data.cache[row.key];
    const busy = pending.has(row.key);
    const state = translation ? undefined : busy ? "pending" : failed.has(row.key) ? "failed" : "uncached";
    const customId = row.customId;
    return (
      <li key={row.key} className="translator-phrase-item">
        <button type="button" className="translator-phrase" data-state={state} aria-busy={busy || undefined} onClick={() => open(row)}>
          <span className="translator-phrase-source" lang={mine.tag}>{row.text}</span>
          <span className="translator-phrase-target" lang={translation ? theirs.tag : undefined}>
            {translation ?? (busy ? tt("translator.typePending") : failed.has(row.key) ? tt("translator.phraseFailed") : tt("translator.phraseNotCached"))}
          </span>
        </button>
        {customId ? (
          <button
            type="button"
            className="translator-icon-button translator-phrase-delete"
            aria-label={tt("translator.phraseDelete", { text: row.text })}
            title={tt("translator.phraseDelete", { text: row.text })}
            onClick={() => removePhrase(customId)}
          >
            <CloseIcon />
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <div className="translator-phrases" role="dialog" aria-modal="true" aria-labelledby="translator-phrases-title">
      <header className="translator-phrases-head">
        <h2 id="translator-phrases-title" ref={headingRef} tabIndex={-1}>{tt("translator.phrases")}</h2>
        <span className="translator-phrases-pair">
          <span lang={mine.tag}>{mine.nativeName}</span>
          <span aria-hidden="true"> → </span>
          <span lang={theirs.tag}>{theirs.nativeName}</span>
        </span>
        <button type="button" className="translator-icon-button" aria-label={tt("translator.phrasesClose")} title={tt("translator.phrasesClose")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="translator-phrases-body">
        <div className="translator-phrases-sync">
          {uncached.length > 0 ? (
            <button type="button" className="translator-phrases-all" data-focus-halo disabled={bulk} aria-busy={bulk || undefined} onClick={() => void translateAll()}>
              {bulk ? tt("translator.typePending") : tt("translator.phrasesTranslateAll")}
            </button>
          ) : null}
          <p className="translator-phrases-status" role="status" aria-live="polite">
            {uncached.length > 0 ? tt("translator.phrasesRemaining", { count: String(uncached.length) }) : tt("translator.phrasesAllCached")}
          </p>
        </div>
        {groups.length === 0 ? <p className="translator-phrases-note">{tt("translator.phrasesNoBuiltIn")}</p> : null}
        {groups.map(({ group, rows }) => (
          <section key={group} className="translator-phrase-group" aria-labelledby={`translator-phrases-${group}`}>
            <h3 id={`translator-phrases-${group}`}>{tt(`translator.phrases.${group}`)}</h3>
            <ul>{rows.map(renderRow)}</ul>
          </section>
        ))}
        <section className="translator-phrase-group" aria-labelledby="translator-phrases-mine">
          <h3 id="translator-phrases-mine">{tt("translator.phrasesMine")}</h3>
          {customRows.length > 0 ? <ul>{customRows.map(renderRow)}</ul> : null}
          <form className="translator-phrase-add" onSubmit={addPhrase}>
            <label>
              <span className="sr-only">{tt("translator.phraseAddLabel")}</span>
              <input
                type="text"
                value={draft}
                lang={mine.tag}
                maxLength={CUSTOM_PHRASE_MAX_CHARS}
                placeholder={tt("translator.phraseAddPlaceholder")}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <button type="submit" disabled={!draft.trim()}>{tt("translator.phraseAdd")}</button>
          </form>
        </section>
      </div>
    </div>
  );
}
