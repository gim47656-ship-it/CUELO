# Extension retirement ledger

확장 구성요소의 도입 근거와 검토 일정을 관리하는 원장입니다. 원장 폴더는 `Tools/OMP_Global_Config/agent/extension-ledger/`입니다.

## 실행

원장 폴더 안에서 실행합니다.

```sh
node check.mjs [--strict] [--json]
node --test check.test.mjs
```

`ledger.json`은 `doc/history` 참조를 포함하므로 비공개입니다. 공개 범위에는 README, 검사기, 테스트만 포함됩니다. 테스트는 자체 픽스처를 생성하므로 비공개 원장 없이 공개 환경에서 실행할 수 있습니다.

## 인벤토리 범위

경로는 현재 작업 디렉터리가 아니라 **스크립트 위치**를 기준으로 해석합니다.

- `extensions/`: 최상위 `.ts` 파일과 디렉터리. `lib/`, `tests/`는 제외
- `tools/`: 최상위 디렉터리와 `.ts` 파일
- `cuelo-plugins/`: 바로 아래의 플러그인 디렉터리. `README.md`는 제외

저장소 소스만 대상으로 하며 설치된 도구, 프로필 도구, 런타임 도구는 포함하지 않습니다.

## 원장 필드

`ledger.json`은 JSON 배열입니다.

| 필드 | 설명 |
| --- | --- |
| `id` | agent 루트 기준 상대 경로 |
| `kind` | `guard`, `hint`, `tool`, `infra` 중 하나 |
| `strengths` | 공개 [장점과 장치 판단 기준](../../../../docs/harness.md#장점과-장치-판단-기준)의 S1–S4 배열 |
| `purpose` | 소스 위치를 포함한 한 줄 목적 |
| `introduced` | Git에서 파일이 처음 추가된 기록. 폴더는 Git이 디렉터리를 추적하지 않으므로 추적된 자식 중 가장 이른 추가 기록 사용 |
| `decision` | 확인된 도입 결정 기록 또는 `미상` |
| `effectMetric` | 측정 출처 또는 `미정` |
| `reviewBy` | 기본적으로 `introduced`로부터 UTC 달력 기준 90일 후 또는 기존 HANDOFF 관찰 날짜 |
| `retireWhen` | 폐기 기준 또는 인프라 의존성 |
| `status` | 초기값은 `active`, `retired`도 지원 |

## 검사 결과와 종료 코드

텍스트 출력은 요약과 발견 항목을 표시합니다. `--json` 출력에는 UTC 기준 오늘 날짜, 개수, 발견 항목 배열이 포함됩니다.

| 분류 | 의미 |
| --- | --- |
| `unledgered` | 실제 경로에 대응하는 원장 항목이 없음 |
| `stale` | 상태와 관계없이 원장의 경로가 현재 인벤토리에 없음 |
| `due` | `active` 항목의 `reviewBy`가 오늘 이전이거나 오늘임 |
| `noStrength` | `active`이고 `infra`가 아닌 항목의 `strengths`가 비어 있음 |
| `noMetric` | 상태와 관계없이 `effectMetric`이 정확히 `미정`임 |

유효한 입력의 기본 종료 코드는 `0`입니다. `--strict`에서는 `unledgered` 또는 `stale`이 있을 때만 `1`로 끝납니다. 옵션, 스키마나 날짜가 잘못됐거나 원장 또는 인벤토리를 읽지 못하면 진단을 출력하고 `2`로 끝납니다.

검사기는 **읽기 전용**이며 자동으로 폐기하지 않습니다. 근거를 확인한 뒤 항목과 날짜를 수동으로 유지하세요. 항목이 누락되었거나 검토 기한이 되었다는 사실만으로 확장 구성요소를 제거해야 한다는 근거가 되지는 않습니다.

규칙 텍스트에 담긴 날짜가 있는 사실을 중점적으로 관리하는 원장은 [rule-ledger](../rule-ledger/README.md)를 참고하세요.
