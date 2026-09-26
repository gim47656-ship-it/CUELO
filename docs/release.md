# CUELO 웹 릴리스와 npm 준비

CUELO는 공개 저장소 `gim47656-ship-it/CUELO`의 GitHub Releases로 웹 소스를, npm의 [`cuelo`](https://www.npmjs.com/package/cuelo)로 설치형 웹 패키지를 배포합니다. 데스크톱 설치 파일은 게시하지 않습니다.

## 릴리스 준비

1. `package.json`의 CUELO 버전과 `CHANGELOG.md`의 해당 버전 항목을 함께 갱신합니다. OMP SDK 버전은 별도입니다.
2. 웹 실행·설치 호환 코드의 버전 계약도 맞추고, 타입·lint·테스트·production 빌드 및 실제 웹 동작을 검증합니다.
3. 공개 미러 게시와 공개 저장소의 `CI` 성공을 확인합니다. 릴리스에는 검증한 공개 커밋을 사용합니다.

## 게시

공개 저장소의 Actions에서 **Publish CUELO web release**를 수동 실행합니다. `target_sha`에는 CI가 성공한 현재 공개 `main` 커밋의 전체 SHA를 넣습니다. CLI로 실행할 때도 공개 저장소를 명시합니다.

```bash
gh workflow run release.yml --repo gim47656-ship-it/CUELO --ref main -f target_sha=<public-main-commit-sha>
```

workflow는 지정한 커밋이 현재 공개 main인지, 그 커밋의 CI가 성공했는지 확인합니다. 패키지 버전으로 `v<version>` 태그를 정하고 `CHANGELOG.md`에서 같은 버전의 내용을 가져옵니다. 기존 태그를 다른 커밋으로 옮기거나 기존 릴리스 내용을 덮어쓰지 않습니다.

GitHub의 Source code 다운로드가 릴리스 소스입니다. 빌드된 데스크톱 파일이나 별도 실행 엔진은 포함하지 않습니다.

## npm `cuelo` 준비 경계

GitHub의 소스 릴리스는 npm 설치형 패키지가 아닙니다. npm tarball에는 격리된 production 빌드의 `.next/BUILD_ID`, 서버·정적 산출물, `public/`, `bin/` 및 설치 시 쓰는 공개 호환 패치 원본이 들어가야 합니다. 개발용 `.next/dev`, 캐시, 소스맵과 개인 설정·인증 정보·작업 기록은 넣지 않습니다. production `.next/trace`와 `.next/diagnostics/`는 tarball에 포함될 수 있습니다.

서버는 **Bun 1.4.2 이상**이 필수입니다. `cuelo` 실행기는 Node 22.19.0 이상에서도 시작할 수 있지만 실제 Next 서버는 Bun으로 실행합니다. Bun이 설치되지 않았다면 먼저 설치해야 합니다. 소스 체크아웃은 README와 [설치 안내](installation.md)의 `node install.mjs setup` → `node install.mjs start` 경로를 따릅니다. 앱만 따로 실행할 때는 `bun bin/cuelo.js`를 사용할 수 있습니다. `bun run start`와 `bun run start:lan`도 같은 런처를 브라우저 자동 열기 없이 사용합니다.

npm global 설치에서는 SDK가 `cuelo` 패키지 **자체의** `node_modules/@oh-my-pi/` 아래에 놓여야 합니다. 설치 뒤 `postinstall`은 같은 패키지 내부의 `.next`와 SDK에 기존 native/core/notices 패치를 적용·검증합니다. 사용자 `~/.omp`, 다른 전역 `omp`, hoisted 또는 공유 SDK는 건드리지 않으며 그런 해석 구조라면 설치를 실패시킵니다. `--ignore-scripts`나 npm의 script 정책으로 설치 때 패치가 생략됐다면 설치된 `cuelo` 디렉터리에서 `npm run prepare:runtime`을 명시적으로 실행해야 합니다. 준비되지 않은 npm 패키지의 서버 기동은 패치 검사에서 멈추고 안내합니다. 소스 체크아웃의 `bun install`은 패치를 자동 적용하지 않습니다.

`cuelo [options]`는 앱만 실행합니다. `cuelo setup [--home <dir>] [--model <provider/model>] [--role <name>=<provider/model[:effort]>]`은 사용자가 명시했을 때 공개 하네스를 자신의 프로필에 새 파일만 복사하며, 기존 설정·계정·스킬은 덮어쓰지 않습니다. npm 설치본은 이미 준비된 빌드와 SDK를 검사한 뒤 복사하고 소스 체크아웃은 빌드·패치를 수행합니다. `cuelo start [--home <dir>]`는 앱과 세 sidecar를 전경에서 함께 실행하고 Ctrl+C로 종료합니다. `cuelo health`는 localhost 네 서비스만 조회하며 provider를 호출하지 않습니다.

게시 전에 별도 production 빌드 트리에서 기존 native/core/notices 패치를 적용·검증하고 `npm pack --dry-run --json --ignore-scripts`로 포함 파일을 살핍니다. 실제 `npm pack --ignore-scripts` tarball을 격리된 global prefix에 `npm install --global --prefix <isolated-prefix> --omit=dev --foreground-scripts <tarball>`로 설치해야 합니다. 설치된 `cuelo --help`, `cuelo --no-open -H 127.0.0.1 -p <unused-port>` 및 HTTP 응답을 확인하고, 설치된 OMP SDK의 패치와 모듈 해석도 검증합니다. 앱만 별도 포트로 검사할 때는 `PORT`와 `OMP_USAGE_PORT`, `OMP_BTW_PORT`, `OMP_SUBAGENT_PORT`를 모두 미사용 포트로 지정해야 기존 실행 중인 sidecar를 읽지 않습니다. tarball 생성·설치 검증은 **게시가 아니며** `npm publish`, npm 로그인·권한 변경, 자동 게시 workflow는 별도 승인 전에는 수행하지 않습니다. npm registry에서 이름 조회의 404만으로 등록 가능 여부나 게시 권한을 확인했다고 주장하지 않습니다.

## 소개 페이지 게시

`site/`는 npm 패키지나 GitHub 소스 릴리스와 별도인 정적 소개 페이지입니다. 공개 저장소의 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 설정하고, 공개 `main`에서 **Publish CUELO introduction** (`pages.yml`)을 수동 실행합니다. 준비한 주소는 https://gim47656-ship-it.github.io/CUELO/ (한국어: `/ko/`)입니다.

## 앱의 알림

앱은 공개 CUELO 저장소의 안정 릴리스만 확인합니다. 현재 앱보다 새 버전이 있을 때 사이드바에 변경 내용·릴리스 링크·소스 업데이트 명령을 표시합니다. 알림이 설치나 서버 재시작을 자동 실행하지는 않습니다.
