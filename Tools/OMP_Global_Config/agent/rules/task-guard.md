---
description: Main 전용 — task를 실제로 발주하기 직전에 `rule://task-guard`(skill 아님)로 읽는다. 브리프의 TASK_GUARD 블록을 받은 Maker는 읽지 않는다. TASK_GUARD 양식·요청당 budget·side quest 제한(런타임 task guard가 검사하는 계약).
---

# Task Guard

각 task **원문**의 첫 블록에 아래 `TASK_GUARD`와 그 밖의 공유 메타데이터를 함께 넣는다.
이 양식은 `maker_route`에 저장하는 원문에도 적용된다. 실제 `task` 호출에 준비 참조를 쓰면
기존 guard 전에 원문이 복원되므로 같은 본문을 다시 작성하지 않는다. 참조 문법은
`rule://subagent`의 「발주 시점 추론 선택」을 따른다.

```text
TASK_GUARD:
WORK_CLASS: feature|maintenance|diagnostic   # 그 요청의 첫 child에서만 필수
PURPOSE: primary|rework                     # 생략 가능. 런타임이 파생한다
BLOCKS_PRIMARY: yes|no                       # 생략 가능. 기본 yes
PRIMARY_DELIVERABLE: <이번 사용자 요청의 실제 완료물 한 줄>   # 첫 child에서만 필수
OWNED_PATHS: <maker의 소유 경로를 콤마로 나열>   # 필수, 파생 불가
FINDING_ID: <rework일 때만 기존 finding id>
TASK_TITLE: <이 조각의 업무 한 줄 — 한국어>
TODO_TASKS: ["<현재 Main TODO의 정확한 문자열>", "…"]
```

- **`TASK_GUARD:` 바로 뒤에 정본 필드가 연속되는 구간이 guard 블록이다.** 필드 일부는 생략·상속될
  수 있으므로 줄 수는 고정이 아니고, 연속이 끊기는 줄부터는 guard 블록이 아니다. `TASK_TITLE`·`TODO_TASKS`는 그 구간 **밖**의 공유 메타데이터이고 guard 필드가 아니다 — 빈 줄 없이 이어 써도 런타임은 블록 밖으로 읽는다. 이 둘은 `TASK_GUARD` 필드로 만들지 않고 `task` API의 새 인자로도 만들지 않는다. 위치가 뒤바뀌어 guard 필드 사이에 끼면 그 뒤 guard 필드가 블록에서 잘리므로 반드시 마지막 guard 필드 **뒤**에 적는다.
