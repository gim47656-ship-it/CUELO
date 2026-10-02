"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ACCOUNT_FACES, avatarSrcForSeed } from "@/lib/hanse-resource-client";
import { isActiveSubagentStatus } from "@/hooks/useSubagentTranscripts";
import type { OfficeParticipant, OfficeRoster } from "@/lib/office/office-roster";
import type { OfficePane } from "@/hooks/useOfficeView";
import { loungeMemberName } from "../lounge/i18n";
import { useOfficeText, type OfficeTranslate } from "./i18n";
import styles from "./office.module.css";

/** 상태 점과 글자의 색 역할. 색만으로 뜻을 나르지 않게 늘 글자와 함께 쓴다. */
type OfficeTone = "active" | "done" | "warn" | "failed" | "idle" | "unknown";

export interface ParticipantPresentation {
  name: string;
  status: string;
  tone: OfficeTone;
}

/**
 * 참여자 하나를 화면 말로. Main 의 상태는 상단 상태줄과 같은 공용 문구를, Maker 는 런타임
 * status 를 그대로 옮긴 오피스 문구를 쓴다. 실행 완료를 「완료」나 「수용」으로 바꿔 말하지 않는다.
 */
export function useParticipantPresentation(): (participant: OfficeParticipant) => ParticipantPresentation {
  const { t } = useI18n();
  const { ot, locale } = useOfficeText();
  return (participant) => {
    if (participant.kind === "main") {
      const character = participant.seat === null
        ? ot("office.faceUnknown")
        : loungeMemberName(SEAT_ALIASES[participant.seat], locale);
      const state = participant.state;
      return {
        name: ot("office.recipientMain", { name: character }),
        status: t(state === "attention" ? "workspace.mainAttention" : state === "waiting" ? "workspace.mainWaiting" : state === "working" ? "workspace.mainWorking" : "workspace.mainIdle"),
        tone: state === "attention" ? "warn" : state === "working" ? "active" : "idle",
      };
    }
    if (participant.retrying) return { name: participant.name, status: ot("office.status.retrying"), tone: "warn" };
    const tone: OfficeTone = participant.status === "failed"
      ? "failed"
      : participant.status === "aborted"
        ? "warn"
        : isActiveSubagentStatus(participant.status)
          ? "active"
          : participant.status === "completed" ? "done" : "unknown";
    return { name: participant.name, status: ot(`office.status.${participant.status}` as const), tone };
  };
}

// 자리 이름은 얼굴 목록 순서 그대로다. 문구를 여기서 다시 짓지 않는다.
const SEAT_ALIASES: readonly string[] = ACCOUNT_FACES.map((face) => face.alias);

/**
 * 자리의 얼굴. 계정 아바타와 같은 번들 그림을 쓰지만 확대 버튼은 두지 않는다 — 자리와 참여자
 * 줄은 행 전체가 버튼이라 그 안에 버튼을 또 넣을 수 없다. 캐릭터를 모르면 물음표 타일이다.
 */
