"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { ScanItem, ScanResult } from "@/lib/interpreter-scan";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { useTranslatorText } from "./i18n";
import { resizeImageToDataUrl } from "./image-resize";
import { SCAN_AVOID_MAX_CHARS, formatTotal, readAvoid, sumPrices, writeAvoid } from "./menu-scan-store";
import styles from "./MenuScan.module.css";
import type { ShowCardContent } from "./ShowCard";

const NO_ITEMS: readonly ScanItem[] = [];

const COPY_KEYS = ["title", "close", "takePhoto", "pickAlbum", "avoidLabel", "avoidPlaceholder", "avoidHint", "pickHint", "loading", "error", "authError", "retry", "empty", "show", "pick", "avoidChanged", "rescan", "warning"] as const;
type Copy = Record<(typeof COPY_KEYS)[number], string>;
type Phase = { name: "pick" } | { name: "loading" } | { name: "result"; result: ScanResult; avoid: string } | { name: "error"; auth: boolean };

interface MenuScanProps {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  onShow: (card: ShowCardContent) => void;
  onClose: () => void;
}

/** 통역 도구줄의 사진 단추 아이콘. */
export function CameraIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8h3l1.6-2.4h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

interface RowProps {
  item: ScanItem;
  index: number;
  checked: boolean;
  copy: Copy;
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  onToggle: (index: number) => void;
  onShow: (item: ScanItem) => void;
}

