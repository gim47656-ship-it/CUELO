"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { aliasForSeed, avatarSrcForSeed, providerDisplayName } from "../../lib/hanse-resource-client";

/**
 * 계정 아바타.
 *
 * 사용량 패널은 계정을 한눈에 구별할 수 있어야 하는데, 그 일에 계정 주소를 쓰면 구별을
 * 위해 개인정보를 상시 노출하는 것이 된다. 그래서 구별은 얼굴과 별칭이 맡고 주소는 뒤로
 * 물러난다. 얼굴은 별칭과 같은 자리에서 고르므로 이름과 얼굴은 항상 함께 움직이고, 같은
 * 계정은 새로고침해도 같은 얼굴이다.
 *
 * 그림은 앱이 직접 서빙하는 번들 자산(`public/avatars/*.webp`)이다. 외부 아바타 서비스는
 * 계정 식별자를 제3자에게 보내는 것이라 이 작업의 목적과 정반대이고, 새 의존성이나
 * 네트워크 요청도 쓰지 않는다.
 *
 * 화면에 박히는 얼굴은 24~48px이라 그림 자체를 보기에는 작다. 눌러서 원본 한 장을 크게
 * 여는 길을 같은 컴포넌트에 둔다 — 세 화면(대화 기록·사용량 패널·사이드바 스트립)이 모두
 * 이 컴포넌트를 쓰므로 여기 한 곳이면 세 곳이 함께 열린다.
 *
 * 그림을 불러오지 못했을 때만 별칭 첫 글자 타일로 떨어진다. 깨진 이미지 아이콘을
 * 사용자에게 보이지 않는 것이 이 대체 경로의 유일한 목적이다. 장식이므로 접근성 이름은
 * 옆의 별칭·provider 텍스트가 갖는다.
 */

/** 대체 타일 색의 가짓수. 실제 색은 `globals.css` 가 SEED 팔레트 토큰으로 정한다. */
const TILE_TONES = 6;

/** 아바타 원본의 한 변. 확대 보기는 이 크기가 상한이다. */
const FULL_SIZE = 256;

export function AccountAvatar({ seed, size, provider }: { seed: number; size: number; provider?: string }) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  // 그림이 없는 계정은 이니셜 타일이다. 크게 열어 보여줄 원본이 없으므로 누르는 자리도
  // 만들지 않는다 — 빈 모달은 눌린 이유를 설명하지 못한다.
  if (failed) {
    return (
      <span
        className="account-avatar account-avatar-mono"
        data-tone={seed % TILE_TONES}
        style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
        aria-hidden="true"
      >
        {aliasForSeed(seed).slice(0, 1)}
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="account-avatar-button"
        style={{ width: size, height: size }}
        // 사이드바 스트립과 계정 카드는 행 전체가 눌리는 자리다. 얼굴을 눌렀다고 그 행의
        // 동작(사용량 열기·ON/OFF)까지 함께 일어나면 누른 사람의 의도와 어긋난다.
        onClick={(event) => {
          event.stopPropagation();
          setZoomed(true);
        }}
        aria-label={aliasForSeed(seed)}
      >
        <img
          className="account-avatar"
          src={avatarSrcForSeed(seed)}
          width={size}
          height={size}
          alt=""
          aria-hidden="true"
          draggable={false}
          onError={() => setFailed(true)}
        />
      </button>
      {zoomed && <AccountAvatarDialog seed={seed} provider={provider} onClose={() => setZoomed(false)} />}
    </>
  );
}

/**
 * 원본 한 장을 띄우는 확대 보기. 원본이 256px 한 장뿐이라 배율 조작은 두지 않는다 — 그
 * 이상은 뭉갠 그림이고, 그보다 작게 볼 이유는 화면 폭 말고는 없다. 캡션은 이 얼굴이 누구인지
 * 확인하러 연 창이라는 뜻에서 별칭과 provider 를 함께 적는다.
 */
function AccountAvatarDialog({ seed, provider, onClose }: { seed: number; provider?: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();

    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
    };
  }, []);

  const alias = aliasForSeed(seed);

  // 사이드바 스트립은 그 자체가 버튼이다. 포털로 DOM 을 옮겨도 React 이벤트는 부모
  // 컴포넌트 트리로 올라가므로, 창 안의 클릭은 여기서 끊어야 행 동작을 깨우지 않는다.
  return createPortal(
    <dialog
      ref={dialogRef}
      className="account-avatar-dialog"
      aria-label={alias}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <img
        className="account-avatar-full"
        src={avatarSrcForSeed(seed)}
        width={FULL_SIZE}
        height={FULL_SIZE}
        alt={alias}
        draggable={false}
      />
      <p className="account-avatar-caption">
        <span className="account-avatar-caption-alias">{alias}</span>
        {provider ? <span className="account-avatar-caption-provider">{providerDisplayName(provider)}</span> : null}
      </p>
      <button type="button" className="account-avatar-close" onClick={onClose}>
        {t("i18n.close")}
      </button>
    </dialog>,
    document.body,
  );
}
