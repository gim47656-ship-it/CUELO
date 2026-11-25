---
description: Before any cross_review call.
---

계열 교차검증. review는 Main과 Maker가 부를 수 있고 resolve는 Main 전용이다(Maker는 자기 코드의 필수 검토를 돌린 뒤 reviewId 체인과 finding별 제안 status와 근거를 보고하고, Main이 확인해 resolve한다). action=review: files(cwd 기준 상대 경로)의 변경을 필수 reviewer가 acceptance 기준으로 적대적으로 읽고 reviewId, reviewer 모델, round, triggers, findings를 돌려준다. Anthropic과 DeepSeek 저자는 OpenAI 슬롯 `crossReviewOpenAI`, OpenAI와 그 밖의 저자는 Anthropic 슬롯 `crossReviewAnthropic`으로 보낸다(2026-11-08 사용자 결정으로 DeepSeek 작성분도 GPT가 검토한다).

2026-11-21 사용자 결정(「보조검토자는 아이에 자리를 폐지해야할것」): 새 라운드는 필수 자리만 호출한다. 옛 원장의 R*-ADV-*와 R*-GGL-* 지적은 그대로 읽고 resolve에서 모두 닫는다. 옛 라운드에 늦게 붙은 별도 원장 지적은 `earlierAdvisoryFindings`에도 표시한다.

authors는 코드를 쓴 모델 selector이며 두 필수 자리에 걸치면 둘 다 돌린다. Main 세션은 "main"(자기 현재 모델)도 쓸 수 있지만 subagent 세션에서 "main"은 거절되므로 자기 모델 selector를 주고, subagent 세션의 1회차 authors에 세션 자신의 모델과 같은 계열이 없으면 거절된다. `previousReviewId`를 주는 코드 검토는 직전 코드 검토 이후의 delta만 보며 바뀐 것이 없으면 거절한다. 이어지는 라운드에서 files와 acceptance를 생략하면 체인이 본 파일과 가장 늦은 라운드의 acceptance를 이어받는다(결과 carriedOver; 2026-10-28 전 라운드는 acceptance를 남기지 않아 다시 줘야 한다). 변경이 한 호출 상한(300KB)을 넘으면 거절하지 않고 파일과 hunk 단위로 reviewer 자리마다 최대 16번 나눠 같은 라운드로 심사한다(결과 batches). 16번으로도 모자라거나 공통 부분(기준, 앞 지적, 입력, 참고)만으로 상한에 가까우면 아무것도 보내지 않고 거절한다. base(선택, 1회차 전용, 빈 문자열은 주지 않은 것으로 읽는다)는 이미 커밋된 변경을 심사할 때 쓰는 HEAD 또는 그 조상 커밋이며, 그 커밋부터 HEAD까지의 변경을 보여 준다. 대상 파일의 작업 트리가 HEAD와 같아야 하고(수정, 삭제, 추적 안 한 새 파일은 거절, git이 무시하는 새 파일은 건너뜀) base가 없으면 HEAD와 작업 트리를 비교한다(커밋 뒤에도 같은 체인을 previousReviewId로 이어 가는 것은 base 없이 된다).

reviewer는 모든 finding에 재현 방법 `probe{steps, expectIfReal, expectIfNot?}`와 증명 수준 `proof`를 붙인다. `cited-line`은 인용한 줄만으로 결함이 보이고, `reasoned`는 인용한 코드를 따라 실패 경로를 짚었으며, `needs-run`은 실행해야 결론을 낼 수 있다는 뜻이다. proof 없이 probe만 있는 옛 finding은 `needs-run`으로 센다. 모양이 틀린 probe나 모르는 proof는 해당 필드만 버린다. 재현 방법은 필드당 2,000자에서 자른다.

