# 라이브 통화

입력창의 마이크 버튼은 이 대화의 에이전트와 음성으로 통화합니다. 통화 모델은 Codex live이고, 혼자 답할 수 없는 일은 지금 세션에 위임한 뒤 그 답을 읽어 줍니다. 통화 전사는 세션 기록에 남습니다. 통화 중에는 같은 버튼이 종료 버튼이 됩니다. 좁은 화면에서는 모델 선택 등 다른 조작부와 함께 줄을 나누고, 화면 높이가 부족하면 할 일·배너 영역을 스크롤하면서 입력창과 종료 버튼을 사용할 수 있습니다. 확정된 사용자 발화 전체가 끝내는 말(「통화 끊어」, 「알았어, 끊어봐」, 「아니 통화 종료하라고」, 「통화 종료해 줘」 등)이어도 통화가 끝납니다. 「끊지 마」, 「끊어도 돼?」, 「끊어라고 했어」처럼 부정·질문·인용이나 「통화 종료가 안 먹네」 같은 문제 설명은 끝내지 않습니다.

에이전트와의 통화는 Codex 목소리를 사용하며 별도의 음성 합성 서비스나 API 키는 필요하지 않습니다. 별도 「통역」 화면에서는 아래 설명처럼 Gemini Live도 선택할 수 있습니다.

## Codex 목소리

설정 창 왼쪽 **구성**(Configuration) 메뉴의 **통화 음성**에서 에이전트 통화와 Codex 통역이 쓰는 목소리를 고릅니다. 고르면 바로 저장되고 다음 통화부터 적용됩니다. 처음 값은 Sol이고, 한국어 목소리 Haetsal(햇살)·Hanul(하늘)을 비롯한 25개 중에서 고를 수 있습니다. 이 값은 omp 설정의 `live.voice`이며 설정 창 「제공자」 탭의 「Live 음성」과 같은 값입니다. Gemini 통역에는 Codex 목소리 설정이 적용되지 않습니다.

같은 화면의 **말 빠르기**에서 「보통」과 「천천히」를 고를 수 있습니다. 「천천히」를 고르면 다음 통화부터 통화와 통역 모두 또박또박 느리게 말합니다. 속도 숫자를 통화에 직접 넣는 방식은 Codex 통화가 연결되지 않아 쓰지 않고, 통화 지시에 느리게 말하라는 규칙을 붙입니다. 그래서 정확한 배속이 아니라 대략 느려지는 정도이며, 「빠르게」는 지시로는 빨라지지 않아 두지 않았습니다.

| 무엇 | 어디 | 비고 |
|------|------|------|
| Codex 목소리 | omp 설정 `live.voice` | 처음 값 `sol`. 통화마다 설정을 다시 읽으므로 열려 있는 세션에서도 다음 통화부터 바뀝니다 |
| 말 빠르기 | `<agentDir>/cuelo-live-settings.json`의 `pace` | `normal`(처음 값) 또는 `slow`. 통화마다 다시 읽습니다 |

## 통화 중 동작

- **누가 말하는가.** 통화를 시작할 때 서버가 이 세션의 Main을 정합니다. 규칙은 화면 얼굴과 같습니다. 캐릭터가 하나로 예약된 provider는 계정 수와 관계없이 그 캐릭터입니다(Codex→YUKI 등). Anthropic은 **이 세션에 pin된** OAuth 계정의 저장 순서로 정합니다(0→RIN, 1→MIO). 같은 모델을 쓰는 두 세션이 동시에 열려 있어도 각자의 pin으로 갈립니다. pin이 아직 없으면 추측하지 않습니다. 이 결과는 통화 기록의 얼굴·이름 표시에만 쓰이고, 목소리는 늘 Codex 목소리입니다. 통화 답변은 그 캐릭터의 얼굴과 이름으로 보이며 「기본 음성」이라는 표시가 함께 붙습니다. 통화 도중 Main이 바뀌어도 그 통화의 표시는 시작할 때 정한 캐릭터를 따릅니다.
- **Main 대화 공유.** 통화가 열리면(`session.started`) 서버가 이 세션의 최근 사용자·Main 답변과 지난 통화 턴을 오래된 순서로, 한 항목 400자·전체 약 2,400자까지 잘라 `session.context.append`의 `commentary` 채널로 넘깁니다. 대화를 이어 가기 위한 배경이며 읽으라는 내용이 아닙니다. 통화 중 채팅창으로 보낸 요청처럼 위임이 아닌 Main 턴이 끝나면, 그 요청은 `commentary`로, Main의 마지막 답은 위임 결과와 같은 「Agent Final Message」 형식으로 넘겨 통화가 자기 답처럼 읽게 합니다. 위임한 턴의 답은 전처럼 위임 채널로만 갑니다.
- **통화 기록.** 확정된 사용자·assistant 턴만 세션 기록에 남깁니다. 예전에 캐릭터 통화 음성으로 한 통화의 기록은 그때 저장된 화자 표시를 그대로 읽습니다.

