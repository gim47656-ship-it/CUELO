---
description: When user names 6 Pro/SHION or in a 6PRO session.
---

# ChatGPT 6 Pro 상담

6 Pro는 로컬 OpenAI 호환 shim이 사용자 브라우저의 전용 탭을 몰아서 쓴다. 세션 바인딩은
로컬에서 유지하고 상담은 순수 프롬프트만 보내며, relay가 해당 대화·요청의 완성 답을
수집해 인증된 로컬 reply 경로로 현재 세션에 투영한다. 왕복은 직렬이며 역할이 아니라
**상담**이다. 정본은 `harness-policy.json`의 `mainLane.web6Consult`이고 별칭 `SHION`이 이
대상을 가리킨다.

## 들어가는 자리

|자리|언제|
|---|---|
|**발주 전 설계**|첫 child 직전. 조각 분할·공유 계약·수용 조건. 여기서 틀리면 뒤따르는 maker가 통째로 헛돈다|
|**최종 판정 직전 상담**|`mainLane.workerReview.finalVerdictConsult` 슬롯 그대로. 요약 입력·이견 목록 출력이라 형태가 정확히 맞는다|
|**경합 가설 판정**|원인 후보가 2개 이상이고 관측으로 가를 수 없을 때. Main이 아직 할 수 있는 관측의 대체물로 쓰지 않는다|
|**되돌리기 비싼 설계 선택**|스키마·공개 인터페이스·마이그레이션 등 `irreversible-state-change`·`compatibility-break` 계열|

두지 않는 자리도 계약이다 — **maker 내부 구현 상담**(도구 루프가 필요하다), **diff 검수**(본문
반출 금지이고 크기도 맞지 않는다), **검증 실행**(도구가 필요하다), **사용자 답변 작성**. 여기에
넣으면 그 세션은 6 Pro 대기로 멈춘다.

## 발동 조건

- **일반 세션** — 사용자가 6 Pro로 처리하라고 **명시했을 때만**. `시온 호출해`도 명시 호출이다.
- **6PRO 탭에서 연 세션**(`gpt6-handles.json`의 유효한 핸들이 그 `sessionId`에 걸린 세션) —
  발주 전 설계와 최종 판정 상담은 **기본 발동**, 나머지 둘은 조건이 맞을 때 Main 재량이다.
  바인딩 사실은 브리지가 그 세션에 알린다.

## 호출 경로

호출은 exact `completion(model="web6/gpt-6-pro")`만 쓴다. task child나 Main 모델 전환, raw HTTP,
clipboard와 수동 붙여넣기로 대체하지 않는다. shim, relay의 세션/대화 신원 확인과 최종 답 수집,
인증된 loopback 투영은 `mainLane.web6Consult`와 구현(`extensions/consult.ts`, `web6-server.js`)이 정본이다.
도구 멘션이나 게시 지시, 로컬 handleKey를 브라우저 상담 본문에 넣지 않는다.
권한과 안전 승인은 자동 허용하지 않는다. 중간 답이나 DOM 안정, 임의 대기만으로 완료를 판단하지 않고
실패 이유를 보존하며 취소되거나 실패한 요청을 자동 재게시하지 않는다.

task child를 만들거나 Main 모델을 바꾸지 않는다. shim·relay·로그인·수집·투영이 실패하면
상담 없이 기존 경로로 진행하고 실패 사실만 남긴다.

## 입력과 상한

입력은 요구·수용 조건·구조와 증거 **요약**(locator 포함)·검토 중인 선택지뿐이다. diff 본문,
build·test 원문 출력, 파일 내용, 사용자 secret은 넣지 않는다. 로컬 발급 handleKey와 Bearer는
브라우저 상담 본문·로그·인계 문서로 보내지 않는다.

응답의 말투와 인라인 투영은 `extensions/character-voice.ts`가 소유하며 같은 답을 다시 투영하지 않는다.
횟수와 실패 처리는 `mainLane.web6Consult.cap`과 `failOpen`을 따른다. 실패하면 상담 없이 기존 경로로 진행했다고 밝힌다.
상담은 조언이며 Main의 분할, 진단, 판정이나 PASS 증거를 대신하지 않는다. 사용 사실은 그 턴에 사용자에게 알린다.