export function OfficeFace({ seat, size, dim = false }: { seat: number | null; size: number; dim?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (seat === null || failed) {
    return (
      <span className={styles.face} data-unknown={seat === null ? "true" : undefined} style={{ width: size, height: size, fontSize: Math.round(size * 0.44) }} aria-hidden="true">
        {seat === null ? "?" : SEAT_ALIASES[seat].slice(0, 1)}
      </span>
    );
  }
  return (
    <img
      className={styles.face}
      data-dim={dim ? "true" : undefined}
      src={avatarSrcForSeed(seat)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function ParticipantButton({
  participant,
  selected,
  onSelect,
  presentation,
  ot,
}: {
  participant: OfficeParticipant;
  selected: boolean;
  onSelect: (key: string) => void;
  presentation: ParticipantPresentation;
  ot: OfficeTranslate;
}) {
  const step = participant.kind === "maker" && isActiveSubagentStatus(participant.status)
    ? participant.snapshot.progress?.lastIntent?.trim() || null
    : null;
  const role = participant.kind === "main" ? ot("office.main") : ot("office.maker");
  return (
    <button
      type="button"
      className={styles.seatRow}
      aria-pressed={selected}
      onClick={() => onSelect(participant.key)}
      title={step ? `${ot("office.currentStep")}: ${step}` : undefined}
    >
      <span className={styles.seatRowHead}>
        <span className={styles.role} data-kind={participant.kind}>{role}</span>
        {participant.kind === "maker" && <span className={styles.seatRowName}>{participant.name}</span>}
      </span>
      <span className={styles.status} data-tone={presentation.tone}>
        <span className={styles.dot} aria-hidden="true" />
        {presentation.status}
      </span>
      {step && <span className={styles.step}>{step}</span>}
    </button>
  );
}

export interface OfficeFloorProps {
  roster: OfficeRoster;
  selected: string;
  onSelect: (key: string) => void;
}

/**
 * 오피스 자리판. 3D 공간(`OfficeStage`)을 그릴 수 없을 때 그 자리에 펼친다. 일곱 자리는 늘 같은
 * 순서로 놓이고, 이 세션에 실제로 참여한 사람이 있는 자리만 채워진다. 빈 자리는 비어 보이게
 * 둔다 — 참여 수를 꾸며 내지 않는다.
 */
export function OfficeFloor({ roster, selected, onSelect }: OfficeFloorProps) {
  const { ot, locale } = useOfficeText();
  const present = useParticipantPresentation();
  const running = roster.participants.filter((participant) => (
    participant.kind === "main" ? participant.state === "working" : isActiveSubagentStatus(participant.status)
  )).length;
  return (
    <section className={styles.floor} aria-label={ot("office.floor")}>
      <header className={styles.floorHeader}>
        <h2 className={styles.floorTitle}>{ot("office.floor")}</h2>
        <p className={styles.floorSummary}>{ot("office.floorSummary", { count: roster.participants.length, running })}</p>
      </header>
      <ul className={styles.desks}>
        {roster.seats.map((seat) => {
          const occupied = seat.participants.length > 0;
          const selectedHere = seat.participants.some((participant) => participant.key === selected);
          return (
            <li key={seat.seat} className={styles.desk} data-occupied={occupied ? "true" : undefined} data-selected={selectedHere ? "true" : undefined}>
              <div className={styles.deskPlate}>
                <OfficeFace seat={seat.seat} size={36} dim={!occupied} />
                <span className={styles.deskName}>{loungeMemberName(seat.alias, locale)}</span>
              </div>
              {occupied
                ? seat.participants.map((participant) => (
                  <ParticipantButton
                    key={participant.key}
                    participant={participant}
                    selected={participant.key === selected}
                    onSelect={onSelect}
                    presentation={present(participant)}
                    ot={ot}
                  />
                ))
                : <span className={styles.deskEmpty}>{ot("office.seatEmpty")}</span>}
            </li>
          );
        })}
      </ul>
      {roster.unnamed.length > 0 && (
        <section className={styles.unnamed} aria-label={ot("office.unnamed")}>
          <h3 className={styles.unnamedTitle}>{ot("office.unnamed")}</h3>
          <p className={styles.unnamedHint}>{ot("office.unnamedHint")}</p>
          <div className={styles.unnamedList}>
            {roster.unnamed.map((participant) => (
              <div key={participant.key} className={styles.unnamedItem}>
                <OfficeFace seat={null} size={28} />
                <ParticipantButton
                  participant={participant}
                  selected={participant.key === selected}
                  onSelect={onSelect}
                  presentation={present(participant)}
                  ot={ot}
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

export interface OfficeRailProps {
  roster: OfficeRoster;
  selected: string;
  onSelect: (key: string) => void;
  /** `floor` 면 공간만, `target` 이면 고른 대상의 대화 칸이 열려 있다. */
  pane: OfficePane;
  /** 대화 칸을 접고 공간으로 돌아간다. */
  onShowFloor: () => void;
}

/**
 * 하단 참여자 줄. 자리판의 선택과 같은 상태를 가리키고, 맨 앞에는 입력이 실제로 가는 곳을 늘
 * 적는다. 여기서 누구를 골라도 받는 사람은 바뀌지 않는다 — 보는 대상만 바뀐다.
 */
export function OfficeRail({ roster, selected, onSelect, pane, onShowFloor }: OfficeRailProps) {
  const { ot } = useOfficeText();
  const present = useParticipantPresentation();
  const main = roster.participants[0];
  return (
    <nav className={styles.rail} aria-label={ot("office.participants")}>
      <div className={styles.recipient}>
        <span className={styles.recipientLabel}>{ot("office.recipient")}</span>
        <OfficeFace seat={main.seat} size={22} />
        <strong className={styles.recipientName}>{present(main).name}</strong>
      </div>
      <div className={styles.chips} role="group" aria-label={ot("office.participants")}>
        <button type="button" className={styles.chip} aria-pressed={pane === "floor"} onClick={onShowFloor}>
          <span className={styles.chipName}>{ot("office.showFloor")}</span>
        </button>
        {roster.participants.map((participant) => {
          const presentation = present(participant);
          return (
            <button
              key={participant.key}
              type="button"
              className={styles.chip}
              aria-pressed={participant.key === selected && pane === "target"}
              onClick={() => onSelect(participant.key)}
            >
              <OfficeFace seat={participant.seat} size={22} />
              <span className={styles.chipName}>{presentation.name}</span>
              <span className={styles.status} data-tone={presentation.tone}>
                <span className={styles.dot} aria-hidden="true" />
                <span className={styles.chipStatus}>{presentation.status}</span>
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
