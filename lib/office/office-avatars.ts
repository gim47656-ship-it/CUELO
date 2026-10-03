/**
 * 오피스 캐릭터의 개인 VRM 모델. 모델 파일은 공개 소스·설치본에 들어 있지 않다 — 사용자가 agent
 * 데이터 디렉터리의 `office-avatars/<id>.vrm` 에 넣어 둔 것만 서버가 이 고정 ID 로 내준다. 순서는
 * 오피스 자리 번호(`ACCOUNT_FACES`: RIN·MIO·NOVA·YUKI·ISANA·SHION·HIKARI)와 같다.
 */
export const OFFICE_AVATAR_IDS = ["rin", "mio", "nova", "yuki", "isana", "shion", "hikari"] as const;

export type OfficeAvatarId = (typeof OFFICE_AVATAR_IDS)[number];

/** agent 데이터 디렉터리 아래 모델을 두는 폴더 이름. */
export const OFFICE_AVATAR_DIR = "office-avatars";

/** 설치된 모델 목록을 돌려주는 주소. 모델 하나는 `<이 주소>/<id>` 다. */
export const OFFICE_AVATARS_API = "/api/office-avatars";

/** `GET /api/office-avatars` 응답: 이 설치에서 받을 수 있는 모델. */
export interface OfficeAvatarManifest {
  available: OfficeAvatarId[];
}

/** 고정 목록에 있는 이름만 ID 로 받는다. 경로·대소문자 변형·확장자는 모두 거절한다. */
export function parseOfficeAvatarId(value: string): OfficeAvatarId | null {
  return (OFFICE_AVATAR_IDS as readonly string[]).includes(value) ? (value as OfficeAvatarId) : null;
}

/** 캐릭터 자리 번호의 모델 ID. 자리를 모르면(null) 모델도 없다. */
export function officeAvatarForSeat(seat: number | null): OfficeAvatarId | null {
  return seat === null ? null : OFFICE_AVATAR_IDS[seat % OFFICE_AVATAR_IDS.length];
}
