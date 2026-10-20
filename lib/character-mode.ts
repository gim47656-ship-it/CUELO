import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { COMPLETION_AUDIO_ALIASES, CUE_TAGS, OFFICE_CUE_ROOT } from "./completion-audio";

/**
 * 「기본 / 사무실 모드」 캐릭터 세트. 서버(PC) 전체에 하나뿐인 설정이라 omp 설정이 아니라
 * `<agentDir>/cuelo-character-mode.json` 에 둔다. 사무실 모드의 캐릭터와 자산은 실존 인물에서
 * 영감을 얻을 수 있으므로 저장소·`public/`이 아니라 `<agentDir>/characters-office/` 에만 있고,
 * 이 모듈과 `/api/office-characters/` 라우트만 그 폴더를 읽는다.
 */

export type CharacterMode = "default" | "office";

export const CHARACTER_MODE_FILE_NAME = "cuelo-character-mode.json";
export const OFFICE_DIR_NAME = "characters-office";
export const OFFICE_ROSTER_FILE_NAME = "roster.json";
/** 사무실 캐릭터가 대신 앉는 자리. 나머지 자리는 두 모드 모두 기본이다. */
export const OFFICE_SEAT_ALIAS = "YUKI(유키)";

/** 사무실 자산으로 내보낼 수 있는 확장자와 content type. */
const ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".json": "application/json; charset=utf-8",
};

export interface OfficeSeatPayload {
  /** 대신 앉는 기본 자리(`YUKI(유키)`). */
  seat: string;
  id: string;
  alias: string;
  names: string[];
  faceUrl: string;
  voice: { temperament: string; expression: string };
  /** `parseCueManifest` 가 읽는 형식. `file` 은 `OFFICE_CUE_ROOT`(`/api/office-characters/`) 기준 상대 경로다. */
  manifest: { characters: Array<{ id: string; clips: OfficeClip[]; stickers: OfficeSticker[]; captions: [] }> };
}

interface OfficeClip { file: string; tag: string; ko?: string }
interface OfficeSticker { file: string; tag: string }

export interface CharacterModePayload {
  mode: CharacterMode;
  /** 이 PC에 사무실 캐릭터 세트가 있는지. 모드와 무관하게 설정 화면의 안내에 쓴다. */
  rosterAvailable: boolean;
  /** 사무실 모드일 때만 채운다. 기본 모드에서는 비어 있어 화면이 기존과 같다. */
  seats: OfficeSeatPayload[];
}

export function characterModePath(agentDir: string): string {
  return path.join(agentDir, CHARACTER_MODE_FILE_NAME);
}

export function officeDir(agentDir: string): string {
  return path.join(agentDir, OFFICE_DIR_NAME);
}

/** 파일이 없거나 읽을 수 없거나 모르는 값이면 기본 모드다. */
export function readCharacterMode(agentDir: string): CharacterMode {
  try {
    return asRecord(JSON.parse(readFileSync(characterModePath(agentDir), "utf8")))?.mode === "office" ? "office" : "default";
  } catch {
    return "default";
  }
}

export async function writeCharacterMode(agentDir: string, mode: CharacterMode): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  writePrivateFileAtomicSync(characterModePath(agentDir), `${JSON.stringify({ mode })}\n`);
}

/** 상대 경로 문자열을 `/` 조각으로 나눈다. 비었거나 절대·역슬래시·`..`·숨김 조각이 있으면 null. */
function safeSegments(relative: string): string[] | null {
  if (typeof relative !== "string" || relative === "" || relative.includes("\\") || relative.includes("\0")) return null;
  const segments = relative.split("/");
  return segments.every((segment) => segment !== "" && !segment.startsWith(".")) ? segments : null;
}

/**
 * `characters-office/` 아래 파일의 실제 경로. 조각 검증 뒤 `realpath` 로 풀어 심볼릭 링크가
 * 폴더 밖을 가리키면 거절한다. 허용 확장자가 아니거나 일반 파일이 아니면 null.
 */
