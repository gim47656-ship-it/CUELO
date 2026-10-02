# OMP Main을 유지하는 Claude Code Maker 연결 검토안

- 상태: **검토 제안**. 문서 공개만 승인된 상태이며, 구현 착수·엔진 전환·설치·인증 변경을 승인하거나 지시하지 않습니다.
- 확인일: 2026-10-02
- 정적 검토 기준: [CUELO main 99936413](https://github.com/gim47656-ship-it/CUELO/tree/99936413a11d8e13521516b7104e45aa8668bb63), 앱 0.7.2 / 내장 OMP 18.4.10
- 검토 범위: 공개 소스와 공식 문서. 실제 Claude 실행, 모델 호출, 회귀 테스트, 성능·비용 측정은 수행하지 않았습니다.

## 제안과 전제

Main은 현재 OMP에 두고, 명시적으로 선택한 Maker의 구현 실행만 Claude Code 런타임에 맡기는 방식을 검토합니다. 발주·경로 소유권·승인·검수·수용·학습 저장·공유 문서 지도 관리는 CUELO/OMP Main이 계속 소유합니다.

가장 중요한 전제는 기존 규칙, 자동학습과 기억 재사용, 문서 지도와 기록 계약을 보존하는 것입니다. 외부 프로세스가 실행되는 것만으로 이 조건을 충족했다고 판단하지 않습니다. 현재 공개본에는 연결 지점이 있지만 완성된 Claude 어댑터와 동등성 검증은 확인되지 않았습니다.

이 문서는 기존 [하네스 안내](harness.md)와 정책의 대체 정본이 아닙니다. 실제 구현 전 현재 코어·정책을 다시 읽고 아래 미검증 항목을 확인해야 합니다.

## 공개 소스에서 확인한 연결 지점

[CUELO core 패치의 외부 Maker bridge](https://github.com/gim47656-ship-it/CUELO/blob/99936413a11d8e13521516b7104e45aa8668bb63/Tools/OMP_Global_Config/patches/apply-core-patch.mjs#L2066-L2432)는 다음 동작을 정의합니다.

- `resolveExternalMakerEngine`은 `agent.name === "maker"`인 경우만 검사합니다. `CUELO_MAKER_ENGINES`에 `claude`가 있고 절대 경로 `CUELO_RUNTIME_DIR`가 있으며, 최종 해석된 모델의 provider가 `anthropic`이면 Claude 경로를 선택합니다. 설정이 없으면 기존 OMP 경로를 유지합니다.
- `loadExternalMakerRuntime`은 런타임 디렉터리의 `index.ts`에서 `getRuntime("claude")`를 가져옵니다. 공개 트리에서 이 어댑터 구현과 대응 설정 UI는 확인하지 못했습니다. 개인 설치나 비공개 원본에 별도 구현이 있는지는 이 조사로 판단할 수 없습니다.
- `ExternalMakerRuntime.createSession`은 `cwd`, 모델, 추론 강도를 받고, 세션은 `prompt`, `abort`, `onEvent`, `dispose`를 제공합니다.
- `acceptExternalEvent`는 본문·도구·사용량·종료 이벤트를 기존 task 진행/결과 경로로 변환합니다. 취소를 전달하고 성공 종료가 없으면 오류를 반환하며 세션을 정리하는 코드가 있습니다. 실제 프로세스 종료와 이벤트 정확성은 어댑터 검증이 필요합니다.
- 외부 경로는 OMP `createAgentSession` 전에 분기합니다. Maker 본문 지침, 명시적 context, plan, worktree와 task는 전달하지만, 네이티브 경로가 받는 `contextFiles`, `skills`, `rules`, extension, 도구 제한, MCP와 기억 상태를 같은 방식으로 초기화하지 않습니다.
- 외부 결과는 일반 텍스트를 받아 yield에 대응시키며, 기존 `outputSchema` 검증을 명시적으로 끕니다. 성공 종료와 Main의 수용 판정은 별도로 남겨야 합니다.

따라서 모델 역할을 Anthropic으로 고르는 것과 Claude Code 엔진으로 실행하는 것은 별개입니다. 환경변수만 설정하는 방식도 아래 보존 조건을 보장하지 않습니다. 이 절은 설치나 활성화 절차가 아닙니다.

## 반드시 보존할 계약

### 발주와 소유권

기존 `maker_route` → prepared task → task guard → 실행 → Main 검수 흐름을 유지합니다. [command-guard](../Tools/OMP_Global_Config/agent/extensions/command-guard/index.ts)의 발주 전 검사는 부모에서 실행되지만, 자식 도구 실행을 막는 OMP extension이 Claude에 자동 설치되지는 않습니다.

어댑터 계약에는 실제 session/assignment/attempt 식별자, 목적, 수용 조건, 허용 경로, 금지 행동, 승인 범위, 검증 요구를 명시적으로 전달해야 합니다. 동일 파일의 중복 owner를 만들지 않고 재작업에서도 기존 owner와 revision 연결을 보존합니다.

worktree를 `cwd`로 주는 것은 파일 접근 격리가 아닙니다. Write/Edit뿐 아니라 Bash·MCP 등 파일을 바꿀 수 있는 모든 경로에서 범위를 검사하고, 실제 diff도 대조해야 합니다. 프롬프트에 적은 `OWNED_PATHS`만으로 강제 차단을 주장하지 않습니다.

### 규칙과 실행 능력

[Maker SOP](../Tools/OMP_Global_Config/agent/sop/maker.md), [공통 규칙](../Tools/OMP_Global_Config/agent/RULES.md), 요청에 필요한 프로젝트 규칙·스킬·기억을 명시적으로 전달하고 로딩 여부를 확인합니다. OMP 도구 이름이나 `rule://`, `skill://` 경로를 Claude가 그대로 해석할 수 있다고 가정하지 않습니다.

OMP 전용 도구·승인·편집 전 체크포인트는 대응 구현이나 Main에게 돌려주는 절차가 필요합니다. 사용할 수 없는 검증 도구는 미지원으로 보고하며, 수행한 것처럼 보고하지 않습니다. 임의 권한 우회나 Claude 측 별도 위임으로 CUELO 소유권을 벗어나지 않도록 해야 합니다.

### 자동학습과 기억

기존 [Maker 학습 계약](../Tools/OMP_Global_Config/agent/agents/maker.md)은 Maker가 확인된 실패→수정→성공 근거로 lesson candidate를 보고하고, Main이 `learn` 저장·기존 기억 연결·기각을 결정하도록 합니다. Maker에게 학습 저장권을 새로 부여하지 않습니다.

Main의 자동학습 흐름을 유지하되, 외부 Maker의 도구 실패·수정·성공과 적용 기억 id가 Main에 전달되는지 별도로 검증해야 합니다. 네이티브 자식 기억 초기화를 건너뛰므로, 시작 시 필요한 회상 결과를 전달하고 다음 작업에서 실제로 재사용되는지 확인합니다. Claude 자체의 기억 기능을 CUELO 기억 저장소와 동등하다고 취급하거나 별도 정책 정본을 만들지 않습니다.

### 문서 지도와 기록

[docs-handoff 규칙](../Tools/OMP_Global_Config/agent/rules/docs-handoff.md)을 그대로 따릅니다.

- Maker는 자기 작업의 기록과 evidence를 작성하고 revision·검증·남은 경계·교훈 후보를 보고합니다.
- 프로젝트의 기존 `HANDOFF.md` 현재 상태는 Main이 갱신합니다.
- 공유 `doc/README.md` 지도는 Main 또는 명시된 한 owner가 갱신합니다.
- 기존 문서 루트·링크·검색 헤더·정본을 보존합니다. Claude 전용 중복 지도나 기억 층을 만들지 않습니다.

공개 CUELO 기준 트리에는 `HANDOFF.md`와 `doc/README.md`가 없습니다. 이 검토안을 연결하려고 공개 루트에 현재 상태 문서를 새로 만들거나 비공개 문서를 추정해 복제하지 않습니다.

### 취소와 결과 수용

취소 신호 전달과 실제 writer 종료를 구분합니다. 종료가 확인되기 전 owner/worktree를 해제하거나 다음 writer를 발주하지 않습니다. 시작 중 취소, 늦은 종료 이벤트, 프로세스 오류, 정리 실패에서도 같은 조건을 지켜야 합니다.

기존 [routing verdict](../Tools/OMP_Global_Config/agent/extensions/jev-runtime.ts)는 실행과 분리된 Main의 advisory 기록입니다. 이를 자동 품질 gate로 설명하지 않습니다. 외부 결과에는 실제 attempt, 종료 상태, 변경 revision, 수용 조건별 검증, evidence locator와 미검증 항목이 필요합니다. 어댑터 또는 수용 전 처리에서 이 계약을 검증하고, 누락·오류·취소 결과를 성공으로 보정하지 않습니다. 오래된 결과나 다른 attempt 결과를 현재 작업에 수용하지 않습니다.

진행 이벤트도 실제 관측만 기록해야 합니다. 현재 bridge의 사용량 변환은 비용 0을 넣으므로 비용 계측 완료로 보지 않습니다. 실제 비용과 미측정 값을 구분하는 정책이 필요합니다. 원문·비밀값을 공개 로그나 기록에 옮기지 않습니다.

## 최소 통합 방향

새 Main 엔진을 만들기보다 기존 `getRuntime("claude")` 지점에 어댑터를 연결하는 방식을 우선 검토합니다. Claude Agent SDK는 지침 주입과 도구 전후 hook을 붙이기 편한 후보이며, CLI의 구조화 스트림 방식도 비교할 수 있습니다. 선택은 구현 승인 뒤 작은 검증으로 결정합니다.

기존 인터페이스의 cwd/model/thinking만으로 충분하다고 보지 않고, 발주 식별자·정책·필요 context·회상·도구 권한·결과 계약을 명시적으로 잇습니다. 자격증명·과금·모델 대응·추론 단계는 별도 확인하며, OMP 인증 상태가 Claude Code 인증으로 자동 이어진다고 가정하지 않습니다. 영속 세션 재개와 `write agent://` 후속 지시는 별도 적합성 항목입니다.

## 단계별 검토와 회귀 통과 조건

현재 상태는 문서 검토 단계입니다. 아래 단계는 향후 별도 승인과 검증을 전제로 합니다.

1. **기본 OFF 유지**: 제품 코드·설정·역할을 변경하지 않고, 보존할 계약과 미지원 동작을 합의합니다.
2. **비용 없는 fixture 검증**: 가짜 런타임으로 이벤트·취소·오류·결과 연결을 검증합니다. 이는 실제 Claude 호환성 검증을 대신하지 않습니다.
3. **명시적 opt-in 한 Maker**: 승인된 한 작업과 격리 공간에서만 시범 실행합니다. 현재 환경변수는 provider별 Maker 선택이므로 한 작업 제한을 자체 보장하지 않습니다. per-task opt-in 또는 별도로 격리된 시범 실행 경계를 먼저 마련해야 합니다.
4. **동등성 검수 후 확대 판단**: 다음 조건의 증거를 Main이 확인한 뒤 확대 여부를 결정합니다. 속도·비용 우월성을 사전에 주장하지 않습니다.

필수 회귀 항목:

- OFF일 때 기존 OMP 실행, Main, 라우팅과 모델 정책이 변하지 않는가
- 필요한 규칙·스킬·기억을 받고 적용했는가; 미지원 OMP 도구를 허위 실행으로 보고하지 않는가
- 허용 경로 밖 Write/Edit/Bash/MCP 변경과 중복 owner가 차단되는가
- 취소·시작 중 취소·프로세스 실패·정리 실패에서 writer 종료 전 소유권이 풀리지 않는가
- 도구 실패와 종료 상태가 정확하며, 누락·중복·늦은 이벤트가 다른 attempt에 섞이지 않는가
- 보고서의 revision·수용 조건별 증거가 확인되고, 잘못된 형식·미검증 결과를 수용하지 않는가
- 확인된 실패→수정 근거로 Main이 학습을 결정하고, 다음 작업의 회상과 적용까지 연결되는가
- Maker 자기 기록과 Main의 HANDOFF·공유 지도 갱신이 기존 소유권·링크 계약을 지키는가
- 재작업·후속 지시·재시작 후 재개가 지원되는가; 미지원이면 명확히 보류되는가
- 실제 Claude 인증·모델·추론·사용량·비용·스트림 의미가 관측되고 미측정과 구분되는가

이 항목들은 **아직 실행하지 않은 통과 조건**입니다.

## 롤백과 중단 조건

향후 시범에서 규칙 누락, 범위 밖 변경, 취소 후 writer 잔존, 결과 오귀속, 학습·지도 손상이 발견되면 신규 외부 발주를 중단합니다. 실행 중 child의 실제 종료를 확인하고 변경·증거·owner 상태를 보존한 뒤, 이후 작업을 기존 OMP 경로로 돌립니다. 환경변수 제거만으로 이미 실행 중인 child가 안전하게 멈췄다고 판단하지 않습니다.

기존 변경을 자동 삭제하거나 초기화하지 않습니다. Main이 diff와 증거를 확인해 유지·재작업·폐기 여부를 결정합니다. 재활성화는 원인 수정과 해당 회귀 검증 이후 별도 판단합니다.

## 공식 기능 참고

아래 문서는 연결 구현 가능성을 확인하는 자료입니다. CUELO에 이미 구현·검증됐다는 근거는 아닙니다.

- [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks): 도구 실행 전 차단과 실행 관측
- [SDK system prompt와 설정 소스](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts): 지침 전달과 설정 로딩 경계
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference): print, stream-json, 모델·세션·출력 옵션

공식 기능과 기본값은 바뀔 수 있으므로 구현 시 선택한 SDK/CLI 버전을 고정하고 다시 확인해야 합니다.