Main이나 Maker는 재현 방법을 실행한 뒤 `previousReviewId`와 `probeResults[{findingId, command, exitCode, output}]`로 체인당 한 번 판단을 받을 수 있다. probe는 검토 파일과 묶인 입력이 그대로일 때만 실행 결과를 심사한다. 새 검토 파일이나 inputs/references를 받지 않고 검토한 코드의 지문도 바꾸지 않는다. reviewer는 결과마다 `confirmed|withdrawn|unresolved`를 돌려준다(판단이 빠지면 `unresolved`). 체인에 없는 id, 중복 결과, 두 번째 probe, 개인키 블록이 든 결과는 거절한다. 출력은 건당 8KB(넘으면 앞뒤만 남김), 합계 40KB(넘으면 거절)로 제한하고 비밀 값을 가린다. verdict는 자문이며 finding을 자동으로 닫지 않는다. probe를 쓰지 못해도 직접 실행한 명령과 출력으로 1라운드 지적을 반박하거나 수정할 수 있다.

첫 라운드는 사용자 메시지(하네스 주입 제외, Maker의 최초 발주 포함)를 `USER REQUEST`로 싣는다. 코드와 같은 필터로 비밀을 가린다. UTF-8 32KiB 안에서 최초 요청을 보존하고 최근 메시지를 우선한다. 최초 요청만으로 넘으면 앞뒤를 남기고 빠진 구간은 검증 불가로 표시한다. 같은 브랜치에서 Main이 선택적으로 `lab_goal`에 적은 명시 조건도 예산 안에서 싣는다. 원문은 다음 라운드로 넘기지 않는다.

첫 라운드에는 세션 기록에서 하네스가 고른 bash·eval 실행도 `OBSERVED RUNS`로 싣는다. 검수 대상 파일의 경로나 이름을 부르거나 검사 명령인 실행 가운데 최신 10건, 24KiB까지이며, 마지막 수정 전후 표시와 종료 코드를 붙인다. 이미 돌린 실행의 출력은 acceptance에 다시 붙이지 않아도 된다. acceptance가 경로로 부른 미커밋 변경이 `files`·`inputs`·`references`에 없으면 그 diff를 맥락으로만 싣고, 통과는 그 파일을 덮지 않는다. BOM·CRLF·UTF-8 아닌 바이트가 있는 파일에는 바이트 사실 한 줄을 붙인다(2026-11-25, doc/history/2026/11/25-xr-evidence).

신고 증상 재현(2026-11-23 사용자 결정: 「과제에 신고된 증상이 있으면 검수자가 그 증상을 직접 재현해 보는 단계를 넣는다」): 저자는 구체적으로 신고된 증상을 수정 전후에 같은 조건으로 재현하고, 사용한 명령과 출력을 `acceptance` 또는 통과에 묶이는 `inputs`에 넣는다(세션에서 돌린 실행은 `OBSERVED RUNS`로 실리므로 명령만 적어도 된다). 첫 라운드의 reviewer는 출력이 수정 전에는 바로 그 증상이 나왔고 수정 후에는 사라졌음을 보여 주는지 확인한다. 증거가 없거나 실행한 시나리오가 다르면 `major` finding으로 증명되지 않은 점을 적고, 신고 증상을 정확히 재현하는 `probe`를 직접 설계한다. 저자가 그 방법을 그대로 실행해 `previousReviewId`와 `probeResults`로 제출하면 reviewer가 `confirmed|withdrawn|unresolved` 중 하나로 판정한다. 저자가 먼저 제출한 수정 전후 로그와 reviewer가 설계한 재현 방법 및 그 실행 결과는 별개 근거다.

2026-11-23 사용자 결정(「두개의장점을 합쳐야할거아니야」): 「위험 표시가 있거나, 변경이 일정 크기 이상(여러 파일 또는 수십 줄)이면 검수」. 2026-11-22 결정(a1)의 발동 범위를 넓힌다. 1/10 결정론 표본 검토는 되살리지 않고 코드 라운드 상한은 유지한다.

