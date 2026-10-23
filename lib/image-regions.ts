/**
 * 스크린샷 확대창의 「고칠 곳 표시」 계산. 상자는 원본 그림 픽셀 좌표로 남기고, 화면 좌표는 그릴 때만 쓴다.
 * 캔버스에 그리는 일은 부르는 쪽이 하고, 여기서는 좌표·두께·여백만 정한다.
 */

export interface Point {
  x: number;
  y: number;
}

/** 원본 그림 픽셀 기준 사각형(정수). */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 화면에 그려진 그림의 자리(CSS px). `getBoundingClientRect()`와 같은 꼴이다. */
export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 이보다 짧게 끈 것은 누른 것으로 보고 상자로 만들지 않는다(CSS px, 가로·세로 각각). */
export const MIN_REGION_DRAG_CSS_PX = 6;

/** 자른 그림에 둘레로 붙이는 여백(상자 폭·높이에 대한 비율, 한쪽). */
export const REGION_CROP_PADDING = 0.12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 화면 위 점(CSS px)을 원본 픽셀 좌표로 바꾼다. 그림 밖은 가장자리로 붙인다. */
export function displayToNatural(point: Point, display: DisplayRect, natural: Size): Point {
  const sx = display.width > 0 ? natural.width / display.width : 0;
  const sy = display.height > 0 ? natural.height / display.height : 0;
  return {
    x: clamp((point.x - display.left) * sx, 0, natural.width),
    y: clamp((point.y - display.top) * sy, 0, natural.height),
  };
}

/**
 * 끈 두 점(화면 CSS px)으로 원본 픽셀 상자를 만든다. 어느 방향으로 끌어도 같고 그림 밖은 잘린다.
 * 그림 안에서 가로나 세로로 `MIN_REGION_DRAG_CSS_PX`보다 짧게 끈 것은 null이다.
 */
export function regionFromDrag(start: Point, end: Point, display: DisplayRect, natural: Size): Region | null {
  const left = clamp(Math.min(start.x, end.x), display.left, display.left + display.width);
  const right = clamp(Math.max(start.x, end.x), display.left, display.left + display.width);
  const top = clamp(Math.min(start.y, end.y), display.top, display.top + display.height);
  const bottom = clamp(Math.max(start.y, end.y), display.top, display.top + display.height);
  if (right - left < MIN_REGION_DRAG_CSS_PX || bottom - top < MIN_REGION_DRAG_CSS_PX) return null;
  const a = displayToNatural({ x: left, y: top }, display, natural);
  const b = displayToNatural({ x: right, y: bottom }, display, natural);
  const x = Math.floor(a.x);
  const y = Math.floor(a.y);
  const w = Math.min(natural.width, Math.ceil(b.x)) - x;
  const h = Math.min(natural.height, Math.ceil(b.y)) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * 표시 선의 두께(원본 px). 빨간 안쪽 선이 `inner`, 그 바깥을 감싸는 흰 선이 `outer`(양쪽 합친 전체 폭)다.
 * 큰 그림에서도 보이도록 긴 변의 0.4%를 쓰되 2px보다 가늘지 않게, 12px보다 굵지 않게 한다.
 */
export function outlineWidths(natural: Size): { inner: number; outer: number } {
  const inner = clamp(Math.round(Math.max(natural.width, natural.height) * 0.004), 2, 12);
  return { inner, outer: inner * 2 };
}

/** 번호표 글자 크기(원본 px). 선 두께에 맞춰 커지고 14px보다 작지 않다. */
export function labelFontSize(natural: Size): number {
  return Math.max(14, outlineWidths(natural).inner * 7);
}

/** 상자 하나를 자를 범위: 각 변에 상자 크기의 12% 여백을 붙이고 그림 안으로 자른다. */
export function cropRect(region: Region, natural: Size, padding = REGION_CROP_PADDING): Region {
  const padX = Math.round(region.w * padding);
  const padY = Math.round(region.h * padding);
  const x = clamp(region.x - padX, 0, natural.width);
  const y = clamp(region.y - padY, 0, natural.height);
  const right = clamp(region.x + region.w + padX, 0, natural.width);
  const bottom = clamp(region.y + region.h + padY, 0, natural.height);
  return { x, y, w: right - x, h: bottom - y };
}

/** 선을 그릴 사각형(선의 가운데 기준, 원본 px). `strokeRect(x, y, w, h)`에 그대로 넘긴다. */
export interface StrokeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 상자 바깥으로 그릴 두 선의 자리. 빨간 안쪽 선은 상자 테두리 바로 바깥, 흰 선은 그 바깥이다. 상자가
 * 그림 가장자리에 닿으면 선이 그림 밖으로 나가 잘리지 않도록 그 변의 선을 그림 안으로 들인다(그 변에서는
 * 선이 상자 안쪽 가장자리를 덮는다).
 */
export function outlineRects(region: Region, natural: Size): { outer: StrokeRect; inner: StrokeRect } {
  const { inner, outer } = outlineWidths(natural);
  const place = (offset: number, half: number): StrokeRect => {
    const left = clamp(region.x - offset, half, natural.width - half);
    const top = clamp(region.y - offset, half, natural.height - half);
    const right = clamp(region.x + region.w + offset, half, natural.width - half);
    const bottom = clamp(region.y + region.h + offset, half, natural.height - half);
    return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
  };
  return {
    inner: place(inner / 2, inner / 2),
    outer: place(inner + outer / 2, outer / 2),
  };
}

/** 원본 픽셀 상자를 화면에 겹쳐 그릴 비율(%). 창 크기가 바뀌어도 그림과 함께 움직인다. */
export function regionPercent(region: Region, natural: Size): { left: number; top: number; width: number; height: number } {
  return {
    left: (region.x / natural.width) * 100,
    top: (region.y / natural.height) * 100,
    width: (region.w / natural.width) * 100,
    height: (region.h / natural.height) * 100,
  };
}
