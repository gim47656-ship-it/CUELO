"use client";

import { Component, Suspense, lazy, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { isActiveSubagentStatus } from "@/hooks/useSubagentTranscripts";
import { officeBodies, type OfficeParticipant, type OfficeRoster } from "@/lib/office/office-roster";
import { officeLayout, officeMainPlan, officeMakerPlan, officeRestKey } from "@/lib/office/office-stage";
import {
  OFFICE_CAMERA_FIT,
  OFFICE_ZOOM_MAX,
  canPanOfficeView,
  panOfficeView,
  stepOfficeView,
  zoomOfficeView,
  type OfficeCameraView,
} from "@/lib/office/office-camera";
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
  /** 자리 카드(WebGL 대체)에 표시할 고른 대상. */
  selected: string;
  onSelect: (key: string) => void;
  /** 맞춤 대비 확대 배율과 바라보는 점. 대화 보기에 다녀와도 그대로 남게 부모가 든다. */
  view: OfficeCameraView;
  onViewChange: (update: (view: OfficeCameraView) => OfficeCameraView) => void;
}

/** 옮기기 버튼: 방향(바닥 x·z)과 문구 키, 위쪽 화살표를 돌릴 각도. */
const PAN_BUTTONS = [
  { dx: 0, dz: -1, label: "office.panUp", turn: 0 },
  { dx: -1, dz: 0, label: "office.panLeft", turn: -90 },
  { dx: 1, dz: 0, label: "office.panRight", turn: 90 },
  { dx: 0, dz: 1, label: "office.panDown", turn: 180 },
] as const;

/** 보기 조작 버튼의 선 아이콘. 헤더 아이콘과 같은 24 격자·2px 선이며 이름은 버튼 쪽이 단다. */
function ToolIcon({ path, turn = 0 }: { path: string; turn?: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={turn ? { transform: `rotate(${turn}deg)` } : undefined}>
      <path d={path} />
    </svg>
  );
}

/**
 * 오피스 화면의 중심 공간. 이 세션의 참여자(Main·Maker·캐릭터 미확인)가 실제 상태대로 책상과
 * 러그를 오가고, 참여하지 않은 캐릭터는 휴게 구역에서 쉰다. 참여자 캐릭터나 그 말풍선을 누르면
 * 그 대상의 대화 보기로 넘어간다 — 보는 대상만 바뀌고 아무것도 실행하지 않는다. 확대·옮기기는
 * 버튼으로도, 확대한 장면을 끌어서도 한다. WebGL 이 없거나 장면을 못 받으면 기존 자리 카드로
 * 그대로 떨어진다.
 */
