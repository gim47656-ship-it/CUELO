"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { OfficeRail } from "@/components/office/OfficeFloor";
import { OfficeStage } from "@/components/office/OfficeStage";
import officeStyles from "@/components/office/office.module.css";
import { ACCOUNT_FACES } from "@/lib/hanse-resource-client";
import { OFFICE_CAMERA_FIT, type OfficeCameraView } from "@/lib/office/office-camera";
import {
  OFFICE_MAIN_KEY,
  buildOfficeRoster,
  resolveOfficeSelection,
  type OfficeFaceResolver,
  type OfficeMainState,
  type OfficeMakerAccount,
} from "@/lib/office/office-roster";
import type { SubagentSnapshot, SubagentStatus } from "@/lib/types";

/*
 * 개발 전용 장면 미리보기. 고정 참여자(가짜 Maker 스냅샷·계정 근거)를 실제 `buildOfficeRoster` 에
 * 흘려 넣어 실제 `OfficeStage`·`OfficeScene3D` 를 그린다. 계정·세션·서버 호출은 없다.
 */

interface FixtureMaker {
  id: string;
  status: SubagentStatus;
  /** 기록된 모델(provider/model). 없으면 기록 없음. */
  model?: string;
  /** 기록에서 본 credential. Anthropic 처럼 계정이 여럿인 provider 의 얼굴은 이것으로만 정해진다. */
  credentialId?: number;
  retrying?: boolean;
  intent?: string;
}

interface Scenario {
  label: string;
  main: { seat: number | null; state: OfficeMainState };
  makers: FixtureMaker[];
}

const SCENARIOS: Record<string, Scenario> = {
  idle: { label: "Main 혼자 · idle", main: { seat: 0, state: "idle" }, makers: [] },
  working: { label: "Main 혼자 · working", main: { seat: 0, state: "working" }, makers: [] },
  attention: { label: "Main · attention", main: { seat: 0, state: "attention" }, makers: [] },
  team: {
    label: "Main MIO + Maker 3",
    main: { seat: 1, state: "waiting" },
    makers: [
      { id: "YukiTests", status: "running", model: "openai-codex/gpt-6-astra", intent: "Running focused tests" },
      { id: "NovaDraft", status: "completed", model: "opencode-go/muse-spark-1.3-contributor" },
      { id: "IsanaScan", status: "pending", model: "b-ai/deepseek-v4.1-flash" },
    ],
  },
  crowd: {
    label: "같은 계정 여럿 · 미확인 · 실패·중단·재시도",
    main: { seat: 0, state: "working" },
    makers: [
      { id: "RinSameA", status: "running", model: "anthropic/claude-opus-5-5", credentialId: 1, intent: "Editing the scene" },
      { id: "RinSameB", status: "pending", model: "anthropic/claude-opus-5-5", credentialId: 1 },
      { id: "YukiTests", status: "running", model: "openai-codex/gpt-6-astra" },
      { id: "NovaDraft", status: "completed", model: "opencode-go/muse-spark-1.3-contributor" },
      { id: "IsanaScan", status: "failed", model: "b-ai/deepseek-v4.1-flash" },
      { id: "HikariRetry", status: "running", model: "google-antigravity/gemini-3.8-flash", retrying: true },
      { id: "ShionStopped", status: "aborted", model: "web6/gpt-6-pro" },
      { id: "AnthropicNoCredential", status: "running", model: "anthropic/claude-opus-5-5" },
    ],
  },
  mio: {
    label: "Main MIO + MIO Maker 2 (한 몸·작업 셋)",
    main: { seat: 1, state: "idle" },
    makers: [
      { id: "MioBuild", status: "running", model: "anthropic/claude-opus-5-5", credentialId: 2, intent: "Wiring the loader" },
      { id: "MioReview", status: "failed", model: "anthropic/claude-opus-5-5", credentialId: 2 },
    ],
  },
  unknown: {
    label: "Main 캐릭터 미확인 + 기록 없는 Maker",
    main: { seat: null, state: "idle" },
    makers: [{ id: "NoRecord", status: "running" }],
  },
};

const MAIN_STATES: readonly OfficeMainState[] = ["idle", "working", "waiting", "attention"];
/** 1105 는 1365px 창에서 기본 사이드바(260px)를 뺀 폭이다. 852 는 같은 셈으로 1112px 창이다. */
const WIDTHS = [0, 375, 390, 768, 852, 1105, 1365] as const;

/** 미리보기의 얼굴 배정: provider 예약 얼굴, Anthropic 은 credential 1 → RIN, 2 → MIO. */
const resolveFace: OfficeFaceResolver = (provider, credentialId) => {
  if (provider === "anthropic") {
    if (credentialId === 1) return { seed: 0, alias: ACCOUNT_FACES[0].alias };
    if (credentialId === 2) return { seed: 1, alias: ACCOUNT_FACES[1].alias };
    return null;
  }
  const seat = ACCOUNT_FACES.findIndex((face) => "provider" in face && face.provider === provider);
  return seat >= 0 ? { seed: seat, alias: ACCOUNT_FACES[seat].alias } : null;
};

function snapshotOf(maker: FixtureMaker, index: number): SubagentSnapshot {
  return {
    id: maker.id,
    index,
    agent: "maker",
    agentSource: "bundled",
    status: maker.status,
    lastUpdate: 1,
    progress: {
      index,
      id: maker.id,
      agent: "maker",
      status: maker.status,
      task: "preview",
      lastIntent: maker.intent,
      recentTools: [],
      recentOutput: [],
      toolCount: 0,
      requests: 0,
      tokens: 0,
      cost: 0,
      durationMs: 0,
      resolvedModel: maker.model,
      retryState: maker.retrying ? { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "preview", startedAtMs: 1 } : undefined,
    },
  };
}

