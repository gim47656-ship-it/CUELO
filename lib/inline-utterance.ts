import type { AgentMessage, AssistantMessage, SubagentSnapshot } from "./types";

/**
 * 대화창에 자기 목소리로 끼어드는 발화 하나.
 *
 * Main 의 답이 아닌 화자(지금은 자식 에이전트, 앞으로 늘어날 무엇이든)는 모두 이 모양
 * 하나로 정규화한 뒤 렌더러 한 곳이 그린다. 출처를 아는 코드는 어댑터 안에만 있고
 * 렌더러에는 없다 — 화자가 늘어도 렌더러는 그대로다.
 *
 * 얼굴을 고르는 입력은 `provider` 와 `credentialId` 둘뿐이다. `label` 은 화면에 붙는
 * 표시 텍스트일 뿐 얼굴 해소에 관여하지 않는다.
 */
export interface InlineUtterance {
  /** 같은 발화를 다시 그릴 때 자리를 지키는 키. 폴링이 반복돼도 값이 변하지 않아야 한다. */
  key: string;
  /** 발화가 붙을 턴 — 그 턴을 연 사용자 메시지의 인덱스. */
  turnIndex: number;
  /** 계정을 가리키는 입력. 얼굴은 이 둘로만 고른다. */
  provider: string;
  credentialId?: number;
  /** 계정 pin의 소유 세션. null이면 부모 세션 계정을 대체 근거로 쓰지 않는다. */
  accountSessionId?: string | null;
  /**
   * 화자 하나를 가리키는 이름. 출처가 다르면 같은 이름이라도 다른 화자이므로 어댑터가
   * 자기 출처 이름을 앞에 붙여 만든다. 같은 화자의 발화인지 가리는 유일한 근거다.
   */
  speakerId: string;
  /** 화자의 표시 이름(예: 자식의 spawn 이름). 없으면 별칭만 그린다. */
  label?: string;
  text: string;
  status: InlineUtteranceStatus;
}

export type InlineUtteranceStatus = "streaming" | "settled" | "failed";

/**
 * 캐릭터 호출 마커가 실어 온 요청 대상. 한 `task` 호출이 `tasks[]` 배치로 여러 자식을
 * 띄울 수 있으므로 `name`(tasks[].name, 런타임이 자식 id로 쓰는 값)으로 자식과 짝을 맞춘다.
 * 호출 id만으로는 배치 안의 어느 자식이 어느 캐릭터인지 알 수 없다.
 */
export interface CharacterSummonRequest {
  /** 이 요청을 실은 `task` 도구 호출 id. */
  toolCallId: string;
  /** `tasks[]` 배치 항목의 이름. 단일 `task` 호출에는 없을 수 있다. */
  name?: string;
  /** 요청한 캐릭터 별칭(예: "ISANA(이사나)"). */
  alias: string;
  /** 요청한 모델 id(`provider/model`). */
  model: string;
  /** 이 요청을 실은 호출의 task 항목 수. 1이면 그 호출의 유일한 자식이 곧 이 요청이다. */
  batchSize: number;
}

/**
 * 발화가 붙을 턴 하나. 앵커는 그 턴을 연 사용자 메시지다 — `partitionTranscriptPlan` 이
 * 작업 로그를 묶는 `anchorIdx` 와 같은 자리라, 대화창은 그 턴의 마지막 항목 뒤에 붙이면 된다.
 */
