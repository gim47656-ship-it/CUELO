---
description: 웹·앱 UI의 시각 디자인, 레이아웃, 반응형, 디자인 시스템, 디자인 리뷰와 디자인 스킬 채택·제외 결정을 다룰 때 읽는다.
---

# 프론트엔드 디자인

## 누가 하는가

- 별도 디자인 역할은 없다. 시각 판단은 그 화면을 소유한 사람이 한다. routine이면 Main이,
  위임한 조각이면 그 `maker`가 디자인 계약을 정하고 구현까지 끝낸다.
- 이미 채택된 디자인 시스템·토큰·레이아웃·컴포넌트 규약을 따르는 국소 유지보수에는 새 디자인
  판단이 없다. routine으로 그대로 끝낸다.
- 새 화면·리디자인, 방향이 정해지지 않은 구조처럼 실제로 새 시각 판단이 필요하고 서로 독립인
  조각이 둘 이상일 때만 `large`로 분류한다. UI 파일을 건드린다는 사실 자체는 위임 근거가 아니다.
- 화면 검증도 그 조각의 owner 몫이다. 결정론적 desktop/mobile, keyboard focus, overflow,
  reduced motion 확인을 직접 실행하고 증거를 남긴다. Main은 계약·증거·중간 검수·최종 수용을
  직접 판정한다.

## 브리프에 반드시 적을 것

명칭, 화면 내 배치, 표시·동작 트리거 조건, 반응형 거동 넷을 적는다. 이 넷이 비어 있으면
시안부터 다시 만드는 재작업이 생긴다.

## 디자인 경로

- 시각 디자인이 포함된 작업에서는 아래 세 기본 디자인 스킬의 지침을 **반드시** 읽고 그 판단을
  디자인 계약에 반영한다. 세 스킬의 이름과 실제 출처는 다음과 같다: `skill://seed-design`(미러
  vendored, upstream `daangn/seed-design`), `skill://frontend-design`(설치 플러그인
  `frontend-design@claude-plugins-official`), `skill://ui-ux-pro-max`(미러 vendored, upstream
  `nextlevelbuilder/ui-ux-pro-max-skill`). 그 밖의 설치 스킬과 출처는 미러
  `agent/skills/registry.json`이 정본이다. 출처를 다른 벤더나 OMP 기본 제공으로 표기하지 않으며,
  없는 설치·업그레이드·마이그레이션 절차를 만들지 않는다.
- 신규 화면·리디자인·기존 화면 분석은 `skill://hallmark`, 제네릭한 AI 스타일 감사와 제거는
  `skill://kill-ai-slop`을 함께 사용한다. 그 밖의 스킬은 설치된 스킬 이름과 설명을 보고 이번
  과제와 현재 프로젝트에 실제로 필요한 최소 집합만 스스로 고른다. 브리프가 스킬 목록을 미리 다
  싣거나 사용자에게 고르라고 묻지 않는다.
- UI·문서 산출물(화면 코드, 강의·보고용 HTML·문서)을 사용자에게 넘기기 전에
  `node <kill-ai-slop 스킬 폴더>/scripts/scan.mjs <대상>`을 실행한다(프로필 기준
  `~/.omp/agent/skills/kill-ai-slop/scripts/scan.mjs`). 적중은 판정이 아니라 단서이므로 해당
  코드를 읽어 확정한다. 확정한 징후는 고치거나, 의도적으로 남긴 이유를 보고에 적는다. 이 절차는
  산출 전 점검(advisory)이며 영구 gate나 CI 검사로 만들지 않는다.
- 스캐너는 시각·코드 징후만 보고 한국어 문구는 보지 않는다. 한국어 사용자용 문구(UI 텍스트,
  강의·문서, 데이터 파일 속 문항·보기·표 문자열)는 넘기기 전에 `skill://humanizer`의 감지
  방식(「분석 결과」만 내고 파일은 고치지 않음)으로 점검한다. 사용자나 과제가 문구 수정을 요청하면
  같은 스킬의 교정 절차를 범위 안 모든 문자열에 끝까지 적용한다. 굵은 글씨 강조는 문단당 최대
  1개로 한다.