export function OfficeStage({ roster, selected, onSelect, view, onViewChange }: OfficeStageProps) {
  const { ot, locale } = useOfficeText();
  const present = useParticipantPresentation();
  const [support, setSupport] = useState<StageSupport>(() => (detectWebgl() ? "ok" : "noWebgl"));
  const [Scene, setScene] = useState(loadScene);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [motions, setMotions] = useState<ReadonlyMap<string, OfficeMotion>>(() => new Map());
  const [hovered, setHovered] = useState<string | null>(null);
  const bubbles = useRef<OfficeBubbleRegistry>(new Map());
  // 말풍선이 밑으로 들어가 가려지면 안 되는 머리글·닫기 버튼.
  const reserved = useRef<OfficeBubbleRegistry>(new Map());

  // 한 캐릭터는 작업이 몇 개든 몸 하나다. 장면·말풍선은 몸 단위이고, 작업 하나하나는 몸의 줄·참여자
  // 줄·자리 카드에서 따로 고른다.
  const bodies = useMemo(() => officeBodies(roster), [roster]);
  // 배치는 어느 몸이 방에 있는지가 바뀔 때만 다시 짠다(상태나 대표 작업만 바뀌면 그대로).
  const placementKey = bodies.map((body) => body.key).join("|");
  const layout = useMemo(
    () => officeLayout(bodies.map((body) => ({ key: body.key, seat: body.seat }))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placementKey],
  );
  const sceneParticipants = useMemo<OfficeSceneParticipant[]>(() => bodies.map(({ key, seat, lead }) => ({
    key,
    seat,
    plan: lead.kind === "main" ? officeMainPlan(lead.state) : officeMakerPlan(lead.status, lead.retrying),
  })), [bodies]);

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
  const reservedRef = useCallback((key: string) => (element: HTMLElement | null) => {
    if (element) reserved.current.set(key, element);
    else reserved.current.delete(key);
  }, []);
  const pan = useCallback((dx: number, dz: number) => {
    onViewChange((current) => panOfficeView(current, dx, dz));
  }, [onViewChange]);
  // 몸을 누르면: 작업이 하나면 그 작업을 열고, 여럿이면 말풍선의 첫 작업 줄에 초점을 둔다 — 어느 작업을
  // 볼지는 사용자가 줄에서 고른다(대표 작업을 대신 열지 않는다).
  const selectBody = useCallback((key: string) => {
    const body = bodies.find((candidate) => candidate.key === key);
    if (!body) return;
    if (body.members.length === 1) onSelect(body.members[0].key);
    else bubbles.current.get(key)?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [bodies, onSelect]);

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
          </div>
          <OfficeFloor roster={roster} selected={selected} onSelect={onSelect} />
        </div>
      </section>
    );
  }

  const running = roster.participants.filter(isRunning).length;
  const mainMotion = motions.get(bodies.find((body) => body.members.some((member) => member.kind === "main"))?.key ?? "");
  const zoomed = view.zoom > 1;
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
              reserved={reserved.current}
              view={view}
              onPan={pan}
              onSelect={selectBody}
              onHover={setHovered}
              onReady={markReady}
              onMotionChange={recordMotion}
              onContextLost={markFailed}
            />
          </Suspense>
        </SceneBoundary>
      </div>
      <header ref={reservedRef("header")} className={styles.stageHeader}>
        <h2 className={styles.floorTitle}>{ot("office.stage")}</h2>
        <p className={styles.floorSummary}>{ot("office.floorSummary", { count: roster.participants.length, running })}</p>
        <p className={styles.stageHint}>{ot(zoomed ? "office.stageHintZoomed" : "office.stageHint")}</p>
      </header>
      {/* 보기 조작. 끌기만으로 둘러보지 않아도 되게 확대·축소·전체 보기와 옮기기를 버튼으로 둔다. */}
      <div ref={reservedRef("tools")} className={styles.stageTools} role="group" aria-label={ot("office.viewControls")}>
        <div className={styles.toolRow}>
          <button
            type="button"
            className={styles.toolButton}
            onClick={() => onViewChange((current) => zoomOfficeView(current, -1))}
            disabled={!zoomed}
            aria-label={ot("office.zoomOut")}
            title={ot("office.zoomOut")}
          >
            <ToolIcon path="M5 12h14" />
          </button>
          <button
            type="button"
            className={styles.toolButton}
            data-control="zoom-fit"
            onClick={() => onViewChange(() => OFFICE_CAMERA_FIT)}
            disabled={!zoomed}
            title={ot("office.zoomFitTitle")}
            aria-label={`${ot("office.zoomFit")} (${ot("office.zoomLevel", { percent: Math.round(view.zoom * 100) })})`}
          >
            {ot("office.zoomLevel", { percent: Math.round(view.zoom * 100) })}
          </button>
          <button
            type="button"
            className={styles.toolButton}
            onClick={() => onViewChange((current) => zoomOfficeView(current, 1))}
            disabled={view.zoom >= OFFICE_ZOOM_MAX}
            aria-label={ot("office.zoomIn")}
            title={ot("office.zoomIn")}
          >
            <ToolIcon path="M12 5v14M5 12h14" />
          </button>
        </div>
        {zoomed && (
          <div className={styles.toolPad}>
            {PAN_BUTTONS.map((button) => (
              <button
                key={button.label}
                type="button"
                className={styles.toolButton}
                data-pan={`${button.dx},${button.dz}`}
                onClick={() => onViewChange((current) => stepOfficeView(current, button.dx, button.dz))}
                disabled={!canPanOfficeView(view, button.dx, button.dz)}
                aria-label={ot(button.label)}
                title={ot(button.label)}
              >
                <ToolIcon path="M12 19V5M5 12l7-7 7 7" turn={button.turn} />
              </button>
            ))}
          </div>
        )}
      </div>
      {!ready && <p className={styles.stageLoading} role="status">{ot("office.stageLoading")}</p>}
      {/* 캐릭터 머리 위 말풍선. 몸마다 하나이고, 작업이 하나면 말풍선이 버튼, 여럿이면 작업마다 버튼 한
          줄이라 키보드·터치로도 같은 작업을 연다. 자리는 장면이 매 프레임 옮기고, 처음 자리를 잡기 전에는
          보이지 않는다. 확대해서 화면 밖으로 나간 캐릭터의 말풍선은 무대 가장자리에 붙어 남는다. */}
      <div className={styles.bubbles} data-ready={ready ? "true" : undefined}>
        {bodies.map((body) => {
          const motion = motions.get(body.key);
          const motionText = motion && <span className={styles.bubbleMotion}>{ot(`office.motion.${motion}` as const)}</span>;
          if (body.members.length === 1) {
            const [participant] = body.members;
            const presentation = present(participant);
            return (
              <button
                key={body.key}
                ref={bubbleRef(body.key)}
                type="button"
                className={styles.bubble}
                data-key={body.key}
                data-participant={participant.key}
                data-kind={participant.kind}
                data-tone={presentation.tone}
                data-motion={motion}
                data-hover={hovered === body.key ? "true" : undefined}
                title={ot("office.openChat", { name: presentation.name })}
                onClick={() => onSelect(participant.key)}
              >
                <span className={styles.bubbleName}>{presentation.name}</span>
                <span className={styles.status} data-tone={presentation.tone}>
                  <span className={styles.dot} aria-hidden="true" />
                  {presentation.status}
                </span>
                {motionText}
              </button>
            );
          }
          const name = loungeMemberName(roster.seats[body.seat ?? -1]?.alias ?? "", locale);
          return (
            <div
              key={body.key}
              ref={bubbleRef(body.key)}
              role="group"
              aria-label={name}
              className={styles.bubble}
              data-key={body.key}
              data-group="true"
              data-motion={motion}
              data-hover={hovered === body.key ? "true" : undefined}
            >
              <span className={styles.bubbleName}>{name}</span>
              {body.members.map((participant) => {
                const presentation = present(participant);
                return (
                  <button
                    key={participant.key}
                    type="button"
                    className={styles.bubbleTask}
                    data-participant={participant.key}
                    title={ot("office.openChat", { name: presentation.name })}
                    onClick={() => onSelect(participant.key)}
                  >
                    <span className={styles.bubbleTaskName}>{presentation.name}</span>
                    <span className={styles.status} data-tone={presentation.tone}>
                      <span className={styles.dot} aria-hidden="true" />
                      {presentation.status}
                    </span>
                  </button>
                );
              })}
              {motionText}
            </div>
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