export async function resolveOfficeAsset(
  agentDir: string,
  relative: string,
): Promise<{ file: string; contentType: string } | null> {
  const segments = safeSegments(relative);
  if (!segments) return null;
  const contentType = ASSET_CONTENT_TYPES[path.extname(segments[segments.length - 1]).toLowerCase()];
  if (!contentType) return null;
  try {
    const root = await realpath(officeDir(agentDir));
    const file = await realpath(path.join(root, ...segments));
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    return (await stat(file)).isFile() ? { file, contentType } : null;
  } catch {
    return null;
  }
}

/** `characters-office/` 아래 폴더의 실제 경로. 심볼릭 링크로 폴더 밖을 가리키면 null. */
async function resolveOfficeDir(agentDir: string, relative: string): Promise<string | null> {
  const segments = safeSegments(relative);
  if (!segments) return null;
  try {
    const root = await realpath(officeDir(agentDir));
    const dir = await realpath(path.join(root, ...segments));
    if (dir !== root && !dir.startsWith(root + path.sep)) return null;
    return (await stat(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function assetUrl(relative: string): string {
  return OFFICE_CUE_ROOT + relative.split("/").map(encodeURIComponent).join("/");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** `characters-office/` 안의 json 파일(같은 realpath 포함 검사를 지난 것만)을 읽는다. 어긋나면 null. */
async function readOfficeJson(agentDir: string, relative: string): Promise<unknown> {
  const asset = await resolveOfficeAsset(agentDir, relative);
  if (!asset || !asset.contentType.startsWith("application/json")) return null;
  try {
    return JSON.parse(await readFile(asset.file, "utf8"));
  } catch {
    return null;
  }
}

async function officeFileExists(agentDir: string, relative: string): Promise<boolean> {
  return (await resolveOfficeAsset(agentDir, relative)) !== null;
}

const STICKER_EXTENSIONS = [".webp", ".png"];

/**
 * 완료 음성. 대사 파일의 `file` 은 `<id>/01.wav`·`<id>/approval/01.wav` 처럼 캐릭터 id 로
 * 시작하지만 디스크는 `<audio>/01.wav`(완료)·`<audio>/<태그>/01.wav` 라서, 앞의 id 를 떼고
 * 로스터의 `audio` 폴더 아래에서 찾는다. 디스크에 없는 항목은 뺀다.
 */
async function readClips(agentDir: string, id: string, audioDir: string, linesFile: string): Promise<OfficeClip[]> {
  const lines = asRecord(await readOfficeJson(agentDir, linesFile));
  if (!Array.isArray(lines?.clips)) return [];
  const clips: OfficeClip[] = [];
  for (const raw of lines.clips) {
    const entry = asRecord(raw);
    const { file, tag, ko } = entry ?? {};
    if (typeof file !== "string" || typeof tag !== "string" || !(CUE_TAGS as readonly string[]).includes(tag)) continue;
    const rest = file.startsWith(`${id}/`) ? file.slice(id.length + 1) : file;
    const relative = `${audioDir}/${rest}`;
    if (!rest.endsWith(".wav") || !(await officeFileExists(agentDir, relative))) continue;
    const ko_ = text(ko);
    clips.push({ file: relative, tag, ...(ko_ ? { ko: ko_ } : {}) });
  }
  return clips;
}

/** 스티커는 `<stickers>/<태그>/NN.webp|png` 를 훑어 모은다. */
async function readStickers(agentDir: string, stickersDir: string): Promise<OfficeSticker[]> {
  const stickers: OfficeSticker[] = [];
  for (const tag of CUE_TAGS) {
    const dir = await resolveOfficeDir(agentDir, `${stickersDir}/${tag}`);
    if (!dir) continue;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!STICKER_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
      const relative = `${stickersDir}/${tag}/${name}`;
      if (await officeFileExists(agentDir, relative)) stickers.push({ file: relative, tag });
    }
  }
  return stickers;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** 따옴표·대괄호·꺾쇠·줄바꿈이 든 별칭은 프롬프트나 화면 문구를 깨뜨릴 수 있어 거절한다. */
const MAX_ALIAS_LENGTH = 64;
/** 말투 블록을 닫거나 새로 여는 태그가 든 항목은 프롬프트 구조를 깨뜨리므로 거절한다. */
const CHARACTER_VOICE_TAG = /<\/?character-voice/i;
const UNSAFE_ALIAS = /["'`\u201C\u201D\u2018\u2019<>\[\]\r\n]/;

/** 기본 자리의 별칭에서 부르는 이름(`YUKI(유키)` → yuki, 유키)을 뽑는다. */
function callNamesOf(alias: string): string[] {
  const open = alias.indexOf("(");
  return open < 0 ? [alias.toLowerCase()] : [alias.slice(0, open).toLowerCase(), alias.slice(open + 1, alias.indexOf(")", open)).toLowerCase()];
}

/**
 * 사무실 별칭·호출 이름이 기본 자리와 겹치는가. 별칭은 어떤 기본 별칭과도(자기 자리 포함) 같으면 안 되고,
 * 호출 이름은 다른 자리의 별칭·호출 이름과 같으면 안 된다(자기 자리 기본 이름은 괜찮다).
 */
function collidesWithBuiltIns(seat: string, alias: string, names: readonly string[]): boolean {
  if ((COMPLETION_AUDIO_ALIASES as readonly string[]).includes(alias)) return true;
  const taken = new Set(COMPLETION_AUDIO_ALIASES.filter((builtin) => builtin !== seat).flatMap((builtin) => [builtin.toLowerCase(), ...callNamesOf(builtin)]));
  return names.some((name) => taken.has(name.toLowerCase()));
}

/** 로스터 한 항목을 검증해 화면용으로 만든다. 하나라도 어긋나면 null — 그 자리는 기본으로 남는다. */
async function buildSeat(agentDir: string, seat: string, raw: unknown): Promise<OfficeSeatPayload | null> {
  const entry = asRecord(raw);
  if (!entry) return null;
  const id = text(entry.id);
  const alias = text(entry.alias);
  const face = text(entry.face);
  const voice = asRecord(entry.voice);
  const temperament = text(voice?.temperament);
  const expression = text(voice?.expression);
  if (!id || !ID_PATTERN.test(id) || !alias || alias.length > MAX_ALIAS_LENGTH || UNSAFE_ALIAS.test(alias) || !face || !temperament || !expression) return null;
  if (CHARACTER_VOICE_TAG.test(temperament) || CHARACTER_VOICE_TAG.test(expression)) return null;
  if (!Array.isArray(entry.names) || entry.names.length === 0 || !entry.names.every((name) => text(name))) return null;
  if (collidesWithBuiltIns(seat, alias, (entry.names as string[]).map((name) => name.trim()))) return null;
  if (!safeSegments(face) || !(await officeFileExists(agentDir, face))) return null;
  const stickersDir = text(entry.stickers);
  const audioDir = text(entry.audio);
  const linesFile = text(entry.audioLines);
  if ((stickersDir && !safeSegments(stickersDir)) || (audioDir && !safeSegments(audioDir)) || (linesFile && !safeSegments(linesFile))) {
    return null;
  }
  return {
    seat,
    id,
    alias,
    names: (entry.names as string[]).map((name) => name.trim()),
    faceUrl: assetUrl(face),
    voice: { temperament, expression },
    manifest: {
      characters: [{
        id,
        clips: audioDir && linesFile ? await readClips(agentDir, id, audioDir, linesFile) : [],
        stickers: stickersDir ? await readStickers(agentDir, stickersDir) : [],
        captions: [],
      }],
    },
  };
}

/** 로스터를 읽는다. 파일이 없거나 깨졌으면 빈 목록이고, 사무실 자리(`YUKI(유키)`) 밖의 항목은 무시한다. */
export async function readOfficeSeats(agentDir: string): Promise<OfficeSeatPayload[]> {
  const seats = asRecord(asRecord(await readOfficeJson(agentDir, OFFICE_ROSTER_FILE_NAME))?.seats);
  if (!seats) return [];
  const seat = await buildSeat(agentDir, OFFICE_SEAT_ALIAS, seats[OFFICE_SEAT_ALIAS]);
  return seat ? [seat] : [];
}

/** 사무실 모드여도 자리가 하나도 유효하지 않으면 기본과 같다 — 사용자에게 오류를 내지 않는다. */
export async function readCharacterModePayload(agentDir: string): Promise<CharacterModePayload> {
  const mode = readCharacterMode(agentDir);
  const seats = await readOfficeSeats(agentDir);
  return { mode, rosterAvailable: seats.length > 0, seats: mode === "office" ? seats : [] };
}
