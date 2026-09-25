---
description: 에이전트 정의(agent/agents)를 SOP 조각에서 생성·검증·동기화할 때 절차를 확인한다.
globs: ["Tools/OMP_Global_Config/**"]
---

# 에이전트 정의 빌드 하네스
- 저장소 루트가 CUELO 앱 소스 루트이며, 이 미러는
  `<repo>/Tools/OMP_Global_Config`에 있다. `Tools/OMP_Global_Config/**` glob은 저장소 루트
  기준으로 유지하므로 `F:/CUELO`에서 현재 미러 경로와 일치한다.

- `agent/agents/maker.md`는 `agent/sop/` 조각에서 `patches/build-agents.mjs`가 생성한다.
- 위임 정의는 `maker` 하나이며 `_writer.md`와 `_common.md`를 합친다.
- `thinking-level`은 SOP에 쓰지 않는다. 생성 기본값은 `medium`이고 모델은 `model:"@impl"`이다.
  발주 전 Main이 고른 `tasks[].model`의 concrete effort suffix가 생성 기본값보다 우선한다.
  모델·fallback은 `modelRoles`, 모델 분류·추론은 `routing.modelSelection`·`routing.effortSelection`이 정한다.
- frontmatter 도구는 `read, bash, edit, write, grep, glob, lsp, eval,
  generate_image, ast_grep, ast_edit, debug, todo, web_search, checkpoint`다. core 18.3.0에는 `hub`가
  없고(목록에 남겨도 조용히 버려진다) `wait`는 top-level 전용이라 Maker(depth 1)에 넣어도 생기지 않으므로 둘 다 적지 않는다.
  restricted session에서 `checkpoint`를 명시하면 core `createTools`가 `rewind`를 안전 쌍으로
  자동 추가하므로 frontmatter에는 `rewind`를 중복하지 않지만 실제 runtime에는 둘 다 노출된다.
- `ast_grep`·`ast_edit`은 구조 검색·편집, `debug`는 runtime state·breakpoint, `web_search`는 최신
  외부 자료 발견 뒤 `read`로 1차 출처 확인, `todo`는 3단계 이상 작업에만 쓴다. `eval`은 실제 화면
  관측, 살아 있어야 하는 process는 `bash`의 `name` 서비스(이름은 세션마다 고유), peer 메시지는 `write agent://<id>`,
  job·서비스 조회·중지는 `read proc://`·`write proc://<id>/kill`이다. `generate_image`는 이미지 자산용이고
  `config.yml`의 `generate_image.enabled: true`와 에이전트 도구 목록 gate
  (`restrictToolNames`/`options.toolNames`)를 모두 통과해야 실제로 붙는다. 새 도구도 기존 권한·
  프로젝트 경계·외부 side-effect 승인 규칙을 낮추지 않으며 검수는 Main이 소유한다.
- 재생성은 `node patches/build-agents.mjs`, 검사는 `node patches/build-agents.mjs --check`다.
  어긋나면 exit 1이다.
- 생성 파일 머리에는 `source-hash` 스탬프가 있다. 손편집과 조각 변경 후 미재생성이 서로 다른
  상태로 잡히고, 손편집은 병합되지 않는다.
- 바꾸는 쪽 PC: `agent/sop/` 수정 → `node patches/build-agents.mjs` → `.\setup.ps1` → 모든 항목
  PASS와 `READY` 확인 → 바뀐 경로만 명시해 커밋·푸시. 받는 쪽 PC: `git pull` → `.\setup.ps1` →
  `READY` 확인.
- `agent/agents/*.md`는 직접 고치지 않는다. 적발 지점은 `verify.ps1`의 `Generated Agents` 항목과
  `export.ps1`의 `HAND-EDITED` 중단이고, 해결은 항상 `agent/sop/`를 고친 뒤 재생성하는 것이다.
- `export.ps1 -Force`가 유일한 우회다. "프로필 쪽 정의를 일부러 가져온다"는 뜻이므로 가져온 뒤에는
  조각에 반영하고 미러를 다시 빌드한다.
- `agent/sop/`는 미러 전용이다. `$ManagedDirectories`에 없으므로 `setup.ps1`이 프로필로 밀지 않고
  `export.ps1`은 스테이지로 보존만 한다.
- 어디를 고칠지: 공통 문구 → `_common.md`, Maker 계약 → `_writer.md`,
  역할 정체성 → `maker.md`, 모델·fallback → `config.yml`의 `modelRoles`,
  생성 기본 추론 → `patches/build-agents.mjs`. 재생성 뒤
  `node patches/build-agents.mjs --check`와 `node patches/validate-harness-policy.mjs --json`을
  그 변경의 owner가 실행한다. 지원 setup·재시작은 Main이 한다.
