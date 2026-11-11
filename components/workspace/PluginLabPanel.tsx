"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionButton, Switch } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import type { LabPlugin } from "@/lib/plugin-lab";
import type { ExtensionWidgetItem } from "@/lib/types";
import { PanelHeader } from "./PanelHeader";
import { LAB_PANEL_SANDBOX, createLabPanelHost, labLinesFor, type LabPanelTheme } from "./plugin-lab-bridge";
import styles from "./PluginLabPanel.module.css";

const OPEN_PANEL_KEY = "cuelo-plugin-lab-open";
const API = "/api/plugin-lab";

const REFRESH_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" />
  </svg>
);

type ListState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; plugins: LabPlugin[] };

/** What ChatWindow reported last: its session's `lab:` widgets. */
export interface LabWidgetReport {
  sessionId: string | null;
  widgets: readonly ExtensionWidgetItem[];
}

export interface PluginLabPanelProps {
  title: string;
  /** Only the visible view fetches; the list loads again each time the view opens. */
  visible: boolean;
  sessionId: string | null;
  /** The `lab:` widgets ChatWindow last reported, with the session they belong to. */
  labWidgets: LabWidgetReport;
  /** Puts text into the message box without sending it. Absent while no conversation is open. */
  onInsertDraft?: (text: string) => void;
}

function readOpenPanel(): string | null {
  try {
    return window.localStorage.getItem(OPEN_PANEL_KEY);
  } catch {
    return null;
  }
}

function writeOpenPanel(id: string | null) {
  try {
    if (id) window.localStorage.setItem(OPEN_PANEL_KEY, id);
    else window.localStorage.removeItem(OPEN_PANEL_KEY);
  } catch {
    // Storage off: the open panel just does not survive a reload.
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON: fall back to the status line.
  }
  return `HTTP ${response.status}`;
}

/** A panel that can run: it has a panel file and is switched on. */
function canOpenPanel(plugin: LabPlugin): boolean {
  return plugin.hasPanel && plugin.enabled;
}

// One formatter per locale: `Intl.DateTimeFormat` construction is the cost, and a locale switches rarely.
const enhancementDateFormats = new Map<string, Intl.DateTimeFormat>();

/** The manifest states a date-time; the card shows the calendar day it fell on in the reader's locale. */
function formatEnhancementDate(at: string, locale: string): string {
  let format = enhancementDateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
    enhancementDateFormats.set(locale, format);
  }
  return format.format(new Date(at));
}

