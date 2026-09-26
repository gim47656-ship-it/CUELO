# CUELO 웹 릴리스

CUELO는 공개 저장소 `gim47656-ship-it/CUELO`의 GitHub Releases로 웹 소스를 배포합니다. npm의 `omp-web`이나 데스크톱 설치 파일을 게시하지 않습니다.

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

## 앱의 알림

앱은 공개 CUELO 저장소의 안정 릴리스만 확인합니다. 현재 앱보다 새 버전이 있을 때 사이드바에 변경 내용·릴리스 링크·소스 업데이트 명령을 표시합니다. 알림이 설치나 서버 재시작을 자동 실행하지는 않습니다.
