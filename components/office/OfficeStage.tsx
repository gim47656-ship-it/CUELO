"use client";

import dynamic from "next/dynamic";
import { Component, useCallback, useState, type ReactNode } from "react";
import { OFFICE_MAIN_KEY, type OfficeMainParticipant, type OfficeRoster } from "@/lib/office/office-roster";
import { OfficeFace, OfficeFloor, useParticipantPresentation } from "./OfficeFloor";
import type { OfficeMotion } from "./OfficeScene3D";
import { useOfficeText } from "./i18n";
import styles from "./office.module.css";

// three.js 는 브라우저에서만 돈다. 서버 렌더에는 넣지 않고 오피스를 처음 열 때 따로 받는다.
const OfficeScene3D = dynamic(() => import("./OfficeScene3D"), { ssr: false });

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

/** 장면 코드·자산 로딩·WebGL 생성 실패를 받아 카드 화면으로 넘긴다. */
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

export interface OfficeStageProps {
  roster: OfficeRoster;
  selected: string;
  /** 대화 칸이 공간 옆에 열려 있는지(`pane === "target"`). */
  chatOpen: boolean;
  onSelect: (key: string) => void;
  onCloseChat: () => void;
}

/**
 * 오피스 보기의 중심 공간. Main 캐릭터를 누르면(또는 아래 버튼) 같은 Main 대화 칸이 오른쪽에
 * 열린다 — 보는 대상만 바뀌고 아무것도 실행하지 않는다. WebGL 이 없거나 자산을 못 받으면 기존
 * 자리 카드로 그대로 떨어진다.
 */
export function OfficeStage({ roster, selected, chatOpen, onSelect, onCloseChat }: OfficeStageProps) {
  const { ot } = useOfficeText();
  const present = useParticipantPresentation();
  const [support, setSupport] = useState<StageSupport>(() => (detectWebgl() ? "ok" : "noWebgl"));
  const [ready, setReady] = useState(false);
  const [motion, setMotion] = useState<OfficeMotion | null>(null);
  const main = roster.participants.find((participant): participant is OfficeMainParticipant => participant.kind === "main")!;
  const presentation = present(main);
  const mainSelected = chatOpen && selected === OFFICE_MAIN_KEY;
  const selectMain = useCallback(() => onSelect(OFFICE_MAIN_KEY), [onSelect]);
  const markReady = useCallback(() => setReady(true), []);
  const markFailed = useCallback(() => setSupport("assetFailed"), []);

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
            {closeButton}
          </div>
          <OfficeFloor roster={roster} selected={selected} onSelect={onSelect} />
        </div>
      </section>
    );
  }

  return (
    <section className={styles.stage} data-stage={ready ? "ready" : "loading"} data-main-motion={motion ?? undefined} aria-label={ot("office.stage")}>
      <div className={styles.stageCanvas} aria-hidden="true">
        <SceneBoundary onFailure={markFailed}>
          <OfficeScene3D
            mainState={main.state}
            selected={mainSelected}
            onSelectMain={selectMain}
            onReady={markReady}
            onMotionChange={setMotion}
            onContextLost={markFailed}
          />
        </SceneBoundary>
      </div>
      <header className={styles.stageHeader}>
        <h2 className={styles.floorTitle}>{ot("office.stage")}</h2>
        <p className={styles.floorSummary}>{ot("office.stageHint")}</p>
      </header>
      {closeButton}
      {!ready && <p className={styles.stageLoading} role="status">{ot("office.stageLoading")}</p>}
      <div className={styles.stageFooter}>
        <button type="button" className={styles.stageMain} aria-pressed={mainSelected} onClick={selectMain}>
          <OfficeFace seat={main.seat} size={28} />
          <span className={styles.stageMainText}>
            <span className={styles.stageMainName}>{ot("office.openChat", { name: presentation.name })}</span>
            <span className={styles.status} data-tone={presentation.tone}>
              <span className={styles.dot} aria-hidden="true" />
              {presentation.status}
              {motion && <span className={styles.stageMotion}> · {ot(`office.motion.${motion}` as const)}</span>}
            </span>
          </span>
        </button>
      </div>
    </section>
  );
}