코드 검토는 기본 한 번이다. 첫 코드 검토에서 blocker가 나온 체인만 두 번째 코드 검토를 할 수 있다. probe는 코드 검토 횟수에 넣지 않으므로 실행 순서에 따라 결과의 `round` 번호는 다를 수 있다. 첫 검토 뒤 새로 나온 지적은 심각도와 probe verdict에 관계없이 `roundCap.limitCandidates`로 안내하며, `resolve`에서 지적 id와 사유를 근거로 적어 `limit`로 닫는다. 자발적으로 고쳤다면 그 사실과 검사 근거도 적는다. 첫 검토의 지적에는 여전히 각각 `fixed|refuted|limit`와 근거가 필요하다.

Main과 Maker는 변경 줄의 marker, 해당 위험 범주의 high-risk 선언, 변경 크기 기준 중 하나에 해당하면 완료를 보고하기 전에 1라운드를 돌린다. 초기 크기 기준은 게이트 대상 코드 파일 3개 이상 또는 게이트 대상 코드에서 추가와 삭제를 합쳐 50줄 이상이다. 크기 기준을 넘으면 그 변경의 게이트 대상 코드 파일 전체를 검토한다. 원격이 없거나 커밋 요청이 없다는 이유로 검토를 미루지 않는다(2026-11-22 약한 모델 `shop-service-b`에서 Haiku와 Sonnet이 조기 안내를 받고도 커밋하지 않는다며 건너뜀).

명세가 다루지 않는 보안 기본값(다른 사용자의 데이터 접근 제어, 음수나 범위 밖 입력 검증, 로그와 쿼리 인젝션)에 대한 지적은 「명세가 요구하지 않는다」만으로 `refuted`나 `limit`로 닫지 않는다. 명세가 그 동작을 명시적으로 허용한 문구를 인용하거나, 고치거나, 사용자 결정으로 남긴다(2026-11-22 같은 비교에서 Terra와 DeepSeek 작성자가 접근 제어와 음수 수량 지적을 명세 침묵으로 반박함).

references(선택, 최대 10개)는 심사 대상이 아닌 맥락용 기존 또는 신규 파일(예: 작업 기록, 계약 파일)의 현재 내용을 변경 뒤에 읽기 전용으로 싣는다. 명시한 경로만이며 통과 지문을 덮지 않고 references만으로는 심사하지 않는다. 정책상 제외 경로(비밀을 담는 파일), gitignore, 심볼릭 링크, 바이너리, 파일당 200KiB 초과, inputs와 함께 쓰는 맥락 예산(합계 200KiB, inputs를 먼저 싣고 references는 남은 예산을 쓴다) 초과, 읽는 동안 열린 파일의 실제 경로가 고정한 저장소 루트 아래 요청 경로와 달라진 경우는 빠지고 skippedReferences에 이유가 나온다. 이 경로 확인은 Linux(WSL 포함)의 /proc/self/fd에 의존하므로 native Windows/macOS에서는 references를 읽지 않고 skippedReferences에 unsupported 이유를 남긴다(변경 파일 심사는 그대로). inputs(선택, 최대 10개)는 변경이 일관돼야 하는 명세, 계약, 스키마, 호출자 파일이며, references와 같은 읽기, 필터, 제한으로(맥락 예산은 inputs가 먼저 쓴다) 별도 블록에 싣고(심사 대상 아님, 빠진 것은 skippedInputs) files와 겹치면 거절한다. references와 달리 통과에 묶여서, resolve 뒤 입력이 바뀌거나 지워지면 git_finalize가 그 통과를 덮지 않는 것으로 보고 다시 검토를 요구한다(inputs 없는 검토는 그대로). 이어지는 라운드는 앞 라운드의 입력을 이어받고 더할 수 있으며, 이어받은 입력을 더 읽을 수 없으면 거절하므로 빼려면 previousReviewId 없이 새로 시작한다.

