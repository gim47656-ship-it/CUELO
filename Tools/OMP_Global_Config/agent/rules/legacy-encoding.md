---
description: VB.NET·VB6·레거시 설정/데이터 파일을 수정할 때 인코딩 판별과 보존 절차를 확인한다.
globs: ["**/*.vb", "**/*.frm", "**/*.bas", "**/*.cfg", "**/*.csv", "**/*.resx"]
---

# 레거시 소스 인코딩 판별과 보존

`.vb`·`.frm`·`.bas`·`.cfg`·`.csv`·`.resx`는 수정 전에 인코딩을 증거로 판별한다. BOM
(`EF BB BF`는 UTF-8), 파일·프로젝트의 기존 규약, 소비하는 코드의 reader 계약, 엄격한
디코딩·재인코딩 round trip을 함께 본다. BOM이 없다고 곧 CP949는 아니며, BOM 없는 UTF-8과
여러 인코딩에서 해석되는 ASCII-only 파일이 있으므로 디코딩 성공만으로 단정하지 않는다.

판별한 인코딩과 BOM·줄바꿈 상태 그대로 저장하고 변환하지 않는다. UTF-8 전용 편집기로 CP949가
깨지면 Python의 `encoding='cp949'`로 우회한다. 저장 후 한글 줄이 원래 인코딩으로 정상
디코딩되는지 1회 확인하고 byte/decoding 증거를 남긴다.

터미널 한글 깨짐은 `chcp 65001`과 UTF-8 출력 설정으로만 해결하며 시스템 로캘 `Beta: UTF-8`은
켜지 않는다. `Encoding.Default`로 읽는 CFG/CSV는 CP949를 유지한다.

위임할 때는 브리프에 원래 인코딩과 검증 방법을 명시한다. CP949/BOM 편집은 기존 bytes와
decoding을 증명하고 high-risk의 Main 검수 계약을 적용한다.
