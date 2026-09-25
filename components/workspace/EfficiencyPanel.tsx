"use client";

import { useId, useMemo, useState } from "react";
import { ActionButton, Badge, ToggleButton } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";
import { useRunXray } from "@/hooks/useRunXray";
import type { HanseEfficiencyClient } from "@/lib/hanse-efficiency-client";
import type {
  ExperimentConfig,
  ExperimentConfigRole,
  ExperimentResponse,
  ExperimentScope,
  RunBottleneck,
  RunDetail,
  RunOutcome,
  RunRoleSegment,
  RunSummary,
} from "@/lib/run-xray-types";
import type { WorkspaceEfficiencyTab } from "@/lib/workspace-layout";

export interface EfficiencyPanelProps {
  open: boolean;
  sessionId: string | null;
  activeTab: WorkspaceEfficiencyTab;
  onTabChange: (tab: WorkspaceEfficiencyTab) => void;
  client?: HanseEfficiencyClient;
  className?: string;
}

type EfficiencyBadgeTone = "neutral" | "informative" | "positive" | "warning" | "critical";

const OUTCOME_TONES: Record<RunOutcome, EfficiencyBadgeTone> = {
  completed: "positive",
  error: "critical",
  aborted: "warning",
  interrupted: "warning",
  running: "informative",
};

const ROLE_TONES: Record<string, EfficiencyBadgeTone> = {
  main: "informative",
  maker: "neutral",
  checker: "neutral",
  advisor: "neutral",
  unattributed: "warning",
};

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const ms = Math.max(0, value);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // 초를 먼저 정수로 확정한다. 분을 자른 뒤 나머지를 반올림하면 `49m 60s`가 나온다.
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds - totalMinutes * 60;
  if (totalMinutes < 60) return restSeconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${restSeconds}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function formatPercent(value: number | null | undefined, digits = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
      <dt className="min-w-0 flex-1 truncate text-xs text-text-muted">{label}</dt>
      <dd className="m-0 flex-none font-mono text-xs tabular-nums text-text">{value}</dd>
    </div>
  );
}

/** 숫자를 동반한 가로 비율 막대. 색만으로 의미를 전달하지 않는다. */
function RatioBar({ share, label }: { share: number; label: string }) {
  const width = Number.isFinite(share) ? Math.max(1, Math.min(100, share * 100)) : 1;
  return (
    <div className="efficiency-bar" aria-hidden="true">
      <div className="efficiency-bar-fill" style={{ width: `${width}%` }} />
      <span className="efficiency-bar-value">{label}</span>
    </div>
  );
}

function CostLine({ costUsd, unpriced, t }: { costUsd: number; unpriced: number; t: (key: string) => string }) {
  return (
    <span className="font-mono tabular-nums">
      {t("efficiency.estimatedCostValue").replace("{value}", formatMoney(costUsd))}
      {unpriced > 0 ? ` · ${t("efficiency.unpricedLowerBound")}` : ""}
    </span>
  );
}

function OutcomeBadge({ outcome, t }: { outcome: RunOutcome; t: (key: string) => string }) {
  const keys: Record<RunOutcome, string> = {
    completed: "efficiency.outcomeCompleted",
    error: "efficiency.outcomeError",
    aborted: "efficiency.outcomeAborted",
    interrupted: "efficiency.outcomeInterrupted",
    running: "efficiency.outcomeRunning",
  };
  return (
    <Badge tone={OUTCOME_TONES[outcome]} variant="weak" size="medium">
      {t(keys[outcome])}
    </Badge>
  );
}

function PurposeBadge({ purpose, t }: { purpose: string | null; t: (key: string) => string }) {
  if (purpose === null) return <span className="efficiency-dim">{t("efficiency.unmeasuredShort")}</span>;
  const keys: Record<string, string> = {
    primary: "efficiency.purposePrimary",
    rework: "efficiency.purposeRework",
    review: "efficiency.purposeReview",
  };
  return (
    <Badge tone={purpose === "rework" ? "warning" : "neutral"} variant="weak" size="medium">
      {t(keys[purpose] ?? "efficiency.unmeasuredShort")}
    </Badge>
  );
}