function ItemRow({ item, index, checked, copy, mine, theirs, onToggle, onShow }: RowProps) {
  return (
    <li className={styles.row} data-warn={item.warning ? "true" : undefined}>
      <label className={styles.pick} title={copy.pick}>
        <input type="checkbox" checked={checked} aria-label={`${copy.pick}: ${item.translation}`} onChange={() => onToggle(index)} />
      </label>
      <div className={styles.main}>
        <span className={styles.translation} lang={mine.tag}>{item.translation}</span>
        <span className={styles.original} lang={theirs.tag}>{item.original}</span>
        {item.description ? <p className={styles.description} lang={mine.tag}>{item.description}</p> : null}
        {item.allergens?.length ? (
          <ul className={styles.tags} lang={mine.tag}>
            {item.allergens.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        ) : null}
        {item.warning ? <p className={styles.warning} role="note" lang={mine.tag}><span className="sr-only">{copy.warning}: </span>{item.warning}</p> : null}
      </div>
      <div className={styles.side}>
        {item.priceText || item.price !== undefined ? <span className={styles.price}>{item.priceText ?? item.price}</span> : null}
        <button type="button" className={styles.show} onClick={() => onShow(item)}>{copy.show}</button>
      </div>
    </li>
  );
}

/**
 * 메뉴판·간판 사진 해설. 사진을 줄여 `/api/live/interpret/scan`에 한 번 보내고, 항목별 번역·설명·알레르기·가격을
 * 보여 준다. 해설은 통역과 따로 도는 덧붙임이라 실패해도 오류 안내와 다시 시도만 있고 통역에는 영향이 없다.
 */
export function MenuScan({ mine, theirs, onShow, onClose }: MenuScanProps) {
  const { tt } = useTranslatorText();
  const copy = useMemo(() => Object.fromEntries(COPY_KEYS.map((key) => [key, tt(`translator.scan.${key}`)])) as Copy, [tt]);
  const [phase, setPhase] = useState<Phase>({ name: "pick" });
  const [avoid, setAvoid] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const imageRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const closedRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closedRef.current = false;
    setAvoid(readAvoid());
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    // 보여주기 카드가 떠 있으면 카드가 먼저 Escape를 받아 멈추므로 여기까지 오지 않는다.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      closedRef.current = true;
      document.removeEventListener("keydown", onKey);
      abortRef.current?.abort();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const run = async (image: string, avoidText: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ name: "loading" });
    setPicked(new Set());
    try {
      const response = await fetch("/api/live/interpret/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, mine: mine.code, theirs: theirs.code, avoid: avoidText.trim() }),
        signal: controller.signal,
      });
      if (!response.ok) {
        setPhase({ name: "error", auth: response.status === 401 });
        return;
      }
      setPhase({ name: "result", result: (await response.json()) as ScanResult, avoid: avoidText });
    } catch {
      if (!controller.signal.aborted) setPhase({ name: "error", auth: false });
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    imageRef.current = null;
    try {
      imageRef.current = await resizeImageToDataUrl(file);
    } catch {
      if (!closedRef.current) setPhase({ name: "error", auth: false });
      return;
    }
    // 줄이는 동안 덮개가 닫혔으면 사진을 보내지 않는다.
    if (closedRef.current) return;
    await run(imageRef.current, avoid);
  };

  const changeAvoid = (value: string) => {
    const next = value.slice(0, SCAN_AVOID_MAX_CHARS);
    setAvoid(next);
    writeAvoid(next);
  };

  const toggle = (index: number) => {
    setPicked((previous) => {
      const next = new Set(previous);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  };

  const show = (item: ScanItem) => onShow({ text: item.original, language: theirs, note: { text: item.translation, language: mine } });

  const items = phase.name === "result" ? phase.result.items : NO_ITEMS;
  const totals = useMemo(() => sumPrices(items, picked), [items, picked]);
  const retryImage = imageRef.current;

  return (
    <div className="translator-phrases" role="dialog" aria-modal="true" aria-labelledby="translator-scan-title">
      <header className="translator-phrases-head">
        <h2 id="translator-scan-title" ref={headingRef} tabIndex={-1}>{copy.title}</h2>
        <button type="button" className="translator-icon-button" aria-label={copy.close} title={copy.close} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className={styles.body}>
        {phase.name === "pick" || phase.name === "result" || phase.name === "error" ? (
          <>
            <div className={styles.pickers}>
              <label className={styles.primary}>
                <CameraIcon />
                {copy.takePhoto}
                <input className={styles.hiddenInput} type="file" accept="image/*" capture="environment" onChange={(event) => void onFile(event)} />
              </label>
              <label className={styles.secondary}>
                {copy.pickAlbum}
                <input className={styles.hiddenInput} type="file" accept="image/*" onChange={(event) => void onFile(event)} />
              </label>
            </div>
            <div className={styles.avoid}>
              <label htmlFor="translator-scan-avoid">{copy.avoidLabel}</label>
              <input id="translator-scan-avoid" type="text" value={avoid} maxLength={SCAN_AVOID_MAX_CHARS} placeholder={copy.avoidPlaceholder} onChange={(event) => changeAvoid(event.target.value)} />
              <p className={styles.hint}>{copy.avoidHint}</p>
            </div>
          </>
        ) : null}
        {phase.name === "pick" ? <p className={styles.hint}>{copy.pickHint}</p> : null}
        {phase.name === "loading" ? <p className={styles.status} role="status" aria-busy="true">{copy.loading}</p> : null}
        {phase.name === "error" ? (
          <div className={styles.error} role="alert">
            <p>{phase.auth ? copy.authError : copy.error}</p>
            {retryImage ? <button type="button" className={styles.secondary} onClick={() => void run(retryImage, avoid)}>{copy.retry}</button> : null}
          </div>
        ) : null}
        {phase.name === "result" ? (
          <>
            {phase.avoid.trim() !== avoid.trim() && retryImage ? (
              <div className={styles.avoid}>
                <p className={styles.hint}>{copy.avoidChanged}</p>
                <button type="button" className={styles.rescan} onClick={() => void run(retryImage, avoid)}>{copy.rescan}</button>
              </div>
            ) : null}
            {phase.result.summary ? <p className={styles.summary} lang={mine.tag}>{phase.result.summary}</p> : null}
            {!phase.result.summary && items.length === 0 ? <p className={styles.status}>{copy.empty}</p> : null}
            {items.length > 0 ? (
              <ul className={styles.list}>
                {items.map((item, index) => (
                  <ItemRow key={`${index}:${item.original}`} item={item} index={index} checked={picked.has(index)} copy={copy} mine={mine} theirs={theirs} onToggle={toggle} onShow={show} />
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </div>
      {phase.name === "result" && picked.size > 0 ? (
        <div className={styles.footer} role="status">
          <span className={styles.footerLabel}>
            {tt("translator.scan.total", { count: totals.count })}
            {totals.missing > 0 ? `, ${tt("translator.scan.missing", { count: totals.missing })}` : ""}
          </span>
          <span className={styles.footerTotal}>{formatTotal(totals.total, phase.result.currency, mine.tag)}</span>
        </div>
      ) : null}
    </div>
  );
}
