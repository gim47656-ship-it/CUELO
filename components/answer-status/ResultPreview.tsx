"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { ActionButton } from "@seed-design/react";
import type { Deliverable } from "@/lib/answer-status/deliverables";
import { encodeFilePathForApi, getFileName } from "@/lib/file-paths";
import { TurnWrittenFiles } from "../TurnWrittenFiles";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { useAnswerStatusText } from "./i18n";

function fileUrl(filePath: string, type: "read" | "preview", sessionId: string | null | undefined): string {
  const query = new URLSearchParams({ type });
  if (sessionId) query.set("sessionId", sessionId);
  return `/api/files/${encodeFilePathForApi(filePath)}?${query}`;
}

/** 화면에 가까워질 때 한 번만 참이 된다. 긴 대화의 지난 카드마다 미리보기를 한꺼번에 불러오지 않는다. */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: "200px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

type LoadState = { kind: "loading" } | { kind: "ready"; content: string } | { kind: "failed" };

/**
 * 미리보기를 틀기 전에 주소를 한 번 확인한다. `json`은 파일 보기 JSON의 `content`(HTML 원문), `text`는
 * 응답 본문(DOCX를 바꾼 HTML), `head`는 응답이 정상인지만 본다(PDF). 실패 응답의 오류 JSON이나 브라우저
 * 오류 화면을 판 안에 그리지 않는다.
 */
function useCheckedPreview(url: string, read: "json" | "text" | "head"): LoadState {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    fetch(url, { method: read === "head" ? "HEAD" : "GET", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        if (read === "head") return "";
        if (read === "text") return response.text();
        const data = (await response.json()) as { content?: unknown };
        return typeof data.content === "string" ? data.content : null;
      })
      .then((content) => {
        if (!controller.signal.aborted) setState(content === null ? { kind: "failed" } : { kind: "ready", content });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "failed" });
      });
    return () => controller.abort();
  }, [url, read]);
  return state;
}

function FrameNote({ messageKey }: { messageKey: "result.previewLoading" | "result.previewFailed" }) {
  const { st } = useAnswerStatusText();
  return <p className="answer-result-fallback" role={messageKey === "result.previewLoading" ? "status" : undefined}>{st(messageKey)}</p>;
}

/** 사용자가 받은 것을 파일 이름 없이 알 수 있게 부르는 이름. */
function kindLabelKey(deliverable: Deliverable): "result.kind.html" | "result.kind.pdf" | "result.kind.document" | "result.kind.image" {
  if (deliverable.kind === "html") return "result.kind.html";
  if (deliverable.kind === "image") return "result.kind.image";
  return deliverable.filePath.toLowerCase().endsWith(".pdf") ? "result.kind.pdf" : "result.kind.document";
}

function PreviewMedia({ deliverable, sessionId, title }: { deliverable: Deliverable; sessionId?: string | null; title: string }) {
  const { filePath, kind } = deliverable;
  // 주소마다 새로 그린다. 다른 파일로 바뀌면 이전 파일의 받은 상태·실패·내용이 한 번도 비치지 않는다.
  if (kind === "image") {
    const src = fileUrl(filePath, "read", sessionId);
    return <ImagePreview key={src} src={src} title={title} />;
  }
  if (kind === "html") {
    const url = fileUrl(filePath, "read", sessionId);
    return <HtmlFrame key={url} url={url} title={title} />;
  }
  if (filePath.toLowerCase().endsWith(".pdf")) {
    const url = fileUrl(filePath, "read", sessionId);
    return <PdfFrame key={url} url={url} title={title} />;
  }
  const url = fileUrl(filePath, "preview", sessionId);
  return <DocxFrame key={url} url={url} title={title} />;
}

function HtmlFrame({ url, title }: { url: string; title: string }) {
  const state = useCheckedPreview(url, "json");
  if (state.kind !== "ready") return <FrameNote messageKey={state.kind === "failed" ? "result.previewFailed" : "result.previewLoading"} />;
  // 파일 보기의 HTML 미리보기와 같은 격리: 스크립트는 돌지만 CUELO 출처에는 닿지 않는다. 미리보기 안은
  // 초점·클릭을 받지 않는다(inert). 여는 것은 위의 덮개와 「결과 보기」 단추다.
  return <iframe className="answer-result-media" srcDoc={state.content} sandbox="allow-scripts" title={title} scrolling="no" inert />;
}

