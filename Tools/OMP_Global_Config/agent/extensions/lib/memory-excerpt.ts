// 저장 기억을 판정기나 모델 문맥에 다시 실을 때 비밀을 가리는 공통 패턴. jev-runtime(회상 기억 적용 점검)과
// edit-lessons(편집 경로 교훈 단서)가 같은 규칙을 쓰도록 한 곳에 둔다.

/** 비밀로 보이는 낱말·접두. 걸리면 내용은 싣지 않고 id만 남긴다. */
export const MEMORY_SECRET_PATTERN = /(?:^|[\s"'`:])(?:password|passwd|api[_ -]?key|bearer|secret|token|credential|client[_ -]?secret)\b|(?:비밀번호|자격증명|인증키|토큰)|(?:sk-[A-Za-z0-9_-]{12,})/i;