export interface InlineUtteranceTurn {
  /** 그 턴을 연 사용자 메시지의 인덱스. */
  index: number;
  /** 그 턴을 가리키는 항목 id. 없으면 인덱스가 유일한 이름이다. */
  entryId?: string;
  /** 이 턴이 띄운 `task` 도구 호출의 toolCallId. 자식과 턴을 잇는 유일한 열쇠다. */
  taskToolCallIds: readonly string[];
  /**
   * 이 턴의 `task` 호출 중 command guard가 캐릭터 호출 마커를 넣은 요청. 일반 구현 child와
   * 명시적인 캐릭터 호출을 가르는 근거이고, 호출이 실패했을 때 요청 대상을 되찾는 근거다.
   */
  characterSummons: readonly CharacterSummonRequest[];
  /**
   * 이 턴에서 부모가 `write agent://<id>`로 보낸 메시지들. 자식이 받았는지는 이 목록이 아니라 자식
   * 기록의 `irc:incoming`이 증명한다 — 여기서는 발신 후보만 모은다. `from`은 그 호출의
   * toolResult details에서 온다 — 결과가 아직 없는(스트리밍 중) send는 발신자를 모르므로
   * `from` 없이 남고, 소비자는 그런 send를 수신 경계와 잇지 않는다.
   */
  peerSends: readonly PeerSend[];
}

/**
 * 부모가 `write agent://<id>`로 보낸 메시지 하나. `to`는 요청한 수신자(자식 id 또는 "all"),
 * `from`은 toolResult details가 확정한 발신자다.
 */
export interface PeerSend {
  /** 이 send를 싣는 toolCall id. 스트리밍 목록과 settled 목록의 중복을 가르는 키다. */
  toolCallId: string;
  /** 요청한 수신자. 자식 id 또는 "all". */
  to: string;
  /** toolResult details가 확정한 발신자. 결과가 아직 없으면 없다. */
  from?: string;
  /** 보낸 본문. 자식의 `irc:incoming` details.message와 같은 값이다. */
  message: string;
  /** toolResult details의 수신 확인. 없으면 아직 결과가 안 온 send다. */
  receipts?: readonly { to?: string; outcome?: string }[];
}

/**
 * 어댑터가 보는 창. 턴 하나가 아니라 창 전체를 한 번에 준다 — 어댑터가 자기 것으로 골라 쓴다.
 * 자식 발화는 폴링으로 흘러 들어오므로 렌더마다 훅을 부를 수 없고, 그래서 어댑터도 훅이다.
 */
export interface InlineUtteranceContext {
  sessionId: string | undefined;
  /** 세션이 지금 쓰는 provider. 자식이 자기 모델을 아직 기록하지 않았을 때의 근거다. */
  sessionProvider: string | undefined;
  turns: readonly InlineUtteranceTurn[];
  /**
   * 대화창이 그리고 있는 메시지 배열 그대로. `turns` 로 갈음할 수 없어서 원본이 필요하다 —
   * `buildInlineTurns` 는 `task` 도구 호출을 띄운 턴만 담으므로(아래), 자식 없이 진행된 턴에
   * 앵커해야 하는 출처는 그 목록에서 자기 턴을 찾을 수 없다. 시각으로 턴을 고르는 출처도
   * 여기서 경계를 얻는다(`timestamp` 는 `entryToUiMessage` 가 이미 싣는다).
   *
   * 이 배열의 인덱스가 곧 `InlineUtterance.turnIndex` 다. 대화창이 낙관적으로 먼저 붙이는
   * 사용자 메시지는 언제나 **배열 끝**에만 붙으므로 앞선 턴의 인덱스는 흔들리지 않는다.
   */
  messages: readonly AgentMessage[];
  /** 실행 중이거나 방금 끝난 자식. 출처마다 자기 것만 골라 쓴다. */
  subagents: readonly SubagentSnapshot[];
}

/**
 * 발화 출처 하나. 자기 발화를 돌려주는 훅이다.
 *
 * 훅이므로 `useInlineUtterances` 가 렌더마다 같은 순서로 직접 부른다. 새 화자를 붙이는 일은
 * 이 계약을 구현한 어댑터 하나를 만들어 그 훅에서 부르는 것으로 끝난다.
 */
export interface InlineUtteranceSource {
  /** 출처를 가리키는 이름. 진단과 키에 쓴다. */
  id: string;
  use(context: InlineUtteranceContext): readonly InlineUtterance[];
}

