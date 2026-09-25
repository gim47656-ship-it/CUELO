# 프로젝트 신뢰

CUELO는 브라우저 세션에서 omp를 실행합니다. 프로젝트를 열 때 프로젝트 안의 확장이나 MCP 설정이 실행되는 것을 막기 위해, 실행 가능한 프로젝트 자원이 있는 저장소는 별도 신뢰 확인을 거칩니다.

## 신뢰 확인이 적용되는 자원

프로젝트 단위로 신뢰를 확인하는 대상은 다음과 같습니다.

| 종류 | 탐색 대상 |
| --- | --- |
| Extensions | `.omp/extensions`, `.pi/extensions`, `.claude/extensions`, `.agents/extensions` |
| Hooks | 위 설정 루트들의 `hooks/` 디렉터리 |
| Custom tools | 위 설정 루트들의 `tools/` 디렉터리 |
| MCP 설정 | `.mcp.json`, `.omp/.mcp.json`, `.omp/mcp.json`, `.claude/.mcp.json`, `.claude/mcp.json`, `.cursor/mcp.json` |

Skills, rules, prompts, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`는 이 신뢰 확인으로 실행을 차단하는 대상이 아닙니다. 일부는 prompt 입력으로 처리되므로, 이 문서는 prompt injection을 막는다고 보장하지 않습니다. 신뢰할 수 없는 프로젝트의 지시문도 검토 없이 따라서는 안 됩니다.

해당 실행 자원이 없는 프로젝트는 별도 신뢰 단계가 필요하지 않습니다.

## 신뢰하지 않은 프로젝트의 세션

신뢰하지 않은 프로젝트에서 프로젝트 로컬 확장과 custom tool은 세션 초기화에 전달되지 않으며 프로젝트 MCP 실행도 비활성화됩니다. 사용자 수준(`~/.omp/agent`)의 확장과 도구는 계속 사용할 수 있습니다. 프로젝트별 리소스를 사용할 필요가 있을 때만 CUELO의 신뢰 요청을 승인하세요.

## 저장 위치와 범위

결정은 `~/.omp/agent/omp-web-trusted-projects.json`에 프로젝트의 real path를 기준으로 저장됩니다. 신뢰 승인은 CUELO의 브라우저 상태에만 적용되며, 터미널에서 `omp` CLI가 프로젝트를 읽는 동작은 바꾸지 않습니다. 파일에서 프로젝트 항목을 지우면 해당 승인이 취소되고, 파일을 지우면 저장된 승인이 모두 없어집니다.

근거 코드: `lib/project-trust.ts`, `lib/session-system-prompt.ts`, `app/api/`의 세션 초기화 경로.
