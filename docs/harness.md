# CUELO가 사용하는 공개 OMP 하네스

OMP 하네스는 코딩 에이전트가 요구를 작업으로 나누고, 변경을 검증하고, 증거로 검수하는 작업 규칙·SOP·확장·core 패치의 묶음입니다. 공개 트리는 [`Tools/OMP_Global_Config/agent/`](../Tools/OMP_Global_Config/agent/)와 [`Tools/OMP_Global_Config/patches/`](../Tools/OMP_Global_Config/patches/)에 있습니다. CUELO 앱과 구분되는 omp 작업 환경용 자료입니다.

## 설치와 공개 범위

공개된 `agent/`는 [설치 안내](installation.md)의 `setup`이 사용자의 `~/.omp/agent`에 복사합니다. 이미 있는 파일은 바꾸거나 지우지 않고, 없는 파일만 추가합니다. `config.yml`이 없는 프로필에는 기본 운영 설정(학습·메모리·요청 예산)으로 새 파일을 만들고, 제공자 요청을 스스로 쓰는 자동 기능은 꺼 둡니다. 이 저장소에는 사용자별 모델 설정이 없으므로 `modelRoles`는 사용자가 정합니다. 설치 때 `--model`(core `default`)과 `--role <이름>=<provider/model>`을 직접 넘기면 그 새 파일에 그 값만 적고, 나중에는 CUELO 설정의 Model roles 화면에서 바꿉니다. 기존 `config.yml`은 보존되어 플래그를 다시 줘도 역할·Jev 설정이 채워지지 않습니다. [기존 프로필 보완 절차](installation.md#기존-프로필의-역할과-jev-보완)를 따르세요. 지정하지 않은 하네스 역할은 `maker_route`에서 해당 후보만 사용 불가로 표시됩니다. CUELO 앱 자체는 이 하네스를 설치하지 않아도 기본 대화가 가능합니다.

공개 저장소에는 역할·검수 절차와 런타임 확장, 정책 규칙, core 패치가 포함됩니다. 반면 계정이나 모델 선택 정보를 담는 `config.yml`·`models.yml`, 개인 skills, 작업 기록은 공개하지 않습니다. npm 패키지도 해당 개인 파일과 제공자 API 키, 독립 `omp` CLI를 동봉하지 않습니다. 설치에 필요한 Node/Bun/Git과 기능별 CLI·메모리 모델의 경계는 [설치 안내](installation.md#새-windows-pc에서-먼저-준비할-것)를 따릅니다.

내장 코어는 OMP **18.5.1**을 사용합니다. upstream의 Windows SQLite 핸들·Git 줄바꿈·세션 소유권 개선과, Codex 실시간 끼어들기 거절 복구·대기 도구 정리를 반영하면서 세션 격리와 하네스의 도구 계약을 유지합니다. 발주별 모델 전달과 advisor 기록 제외 내보내기는 upstream 구현을 사용하고, Maker의 단일 모델·승인 후보·소유권 검증은 그대로 적용합니다. 공식 standalone CLI와 패치된 내장 코어의 동작 범위는 구분합니다. 완료율 추정 설정은 `task.completionProbe`이며, 웹의 SDK 실행 경로에서는 주기적인 추가 추정 요청을 하지 않습니다. 기존에 이 기능을 꺼둔 환경에는 이 항목의 추가 호출 절감이 없습니다.

캐릭터 확장(`character-voice.ts`)의 RIN·MIO는 Anthropic OAuth 저장 목록의 0번·1번 자리를 기본으로 씁니다. 이 번호는 저장 순서일 뿐 계정 ID·이메일 같은 개인 정보가 아니며, 공개본에서도 코드 그대로 동작합니다. 해당 자리에 쓸 자기 계정은 `omp`로 직접 로그인해 준비합니다. 계정이 하나뿐인 상태에서 MIO로 전환하면 1번 자리 계정을 찾지 못했다고 알리고 현재 세션 모델을 유지합니다.

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
`routing_verdict`의 `revision`은 Main이 실제로 검수한 revision입니다. 원장은 Maker 완료 보고에서 관측한
`sourceRevision`을 함께 보존합니다. 원본과 같으면 `same`, 다르지만 Main이 `integratedFrom`에 원본을
명시하면 `integrated`, 연결이 없거나 틀리면 `mismatch`, 원본을 관측하지 못했으면 `unknown`으로 기록합니다.
검수 revision을 생략한 `held`도 `unknown`입니다. `integratedFrom`은 연결 주장이며 실제 검수 근거는
기존 `reason`·`evidenceLocators`에 남깁니다. 불일치나 미관측 때문에 수용을 자동 거절하지 않고,
검수 revision이 있으면 진단을 돌려줍니다. 과거 기록의 원본을 추정하거나 품질 집계를 다시 쓰지 않습니다.
자동 전달된 결과도 실제 작업의 종료 상태를 보존합니다. 상태가 없으면 같은 작업의 확인 가능한 종료 기록을 사용하고, 그것도 없으면 정산을 보류합니다. 오류 본문을 키워드로 추측하거나 미확인 결과를 완료로 기록하지 않습니다. 실패한 작업은 완료를 전제로 한 수용 대상이 아닙니다.
서로 다른 호출에서 표시 이름과 작업 계약을 재사용해도 실행 초안과 결과 연결은 호출별로 유지합니다. 준비된 판단을 재사용하는 격리 작업도 각자의 실제 작업 식별자로 기록합니다. 하나가 종료되면 그 작업의 경로만 풀리고, 다른 작업과 재개된 작업의 경로는 계속 보호합니다.
취소 요청만으로 소유권을 풀지는 않습니다. 같은 실행의 실제 종료를 확인하면 다음 발주 전에 취소 결과와 담당 경로를 정산하므로 별도 조회가 필요하지 않습니다. 최근 표시 목록 밖으로 밀린 작업도 코어에 보관된 해당 실행의 종료 기록으로 확인합니다. 종료 중이거나 기록이 사라졌거나 다른 실행의 기록뿐이면 보호를 유지합니다. 이 조회는 대응하는 코어 패치와 확장을 함께 적용해야 하며, 이전 코어에서는 기존 조회 범위의 근거만 사용합니다.
사용자 요구로 목적·범위·수용 조건이 바뀌면 변경된 사실로 `maker_route`를 다시 판단합니다.
UI/UX 전문성 경계가 새로 확인되면 비-Opus owner의 미완 변경·증거를 보존해 명시적으로 이관하며, 같은 Opus owner와 완료된 비-UI 작업은 재사용합니다.
Main이 실제 재작업을 지시할 때는 [검수와 수용](../Tools/OMP_Global_Config/agent/rules/subagent.md#검수와-수용)의
`REWORK task_id=... role=maker previous_revision=... next_revision=...`와
`finding_id=... source=...`를 후속 메시지에 넣어야 합니다. 평문 지시만으로 새 attempt가 기록되지는 않습니다.
REWORK 전송 뒤 시작된 재개 실행은 코어가 같은 job id를 다시 써도 그 실행 하나만 다음 attempt(`#a2` 등)로 기록됩니다.
CUELO가 재시작된 뒤에도 같은 Main 세션에서 이전 Maker에게 `write agent://<id>`를 보내면, 코어가 그 Maker의 저장된 대화와 도구·프롬프트 계약으로 되살려 메시지를 받게 합니다. 재시작 순간 실행 중이던 도구 호출과 백그라운드 작업은 이어지지 않으며, `isolated` 작업 공간으로 띄운 Maker는 되살리지 않습니다.
`maker_route`에 표시되는 history는 Jev 분류 **후** Main에게 붙는 건수 advisory이며 분류 입력이나
모델·강도 자동 조정 근거가 아닙니다.

등급(`NORMAL`·`HARD`)과 후보 이름은 구분합니다. 후보는 `NORMAL_SONNET`, `NORMAL_OPUS`, `NORMAL_SOL`, `NORMAL_DEEPSEEK`, `HARD_UI_OPUS`, `HARD_CODE_OPUS`, `HARD_CODE_SONNET`, `HARD_CODE_ASTRA`처럼 실제 모델 계열을 표시합니다. NORMAL도 레이아웃·반응형·접근성·포커스·터치 표적 등 UI/UX 판단이 남으면 Opus를 선택하며, 이를 위해 HARD로 승격하지 않습니다. 비-UI NORMAL은 Sonnet을 우선하고 실제 사용 불가·소진 시에만 DeepSeek를 추천합니다. 기존 NORMAL의 명시적 Opus 선택도 유지합니다. UI/UX의 Opus unavailable은 다른 모델로 숨겨 대체하지 않습니다. HARD 코드의 기본은 Opus이고, `HARD_CODE_SONNET`·`HARD_CODE_ASTRA`는 `ROUTING_REASON`을 남길 때만 고르는 대안입니다. `NORMAL_SOL`도 자동 추천 대상이 아니라 명세가 분명한 비-UI 코드에서 지연보다 비용이 중요할 때 `ROUTING_REASON`으로 고르는 대안이며 Sonnet 기본을 대체하지 않습니다. 기존 평가는 표본이 작아 이 대안들의 우월성을 증명하지 않습니다.

후보별 추론 강도는 정책의 `allowedEfforts`와 실제 모델 지원 단계의 교집합입니다. `NORMAL_SONNET`·`HARD_CODE_SONNET`·`NORMAL_SOL`은 `medium`~`xhigh`, `HARD_CODE_ASTRA`는 `high`~`xhigh`, Opus 후보 셋은 `high`~`max`(기본 `high`, `max`는 기본값이 아님), DeepSeek는 `high`만 사용합니다. `max`는 Opus 후보에서만 허용되므로 child 추론 상한 `task.maxEffort`는 `max`입니다. 이 정책은 Main의 Auto나 실행 중인 세션의 모델·강도를 소급 변경하지 않습니다. 재작업을 새로 발주할 때는 관측 신호가 있으면 같은 후보의 강도를 허용 구간 안에서 한 단계 올립니다. 신호는 수정 뒤 같은 검사가 같은 원인으로 다시 실패한 경우, Main 검수에서 원인 오진이나 수용 조건 누락이 확인된 경우, 실행 중에 Main이 범위를 늘린 경우, Maker가 막혔다고 스스로 보고한 경우입니다. 재작업 횟수만으로는 올리지 않고, 실행 중인 Maker의 강도는 바꾸지 않습니다. 이미 상한이면 강도 대신 모델·분할·브리프를 다시 봅니다.

CUELO의 패치된 내장 코어에서 Main은 Auto를 유지하며 새 사용자 턴의 자동 선택에 `providers.autoThinkingMinEffort: medium`과 `providers.autoThinkingMaxEffort: xhigh`를 적용합니다. 분류 실패 시 이전 값으로 대체하는 경우에도 같은 하한을 사용합니다. 모델이 지원하는 단계와 명시된 세션 상한 안에서만 고르며, 추론 조절이 없는 모델에 값을 만들어 넣지는 않습니다. 실행 중에 사용자가 직접 보낸 Steer·Follow-up은 이번 턴 요청에 이어 붙여 다시 판정하고, 결과가 현재 강도보다 높을 때만 다음 모델 요청부터 올립니다. 같은 턴 안에서는 내리지 않으며, 다음 새 사용자 턴은 평소처럼 처음부터 다시 고릅니다. 판정을 기다리지 않으므로 메시지 전달은 늦어지지 않고, 입력마다 판정 요청이 한 번 늘어납니다. 강도가 바뀌면 일부 제공자에서 프롬프트 캐시가 한 번 다시 쓰일 수 있습니다. 에이전트가 넣은 메시지·숨김 메시지·도구 후속 실행·수동 선택과 고정 강도 세션(Maker 포함)의 강도는 바꾸지 않습니다. 공식 standalone `omp` 실행 파일에는 이 로컬 코어 패치가 포함되지 않으므로 CLI 업데이트만으로 해당 동작이 적용되지는 않습니다.

웹 입력창의 Auto 선택·상한과 「현재 추론 강도」는 서로 다른 값입니다. 선택기는 자동 선택에 허용한 상한을 보여 주고, 별도 표시는 코어가 보고한 실효값을 보여 줍니다. 새 대화에서는 상한 적용을 마치기 전까지 첫 메시지와 내장 명령 실행을 기다리며, 연결 실패 뒤 다시 보내면 같은 세션에서 미완 적용을 재시도합니다.

사용자가 직접 Steer를 보내면 패치된 내장 코어는 도구 호출이 아직 나오지 않은 모델 요청을 교체하고, 같은 실행 안에서 새 지시로 다시 요청합니다. 제공자가 실시간 주입을 수락했더라도 응답 종료 신호를 기다리지 않습니다. 본문이 이미 표시됐다면 그 본문과 완료된 서명 추론은 보존하고, 작성 중인 추론은 세션 기록과 다음 요청에서 제외합니다. 아직 보인 본문이 없다면 기존 부분 응답을 버립니다. 도구 호출이 나온 요청, 내부 메시지와 Follow-up은 기존 전환 경계를 따릅니다. 세션 중단·목표 일시정지·추론 상한 변경은 하지 않습니다. 재계산에 따른 사용량이 발생할 수 있으며, 요청을 바로 전환해도 새 답변 생성 시간까지 보장하지는 않습니다. 공식 standalone `omp` 실행 파일에는 이 로컬 패치가 포함되지 않습니다.

CUELO의 목표 모드에서 실행을 취소하면, 취소 정리가 끝나기 전에 실행 종료 알림이 와도 자동 이어 가기를 다시 시작하지 않습니다. 취소에 따른 중단은 사용자의 직접 입력이나 명시적인 목표 시작·변경·재개로만 해제됩니다. 이미 일시정지된 목표는 새 메시지만으로 재개되지 않으며 `/goal resume`이 필요합니다.

패치된 내장 코어의 Anthropic 계정 재선택은 오늘 쓸 몫 안에 있는 계정 가운데 주간 한도가 곧 리셋되는데 많이 남은 계정을 먼저 씁니다. 순서는 남은 주간 비율을 리셋까지 남은 시간으로 나눈 값(upstream의 required drain)이 큰 쪽이고, 같으면 저장 순서(RIN 먼저)입니다. 오늘 몫은 사용량 패널과 같은 기준으로, 주간 창에서 지난 날 수에 오늘 하루를 더한 몫입니다. 예를 들어 사흘째라면 3/7까지입니다. 몫을 넘은 계정은 몫 안의 계정 뒤로 가고, 두 계정이 모두 넘었으면 덜 넘은 쪽을 씁니다. 사용량·주간 리셋 정보가 완전한 건강한 후보만 재배열하며, 조회 실패·부분 정보는 추정하지 않고 기존 한도·예비량·5시간 보호를 유지합니다. 사용 중인 warm pin과 명시적으로 지정한 캐릭터 계정은 이 선호로 전환하지 않습니다. 캐릭터 `교체`와 summon은 모두 그 계정을 세션 exact pin으로 고정하므로, 그 계정이 막히거나 한도에 닿으면 다른 계정으로 조용히 넘어가지 않고 실패로 알립니다.

캐릭터 summon 표시 없이 띄운 일반 Maker는 부모 세션의 Anthropic 계정 고정(warm pin과 exact pin)을 물려받지 않고 위 순서로 새로 고릅니다. summon으로 부른 Maker는 지정한 자리를 다시 exact pin으로 고정합니다. Maker가 아닌 자식과 다른 provider의 계정은 전처럼 부모에게서 물려받습니다.

패치된 내장 코어는 thinking 요약을 생략하는 설정(`omitThinking`)에서도 Claude Opus 5.5 같은 최신 모델이 도구 호출 사이에 쓴 사용자용 진행 문장(progress update)을 본문으로 보여 줍니다. Anthropic은 이 문장을 별도 thinking 블록으로 보내므로, 생략 설정(`display: "omitted"`)을 그대로 쓰면 화면과 세션 기록에서 사라집니다. 코어는 공식 Anthropic API로 가는 이 요청을 `display: "updates"`(beta 헤더 `thinking-display-updates-2026-08-18`)로 보냅니다. 그러면 reasoning은 비어서 오고, 텍스트가 온 진행 문장만 본문 text로 내보냅니다. thinking 서명은 공식 문서대로 불투명 값으로 다루고 해석하지 않으며, 다음 요청에는 서명된 원래 thinking 블록을 그대로 돌려보냅니다. 공식 API가 아닌 주소는 upstream 동작을 따릅니다. 이 동작도 standalone `omp` 실행 파일에는 포함되지 않습니다.

edit 도구가 이전 read·검색에서 온전히 보이지 않은 줄을 기준으로 한 편집을 거부할 때, 패치된 내장 코어는 그 안내를 한국어로 바꿔 모델에 전달합니다. 안내 원문은 native 모듈이 영어로 만들며, 영어 안내 바로 뒤에 Main이 진행 문장을 영어로 이어 쓰는 일이 있었습니다. 알려진 문장 틀만 바꾸고 파일·줄·태그와 파일 내용 줄은 그대로 두며, 틀이 다른 오류는 원문을 유지합니다.

upstream 18.3.3부터 코어는 `task`·`bash`를 가진 SubAgent에 `wait`를 자동으로 붙입니다. CUELO에서 `wait`는 Main 전용이므로 패치된 내장 코어는 이 자동 부여만 막고, agent 정의가 `wait`를 직접 적은 경우에는 그대로 줍니다. SubAgent는 자기 background job 결과를 기다리지 않고 자동 재개로 받습니다.

에이전트의 `ask` 질문은 추천안(`recommended`)과 자동 선택 허용(`autoSelectRecommended: true`)을 모두 단 질문만 설정한 대기 시간(이 프로필은 `ask.timeout: 120`, 2분) 뒤 추천안으로 진행합니다. 그 밖의 질문과 plan mode 질문은 답할 때까지 기다립니다. 웹 질문 창은 이 안내를 보여 주고, 옵션을 고르거나 답을 입력하면 대기 시간을 다시 시작합니다. 타임아웃으로 고른 답은 결과에 "사용자 응답·승인이 아님"으로 표시되고, 규칙상 배포·삭제·비용·계정·권한·provider 안전 확인 질문에는 자동 선택을 켜지 않습니다.

SubAgent의 service tier는 `tier.subagent: inherit`으로 Main을 따르되, 패치된 내장 코어는 Main의 OpenAI Fast(`priority`)만 새 SubAgent에 넘깁니다. Main의 Anthropic·Google Fast와 Ultrafast·flex는 SubAgent로 자동 상속하지 않습니다. `tier.subagent`에 값을 직접 적거나 agent별 override를 두면 그 값이 그대로 적용됩니다. Fast를 지원하지 않는 모델에는 요청에 싣지 않습니다.

Maker는 자신이 바꾼 범위의 focused check와 실제 변경 표면 검증을 수행하고 원문 증거 locator를 보고합니다. Main은 확정된 변경분을 중간 검수하고, 마지막에는 각 수용 조건과 그 증거를 대조해 직접 판정합니다. Main은 Maker의 focused check를 같은 조건에서 반복하지 않으며, 필요할 때 공통 환경의 통합·전체 수용 검사를 수행합니다. 검사되지 않은 revision을 통과로 처리하지 않습니다. 자세한 책임 경계는 [검수와 수용](../Tools/OMP_Global_Config/agent/rules/subagent.md) 절과 policy의 `mainLane.workerReview`, `routing.reviewPacket`에 규정돼 있습니다.

upstream 18.4.12는 SubAgent가 빌드·테스트·스모크를 아예 돌리지 않고 검증을 Main에 넘기도록 바꿨습니다. 패치된 내장 코어는 이 계약을 위 분담으로 되돌립니다. Maker는 자기 변경의 집중 검사(테스트 파일 하나·타깃 재현·스모크)를 실행해 명령과 종료 코드를 보고하고, 실행할 수 없거나 무거운 통합 검사는 Main이 돌릴 정확한 명령으로 넘깁니다. 같은 작업 공간을 쓰는 Maker는 배정에 명시되지 않은 프로젝트 전체 빌드·포매터·린터·전체 테스트를 돌리지 않습니다. 형제 Maker의 미완 편집과 CPU 경합 때문입니다. 별도 worktree로 띄운 `isolated` Maker에는 이 금지가 없습니다. Main 세션의 프롬프트는 upstream 그대로입니다. upstream 18.4.11부터 실행 중인 SubAgent에 주기적으로 완료율을 묻는 기능(`task.completionProbeMs`, 기본 2분)은 묻는 횟수만큼 모델 요청이 늘어납니다. 공개 설치는 이 기본값을 바꾸지 않으므로, 끄려면 자기 `config.yml`의 `task.completionProbeMs`를 `0`으로 둡니다.

교훈은 Mnemopi 기억으로 남습니다. `learn`은 Main 세션에만 있으며 저장한 기억 id를 결과에 돌려줍니다. Maker는 교훈을 직접 저장하지 않고 종료 보고에 교훈 후보(적용 조건·원인·바뀐 행동·성공 근거)를 싣습니다. 저장·기존 교훈 연결·기각은 Main이 정합니다. 패치된 내장 코어에서 Maker 세션은 첫 턴에 자기 작업 brief로 기억을 한 번 회상하고, 주입되는 `<memories>` 줄마다 `(id: …)`가 붙습니다. 이전에는 부모 Main의 첫 턴 회상만 물려받았습니다. Main은 위임 attempt가 실제로 적용한 교훈을 `routing_verdict`의 선택 필드 `appliedLessons`에 기억 id로 남기고, 적용 근거는 `evidenceLocators`로 남깁니다. 이 필드는 기록일 뿐 수용 조건을 바꾸지 않으며, 교훈의 효과를 자동으로 판정하지도 않습니다. Main이 혼자 끝낸 작업은 원장에 attempt가 없으므로, 패치된 코어가 Main·Maker 모든 세션에서 첫 턴에 실제로 전달한 기억 id를 LLM 문맥에 들어가지 않는 세션 기록(`mnemopi-recall`)으로 남깁니다. 이 기록과 세션 중 `recall` 결과의 id로 교훈이 전달된 세션과 그 뒤 같은 실패가 다시 났는지를 셀 수 있습니다.
저장 범위도 Main이 판단합니다. 여러 프로젝트에 적용되는 사용자 선호와 작업 운영 원칙은 전역 기억(`global`)으로, 특정 저장소의 구현·경로·환경에 종속된 사실은 프로젝트 기억(`project`)으로 남깁니다. 기존 교훈이 있으면 중복 저장보다 연결·수정을 우선합니다.

교훈 자동 기록(`autolearn`)을 켜면 도구를 많이 쓴 턴이 끝날 때마다 대화와 분리된 짧은 정리 단계가 교훈을 따로 저장합니다. 정리 단계는 교훈 맨 앞에 한 문장 요약을 붙입니다. 저장한 것이 있으면 대화에 "[교훈 자동 저장] N건" 메시지로 교훈마다 그 요약 한 줄을 최대 3건까지 보여 주고, 다음 턴의 모델도 그 메시지를 봅니다. 이 알림은 작업 과정을 접어도 대화 흐름에 남습니다. 저장한 것이 없으면 아무것도 띄우지 않습니다. 공개 설치의 기본값은 꺼짐입니다.

에이전트가 직접 `learn`이나 `manage_skill`로 저장한 교훈·스킬은 자동 기록 설정과 별개로 해당 턴 끝의 "[교훈 저장]" 카드에서 확인합니다. 마지막 답변 뒤에 저장한 내용도 포함하며, 실패한 호출이나 스킬 삭제는 저장 알림에 넣지 않습니다.

Main 승인이 작업을 막고 있다면 관계없는 문서 정리나 새 발주보다 필요한 확인과 회신을 먼저 처리합니다. 승인과 완료 보고가 엇갈렸을 때는 이미 끝난 검사를 반복하지 않고 최신 승인과 남은 동작을 대조해 이어갑니다. 실패를 기록하는 데서 끝내지 않고 기존 규칙의 실행 위반과 실제 누락을 구분해 다음 작업에 반영하며, 효과를 관측하기 전에는 개선됐다고 단정하지 않습니다.

## 다중 파일 조사 `skim`

Main과 Maker는 [`skim.ts`](../Tools/OMP_Global_Config/agent/extensions/skim.ts)의 `skim(paths, question)`으로 cwd 안 파일·디렉터리·glob의 텍스트를 Gemini Flash에 묻고 근거 경로가 붙은 답을 받습니다. Gemini 실패 시 같은 안전 필터를 거친 동일 입력으로 `b-ai/deepseek-v4.1-flash`에 한 번 대체하며, 첫 줄에 실제 응답 모델, 그 다음 줄에 Gemini 실패 원문을 표시합니다. DeepSeek는 별도 역할 slot을 만들지 않고 이 도구에서만 지정합니다. 허용 파일 내용은 Google 또는 대체 시 B.AI로 전송됩니다. 자기 프로필에 `modelRoles.skim: google-antigravity/gemini-3.8-flash`와 각 제공자 인증이 필요합니다. `.env*`와 인증·비밀 경로, **명시 경로도 포함한** gitignore 대상, 바이너리와 1 MiB 초과 파일은 제외합니다. 전송량은 파일당 48 KiB, 요청당 192 KiB로 제한하며 빠지거나 잘린 파일을 결과에 표시합니다. 정확한 편집 줄은 `read`로 확인합니다. 이미지 `vision`과 Jev 기반 `find`는 바꾸지 않습니다.

`modelRoles.tiny`는 Gemini Flash입니다. 세션 제목 생성은 코어의 `tiny → commit → smol` 순서를 써서 Gemini 실패 시 `commit`의 `anthropic/claude-sonnet-5-5`로 넘어가고, Mnemopi의 `memory` 역할은 전용 후보 체인에서 Sonnet을 시도합니다. `tts/speech-enhancer`는 단일 `@tiny` 호출에 실패하면 모델을 바꾸지 않고 기존의 기계적 음성 텍스트 정규화로 돌아갑니다. Gemini의 모델 키 전체에 retry 체인을 걸지 않아 `vision`은 바뀌지 않습니다.

## Task Guard와 command guard

[Task Guard 규칙](../Tools/OMP_Global_Config/agent/rules/task-guard.md)은 발주 brief에 `WORK_CLASS`, `PRIMARY_DELIVERABLE`, `OWNED_PATHS` 등 작업 계약을 담도록 정합니다. [`command-guard` 확장](../Tools/OMP_Global_Config/agent/extensions/command-guard/)은 task dispatch에서 maker 역할·요청별 budget·작업 잠금·소유 경로를 검사하고, 자식 작업에서 실제로 바뀐 경로를 advisory로 보고합니다. `bash` 명령에서는 삭제·데이터베이스 변경·배포·Git 마감처럼 보호 대상 동작도 검사합니다. 별도 eval 경로를 이용한 child budget 우회도 막습니다. 이것은 Main의 요구사항 판단이나 최종 검수를 대체하지 않습니다.

같은 `task` 배치에서 공유 작업공간 Maker들의 `OWNED_PATHS`가 겹치면 어떤 작업도 예약하지 않고 배치 전체를 거절합니다. 별도 호출도 앞선 호출의 승인 중 예약과 충돌하면 막습니다. 시작한 작업은 실제 owner로 넘기고, 거절·실패·미실행으로 끝난 호출은 자기 예약만 해제합니다. 하류 guard가 거절한 호출도 같은 메시지의 준비 단계에서는 예약을 유지하므로 뒤 호출이 보수적으로 막힐 수 있으며, 호출 종료 뒤 다음 발주에서 풀립니다.

별도 worktree로 실행하는 `isolated` 작업은 공유 작업공간 충돌에서 제외합니다. 실제로 시작된 작업의 소유 경로와 격리 여부는 원장에 저장해 세션을 다시 열어도 복원합니다. 완료된 Maker도 REWORK나 일반 후속 지시로 실제 job이 실행 중이면 같은 경로를 보호합니다. 과거 원장의 running 상태만으로 잠그지 않으며, 끝났거나 사라진 실행은 경로를 계속 점유하지 않습니다. 옛 기록에 소유 경로가 없으면 실행 중인 동안만 공유 작업공간의 새 발주를 막습니다.

`bash` 도구의 내장 셸은 PowerShell이 아니므로, 명령 위치의 cmdlet(`Test-Path`, `Set-Content` 등), 따옴표 밖의 `$env:NAME`, `$x = ...` 대입, `if (...) { }` 블록, `$`가 든 `powershell -Command` 인자는 실행 전에 막고 `write`로 만든 `.ps1`을 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File`로 실행하라고 안내합니다. 따옴표 안의 값과 heredoc 본문은 데이터로 보고 검사하지 않습니다.

## Typed judgment routing (Jev)

정식 신규 발주나 의미 있는 과제 변경 때 `maker_route`는 작업 분류·등급의 중심 난제·기존 owner 중복 등을 한 번에 판단하도록 사용됩니다. 첫 예상 밖 실패나 보고 검수처럼 다른 경계에서는 [`jev-runtime.ts`](../Tools/OMP_Global_Config/agent/extensions/jev-runtime.ts)가 런타임 advisory로 관측 가능한 사실을 제공하고, Main/owner가 그 사실에 담기지 않은 의미와 승인을 판단합니다. 같은 질문을 반복하거나 Jev 결과를 결정론적 권한·검수로 취급하지 않습니다. 정본은 [subagent 규칙](../Tools/OMP_Global_Config/agent/rules/subagent.md)의 “Typed judgment routing”과 policy `routing.typedJudgmentRouting`입니다.

Jev 런타임은 `findScopedSettings(ctx.cwd)`로 실제 실행 프로필/프로젝트 설정을 읽고 SDK의 `resolveJudge`를 호출합니다. 이 확장은 API 키 파일이나 비공개 `models.yml`을 복사해서 활성화되지 않습니다. 설정 기본값 `auto`는 자격 있는 `modelRoles.judge` 체인으로 해석되고, 첫 native 판정 후보 뒤로는 chat/local 후보와 세션 모델을 붙이지 않습니다. CUELO는 `judge`에 OpenRouter의 `typesafe/jev-1.13`(판정 전용 `openrouter-decisions` API)을 두며, 판정 한 번은 1초 안에 끝납니다. 패치된 SDK의 `providers.judgmentProvider: vercel` 모드는 **Vercel AI Gateway**에 저장된 `vercel-ai-gateway` API 키로 `typesafe-ai/jev` 한 경로만 호출하며 실패 시 chat 모델로 대체하지 않습니다. 이 모드는 Vercel 유료 크레딧이 필요합니다(무료 등급은 HTTP 403). Maker 후보 여섯 개는 이 Jev 역할과 별도로 `modelRoles.implSonnet` 등에서 읽습니다. 가입·키 입력·역할 지정은 [기존 프로필의 역할과 Jev 보완](installation.md#기존-프로필의-역할과-jev-보완)에서 사용자가 직접 마칩니다. 실제 판정의 외부 요청/과금과 미검증 경계는 `setup`·`health` 성공으로 넘기지 않습니다.

`maker_route`는 Jev 판정과 후보 제공자 사용량 조회를 함께 시작하고, 빠른 판정에도 조회를 조기 취소하지 않습니다. 사용량 조회는 기존 2초 제한 안의 결과를 기다리며 실패·timeout은 미측정으로 표시합니다. 사용량은 배정 참고 정보이지 Jev 판단 입력이 아닙니다.

턴 경계에는 JEV를 두 곳 더 씁니다. [`turn-end-guard.ts`](../Tools/OMP_Global_Config/agent/extensions/turn-end-guard.ts)는 작업 중 사용자가 던진 질문에 이후 본문이 실제로 답했는지 입력당 한 번 판정하고, 미답이면 먼저 답하라고 안내합니다. [`external-advice-check.ts`](../Tools/OMP_Global_Config/agent/extensions/external-advice-check.ts)는 다른 모델의 긴 답을 붙여 검증을 요청하면 주장별 확인 목록을 만들어 그 사용자 메시지와 같은 턴에 숨김 메시지로 붙입니다. 별도 턴을 열지 않으므로 긴 첫 메시지가 밀려나지 않습니다. 두 곳 모두 경로·URL·코드·secret을 지운 짧은 발췌만 보내고, 승인이나 도구 차단이 아닙니다. `jev-runtime.ts`는 Windows 셸 경계 실패(PowerShell 변수 소실, 역슬래시 경로 소실, PATH 첫 `bash`인 WSL이 CRLF `.sh`를 읽어 낸 `$'\r'` 구문 오류, Windows `curl.exe`가 `-o /dev/null`에 쓰지 못해 응답을 받고도 낸 exit 23 등)를 따로 분류해 고치는 방법을 알리고, 이 세션이 띄운 실행 중 작업이 쥔 폴더를 지우려는 호출은 그 작업이 끝날 때까지 막습니다. `verify.ps1`은 PATH 첫 `bash`가 WSL 실행기이면 판정에 넣지 않는 경고 한 줄을 출력합니다.

같은 판정을 세 곳에 더 씁니다. [`steering-reply-gate.ts`](../Tools/OMP_Global_Config/agent/extensions/steering-reply-gate.ts)는 작업 중 끼어든 질문에 첫 도구 앞 본문이 답했는지 판정합니다. 질문이 아닌 지시·수락에는 이를 받아들이는 답도 인정합니다. 판정은 뒤에서 돌아 도구 실행을 붙잡지 않으며, 이후 본문이 바뀌거나 실행이 끝났으면 늦게 도착한 판정으로 다시 답하게 하지 않습니다. `turn-end-guard.ts`는 미완 TODO가 없어도 승인 없이 지금 할 수 있는 일을 "다음에 하겠다"로 남기고 끝낸 턴을 잡아 이어 가라고 안내합니다. 배포·삭제·비용·사용자 선택·외부 대기는 자동으로 이어 가지 않고, 체크포인트 회신을 기다리는 child 세션은 제외합니다. 사용자 정지나 업데이트·재시작 중단으로 abort된 턴도 다시 깨우지 않습니다. 업데이트가 세션을 멈춘 뒤 옛 서버에서 도구가 다시 도는 일을 막기 위해서입니다. [`todo-nudge.ts`](../Tools/OMP_Global_Config/agent/extensions/todo-nudge.ts)는 요청이 들어올 때 여러 항목·단계 요청인지 한 번 판정해, 그럴 때만 TODO 목록 안내를 냅니다. 판정이 없거나 실패하면 도구 세 번 규칙으로 돌아갑니다. `jev-runtime.ts`의 재시도 경계는 judge 없이 로컬에서 테스트·CI 실패를 시간 초과·모듈/환경·source manifest 불일치·assertion으로 나눠, 다시 돌릴 일인지 고칠 일인지 알려 줍니다.

화면 확인에도 JEV를 씁니다. [RULES.md](../Tools/OMP_Global_Config/agent/RULES.md)의 화면 확인 규칙은 Main과 Maker 모두에 적용됩니다. 웹은 `browser`, 네이티브 데스크톱 창은 `computer`, 로직은 테스트로 확인합니다. 조작·대기·확인 여러 단계를 한 `eval` 셀에 묶고, DOM 텍스트·AX 트리는 문자열 비교로 먼저 확인합니다. 문자열로 가를 수 없는 판정만 같은 셀에서 `judge()`(JEV)에 텍스트로 넘기므로, 단계마다 모델 턴을 거치지 않습니다. 스크린샷은 모양을 봐야 할 때만 찍고, `judge()` 결과는 참고 신호일 뿐 최종 수용 근거가 아닙니다. `computer`는 실제 데스크톱을 조작하므로 자기가 띄운 창만 다루고, 되돌릴 수 없는 버튼은 누르지 않습니다. 같은 순서를 여러 문서·기록·로그를 분류할 때(정해진 문구로 거른 뒤 남은 것만 `judge_batch`)와 긴 작업을 감시할 때(종료 문구는 문자열, "멈췄나"만 `judge()`)도 씁니다. 기준선과 비교하는 재측정은 기준선과 같은 방법으로 셉니다.

패치된 내장 코어의 `computer` 행동(`press`·`click`·`setValue`·`focus`·창 좌표 입력 등)은 `{ action, status, suggestedNext, evidence?, reacquired? }`를 돌려줍니다. `status`는 `verified`·`unverified`·`suspected_noop`이고, `verified`는 행동 전후 접근성 readback에서 값·포커스·상태 변화를 읽었을 때만 붙습니다. 좌표·키 입력은 읽을 대상이 없어 늘 `unverified`와 `reobserve`입니다. `ax()`·`find()`가 준 ref가 화면 갱신으로 만료되면 발급 때 저장한 지문(role·이름·RuntimeId·AutomationId·이름 있는 부모 경로·위치)으로 후보를 좁혀, 하나로 특정될 때만 그 요소를 다시 잡습니다. 후보가 없거나 여럿이면 다른 요소를 조작하지 않고 기존 `StaleRef`로 실패하며, 오류의 `computerAction` 필드에 거절 이유와 후보를 싣습니다. 설계는 [Cua의 행동 결과 계약](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-result-contract.md)과 [browser-use의 요소 재식별](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/service.py)을 참고했습니다.

행동 뒤 목표 상태는 `computer.run` 안에서 행동을 한 번 부른 다음 `wait(predicate, { timeout })`으로 확인합니다. 예: `await save.press(); const row = await wait(async () => (await win.find({ title: "Saved row 1" }))[0], { timeout: 5000 });`. `wait(predicate)`는 upstream에 이미 있던 기능이고, 새 API나 도구는 추가하지 않았습니다. 기존에는 predicate를 100ms 고정 간격으로 다시 불렀고, 그 안의 클릭·도구 호출도 매번 그대로 실행했습니다. 늦게 끝난 읽기의 나머지 코드도 deadline 뒤에 계속 돌았습니다. 패치된 코어는 다음처럼 바꿉니다.

- predicate를 바로 한 번 읽고, 이후 100·250·500·1000ms 간격으로 다시 읽습니다(마지막 간격 반복). `interval`을 주면 그 고정 간격(최소 10ms)을 씁니다. 대기는 남은 시간을 넘지 않고, deadline이나 취소 뒤에는 새 읽기를 시작하지 않습니다. 참이 되면 그 값만 돌려줍니다.
- predicate 안에서 데스크톱 입력·`clipboard.write`·도구 호출은 실행 전에 거절됩니다. 그래서 목표가 늦거나 끝내 나오지 않아도 다시 클릭하거나 takeover하거나 다른 창을 고르지 않습니다. 스크린샷은 읽기로 허용하되 probe마다 이미지를 대화에 붙이지 않습니다.
- 제한 시간 안에 목표가 없으면 `wait(predicate) timed out after …` 오류로 끝나고, 취소는 취소로 끝납니다. predicate 안의 native·프로그래밍 오류는 재시도하지 않고 그 오류를 그대로 올립니다. 제한 시간·취소·성공 뒤에는 늦게 끝난 읽기의 나머지 코드가 데스크톱을 더 읽거나 조작하지 못합니다.

predicate는 여전히 샌드박스가 아닌 Bun/Node 코드입니다. 위 거절은 데스크톱 facade와 도구 bridge에만 적용되고, 임의 I/O를 모두 막지는 않습니다. 어떤 행·문구·값이 목표인지는 호출하는 쪽이 정해야 하고, 버튼 모양 변화만으로 저장이 성공했다고 보지 않습니다. 이 대기는 행동의 승인 등급을 바꾸지 않으므로, 저장·전송처럼 결과가 남는 클릭은 전처럼 사용자 승인이 필요합니다. 간격과 deadline 처리는 [Playwright `pollAgainstDeadline`](https://github.com/microsoft/playwright/blob/main/packages/isomorphic/timeoutRunner.ts)과 [`expect.poll`](https://playwright.dev/docs/test-assertions#expectpoll)을 참고했고, 코드를 가져오거나 의존성을 추가하지 않았습니다.

이미지를 읽을 때는 vision 모델에게 먼저 묻습니다. [`image-question-router.ts`](../Tools/OMP_Global_Config/agent/extensions/image-question-router.ts)는 Main이나 Maker가 이미지 파일을 `?q=` 없이 `read`하려 하면, 이미지가 컨텍스트에 실리기 전에 그 경로의 첫 읽기를 막고 `경로?q=<질문>`으로 다시 읽게 합니다. 글자·값 확인뿐 아니라 레이아웃·간격·색·정렬·잘림 같은 형태 판단도 `modelRoles.vision` 모델이 보고 답만 텍스트로 돌아옵니다. JEV 판정 없이 동작하는 로컬 규칙이며, vision 답으로 부족하면 같은 경로를 한 번 더 읽어 직접 볼 수 있습니다. `browser`·`computer` 스크린샷은 `read`가 아니라서 대상이 아닙니다.

## 캐릭터 음성과 확장

[`character-voice.ts`](../Tools/OMP_Global_Config/agent/extensions/character-voice.ts)는 사용자 대면 말투 block을 현재 세션에 주입하고, 캐릭터 호출 의도를 지정된 경로로 전달합니다. 사용자 지정 말투와 기술적 사실은 보존하고, 반복되는 고정 대사를 피하는 규칙은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md)에 있습니다. [`todo-nudge.ts`](../Tools/OMP_Global_Config/agent/extensions/todo-nudge.ts)는 사용자 요청 하나에서 Main이 TODO 목록 없이 도구를 세 번 부르면 요청당 한 번 목록을 만들라고 안내합니다. 사용자가 화면의 TODO로 진행 상황을 볼 수 있게 하려는 것이며, 도구를 막지 않고 child 세션에는 개입하지 않습니다. 다른 공개 확장과 `command-guard`는 `agent/extensions/`에 있습니다.

[`korean-reply-guard.ts`](../Tools/OMP_Global_Config/agent/extensions/korean-reply-guard.ts)는 Main의 사용자 표시 답변이 영어로 새는 일을 막습니다. 코드·인라인 코드·URL·경로·식별자·원본 오류 줄을 뺀 산문에서 라틴 글자가 40자 이상이고 한글 비율이 15% 미만이면 영어로 봅니다. 처음 한 번은 숨김 안내로 다음 답부터 한국어로 쓰게 하고, 그래도 이어지면 `modelRoles.tiny` 모델로 번역한 한국어를 원문 아래에 표시합니다. 번역은 모델 문맥에서 빠지고, 민감 정보처럼 보이는 글은 외부로 보내지 않습니다. 사용자가 영어로 쓰거나 영어 답을 요청한 턴과 서브에이전트에는 개입하지 않으며, 번역에는 tiny 모델 요청 비용이 듭니다.

캐릭터 교체는 인용 밖의 명확한 명령형으로 요청하세요. 부정문, 방법·설명 요청, 과거에 일어난 전환을 말하는 문장, 따옴표·코드·인용문 속 예시는 자동 전환하지 않습니다. 가능 여부를 묻는 모호한 질문도 교체 명령으로 처리하지 않습니다.

실시간 통화의 합성 음성은 말투 주입과 별도인 선택 기능입니다. Cartesia API 키를 연결하고 음성 준비에 동의하면 캐릭터별 비공개 음성을 만들고 현재 Main의 실제 세션 정체성에 맞춰 선택합니다. 공유 계정 기본값이나 표시 이름만으로 캐릭터를 추정하지 않으며, 다른 캐릭터의 음성으로 대신하지 않습니다. 플랜·전송 범위·키 보관·통화 중단 동작은 [캐릭터 통화 설정](./live-voice.md)을 따릅니다.

## 의미 검색의 폴더 탐색 보완

패치된 내장 코어의 `find`는 기존 파일 검색 결과를 보존하면서, 폴더 구조와 파일명 표본을 JEV로 판정해 기존 키워드 후보 범위 밖의 파일도 추가로 살펴봅니다. 기존 후보 밖 파일이 없으면 이 단계는 실행하지 않습니다. 추가 후보와 파일 읽기는 제한돼 있으며, 저장소 전체의 누락 없는 검색을 보장하지는 않습니다.

기존 비밀 파일·숨김 파일·무시 파일 제외와 검색 시간 제한은 그대로 적용합니다. 보완 단계가 실패하거나 시간 제한에 걸려도 이미 완료된 기본 검색 결과는 유지하고, 사용자 취소는 취소로 처리합니다. 결과에는 종전처럼 경로·줄 범위·짧은 미리보기를 반환하며 코드 원문을 일괄 덧붙이지 않습니다.

폴더 판정과 추가 탐색만큼 JEV 호출·검색 시간이 늘 수 있습니다. 전체 코딩 비용이나 성공률 개선으로 일반화하지 않으며, 별도 공식 `omp.exe`에는 이 로컬 패치가 포함되지 않습니다.

## 요청별 MCP 선택 연결

패치된 CUELO 내장 코어와 소스 CLI에서 다음 설정을 켜면, 시작할 때 모든 MCP에 연결하는 대신 요청마다 JEV가 필요한 서버를 고릅니다.

```yaml
mcp:
  selection: per-request
```

기본값 `all`은 기존의 시작 시 연결 동작을 유지합니다. 설정을 바꾼 뒤에는 새 세션에서 확인하세요. 별도 공식 `omp.exe`와 ACP 연결에는 이 로컬 기능이 적용되지 않습니다.

- 자동 연결 후보는 기존 설정과 프로젝트 신뢰 조건을 통과한 서버입니다. 꺼진 서버를 임의로 켜거나 인증·권한을 대신 승인하지 않습니다.
- JEV에는 현재 요청에서 추린 짧은 단서와 최소 프로젝트·서버 설명을 보냅니다. 설정의 환경변수·헤더·인증값이나 도구 스키마 전체는 보내지 않습니다. 알려진 비밀 형식은 가리지만 모든 개인정보를 검출한다는 보장은 아닙니다.
- 필요하지 않은 자동 연결 서버는 다시 실행하지 않고 도구 노출만 줄입니다. 사용자가 직접 연결한 서버는 수동 선택을 존중합니다.
- JEV를 사용할 수 없으면 새 연결을 만들지 않고 실패 상태를 알립니다. 개별 서버의 필요성을 판단하지 못한 경우도 연결하지 않으며, 요청에서 이름을 부른 서버에만 보류 안내를 표시합니다. 이름을 부르지 않은 보류 후보는 나열하지 않습니다. 전체 서버 연결이나 다른 채팅 모델로 조용히 대체하지 않습니다.
- 전역·프로젝트 설치 추천은 공식 출처와 필요한 작업·권한을 함께 안내하고 사용자 승인을 요청합니다. 승인 뒤에는 에이전트가 설치·등록·설정·연결·검증을 수행합니다. 사용자 본인 로그인·인증정보 입력·제공자 안전 확인·동의가 필요한 단계만 사용자에게 넘깁니다. 선택 확장은 스스로 설치를 실행하거나 승인을 대신하지 않습니다. `/mcp` 설치·인증 명령이 필요한 경우 터미널의 대화형 `omp`를 사용합니다.

`tools.xdevDocs: catalog`는 도구 상세 설명을 필요할 때 읽도록 하는 별도 설정입니다. 서버 연결을 고르는 `mcp.selection`과 같은 기능이 아닙니다. 요청별 판정은 JEV 사용량을 추가하며, 전체 작업 비용 절감률은 별도 측정 없이 보장하지 않습니다.

## Git 마감 도구

[`git_finalize`](../Tools/OMP_Global_Config/agent/tools/git-finalizer/)는 Main 전용 도구입니다. 정확한 파일 목록을 대상으로 경로·저장소 경계와 ancestry를 확인하고, 잠금 아래 commit 및 push를 수행합니다. 저장소에 `Tools/CUELO_Setup/files/source-build-helper.js`가 있으면, 커밋할 source 파일이 `source-integrity.json`과 다른데 manifest를 함께 넣지 않은 경우 commit 전에 멈추고 재생성 명령을 알려 줍니다. Maker에게 Git 마감을 허용하는 도구가 아닙니다. 구현과 PowerShell finalizer는 `agent/tools/git-finalizer/`에 있습니다.

저장소에 기억 동기화 스크립트(`Tools/OMP_Global_Config/memory-sync/sync.ts`)가 있으면 `git_finalize`는 커밋 전에 이 PC의 프로젝트 기억을 `memories.jsonl`로 내보내고, 바뀐 경우 그 파일을 같은 커밋에 넣습니다. 다른 PC는 `setup`에서 이 파일을 가져옵니다. 내보내기가 실패해도 요청한 파일의 커밋은 진행하고 결과 문구에 실패 이유를 남깁니다. 기억 파일은 공개 미러에 올라가지 않습니다.

## 스킬 비용 리포트

omp는 세션마다 스킬의 이름과 짧은 설명만 system prompt에 넣고, `SKILL.md` 본문은 `skill://<name>`을 읽을 때마다 컨텍스트에 들어갑니다. [`skill-cost.mjs`](../Tools/OMP_Global_Config/skill-cost/skill-cost.mjs)는 설치된 스킬(`skills`, `managed-skills`)마다 설명·본문·참조 파일의 추정 토큰과, 최근 세션 기록에서 실제로 읽은 횟수·세션 수를 세어 **본문 토큰 × 읽은 횟수** 순으로 보여 줍니다. 한 번도 읽지 않은 스킬은 `[never read]`로 표시하고, 이 PC에 없는 스킬을 읽은 기록도 따로 남깁니다. 읽기 전용이며 네트워크나 모델을 호출하지 않습니다.

```sh
bun Tools/OMP_Global_Config/skill-cost/skill-cost.mjs [--days 30] [--json] [--agent-dir <dir>]
```

토큰은 토크나이저 없이 ASCII 4자당 1, 그 밖의 문자는 1자당 1로 추정하므로 순위 비교용입니다. 실제로 주입되는 짧은 설명의 합계는 `skill-descriptions.db` 기준으로 마지막 줄에 따로 나옵니다.

## 기억 주제 갱신

`learn`에 선택 인자 `topic`을 주면 같은 프로젝트 bank에서 그 주제의 기억 한 행을 새로 쌓지 않고 갱신하며, 결과에 기억 id와 revision을 보여 줍니다. 동시 실행 한도처럼 값이 바뀌는 사실이 여러 버전으로 쌓여 회상 자리(기본 8건)를 서로 차지하지 않게 하려는 것입니다. `topic` 없는 `learn`은 이전과 같습니다.

## omp core 패치

[`Tools/OMP_Global_Config/patches/`](../Tools/OMP_Global_Config/patches/)에는 이 하네스의 동작을 omp core에 맞춰 적용하는 패치와 적용·검증 도구가 있습니다. 소스 `setup`은 빌드 뒤 앱 자체 SDK에 패치를 적용·검사하고, npm의 `postinstall`은 설치된 `cuelo` 패키지 SDK를 준비합니다. **사용자가 별도 설치한 standalone `omp.exe`는 이 패치의 대상이 아닙니다.** `apply-core-patch.mjs`, `validate-harness-policy.mjs`, `core-*-test.ts`가 관련 도구·회귀 검사를 담습니다. 이 공개 저장소의 CI는 앱 빌드·테스트와 함께 `Verify harness`에서 앱이 고정한 core 버전을 새로 설치·패치해 확장·가드·finalizer 테스트와 core 회귀 검사를 돌립니다. 정책·생성 에이전트 일치, source manifest, 내용 검사 증거, eval 분석 테스트는 공개 미러에 없는 설정·증거 파일을 읽으므로 원본 저장소에서만 가볍게 실행합니다.

Codex WebSocket에서 실행 중 끼어든 메시지(live steering)를 서버가 `unsupported_native_inflight_message`로 거절하면, 코어 18.5.1부터는 CUELO의 별도 패치 대신 upstream 복구를 따릅니다. 그 세션에서는 이후 끼어들기를 보내지 않고, 거절된 연결을 닫은 뒤 새 연결에서 현재 요청을 다시 시도합니다. 거절된 끼어들기 입력은 유실되지 않고 되돌려집니다. 실제 서비스에서의 거절 순서는 확인하지 않았습니다(`core-native-inflight-test.ts`는 로컬 WebSocket fixture).

## 정본 자료

역할과 운용 요약은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md), 전역 구현 원칙은 [RULES.md](../Tools/OMP_Global_Config/agent/RULES.md), 상세한 위임·검수 절차는 [rules/subagent.md](../Tools/OMP_Global_Config/agent/rules/subagent.md), task dispatch 계약은 [rules/task-guard.md](../Tools/OMP_Global_Config/agent/rules/task-guard.md), 정책 데이터는 [rules/harness-policy.json](../Tools/OMP_Global_Config/agent/rules/harness-policy.json)에서 확인할 수 있습니다.