/**
 * 한 assistant 메시지가 띄운 `task` 도구 호출의 id. 자식 스냅샷의 `parentToolCallId` 가
 * 이 값과 같아서, 이것이 자식과 턴을 잇는 열쇠다.
 *
 * 스트리밍 중인 메시지는 아직 다 차지 않았으므로 `Partial` 로도 받는다.
 */
export const CHARACTER_SUMMON_MARKER =
  /^\[character-summon alias="([^"\r\n]+)" model="([^"\r\n]+)"(?: oauth-position="\d+")?\]\r?$/mu;

/** task 문자열에서 첫 character-summon 마커 줄을 읽는다. 마커가 없으면 빈 배열이다. */
function parseCharacterSummonTask(
  toolCallId: string,
  name: string | undefined,
  task: unknown,
  batchSize: number,
): CharacterSummonRequest[] {
  if (typeof task !== "string") return [];
  const match = CHARACTER_SUMMON_MARKER.exec(task);
  const alias = match?.[1];
  const model = match?.[2];
  if (!alias || !model) return [];
  return [{ toolCallId, ...(name ? { name } : {}), alias, model, batchSize }];
}

/**
 * 명시적인 character-summon 마커 줄을 가진 task 호출의 요청을 고른다. TASK_GUARD 뒤에도 올 수
 * 있다. 모델·provider·child 이름은 호출 의도를 증명하지 못하므로 이 판정에 쓰지 않는다.
 *
 * `tasks[]` 배치는 항목마다 요청 하나를 낸다 — 같은 toolCallId 아래 어느 자식이 어느
 * 캐릭터인지는 `name`이 가른다.
 */
export function collectCharacterSummons(
  message: Partial<AgentMessage> | null | undefined,
): CharacterSummonRequest[] {
  if (!message || message.role !== "assistant") return [];
  const requests: CharacterSummonRequest[] = [];
  for (const block of message.content ?? []) {
    if (block.type !== "toolCall" || block.toolName !== "task") continue;
    const input = block.input;
    const batchSize = (input.task === undefined ? 0 : 1)
      + (Array.isArray(input.tasks) ? input.tasks.length : 0);
    requests.push(...parseCharacterSummonTask(
      block.toolCallId,
      typeof input.name === "string" ? input.name : undefined,
      input.task,
      batchSize,
    ));
    if (!Array.isArray(input.tasks)) continue;
    for (const item of input.tasks) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      requests.push(...parseCharacterSummonTask(
        block.toolCallId,
        "name" in item && typeof item.name === "string" ? item.name : undefined,
        "task" in item ? item.task : undefined,
        batchSize,
      ));
    }
  }
  return requests;
}

export function collectTaskToolCallIds(
  message: Partial<AgentMessage> | null | undefined,
): string[] {
  if (!message || message.role !== "assistant") return [];
  const ids: string[] = [];
  for (const block of message.content ?? []) {
    if (block.type === "toolCall" && block.toolName === "task") ids.push(block.toolCallId);
  }
  return ids;
}

/** `agent://<id>` 쓰기 대상에서 수신자를 읽는다. JSON-path 접미사가 붙은 대상은 코어가 거부한다. */
const AGENT_WRITE_TARGET = /^agent:\/\/([^/?#]+)\/?$/i;

/**
 * `write agent://` toolResult의 details.message에서 발신자와 수신 확인을 읽는다. send의 `from`은
 * toolCall input에 없고 결과에만 오므로, 발신자를 아는 send는 결과가 도착한 것뿐이다.
 */
function collectPeerSendResults(
  messages: readonly AgentMessage[],
): Map<string, { from?: string; receipts?: readonly { to?: string; outcome?: string }[] }> {
  const results = new Map<string, { from?: string; receipts?: readonly { to?: string; outcome?: string }[] }>();
  for (const message of messages) {
    if (message.role !== "toolResult" || message.toolName !== "write") continue;
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const sent = (details as Record<string, unknown>).message;
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) continue;
    const record = sent as Record<string, unknown>;
    if (record.op !== "send") continue;
    const receipts = Array.isArray(record.receipts)
      ? record.receipts
          .filter((receipt): receipt is Record<string, unknown> => (
            typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)
          ))
          .map((receipt) => ({
            to: typeof receipt.to === "string" ? receipt.to : undefined,
            outcome: typeof receipt.outcome === "string" ? receipt.outcome : undefined,
          }))
      : undefined;
    results.set(message.toolCallId, {
      from: typeof record.from === "string" ? record.from : undefined,
      receipts,
    });
  }
  return results;
}