export function PluginLabPanel({ title, visible, sessionId, labWidgets, onInsertDraft }: PluginLabPanelProps) {
  const { t } = useI18n();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string | null>>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const loadSeq = useRef(0);

  useEffect(() => {
    setOpenId(readOpenPanel());
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setList((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    try {
      const response = await fetch(API, { cache: "no-store" });
      if (!response.ok) throw new Error(await errorText(response));
      const body = await response.json() as { plugins?: LabPlugin[] };
      if (seq === loadSeq.current) setList({ kind: "ready", plugins: body.plugins ?? [] });
    } catch (error) {
      if (seq === loadSeq.current) setList({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const setEnabled = useCallback(async (plugin: LabPlugin, enabled: boolean) => {
    setPending((current) => new Set(current).add(plugin.id));
    setRowErrors((current) => ({ ...current, [plugin.id]: null }));
    try {
      const response = await fetch(`${API}/${encodeURIComponent(plugin.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const body = await response.json() as { plugin: LabPlugin };
      setList((current) => current.kind === "ready"
        ? { kind: "ready", plugins: current.plugins.map((item) => (item.id === body.plugin.id ? body.plugin : item)) }
        : current);
      // Read the list again: a list request still in flight was answered before this change.
      void load();
    } catch (error) {
      setRowErrors((current) => ({ ...current, [plugin.id]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(plugin.id);
        return next;
      });
    }
  }, [load]);

  const openPanel = useCallback((id: string | null) => {
    setOpenId(id);
    writeOpenPanel(id);
  }, []);

  const plugins = list.kind === "ready" ? list.plugins : [];
  const openPlugin = openId ? plugins.find((plugin) => plugin.id === openId && canOpenPanel(plugin)) ?? null : null;

  if (openPlugin) {
    return (
      <PluginPanelHost
        plugin={openPlugin}
        sessionId={sessionId}
        labWidgets={labWidgets}
        onInsertDraft={onInsertDraft}
        onBack={() => openPanel(null)}
      />
    );
  }

  const showApplyHint = plugins.some((plugin) => plugin.hasExtension);

  return (
    <section className={styles.view} aria-label={title}>
      <PanelHeader
        title={title}
        subtitle={list.kind === "ready" ? t("pluginLab.counts", { count: plugins.length }) : undefined}
        actions={[{ id: "refresh", label: t("pluginLab.refresh"), icon: REFRESH_ICON, onClick: () => void load() }]}
      />
      <div className={styles.toolbar}>
        <ActionButton
          variant="neutralWeak"
          size="small"
          disabled={!onInsertDraft}
          onClick={() => onInsertDraft?.(t("pluginLab.starter"))}
          title={onInsertDraft ? t("pluginLab.createHint") : t("pluginLab.noComposer")}
        >
          {t("pluginLab.create")}
        </ActionButton>
        {showApplyHint && <p className={styles.hint}>{t("pluginLab.applyHint")}</p>}
      </div>
      <div className={styles.body}>
        {list.kind === "loading" && <p className={styles.message} role="status">{t("pluginLab.loading")}</p>}
        {list.kind === "error" && (
          <div className={styles.message} role="alert">
            <p className={styles.errorText}>{t("pluginLab.loadFailed", { error: list.message })}</p>
            <ActionButton variant="neutralWeak" size="small" onClick={() => void load()}>{t("pluginLab.retry")}</ActionButton>
          </div>
        )}
        {list.kind === "ready" && plugins.length === 0 && <p className={styles.message}>{t("pluginLab.empty")}</p>}
        {list.kind === "ready" && plugins.length > 0 && (
          <ul className={styles.list} aria-label={t("pluginLab.listLabel")}>
            {plugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                busy={pending.has(plugin.id)}
                error={rowErrors[plugin.id] ?? null}
                onToggle={(enabled) => void setEnabled(plugin, enabled)}
                onOpen={() => openPanel(plugin.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function PluginRow({ plugin, busy, error, onToggle, onOpen }: {
  plugin: LabPlugin;
  busy: boolean;
  error: string | null;
  onToggle: (enabled: boolean) => void;
  onOpen: () => void;
}) {
  const { t, locale } = useI18n();
  const active = plugin.enabled;
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const enhancements = useMemo(() => [...(plugin.enhancements ?? [])].reverse(), [plugin.enhancements]);
  return (
    <li className={styles.card} data-enabled={active ? "true" : "false"} aria-busy={busy || undefined}>
      <div className={styles.cardHead}>
        <div className={styles.titleBlock}>
          <div className={styles.titleLine}>
            <span className={styles.name} title={plugin.name}>{plugin.name}</span>
          </div>
          <span className={styles.id} title={plugin.id}>{plugin.id}</span>
        </div>
        <div className={styles.control}>
          <Switch.Root
            className={styles.switch}
            size="24"
            tone="brand"
            checked={plugin.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={t("pluginLab.toggleLabel", { name: plugin.name })}
          >
            <Switch.HiddenInput />
            <Switch.Label className={styles.switchLabel}>
              {busy ? t("pluginLab.saving") : plugin.enabled ? t("pluginLab.on") : t("pluginLab.off")}
            </Switch.Label>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Root>
        </div>
      </div>
      {plugin.description && <p className={styles.description}>{plugin.description}</p>}
      {enhancements.length > 0 && (
        <div className={styles.enhancement}>
          <span className={styles.metaLabel}>{t("pluginLab.enhancements")}</span>
          {enhancements.slice(0, historyExpanded ? enhancements.length : 3).map((entry, index) => (
            <div className={styles.enhancement} key={`${entry.at}-${index}`}>
              <p className={styles.enhancementHead}>
                <time className={styles.enhancementDate} dateTime={entry.at} title={t("pluginLab.enhancementDateHint")}>
                  {formatEnhancementDate(entry.at, locale)}
                </time>
              </p>
              <p className={styles.enhancementSummary}>{entry.summary}</p>
            </div>
          ))}
          {enhancements.length > 3 && (
            <div className={styles.cardActions}>
              <ActionButton variant="neutralWeak" size="small" aria-expanded={historyExpanded} onClick={() => setHistoryExpanded((expanded) => !expanded)}>
                {historyExpanded ? t("pluginLab.showFewerEnhancements") : t("pluginLab.showAllEnhancements", { count: enhancements.length })}
              </ActionButton>
            </div>
          )}
        </div>
      )}
      {plugin.tools.length > 0 && (
        <div className={styles.tools}>
          <span className={styles.metaLabel}>{t("pluginLab.tools")}</span>
          <ul className={styles.toolList} aria-label={t("pluginLab.tools")}>
            {plugin.tools.map((tool) => <li key={tool} className={styles.tool}>{tool}</li>)}
          </ul>
        </div>
      )}
      {plugin.problem && (
        <p className={styles.problem}>
          <span className={styles.problemLabel}>{t("pluginLab.problem")}</span>
          <span>{plugin.problem}</span>
        </p>
      )}
      {error && <p className={styles.problem} role="alert">{t("pluginLab.toggleFailed", { error })}</p>}
      {canOpenPanel(plugin) && (
        <div className={styles.cardActions}>
          <ActionButton variant="neutralWeak" size="small" onClick={onOpen} aria-label={t("pluginLab.openPanelLabel", { name: plugin.name })}>
            {t("pluginLab.openPanel")}
          </ActionButton>
        </div>
      )}
    </li>
  );
}

function PluginPanelHost({ plugin, sessionId, labWidgets, onInsertDraft, onBack }: {
  plugin: LabPlugin;
  sessionId: string | null;
  labWidgets: LabWidgetReport;
  onInsertDraft?: (text: string) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Lines reported for another session (the report lags a session switch by one effect) are not shown.
  const lines = useMemo(
    () => (labWidgets.sessionId === sessionId ? labLinesFor(labWidgets.widgets, plugin.id) : []),
    [labWidgets, sessionId, plugin.id],
  );
  const stateRef = useRef<{ sessionId: string | null; lines: string[]; theme: LabPanelTheme }>({ sessionId: null, lines: [], theme: "light" });
  const insertRef = useRef(onInsertDraft);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    insertRef.current = onInsertDraft;
  }, [onInsertDraft]);

  const host = useMemo(() => createLabPanelHost({
    frame: () => frameRef.current?.contentWindow ?? null,
    state: () => stateRef.current,
    insertDraft: (text) => {
      const insert = insertRef.current;
      if (!insert) {
        setNotice(t("pluginLab.noComposer"));
        return false;
      }
      insert(text);
      setNotice(t("pluginLab.draftInserted"));
      return true;
    },
    recordDraft: () => {
      fetch(`${API}/${encodeURIComponent(plugin.id)}/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "draft" }),
      }).then(
        (response) => { if (!response.ok) setNotice(t("pluginLab.draftNotRecorded")); },
        () => setNotice(t("pluginLab.draftNotRecorded")),
      );
    },
  }), [plugin.id, t]);

  useEffect(() => {
    window.addEventListener("message", host.handleMessage);
    return () => window.removeEventListener("message", host.handleMessage);
  }, [host]);

  useEffect(() => {
    stateRef.current = { sessionId, lines, theme };
    host.publishState();
  }, [host, sessionId, lines, theme]);

  return (
    <section className={styles.view} aria-label={t("pluginLab.frameTitle", { name: plugin.name })}>
      <PanelHeader
        back={{ label: t("pluginLab.back"), onClick: onBack }}
        title={plugin.name}
        subtitle={t("pluginLab.panelSubtitle", { id: plugin.id })}
      />
      <div className={styles.stage}>
        <iframe
          ref={frameRef}
          className={styles.frame}
          title={t("pluginLab.frameTitle", { name: plugin.name })}
          src={`${API}/${encodeURIComponent(plugin.id)}/panel`}
          sandbox={LAB_PANEL_SANDBOX}
          referrerPolicy="no-referrer"
        />
      </div>
      <div className={styles.status}>
        <span className={styles.lines} data-live={lines.length > 0 ? "true" : "false"}>
          {lines.length > 0 ? t("pluginLab.lines", { count: lines.length }) : t("pluginLab.noLines")}
        </span>
        <span role="status" className={styles.notice}>{notice}</span>
      </div>
    </section>
  );
}
