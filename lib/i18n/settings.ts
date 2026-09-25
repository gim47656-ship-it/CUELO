import koreanSettingsJson from "./settings-ko.json";
import type { SettingsResponse } from "../settings-api";

interface SettingsFieldTranslation {
  readonly label: string;
  readonly description: string;
}

interface SettingsLocaleMetadata {
  readonly tabs: Readonly<Record<string, string>>;
  readonly groups: Readonly<Record<string, string>>;
  readonly shell: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, SettingsFieldTranslation>>;
}

/** 한국어 설정 화면의 탭, 그룹, shell 문구, 필드 메타데이터. */
export const koreanSettingsMetadata: SettingsLocaleMetadata = koreanSettingsJson;

/** 설정 API 응답의 정적 메타데이터만 한국어로 변환한다. */
export function translateSettingsResponseToKorean(response: SettingsResponse): SettingsResponse {
  for (const tab of response.tabs) {
    tab.label = koreanSettingsMetadata.tabs[tab.id] ?? tab.label;
    for (let index = 0; index < tab.groups.length; index++) {
      const group = tab.groups[index];
      tab.groups[index] = koreanSettingsMetadata.groups[group] ?? group;
    }
  }

  for (const field of response.fields) {
    const translation = koreanSettingsMetadata.fields[field.path];
    if (translation) {
      field.label = translation.label;
      field.description = translation.description;
    }
    if (field.group) field.group = koreanSettingsMetadata.groups[field.group] ?? field.group;
  }

  return response;
}
