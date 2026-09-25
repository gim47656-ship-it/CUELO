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

Maker는 자신이 바꾼 범위의 focused check와 실제 변경 표면 검증을 수행하고 원문 증거 locator를 보고합니다. Main은 확정된 변경분을 중간 검수하고, 마지막에는 각 수용 조건과 그 증거를 대조해 직접 판정합니다. Main은 Maker의 focused check를 같은 조건에서 반복하지 않으며, 필요할 때 공통 환경의 통합·전체 수용 검사를 수행합니다. 검사되지 않은 revision을 통과로 처리하지 않습니다. 자세한 책임 경계는 [검수와 수용](../Tools/OMP_Global_Config/agent/rules/subagent.md) 절과 policy의 `mainLane.workerReview`, `routing.reviewPacket`에 규정돼 있습니다.

## Task Guard와 command guard

[Task Guard 규칙](../Tools/OMP_Global_Config/agent/rules/task-guard.md)은 발주 brief에 `WORK_CLASS`, `PRIMARY_DELIVERABLE`, `OWNED_PATHS` 등 작업 계약을 담도록 정합니다. [`command-guard` 확장](../Tools/OMP_Global_Config/agent/extensions/command-guard/)은 task dispatch에서 maker 역할·요청별 budget·작업 잠금·소유 경로를 검사하고, 자식 작업에서 실제로 바뀐 경로를 advisory로 보고합니다. `bash` 명령에서는 삭제·데이터베이스 변경·배포·Git 마감처럼 보호 대상 동작도 검사합니다. 별도 eval 경로를 이용한 child budget 우회도 막습니다. 이것은 Main의 요구사항 판단이나 최종 검수를 대체하지 않습니다.

## Typed judgment routing (Jev)

정식 신규 발주나 의미 있는 과제 변경 때 `maker_route`는 작업 분류·등급의 중심 난제·기존 owner 중복 등을 한 번에 판단하도록 사용됩니다. 첫 예상 밖 실패나 보고 검수처럼 다른 경계에서는 [`jev-runtime.ts`](../Tools/OMP_Global_Config/agent/extensions/jev-runtime.ts)가 런타임 advisory로 관측 가능한 사실을 제공하고, Main/owner가 그 사실에 담기지 않은 의미와 승인을 판단합니다. 같은 질문을 반복하거나 Jev 결과를 결정론적 권한·검수로 취급하지 않습니다. 정본은 [subagent 규칙](../Tools/OMP_Global_Config/agent/rules/subagent.md)의 “Typed judgment routing”과 policy `routing.typedJudgmentRouting`입니다.

## 캐릭터 음성과 확장

[`character-voice.ts`](../Tools/OMP_Global_Config/agent/extensions/character-voice.ts)는 사용자 대면 말투 block을 현재 세션에 주입하고, 캐릭터 호출 의도를 지정된 경로로 전달합니다. 사용자 지정 말투와 기술적 사실은 보존하고, 반복되는 고정 대사를 피하는 규칙은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md)에 있습니다. 다른 공개 확장과 `command-guard`는 `agent/extensions/`에 있습니다.

## Git 마감 도구

[`git_finalize`](../Tools/OMP_Global_Config/agent/tools/git-finalizer/)는 Main 전용 도구입니다. 정확한 파일 목록을 대상으로 경로·저장소 경계와 ancestry를 확인하고, 잠금 아래 commit 및 push를 수행합니다. Maker에게 Git 마감을 허용하는 도구가 아닙니다. 구현과 PowerShell finalizer는 `agent/tools/git-finalizer/`에 있습니다.

## omp core 패치

[`Tools/OMP_Global_Config/patches/`](../Tools/OMP_Global_Config/patches/)에는 이 하네스의 동작을 omp core에 맞춰 적용하는 패치와 적용·검증 도구가 있습니다. 예를 들어 `apply-core-patch.mjs`, `validate-harness-policy.mjs`, `core-*-test.ts`가 패치와 관련 회귀 검사를 담습니다. 구체적인 적용 명령은 각 패치 도구와 설치 환경에 따라 확인하세요. 이 문서는 CUELO 앱이 core 패치를 자동 설치한다고 뜻하지 않습니다. 원본 저장소의 CI는 앱이 고정한 core 버전을 새로 설치해 이 패치를 적용하고 회귀 검사를 실행합니다. 설치 도구가 요구하는 앱 source 해시 목록이 커밋된 소스와 맞는지도 같이 확인합니다. 공개 미러에는 그 검사에 필요한 설정·eval 자료가 없어서 해당 job을 건너뜁니다.

## 정본 자료

역할과 운용 요약은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md), 전역 구현 원칙은 [RULES.md](../Tools/OMP_Global_Config/agent/RULES.md), 상세한 위임·검수 절차는 [rules/subagent.md](../Tools/OMP_Global_Config/agent/rules/subagent.md), task dispatch 계약은 [rules/task-guard.md](../Tools/OMP_Global_Config/agent/rules/task-guard.md), 정책 데이터는 [rules/harness-policy.json](../Tools/OMP_Global_Config/agent/rules/harness-policy.json)에서 확인할 수 있습니다.
