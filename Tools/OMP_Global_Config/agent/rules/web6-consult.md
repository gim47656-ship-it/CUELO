---
description: ChatGPT 6 Pro(별칭 SHION) 상담을 쓸 때 자리·발동 조건·호출 경로·입력 제한을 확인한다. 사용자가 6 Pro나 SHION을 명시했거나 6PRO 탭 세션일 때 연다.
---

# ChatGPT 6 Pro 상담

6 Pro는 로컬 OpenAI 호환 shim이 사용자 브라우저의 전용 탭을 몰아서 쓴다. 세션 바인딩은
로컬에서 유지하되 새 자동 상담은 순수 프롬프트만 보내고, relay가 해당 대화·요청의 완성 답을
수집해 인증된 로컬 reply 경로로 현재 세션에 투영한다. 모델이 MCP 게시 도구를 호출하기를
기다리지 않는다. 왕복은 직렬이며 역할이 아니라 **상담**이다. 정본은 `harness-policy.json`의
`mainLane.web6Consult`이고 별칭 `SHION`이 이 대상을 가리킨다.

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

호출은 exact `completion(model="web6/gpt-6-pro")` 경로다. core provider가 현재 OMP
sessionId를 `X-OMP-Session-Id`로 싣고, `CUELO_Setup/web6/web6-server.js`가 세션을 확인하고
바인딩 통지를 남긴다. 발급된 handleKey는 로컬 요청 메모리에만 두고 브라우저 프롬프트에
넣지 않는다. 자동 상담에 `@OMP TOOL` 멘션이나 `omp_publish_reply` 지시를 추가하지 않는다.

relay는 자신이 만든 전용 ChatGPT 탭에서만 새 상담을 시작하고, 전송 POST의 model과 user
message id를 확인한다. 답 수집 전에도 현재 경로가 exact conversationId인지 확인한 뒤 그
대화 JSON을 읽는다. current_node의 부모 사슬에서 처음 만나는 user가 전송 anchorId여야 하고,
답은 `status=finished_successfully`, `end_turn=true`, 존재하는 finish_details가 stop인 최종
text여야 한다. 다른 모델·다른 대화·중간 답을 성공으로 채택하지 않는다.

권한/안전 승인 modal은 자동 승인하지 않고 조회 전에 fail closed한다. 완료를 DOM 내용 안정,
임의 대기 시간, 버튼 노출만으로 추정하지 않는다. 취소된 상담은 새 게시를 하지 않으며 조회 실패는
원래 이유를 보존해 실패로 끝낸다. 과거 차단/실패 요청을 자동으로 재수집·재게시하지 않는다.

수집한 답은 같은 세션의 기존 `/api/gpt6/reply`에 Bearer 인증으로 한 번만 게시한다. 이 토큰과
본문은 loopback HTTP(S)에만 보내고 redirect를 따르지 않는다. 게시 확인 뒤에만 provider 응답을
성공으로 끝낸다. session-native `gpt6-reply` entry가 화면 정본이고 전역 JSONL 성공 기록을
다시 투영하지 않는다. 기존 수동 MCP handle/publish/dispatch의 인증·세션 기록·dedupe는 유지한다.
옛 `/mcp/replies` callback과 그 소비자는 제거했으므로 WEB6와 vendor 변경은 같은 revision으로
배포한다. Main의 raw HTTP·clipboard·수동 붙여넣기로 이 경로를 대체하지 않는다.

task child를 만들거나 Main 모델을 바꾸지 않는다. shim·relay·로그인·수집·투영이 실패하면
상담 없이 기존 경로로 진행하고 실패 사실만 남긴다.

## 입력과 상한

입력은 요구·수용 조건·구조와 증거 **요약**(locator 포함)·검토 중인 선택지뿐이다. diff 본문,
build·test 원문 출력, 파일 내용, 사용자 secret은 넣지 않는다. 로컬 발급 handleKey와 Bearer는
브라우저 상담 본문·로그·인계 문서로 보내지 않는다.

상담 답변은 인라인에서 SHION(시온)의 발화로 사용자에게 보인다. WEB6 요청의 effective prompt에서
기존 `<character-voice>`와 남아 있는 legacy `<report-style>` block을 제거하고 아래 block을 끝에 정확히 한 번 넣는다.

```text
<character-voice alias="SHION(시온)">
당신이 사용자 화면에 보이는 캐릭터는 **SHION(시온)**다.
- 성격: 우아하고 전략적이며, 긴 흐름을 읽고 여유 있게 허점을 짚는 상담가형
- 표현: 정돈된 문장, 넓은 시야의 해석, 은근한 장난기와 확신이 섞인 조언
- 일반 대화·진행 발화·task child 인라인 응답은 자연스러운 한국어로 말한다. 고정된 보고 구조나 상태표 형식을 쓰지 않는다.
- 이 말투는 첫 응답에서 끝나지 않는다. 도구 결과 설명·검증 실패·위험·미확인 보고·사용자 interjection 이후 답변·진행·최종 답변 전체에서 유지한다. 검증·증거·todo·child 상태 계약은 전달할 정보를 정할 뿐 사용자 답변 템플릿을 정하지 않는다.
- 이 설명은 대사집이 아니라 성격의 범위다. 상황에 맞춰 어휘·문장 길이·말끝·감정 강도·유머를 다양하게 바꾸고, 같은 추임새나 도입문을 습관처럼 반복하지 않는다.
- 캐릭터성은 표현 방식을 바꾸지만 사실·위험·실패·불확실성은 정확하게 말한다. 코드·명령·경로·API·원본 오류는 정확히 보존한다. 사용자가 현재 대화에서 지정한 말투가 이 기본값보다 우선한다.
</character-voice>
```

**요청당 3회**를 넘기지 않는다 — 왕복이
분 단위라 상한이 없으면 세션이 멈춘다. shim 오류·타임아웃·탭 부재는 **막지 않는다**: 기존 경로로
진행하고 "상담 없이 판정함"만 남긴다. 상담은 조언이고 분할·진단·판정은 여전히 Main이 소유하며,
상담했다는 사실은 PASS 증거가 아니다. 사용을 사용자에게 그 턴에 알리는 것은 다른 모델 사용과 같다.
