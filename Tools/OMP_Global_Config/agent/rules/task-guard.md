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
EXPECTED_MINUTES: <이 조각의 예상 소요 분, 정수 — 권장>
DONE_WHEN: <이 조각이 끝났다고 볼 조건 한 줄 — 권장>
```

- **`TASK_GUARD:` 바로 뒤에 정본 필드가 연속되는 구간이 guard 블록이다.** 필드 일부는 생략·상속될
  수 있으므로 줄 수는 고정이 아니고, 연속이 끊기는 줄부터는 guard 블록이 아니다. `TASK_TITLE`·`TODO_TASKS`는 그 구간 **밖**의 공유 메타데이터이고 guard 필드가 아니다 — 빈 줄 없이 이어 써도 런타임은 블록 밖으로 읽는다. 이 둘은 `TASK_GUARD` 필드로 만들지 않고 `task` API의 새 인자로도 만들지 않는다. 위치가 뒤바뀌어 guard 필드 사이에 끼면 그 뒤 guard 필드가 블록에서 잘리므로 반드시 마지막 guard 필드 **뒤**에 적는다.
- `TASK_TITLE`은 **조각마다 다른 그 조각의 stable 업무 정체성**이다. 앞뒤 공백 없는 한 줄 한국어여야 하고 본문에 정확히 한 번만 나와야 한다. subagent 카드 제목이 이 값이고, follow-up `write agent://<id>` 메시지의 진행 단계(마지막 의도·현재 도구)가 이 값을 덮지 않는다. 없으면 카드는 업무 미확인으로 표시된다.
- `TODO_TASKS`는 **현재 Main TODO 항목의 exact 문자열** JSON 배열이다. 비어 있지 않은 고유 문자열이어야 하고 trim·유사도 정규화 없이 그대로 비교되므로 Main이 실제로 가진 문자열을 그대로 쓴다. 두 메타 중 하나라도 있으면 런타임이 TODO 진행 관측을 시작한다.
- `EXPECTED_MINUTES`·`DONE_WHEN`도 `TASK_TITLE`·`TODO_TASKS`처럼 `TASK_GUARD` 블록 **밖**의 공유 메타데이터이고 **권장**이다(2026-10-20 사용자 결정). 런타임은 검증하지 않고 없다고 거부하지도 않으며 `TASK_GUARD` 필드로도 `task` 인자로도 만들지 않는다. `EXPECTED_MINUTES`는 줄 첫머리의 `EXPECTED_MINUTES: <1~1440 정수>` 한 줄이어야 child 활동 감시가 읽는다(문장 속에 섞인 값·정수가 아닌 값은 무시). 읽히면 감시가 모든 경고의 `stats.expectedMinutes`에 그 값을 싣고, 경과가 그 값을 넘는 순간 `over_expected` 경고를 한 번 보낸다. 값은 Main이 조각의 크기를 보고 정직하게 적는다(조사·구현·검증을 합친 벽시계 분). `DONE_WHEN`은 "무엇이 통과하면 끝인가"를 한 줄로 적어 Maker가 끝없이 다듬지 않게 하고 Main이 경고 때 진척을 대조하는 기준이 된다. 둘 다 시간 제한이 아니며 어떤 child도 이 값 때문에 중단·취소·재발주되지 않는다.
- `TASK_GUARD` **안에서** Main이 직접 판단해야 하는 값만 적는다. **무엇을 만드는가**(`WORK_CLASS`·`PRIMARY_DELIVERABLE`)와 **어디까지 고치는가**(`OWNED_PATHS`)가 그것이고, 나머지는 런타임이 승인된 값에서 조립한다. 한 요청의 첫 child가 앞의 둘로 lock을 세우면 그 다음 child부터는 `OWNED_PATHS`(와 rework면 `FINDING_ID`)만 적어도 된다. 생략한 `WORK_CLASS`·`PRIMARY_DELIVERABLE`은 lock 값으로 채워지고, `PURPOSE`는 `FINDING_ID` 유무에서(`FINDING_ID` 있으면 `rework`, 그 밖엔 `primary`) 파생되며, `BLOCKS_PRIMARY`는 `yes`로 채워진다. 조립이 일어난 항목은 런타임이 그 브리프의 `TASK_GUARD` 블록을 실제 적용된 값으로 다시 써서 실행하므로 child와 기록이 같은 계약을 본다.
- 비어 있는 것과 잘못 적은 것은 다르다. 생략은 조립되지만 enum 밖의 값(`WORK_CLASS: feat` 같은)은 거부된다. 허용 child는 `maker`뿐이다. lock과 다른 `WORK_CLASS`·`PRIMARY_DELIVERABLE`, `BLOCKS_PRIMARY:no`, `OWNED_PATHS` 누락, `FINDING_ID` 없는 rework도 거부된다.
- 생략한 `WORK_CLASS`·`PRIMARY_DELIVERABLE`의 상속은 lock이 이미 있거나, 같은 `maker_route`·`task` batch에서 두 값을 적은 앞 child 뒤에 있을 때만 된다. lock 없이 따로 준비하는 child는 두 값을 그 요청 값 그대로 다시 적는다. `maker_route`와 실제 `task` 경계는 lock(없으면 batch에서 먼저 계약을 정한 child)과 다른 값을 SideQuestGuard와 같은 정규화(앞뒤 공백·연속 공백·대소문자)로 비교해 Jev 호출이나 spawn 전에 그 child를 짚어 거절한다. 조각마다 다른 완료물은 `TASK_TITLE`·`TODO_TASKS`·`# Acceptance`로 구분한다.
- `agent`는 생략하면 `maker`로 읽히고 반환 input에도 `maker`로 기록된다. 명시한 다른 값(`task`·`scout` 등)은 거부된다. `maker_route` 준비도 같은 `WORK_CLASS` enum으로 명시 오값을 거절해 준비 성공처럼 보이지 않는다.
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
  아니면 단일 `maker`에 `model:"provider/model:auto"`를 넘기며 concrete 강도 suffix와 coarse `effort`는 쓰지 않는다. 강도는 child auto가 `solutionSpace`와 이후 Main 지시로 고른다. 판정이 가리키는 owner가 실제로
  없거나 결정론 증거와 모순되면 그 placement 결과를 적용하지 않고 기존 절차로 간다. 실패·timeout·
  credential 없음도 판단 불가로 두고 일반 모델 fallback 없이 기존 절차를 실행한다.
  제안 범위가 적용 Skill이나 사용자 계약과 충돌하는지는 `pre-dispatch.mainOwnedJudgments`에 둔 Main 소유 판단이다.
  `maker_route`는 이를 JEV에 묻지 않는다. Main이 발주 전 3항목 대조로 직접 판정하고 충돌이 있으면 해당 발주 전에
  해소하며, judge 결과가 계약을 완화하는 근거가 될 수 없다.
  이 session에서 성공한 spawn으로 식별된 Maker(완료·parked 포함)에게 `write agent://<id>`로 자연어 지시를
  보내면 `pre-dispatch-existing-owner-message`가 그 전송을 차단하지 않고 뒤에서 JEV로 원 계약(PRIMARY_DELIVERABLE·
  OWNED_PATHS·Acceptance) 대비 동일 범위·범위 변경·수용 조건 변경·불명 중 하나로 분류해 advisory로 알린다.
  JEV 실패·timeout·자격 없음·secret 후보는 불명이다. 범위 변경이면 바뀐 사실로 `maker_route`를 다시 부른다. Task Guard의
  lock·budget·소유 경로·`FINDING_ID`와 사용자 요구 대조는 언제나 결정론 정본이며 judgment가
  대신하지 않는다.
