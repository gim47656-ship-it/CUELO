import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { cropRect, labelFontSize, outlineRects, outlineWidths, regionFromDrag, regionPercent, type Point, type Region, type Size } from "@/lib/image-regions";

const MARK_RED = "#e5191f";
const MARK_WHITE = "#ffffff";

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const { promise, resolve, reject } = Promise.withResolvers<Blob>();
  canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas encode failed"))), "image/png");
  return promise;
}

function canvasOf(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d unavailable");
  return [canvas, context];
}

/**
 * 받은 원본 그림(같은 출처 blob이라 캔버스가 오염되지 않음)으로 두 가지를 만든다. (a) 원본 해상도 그림에
 * 모든 상자를 흰 바깥선 + 빨간 안쪽선과 번호표로 새긴 것, (b) 상자마다 12% 여백을 둔 원본 픽셀 조각(선 없음).
 * 모두 PNG다. 순서는 표시한 그림, 구역 1..n.
 */
export async function renderRegionImages(blob: Blob, regions: readonly Region[]): Promise<{ marked: Blob; crops: Blob[] }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const natural = { width: bitmap.width, height: bitmap.height };
    const { inner, outer } = outlineWidths(natural);
    const fontSize = labelFontSize(natural);
    const [markedCanvas, marked] = canvasOf(natural.width, natural.height);
    marked.drawImage(bitmap, 0, 0);
    regions.forEach((region, index) => {
      // 선은 상자 바깥쪽으로 그려 상자 안의 내용을 덮지 않는다. 흰 선이 먼저, 그 안쪽 가장자리에 빨간 선.
      // 그림 가장자리에 닿은 변은 outlineRects가 선을 그림 안으로 들여 잘리지 않게 한다.
      const rects = outlineRects(region, natural);
      marked.lineJoin = "miter";
      marked.strokeStyle = MARK_WHITE;
      marked.lineWidth = outer;
      marked.strokeRect(rects.outer.x, rects.outer.y, rects.outer.w, rects.outer.h);
      marked.strokeStyle = MARK_RED;
      marked.lineWidth = inner;
      marked.strokeRect(rects.inner.x, rects.inner.y, rects.inner.w, rects.inner.h);
      const label = String(index + 1);
      marked.font = `700 ${fontSize}px sans-serif`;
      const padX = Math.round(fontSize * 0.35);
      const labelW = Math.ceil(marked.measureText(label).width) + padX * 2;
      const labelH = Math.round(fontSize * 1.3);
      // 번호표는 상자 왼쪽 위 바깥에 붙이고, 그림 위쪽 가장자리면 상자 안쪽으로 내린다.
      const labelX = Math.min(Math.max(0, region.x - inner), natural.width - labelW);
      const above = region.y - inner - labelH;
      const labelY = above >= 0 ? above : Math.min(region.y, natural.height - labelH);
      marked.fillStyle = MARK_WHITE;
      marked.fillRect(labelX - 1, labelY - 1, labelW + 2, labelH + 2);
      marked.fillStyle = MARK_RED;
      marked.fillRect(labelX, labelY, labelW, labelH);
      marked.fillStyle = MARK_WHITE;
      marked.textBaseline = "middle";
      marked.textAlign = "center";
      marked.fillText(label, labelX + labelW / 2, labelY + labelH / 2);
    });
    const crops = await Promise.all(regions.map((region) => {
      const crop = cropRect(region, natural);
      const [canvas, context] = canvasOf(crop.w, crop.h);
      context.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      return canvasToPng(canvas);
    }));
    return { marked: await canvasToPng(markedCanvas), crops };
  } finally {
    bitmap.close();
  }
}

/**
 * 확대한 스크린샷 위에 끌어서 고칠 곳 상자를 그린다. 상자는 원본 픽셀로 부모에게 넘기고, 화면에는
 * 그림 크기에 대한 비율로 겹쳐 그려 창 크기가 바뀌어도 같은 자리에 남는다. 번호는 그린 순서다.
 */
export function ImageRegionMarker({ src, regions, max, onAdd, onNaturalSize, regionLabel }: {
  src: string;
  regions: readonly Region[];
  max: number;
  onAdd: (region: Region) => void;
  onNaturalSize: (size: Size) => void;
  regionLabel: (n: number) => string;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const dragRef = useRef<{ pointerId: number; start: Point } | null>(null);
  const [draft, setDraft] = useState<Region | null>(null);

  const regionAt = (end: Point): Region | null => {
    const image = imageRef.current;
    const drag = dragRef.current;
    if (!image || !drag || !natural) return null;
    return regionFromDrag(drag.start, end, image.getBoundingClientRect(), natural);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!natural || regions.length >= max || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY } };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    setDraft(regionAt({ x: event.clientX, y: event.clientY }));
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>, keep: boolean) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    const region = keep ? regionAt({ x: event.clientX, y: event.clientY }) : null;
    dragRef.current = null;
    setDraft(null);
    if (region) onAdd(region);
  };

  return (
    <div
      className="tool-image-marker"
      data-drawing={natural && regions.length < max ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        className="tool-image-full"
        src={src}
        alt=""
        draggable={false}
        onLoad={(event) => {
          const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
          setNatural(size);
          onNaturalSize(size);
        }}
      />
      {natural && regions.map((region, index) => (
        <RegionBox key={`${index}-${region.x}-${region.y}`} region={region} natural={natural} label={String(index + 1)} title={regionLabel(index + 1)} />
      ))}
      {natural && draft && <RegionBox region={draft} natural={natural} />}
    </div>
  );
}

function RegionBox({ region, natural, label, title }: { region: Region; natural: Size; label?: string; title?: string }) {
  const at = regionPercent(region, natural);
  return (
    <span
      className="tool-image-region"
      data-draft={label ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={title}
      style={{ left: `${at.left}%`, top: `${at.top}%`, width: `${at.width}%`, height: `${at.height}%` }}
    >
      {label && <span className="tool-image-region-number" aria-hidden="true">{label}</span>}
    </span>
  );
}