function RunListItem({
  run,
  selected,
  onSelect,
  t,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const title = run.title && run.title.trim().length > 0 ? run.title : t("efficiency.noTitle");
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={classNames("efficiency-run-item", selected && "is-selected")}
      >
        <span className="efficiency-run-top">
          <span className="efficiency-run-index">#{run.index}</span>
          <span className="efficiency-run-title" title={title}>{title}</span>
          <OutcomeBadge outcome={run.outcome} t={t} />
        </span>
        <span className="efficiency-run-meta">
          <span className="font-mono tabular-nums">{t("efficiency.elapsedValue").replace("{value}", formatDurationMs(run.wallClockMs))}</span>
          <CostLine costUsd={run.estimatedCostUsd} unpriced={run.unpricedRequests} t={t} />
        </span>
      </button>
    </li>
  );
}

function RoleRow({ role, t }: {
  role: RunRoleSegment;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const models = role.models.length > 0 ? role.models.join(", ") : t("efficiency.unmeasuredShort");
  const efforts = role.efforts.length > 0 ? role.efforts.join(", ") : t("efficiency.unmeasuredShort");
  return (
    <section className="efficiency-card">
      <div className="efficiency-card-top">
        <h4 className="efficiency-card-title" title={role.id}>{role.id}</h4>
        <Badge tone={ROLE_TONES[role.kind] ?? "neutral"} variant="weak" size="medium">
          {t(`efficiency.role${role.kind === "main" ? "Main" : role.kind === "maker" ? "Maker" : role.kind === "checker" ? "Checker" : role.kind === "advisor" ? "Advisor" : "Unattributed"}`)}
        </Badge>
        <PurposeBadge purpose={role.purpose} t={t} />
      </div>
      <p className="efficiency-model-line" title={models}>{models}</p>
      <p className="efficiency-dim">
        {t("efficiency.effortLabel").replace("{value}", efforts)}
        {` · ${t("efficiency.requestsValue").replace("{value}", String(role.requestCount))}`}
        {` · ${t("efficiency.toolCallsValue").replace("{value}", String(role.toolCalls))}`}
      </p>
      <dl className="m-0 grid grid-cols-2 gap-x-4">
        <Metric label={t("efficiency.busyTime")} value={formatDurationMs(role.busyMs)} />
        <Metric label={t("efficiency.estimatedCost")} value={formatMoney(role.estimatedCostUsd)} />
        <Metric label={t("efficiency.tokens")} value={formatTokens(role.totalTokens)} />
        <Metric label={t("efficiency.unpricedRequests")} value={formatNumber(role.unpricedRequests)} />
      </dl>
      {role.untimedRequests > 0 ? (
        <p className="efficiency-note">
          {t("efficiency.untimedLowerBound").replace("{value}", formatNumber(role.untimedRequests))}
        </p>
      ) : null}
      {role.unpricedRequests > 0 ? (
        <p className="efficiency-note">{t("efficiency.unpricedLowerBound")}</p>
      ) : null}
    </section>
  );
}

function BottleneckRow({ item, t }: {
  item: RunBottleneck;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const label = item.kind === "unmeasured-gap"
    ? t("efficiency.unmeasuredGap")
    : item.id;
  return (
    <li className="efficiency-bottleneck">
      <div className="efficiency-bottleneck-top">
        <span className="efficiency-bottleneck-label" title={label}>{label}</span>
        <span className="font-mono text-xs tabular-nums text-text">{formatDurationMs(item.ms)}</span>
      </div>
      {/* 1위 대비 길이일 뿐이라 백분율을 쓰지 않는다. 생성시간을 경과로 나누면 병렬 역할에서 합이 100%를 넘는다. */}
      <RatioBar share={item.relative} label={formatDurationMs(item.ms)} />
    </li>
  );
}

function GovernorDetail({ detail, t }: {
  detail: RunDetail;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="efficiency-detail">
      <section aria-label={t("efficiency.summarySection")}>
        <h3 className="efficiency-section-title">{t("efficiency.summarySection")}</h3>
        <div className="efficiency-dual">
          <div className="efficiency-dual-cell">
            <span className="efficiency-dual-label">{t("efficiency.elapsed")}</span>
            <span className="efficiency-dual-value">{formatDurationMs(detail.wallClockMs)}</span>
          </div>
          <div className="efficiency-dual-cell">
            <span className="efficiency-dual-label">{t("efficiency.busyTotal")}</span>
            <span className="efficiency-dual-value">{formatDurationMs(detail.busyMs)}</span>
          </div>
        </div>
        <p className="efficiency-note">{t("efficiency.noSumNote")}</p>
        <dl className="m-0 grid grid-cols-2 gap-x-4">
          <Metric label={t("efficiency.estimatedCost")} value={formatMoney(detail.estimatedCostUsd)} />
          <Metric label={t("efficiency.tokens")} value={formatTokens(detail.totalTokens)} />
        </dl>
        {detail.unpricedRequests > 0 ? (
          <p className="efficiency-note">{t("efficiency.unpricedLowerBound")}</p>
        ) : null}
      </section>
      <section aria-label={t("efficiency.rolesSection")}>
        <h3 className="efficiency-section-title">{t("efficiency.rolesSection")}</h3>
        {detail.roles.length > 0 ? (
          <div className="efficiency-stack">
            {detail.roles.map((role) => <RoleRow key={role.id} role={role} t={t} />)}
          </div>
        ) : (
          <p className="efficiency-empty">{t("efficiency.rolesEmpty")}</p>
        )}
      </section>
      <section aria-label={t("efficiency.bottlenecksSection")}>
        <h3 className="efficiency-section-title">{t("efficiency.bottlenecksSection")}</h3>
        <p className="efficiency-note">{t("efficiency.bottleneckOrderNote")}</p>
        {detail.bottlenecks.length > 0 ? (
          <ul className="efficiency-stack">
            {detail.bottlenecks.map((item) => (
              <BottleneckRow key={`${item.kind}:${item.id}`} item={item} t={t} />
            ))}
          </ul>
        ) : (
          <p className="efficiency-empty">{t("efficiency.bottlenecksEmpty")}</p>
        )}
        {detail.unmeasuredMs > 0 ? (
          <p className="efficiency-note">
            {t("efficiency.unmeasuredGapValue").replace("{value}", formatDurationMs(detail.unmeasuredMs))}
          </p>
        ) : null}
      </section>
      {detail.toolTotals.length > 0 ? (
        <section aria-label={t("efficiency.toolsSection")}>
          <h3 className="efficiency-section-title">{t("efficiency.toolsSection")}</h3>
          <dl className="m-0 grid grid-cols-2 gap-x-4">
            {detail.toolTotals.map((tool) => (
              <Metric
                key={tool.toolName}
                label={`${tool.toolName} · ${t("efficiency.toolErrorsValue").replace("{value}", String(tool.errors))}`}
                value={formatNumber(tool.calls)}
              />
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function configRoleSummary(roles: ExperimentConfigRole[]): string {
  return roles.map((role) => {
    const effort = role.effort ?? "–";
    const count = role.count > 1 ? ` x${role.count}` : "";
    return `${role.kind} ${role.model}:${effort}${count}`;
  }).join(" · ");
}

/** 어떤 기록을 세었는지 숫자로 못 박는다. 범위는 색이 아니라 문자로 말한다. */
function ScopeSummary({
  response,
  t,
}: {
  response: ExperimentResponse;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <section className="efficiency-card">
      <dl className="m-0 grid grid-cols-2 gap-x-4">
        <Metric label={t("efficiency.scopeSessions")} value={formatNumber(response.sessionCount)} />
        <Metric label={t("efficiency.scopeRuns")} value={formatNumber(response.runCount)} />
        <Metric label={t("efficiency.scopeExcludedRuns")} value={formatNumber(response.excludedRunCount)} />
      </dl>
    </section>
  );
}

function ExperimentCard({
  config,
  baselineRuns,
  t,
}: {
  config: ExperimentConfig;
  baselineRuns: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const share = baselineRuns > 0 ? config.runCount / baselineRuns : 0;
  const reworkRate = config.runCount > 0 ? config.reworkRuns / config.runCount : 0;
  const errorRate = config.runCount > 0 ? config.errorRuns / config.runCount : 0;
  return (
    <section className="efficiency-card">
      <p className="efficiency-model-line" title={configRoleSummary(config.roles)}>
        {configRoleSummary(config.roles)}
      </p>
      <div className="efficiency-bottleneck-top">
        <span className="efficiency-dim">
          {t("efficiency.runsValue").replace("{value}", String(config.runCount))}
        </span>
        <span className="font-mono text-xs tabular-nums text-text">{formatPercent(share)}</span>
      </div>
      <RatioBar share={share} label={formatPercent(share)} />
      <dl className="m-0 grid grid-cols-2 gap-x-4">
        <Metric label={t("efficiency.medianElapsed")} value={formatDurationMs(config.medianWallClockMs)} />
        <Metric label={t("efficiency.medianBusy")} value={formatDurationMs(config.medianBusyMs)} />
        <Metric label={t("efficiency.medianTokens")} value={formatTokens(config.medianTotalTokens)} />
        <Metric label={t("efficiency.medianEstimatedCost")} value={formatMoney(config.medianEstimatedCostUsd)} />
        <Metric label={t("efficiency.totalEstimatedCost")} value={formatMoney(config.totalEstimatedCostUsd)} />
        <Metric label={t("efficiency.reworkRate")} value={formatPercent(reworkRate, 1)} />
        <Metric label={t("efficiency.errorRate")} value={formatPercent(errorRate, 1)} />
        <Metric label={t("efficiency.unpricedRuns")} value={formatNumber(config.unpricedRuns)} />
        <Metric label={t("efficiency.untimedRuns")} value={formatNumber(config.untimedRuns)} />
      </dl>
      {config.untimedRuns > 0 ? (
        <p className="efficiency-note">
          {t("efficiency.untimedMedianLowerBound").replace("{value}", formatNumber(config.untimedRuns))}
        </p>
      ) : null}
      {config.unpricedRuns > 0 ? (
        <p className="efficiency-note">{t("efficiency.unpricedLowerBound")}</p>
      ) : null}
    </section>
  );
}

/**
 * 효율 패널. Governor(실행 통제)와 Experiment Lab(구성 비교) 두 보기를
 * 제공한다. ResourcePanel과 같은 섹션·빈 상태·스크롤 구조를 쓰며, 이미
 * 쌓인 기록만 읽는다.
 */
export function EfficiencyPanel({
  open,
  sessionId,
  activeTab,
  onTabChange,
  client,
  className,
}: EfficiencyPanelProps) {
  const headingId = useId();
  const tabPanelId = useId();
  const { t } = useI18n();
  const visible = open;
  const xray = useRunXray({ sessionId, visible, activeTab, client });
  const [manualFolder, setManualFolder] = useState<string>("");
  const folders = useMemo(
    () => xray.experiments.response?.folders ?? [],
    [xray.experiments.response],
  );
  const baselineRuns = useMemo(
    () => xray.experiments.response?.configs.reduce((max, config) => Math.max(max, config.runCount), 0) ?? 0,
    [xray.experiments.response],
  );
  // 화면에 보이는 폴더는 **실제로 요청한 폴더**여야 한다. 세션 cwd를 기본값처럼
  // 보여주면 전체 폴더 수치를 특정 폴더 수치로 오해하게 된다. DB의 folder 값은
  // `/E/Projects-Tools/` 형태라 세션 cwd와 형식도 다르다.
  const effectiveFolder = xray.experimentFolder;
  // 토글은 화면에 올라온 응답의 범위를 그대로 가리킨다. 눌린 상태와 실제 집계가
  // 어긋나면(예: 탭을 다시 열어 기본 범위로 돌아온 뒤) 화면이 거짓말을 하게 된다.
  const scope: ExperimentScope = xray.experiments.response?.scope ?? "all";

  if (!open) return null;

  const busy = (activeTab === "governor" && xray.list.status === "loading")
    || (activeTab === "lab" && xray.experiments.status === "loading");
  const refreshLabel = busy ? t("efficiency.refreshing") : t("efficiency.refresh");
  const timestampLabel = activeTab === "governor"
    ? (xray.list.runs.length > 0 ? t("efficiency.runsValue").replace("{value}", String(xray.list.runs.length)) : "")
    : (xray.experiments.response ? t("efficiency.runsValue").replace("{value}", String(xray.experiments.response.runCount)) : "");

  const handleRefresh = () => {
    if (activeTab === "governor") xray.refreshRuns();
    else xray.refreshExperiments(undefined, scope);
  };

  const renderGovernor = () => {
    if (!sessionId) return <p className="efficiency-empty">{t("efficiency.noSession")}</p>;
    if (xray.list.status === "idle" || xray.list.status === "loading") {
      return <div className="p-4 text-sm text-text-muted" role="status">{t("efficiency.loadingRuns")}</div>;
    }
    if (xray.list.status === "error") {
      return (
        <div className="p-4 text-sm text-text" role="alert">
          <div className="font-medium">{t("efficiency.runsError")}</div>
          <div className="mt-1 text-xs text-text-muted">{xray.list.error}</div>
        </div>
      );
    }
    if (xray.list.status === "empty") {
      return <p className="efficiency-empty">{t("efficiency.runsEmpty")}</p>;
    }
    return (
      <div className="efficiency-governor">
        <ul className="efficiency-run-list">
          {xray.list.runs.map((run) => (
            <RunListItem
              key={run.runId}
              run={run}
              selected={xray.selectedRunId === run.runId}
              onSelect={() => xray.selectRun(xray.selectedRunId === run.runId ? null : run.runId)}
              t={t}
            />
          ))}
        </ul>
        <div className="efficiency-detail-pane">
          {xray.selectedRunId === null || xray.detail.status === "idle" ? (
            <p className="efficiency-empty">{t("efficiency.selectRun")}</p>
          ) : xray.detail.status === "loading" ? (
            <div className="p-4 text-sm text-text-muted" role="status">{t("efficiency.loadingDetail")}</div>
          ) : xray.detail.status === "error" ? (
            <div className="p-4 text-sm text-text" role="alert">
              <div className="font-medium">{t("efficiency.detailError")}</div>
              <div className="mt-1 text-xs text-text-muted">{xray.detail.error}</div>
            </div>
          ) : xray.detail.detail ? (
            <GovernorDetail detail={xray.detail.detail} t={t} />
          ) : null}
        </div>
      </div>
    );
  };

  const renderLab = () => {
    if (xray.experiments.status === "idle" || xray.experiments.status === "loading") {
      return <div className="p-4 text-sm text-text-muted" role="status">{t("efficiency.loadingExperiments")}</div>;
    }
    if (xray.experiments.status === "error") {
      return (
        <div className="p-4 text-sm text-text" role="alert">
          <div className="font-medium">{t("efficiency.experimentsError")}</div>
          <div className="mt-1 text-xs text-text-muted">{xray.experiments.error}</div>
        </div>
      );
    }
    const response = xray.experiments.response;
    if (xray.experiments.status === "empty" || !response) {
      return (
        <>
          <p className="efficiency-empty">{t("efficiency.experimentsEmpty")}</p>
          {/* 범위를 좁혀 0건이 된 경우에도 몇 건을 뺐는지는 남긴다. */}
          {response ? (
            <div className="efficiency-stack">
              <ScopeSummary response={response} t={t} />
            </div>
          ) : null}
          <p className="efficiency-note">{t("efficiency.difficultyNote")}</p>
        </>
      );
    }
    return (
      <>
        <p className="efficiency-note">{t("efficiency.difficultyNote")}</p>
        <div className="efficiency-stack">
          <ScopeSummary response={response} t={t} />
          {response.configs.map((config) => (
            <ExperimentCard key={config.signature} config={config} baselineRuns={baselineRuns} t={t} />
          ))}
        </div>
      </>
    );
  };

  return (
    <section
      className={classNames(
        "efficiency-panel flex min-h-0 w-full flex-col overflow-hidden bg-bg-panel text-text",
        className,
      )}
      aria-labelledby={headingId}
      aria-busy={busy}
    >
      <header className="flex min-h-12 items-center gap-3 border-b border-border bg-bg px-3">
        <h1 id={headingId} className="m-0 text-sm font-semibold text-text">{t("efficiency.title")}</h1>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] tabular-nums text-text-dim">{timestampLabel}</span>
        <ActionButton variant="neutralWeak" size="xsmall" onClick={handleRefresh} disabled={busy}>
          {refreshLabel}
        </ActionButton>
      </header>
      <div className="grid grid-cols-2 border-b border-border bg-bg" role="tablist" aria-label={t("efficiency.title")}>
        {(["governor", "lab"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            id={`${tabPanelId}-${tab}-tab`}
            aria-controls={tabPanelId}
            className={classNames(
              "min-h-10 border-0 border-r border-border bg-bg px-4 text-sm text-text-muted last:border-r-0 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
              activeTab === tab && "bg-bg-selected font-semibold text-text",
            )}
            onClick={() => onTabChange(tab)}
          >
            {tab === "governor" ? t("efficiency.governor") : t("efficiency.lab")}
          </button>
        ))}
      </div>
      {activeTab === "lab" ? (
        <div className="efficiency-folderbar">
          <label className="efficiency-folder-label" htmlFor={`${tabPanelId}-folder`}>
            {t("efficiency.folder")}
          </label>
          <select
            id={`${tabPanelId}-folder`}
            className="efficiency-folder-select"
            value={effectiveFolder ?? ""}
            onChange={(event) => {
              const next = event.target.value === "" ? null : event.target.value;
              setManualFolder(next ?? "");
              xray.refreshExperiments(next, scope);
            }}
          >
            <option value="">{t("efficiency.folderAll")}</option>
            {folders.map((folder) => (
              <option key={folder} value={folder}>{folder}</option>
            ))}
            {effectiveFolder && !folders.includes(effectiveFolder) ? (
              <option value={effectiveFolder}>{effectiveFolder}</option>
            ) : null}
          </select>
          <input
            className="efficiency-folder-input"
            value={manualFolder}
            placeholder={t("efficiency.folderPlaceholder")}
            aria-label={t("efficiency.folder")}
            onChange={(event) => setManualFolder(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const next = manualFolder.trim() === "" ? null : manualFolder.trim();
                xray.refreshExperiments(next, scope);
              }
            }}
          />
          <div className="col-span-full flex flex-col items-start gap-2">
            <ToggleButton
              variant="neutralWeak"
              size="xsmall"
              pressed={scope === "attributed"}
              onPressedChange={(pressed) => xray.refreshExperiments(undefined, pressed ? "attributed" : "all")}
            >
              {t("efficiency.scopeAttributed")}
            </ToggleButton>
            {/* 배지는 SEED 레시피가 120px에서 자르므로 범위명만 짧게 쓴다. */}
            <Badge tone={scope === "attributed" ? "informative" : "neutral"} variant="weak" size="medium">
              {t(scope === "attributed" ? "efficiency.scopeAttributed" : "efficiency.scopeAll")}
            </Badge>
          </div>
        </div>
      ) : null}
      <div
        id={tabPanelId}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        role="tabpanel"
        aria-labelledby={`${tabPanelId}-${activeTab}-tab`}
      >
        {activeTab === "governor" ? renderGovernor() : renderLab()}
      </div>
    </section>
  );
}
