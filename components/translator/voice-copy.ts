export const VOICE_COPY = {
  ko: {
    engineLabel: "통역 엔진", engineVoice: "음성 + 텍스트", engineCodex: "Codex Live",
    engineHint: "말하는 동안 원문이 표시되며, 등록된 목소리로 번역 방향을 고정합니다.",
    engineFast: "빠른 통역",
    fastHint: "말하는 동안 번역이 표시됩니다. 음성이 켜져 있고 통역 방향이 불분명하면 텍스트만 표시됩니다.",
    enrollTitle: "목소리 등록", enrollMe: "먼저 한 문장을 말해주세요.", enrollThem: "이제 상대방이 한 문장을 말해주세요.",
    enrollHint: "음성 샘플은 브라우저 메모리에만 남고 종료 시 삭제됩니다.",
    enrollRetry: "목소리가 또렷하게 들리지 않았습니다. 다른 한 문장을 다시 말씀해 주세요.",
    enrollNext: "다음", enrollDone: "완료", enrollSkip: "건너뛰기",
    enrollWaiting: "모델을 불러오는 중이지만 통역은 바로 시작됩니다.",
    modelLoading: "음성 모델 불러오는 중 {percent}%", modelFailed: "음성 구분을 사용할 수 없어 언어 규칙으로 동작합니다.", modelReady: "음성 모델 준비 완료",
    correctSpeaker: "말풍선을 눌러 화자를 수정하고 다시 번역하세요.", translationFailed: "번역 실패. 눌러서 다시 시도",
  },
  en: {
    engineLabel: "Engine", engineVoice: "Voice + text", engineCodex: "Codex Live",
    engineHint: "Originals appear while speaking. Registered voices lock translation direction.",
    engineFast: "Fast interpretation",
    fastHint: "Translations appear as people speak. When voice is on and the interpretation direction is unclear, only text is shown.",
    enrollTitle: "Voice setup", enrollMe: "Say a sentence first.", enrollThem: "Now have the other person say a sentence.",
    enrollHint: "Voice samples stay in browser memory and are discarded when you stop.",
    enrollRetry: "Your voice sample was not clear. Please say another sentence.",
    enrollNext: "Next", enrollDone: "Done", enrollSkip: "Skip", enrollWaiting: "Loading models, but interpreting now.",
    modelLoading: "Loading voice model {percent}%", modelFailed: "Voice matching unavailable; using language rules.", modelReady: "Voice model ready",
    correctSpeaker: "Tap a bubble to fix the speaker and retranslate.", translationFailed: "Translation failed. Tap to retry",
  },
};
export const OVERLAP_COPY: Record<string, string> = {
  ko: "한 번에 한 명씩 말씀해 주세요. 겹쳐 말하면 모두 통역되지 않고 인식된 말만 순서대로 통역됩니다.",
  en: "Please speak one at a time. Overlapping speech is not fully captured; only recognized words are interpreted in order.",
  ja: "一度に一人ずつ話してください。声が重なるとすべては通訳されず、認識された言葉だけが順に訳されます。",
  vi: "Vui lòng nói từng người một. Nếu nói chồng lên nhau, chỉ những từ nhận diện được mới được dịch theo thứ tự.",
  zh: "请一次一个人说话。声音重叠时无法全部翻译，仅按顺序翻译识别到的内容。",
  th: "กรุณาพูดทีละคน หากพูดซ้อนกันระบบจะแปลเฉพาะคำที่จับได้ตามลำดับเท่านั้น",
};
export const ENROLL_COPY: Record<string, string> = {
  ko: "목소리를 등록할 수 있도록 한국어로 한 문장을 말해주세요.",
  en: "Please say one sentence in English to register your voice.",
  ja: "声を登録するため、日本語で一文話してください。",
  vi: "Vui lòng nói một câu bằng tiếng Việt để đăng ký giọng nói.",
  zh: "请用中文说一句话以登记您的声音。",
  th: "กรุณาพูดภาษาไทยหนึ่งประโยคเพื่อลงทะเบียนเสียงของคุณ",
};