/**
 * 한 assistant 메시지가 띄운 `write agent://<id>` 호출을 모은다. 수신자가 경로에 있고 본문
 * (`content`)이 문자열로 있는 호출만 발신 후보다 — 이름 없는 send는 자식과 잇는 근거가 없다.
 * 코어는 agent:// 본문을 그대로 보내므로 `content`가 자식의 `irc:incoming` 본문과 같다.
 * `from`은 이미 도착한 toolResult에서만 채운다.
 */
export function collectPeerSends(
  message: Partial<AgentMessage> | null | undefined,
  sendResults?: ReadonlyMap<string, { from?: string; receipts?: readonly { to?: string; outcome?: string }[] }>,
): PeerSend[] {
  if (!message || message.role !== "assistant") return [];
  const sends: PeerSend[] = [];
  for (const block of message.content ?? []) {
    if (block.type !== "toolCall" || block.toolName !== "write") continue;
    const input = block.input;
    const target = typeof input.path === "string" ? AGENT_WRITE_TARGET.exec(input.path) : null;
    const to = target?.[1];
    const body = input.content;
    if (!to || typeof body !== "string") continue;
    const result = sendResults?.get(block.toolCallId);
    sends.push({
      toolCallId: block.toolCallId,
      to,
      message: body,
      ...(result?.from ? { from: result.from } : {}),
      ...(result?.receipts ? { receipts: result.receipts } : {}),
    });
  }
  return sends;
}

/**
 * 대화 기록에서 턴마다 어떤 `task` 호출을 띄웠는지 모은다.
 *
 * 스트리밍 중인 턴은 아직 `messages` 에 없고 `streamState.streamingMessage` 에만 있으므로
 * 그쪽 id 를 따로 받는다. 그 id 들은 마지막 사용자 메시지가 연 턴의 것으로 본다 — 도구
 * 호출은 그 메시지가 끝난 뒤에 실행되므로, 자식이 도는 동안의 턴은 언제나 마지막 턴이다.
 *
 * 자식의 자식(손자)은 여기에 걸리지 않는다. 손자의 `parentToolCallId` 는 자식 세션 안의
 * `task` 호출을 가리키므로 이 대화 기록에는 없다 — 인라인은 한 단계까지만이다.
 */
