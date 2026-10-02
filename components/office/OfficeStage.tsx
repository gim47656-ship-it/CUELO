"use client";

import { Component, Suspense, lazy, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { isActiveSubagentStatus } from "@/hooks/useSubagentTranscripts";
import { OFFICE_MAIN_KEY, type OfficeParticipant, type OfficeRoster } from "@/lib/office/office-roster";
import { officeLayout, officeMainPlan, officeMakerPlan, officeRestKey } from "@/lib/office/office-stage";
import { loungeMemberName } from "../lounge/i18n";
import { OfficeFloor, useParticipantPresentation } from "./OfficeFloor";
import type { OfficeBubbleRegistry, OfficeMotion, OfficeSceneParticipant } from "./OfficeScene3D";
import { useOfficeText } from "./i18n";
import styles from "./office.module.css";

/**
 * three.js 장면은 오피스를 처음 열 때 따로 받는다. 받기를 무대가 마운트될 때마다 새로 만들어
 * 둔다 — 일시적인 청크 실패가 한 번 나도 「다시 시도」나 오피스를 다시 열면 새로 받는다.
 * (모듈에 한 번 만든 lazy 는 실패를 영원히 기억한다.)
 */
function loadScene() {
  return lazy(() => import("./OfficeScene3D"));
}

type StageSupport = "ok" | "noWebgl" | "assetFailed";

/** 3D 를 그릴 수 있는지 미리 본다. 확인용 문맥은 바로 반납해 브라우저의 문맥 한도를 쓰지 않는다. */
function detectWebgl(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

/** 장면 코드 받기·WebGL 생성 실패를 받아 카드 화면으로 넘긴다. */
class SceneBoundary extends Component<{ onFailure: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[office] 3D scene failed; falling back to seat cards", error);
    this.props.onFailure();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function isRunning(participant: OfficeParticipant): boolean {
  return participant.kind === "main" ? participant.state === "working" : isActiveSubagentStatus(participant.status);
}

export interface OfficeStageProps {
  roster: OfficeRoster;
  selected: string;
  /** 대화 칸이 공간 옆에 열려 있는지(`pane === "target"`). */
  chatOpen: boolean;
  onSelect: (key: string) => void;
  onCloseChat: () => void;
}

/**
 * 오피스 보기의 중심 공간. 이 세션의 참여자(Main·Maker·캐릭터 미확인)가 실제 상태대로 책상과
 * 러그를 오가고, 참여하지 않은 캐릭터는 휴게 구역에서 쉰다. 참여자 캐릭터나 그 말풍선을 누르면
 * 그 대상의 대화 칸이 오른쪽에 열린다 — 보는 대상만 바뀌고 아무것도 실행하지 않는다. WebGL 이
 * 없거나 장면을 못 받으면 기존 자리 카드로 그대로 떨어진다.
 */
export function OfficeStage({ roster, selected, chatOpen, onSelect, onCloseChat }: OfficeStageProps) {
  const { ot, locale } = useOfficeText();
  const present = useParticipantPresentation();
  const [support, setSupport] = useState<StageSupport>(() => (detectWebgl() ? "ok" : "noWebgl"));
  const [Scene, setScene] = useState(loadScene);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [motions, setMotions] = useState<ReadonlyMap<string, OfficeMotion>>(() => new Map());
  const [hovered, setHovered] = useState<string | null>(null);
  const bubbles = useRef<OfficeBubbleRegistry>(new Map());

  // 배치는 누가 어느 캐릭터 자리로 참여했는지가 바뀔 때만 다시 짠다(상태만 바뀌면 그대로).
  const placementKey = roster.participants.map((participant) => `${participant.key}=${participant.seat ?? "?"}`).join("|");
  const layout = useMemo(
    () => officeLayout(roster.participants.map((participant) => ({ key: participant.key, seat: participant.seat }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placementKey],
  );
  const sceneParticipants = useMemo<OfficeSceneParticipant[]>(() => roster.participants.map((participant) => ({
    key: participant.key,
    seat: participant.seat,
    plan: participant.kind === "main" ? officeMainPlan(participant.state) : officeMakerPlan(participant.status, participant.retrying),
    selected: chatOpen && participant.key === selected,
  })), [chatOpen, roster.participants, selected]);

  const markReady = useCallback(() => setReady(true), []);
  const markFailed = useCallback(() => setSupport("assetFailed"), []);
  const retry = useCallback(() => {
    setScene(loadScene);
    setReady(false);
    setAttempt((value) => value + 1);
    setSupport(detectWebgl() ? "ok" : "noWebgl");
  }, []);
  const recordMotion = useCallback((key: string, motion: OfficeMotion) => {
    setMotions((current) => (current.get(key) === motion ? current : new Map(current).set(key, motion)));
  }, []);
  const bubbleRef = useCallback((key: string) => (element: HTMLElement | null) => {
    if (element) bubbles.current.set(key, element);
    else bubbles.current.delete(key);
  }, []);

  const closeButton = chatOpen ? (
    <button type="button" className={styles.stageClose} onClick={onCloseChat} title={ot("office.closeChatTitle")}>
      {ot("office.closeChat")}
      <span aria-hidden="true">✕</span>
    </button>
  ) : null;

  if (support !== "ok") {
    return (
      <section className={styles.stage} data-stage={support} aria-label={ot("office.stage")}>
        <div className={styles.stageFallback}>
          <div className={styles.stageFallbackBar}>
            <p className={styles.stageNotice} role="status">
              {ot(support === "noWebgl" ? "office.stageNoWebgl" : "office.stageAssetFailed")}
            </p>
            {support === "assetFailed" && (
              <button type="button" className={styles.stageRetry} onClick={retry}>{ot("office.retry")}</button>
            )}
            {closeButton}
          </div>
          <OfficeFloor roster={roster} selected={selected} onSelect={onSelect} />
        </div>
      </section>
    );
  }

  const running = roster.participants.filter(isRunning).length;
  const mainMotion = motions.get(OFFICE_MAIN_KEY);
  return (
    <section
      className={styles.stage}
      data-stage={ready ? "ready" : "loading"}
      data-main-motion={mainMotion}
      aria-label={ot("office.stage")}
    >
      <div className={styles.stageCanvas} aria-hidden="true">
        <SceneBoundary key={attempt} onFailure={markFailed}>
          <Suspense fallback={null}>
            <Scene
              layout={layout}
              participants={sceneParticipants}
              bubbles={bubbles.current}
              onSelect={onSelect}
              onHover={setHovered}
              onReady={markReady}
              onMotionChange={recordMotion}
              onContextLost={markFailed}
            />
          </Suspense>
        </SceneBoundary>
      </div>
      <header className={styles.stageHeader}>
        <h2 className={styles.floorTitle}>{ot("office.stage")}</h2>
        <p className={styles.floorSummary}>{ot("office.floorSummary", { count: roster.participants.length, running })}</p>
        <p className={styles.stageHint}>{ot("office.stageHint")}</p>
      </header>
      {closeButton}
      {!ready && <p className={styles.stageLoading} role="status">{ot("office.stageLoading")}</p>}
      {/* 캐릭터 머리 위 말풍선. 참여자 것은 버튼이라 키보드·터치로도 같은 대상을 연다. 자리는
          장면이 매 프레임 옮기고, 처음 자리를 잡기 전에는 보이지 않는다. */}
      <div className={styles.bubbles} data-ready={ready ? "true" : undefined}>
        {roster.participants.map((participant) => {
          const presentation = present(participant);
          const motion = motions.get(participant.key);
          const pressed = chatOpen && participant.key === selected;
          return (
            <button
              key={participant.key}
              ref={bubbleRef(participant.key)}
              type="button"
              className={styles.bubble}
              data-key={participant.key}
              data-kind={participant.kind}
              data-tone={presentation.tone}
              data-motion={motion}
              data-hover={hovered === participant.key ? "true" : undefined}
              aria-pressed={pressed}
              title={ot("office.openChat", { name: presentation.name })}
              onClick={() => onSelect(participant.key)}
            >
              <span className={styles.bubbleName}>{presentation.name}</span>
              <span className={styles.status} data-tone={presentation.tone}>
                <span className={styles.dot} aria-hidden="true" />
                {presentation.status}
              </span>
              {motion && <span className={styles.bubbleMotion}>{ot(`office.motion.${motion}` as const)}</span>}
            </button>
          );
        })}
        {layout.rest.map((place) => {
          const key = officeRestKey(place.seat);
          return (
            <span
              key={key}
              ref={bubbleRef(key)}
              className={styles.restTag}
              data-key={key}
              data-hover={hovered === key ? "true" : undefined}
              title={ot("office.absentHint")}
            >
              <span className={styles.bubbleName}>{loungeMemberName(roster.seats[place.seat]?.alias ?? "", locale)}</span>
              <span className={styles.restStatus}>{ot("office.absent")}</span>
              <span className={styles.bubbleMotion}>{ot("office.absentHint")}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}