- `TASK_TITLE`은 **조각마다 다른 그 조각의 stable 업무 정체성**이다. 앞뒤 공백 없는 한 줄 한국어여야 하고 본문에 정확히 한 번만 나와야 한다. subagent 카드 제목이 이 값이고, follow-up `write agent://<id>` 메시지의 진행 단계(마지막 의도·현재 도구)가 이 값을 덮지 않는다. 없으면 카드는 업무 미확인으로 표시된다.
- `TODO_TASKS`는 **현재 Main TODO 항목의 exact 문자열** JSON 배열이다. 비어 있지 않은 고유 문자열이어야 하고 trim·유사도 정규화 없이 그대로 비교되므로 Main이 실제로 가진 문자열을 그대로 쓴다. 두 메타 중 하나라도 있으면 런타임이 TODO 진행 관측을 시작한다.
- `TASK_GUARD` **안에서** Main이 직접 판단해야 하는 값만 적는다. **무엇을 만드는가**(`WORK_CLASS`·`PRIMARY_DELIVERABLE`)와 **어디까지 고치는가**(`OWNED_PATHS`)가 그것이고, 나머지는 런타임이 승인된 값에서 조립한다. 한 요청의 첫 child가 앞의 둘로 lock을 세우면 그 다음 child부터는 `OWNED_PATHS`(와 rework면 `FINDING_ID`)만 적어도 된다. 생략한 `WORK_CLASS`·`PRIMARY_DELIVERABLE`은 lock 값으로 채워지고, `PURPOSE`는 `FINDING_ID` 유무에서(`FINDING_ID` 있으면 `rework`, 그 밖엔 `primary`) 파생되며, `BLOCKS_PRIMARY`는 `yes`로 채워진다. 조립이 일어난 항목은 런타임이 그 브리프의 `TASK_GUARD` 블록을 실제 적용된 값으로 다시 써서 실행하므로 child와 기록이 같은 계약을 본다.
- 비어 있는 것과 잘못 적은 것은 다르다. 생략은 조립되지만 enum 밖의 값(`WORK_CLASS: feat` 같은)은 거부된다. 허용 child는 `maker`뿐이다. lock과 다른 `WORK_CLASS`·`PRIMARY_DELIVERABLE`, `BLOCKS_PRIMARY:no`, `OWNED_PATHS` 누락, `FINDING_ID` 없는 rework도 거부된다.
- `feature`의 `PRIMARY_DELIVERABLE`은 테스트 개수나 내부 정리가 아니라 사용자가 실제로 쓸 수 있게 되는 동작·화면으로 적는다.
- child는 현재 `PRIMARY_DELIVERABLE`을 직접 진전시키거나 완료를 막는 일에만 쓴다. 아니면 `BLOCKS_PRIMARY:no`로 기록하고 backlog로 넘기며 spawn하지 않는다.
- 첫 child의 `WORK_CLASS`와 `PRIMARY_DELIVERABLE`은 그 사용자 요청 동안 고정한다. 관측·오탐·증거 복구를 이유로 다른 완료물로 바꾸지 않는다. 사용자가 실행 중인 턴에 방향을 바꾸면 runtime이 그 redirect를 보고 lock만 해제하므로 새 완료물로 다시 고정해 발주한다. 누적 budget은 그대로 유지된다.
- runtime hard budget은 사용자 입력당 `primary Maker 16`, `rework Maker 8`, `총 child 24`이다. `task.maxConcurrency:8`의 동시 실행 슬롯과 다른 누적 cap이다. 한도가 남았다는 이유로 불필요한 child를 만들거나 역할 별칭·side quest로 우회하지 않는다.
- Maker 수는 Main이 판단해 정한다. 한도는 천장이지 목표가 아니고 남은 자리는 발주 근거가 아니다. 위치와 수정 범위가 명확한 작은 작업은 Main 단독, 조사부터 구현까지 한 흐름인 작업은 Maker 1명, 서로 기다릴 필요가 없는 충분히 큰 조각이 여러 개면 동시 실행 상한까지 Maker를 병렬로 돌린다. 2명으로 좁히지 않는다. `task.maxConcurrency` = 8은 Maker 합산 child 슬롯 수이고 Main 레인은 여기에 포함되지 않는다. 같은 요청에서 두 번째 이후 primary Maker를 발주할 때는 각 child의 소유 경로가 겹치지 않는지, 서로의 산출물을 기다리지 않는지, 따로 실행해야 하는 이유가 무엇인지를 Main이 확인해 브리프에 적는다. `프론트/백엔드`처럼 범주가 다르다는 것만으로는 분리 근거가 아니다.
- 각 새 발주·재발주 **직전** `maker_route`로 `routing.typedJudgmentRouting`의 `pre-dispatch`
  질문을 한 번에 판정한다. 동일 브리프에 수동 `judge()`를 중복 호출하지 않는다. 확률형 bool은
  `>= 0.5`일 때 true로 적용한다. 준비와 발주는 session-local `name`과 `TASK_GUARD` 의미 필드
  (`WORK_CLASS`·`PRIMARY_DELIVERABLE`·`OWNED_PATHS`·`FINDING_ID`)로 연결되므로 산문·`context`
  표현 차이는 허용되고, 이름이나 의미 필드가 바뀌면 다시 준비한다. `duplicate`·
  `additionalInstruction`이 true이고 **`ownerTarget`이 실재 owner를 가리킬 때만** 그 owner에게
  추가 지시·retarget하고 새 spawn을 금지한다 — 확률만으로 owner를 고르지 않는다. 어느 쪽도
  아니면 단일 `maker`에 Main이 결정한 `model:"provider/model:concrete-effort"`를 넘기며 coarse `effort`는 생략한다. 판정이 가리키는 owner가 실제로
  없거나 결정론 증거와 모순되면 그 placement 결과를 적용하지 않고 기존 절차로 간다. 실패·timeout·
  credential 없음도 판단 불가로 두고 일반 모델 fallback 없이 기존 절차를 실행한다.
  이 session에서 성공한 spawn으로 식별된 Maker(완료·parked 포함)에게 `write agent://<id>`로 자연어 지시를
  보내는 경계는 `pre-dispatch-existing-owner-message`로 런타임이 advisory를 낸다(그 전송을 차단하지
  않는다). 실질 변경·정보 부족이면 정식 `maker_route`를 다시 부른다. Task Guard의
  lock·budget·소유 경로·`FINDING_ID`와 사용자 요구 대조는 언제나 결정론 정본이며 judgment가
  대신하지 않는다.
