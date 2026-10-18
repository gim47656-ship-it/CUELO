"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ActionButton, Badge, ToggleButton } from "@seed-design/react";
import { formatDurationMs, formatNumber, formatTokens } from "@/components/workspace/efficiency-format";
import { EFFICIENCY_RUNS_BASE } from "@/lib/hanse-efficiency-client";
import {
  RUN_TURN_PAGE_DEFAULT,
  type RunPrelude,
  type RunTurn,
  type RunTurnEntryText,
  type RunTurnEvent,
  type RunTurnEventKind,
  type RunTurnsPage,
  type RunTurnToolCall,
  type RunTurnToolStatus,
} from "@/lib/run-xray-types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const KIND_KEYS: Record<RunTurnEventKind, string> = {
  injection: "efficiency.sawKindInjection",
  developer: "efficiency.sawKindDeveloper",
  user: "efficiency.sawKindUser",
  compaction: "efficiency.sawKindCompaction",
  model: "efficiency.sawKindModel",
  effort: "efficiency.sawKindEffort",
  prompt: "efficiency.sawKindPrompt",
  rules: "efficiency.sawKindRules",
  memory: "efficiency.sawKindMemory",
};

const STATUS_KEYS: Record<RunTurnToolStatus, string> = {
  ok: "efficiency.sawToolOk",
  failed: "efficiency.sawToolFailed",
  noMatch: "efficiency.sawToolNoMatch",
  cancelled: "efficiency.sawToolCancelled",
  missing: "efficiency.sawToolMissing",
};

/** 성공은 배지를 달지 않는다. 실패만 강한 색을 쓰고 나머지는 중립이다. */
const STATUS_TONES: Record<Exclude<RunTurnToolStatus, "ok">, "critical" | "neutral" | "warning"> = {
  failed: "critical",
  noMatch: "neutral",
  cancelled: "neutral",
  missing: "warning",
};

