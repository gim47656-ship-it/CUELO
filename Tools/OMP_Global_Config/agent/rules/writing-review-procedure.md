---
description: 새 글·문단 초안, 문서·UI 문구의 draft 및 slop_check 작업 전에 읽는다.
---

- **글씨가 들어가는 콘텐츠는 Gemini가 먼저 쓰고 AI 슬롭 점검을 거친다(2026-10-25 사용자 결정).** 새로 쓰거나 한 문단
  이상 다시 쓰는 글은 Main·Maker 모두 먼저 `draft`로 쓴다. README·CHANGELOG·`docs/`·보고서·안내서·소개 글·게시물,
  `HANDOFF.md`·`doc/history` 작업 기록의 서술, md·csv·Excel·Word·PDF 보고서·표, PPT 슬라이드 문구, HTML·웹 화면과
  UI의 문구가 모두 대상이다. 사실·수치·경로·명령·커밋은 `instruction`이나 `paths`로 넘겨 모델이 지어내지 않게 한다.
  Gemini가 작성해 cwd 안에 저장하고, 실패하면 `modelRoles.draftFallback`이 가리키는 모델(소스 프로필은 GPT-6.1 Terra, 미설정 설치는
  Hive의 DeepSeek 1017)로 한 번 대체한다. 설정한 대체가 실패하면 DeepSeek로 넘어가지 않는다(참고 텍스트는 Google 또는 대체 모델의 제공자로
  전송). 결과는 직접 열어 사실·형식을 검토하고, 반영하기 전에 AI 슬롭 점검을 같은 작업에서 돌린다: 한국어 글은
  `humanizer`, 영어 글은 `stop-slop`, 화면·UI 문구는 `kill-ai-slop` 스킬 절차를 따른다. 틀린 사실과 슬롭만 고쳐
  `edit`로 반영한다. 코드·설정·규칙 파일(`RULES.md`·`AGENTS.md`·`rules/`·SOP), 몇 줄 이하의 정확한 수정, 사용자에게
  하는 대화 답변은 대상이 아니다. 이 Gemini는 2026-10-26부터 Google Cloud Vertex의 Gemini 4 Argon이며(크레딧으로
  과금) OCR 역할에도 쓴다. 이미지 질문(vision)은 Opus를 유지하고, Antigravity OAuth는 계정 정지 위험으로 쓰지 않는다.
  **바깥에서 사람이 실제로 보는 산출물만 AI 슬롭 게이트를 통과한다(2026-10-26 사용자 지시, 2026-10-29 범위 축소로
  2026-10-27 결정을 대체).** 대상은 형식으로 정한다: 슬라이드·PPTX, HTML, DOCX·XLSX·PDF·HWPX, 보고서 csv, 언어 팩의
  화면·메뉴 문구, 매뉴얼이다. **마크다운은 README·CHANGELOG·`docs/`·문서 지도를 포함해 위치와 관계없이 대상이 아니다.**
  `.slop-gate.json` `visible` glob이 선언한 마크다운만 대상이 된다. 공개 저장소에 올라가는지, `.publicignore` 선언이
  있는지는 따지지 않는다. 고객·사용자에게 파일로 건네는 덱·보고서·문서는 대상이다(2026-10-27: 공개 선언이 없다는 이유로
  고객용 덱이 빠진 사례를 사용자가 바로잡았다). 제외는 선언 없는 마크다운과 소스 내부다: 코드·주석·로그·테스트·fixture·
  생성물·vendor, 내부 프롬프트·규칙·SOP·스킬, `HANDOFF.md`·`doc/history`·`doc/README.md`. `.slop-gate.json` `visible`은
  대상을 더하기만 한다. 위 초안 작성·직접 교정 규칙과 코드 변경의 `cross_review`는 그대로 유지한다.
  점검은 `slop_check`로 한다. 검토 모델은 slop 전용 slot `slopReviewOpenAI`(GPT-6 Luna)와 `slopReviewGemini`(Gemini 3.8 Flash)다
  (2026-10-29 사용자 결정: slop에는 Opus·Astra를 쓰지 않는다). Anthropic·Gemini·그 밖 저자는 Luna가 필수이고 Flash가 자문,
  OpenAI 저자는 Flash가 필수이며(Luna는 같은 계열이라 건너뛴다) Gemini 저자는 Luna만 본다. slot이 비었거나 풀리지 않으면 그
  자리는 `cross_review`와 같은 옛 slot(`crossReviewOpenAI`·`crossReviewAnthropic`·`crossReviewAdvisory`)으로 돌아가고, 풀린
  slot이 계열이 맞지 않으면 호출 없이 거절한다. `cross_review`는 이 slot을 읽지 않는다. 규칙 본문은 system 메시지에 고정하고
  파일 글만 user 메시지에 실어 제공자 프리픽스 캐시가 맞게 한다. 지적이 없으면
  그 파일 내용에 통과가 기록된다. 고친 파일은 다시 점검하며 내용을 바꾸지 않고 닫을 수 있는 것은 Main이 근거로
  반박(`refuted`)한 지적뿐이다. git 추적 파일은 HEAD 대비 바뀐 글만 본다. 대상 파일은 `git_finalize`의 `slop-gate`와
  저장소 밖 산출물의 턴 종료 검사에 걸린다. 게이트 면제는 사용자의 명시 지시가 있을 때만 기록해 적용한다.
  검토 응답이 JSON으로 해석되지 않으면 실패 원문·파싱 오류를 먼저 확인한다. 토큰 길이로 원인을 추측하거나 같은 조건으로
  반복 호출하지 않는다. 검토 응답의 형식 오류를 피하려고 산출물의 따옴표·쉼표·내용을 바꾸지 않는다. 실제 내용상 지적에
  근거한 교정은 별개다. 불완전한 JSON을 임의로 보완하거나 필수 검토가 실패한 상태에서 통과시키지 않는다.
- **draft는 호출 횟수가 아니라 작성 범위로 적용한다(2026-10-27 사용자 지적).** 일부 문단의 초안만 받은 뒤 나머지 설명·표 문구·슬라이드 본문을 Main이나 Maker가 직접 써서 합치면 안 된다. 새로 쓰거나 문단 단위로 다시 쓰는 각 블록은 최종 파일에 반영하기 전에 `draft`로 작성한다. 작업을 여러 번 나누거나 HTML 한 줄에 넣어도 예외가 되지 않는다. 초안 밖의 새 설명·예시·결론을 덧붙이는 것은 사실 교정이나 슬롭 제거가 아니다. 기존 문구의 정확한 사실·오탈자 교정, 문구를 바꾸지 않는 코드·레이아웃 변경은 직접 수정할 수 있다. 적용 전에 초안과 반영할 문구를 대조하고 빠진 블록만 다시 작성한다. `slop_check` 통과는 draft 작성 범위를 증명하지 않는다.