## 통역 엔진 선택

통역 화면에서 기존 **Codex Live**와 **Gemini 라이브 (Google Cloud)**를 고를 수 있습니다. 처음 값은 Codex이며 연결 방식은 통역을 멈춘 상태에서 바꿉니다. 비교 측정에서 베트남어만 Cloud가 더 정확해서, 통역을 멈춘 상태에서 언어 짝에 베트남어를 넣으면 Cloud로, 빼면 Codex로 바뀝니다. 베트남어 짝 안에서 직접 Codex로 돌려 두면 방향을 바꿔도 그 선택을 유지합니다. Cloud 인증이 준비되지 않았으면 화면이 그 사실을 알리고 시작 버튼을 막으므로, 그때는 Codex로 돌리면 됩니다. 성별·나이대·분위기는 모든 연결에서 공통으로 쓰며 엔진을 바꿔도 선택값이 유지됩니다. 이 설정은 실제 통역 지시에 포함되지만, 모든 문장에서 원하는 말투가 정확히 재현됨을 보장하지는 않습니다.

Codex는 기존 ChatGPT 로그인을 사용합니다. Cloud 연결은 CUELO 서버가 인증과 실시간 전송을 중계하며 브라우저에 Cloud 인증 토큰을 보내지 않습니다. 마이크 입력과 통역 음성은 선택한 서비스로 전송됩니다.

Cloud 연결에는 API 키 선택칸이 없습니다. 서버의 Cloud 인증 상태를 확인하고, 「통역 시작」을 눌러야 실제 음성 연결을 엽니다. Codex의 연결 준비 동작은 그대로 유지됩니다.

화면은 통역과 들은 원문을 독립된 자막 흐름으로 보여 줍니다. 공급자가 원문과 번역을 같은 시점이나 같은 단위로 보내지 않을 수 있어 줄을 일대일로 맞추지 않습니다. 다시 연결할 때도 최근 전사를 독립된 문맥으로 전달합니다. 언어 판별이 어려운 이름·숫자만으로 화자를 확정하지 않습니다.

### Google Cloud 연결 준비

Cloud 연결은 AI Studio와 다른 API를 사용합니다. 사용할 Cloud 프로젝트에 결제를 연결하고 `aiplatform.googleapis.com`을 활성화한 뒤, CUELO 서버를 실행하는 계정에 [ADC 로그인 인증](https://docs.cloud.google.com/sdk/gcloud/reference/auth/application-default/login)을 준비합니다.

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project PROJECT_ID
```

서버 환경에 `GOOGLE_CLOUD_PROJECT`를 해당 프로젝트 ID로, `GOOGLE_CLOUD_LOCATION`을 지원 지역(예: `us-central1`)으로 설정합니다. 설정을 바꿨다면 CUELO 서버를 다시 시작합니다. 인증 파일과 갱신 토큰은 서버에만 보관하며 공유하거나 저장소에 넣지 않습니다. 프로젝트·지역·인증이 없으면 준비되지 않은 상태를 표시하고 다른 연결로 자동 전환하지 않습니다. 조직 정책이 API 키를 금지하더라도 그 정책을 해제할 필요는 없습니다.

Google Cloud 첫 가입 크레딧은 적용 가능한 Cloud 서비스에 사용할 수 있지만 [AI Studio용 Gemini API 비용에는 사용할 수 없습니다](https://docs.cloud.google.com/free/docs/free-cloud-features#during-free-trial). 크레딧의 종류·잔액·만료일을 Cloud 결제 화면에서 확인하세요. 유료 전환된 계정은 크레딧이 소진되거나 만료된 뒤 비용이 청구될 수 있습니다.

Cloud 콘솔의 **Budgets & caps → 지출 한도 적용**에서 해당 프로젝트와 Vertex AI/Agent Platform 서비스에 [월 지출 한도](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)를 설정할 수 있습니다. 단순 알림용 예산과 구분하세요. 한도는 크레딧 차감 전 예상 사용액을 기준으로 신규 사용을 일시중지하며, 적용 지연과 진행 중 요청 때문에 초과할 수 있습니다. 매월 초기화되므로 크레딧 잔액·만료일에 연동되는 차단 장치는 아닙니다.


## 확인되지 않은 것

- 위임 밖에서 넘긴 맥락(`session.context.append`)은 SDK에 계약만 있고 SDK 자신은 쓰지 않습니다. 통화 모델이 `commentary` 이력을 소리 내 읽지 않는지, 사용자 발화 없이 넘긴 채팅 답을 바로 말하는지는 실제 통화로 확인하지 않았습니다.

관련 구현: `lib/live-session.ts`, `lib/live-character.ts`, `hooks/useLiveVoice.ts`, `components/LiveVoiceButton.tsx`, `components/LiveVoiceConfig.tsx`, `components/SettingsConfig.tsx`, `components/ChatInput.tsx`, `components/ChatWindow.tsx`, `app/api/live/voices/route.ts`.