파일 내용은 필수 reviewer 슬롯이 가리키는 provider(OpenAI 또는 Anthropic)로 전송된다. 비밀을 담는 파일(.env*, 키와 인증서 형식, id_*, agent.db, .npmrc, .netrc, .pypirc, .git-credentials, ~/.omp/agent 아래)과 개인키 블록이 든 파일, 바이너리, 큰 입력은 제외한다. 제외한 파일은 정책상 심사할 수 없다는 이유와 다음 단계(이름 또는 위치 바꾸기, 커밋에서 빼기, 사용자 명시 지시의 waiver)를 결과 skipped와 nextStep에 바로 알리며, 같은 파일에 라운드를 더 돌려도 통과는 나오지 않고 git_finalize의 거절 메시지도 같은 이유를 말한다. credential, secret, password, api-key를 품은 이름이나 단독 auth 또는 token 이름처럼 이름만 걸린 파일은 제외하지 않고 비밀로 보이는 값을 [REDACTED]로 가려(결과 redacted에 횟수) 심사한다. 이미 시작된 심사에서 바뀐 줄이 테스트 파일 삭제, 테스트 호출 순감소, skip 추가, 억제 주석 추가, 빈 catch 추가 모양이면 결과의 hidingLeads와 reviewer 프롬프트에 판정이 아닌 단서로만 붙으며 trigger와 게이트 판정은 바뀌지 않는다.

`action=resolve`는 Main 전용이며 다른 세션이 시작한 체인도 닫을 수 있다. 체인의 모든 finding에 `{id, status, evidence}`가 있어야 하며, 통과 지문은 resolve 시점의 git blob으로 기록한다. 마지막으로 코드 검토를 받은 내용과 다른 파일은 `unreviewedChanges`로 알린다. 문서, 테스트, 생성물만 다르면 안내에 그친다. 코드가 바뀌었고 두 번째 코드 검토를 할 수 있으면 `previousReviewId`로 delta를 검토한 뒤 resolve한다. 첫 검토에 blocker가 없거나 두 번째 코드 검토를 마친 경우에는 `unreviewedAcknowledgements[{path, evidence}]`에 달라진 코드 파일마다 그 내용에 실행한 검사를 적는다. 이 근거가 없으면 `unreviewedBlocking`에 남고 통과하지 않는다. 안전 필터 때문에 다음 검토에서도 보일 수 없는 파일은 기존 예외를 적용한다. 받아들인 확인 응답은 경로, blob, 근거를 남긴다.

`git_finalize`는 `crossReviewHighRisk`로 선언했거나 바뀐 줄에 trigger marker가 있는 코드 파일의 통과 기록을 요구한다. 이번 커밋의 `files` 목록 안에서 크기 기준에 이르면 그 목록의 변경된 게이트 대상 코드 파일 전부에 통과 기록을 요구한다. 경로 이름만으로는 marker가 되지 않는다. `crossReviewHighRisk`, `cross_review`의 `highRisk`와 브리프의 high-risk 선언은 `harness-policy.json`의 `routing.high-risk.materialRiskDefinition`에 해당할 때만 쓴다. 테스트, 문서, 생성물, git이 바이너리로 보는 미디어나 오피스 파일 및 글꼴, TypeScript 파서로 주석만 바뀐 것이 증명된 TS/JS 수정, 버전 문자열만 바뀐 수정은 게이트와 크기 집계에서 빠진다. 통과한 내용에서 주석이나 버전 문자열만 바뀌었다면 기존 통과가 그대로 덮는다. reviewer의 PASS 표현은 근거가 아니다.

