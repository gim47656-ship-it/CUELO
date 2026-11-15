// screen-fast-path의 순수 판정: 이미지 read가 클릭 좌표를 vision 모델에게 묻는지, 이 PC에 화면 조작 경로가 있는지,
// lab_screen_find 실패 뒤 같은 대상의 좌표 질문을 허용할지.

const IMAGE_PATH = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

// 좌표·클릭 지점을 찾는 질문. "위치" 단독은 레이아웃 판단(정렬, 겹침)과 겹치므로 클릭·찾기 동사와 묶일 때만 본다.
const COORDINATE_PATTERNS: RegExp[] = [
  /좌표/,
  /픽셀\s*(?:위치|좌표)/,
  /(?:(?:클릭|탭|선택|드래그)(?:할|해야\s*할|하는)?|누를|눌러야\s*할|누르는)\s*(?:곳|위치|지점|자리|부분|데)/,
  /어디(?:를|에|쯤)?\s*(?:클릭|눌러|누르|탭)/,
  /위치(?:를|가|는)?\s*(?:알려|찾아|말해|구해|정확히|어디)/,
  /위치[^.?!]*(?:클릭하려|클릭할게|클릭해야|누르려|누를게|눌러야)/,
  /coordinat/i,
  /\bcoords?\b/i,
  /\bpixel\s*(?:position|location|coordinates?|offset)s?\b/i,
  /\b(?:position|location)\b[^.?!]*\b(?:to|can|should|will|must|could)\s+(?:i\s+|we\s+)?(?:click|tap|press)\b/i,
  // 클릭 의도(to click, I will click, I want to click)가 위치 요청보다 앞에 오는 문장.
  /\b(?:to|i\s+will|i'll|i\s+want\s+to|so\s+(?:i|we)\s+can)\s+(?:click|tap|press)\b[^?!]*\b(?:position|location)\b/i,
  /\b(?:click|tap)\s+(?:position|location)\s+of\b/i,
  /\bbounding\s*box|\bbbox\b/i,
  /where\s+(?:\w+\s+){0,3}(?:click|tap|press)/i,
  /\b(?:click|tap)\s+(?:target|point|spot)\b/i,
  /\bx\s*[,/]\s*y\b|\bx\s+and\s+y\b/i,
];

export interface ImageQuestion {
  /** `?` 앞 경로 그대로. Linux에서는 역슬래시도 파일 이름 글자라 바꾸지 않는다. */
  target: string;
  question: string;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/** 이미지 `read`의 `?q=` 질문을 꺼낸다. `?ocr=`(글자 판독)과 질문 없는 read, URL은 대상이 아니다. */
export function imageQuestion(path: unknown): ImageQuestion | undefined {
  if (typeof path !== "string") return undefined;
  const trimmed = path.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return undefined;
  const at = trimmed.indexOf("?");
  if (at < 0) return undefined;
  const base = trimmed.slice(0, at);
  if (!IMAGE_PATH.test(base)) return undefined;
  const match = /(?:^|&)q=([^&]*)/.exec(trimmed.slice(at + 1));
  if (!match) return undefined;
  return { target: base, question: decode(match[1]) };
}

/** 휴리스틱이다. 따옴표 안 글자(버튼이나 라벨 이름)는 빼고 본다: "'Click target' 라벨이 가운데인가"는 좌표 질문이 아니다. */
export function asksCoordinates(question: string): boolean {
  const unquoted = question.replace(/'[^']*'|"[^"]*"|「[^」]*」|“[^”]*”|‘[^’]*’/g, " ");
  return COORDINATE_PATTERNS.some((pattern) => pattern.test(unquoted));
}

export const FAST_PATHS = [
  "1. 리눅스 앱(이 PC의 GTK/Qt/Electron 창): eval의 `computer` AX(AT-SPI)로 요소를 찾고 누른다.",
  "2. WinBoat VM 안 Windows 앱: skill winboat-desktop의 `scripts/vm-desktop.sh`(UIA)로 요소를 찾고 누른다.",
  "3. 그림뿐인 창(AnyDesk, RDP 캔버스, 게임): `lab_screen_find`(window, find, click)로 로컬 OCR 좌표를 받거나 바로 누른다. 약 1초.",
  "4. 원격 PC의 셸 작업: 아이콘을 클릭해 가지 말고 키보드 경로(Ctrl+Esc → powershell → 한 줄 붙여넣기)로 실행한다.",
];

export function blockReason(question: ImageQuestion): string {
  return [
    "screen-fast-path: 화면 이미지의 클릭 좌표를 vision 모델에게 묻는 read를 막았다. 한 번에 9초 안팎이 들고 좌표가 틀리거나 거부되기도 한다.",
    "빠른 경로를 이 순서로 쓴다:",
    ...FAST_PATHS,
    `\`lab_screen_find\`가 이 대상에서 결과 없음이나 실패를 돌려준 뒤에는 같은 대상(같은 이미지, 같은 찾는 글자, 같은 창 이름)의 좌표 질문이 통과한다. 지금 막힌 이미지: ${question.target}`,
    "좌표가 아닌 설명 질문(상태, 레이아웃, 오류 내용)은 `?q=`로, 글자 판독은 `?ocr=`로 그대로 read하면 된다.",
  ].join("\n");
}

/** Linux에서 화면 캡처·클릭 경로가 없으면 그 이유. Linux가 아닌 PC는 호출자가 png 모드까지 통째로 거절한다. */
export function displayProblem(env: Record<string, string | undefined>): string | undefined {
  const session = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
  // XWayland가 DISPLAY를 줘도 Wayland 창은 X11 캡처에 비어 보이므로, x11이라고 밝힌 세션만 화면 경로로 본다.
  if (session === "wayland" || (session !== "x11" && env.WAYLAND_DISPLAY)) {
    return "이 PC는 Wayland 세션이라 lab_screen_find의 화면 캡처와 XTEST 클릭을 쓸 수 없다.";
  }
  if (!env.DISPLAY) return "이 PC에는 화면 조작 경로가 없다(DISPLAY가 없는 서버나 클라우드). 기존 이미지는 png 인자로만 판독할 수 있다.";
  return undefined;
}

export interface FindFailure {
  /** 환경 실패(화면 없음, 준비 실패)는 대상과 상관없이 좌표 질문을 허용한다. */
  environment?: boolean;
  window?: string;
  find?: string;
  png?: string;
}

const norm = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/** 같은 세션의 lab_screen_find 실패 가운데 이 좌표 질문을 허용하는 것. 대상을 좁히지 않은 실패는 아무것도 허용하지 않는다. */
export function allowingFailure(failures: readonly FindFailure[], question: ImageQuestion): FindFailure | undefined {
  const asked = norm(question.question);
  const target = norm(question.target);
  return failures.find((failure) => {
    if (failure.environment) return true;
    // 경로는 Linux에서 대소문자, 공백, 역슬래시까지 다른 파일이므로 그대로 비교한다.
    if (failure.png && failure.png === question.target) return true;
    if (failure.find && norm(failure.find) && asked.includes(norm(failure.find))) return true;
    if (failure.window) {
      // lab_screen_find는 window를 창 제목 정규식으로 쓴다. 같은 정규식이 질문이나 이미지 경로에 걸려야 같은 창이다.
      // 앵커(`^AnyDesk$`)가 있으면 글 전체로는 안 걸리므로 각 필드 안의 연속 낱말 묶음(길이 제한 없음)에 대어 본다.
      // 질문과 경로는 섞지 않는다. 빈 글에도 걸리는 정규식(`.*`, `AnyDesk|`)은 대상을 좁히지 않은 것이라 아무것도 열지 않는다.
      let title: RegExp;
      try {
        title = new RegExp(failure.window, "i");
      } catch {
        return false;
      }
      if (title.test("")) return false;
      const spans = (text: string) => {
        const words = text.split(/[\s/\\]+/).map((word) => word.replace(/^[,;:'"`()[\]{}<>?!.]+|[,;:'"`()[\]{}<>?!.]+$/g, "")).filter(Boolean);
        return [text, ...words.flatMap((_, i) => words.slice(i).map((__, n) => words.slice(i, i + n + 1).join(" ")))];
      };
      // 경로는 확장자를 뗀 파일 이름도 본다(`/tmp/AnyDesk.png` → AnyDesk).
      const file = question.target.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
      if ([...spans(question.question.slice(0, 500)), ...spans(question.target), file].some((piece) => title.test(piece))) return true;
    }
    return false;
  });
}

export const SYSTEM_BLOCK = `# Screen work fast path
When you operate another app's window, use the fastest path and bundle act-wait-check into one call so each step costs one model turn:
1. Linux app on this PC: \`computer\` AX (AT-SPI) in eval.
2. Windows app in the WinBoat VM: skill winboat-desktop \`scripts/vm-desktop.sh\` (UIA).
3. Pixel-only window (AnyDesk, RDP canvas, games): \`lab_screen_find\` (local OCR, about 1 s; \`click\` presses the match).
4. Shell work on a remote PC: keyboard path (open a console, paste one line), not icon clicks.
Never ask a vision model for click coordinates: \`read <image>?q=\` coordinate questions are blocked until \`lab_screen_find\` failed on that target. \`?ocr=\` and non-coordinate questions stay open.`;