export function OfficePreview() {
  const [mounted, setMounted] = useState(false);
  const [scenarioId, setScenarioId] = useState("crowd");
  const [mainState, setMainState] = useState<OfficeMainState>(SCENARIOS.crowd.main.state);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState(OFFICE_MAIN_KEY);
  const [pane, setPane] = useState<"floor" | "target">("floor");
  const [selectCount, setSelectCount] = useState(0);
  const [width, setWidth] = useState<(typeof WIDTHS)[number]>(0);
  const [view, setView] = useState<OfficeCameraView>(OFFICE_CAMERA_FIT);
  // 오피스 닫기: 대화 보기처럼 무대를 내려 Canvas·렌더 루프를 반납한다.
  const [stageOpen, setStageOpen] = useState(true);
  // 장면은 브라우저 전용이다. 서버 렌더와 첫 하이드레이션에는 그리지 않는다.
  useEffect(() => setMounted(true), []);

  const scenario = SCENARIOS[scenarioId];
  const roster = useMemo(() => {
    const makers = scenario.makers.filter((maker) => !removed.has(maker.id));
    const subagents = makers.map(snapshotOf);
    const accounts = new Map<string, OfficeMakerAccount>(makers.flatMap((maker) => (
      maker.credentialId === undefined ? [] : [[maker.id, { provider: maker.model?.split("/")[0] ?? null, credentialId: maker.credentialId }] as const]
    )));
    const seat = scenario.main.seat;
    return buildOfficeRoster({
      main: {
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        face: seat === null ? null : { seed: seat, alias: ACCOUNT_FACES[seat].alias },
        state: mainState,
      },
      subagents,
      accounts,
      resolveFace,
    });
  }, [mainState, removed, scenario]);
  const effective = resolveOfficeSelection(roster, selected);

  const select = useCallback((key: string) => {
    setSelected(key);
    setPane("target");
    setSelectCount((count) => count + 1);
  }, []);
  const pickScenario = (id: string) => {
    setScenarioId(id);
    setMainState(SCENARIOS[id].main.state);
    setRemoved(new Set());
    setSelected(OFFICE_MAIN_KEY);
    setPane("floor");
  };
  const selectedMaker = roster.participants.find((participant) => participant.key === effective && participant.kind === "maker");

  return (
    <main
      data-preview="office"
      data-preview-scenario={scenarioId}
      data-preview-selected={effective}
      data-preview-pane={pane}
      data-preview-select-count={selectCount}
      style={{ display: "flex", flexDirection: "column", gap: 8, height: "100dvh", padding: 8, boxSizing: "border-box", background: "var(--bg)", color: "var(--seed-color-fg-neutral)", fontSize: 13 }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <strong>office preview</strong>
        {Object.entries(SCENARIOS).map(([id, value]) => (
          <button key={id} type="button" data-scenario={id} aria-pressed={id === scenarioId} onClick={() => pickScenario(id)}>{value.label}</button>
        ))}
        <label>
          Main{" "}
          <select data-control="main-state" value={mainState} onChange={(event) => setMainState(event.target.value as OfficeMainState)}>
            {MAIN_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
          </select>
        </label>
        <label>
          width{" "}
          <select data-control="width" value={width} onChange={(event) => setWidth(Number(event.target.value) as (typeof WIDTHS)[number])}>
            {WIDTHS.map((value) => <option key={value} value={value}>{value === 0 ? "full" : `${value}px`}</option>)}
          </select>
        </label>
        <button
          type="button"
          data-control="remove-selected"
          disabled={!selectedMaker}
          onClick={() => selectedMaker && selectedMaker.kind === "maker" && setRemoved((current) => new Set(current).add(selectedMaker.name))}
        >
          고른 Maker 제거
        </button>
        <button type="button" data-control="toggle-stage" aria-pressed={stageOpen} onClick={() => setStageOpen((open) => !open)}>
          {stageOpen ? "오피스 닫기" : "오피스 열기"}
        </button>
        <span data-control="selection">selected={effective} pane={pane} clicks={selectCount}</span>
      </div>
      <div
        className={`chat-content-layout ${officeStyles.page}`}
        data-office-pane={pane}
        style={{ display: "flex", flex: "1 1 auto", minHeight: 0, width: width === 0 ? "100%" : width, maxWidth: "100%", border: "1px solid var(--seed-color-stroke-neutral-muted)" }}
      >
        {/* /office 와 같다: 공간과 대화가 한 칸을 번갈아 다 쓰고, 대화를 보는 동안에는 무대를 그리지 않는다. */}
        {mounted && stageOpen && pane === "floor" && (
          <OfficeStage roster={roster} selected={effective} onSelect={select} view={view} onViewChange={setView} />
        )}
        {pane === "target" && (
          // 실제 대화 칸과 같은 클래스라 office.module.css 의 보기 규칙이 그대로 걸린다.
          <aside className="chat-session-column" data-preview-target={effective} style={{ padding: 12, overflow: "auto" }}>
            <p style={{ margin: 0 }}>대화 칸 자리(미리보기에는 실제 대화가 없다)</p>
            <p style={{ margin: "4px 0 0", fontFamily: "var(--font-mono)" }}>{effective}</p>
          </aside>
        )}
      </div>
      <div style={{ width: width === 0 ? "100%" : width, maxWidth: "100%" }}>
        <OfficeRail
          roster={roster}
          selected={effective}
          onSelect={select}
          pane={pane}
          onShowFloor={() => setPane("floor")}
          selectionGone={selected !== effective}
        />
      </div>
    </main>
  );
}