/** 파일 보기의 문서 미리보기와 같은 원본 PDF. 없는 파일이면 브라우저 오류 화면 대신 안내를 보인다. */
function PdfFrame({ url, title }: { url: string; title: string }) {
  const state = useCheckedPreview(url, "head");
  if (state.kind !== "ready") return <FrameNote messageKey={state.kind === "failed" ? "result.previewFailed" : "result.previewLoading"} />;
  return <iframe className="answer-result-media" src={`${url}#toolbar=0&view=FitH`} title={title} inert />;
}

/** 서버가 DOCX를 바꾼 HTML(스크립트 없음, 그림은 data URI). 바꾸기에 실패하면 오류 JSON 대신 안내를 보인다. */
function DocxFrame({ url, title }: { url: string; title: string }) {
  const state = useCheckedPreview(url, "text");
  if (state.kind !== "ready") return <FrameNote messageKey={state.kind === "failed" ? "result.previewFailed" : "result.previewLoading"} />;
  return <iframe className="answer-result-media" srcDoc={state.content} sandbox="allow-same-origin" title={title} inert />;
}

function ImagePreview({ src, title }: { src: string; title: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (state === "failed") return <FrameNote messageKey="result.previewFailed" />;
  return (
    <>
      {state === "loading" ? <FrameNote messageKey="result.previewLoading" /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="answer-result-media" data-fit="contain" src={src} alt={title} draggable={false} hidden={state === "loading"} onLoad={() => setState("ready")} onError={() => setState("failed")} />
    </>
  );
}

/**
 * 결과 카드 맨 앞의 결과물 칸. 이 턴이 만든 화면·문서·이미지 하나를 크게 미리 보이고, 「결과 보기」는
 * 기존 파일 보기(`onOpenFile`)로 연다. 나머지 결과물은 아래에 파일 단추로 남는다.
 */
export function ResultPreview({ deliverables, onOpenFile }: {
  deliverables: readonly Deliverable[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { sessionId } = useContext(AnswerStatusContext);
  const { st } = useAnswerStatusText();
  const [frameRef, near] = useNearViewport<HTMLDivElement>();
  const [primary, ...others] = deliverables;
  if (!primary) return null;
  const name = getFileName(primary.filePath);
  const title = st("result.previewTitle", { name });
  const open = onOpenFile ? () => onOpenFile(primary.filePath) : undefined;

  return (
    <section className="answer-result" aria-label={st("result.label")}>
      <div ref={frameRef} className="answer-result-frame" data-kind={primary.kind}>
        {near && <PreviewMedia deliverable={primary} sessionId={sessionId} title={title} />}
        {open && (
          // 미리보기 위 어디를 눌러도 연다. 키보드·화면 읽기는 아래 「결과 보기」 단추 하나로 간다.
          <button type="button" className="answer-result-cover" tabIndex={-1} aria-hidden="true" onClick={open} />
        )}
      </div>
      <div className="answer-result-bar">
        <span className="answer-result-title">
          <span className="answer-result-kind">{st(kindLabelKey(primary))}</span>
          <span className="answer-result-name" title={primary.filePath}>{name}</span>
        </span>
        {open && (
          <ActionButton
            className="answer-result-open"
            variant="neutralSolid"
            size="medium"
            onClick={open}
            aria-label={st("result.openNamed", { name })}
          >
            {st("result.open")}
          </ActionButton>
        )}
      </div>
      {others.length > 0 && (
        <div className="answer-result-more">
          <span className="answer-result-more-label">{st("result.more", { count: others.length })}</span>
          <TurnWrittenFiles files={others.map(({ filePath }) => ({ filePath }))} onOpenFile={onOpenFile} />
        </div>
      )}
    </section>
  );
}
