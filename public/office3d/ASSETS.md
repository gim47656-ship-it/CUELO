# Office 3D assets

오피스 보기의 3D 사무실(`components/office/OfficeScene3D.tsx`)이 쓰는 자산이다. 방(바닥·벽·책상·의자·모니터)은
코드의 three.js 기본 도형이라 파일이 없고, 아래 캐릭터 하나만 내려받아 둔다. 유료 자산은 쓰지 않는다.

| 파일 | 크기 | 내용 | 원 출처 | 라이선스 |
|---|---|---|---|---|
| `RobotExpressive.glb` | 463,988 bytes | 전신 리깅 캐릭터 1개, 애니메이션 14개(Idle·Walking·Running·Sitting·Standing·Wave·Yes·No 등), 텍스처 없음 | three.js 저장소 `examples/models/gltf/RobotExpressive/RobotExpressive.glb`, 마지막 변경 커밋 [`b924f0c`](https://github.com/mrdoob/three.js/blob/b924f0cad4058dc4dde71445c796980c3cd5b5ed/examples/models/gltf/RobotExpressive/RobotExpressive.glb) | CC0 1.0 |

- 원작자: Tomás Laulhé([Quaternius](https://quaternius.com/)). 표정 morph target 추가와 FBX2GLTF 변환은 Don McCurdy.
- 라이선스 원문 위치: 같은 폴더의 three.js [`README.md`](https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/RobotExpressive/README.md)가 "CC0 1.0"이라고 밝히며,
  CC0 1.0 원문은 <https://creativecommons.org/publicdomain/zero/1.0/legalcode> 이다. 사본은 `LICENSE-RobotExpressive.txt`.
- 내려받은 그대로이며 바꾸지 않았다.
