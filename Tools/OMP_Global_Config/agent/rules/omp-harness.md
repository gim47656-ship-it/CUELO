---
description: OMP 업데이트·업그레이드·버전 교체의 upstream rebase 판단과 전역 설정 미러 동기화·검증 절차를 확인한다.
globs: ["Tools/OMP_Global_Config/**", "Tools/CUELO_Setup/**"]
---

# OMP 전역 설정 하네스
- 저장소는 `gim47656-ship-it/CUELO-private`이며 앱 소스 루트는 저장소 루트, 전역 설정 미러는
  `<repo>/Tools/OMP_Global_Config`다. 관례 경로 `F:/CUELO`는 예시일 뿐이며, 스크립트 경로는
  `$PSScriptRoot`에서 계산한다. 이 규칙의 `Tools/OMP_Global_Config/**` glob은 저장소 루트 기준이다.

- 미러(`Tools/OMP_Global_Config`)가 기준이다. 미러를 프로필로 밀 때 `setup.ps1`, 프로필 변경을 미러로 당길 때 `export.ps1`을 쓴다.
- 집·사무실 모두 같은 적용 계약을 따른다. 대상 PC에서 최신 미러·`HANDOFF.md`와 실제 런타임을 먼저 대조하고, 현재 `USERPROFILE`·설치 경로·버전·저장소 branch/upstream으로 적용 경로를 정한다. 진행 작업을 보존해 해당 branch를 `git pull --ff-only`로 갱신하며 자동 reset·rebase로 우회하지 않는다. 다른 PC의 경로·PID·세션·과거 `READY`는 대상 PC의 증거가 아니다.
- 사무실에서도 pull 뒤 `setup.ps1`로 managed `rules`를 설치해야 최신 규칙이 적용된다. 런타임 설치·업그레이드는 필요하고 승인된 경우에만 기존 `CUELO_Setup` 절차를 전역 setup보다 먼저 수행한다. 런타임이 호환되고 설정만 바뀌면 전역 setup만 수행하며 웹을 매번 빌드·설치하지 않는다. 두 절차는 같은 PC에서 겹쳐 돌리지 않고 런타임 → 전역 setup 순서로 끝낸다. 무거운 설치·빌드와 동시에 돌던 검증의 timeout 실패는 timeout·gate·테스트를 바꿀 근거가 아니라 부하를 걷은 뒤 격리 재실행으로 재판정할 대상이다. 자원을 다투지 않는 가벼운 읽기·조회는 그대로 병행한다. 대상 PC의 `verify.ps1 -StrictRuntime`에서 `READY`를 확인하고, 웹 영향 변경의 완료 조건은 아래와 README의 **인증과 재시작** 절을 따른다.
- Git Bash나 OMP `bash` tool에서 Windows PowerShell을 호출할 때 `-File .\script.ps1`처럼 역슬래시 상대 경로를 넘기지 않는다. Bash가 `\`를 escape로 소비해 `.script.ps1`로 변형한다. 이 경로에서는 `powershell.exe ... -File ./script.ps1`처럼 `/` 상대 경로를 사용하고, PowerShell 셸 안에서 직접 실행할 때만 `.\script.ps1` 표기를 쓴다.
- 승인된 일회성 유지보수 스크립트는 지원되는 설치 절차의 파라미터와 전제를 먼저 읽고 그 위에서 조율만 한다. `Stop-KnownCueloProcesses`의 무조건 활성 클라이언트 guard처럼 절차가 이미 강제하는 전제를 빼먹지 않는다. `-NoRelaunch`를 지정하지 않으면 새 런타임 기동과 readiness 판정은 설치 transaction이 소유하므로 wrapper가 재시작·`READY` 판정을 다시 구현하지 않는다. cutover 이후 실패 시의 package/shim 복원은 `-NoRelaunch` 여부와 무관하게 transaction이 시도하고 기록하지만 성공이 보장되지는 않으므로, wrapper가 자체 rollback을 만들지 않고 `rollback-errors.txt`를 포함한 transaction 증거를 읽어 실제 복원 결과를 판정한다. 절차에 없는 단계만 wrapper에 남기고, 실패는 원본 오류 문구와 그 증거를 그대로 보존해 보고한다.
- `export.ps1`은 미러 파일이나 `config.yml` 키가 사라지는 방향이면 대상을 출력하고 중단한다. 프로필이 미러보다 오래된 경우이므로 `setup.ps1`을 먼저 실행한다. 삭제가 의도된 경우에만 `-Force`를 쓴다.
- `agent/agents/*.md`는 `agent/sop/`에서 생성된 빌드 산출물이다. 직접 고치지 말고 `agent/sop/`를 고친 뒤 `node patches/build-agents.mjs`로 재생성한다. 절차 전체는 `rule://meta-harness`.
- 코드·설정 변경의 검증은 그 변경의 owner가 맡는다. routine이면 Main, 위임한 조각이면 그 Maker가 별도 환경 구축 없이 가능한 집중 검사와 결정론적 HTTP/API·화면 smoke를 실행한다. 공통 격리 환경과 필요한 전체 빌드·통합·수용 검사는 Main이 소유·실행하고, 여러 조각이 한 실행 경로로 합치면 Main이 수렴 뒤 frozen revision에서 1회 실행한다. Main은 지원되는 setup·재시작 절차와 그 내부 설치 검사를 유지하며, 위임한 조각의 집중 검사를 같은 환경에서 반복해 확인하지 않고 증거를 판단한다. 웹 화면 확인은 **headless Chromium**(`app.relay: false`)이 기본이다 — localhost·격리 검증 서버가 전부 여기 해당한다. `app.relay: false`를 빼면 relay가 기본이라 사용자 브라우저에 탭이 열리므로, 빌드가 깨진 중간 상태가 사용자 화면에 뜨지 않게 한다. 사용자 세션이 실제로 필요하거나 완성된 표면을 사용자가 판단해야 할 때만 사용자 브라우저(Whale)의 새 작업 탭을 쓰고, 기존 탭을 대상으로 할 때만 `app.target`을 명시한다.
- 적합한 동일 revision 빌드·서버·결과를 먼저 재사용한다. 2026-09-19의 dev CSS 파싱 실패를 현재 트리의 영구 제한으로 보지 않는다. 2026-09-25에 Next host의 `NODE_ENV=production`·`PORT`·`NEXT_RUNTIME`·private env 유출을 원인으로 확인해 자식 셸에서 제거했고, 2026-09-26에는 `NODE_ENV=development`, host Next env 제거, 격리 HOME/USERPROFILE로 package의 dev script를 실행해 실제 CSS·desktop/mobile 화면을 확인했다. cold compile이 길 수 있으므로 readiness만 보고 재시작하거나 같은 navigation을 반복하지 말고 로그로 컴파일 상태를 구분한다. 실제 환경을 교정해도 dev가 불가하거나 동일 revision production 산출물이 있으면 build/start를 사용한다. production build는 격리 source 또는 `CUELO_DIST_DIR`을 사용하고 HOME·USERPROFILE도 격리해 Windows 보호 junction의 `EPERM`을 피한다. 직접 만든 일회성 부산물만 정리하며 기존 유효 cache/stage는 보존한다. 자동 변경된 `tsconfig.json` include·`next-env.d.ts`를 정본에 섞지 않는다.
- `modelRoles`나 `models.yml`의 provider 정의를 바꾼 뒤에는 `omp`를 재시작한다. 실행 중인 Main·세션의 역할 스냅샷과 ModelRegistry가 디스크 변경만으로 교체된다고 가정하지 않는다. SubAgent spawn 때 일부 설정을 다시 읽더라도 전체 런타임 반영의 증거는 아니다. 새 API 응답과 새 세션에서 실제 역할·설정과 저장된 자격증명 해석을 확인한다.
- omp는 CLI 실행마다 프로필 `config.yml`에 자기 기본값을 덧붙인다. 그래서 `verify.ps1`은 파일 완전일치가 아니라 미러 키·값이 프로필에 반영됐는지만 본다.
- 인증 정보, 세션, 로그, 캐시, 플러그인 데이터는 미러에 넣지 않는다. 새 PC에서는 manifest로 다시 설치한다.
- 완료 증거는 변경이 실제로 도달하는 범위에 맞춘다. 미러 문서·문구만 바꾼 작업은 diff 확인으로 닫는다. 프로필에 실제로 설치돼야 의미가 있는 변경은 `setup.ps1` 적용 결과와 그 범위를 덮는 `verify.ps1` 항목의 실제 출력까지 확인한다. 런타임 동작이 바뀌는 변경은 새 세션·실제 응답을 직접 구동해 확인한다. 이 우선순위는 `implementationOwnership.writerValidation.endConditions`·`reuseScope`와 같은 계약이다 — 가벼운 종료가 필요한 무거운 검사를 대체하지 않고, 무거운 검사도 변경이 닿지 않는 범위로 번지지 않는다. 같은 입력의 통과한 검사·빌드·서버는 재사용하고 재작업이 무효화한 범위만 다시 본다.
- 환경 전체 `READY`는 과제 수용 조건과 별개 상태다. 과제 범위가 통과해도 남은 `PARTIAL`·`FAIL`·`AUTH REQUIRED`는 상태 그대로 보고하고 PASS로 바꿔 적지 않는다. 과제 범위와 관련된 실패는 계속 완료를 막고, 인증 안내는 실제 `Provider Auth` 결과가 요구할 때만 낸다.
- 사용자가 승인한 CUELO 영향 설정·런타임 변경은 미러 적용 → 지원되는 reload 또는 프로세스 재시작 → HTTP 200·브라우저 동작과 실제 역할·설정 확인까지 수행한다. 프로필 동기화나 `verify.ps1` 성공만으로 웹 적용을 완료했다고 보고하지 않는다.
- CUELO 재시작은 작업을 보존한 뒤 `CUELO` 프로세스 계보 밖에서 수행한다. Git Bash·OMP `bash` tool 같은 비대화형 자동화는 `powershell.exe ... -File C:/Users/<user>/.omp/restart-ompweb.ps1`처럼 배치된 PowerShell 정본을 `/` 경로로 직접 실행한다. `restart-ompweb.cmd`는 ASCII·CRLF wrapper로 유지하고 Win+R 또는 `CUELO-Restart` 작업 스케줄러에서만 사용한다. 스케줄러의 접수 성공만으로 재시작을 판정하지 말고 재시작 로그와 실제 HTTP·브라우저 응답을 확인한다. PC 재부팅을 기본 해결책으로 요구하지 않는다.
- 세션 안에서 재시작하거나 `deploy-live.ps1`로 배포할 때는 **항상 `-InitiatorSessionId <현재 session id>`를 넘긴다.** 두 스크립트 모두 이 인자가 없으면 자동 재개 없이 끝나 진행 중인 턴이 끊긴 채 남는다(2026-09-25 배포 `ffcae674…`, `initiatorSession=(none)`). 스크립트가 READY 뒤 그 세션에 `[자동 재개]` prompt를 넣어 작업이 이어진다(스케줄 작업 인계 시에는 `~/.omp/restart-ompweb.resume.json`으로 전달). 결과는 `restart-ompweb.log`의 `RESUME_SENT`/`RESUME_FAILED`로 확인한다. 재시작 전에 사용자에게 잠깐 끊긴다고 먼저 알린다.
- 웹 런타임에 영향 없는 문구 변경만으로 재시작하지 않는다. 무관한 진행 중 작업이나 인증 상태를 자동 변경하지 않는다.

## CUELO 화면 검증 경로

- 검증 시작 전에 현재 `vendor/omp-web/package.json` scripts와 `next.config.ts`, 기존 유효
  stage를 확인한다. SDK의 TypeScript·`bun:` 외부화를 webpack이 담당하는 구성에서는
  Turbopack으로 임의 전환하지 않는다. 그 계약이 바뀌면 현재 소스 근거를 우선한다.
- 격리 서버·빌드의 `NODE_ENV`·`HOME`·`USERPROFILE`을 용도에 맞게 명시하고 같은 source와
  의존성을 사용한다. 포트 충돌이면 실제 listener와 관리 프로세스 계보를 먼저 확인한다.
  readiness나 HTTP 200만으로 화면 동작 검증을 대신하지 않는다.
- dev 화면이 안정적이면 그대로 검증한다. on-demand compile/HMR 전체 navigation이 실제
  확인을 방해하면 반복 navigation 대신 유효한 동일 revision 빌드본을 우선 사용한다. 없으면
  owner가 격리 검증용 production build/start를 수행한다. 검증용 build는 설치·배포 승인이
  아니며 pack·운영 cutover·재시작을 포함하지 않는다.
- 재빌드를 유발할 코드·계약 finding이 남아 있으면 먼저 수정한다. 필요한 독립 코드 검토는
  frozen diff와 caller가 준비되면 가벼운 검사와 병행할 수 있다(high-risk 직렬 경계 유지).
  새 검수 단계나 영구 gate를 추가하지 않고, 같은 입력의 통과한 무거운 검사는 재사용한다.
- 유료 외부 호출 대신 실제 handler·저장소·화면 callback에 일회성 입력을 주입했다면 그
  경계와 미검증 구간을 보고한다. 주입용 route·export·fixture는 정본이나 배포물에 넣지 않는다.

## OMP upstream 업데이트와 downstream rebase

사용자가 OMP 업데이트·업그레이드·최신 버전 적용·버전 교체를 요청하면 **upstream rebase 작업**으로
취급한다. CUELO는 공식 OMP 위에 정책·검증·core patch·CUELO runtime 계약을 올린 downstream
배포판이다. 여기서 rebase는 소스와 계약의 통합을 뜻하며 Git의 자동 rebase·reset을 허용하지 않는다.
목표는 최신판 추종이 아니라 upstream 개선을 가져오면서 기존 해결책과 고유 작업 계약을 보존하고,
upstream이 해결한 workaround를 제거해 patch debt를 줄이는 것이다.

### 판단 정본과 upstream 조사

현재 설치 버전만으로 판단하지 않는다. 다음 미러와 실제 Known-Good runtime을 먼저 대조한다.

- `Tools/OMP_Global_Config/agent/config.yml`, `agent/models.yml`, `agent/rules/`, `agent/sop/`
- `Tools/OMP_Global_Config/patches/apply-core-patch.mjs`, `patches/core-patch-test.ts`
- `Tools/OMP_Global_Config/evals/`, `HANDOFF.md`
- `Tools/CUELO_Setup/files/runtime-integrity.json`과 CUELO이 고정한 core version·vendor dependency·관련 테스트

대상 버전의 공식 release/changelog, 실제 source diff, 관련 GitHub issue/PR, 출시 후 회귀 보고를
확인한다. 특히 현재 patch가 건드리는 upstream 파일, breaking change, 설정 migration,
provider/model 변경을 조사한다. 릴리스 노트나 anchor 일치만으로 의미 검증을 대신하지 않는다.

### patch별 판정

`apply-core-patch.mjs`의 각 **독립 수정 목적**마다 upstream 구현과 비교하고 아래 하나로 판정한다.
여러 anchor가 한 문제를 고치면 목적 단위로 묶되 누락 없이 연결한다.

|판정|근거와 조치|
|---|---|
|`RETIRE`|upstream이 동일 문제를 충분히 해결했다. 로컬 patch를 제거하고 issue/PR/version 근거를 남긴다. 동작 regression test는 가능하면 upstream 보장 검사용으로 유지한다.|
|`KEEP`|새 upstream에서도 문제가 남아 있다. 실제 구현이 해결하지 않았다는 근거와 새 source에서 anchor·의미가 유효하다는 증거를 확보해 유지한다.|
|`ADAPT`|upstream 구조는 바뀌었지만 필요한 의미는 없다. 예전 조각을 억지로 삽입하지 않고 새 구조에 맞는 최소 수정으로 복원한다. 관련 regression을 수정 전 실패·수정 후 통과시킨다.|
|`BLOCK`|의미 충돌이 크거나 안전한 통합 근거가 부족하다. 업데이트를 중단하고 기존 Known-Good를 유지하며 충돌 지점과 필요한 후속 작업을 보고한다.|

CUELO **제품 정책**은 upstream에 비슷한 기능이 생겨도 자동 삭제하지 않는다.

- Main/Maker 2역할, 소유권 기반 분할, Maker end-to-end 구현·자기 검증, Main의 중간 검수·최종 수용
- frozen revision, integration overlap/high-risk serial, evidence contract, no polling/barrier 계약
- Eval analyzer·acceptance fixtures, CUELO 모델 배치·비용·fallback 정책

다음 **core workaround**는 upstream 흡수 여부를 먼저 확인한다: agent/session routing,
result/yield 전달, browser/runtime race, model/auth fallback, event 전달, tool output/evidence 누락,
runtime crash/hang, provider/model 호환성. 제품 정책과 workaround를 같은 기준으로 제거하지 않는다.

### 실행 순서

1. 현재 Known-Good 버전과 runtime contract를 확인한다.
2. 대상 upstream 버전의 실제 source를 확보한다.
3. 현재 local patch 목록을 독립 목적별로 추출한다.
4. 모든 patch를 `RETIRE / KEEP / ADAPT / BLOCK`으로 판정한다.
5. 필요한 patch만 새 upstream에 적용한다.
6. 새 버전에서 불필요해진 patch를 제거한다.
7. core patch regression test를 실행한다.
8. CUELO policy validation을 실행한다.
9. Agent 생성물 일치를 검사한다.
10. FAST Eval을 실행한다.
11. 필요하면 변경 경계의 focused regression을 실행한다.
12. CUELO runtime manifest·coreVersion·vendor dependency·관련 테스트를 일관되게 갱신한다.
13. staging/runtime을 검증한다.
14. 기존 인증·세션·history·사용자 데이터 보존을 확인한다.
15. 실제 smoke test를 수행한다.
16. 모든 필수 증거가 통과한 경우에만 지원되는 설치 절차로 stable runtime에 승격한다.

최종 manifest/runtime revision이 기존 검증 입력을 바꾸면 그 영향 범위만 다시 검증한다.
입력이 그대로인 기존 증거는 재사용한다. 별도 상시 gate·검증 엔진을 새로 만들라는 뜻은 아니다.

### 보존할 동작과 금지 사항

새 버전 검증은 OMP 기동 확인만으로 끝내지 않는다. 현재 patch가 보호하는 아래 동작을 직접
검증하고 변경된 경계는 focused regression으로 확인한다.

- 다중 top-level session 격리, `Main` alias의 자기 session tree 해석, cross-session IRC 차단
- 세션 범위의 `read proc://`·peer roster·`wait`(실행 중 peer liveness), parent steer 이후 subagent terminal yield, 실패·취소 전달, 중복 relay 방지
- browser relay의 사용자 탭 비침범, 승인되지 않은 parent model로의 조용한 fallback 방지
- requested/resolved/fallback model 증거, TODO/event 실시간 전달, Bash 성공·실패 exit status evidence
- Maker orchestration Eval, frozen revision·review evidence 계약

upstream 해결로 patch를 지워도 해당 동작 regression은 가능하면 남긴다. 다음은 금지한다.

- 새 버전이라는 이유만으로 설치하거나 기존 patch 전체를 검토 없이 그대로 재적용
- anchor 일치만 확인하고 의미 검증 생략, upstream이 해결한 patch 중복 적용
- core version만 바꾸고 CUELO contract/test/manifest를 방치
- 실패 patch를 주석 처리해 성공으로 보고하거나 테스트 실패를 새 버전 탓으로 추측해 무시
- 인증·세션·history·사용자 데이터 초기화로 우회하거나 검증 없이 Known-Good runtime 교체

### 업데이트 결론과 보고

|결론|조건|
|---|---|
|`UPDATE`|실사용 이점이 있고 local patch와의 rebase가 검증됐다.|
|`UPDATE_WITH_REBASE`|업데이트할 가치가 있으며 일부 patch의 RETIRE/ADAPT가 필요하다. 수정·검증을 마친 뒤 적용한다.|
|`HOLD`|Known-Good 대비 이득이 작거나 새 회귀가 있거나 아직 검증되지 않았다.|
|`BLOCKED`|현재 patch/runtime contract와 안전하게 통합할 수 없다.|

보고에는 기존→대상 버전, 업데이트 결론, upstream 주요 이점, patch별 RETIRE/KEEP/ADAPT/BLOCK과
근거, runtime contract 변경 여부, 실제 검증 명령·결과, 잔여 위험, 최종 Known-Good 버전을 남긴다.
최신 버전 출시 자체는 `UPDATE` 근거가 아니다. 이 판단은 `rule://verdict`의 작업 완료 판정과 구분한다.