export function buildInlineTurns(
  messages: readonly AgentMessage[],
  entryIds: readonly string[],
  streamingTaskToolCallIds: readonly string[] = [],
  streamingCharacterSummons: readonly CharacterSummonRequest[] = [],
  streamingPeerSends: readonly PeerSend[] = [],
): InlineUtteranceTurn[] {
  const sendResults = collectPeerSendResults(messages);
  const turns: InlineUtteranceTurn[] = [];
  const byIndex = new Map<number, InlineUtteranceTurn>();
  let turnIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      turnIndex = index;
      continue;
    }
    const ids = collectTaskToolCallIds(message);
    const sends = collectPeerSends(message, sendResults);
    if ((ids.length === 0 && sends.length === 0) || turnIndex < 0) continue;
    const summons = collectCharacterSummons(message);
    let turn = byIndex.get(turnIndex);
    if (!turn) {
      turn = {
        index: turnIndex,
        entryId: entryIds[turnIndex],
        taskToolCallIds: [],
        characterSummons: [],
        peerSends: [],
      };
      byIndex.set(turnIndex, turn);
      turns.push(turn);
    }
    turn.taskToolCallIds = [...turn.taskToolCallIds, ...ids];
    turn.characterSummons = [...turn.characterSummons, ...summons];
    turn.peerSends = [...turn.peerSends, ...sends];
  }
  if (streamingTaskToolCallIds.length > 0 || streamingPeerSends.length > 0) {
    let lastUser = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") { lastUser = index; break; }
    }
    if (lastUser >= 0) {
      let turn = byIndex.get(lastUser);
      if (!turn) {
        turn = {
          index: lastUser,
          entryId: entryIds[lastUser],
          taskToolCallIds: [],
          characterSummons: [],
          peerSends: [],
        };
        byIndex.set(lastUser, turn);
        turns.push(turn);
      }
      const known = new Set(turn.taskToolCallIds);
      turn.taskToolCallIds = [
        ...turn.taskToolCallIds,
        ...streamingTaskToolCallIds.filter((id) => !known.has(id)),
      ];
      const knownSummons = new Set(
        turn.characterSummons.map((summon) => `${summon.toolCallId} ${summon.name ?? ""}`),
      );
      turn.characterSummons = [
        ...turn.characterSummons,
        ...streamingCharacterSummons.filter(
          (summon) => !knownSummons.has(`${summon.toolCallId} ${summon.name ?? ""}`),
        ),
      ];
      const knownSends = new Set(turn.peerSends.map((send) => send.toolCallId));
      turn.peerSends = [
        ...turn.peerSends,
        ...streamingPeerSends.filter((send) => !knownSends.has(send.toolCallId)),
      ];
    }
  }
  return turns.sort((left, right) => left.index - right.index);
}


/**
 * 어댑터가 내놓은 발화를 화면이 쓸 모양으로 정규화한다 — 모든 출처가 지나는 한 곳이다.
 *
 * 같은 화자가 같은 문장을 연달아 남기는 일이 있다. 도구 호출 없이 끝난 턴을 런타임이
 * 되돌리고 같은 답변을 다시 쓰게 하면(yield 재시도) 기록에는 같은 텍스트가 두 번 남는다.
 * 말은 한 번 한 것이므로 화면에도 한 번만 세우고, 남기는 것은 뒤에 온 기록이다 — 뒤엣것이
 * 도구 호출을 함께 진, 정착한 턴의 기록이라 화면이 두 기록 사이에서 흔들리지 않는다.
 *
 * 겹치는 조건은 좁다. 같은 화자(speakerId)의 발화가 바로 앞에 있고, 그 사이에 아무 발화도
 * 끼지 않았고, 같은 턴이며, 텍스트가 한 글자도 다르지 않을 때만이다. 다른 화자의 발화는
 * 절대 겹치지 않고, 떨어져 있는 반복도, 공백만 다른 문장도 그대로 남는다.
 */
export function normalizeInlineUtterances(
  utterances: readonly InlineUtterance[],
): readonly InlineUtterance[] {
  const kept: InlineUtterance[] = [];
  for (const utterance of utterances) {
    const previous = kept[kept.length - 1];
    if (
      previous
      && previous.speakerId === utterance.speakerId
      && previous.turnIndex === utterance.turnIndex
      && previous.text === utterance.text
    ) {
      kept[kept.length - 1] = utterance;
      continue;
    }
    kept.push(utterance);
  }
  return kept;
}

/** 발화를 붙일 턴별로 묶는다. 렌더러는 이 지도 하나만 보면 된다. */
export function groupInlineUtterances(
  utterances: readonly InlineUtterance[],
): ReadonlyMap<number, readonly InlineUtterance[]> {
  const byTurn = new Map<number, InlineUtterance[]>();
  for (const utterance of utterances) {
    const list = byTurn.get(utterance.turnIndex);
    if (list) list.push(utterance);
    else byTurn.set(utterance.turnIndex, [utterance]);
  }
  return byTurn;
}
