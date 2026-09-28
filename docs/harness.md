# CUELO가 사용하는 공개 OMP 하네스

OMP 하네스는 코딩 에이전트가 요구를 작업으로 나누고, 변경을 검증하고, 증거로 검수하는 작업 규칙·SOP·확장·core 패치의 묶음입니다. 공개 트리는 [`Tools/OMP_Global_Config/agent/`](../Tools/OMP_Global_Config/agent/)와 [`Tools/OMP_Global_Config/patches/`](../Tools/OMP_Global_Config/patches/)에 있습니다. CUELO 앱과 구분되는 omp 작업 환경용 자료입니다.

## 설치와 공개 범위

공개된 `agent/`는 [설치 안내](installation.md)의 `setup`이 사용자의 `~/.omp/agent`에 복사합니다. 이미 있는 파일은 바꾸거나 지우지 않고, 없는 파일만 추가합니다. `config.yml`이 없는 프로필에는 기본 운영 설정(학습·메모리·요청 예산)으로 새 파일을 만들고, 제공자 요청을 스스로 쓰는 자동 기능은 꺼 둡니다. 이 저장소에는 사용자별 모델 설정이 없으므로 `modelRoles`는 사용자가 정합니다. 설치 때 `--model`(core `default`)과 `--role <이름>=<provider/model>`을 직접 넘기면 그 새 파일에 그 값만 적고, 나중에는 CUELO 설정의 Model roles 화면에서 바꿉니다. 기존 `config.yml`은 보존되어 플래그를 다시 줘도 역할·Jev 설정이 채워지지 않습니다. [기존 프로필 보완 절차](installation.md#기존-프로필의-역할과-jev-보완)를 따르세요. 지정하지 않은 하네스 역할은 `maker_route`에서 해당 후보만 사용 불가로 표시됩니다. CUELO 앱 자체는 이 하네스를 설치하지 않아도 기본 대화가 가능합니다.

공개 저장소에는 역할·검수 절차와 런타임 확장, 정책 규칙, core 패치가 포함됩니다. 반면 계정이나 모델 선택 정보를 담는 `config.yml`·`models.yml`, 개인 skills, 작업 기록은 공개하지 않습니다. npm 패키지도 해당 개인 파일과 제공자 API 키, 독립 `omp` CLI를 동봉하지 않습니다. 설치에 필요한 Node/Bun/Git과 기능별 CLI·메모리 모델의 경계는 [설치 안내](installation.md#새-windows-pc에서-먼저-준비할-것)를 따릅니다.

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
사용자 요구로 목적·범위·수용 조건이 바뀌면 변경된 사실로 `maker_route`를 다시 판단합니다.
UI/UX 전문성 경계가 새로 확인되면 비-Opus owner의 미완 변경·증거를 보존해 명시적으로 이관하며, 같은 Opus owner와 완료된 비-UI 작업은 재사용합니다.
Main이 실제 재작업을 지시할 때는 [검수와 수용](../Tools/OMP_Global_Config/agent/rules/subagent.md#검수와-수용)의
`REWORK task_id=... role=maker previous_revision=... next_revision=...`와
`finding_id=... source=...`를 후속 메시지에 넣어야 합니다. 평문 지시만으로 새 attempt가 기록되지는 않습니다.
REWORK 전송 뒤 시작된 재개 실행은 코어가 같은 job id를 다시 써도 그 실행 하나만 다음 attempt(`#a2` 등)로 기록됩니다.
`maker_route`에 표시되는 history는 Jev 분류 **후** Main에게 붙는 건수 advisory이며 분류 입력이나
모델·강도 자동 조정 근거가 아닙니다.

등급(`NORMAL`·`HARD`)과 후보 이름은 구분합니다. 후보는 `NORMAL_SOL`, `NORMAL_OPUS`, `NORMAL_DEEPSEEK`, `HARD_UI_OPUS`, `HARD_CODE_OPUS`, `HARD_CODE_SOL`처럼 실제 모델 계열을 표시합니다. NORMAL도 레이아웃·반응형·접근성·포커스·터치 표적 등 UI/UX 판단이 남으면 Opus를 선택하며, 이를 위해 HARD로 승격하지 않습니다. 비-UI NORMAL은 Sol을 우선하고 실제 사용 불가·소진 시에만 DeepSeek를 추천합니다. 기존 NORMAL의 명시적 Opus 선택도 유지합니다. UI/UX의 Opus unavailable은 다른 모델로 숨겨 대체하지 않습니다. HARD 코드의 기본은 Opus이고, `HARD_CODE_SOL`은 `ROUTING_REASON`을 남길 때만 고르는 대안입니다.

후보별 추론 강도는 정책의 `allowedEfforts`와 실제 모델 지원 단계의 교집합입니다. Sol 후보 둘(`NORMAL_SOL`·`HARD_CODE_SOL`)은 `high`~`xhigh`, Opus 후보 셋과 DeepSeek는 `high`만 사용합니다. 이 정책은 Main의 Auto나 실행 중인 세션의 모델·강도를 소급 변경하지 않습니다.

CUELO의 패치된 내장 코어에서 Main은 Auto를 유지하며 새 사용자 턴의 자동 선택에 `providers.autoThinkingMinEffort: medium`과 `providers.autoThinkingMaxEffort: xhigh`를 적용합니다. 분류 실패 시 이전 값으로 대체하는 경우에도 같은 하한을 사용합니다. 모델이 지원하는 단계와 명시된 세션 상한 안에서만 고르며, 추론 조절이 없는 모델에 값을 만들어 넣지는 않습니다. 실행 중인 요청·Steer·도구 후속 실행·수동 선택의 강도는 이 설정으로 바꾸지 않습니다. 공식 standalone `omp` 실행 파일에는 이 로컬 코어 패치가 포함되지 않으므로 CLI 업데이트만으로 해당 하한이 적용되지는 않습니다.

패치된 내장 코어의 Anthropic 계정 재선택은 사용량·주간 리셋을 확인할 수 있는 건강한 후보끼리 리셋 시각이 빠른 계정을 우선합니다. 리셋 시각이 정확히 같으면 남은 주간 한도가 큰 쪽, 그것도 같으면 기존 순서를 유지합니다. 조회 실패·부분 정보는 추정하지 않으며 기존 한도·예비량·5시간 보호를 유지합니다. 사용 중인 warm pin과 명시적으로 지정한 캐릭터 계정은 이 선호로 전환하지 않습니다. 캐릭터 `교체`와 summon은 모두 그 계정을 세션 exact pin으로 고정하므로, 그 계정이 막히거나 한도에 닿으면 다른 계정으로 조용히 넘어가지 않고 실패로 알립니다.

패치된 내장 코어는 thinking 요약을 생략하는 설정(`omitThinking`)에서도 Claude Opus 5.5 같은 최신 모델이 도구 호출 사이에 쓴 사용자용 진행 문장(progress update)을 본문으로 보여 줍니다. Anthropic은 이 문장을 별도 thinking 블록으로 보내므로, 생략 설정(`display: "omitted"`)을 그대로 쓰면 화면과 세션 기록에서 사라집니다. 코어는 공식 Anthropic API로 가는 이 요청을 `display: "updates"`(beta 헤더 `thinking-display-updates-2026-08-18`)로 보냅니다. 그러면 reasoning은 비어서 오고, 텍스트가 온 진행 문장만 본문 text로 내보냅니다. thinking 서명은 공식 문서대로 불투명 값으로 다루고 해석하지 않으며, 다음 요청에는 서명된 원래 thinking 블록을 그대로 돌려보냅니다. 공식 API가 아닌 주소는 upstream 동작을 따릅니다. 이 동작도 standalone `omp` 실행 파일에는 포함되지 않습니다.

thinking을 보이게 설정하면(`omitThinking: false`, `hideThinkingBlock: false`) Anthropic은 `summarized`로 reasoning 요약과 진행 문장을 둘 다 thinking 블록으로 보내고, 블록 종류로는 둘을 가를 수 없습니다. 영어 reasoning 요약은 CUELO가 한국어 혼잣말로 옮겨 보이고, 한국어로 쓴 진행 문장은 그대로 보입니다. 사용자 답변 여부를 보는 가드(`steering-reply-gate`, `turn-end-guard`)는 [`lib/visible-text.ts`](../Tools/OMP_Global_Config/agent/extensions/lib/visible-text.ts)로 text 블록과 **한국어 thinking 블록**을 본문으로 셉니다. 영어 reasoning 요약만 있고 본문이 없으면 여전히 "답하지 않고 도구를 시작했다"고 안내합니다.

edit 도구가 이전 read·검색에서 온전히 보이지 않은 줄을 기준으로 한 편집을 거부할 때, 패치된 내장 코어는 그 안내를 한국어로 바꿔 모델에 전달합니다. 안내 원문은 native 모듈이 영어로 만들며, 영어 안내 바로 뒤에 Main이 진행 문장을 영어로 이어 쓰는 일이 있었습니다. 알려진 문장 틀만 바꾸고 파일·줄·태그와 파일 내용 줄은 그대로 두며, 틀이 다른 오류는 원문을 유지합니다.

upstream 18.3.3부터 코어는 `task`·`bash`를 가진 SubAgent에 `wait`를 자동으로 붙입니다. CUELO에서 `wait`는 Main 전용이므로 패치된 내장 코어는 이 자동 부여만 막고, agent 정의가 `wait`를 직접 적은 경우에는 그대로 줍니다. SubAgent는 자기 background job 결과를 기다리지 않고 자동 재개로 받습니다.

Maker는 자신이 바꾼 범위의 focused check와 실제 변경 표면 검증을 수행하고 원문 증거 locator를 보고합니다. Main은 확정된 변경분을 중간 검수하고, 마지막에는 각 수용 조건과 그 증거를 대조해 직접 판정합니다. Main은 Maker의 focused check를 같은 조건에서 반복하지 않으며, 필요할 때 공통 환경의 통합·전체 수용 검사를 수행합니다. 검사되지 않은 revision을 통과로 처리하지 않습니다. 자세한 책임 경계는 [검수와 수용](../Tools/OMP_Global_Config/agent/rules/subagent.md) 절과 policy의 `mainLane.workerReview`, `routing.reviewPacket`에 규정돼 있습니다.

교훈은 Mnemopi 기억으로 남습니다. `learn`은 Main 세션에만 있으며 저장한 기억 id를 결과에 돌려줍니다. Maker는 교훈을 직접 저장하지 않고 종료 보고에 교훈 후보(적용 조건·원인·바뀐 행동·성공 근거)를 싣습니다. 저장·기존 교훈 연결·기각은 Main이 정합니다. 패치된 내장 코어에서 Maker 세션은 첫 턴에 자기 작업 brief로 기억을 한 번 회상하고, 주입되는 `<memories>` 줄마다 `(id: …)`가 붙습니다. 이전에는 부모 Main의 첫 턴 회상만 물려받았습니다. Main은 위임 attempt가 실제로 적용한 교훈을 `routing_verdict`의 선택 필드 `appliedLessons`에 기억 id로 남기고, 적용 근거는 `evidenceLocators`로 남깁니다. 이 필드는 기록일 뿐 수용 조건을 바꾸지 않으며, 교훈의 효과를 자동으로 판정하지도 않습니다. Main이 혼자 끝낸 작업은 원장에 attempt가 없으므로, 패치된 코어가 Main·Maker 모든 세션에서 첫 턴에 실제로 전달한 기억 id를 LLM 문맥에 들어가지 않는 세션 기록(`mnemopi-recall`)으로 남깁니다. 이 기록과 세션 중 `recall` 결과의 id로 교훈이 전달된 세션과 그 뒤 같은 실패가 다시 났는지를 셀 수 있습니다.

Main 승인이 작업을 막고 있다면 관계없는 문서 정리나 새 발주보다 필요한 확인과 회신을 먼저 처리합니다. 승인과 완료 보고가 엇갈렸을 때는 이미 끝난 검사를 반복하지 않고 최신 승인과 남은 동작을 대조해 이어갑니다. 실패를 기록하는 데서 끝내지 않고 기존 규칙의 실행 위반과 실제 누락을 구분해 다음 작업에 반영하며, 효과를 관측하기 전에는 개선됐다고 단정하지 않습니다.

## Task Guard와 command guard

[Task Guard 규칙](../Tools/OMP_Global_Config/agent/rules/task-guard.md)은 발주 brief에 `WORK_CLASS`, `PRIMARY_DELIVERABLE`, `OWNED_PATHS` 등 작업 계약을 담도록 정합니다. [`command-guard` 확장](../Tools/OMP_Global_Config/agent/extensions/command-guard/)은 task dispatch에서 maker 역할·요청별 budget·작업 잠금·소유 경로를 검사하고, 자식 작업에서 실제로 바뀐 경로를 advisory로 보고합니다. `bash` 명령에서는 삭제·데이터베이스 변경·배포·Git 마감처럼 보호 대상 동작도 검사합니다. 별도 eval 경로를 이용한 child budget 우회도 막습니다. 이것은 Main의 요구사항 판단이나 최종 검수를 대체하지 않습니다.

## Typed judgment routing (Jev)

정식 신규 발주나 의미 있는 과제 변경 때 `maker_route`는 작업 분류·등급의 중심 난제·기존 owner 중복 등을 한 번에 판단하도록 사용됩니다. 첫 예상 밖 실패나 보고 검수처럼 다른 경계에서는 [`jev-runtime.ts`](../Tools/OMP_Global_Config/agent/extensions/jev-runtime.ts)가 런타임 advisory로 관측 가능한 사실을 제공하고, Main/owner가 그 사실에 담기지 않은 의미와 승인을 판단합니다. 같은 질문을 반복하거나 Jev 결과를 결정론적 권한·검수로 취급하지 않습니다. 정본은 [subagent 규칙](../Tools/OMP_Global_Config/agent/rules/subagent.md)의 “Typed judgment routing”과 policy `routing.typedJudgmentRouting`입니다.

Jev 런타임은 `findScopedSettings(ctx.cwd)`로 실제 실행 프로필/프로젝트 설정을 읽고 SDK의 `resolveJudge`를 호출합니다. 이 확장은 API 키 파일이나 비공개 `models.yml`을 복사해서 활성화되지 않습니다. 설정 기본값 `auto`는 자격 있는 `modelRoles.judge` 체인으로 해석되고, 첫 native 판정 후보 뒤로는 chat/local 후보와 세션 모델을 붙이지 않습니다. CUELO는 `judge`에 OpenRouter의 `typesafe/jev-1.13`(판정 전용 `openrouter-decisions` API)을 두며, 판정 한 번은 1초 안에 끝납니다. 패치된 SDK의 `providers.judgmentProvider: vercel` 모드는 **Vercel AI Gateway**에 저장된 `vercel-ai-gateway` API 키로 `typesafe-ai/jev` 한 경로만 호출하며 실패 시 chat 모델로 대체하지 않습니다. 이 모드는 Vercel 유료 크레딧이 필요합니다(무료 등급은 HTTP 403). Maker 후보 여섯 개는 이 Jev 역할과 별도로 `modelRoles.implSol` 등에서 읽습니다. 가입·키 입력·역할 지정은 [기존 프로필의 역할과 Jev 보완](installation.md#기존-프로필의-역할과-jev-보완)에서 사용자가 직접 마칩니다. 실제 판정의 외부 요청/과금과 미검증 경계는 `setup`·`health` 성공으로 넘기지 않습니다.

`maker_route`는 Jev 판정과 후보 제공자 사용량 조회를 함께 시작하고, 빠른 판정에도 조회를 조기 취소하지 않습니다. 사용량 조회는 기존 2초 제한 안의 결과를 기다리며 실패·timeout은 미측정으로 표시합니다. 사용량은 배정 참고 정보이지 Jev 판단 입력이 아닙니다.

턴 경계에는 JEV를 두 곳 더 씁니다. [`turn-end-guard.ts`](../Tools/OMP_Global_Config/agent/extensions/turn-end-guard.ts)는 작업 중 사용자가 던진 질문에 이후 본문이 실제로 답했는지 입력당 한 번 판정하고, 미답이면 먼저 답하라고 안내합니다. [`external-advice-check.ts`](../Tools/OMP_Global_Config/agent/extensions/external-advice-check.ts)는 다른 모델의 긴 답을 붙여 검증을 요청하면 주장별 확인 목록을 만들어 그 사용자 메시지와 같은 턴에 숨김 메시지로 붙입니다. 별도 턴을 열지 않으므로 긴 첫 메시지가 밀려나지 않습니다. 두 곳 모두 경로·URL·코드·secret을 지운 짧은 발췌만 보내고, 승인이나 도구 차단이 아닙니다. `jev-runtime.ts`는 Windows 셸 경계 실패(PowerShell 변수 소실, 역슬래시 경로 소실, PATH 첫 `bash`인 WSL이 CRLF `.sh`를 읽어 낸 `$'\r'` 구문 오류, Windows `curl.exe`가 `-o /dev/null`에 쓰지 못해 응답을 받고도 낸 exit 23 등)를 따로 분류해 고치는 방법을 알리고, 이 세션이 띄운 실행 중 작업이 쥔 폴더를 지우려는 호출은 그 작업이 끝날 때까지 막습니다. `verify.ps1`은 PATH 첫 `bash`가 WSL 실행기이면 판정에 넣지 않는 경고 한 줄을 출력합니다.

같은 판정을 세 곳에 더 씁니다. [`steering-reply-gate.ts`](../Tools/OMP_Global_Config/agent/extensions/steering-reply-gate.ts)는 작업 중 끼어든 말 뒤 첫 도구 앞 본문이 요청한 결과나 결론을 실제로 줬는지 판정해, 진행 안내만 했으면 먼저 답하라고 안내합니다. 판정은 뒤에서 돌아 도구 실행을 붙잡지 않습니다. `turn-end-guard.ts`는 미완 TODO가 없어도 승인 없이 지금 할 수 있는 일을 "다음에 하겠다"로 남기고 끝낸 턴을 잡아 이어 가라고 안내합니다. 배포·삭제·비용·사용자 선택·외부 대기는 자동으로 이어 가지 않고, 체크포인트 회신을 기다리는 child 세션은 제외합니다. 사용자 정지나 업데이트·재시작 중단으로 abort된 턴도 다시 깨우지 않습니다. 업데이트가 세션을 멈춘 뒤 옛 서버에서 도구가 다시 도는 일을 막기 위해서입니다. [`todo-nudge.ts`](../Tools/OMP_Global_Config/agent/extensions/todo-nudge.ts)는 요청이 들어올 때 여러 항목·단계 요청인지 한 번 판정해, 그럴 때만 TODO 목록 안내를 냅니다. 판정이 없거나 실패하면 도구 세 번 규칙으로 돌아갑니다. `jev-runtime.ts`의 재시도 경계는 judge 없이 로컬에서 테스트·CI 실패를 시간 초과·모듈/환경·source manifest 불일치·assertion으로 나눠, 다시 돌릴 일인지 고칠 일인지 알려 줍니다.

화면 확인에도 JEV를 씁니다. [RULES.md](../Tools/OMP_Global_Config/agent/RULES.md)의 화면 확인 규칙은 Main과 Maker 모두에 적용됩니다. 웹은 `browser`, 네이티브 데스크톱 창은 `computer`, 로직은 테스트로 확인합니다. 조작·대기·확인 여러 단계를 한 `eval` 셀에 묶고, DOM 텍스트·AX 트리는 문자열 비교로 먼저 확인합니다. 문자열로 가를 수 없는 판정만 같은 셀에서 `judge()`(JEV)에 텍스트로 넘기므로, 단계마다 모델 턴을 거치지 않습니다. 스크린샷은 모양을 봐야 할 때만 찍고, `judge()` 결과는 참고 신호일 뿐 최종 수용 근거가 아닙니다. `computer`는 실제 데스크톱을 조작하므로 자기가 띄운 창만 다루고, 되돌릴 수 없는 버튼은 누르지 않습니다. 같은 순서를 여러 문서·기록·로그를 분류할 때(정해진 문구로 거른 뒤 남은 것만 `judge_batch`)와 긴 작업을 감시할 때(종료 문구는 문자열, "멈췄나"만 `judge()`)도 씁니다. 기준선과 비교하는 재측정은 기준선과 같은 방법으로 셉니다.

이미지를 읽을 때는 vision 모델에게 먼저 묻습니다. [`image-question-router.ts`](../Tools/OMP_Global_Config/agent/extensions/image-question-router.ts)는 Main이나 Maker가 이미지 파일을 `?q=` 없이 `read`하려 하면, 이미지가 컨텍스트에 실리기 전에 그 경로의 첫 읽기를 막고 `경로?q=<질문>`으로 다시 읽게 합니다. 글자·값 확인뿐 아니라 레이아웃·간격·색·정렬·잘림 같은 형태 판단도 `modelRoles.vision` 모델이 보고 답만 텍스트로 돌아옵니다. JEV 판정 없이 동작하는 로컬 규칙이며, vision 답으로 부족하면 같은 경로를 한 번 더 읽어 직접 볼 수 있습니다. `browser`·`computer` 스크린샷은 `read`가 아니라서 대상이 아닙니다.

## 캐릭터 음성과 확장

[`character-voice.ts`](../Tools/OMP_Global_Config/agent/extensions/character-voice.ts)는 사용자 대면 말투 block을 현재 세션에 주입하고, 캐릭터 호출 의도를 지정된 경로로 전달합니다. 사용자 지정 말투와 기술적 사실은 보존하고, 반복되는 고정 대사를 피하는 규칙은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md)에 있습니다. [`todo-nudge.ts`](../Tools/OMP_Global_Config/agent/extensions/todo-nudge.ts)는 사용자 요청 하나에서 Main이 TODO 목록 없이 도구를 세 번 부르면 요청당 한 번 목록을 만들라고 안내합니다. 사용자가 화면의 TODO로 진행 상황을 볼 수 있게 하려는 것이며, 도구를 막지 않고 child 세션에는 개입하지 않습니다. 다른 공개 확장과 `command-guard`는 `agent/extensions/`에 있습니다.

## Git 마감 도구

[`git_finalize`](../Tools/OMP_Global_Config/agent/tools/git-finalizer/)는 Main 전용 도구입니다. 정확한 파일 목록을 대상으로 경로·저장소 경계와 ancestry를 확인하고, 잠금 아래 commit 및 push를 수행합니다. 저장소에 `Tools/CUELO_Setup/files/source-build-helper.js`가 있으면, 커밋할 source 파일이 `source-integrity.json`과 다른데 manifest를 함께 넣지 않은 경우 commit 전에 멈추고 재생성 명령을 알려 줍니다. Maker에게 Git 마감을 허용하는 도구가 아닙니다. 구현과 PowerShell finalizer는 `agent/tools/git-finalizer/`에 있습니다.

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

## 정본 자료

역할과 운용 요약은 [AGENTS.md](../Tools/OMP_Global_Config/agent/AGENTS.md), 전역 구현 원칙은 [RULES.md](../Tools/OMP_Global_Config/agent/RULES.md), 상세한 위임·검수 절차는 [rules/subagent.md](../Tools/OMP_Global_Config/agent/rules/subagent.md), task dispatch 계약은 [rules/task-guard.md](../Tools/OMP_Global_Config/agent/rules/task-guard.md), 정책 데이터는 [rules/harness-policy.json](../Tools/OMP_Global_Config/agent/rules/harness-policy.json)에서 확인할 수 있습니다.