/** 본문이 JSON이 아니면 상태 코드와 상관없이 오류다. 200에서 `null`을 돌려주면 화면이 불러오는 중에 멈춘다. */
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: "GET", signal });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON`);
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (body === null) throw new Error(`HTTP ${response.status}: empty body`);
  return body as T;
}

function runUrl(runId: string, path: "turns" | "prelude", params: Record<string, string>): string {
  return `${EFFICIENCY_RUNS_BASE}/${encodeURIComponent(runId)}/${path}?${new URLSearchParams(params).toString()}`;
}

function clockTime(at: number): string {
  return at > 0 ? new Date(at).toLocaleTimeString(undefined, { hour12: false }) : "—";
}

/** 버튼을 누를 때만 전체 글을 읽는다. 목록에는 미리보기만 싣는다. */
function FullText({ runId, role, entryId, call, label, t }: {
  runId: string;
  role: string;
  entryId: string;
  call: string | null;
  label: string;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "error"; value: RunTurnEntryText | null; error: string | null }>(
    { status: "idle", value: null, error: null },
  );
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || state.status === "ready" || state.status === "loading") return;
    setState({ status: "loading", value: null, error: null });
    const params: Record<string, string> = { role, entry: entryId };
    if (call) params.call = call;
    getJson<RunTurnEntryText>(runUrl(runId, "turns", params))
      .then((value) => setState({ status: "ready", value, error: null }))
      .catch((error: unknown) => setState({ status: "error", value: null, error: error instanceof Error ? error.message : String(error) }));
  };
  return (
    <div className="run-saw-full-wrap">
      <button type="button" className="run-saw-link" aria-expanded={open} onClick={toggle}>
        {open ? t("efficiency.sawHideFull") : label}
      </button>
      {open ? (
        state.status === "ready" && state.value ? (
          <>
            <pre className="run-saw-full">{state.value.text}</pre>
            {state.value.truncated ? (
              <p className="run-saw-dim">{t("efficiency.sawTruncated", { value: formatNumber(state.value.text.length) })}</p>
            ) : null}
          </>
        ) : state.status === "error" ? (
          <p className="run-saw-dim" role="alert">{state.error}</p>
        ) : (
          <p className="run-saw-dim" role="status">{t("efficiency.sawLoading")}</p>
        )
      ) : null}
    </div>
  );
}

function EventRow({ event, runId, role, t }: { event: RunTurnEvent; runId: string; role: string; t: Translate }) {
  let preview = event.preview;
  if (event.kind === "compaction" && (event.tokensBefore != null || event.tokensAfter != null)) {
    const tokens = t("efficiency.sawCompactionValue", {
      before: formatTokens(event.tokensBefore ?? null),
      after: formatTokens(event.tokensAfter ?? null),
    });
    preview = preview ? `${tokens} · ${preview}` : tokens;
  } else if (event.memoryIds !== undefined) {
    preview = t("efficiency.sawMemoryIds", { value: event.memoryIds });
  }
  return (
    <li className="run-saw-event">
      <div className="run-saw-event-head">
        <span className="run-saw-kind">{t(KIND_KEYS[event.kind])}</span>
        <span className="run-saw-source">{event.source}</span>
        <span className="run-saw-dim">{clockTime(event.at)}</span>
        {event.hiddenFromChat ? <span className="run-saw-dim">{t("efficiency.sawHiddenFromChat")}</span> : null}
        {event.sentToModel ? null : <span className="run-saw-dim">{t("efficiency.sawNotSent")}</span>}
      </div>
      {preview ? <p className="run-saw-preview">{preview}</p> : null}
      {event.chars > event.preview.length ? (
        <FullText runId={runId} role={role} entryId={event.entryId} call={null} label={t("efficiency.sawShowFull")} t={t} />
      ) : null}
    </li>
  );
}

function ToolCallRow({ call, runId, role, turnEntryId, t }: {
  call: RunTurnToolCall;
  runId: string;
  role: string;
  turnEntryId: string;
  t: Translate;
}) {
  return (
    <li className="run-saw-tool">
      <div className="run-saw-tool-head">
        <span className="run-saw-tool-name">{call.name}</span>
        <span className="run-saw-num">{formatDurationMs(call.durationMs)}</span>
        {call.resultChars !== null ? (
          <span className="run-saw-dim">{t("efficiency.sawResultChars", { value: formatNumber(call.resultChars) })}</span>
        ) : null}
        {call.status !== "ok" ? (
          <Badge tone={STATUS_TONES[call.status]} variant="weak" size="medium">{t(STATUS_KEYS[call.status])}</Badge>
        ) : null}
      </div>
      <code className="run-saw-args">{call.argsPreview}</code>
      <div className="run-saw-tool-actions">
        {call.argsChars > call.argsPreview.length ? (
          <FullText runId={runId} role={role} entryId={turnEntryId} call={call.toolCallId} label={t("efficiency.sawShowArgs")} t={t} />
        ) : null}
        {call.resultEntryId ? (
          <FullText runId={runId} role={role} entryId={call.resultEntryId} call={null} label={t("efficiency.sawShowResult")} t={t} />
        ) : null}
      </div>
    </li>
  );
}

function TurnItem({ turn, runId, role, t }: { turn: RunTurn; runId: string; role: string; t: Translate }) {
  const meta = [
    turn.model,
    formatDurationMs(turn.durationMs),
    turn.usage
      ? t("efficiency.sawUsage", {
          input: formatTokens(turn.usage.input),
          output: formatTokens(turn.usage.output),
          cacheRead: formatTokens(turn.usage.cacheRead),
        })
      : null,
    turn.stopReason ? t("efficiency.sawStop", { value: turn.stopReason }) : null,
  ].filter(Boolean).join(" · ");
  return (
    <li className="run-saw-turn">
      <div className="run-saw-turn-head">
        <span className="run-saw-turn-label">{t("efficiency.sawTurnLabel", { index: turn.index })}</span>
        <span className="run-saw-dim">{clockTime(turn.at)}</span>
      </div>
      <p className="run-saw-turn-meta">{meta}</p>
      {turn.toolsAdded.length > 0 || turn.toolsRemoved.length > 0 ? (
        <p className="run-saw-dim" title={[...turn.toolsAdded.map((name) => `+${name}`), ...turn.toolsRemoved.map((name) => `−${name}`)].join(" ")}>
          {t("efficiency.sawToolsChanged", { added: turn.toolsAdded.join(", ") || "0", removed: turn.toolsRemoved.join(", ") || "0" })}
        </p>
      ) : null}
      {turn.before.length > 0 ? (
        <div className="run-saw-group">
          <p className="run-saw-group-label">{t("efficiency.sawBefore")}</p>
          <ul className="run-saw-events">
            {turn.before.map((event) => <EventRow key={event.entryId} event={event} runId={runId} role={role} t={t} />)}
          </ul>
        </div>
      ) : null}
      {turn.toolCalls.length > 0 ? (
        <ul className="run-saw-tools">
          {turn.toolCalls.map((call) => (
            <ToolCallRow key={call.toolCallId} call={call} runId={runId} role={role} turnEntryId={turn.entryId} t={t} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PreludeSection({ runId, role, t }: { runId: string; role: string; t: Translate }) {
  const [prelude, setPrelude] = useState<RunPrelude | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setPrelude(null);
    setError(null);
    getJson<RunPrelude>(runUrl(runId, "prelude", { role }), controller.signal)
      .then(setPrelude)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [runId, role]);

  const rebuild = () => {
    setRebuilding(true);
    getJson<RunPrelude>(runUrl(runId, "prelude", { role, rebuild: "1" }))
      .then(setPrelude)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setRebuilding(false));
  };

  const lastDigest = prelude?.recorded.digests.at(-1) ?? null;
  const rebuilt = prelude?.rebuilt;
  return (
    <section className="run-saw-prelude" aria-label={t("efficiency.sawPreludeTitle")}>
      <h4 className="run-saw-subtitle">{t("efficiency.sawPreludeTitle")}</h4>
      {error ? <p className="run-saw-dim" role="alert">{error}</p> : null}
      {!prelude && !error ? <p className="run-saw-dim" role="status">{t("efficiency.sawLoading")}</p> : null}
      {prelude ? (
        <>
          <p className="run-saw-group-label">{t("efficiency.sawPreludeRecorded")}</p>
          <p className="run-saw-line">
            {lastDigest
              ? t("efficiency.sawPreludeDigest", { value: lastDigest.digest })
              : t("efficiency.sawPreludeDigestNone")}
          </p>
          {prelude.recorded.activeTools ? (
            <>
              <p className="run-saw-line">{t("efficiency.sawPreludeTools", { value: prelude.recorded.activeTools.length })}</p>
              <p className="run-saw-names">{prelude.recorded.activeTools.join(" · ")}</p>
            </>
          ) : null}
          {prelude.recorded.memoryRecall ? (
            <div className="run-saw-group">
              <p className="run-saw-line">{t("efficiency.sawPreludeMemory")}</p>
              <p className="run-saw-preview">{prelude.recorded.memoryRecall.preview}</p>
              {prelude.recorded.memoryRecall.chars > prelude.recorded.memoryRecall.preview.length ? (
                <FullText
                  runId={runId}
                  role={role}
                  entryId={prelude.recorded.memoryRecall.entryId}
                  call={null}
                  label={t("efficiency.sawShowFull")}
                  t={t}
                />
              ) : null}
            </div>
          ) : null}
          {rebuilt?.status === "not-loaded" ? (
            <p className="run-saw-approx">{t("efficiency.sawPreludeNotLoaded")}</p>
          ) : rebuilt?.status === "available" ? (
            <div className="run-saw-actions">
              <ActionButton variant="neutralWeak" size="xsmall" onClick={rebuild} disabled={rebuilding}>
                {rebuilding ? t("efficiency.sawPreludeLoading") : t("efficiency.sawPreludeReconstruct")}
              </ActionButton>
            </div>
          ) : rebuilt?.status === "rebuilt" ? (
            <>
              <p className="run-saw-approx">{t("efficiency.sawPreludeApprox")}</p>
              {rebuilt.matchesRecorded !== null ? (
                <p className="run-saw-line">
                  {t(rebuilt.matchesRecorded ? "efficiency.sawPreludeMatch" : "efficiency.sawPreludeMismatch")}
                </p>
              ) : null}
              <pre className="run-saw-full">{rebuilt.text}</pre>
              {rebuilt.truncated ? (
                <p className="run-saw-dim">{t("efficiency.sawTruncated", { value: formatNumber(rebuilt.text.length) })}</p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

interface TurnsState {
  status: "idle" | "loading" | "ready" | "error";
  page: RunTurnsPage | null;
  turns: RunTurn[];
  loadingMore: boolean;
  error: string | null;
}

const IDLE: TurnsState = { status: "idle", page: null, turns: [], loadingMore: false, error: null };

/**
 * Run X-Ray 상세의 "모델이 본 것". 세션 기록으로 다시 맞춘 근사치이며, 사용자가 열 때만
 * 한 쪽(기본 30개)씩 읽는다. 전체 글은 항목마다 따로 읽는다.
 */
export function RunTurnView({ runId, t }: { runId: string; t: Translate }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState("main");
  const [injectedOnly, setInjectedOnly] = useState(false);
  const [state, setState] = useState<TurnsState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback((offset: number) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((previous) => offset === 0
      ? { ...IDLE, status: "loading" }
      : { ...previous, loadingMore: true });
    const params: Record<string, string> = { role, offset: String(offset), limit: String(RUN_TURN_PAGE_DEFAULT) };
    if (injectedOnly) params.injectedOnly = "1";
    getJson<RunTurnsPage>(runUrl(runId, "turns", params), controller.signal)
      .then((page) => setState((previous) => ({
        status: "ready",
        page,
        turns: offset === 0 ? page.turns : [...previous.turns, ...page.turns],
        loadingMore: false,
        error: null,
      })))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setState((previous) => ({ ...previous, status: offset === 0 ? "error" : previous.status, loadingMore: false, error: reason instanceof Error ? reason.message : String(reason) }));
      });
  }, [runId, role, injectedOnly]);

  useEffect(() => {
    if (open) load(0);
  }, [open, load]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const page = state.page;
  const remaining = page ? page.total - state.turns.length : 0;
  const topSources = page
    ? Object.entries(page.counts.bySource).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    : [];

  return (
    <section className="run-saw" aria-label={t("efficiency.sawSection")}>
      <h3 className="efficiency-section-title">{t("efficiency.sawSection")}</h3>
      <p className="run-saw-approx">{t("efficiency.sawApproxNote")}</p>
      {!open ? (
        <div className="run-saw-actions">
          <ActionButton variant="neutralWeak" size="xsmall" onClick={() => setOpen(true)}>
            {t("efficiency.sawOpen")}
          </ActionButton>
        </div>
      ) : (
        <>
          <div className="run-saw-controls">
            {page && page.roles.length > 1 ? (
              <label className="run-saw-role">
                <span>{t("efficiency.sawRole")}</span>
                <select className="efficiency-folder-select" value={role} onChange={(event) => setRole(event.target.value)}>
                  {page.roles.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
            ) : null}
            <ToggleButton variant="neutralWeak" size="xsmall" pressed={injectedOnly} onPressedChange={setInjectedOnly}>
              {t("efficiency.sawOnlyInjected")}
            </ToggleButton>
          </div>
          {state.status === "loading" || state.status === "idle" ? (
            <p className="efficiency-empty" role="status">{t("efficiency.sawLoading")}</p>
          ) : state.status === "error" ? (
            <div className="efficiency-empty" role="alert">
              <div>{t("efficiency.sawError")}</div>
              <div className="run-saw-dim">{state.error}</div>
            </div>
          ) : page ? (
            <>
              <p className="run-saw-summary">
                {t("efficiency.sawSummary", {
                  turns: page.counts.turns,
                  injections: page.counts.injections,
                  tools: page.counts.toolCalls,
                  failed: page.counts.toolFailures,
                })}
              </p>
              {topSources.length > 0 ? (
                <p className="run-saw-names">{topSources.map(([source, count]) => `${source} ${count}`).join(" · ")}</p>
              ) : null}
              <p className="run-saw-dim run-saw-pad">{t("efficiency.sawSecretsMasked")}</p>
              {state.turns.length === 0 ? (
                <p className="efficiency-empty">{t(injectedOnly ? "efficiency.sawFilterEmpty" : "efficiency.sawEmpty")}</p>
              ) : (
                <ol className="run-saw-turns">
                  {state.turns.map((turn) => <TurnItem key={turn.entryId} turn={turn} runId={runId} role={page.role} t={t} />)}
                </ol>
              )}
              {page.trailing.length > 0 && remaining <= 0 ? (
                <div className="run-saw-group run-saw-trailing">
                  <p className="run-saw-group-label">{t("efficiency.sawTrailing")}</p>
                  <ul className="run-saw-events">
                    {page.trailing.map((event) => <EventRow key={event.entryId} event={event} runId={runId} role={page.role} t={t} />)}
                  </ul>
                </div>
              ) : null}
              <div className="run-saw-actions">
                <span className="run-saw-dim">{t("efficiency.sawShown", { shown: state.turns.length, total: page.total })}</span>
                {remaining > 0 ? (
                  <ActionButton variant="neutralWeak" size="xsmall" onClick={() => load(state.turns.length)} disabled={state.loadingMore}>
                    {state.loadingMore ? t("efficiency.sawLoading") : t("efficiency.sawMore", { value: Math.min(remaining, RUN_TURN_PAGE_DEFAULT) })}
                  </ActionButton>
                ) : null}
              </div>
              {state.error ? <p className="run-saw-dim run-saw-pad" role="alert">{state.error}</p> : null}
              <PreludeSection runId={runId} role={page.role} t={t} />
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
