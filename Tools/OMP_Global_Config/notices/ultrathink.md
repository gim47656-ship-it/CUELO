<!--
`ultrathink` 가 발동한 턴에만 주입되는 내 규칙. 이 파일만 고치면 문구가 바뀐다.
빈 파일이나 주석만 있으면 아무것도 주입하지 않는다. 모델이 읽는 지시문이라 영어로 쓴다.
적용: node patches/apply-notices.mjs  (setup.ps1 이 자동 실행)
-->

House additions:
- Enumerate the plausible failure modes first, then rule each out with a fact you observed this turn (file content, command output, log line). Unobserved claims are marked `[INFERENCE]`.
- Prefer reading the actual source over reconstructing behavior from memory of similar systems.