2026-10-29 문서 처리: files에 섞인 문서와 작업 기록 데이터는 코드와 함께 심사할 때 references로 옮기고 게이트 통과가 덮지 않는다.
결과의 docsMovedToReferences와 nextStep이 이를 알리며 reviewer는 문서에 지적을 내지 않는다. 문서뿐인 요청은 그대로 심사하고 기존 inputs/references는 유지한다.
참조 한도를 넘으면 skippedReferences로 알린다. marker의 블록 주석 처리와 early notice의 세부는 `extensions/lib/cross-review.ts`가 정본이다.
조기 알림과 턴 끝 안내는 게이트가 아니다. 변경 크기는 편집한 저장소의 미커밋 변경 전체를 기준으로 보므로, `git_finalize`의 `files` 목록보다 넓을 수 있다. 조기 알림은 아직 통과가 덮지 않는 파일당 세션에서 한 번 보낸다. 턴 끝에는 아직 통과가 없는 파일을 안내한다. 파일이 정착되면 관련 코드를 함께 검토한다.
`bash`, `eval`, 적용된 `ast_edit`처럼 편집 경로를 직접 받지 않는 도구의 성공 결과도 저장소 전체를 크기 기준으로 확인한다. 짧은 간격으로 끝난 호출은 조회를 합친다. 도구 결과는 조회를 최대 1초 기다린다. 조회가 더 오래 걸리면 나중에 조기 알림과 미통과 목록을 갱신하며, 그전에 턴이 끝났다면 해당 턴 안내에는 마지막 변경이 빠질 수 있다.

믿기 어려운 작은 diff(되돌리기 어려운 상태 변경, 여러 호출자가 기대는 계약, 실행 순서·시점에 기대는 수정)는 저자가 cross_review 전에 `blast-radius` 스킬로 사전 점검한다: 그 변경이 안전한 근거가 되는 사실 하나를 찾아 실제 코드에 돌리는 스크립트로 증명하고, 증명이 멈춘 단계와 남은 위험·확인한 항목을 작업 기록에 남긴다. 그 스크립트와 출력은 acceptance·resolve 근거로 쓸 수 있지만 review·resolve를 대신하지 않는다.

필수 검토가 공급자 사용량이나 속도 한도(429, `rate_limit`, usage limit 등)로만 실패하면 재호출이나 대체 없이 2026-11-09 공급자 한도 예외를 안내한다. Main은 `git_finalize` 또는 `git_integrate`의 `crossReviewWaiver`에 사용자 결정, reviewId와 원문 오류를 적고, 작업 기록과 보고에 필수 검토를 완료하지 못했다고 밝힌다. Maker는 같은 근거를 Main에 보고한다. 한도 외 실패가 하나라도 있으면 이 예외에 들어가지 않으며 면제하려면 별도 사용자 명시 지시가 필요하다.

## Maker의 보고 전 검토

Maker는 지시서의 high-risk 선언, 그 위험에 대한 `# Acceptance`의 교차검토 요구, 바뀐 줄의 gate marker, 변경 크기 기준 중 하나에 해당하면 맡은 검사를 마친 뒤 보고 전에 review한다.
Main은 Maker 소유 코드를 직접 review하지 않고 지적과 다음 라운드를 owner에게 전달한 뒤 증거를 확인해 resolve한다.
owner를 다시 깨울 수 없을 때만 Main이 대신한다. authors는 Maker 자신의 selector이고 Main-only resolve는 호출하지 않는다.
Maker는 finding별 제안 status와 근거, reviewId 체인을 보고한다. 마지막 코드 검토 뒤 코드를 바꿨다면 두 번째 코드 검토가 허용되는 경우에만 delta로 다시 보인다. 새 라운드를 열 수 없으면 바뀐 파일마다 실행한 검사를 Main에 넘겨 `unreviewedAcknowledgements`에 남긴다.
검토 범위와 제외는 위 gate 계약을 따르고 바뀌지 않은 caller와 계약은 inputs/references로 보낸다.
2026-10-28 사용자 결정의 주석/semver 면제 및 입력 승계는 위 계약을 따른다.
참고 파일 상한은 파일당 200 KiB, inputs 우선 합계 200 KiB다. 옛 64kb 표기는 적용하지 않는다.
