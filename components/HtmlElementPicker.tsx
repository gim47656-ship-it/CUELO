import { useEffect, useMemo, useRef, useState } from "react";
import { ActionButton } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";
import { injectPickerScript, readPickMessage, type PickedElement } from "@/lib/html-element-pick";

/**
 * 파일 보기의 HTML 미리보기. 「요소 지정」이 꺼져 있으면 원문 그대로 그리고, 켜져 있으면 고르기 스크립트를
 * 덧붙인 원문을 그린다. 어느 쪽이든 `sandbox="allow-scripts"`(출처 없음)이라 미리보기는 CUELO에 닿지 않는다.
 * 켤 때마다 새 nonce로 다시 그리므로 페이지 상태는 처음으로 돌아간다.
 */
export function HtmlElementPicker({ content, title, picking, onExitPick, onRequestEdit }: {
  content: string;
  title: string;
  picking: boolean;
  onExitPick: () => void;
  onRequestEdit: (element: PickedElement) => void;
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // 고르기를 켤 때, 그리고 고르는 중에 원문이 바뀔 때마다 nonce를 새로 만든다. 이번에 그린 문서의 메시지만 받고,
  // 앞 문서에서 고른 요소는 선택 줄에서 사라진다.
  const frame = useMemo(() => {
    if (!picking) return { nonce: "", srcDoc: content };
    const nonce = crypto.randomUUID();
    return { nonce, srcDoc: injectPickerScript(content, nonce) };
  }, [picking, content]);
  const nonce = frame.nonce;
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [pickedNonce, setPickedNonce] = useState("");
  const selection = picking && pickedNonce === nonce ? picked : null;

  useEffect(() => {
    if (!picking) return;
    const onMessage = (event: MessageEvent) => {
      const message = readPickMessage(event.source, event.data, frameRef.current?.contentWindow, nonce);
      if (!message) return;
      if (message.kind === "exit") {
        onExitPick();
        return;
      }
      setPicked(message.element);
      setPickedNonce(nonce);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [nonce, onExitPick, picking]);

  return (
    <div className="html-pick-shell">
      {picking && (
        // 단추 줄은 고르기 전에도 (꺼진 채) 자리를 지킨다. 처음 고를 때 줄 높이가 바뀌어 미리보기가 밀리지 않게 한다.
        <div className="html-pick-bar" aria-label={t("files.pickedElement")} role="group">
          {selection ? (
            <p className="html-pick-summary" title={`${selection.selector}${selection.text ? `\n${selection.text}` : ""}`}>
              <span className="html-pick-tag">&lt;{selection.tag}&gt;</span>
              {selection.text && <span className="html-pick-text"> · &quot;{selection.text}&quot;</span>}
              <span className="html-pick-selector">{selection.selector}</span>
            </p>
          ) : (
            <p className="html-pick-summary html-pick-hint">{t("files.pickElementHint")}</p>
          )}
          <div className="html-pick-actions">
            <ActionButton variant="neutralSolid" size="small" disabled={!selection} onClick={() => selection && onRequestEdit(selection)}>
              {t("files.requestElementEdit")}
            </ActionButton>
            <ActionButton variant="neutralWeak" size="small" disabled={!selection} onClick={() => setPicked(null)}>
              {t("files.clearPick")}
            </ActionButton>
          </div>
        </div>
      )}
      <iframe
        key={nonce || "plain"}
        ref={frameRef}
        className="html-pick-frame"
        srcDoc={frame.srcDoc}
        sandbox="allow-scripts"
        title={title}
      />
    </div>
  );
}