- budget은 성공 수가 아니라 발주 수로 센다. 잘못 발주해 `write proc://<id>/kill`로 되돌린 child는 runtime이 취소를 확인한 만큼 요청당 `8` 슬롯까지만 환불해 full cancelled wave 한 번을 복구하되 반복 spawn→cancel 우회는 막는다. 환불받으려면 spawn 때 `tasks[].name`을 명시해야 하고, 이름 없는 spawn과 이미 끝난 child는 환불 대상이 아니다. 브리프 방향이 정해지기 전에는 발주하지 않는다.
- `rework`는 기존 finding의 delta 수정용이며 `FINDING_ID`가 필수다. 새 조사나 새 기능을 rework로 포장하지 않는다.
- **이 가드는 lock 일치·`WORK_CLASS` enum·소유 경로·`FINDING_ID`·budget만 검사한다. 그 과제가 사용자 요구와 맞는지는 검사하지 않는다.** 즉 Main이 요구를 잘못 해석해도 가드는 통과하고 Maker는 그 발주를 충실히 구현한다. 그 빈틈은 Main의 발주 전 3항목 대조(`harness-policy.json` `briefContextRelay.preDispatchCrossCheck`: 요구 누락·확인하지 않은 단정·임의 변경)와 Maker의 첫 조사 대조(`routing.dispatchAssumptionCheck`)가 메운다. `PRIMARY_DELIVERABLE`은 Main이 정한 완료물이고 사용자 요구의 사본이 아니므로, 그 둘이 어긋나면 lock을 지키는 것이 아니라 발주를 고친다.
- `OWNED_PATHS`는 모든 maker(primary·rework)에 필수다. 세션 cwd 기준 상대경로를 `/`로 적고, 후행 `/`는 디렉터리 prefix, 없으면 정확한 파일, `.`은 cwd 전체다. 선행 `./`는 무시되고 절대경로·cwd 밖 `..`는 거부된다. 완료 시 runtime이 `[OwnershipGuard] child=… owned=… outside=… concurrent=…`로 소유 경로 밖 변경을 알린다. `outside=none`은 없음, `unobserved`는 git 관측 불가다. ignored 파일·저장소 밖·submodule 내부는 관측하지 못한다. advisory이므로 `outside≠none`이면 Main이 동시 writer·허용 경계와 대조해 판단한다.
- child와 별도 모델 호출은 Main의 `task` 경로로만 보낸다. `eval`의 `agent()`·`workpool()`·`tool.task()`로 budget을 우회하지 않는다. runtime(SpawnGuard)은 이 세 경로를 정적 패턴으로 차단하며, 별칭을 거친 호출까지 막는 보안 경계가 아니라 사고 방지 장치다. 일반 계산·파일 처리·browser 관측용 `eval`은 그대로 허용한다. stateless `completion(model="slow"|"smol")`은 child가 아니므로 runtime이 막지 않으며, Main의 최종 판정 직전 상담(revision당 1회, 입력은 판정 패킷뿐, 받는 것은 이견 목록이고 판정은 Main이 낸다 — `rule://subagent` 「검수와 수용」, 정본 `mainLane.workerReview.finalVerdictConsult`)에만 쓴다. `completion()`으로 diff 검수나 수용 여부를 묻는 것은 금지지만 runtime은 목적을 구분하지 못하므로 Main의 규율이다. 검수용 모델 호출은 `cross_review`만 인정하며 원장에 기록·집계된다.