- `skill://seed-design`은 위 셋 중 공통 설계 원칙 담당이다. 사용자가 SEED를 언급하지 않아도
  이번 화면에 해당하는 공통 Foundations(정보 위계, 색 역할, 타이포그래피, spacing, 컴포넌트
  상태, 접근성)와 영향받는 컴포넌트의 공통 가이드라인을 공식 인덱스에서 찾아 읽고, 적용 가능한
  판단을 디자인 계약에 반영한다. 매 작업마다 모든 공식 문서를 훑지 않고 이번 작업에 해당하는
  항목만 연다.
- 이때도 정본은 현재 프로젝트의 기존 디자인 시스템이다. 공통 원칙이 기존 규약과 충돌하거나
  이번 스택에 적용되지 않으면 기존 규약을 따르고 그 사실만 짧게 남긴다. 참고한 외부 시스템의
  패키지·팔레트·프레임워크를 채택하거나 설치·마이그레이션·진단 절차로 넘어가지 않는다. 해당
  시스템의 실제 구현·설치·진단은 사용자가 명시했거나 대상 워크스페이스가 이미 그것을 쓰는
  경우로 유지한다.
- 시각적 판단이 없는 동작 로직·백엔드·문구만 바꾸는 작업은 이 참고 대상이 아니다.
- 기존 프로젝트면 프로젝트가 정본으로 삼는 UI·디자인 명세와 토큰을 먼저 찾아 채택된 디자인
  계약의 기준으로 재사용하고, 현재 글꼴·레이아웃·컴포넌트·상태·반응형 경계에서 보존할 것과
  바꿀 것을 구분한다. 영향받은 결정만 그 정본에 갱신한다. 기존 UI 명세 옆에 파일명 관례만으로
  `DESIGN.md`를 만들거나 작은 스타일 변경을 모두 문서화하지 않으며, 새 디자인 시스템을 기존
  시스템 옆에 하나 더 만들지 않는다.
- 제품·사용자·화면의 단일 목적, 정보 위계, macrostructure, 제한된 색상, 글꼴 역할, spacing,
  컴포넌트 상태, 반응형 전환, 접근성, 제품 고유 signature element 하나를 디자인 계약으로 만든다.
- 대안을 작업 적합성, 정보 위계, 제품 고유성, 밀도, 접근성, 구현 가능성, AI-slop 기준으로
  비교하고 채택·기각 이유를 남긴다. 실제 없는 수치·고객·후기·운영 데이터를 만들지 않는다.
- 영구 Playwright 회귀는 반복할 가치가 있는 관찰 가능한 흐름이고 저장소의 기존 테스트 관례가
  있을 때만 추가하며, 화면 변경마다 테스트나 의존성을 새로 만들지 않는다.

## 디자인 스킬 채택·제외 결정

새 디자인 스킬 후보가 오면 먼저 아래 기준에 견주어 보고, 결정이 나면 이 절의 해당 줄만 고친다. 출처·commit·
라이선스의 정본은 `agent/skills/registry.json`과 각 스킬의 `UPSTREAM.json`이고 이 절은 그 값을 복제하지 않는다.

- **채택 원칙.** 통째로 들이지 않고 선별한다. 기준은 셋이다. 기존 스킬에 없거나 한두 줄뿐인 규칙일 것, 실제
  작업(웹 앱, WPF·WinForms 운영·공장 화면, 대시보드·보고서)에 쓰일 것, 외부 엔진·네트워크에 의존하지 않을 것.
  들인 스킬은 고정 commit에서 upstream 본문을 그대로 두고 「OMP local contract」 한 절만 더하며, 위 필수 경로를
  대체하지 않는 선택 참고다. 충돌하면 이 규칙과 프로젝트의 기존 디자인 시스템이 이긴다.
- **목록 비용도 기준이다.** 스킬마다 세션 목록에 설명이 실린다. 2026-10-10 측정으로 선별 12종은 +462토큰,
  통째 45종은 +2,054토큰(당시 주입 목록 943토큰의 두 배 이상)이었다. 설명은 한 문장 150자 이하로 줄인다.