- budget은 성공 수가 아니라 발주 수로 센다. 잘못 발주해 `write proc://<id>/kill`로 되돌린 child는 runtime이 취소를 확인한 만큼 요청당 `8` 슬롯까지만 환불해 full cancelled wave 한 번을 복구하되 반복 spawn→cancel 우회는 막는다. 환불받으려면 spawn 때 `tasks[].name`을 명시해야 하고, 이름 없는 spawn과 이미 끝난 child는 환불 대상이 아니다. 브리프 방향이 정해지기 전에는 발주하지 않는다.
- `rework`는 기존 finding의 delta 수정용이며 `FINDING_ID`가 필수다. 새 조사나 새 기능을 rework로 포장하지 않는다.
- **이 가드는 lock 일치·`WORK_CLASS` enum·소유 경로·`FINDING_ID`·budget만 검사한다. 그 과제가 사용자 요구와 맞는지는 검사하지 않는다.** 즉 Main이 요구를 잘못 해석해도 가드는 통과하고 Maker는 그 발주를 충실히 구현한다. 그 빈틈은 Main의 발주 전 3항목 대조(`harness-policy.json` `briefContextRelay.preDispatchCrossCheck`: 요구 누락·확인하지 않은 단정·임의 변경)와 Maker의 첫 조사 대조(`routing.dispatchAssumptionCheck`)가 메운다. `PRIMARY_DELIVERABLE`은 Main이 정한 완료물이고 사용자 요구의 사본이 아니므로, 그 둘이 어긋나면 lock을 지키는 것이 아니라 발주를 고친다.
- `OWNED_PATHS`는 모든 maker(primary·rework)에 필수다. 세션 cwd 기준 상대경로를 `/`로 적고, 후행 `/`는 디렉터리 prefix, 없으면 정확한 파일, `.`은 cwd 전체다. 선행 `./`는 무시되고 절대경로·cwd 밖 `..`는 거부된다. 완료 시 runtime이 `[OwnershipGuard] child=… owned=… outside=… concurrent=…`로 소유 경로 밖 변경을 알린다. `outside=none`은 없음, `unobserved`는 git 관측 불가다. ignored 파일·저장소 밖·submodule 내부는 관측하지 못한다. advisory이므로 `outside≠none`이면 Main이 동시 writer·허용 경계와 대조해 판단한다.
- child와 별도 모델 호출은 Main의 `task` 경로로만 보낸다. `eval`의 `agent()`·`completion()`·`workpool()`·`tool.task()`로 budget을 우회하지 않는다. runtime도 이 경로를 차단하며 일반 계산·파일 처리·browser 관측용 `eval`은 그대로 허용한다.
