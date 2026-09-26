# CUELO가 사용하는 공개 OMP 하네스

OMP 하네스는 코딩 에이전트가 요구를 작업으로 나누고, 변경을 검증하고, 증거로 검수하는 작업 규칙·SOP·확장·core 패치의 묶음입니다. 공개 트리는 [`Tools/OMP_Global_Config/agent/`](../Tools/OMP_Global_Config/agent/)와 [`Tools/OMP_Global_Config/patches/`](../Tools/OMP_Global_Config/patches/)에 있습니다. CUELO 앱과 구분되는 omp 작업 환경용 자료입니다.

## 설치와 공개 범위

공개된 `agent/`의 내용을 사용자의 `~/.omp/agent`에 복사해 적용합니다. 이 저장소에는 사용자별 모델 설정이 포함되지 않으므로, 사용자가 자신의 `config.yml`에 `modelRoles`를 지정하고 필요한 `models.yml`을 직접 준비해야 합니다. CUELO 앱 자체는 이 하네스를 설치하지 않아도 동작합니다.

공개 저장소에는 역할·검수 절차와 런타임 확장, 정책 규칙, core 패치가 포함됩니다. 반면 계정이나 모델 선택 정보를 담는 `config.yml`·`models.yml`, 개인 skills, 작업 기록, PC 설치 파이프라인은 공개하지 않습니다. 실제 공개 제외 경계는 private 저장소의 `.publicignore`가 정합니다.

캐릭터별로 고정하는 저장 계정 번호도 공개본에서는 `N`(문서는 "지정 계정")으로 가려져 있습니다. `character-voice.ts`와 관련 core 패치·테스트를 그대로 쓰려면 이 자리에 자기 계정 번호를 채워야 합니다.

## 역할과 작업 모드

[전역 안내](../Tools/OMP_Global_Config/agent/AGENTS.md)와 [Maker SOP](../Tools/OMP_Global_Config/agent/sop/maker.md)는 두 역할을 정의합니다.

- **Main**은 사용자 요구와 수용 조건, 승인, 작업 분할·라우팅, 중간 검수와 최종 판정을 소유합니다. 위임하지 않은 작업은 직접 수행합니다.
- **Maker**는 명시된 범위에서 조사·구현·재작업·자기 변경의 집중 검증을 끝까지 맡습니다. 별도 validator나 다단계 에이전트 역할을 기본 구조로 두지 않습니다.

`routine`은 Main이 한 흐름으로 끝내는 작업, `large`는 독립적으로 완료 가능한 조각을 분리하는 작업, `high-risk`는 결과나 코드 성질상 편집 전 Main 개입과 이후 drift 검수가 필요한 작업입니다. 규모와 위험은 서로 다른 축입니다. 상세 기준은 [subagent 규칙](../Tools/OMP_Global_Config/agent/rules/subagent.md) 및 기계 판독 가능한 [harness-policy.json](../Tools/OMP_Global_Config/agent/rules/harness-policy.json)에 있습니다.

## 발주와 검수 계약

