"use client";

import { useEffect, useRef } from "react";
import { CUE_TAG_MEANING, type CueTag } from "@/lib/completion-audio";

interface Props {
  /** 스티커 이미지 경로. 자산이 아직 없으면 null이고, 그때는 말풍선만 뜬다. */
  sticker: string | null;
  /** 이번 큐가 낸 대사의 한국어 표기. 합성 음성은 일본어라 화면은 이 줄을 읽는다. */
  text: string | null;
  tag: CueTag;
  /** 마운트 순간 이 값이 true일 때만 보이는 자리로 끌어온다. 사용자가 위로 스크롤해 따라가기를 멈췄으면 끌지 않는다. */
  followRef?: { readonly current: boolean };
}

/**
 * 캐릭터 알림의 화면 쪽 — 스티커와 그 대사 말풍선.
 *
 * 대화 흐름 안, 방금 말한 캐릭터 메시지 바로 아래에 캐릭터 쪽(왼쪽)으로 붙는다. 입력창 위에
 * 떠 있으면 대화와 따로 놀아 누가 한 말인지 흐려진다.
 * 글자는 이미지에 굽지 않고 여기서 CSS로 그린다. 생성 모델이 한글을 제대로 못 그리기도 하고,
 * 화면에서 그려야 테마·폰트 크기·줄바꿈이 나머지 UI와 같은 규칙을 따른다.
 */
export function CueBubble({ sticker, text, tag, followRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // 새로 박힌 스티커만 보이는 자리로 끌어온다. 다시 붙는 옛 스티커는 "nearest"라 움직이지 않는다.
  useEffect(() => {
    if (followRef && !followRef.current) return;
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 순간의 따라가기 상태만 본다.
  }, []);
  if (!sticker && !text) return null;
  return (
    <div ref={ref} className="cue-bubble-dock" role="status" aria-live="polite">
      {sticker && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="cue-bubble-sticker"
          src={sticker}
          alt={CUE_TAG_MEANING[tag]}
        />
      )}
      {text && <p className={sticker ? "cue-bubble" : "cue-bubble cue-bubble--solo"}>{text}</p>}
      {sticker && <style jsx global>{`
        .cue-bubble-sticker {
          transform-origin: center 75%;
          animation: cue-sticker-pop 200ms cubic-bezier(0, 0, 0.15, 1) both;
        }
        @keyframes cue-sticker-pop {
          from { opacity: 0; transform: scale(.88); }
          to { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .cue-bubble-sticker { animation: none; }
        }
      `}</style>}
    </div>
  );
}
