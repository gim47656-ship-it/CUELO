# Office 3D assets

오피스 보기의 3D 사무실(`components/office/OfficeScene3D.tsx`)은 방의 가구·벽·소품을 `office-kit.glb` 한 장에서
가져온다. 그 안의 모델은 모두 CC0 1.0(퍼블릭 도메인, https://creativecommons.org/publicdomain/zero/1.0/)이고
유료 자산은 쓰지 않는다. 키트를 받지 못하면 같은 방을 코드 도형으로 그린다.

- 일곱 캐릭터의 겉모습과 동작은 내려받은 파일 없이 `components/office/OfficeCharacter.ts`에서 three.js 기본 도형으로 만든다.
  머리색·머리 모양·옷 색은 같은 저장소의 계정 아바타(`public/avatars/`)를 보고 정했다.
- 이전에 쓰던 three.js 예제 로봇(`RobotExpressive.glb`, CC0 1.0)은 더 쓰지 않아 지웠다.

## `office-kit.glb`

아래 원본 모델을 이름 붙은 노드 하나씩으로 묶었다. 원점을 바닥 가운데로 옮기고 크기를 장면 단위로 맞춘 뒤
같은 재질·도형을 합치고 위치·법선·UV를 정수로 줄였다(`KHR_mesh_quantization`). 모양과 텍스처는 바꾸지 않았다.
배치는 `components/office/OfficeRoomAssets.ts`, 휴게 구역 가구 자리는 `lib/office/office-stage.ts` `OFFICE_LOUNGE`에 있다.

| 노드 | 원본 파일 | 팩 |
| --- | --- | --- |
| `desk` | `Models/GLTF format/desk.glb` | Kenney Furniture Kit 2.0 |
| `chairDesk` | `Models/GLTF format/chairDesk.glb` | Kenney Furniture Kit 2.0 |
| `screen` | `Models/GLTF format/computerScreen.glb` | Kenney Furniture Kit 2.0 |
| `keyboard` | `Models/GLTF format/computerKeyboard.glb` | Kenney Furniture Kit 2.0 |
| `bookcase` | `Models/GLTF format/bookcaseOpen.glb` | Kenney Furniture Kit 2.0 |
| `plantTall` | `Models/GLTF format/pottedPlant.glb` | Kenney Furniture Kit 2.0 |
| `trashcan` | `Models/GLTF format/trashcan.glb` | Kenney Furniture Kit 2.0 |
| `coffeeMachine` | `Models/GLTF format/kitchenCoffeeMachine.glb` | Kenney Furniture Kit 2.0 |
| `couch` | `Assets/gltf/couch_pillows.gltf` | KayKit Furniture Bits 1.0 |
| `armchair` | `Assets/gltf/armchair_pillows.gltf` | KayKit Furniture Bits 1.0 |
| `tableLow` | `Assets/gltf/table_low.gltf` | KayKit Furniture Bits 1.0 |
| `rugRect` | `Assets/gltf/rug_rectangle_stripes_B.gltf` | KayKit Furniture Bits 1.0 |
| `rugOval` | `Assets/gltf/rug_oval_B.gltf` | KayKit Furniture Bits 1.0 |
| `lamp` | `Assets/gltf/lamp_standing.gltf` | KayKit Furniture Bits 1.0 |
| `cactus` | `Assets/gltf/cactus_medium_A.gltf` | KayKit Furniture Bits 1.0 |
| `cactusSmall` | `Assets/gltf/cactus_small_A.gltf` | KayKit Furniture Bits 1.0 |
| `shelf` | `Assets/gltf/shelf_B_large_decorated.gltf` | KayKit Furniture Bits 1.0 |
| `frame` | `Assets/gltf/pictureframe_large_A.gltf` | KayKit Furniture Bits 1.0 |
| `frameSmall` | `Assets/gltf/pictureframe_medium.gltf` | KayKit Furniture Bits 1.0 |
| `counter` | `Assets/gltf/kitchencounter_straight_B_backsplash.gltf` | KayKit Restaurant Bits 1.0 |
| `wall` | `Assets/gltf/wall.gltf` | KayKit Restaurant Bits 1.0 |
| `wallWindow` | `Assets/gltf/wall_window_closed.gltf` | KayKit Restaurant Bits 1.0 |
| `wallDoor` | `Assets/gltf/wall_doorway.gltf` | KayKit Restaurant Bits 1.0 |
| `floorTile` | `Assets/gltf/floor_kitchen.gltf` | KayKit Restaurant Bits 1.0 |
| `roundTable` | `Assets/gltf/table_round_A_small.gltf` | KayKit Restaurant Bits 1.0 |
| `stool` | `Assets/gltf/chair_stool.gltf` | KayKit Restaurant Bits 1.0 |

텍스처는 KayKit 팩의 `furniturebits_texture.png`·`restaurantbits_texture.png` 두 장을 그대로 넣었다. Kenney 모델은 색 재질만 쓴다.

## 출처

- KayKit Furniture Bits 1.0, Kay Lousberg (https://kaylousberg.com), CC0 1.0.
  https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0 (커밋 `96d5930a8dbdb363409bbc2d3341718b00e17c9c`), 경로 `addons/kaykit_furniture_bits/`
- KayKit Restaurant Bits 1.0, Kay Lousberg, CC0 1.0.
  https://github.com/KayKit-Game-Assets/KayKit-Restaurant-Bits-1.0 (커밋 `153c8a7535b48237854cb54ff6890679f8c574d1`), 경로 `addons/kaykit_restaurant_bits/`
- Kenney Furniture Kit 2.0, Kenney (https://www.kenney.nl), CC0 1.0.
  https://kenney.nl/assets/furniture-kit