Main은 작업을 발주할 때 목표·사용자 수용 조건·보존 동작·허용 경로·검증 범위를 정합니다. [`maker_route`](../Tools/OMP_Global_Config/agent/rules/subagent.md)는 작업 분류와 남은 판단, 후보 적합성·노력 수준, 기존 owner와 중복되는지를 돕는 발주 전 판단입니다. 결과는 Main의 조언이지 자동 승인이나 자동 배정이 아닙니다.
Main이 완료된 Maker에게 `write agent://<id>`로 후속 지시를 보내면 런타임 advisory는 같은 session의
실제 attempt에 `routing_verdict`가 아직 기록되지 않았는지 알려줍니다. Main은 증거를 보고
`accepted`·`rework`·`held`를 직접 기록합니다. 증거 보충 요청은 자동 재작업 판정이 아닙니다.
사용자 요구로 목적·범위·수용 조건이 바뀌면 변경된 사실로 `maker_route`를 다시 판단합니다.
UI/UX 전문성 경계가 새로 확인되면 비-Opus owner의 미완 변경·증거를 보존해 명시적으로 이관하며, 같은 Opus owner와 완료된 비-UI 작업은 재사용합니다.
Main이 실제 재작업을 지시할 때는 [검수와 수용](../Tools/OMP_Global_Config/agent/rules/subagent.md#검수와-수용)의
`REWORK task_id=... role=maker previous_revision=... next_revision=...`와
`finding_id=... source=...`를 후속 메시지에 넣어야 합니다. 평문 지시만으로 새 attempt가 기록되지는 않습니다.
`maker_route`에 표시되는 history는 Jev 분류 **후** Main에게 붙는 건수 advisory이며 분류 입력이나
모델·강도 자동 조정 근거가 아닙니다.

등급(`NORMAL`·`HARD`)과 후보 이름은 구분합니다. 후보는 `NORMAL_SOL`, `NORMAL_OPUS`, `NORMAL_DEEPSEEK`, `HARD_UI_OPUS`, `HARD_CODE_OPUS`, `HARD_CODE_ASTRA`처럼 실제 모델 계열을 표시합니다. NORMAL도 레이아웃·반응형·접근성·포커스·터치 표적 등 UI/UX 판단이 남으면 Opus를 선택하며, 이를 위해 HARD로 승격하지 않습니다. 비-UI NORMAL은 Sol을 우선하고 실제 사용 불가·소진 시에만 DeepSeek를 추천합니다. 기존 NORMAL의 명시적 Opus 선택도 유지합니다. UI/UX의 Opus unavailable은 다른 모델로 숨겨 대체하지 않습니다.

후보별 추론 강도는 정책의 `allowedEfforts`와 실제 모델 지원 단계의 교집합입니다. Sol과 Opus는 `high`~`xhigh`, DeepSeek는 `high`를 사용합니다. 이 정책은 Main의 Auto나 실행 중인 세션의 모델·강도를 소급 변경하지 않습니다.

CUELO의 패치된 내장 코어에서 Main은 Auto를 유지하며 새 사용자 턴의 자동 선택에 `providers.autoThinkingMinEffort: medium`과 `providers.autoThinkingMaxEffort: xhigh`를 적용합니다. 분류 실패 시 이전 값으로 대체하는 경우에도 같은 하한을 사용합니다. 모델이 지원하는 단계와 명시된 세션 상한 안에서만 고르며, 추론 조절이 없는 모델에 값을 만들어 넣지는 않습니다. 실행 중인 요청·Steer·도구 후속 실행·수동 선택의 강도는 이 설정으로 바꾸지 않습니다. 공식 standalone `omp` 실행 파일에는 이 로컬 코어 패치가 포함되지 않으므로 CLI 업데이트만으로 해당 하한이 적용되지는 않습니다.

패치된 내장 코어의 Anthropic 계정 재선택은 사용량·주간 리셋을 확인할 수 있는 건강한 후보끼리 리셋 시각이 빠른 계정을 우선합니다. 리셋 시각이 정확히 같으면 남은 주간 한도가 큰 쪽, 그것도 같으면 기존 순서를 유지합니다. 조회 실패·부분 정보는 추정하지 않으며 기존 한도·예비량·5시간 보호를 유지합니다. 사용 중인 warm pin과 명시적으로 지정한 캐릭터 계정은 이 선호로 전환하지 않습니다.

Maker는 자신이 바꾼 범위의 focused check와 실제 변경 표면 검증을 수행하고 원문 증거 locator를 보고합니다. Main은 확정된 변경분을 중간 검수하고, 마지막에는 각 수용 조건과 그 증거를 대조해 직접 판정합니다. Main은 Maker의 focused check를 같은 조건에서 반복하지 않으며, 필요할 때 공통 환경의 통합·전체 수용 검사를 수행합니다. 검사되지 않은 revision을 통과로 처리하지 않습니다. 자세한 책임 경계는 [검수와 수용](../Tools/OMP_Global_Config/agent/rules/subagent.md) 절과 policy의 `mainLane.workerReview`, `routing.reviewPacket`에 규정돼 있습니다.

Main 승인이 작업을 막고 있다면 관계없는 문서 정리나 새 발주보다 필요한 확인과 회신을 먼저 처리합니다. 승인과 완료 보고가 엇갈렸을 때는 이미 끝난 검사를 반복하지 않고 최신 승인과 남은 동작을 대조해 이어갑니다. 실패를 기록하는 데서 끝내지 않고 기존 규칙의 실행 위반과 실제 누락을 구분해 다음 작업에 반영하며, 효과를 관측하기 전에는 개선됐다고 단정하지 않습니다.

## Task Guard와 command guard

[Task Guard 규칙](../Tools/OMP_Global_Config/agent/rules/task-guard.md)은 발주 brief에 `WORK_CLASS`, `PRIMARY_DELIVERABLE`, `OWNED_PATHS` 등 작업 계약을 담도록 정합니다. [`command-guard` 확장](../Tools/OMP_Global_Config/agent/extensions/command-guard/)은 task dispatch에서 maker 역할·요청별 budget·작업 잠금·소유 경로를 검사하고, 자식 작업에서 실제로 바뀐 경로를 advisory로 보고합니다. `bash` 명령에서는 삭제·데이터베이스 변경·배포·Git 마감처럼 보호 대상 동작도 검사합니다. 별도 eval 경로를 이용한 child budget 우회도 막습니다. 이것은 Main의 요구사항 판단이나 최종 검수를 대체하지 않습니다.

## Typed judgment routing (Jev)

정식 신규 발주나 의미 있는 과제 변경 때 `maker_route`는 작업 분류·등급의 중심 난제·기존 owner 중복 등을 한 번에 판단하도록 사용됩니다. 첫 예상 밖 실패나 보고 검수처럼 다른 경계에서는 [`jev-runtime.ts`](../Tools/OMP_Global_Config/agent/extensions/jev-runtime.ts)가 런타임 advisory로 관측 가능한 사실을 제공하고, Main/owner가 그 사실에 담기지 않은 의미와 승인을 판단합니다. 같은 질문을 반복하거나 Jev 결과를 결정론적 권한·검수로 취급하지 않습니다. 정본은 [subagent 규칙](../Tools/OMP_Global_Config/agent/rules/subagent.md)의 “Typed judgment routing”과 policy `routing.typedJudgmentRouting`입니다.

## 캐릭터 음성과 확장

[`character-voice.ts`](../Tools/OMP_Global_Config/agent/extensions/character-voice.ts)는 사용자 대면 말투 block을 현재 세션에 주입하고, 캐릭터 호출 의도를 지정된 경로로 전달합니다. 사용자 지정 말투와 기술적 사실은 보존하고, 반복되는 고정 대사를 피하는 규칙은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md)에 있습니다. [`todo-nudge.ts`](../Tools/OMP_Global_Config/agent/extensions/todo-nudge.ts)는 사용자 요청 하나에서 Main이 TODO 목록 없이 도구를 세 번 부르면 요청당 한 번 목록을 만들라고 안내합니다. 사용자가 화면의 TODO로 진행 상황을 볼 수 있게 하려는 것이며, 도구를 막지 않고 child 세션에는 개입하지 않습니다. 다른 공개 확장과 `command-guard`는 `agent/extensions/`에 있습니다.

