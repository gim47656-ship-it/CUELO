import { join } from "path";
import { invalidateModelsCache } from "./models-cache";
import { getOmpRuntime, invalidateOmpRuntime } from "./omp-runtime";
import { getAgentDir } from "./session-reader";
import { createLiveVoiceService, type LiveVoiceKeyStore, type LiveVoiceService } from "./live-character-voice";

/**
 * 서버 프로세스 하나에 하나뿐인 통화 음성 서비스.
 *
 * 키는 CLI와 같은 AuthStorage(`cartesia` api_key)에 둔다 — 기존 API 키 라우트와 같은 저장소·락이다.
 * Cartesia는 모델 provider가 아니라 provider 목록·사용량 화면에는 나오지 않는다.
 * voice 매핑은 `<agentDir>/cuelo-live-voices.json`(0600, 원자적 교체)에 키 지문별로 둔다.
 */

export const LIVE_VOICE_KEY_PROVIDER = "cartesia";
export const LIVE_VOICE_STATE_FILE = "cuelo-live-voices.json";

const authStorageKeys: LiveVoiceKeyStore = {
  async read() {
    const { authStorage } = await getOmpRuntime();
    const credential = authStorage.credentials.get(LIVE_VOICE_KEY_PROVIDER);
    return credential?.type === "api_key" && credential.key ? credential.key : undefined;
  },
  // 다른 자격 증명 변경 경로(`/api/auth/api-key`, login, logout)와 같이 바꾼 뒤 runtime·모델 캐시를 버린다.
  async write(key) {
    const { authStorage } = await getOmpRuntime();
    await authStorage.credentials.set(LIVE_VOICE_KEY_PROVIDER, { type: "api_key", key, source: "login" });
    invalidateModelsCache();
    invalidateOmpRuntime();
  },
  async remove() {
    const { authStorage } = await getOmpRuntime();
    await authStorage.credentials.remove(LIVE_VOICE_KEY_PROVIDER);
    invalidateModelsCache();
    invalidateOmpRuntime();
  },
};

declare global {
  var __liveVoiceService: LiveVoiceService | undefined;
}

export function getLiveVoiceService(): LiveVoiceService {
  // `next start`는 패키지 폴더를 cwd로 띄우므로 번들 public 자산이 여기 있다.
  globalThis.__liveVoiceService ??= createLiveVoiceService({
    assetDir: join(process.cwd(), "public", "audio", "live"),
    stateFile: join(getAgentDir(), LIVE_VOICE_STATE_FILE),
    keys: authStorageKeys,
  });
  return globalThis.__liveVoiceService;
}