- **채택한 묶음.**
  - 필수 기본 셋(seed-design·frontend-design·ui-ux-pro-max)과 신규·분석 `hallmark`, 슬롭 감사 `kill-ai-slop`,
    한국어 문구 `humanizer`.
  - 제품 UX·업무 도구 12종(dembrandt-skills 선별, 2026-10-10): app-shell, coordinated-data-views,
    data-display-and-selection, domain-expert-configuration, modal-and-overlay-patterns,
    operational-expert-tool-ui, repeated-component-alignment, scroll-areas, status-colors-and-errors,
    surface-separation, ui-context-and-scope, ui-density.
  - 플랫폼별(2026-10-17): material-3(Android Compose·Flutter), refactoring-ui(팔레트·척도가 없을 때),
    WPF·MVVM 4종, 직접 쓴 factory-measurement-hmi(공장 측정기 OK/NG 화면). Android 공식 스킬은
    2026-10-22에 들였고 Android 앱 작업에서만 고른다.
- **제외한 대안과 이유.**
  - dembrandt-skills 45종 통째: 목록 비용이 현 카탈로그의 두 배를 넘고, 33종은 기존과 주제가 겹치며,
    오케스트레이터 `dembrandt`의 트리거가 이 필수 경로와 경쟁하고, 3종은 엔진·Figma·Penpot이 필요하다.
  - upstream과 기존 규칙이 충돌하는 조항(버튼 눌림 scale 금지, 모션 linear 금지, 토스트 지속 시간):
    들이지 않고 기존 ui-ux-pro-max 규칙을 유지한다.
  - impeccable 상시 설치: omp에서는 훅이 동작하지 않아 「산출 전 자동 점검」 이점이 없고 시각 슬롭은
    kill-ai-slop이 덮는다. 대비·작은 글자 같은 렌더링 검사가 필요할 때만 `detect`를 임시로 돌린다(2026-10-19
    시험에서 화면 5건을 찾아 고쳤다). 영구 gate·CI 검사로 만들지 않는다.
  - im-not-ai: 에이전트 정의 9개가 Main/Maker 두 역할 정책과 부딪힐 수 있어 들이지 않았다(분류 체계만 참고).
  - 엔진·외부 도구가 필수인 스킬(extract-design, clone-website, generate-ui-from-brand): 설치가 비목표다.
- **적용 범위.** 시각 판단이 없는 동작·백엔드·문구 작업은 대상이 아니다. 웹 코드 예시는 WPF·WinForms에서
  규칙만 적용한다. 장비 화면은 표시만 바꾸고 판정·공차·교정 계산은 바꾸지 않으며 실제 장비 확인으로 닫는다.
- **출처와 기준일.** 아래는 결정일 기준이고, 고정 commit과 라이선스는 `UPSTREAM.json`에 있다.

  | 결정일 | 출처(upstream) | 결과 |
  |---|---|---|
  | 2026-10-10 | `dembrandt/dembrandt-skills` (MIT, 2026-10-08판) | 45종 비교, 12종 선별 |
  | 2026-10-16 | `DaleSeo/korean-skills` humanizer (MIT) | 들임(감지·교정 두 모드) |
  | 2026-10-16 | `pbakaus/impeccable` 4.6.0 | 조사, 상시 설치 안 함 |
  | 2026-10-17 | `hamen/material-3-skill`, `s0xDk/refactoring-ui-skill`, `github/awesome-copilot`(mvvm-toolkit), `novotnyllc/dotnet-artisan`, `christian289/dotnet-with-claudecode`, `timhok/hmi-design`(고쳐 씀) | 들임 |
  | 2026-10-22 | `android/skills` | 들임(Android 앱 작업 한정) |

## 모델 폴백

- 위임 역할의 모델은 `config.yml`의 `modelRoles`와 `retry.fallbackChains` 항목으로 고정돼
  있어 자동으로 다른 모델로 바뀌지 않는다. 그래도 결과에는 실제 `resolvedModel`과
  `resolvedModelIsFallback`을 기록하고, 폴백 결과를 설정된 모델의 결과라고 보고하지 않는다.