## Git 마감 도구

[`git_finalize`](../Tools/OMP_Global_Config/agent/tools/git-finalizer/)는 Main 전용 도구입니다. 정확한 파일 목록을 대상으로 경로·저장소 경계와 ancestry를 확인하고, 잠금 아래 commit 및 push를 수행합니다. Maker에게 Git 마감을 허용하는 도구가 아닙니다. 구현과 PowerShell finalizer는 `agent/tools/git-finalizer/`에 있습니다.

## omp core 패치

[`Tools/OMP_Global_Config/patches/`](../Tools/OMP_Global_Config/patches/)에는 이 하네스의 동작을 omp core에 맞춰 적용하는 패치와 적용·검증 도구가 있습니다. 예를 들어 `apply-core-patch.mjs`, `validate-harness-policy.mjs`, `core-*-test.ts`가 패치와 관련 회귀 검사를 담습니다. 구체적인 적용 명령은 각 패치 도구와 설치 환경에 따라 확인하세요. 이 문서는 CUELO 앱이 core 패치를 자동 설치한다고 뜻하지 않습니다. 원본 저장소의 CI는 앱이 고정한 core 버전을 새로 설치해 이 패치를 적용하고 회귀 검사를 실행합니다. 설치 도구가 요구하는 앱 source 해시 목록이 커밋된 소스와 맞는지도 같이 확인합니다. 공개 미러에는 그 검사에 필요한 설정·eval 자료가 없어서 해당 job을 건너뜁니다.

## 정본 자료

역할과 운용 요약은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md), 전역 구현 원칙은 [RULES.md](../Tools/OMP_Global_Config/agent/RULES.md), 상세한 위임·검수 절차는 [rules/subagent.md](../Tools/OMP_Global_Config/agent/rules/subagent.md), task dispatch 계약은 [rules/task-guard.md](../Tools/OMP_Global_Config/agent/rules/task-guard.md), 정책 데이터는 [rules/harness-policy.json](../Tools/OMP_Global_Config/agent/rules/harness-policy.json)에서 확인할 수 있습니다.
