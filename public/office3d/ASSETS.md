# Office 3D assets

오피스 보기의 3D 사무실(`components/office/OfficeScene3D.tsx`)은 내려받은 모델·텍스처·애니메이션 파일을 쓰지 않는다.
방(바닥·벽·책상·의자·노트북·소파)과 일곱 캐릭터는 모두 코드에서 three.js 기본 도형으로 만든다. 유료 자산은 쓰지 않는다.

- 캐릭터 겉모습과 동작(대기 숨쉬기·걷기·앉아 일하기·손짓·쉬기)은 `components/office/OfficeCharacter.ts` 한 곳에 있다.
  각 캐릭터의 머리색·머리 모양·옷 색은 같은 저장소의 계정 아바타(`public/avatars/`)를 보고 정했다.
- 이전에 쓰던 three.js 예제 로봇(`RobotExpressive.glb`, CC0 1.0)은 더 쓰지 않아 지웠다.
