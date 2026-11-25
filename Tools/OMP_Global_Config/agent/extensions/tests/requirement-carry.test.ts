import { describe, expect, test } from "bun:test";
import { carriesUserWords, forLog, stripGuardLines, unsupportedApprovalClaims } from "../../cuelo-plugins/requirement-carry/requirement-carry";
import { createRequirementCarry } from "../../cuelo-plugins/requirement-carry/index";

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(options: { sub?: boolean; branch?: string[]; session?: string; log?: (record: Record<string, unknown>) => void } = {}) {
  const handlers = new Map<string, Handler>();
  const logs: Record<string, unknown>[] = [];
  const sent: { content: string }[] = [];
  const pi = {
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    sendMessage: (message: { content: string }) => sent.push(message),
  };
  createRequirementCarry({ log: options.log ?? ((record) => logs.push(record)) })(pi as never);
  const session = options.session ?? "s-carry";
  const branch = (options.branch ?? []).map((text) => ({ type: "message", message: { role: "user", content: text } }));
  const ctx = {
    agent: { kind: options.sub ? "sub" : "main" },
    isIdle: () => true,
    sessionManager: { getSessionId: () => session, getBranch: () => branch },
  };
  const fire = (name: string, event: unknown) => handlers.get(name)?.(event, ctx);
  let id = 0;
  const dispatch = (toolName: "task", input: Record<string, unknown>) => {
    const toolCallId = `call-${++id}`;
    fire("tool_call", { toolName, toolCallId, input });
    const result = fire("tool_result", { toolName, toolCallId, input, content: [{ type: "text", text: "dispatched" }] }) as
      | { content: { type: string; text: string }[] }
      | undefined;
    return result?.content.map((part) => part.text) ?? ["dispatched"];
  };
  fire("session_start", {});
  const say = (text: string) => fire("input", { source: "interactive", text });
  const compact = (summary: string) => fire("session_compact", { compactionEntry: { type: "compaction", summary }, fromExtension: false });
  return { fire, say, compact, dispatch, logs, sent, session };
}

const USER = "세개다만들어주고 추후점검항목으로 남길것";
const GUARD = [
  "TASK_GUARD:",
  "WORK_CLASS: feature",
  "PURPOSE: primary",
  "BLOCKS_PRIMARY: yes",
  "PRIMARY_DELIVERABLE: requirement-carry plugin",
  "OWNED_PATHS: a/,b/",
  `USER_REQUEST: ${USER}`,
  "TASK_TITLE: plugin",
  'TODO_TASKS: ["plugin"]',
  "EXPECTED_MINUTES: 120",
  "DONE_WHEN: tests pass",
  "REPLAN_WHEN: never",
].join("\n");
const paraphrase = `${GUARD}\n\n# Goal\nBuild the third advisory plugin and wire its detection tests as agreed.`;
const withQuote = `${paraphrase}\nUser words: 「${USER}」`;

describe("requirement-carry compaction check", () => {
  test("an approval sentence with no user quote is flagged; the same sentence quoting the user verbatim is not", () => {
    const users = ["프로덕션 배포 진행해 주세요"];
    expect(unsupportedApprovalClaims("사용자가 프로덕션 배포를 승인했다.", users)).toHaveLength(1);
    expect(unsupportedApprovalClaims("사용자가 「프로덕션  배포 진행해」라고 승인했다.", users)).toEqual([]);
    expect(unsupportedApprovalClaims('The user approved the deploy ("프로덕션 배포 진행해 주세요").', users)).toEqual([]);
    expect(unsupportedApprovalClaims("The user approved deleting the old branch.", users)).toHaveLength(1);
    expect(unsupportedApprovalClaims("Do not push to main without approval.", users)).toEqual([]);
  });

  test("near misses: a quote the user never wrote, a quote under 6 characters, and a sentence that only says approval is missing", () => {
    const users = ["프로덕션 배포 진행해 주세요"];
    expect(unsupportedApprovalClaims("사용자가 「스테이징 삭제 진행」이라며 승인했다.", users)).toHaveLength(1);
    expect(unsupportedApprovalClaims("사용자가 「진행」이라며 승인했다.", ["진행해"])).toHaveLength(1);
    expect(unsupportedApprovalClaims("배포는 아직 승인되지 않았다. The change is not approved yet.", users)).toEqual([]);
    expect(unsupportedApprovalClaims("테스트를 돌리고 결과를 기록했다.", users)).toEqual([]);
    // 승인 근거를 주장하는 문장만 대상이다: 주어 없는 grant나 아직 결정하지 않았다는 말은 아니다.
    expect(unsupportedApprovalClaims("The release bot approved the merge.", users)).toEqual([]);
    expect(unsupportedApprovalClaims("사용자가 아직 결정하지 않았다. The user has not decided whether to rotate.", users)).toEqual([]);
  });

  test("compaction event: a quiet advisory for unsupported sentences, none when quoted, announced again for every summary", () => {
    const h = harness();
    h.say("프로덕션 배포 진행해 주세요");
    h.compact("사용자가 「프로덕션 배포 진행해」라고 승인했다. 문서는 다듬었다.");
    expect(h.sent).toEqual([]);
    h.compact("사용자가 스테이징 삭제를 허락했다. 사용자가 「프로덕션 배포 진행해」라고 승인했다.");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.content).toStartWith("[requirement-carry]");
    expect(h.sent[0]!.content).toContain("원문 대조 필요");
    expect(h.sent[0]!.content).toContain("스테이징 삭제를 허락했다");
    expect(h.sent[0]!.content).not.toContain("프로덕션 배포 진행해」라고");
    // The advisory sat in context that compaction just folded into the summary, so each summary is announced again.
    h.compact("사용자가 스테이징 삭제를 허락했다.");
    expect(h.sent).toHaveLength(2);
    expect(h.logs).toMatchObject([
      { kind: "compaction", sessionId: h.session, main: true, count: 1, items: ["사용자가 스테이징 삭제를 허락했다."] },
      { kind: "compaction", count: 1 },
    ]);
  });

  test("user words come from the saved branch too, and a child session is checked as well", () => {
    const h = harness({ sub: true, branch: ["Deploy 하기 전에 승인 받고 진행해"] });
    h.compact('Rule: "Deploy 하기 전에 승인 받고 진행해" (user). The user approved deleting the old branch.');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.content).toContain("approved deleting the old branch");
    expect(h.sent[0]!.content).not.toContain("Rule:");
    expect(h.logs[0]).toMatchObject({ kind: "compaction", main: false });
  });

  test("advice stays within about 600 characters however many sentences are flagged", () => {
    const h = harness();
    h.say("hello there");
    h.compact(Array.from({ length: 12 }, (_, i) => `사용자가 ${i}번 작업을 아주 길게 설명한 내용과 함께 승인했다고 요약이 주장한다.`).join(" "));
    expect(h.sent[0]!.content.length).toBeLessThanOrEqual(600);
    expect(h.sent[0]!.content).toContain("외 ");
  });

  test("approval-required restrictions are never flagged (the paper's restriction test was not significant); questions and mere mentions are not grants", () => {
    expect(unsupportedApprovalClaims("Approval is required before deployment. Permission must be obtained first.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("배포 전 승인이 있어야 한다. 배포하려면 허가가 필요하다. 승인 없이 삭제하지 않는다.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("Network and system changes need user approval. Other PCs need separate approval.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("Do not push to main without approval. Staging does not need approval whereas production requires approval.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("Did the user approve the deploy?", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user asked how the approval process works. The user discussed approval.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user gave permission for deployment.", [])).toHaveLength(1);
  });

  test("grants by other actors, requests, questions and permission-for-time wording are not user grants", () => {
    expect(unsupportedApprovalClaims("The user gave us permission.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user asked for permission to deploy.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user wrote tests, and CI approved the build.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user allowed time for testing.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user approved deployment after QA rejected the first build.", [])).toHaveLength(1);
  });

  test("grant wording variants: object nouns are not actors, a relative clause keeps the grant, request verbs and sign-off idioms are not grants", () => {
    expect(unsupportedApprovalClaims("The user reviewed the plan and approved the system.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user approved the change that CI rejected.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user applied for permission to deploy. The user signed off for the night.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user gave the release manager permission.", [])).toHaveLength(1);
  });

  test("approval nouns, status lines, denials, personal decisions, recipients and quoted multi-sentence replies", () => {
    expect(unsupportedApprovalClaims("The user gave explicit approval to deploy.\n프로덕션 배포: 사용자 승인 완료.", [])).toHaveLength(2);
    expect(unsupportedApprovalClaims("Deployment requires approval from the user.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user hasn't approved the deployment yet.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user decided to investigate the error personally.\n사용자가 오류를 직접 조사하기로 결정했다.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user decided to approve the migration.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user decided to proceed with their own investigation.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user was granted permission to deploy. The user hasn't given approval for the rollout.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user will grant approval once testing is complete. 사용자가 승인한 적이 없다.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("Approval from the user is required before deployment.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user not only approved the rollout but also requested a status update.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user approved deployment: “Ship it!”", ["Ship it!"])).toEqual([]);
    expect(unsupportedApprovalClaims("Permission to deploy was granted by the user. Approval from the user was granted.", [])).toHaveLength(2);
    expect(unsupportedApprovalClaims("The user received permission to deploy. The user didn't grant approval.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("사용자는 이 변경을 승인한 적도 없다. Approval from the user is still required.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user is expected to grant permission tomorrow.", [])).toEqual([]);
    // Review round 4 probes.
    expect(unsupportedApprovalClaims("The user now grants permission to deploy.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user approved the plan to allow retries.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user received explicit written permission to deploy.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user didn\u2019t grant approval.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("The user is planning to grant permission tomorrow.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("Approval from our user was granted.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The system granted the user read access.", [])).toEqual([]);
    expect(unsupportedApprovalClaims("We know user approved the plan.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user approved deployment: “Looks good. Go ahead.”", ["Looks good. Go ahead."])).toEqual([]);
    expect(unsupportedApprovalClaims("The user approved deployment: “Looks good. Go ahead.”", ["something else"])).toHaveLength(1);
  });

  test("log items are redacted before they are clipped and stay within 40 characters", () => {
    const secret = "Q".repeat(32);
    expect(forLog(`User approved Bearer ${secret}`)).not.toContain("QQQQQQ");
    expect(forLog(`${"a".repeat(18)}1234${"b".repeat(19)}`)).not.toContain("aaaaaa");
    expect(forLog(`${"a ".repeat(17)}key=x`).length).toBeLessThanOrEqual(40);
  });

  test("a negation only cancels its own clause", () => {
    expect(unsupportedApprovalClaims("The user rejected plan A but approved plan B.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user approved deployment and rejected rollback.", [])).toHaveLength(1);
    expect(unsupportedApprovalClaims("The user rejected plan A and plan B.", [])).toEqual([]);
  });

  test("a verbatim quote deep inside a very long user message still supports the sentence; emoji do not pad a quote past six characters", () => {
    const long = `${"x".repeat(20_000)} stable branch policy`;
    const h = harness({ branch: [long] });
    h.compact('The user approved "stable branch policy".');
    expect(h.sent).toEqual([]);
    expect(unsupportedApprovalClaims('The user approved "😀😀😀".', ["😀😀😀"])).toHaveLength(1);
  });

  test("the events log is clipped and redacted, and a failing log sink does not lose the advisory", () => {
    const h = harness();
    h.say("write release notes");
    h.compact("The user approved deploying with token abcdefghijklmnopqrstuvwxyz0123456789 right now.");
    expect(JSON.stringify(h.logs)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const loud = harness({
      log: () => {
        throw new Error("sink offline");
      },
    });
    loud.say("write release notes");
    loud.compact("The user approved deleting the branch.");
    expect(loud.sent).toHaveLength(1);
    expect(loud.dispatch("task", { context: "c", tasks: [{ name: "A", task: "other work" }] })).toHaveLength(2);
  });
});

describe("requirement-carry handoff check", () => {
  test("guard lines are not user words: USER_REQUEST alone does not satisfy the check", () => {
    expect(stripGuardLines(paraphrase)).not.toContain(USER);
    expect(stripGuardLines(paraphrase)).toContain("Build the third advisory plugin");
    expect(carriesUserWords(stripGuardLines(paraphrase), [USER])).toBe(false);
    expect(carriesUserWords(stripGuardLines(withQuote), [USER])).toBe(true);
    // The match is verbatim words, so a shared topic word counts as a fragment (known false-negative risk); unrelated text does not.
    expect(carriesUserWords("추후점검항목으로 이야기 없음", ["추후점검항목으로 남길것"])).toBe(true);
    expect(carriesUserWords("완전히 다른 일을 한다", ["추후점검항목으로 남길것"])).toBe(false);
    expect(carriesUserWords("메모: 추후점검항목으로  남길것 이라고 했다", ["추후점검항목으로 남길것"])).toBe(true);
    expect(carriesUserWords("플러그인 만든다", ["플러그인으로 박아둘것을 찾아봐"])).toBe(false);
  });

  test("task dispatch: a brief without user words gets an advisory naming it; a brief with a verbatim fragment does not", () => {
    const h = harness();
    h.say(USER);
    const flagged = h.dispatch("task", { context: "ctx", tasks: [{ name: "A-plugin", task: paraphrase }, { name: "B-plugin", task: withQuote }] });
    expect(flagged).toHaveLength(2);
    expect(flagged[1]).toStartWith("[requirement-carry]");
    expect(flagged[1]).toContain("A-plugin");
    expect(flagged[1]).not.toContain("B-plugin");
    expect(flagged[1]!.length).toBeLessThanOrEqual(600);
    expect(h.dispatch("task", { context: "ctx", tasks: [{ name: "B-plugin", task: withQuote }] })).toEqual(["dispatched"]);
    expect(h.logs).toMatchObject([{ kind: "handoff", main: true, tool: "task", items: ["A-plugin"] }]);
  });

  test("user words in the shared context count; steering words count after a new request resets", () => {
    const h = harness();
    h.say(USER);
    expect(h.dispatch("task", { context: `사용자 원문: ${USER}`, tasks: [{ name: "A", task: paraphrase }] })).toEqual(["dispatched"]);
    h.say("완전히 다른 새 요청입니다 지금부터");
    expect(h.dispatch("task", { context: "x", tasks: [{ name: "A", task: withQuote }] })).toHaveLength(2);
    h.fire("message_start", { message: { role: "user", content: [{ type: "text", text: "그리고 로그 경로도 주입 가능하게 해줘" }] } });
    expect(h.dispatch("task", { context: "x", tasks: [{ name: "C", task: "로그 경로도 주입 가능하게 구현" }] })).toEqual(["dispatched"]);
  });
  test("a repeated task is flagged again, but child sessions and non-Maker agents are not checked", () => {
    const h = harness();
    h.say(USER);
    expect(h.dispatch("task", { context: "c", tasks: [{ name: "A", task: paraphrase }] })).toHaveLength(2);
    // A call that never produced a result (blocked) must not silence its retry.
    h.fire("tool_call", { toolName: "task", toolCallId: "aborted", input: { context: "c", tasks: [{ name: "A", task: paraphrase }] } });
    expect(h.dispatch("task", { context: "c", tasks: [{ name: "A", task: paraphrase }] })).toHaveLength(2);
    expect(h.dispatch("task", { context: "c", tasks: [{ name: "R", agent: "reviewer", task: "look at x" }] })).toEqual(["dispatched"]);
    const child = harness({ sub: true });
    child.say(USER);
    expect(child.dispatch("task", { context: "c", tasks: [{ name: "A", task: paraphrase }] })).toEqual(["dispatched"]);
  });

  test("guard fields after a blank line are still excluded; literal shared context is checked", () => {
    const spread = `TASK_GUARD:\nWORK_CLASS: feature\n\nDONE_WHEN: ${USER}\nDo other work`;
    expect(carriesUserWords(stripGuardLines(spread), [USER])).toBe(false);
    const h = harness();
    h.say(USER);
    expect(h.dispatch("task", { name: "A", task: "other work", context: `Shared context: ${USER}` })).toEqual(["dispatched"]);
  });

  test("steering keeps every earlier input of the request; short requests are judged by whole-input presence", () => {
    const h = harness();
    h.say("retain release notes");
    h.fire("message_start", { message: { role: "user", content: "rotate blue widgets" } });
    for (let i = 0; i < 40; i++) h.fire("message_start", { message: { role: "user", content: `followup number ${i}` } });
    expect(h.dispatch("task", { context: "c", tasks: [{ name: "A", task: "please retain release notes" }, { name: "B", task: "rotate blue widgets now" }] })).toEqual(["dispatched"]);
    const short = harness();
    short.say("번역해");
    const out = short.dispatch("task", { context: "c", tasks: [{ name: "A", task: "Render a chart" }, { name: "B", task: "이 문서를 번역해 주세요" }] });
    expect(out).toHaveLength(2);
    expect(out[1]).toContain("A");
    expect(out[1]).not.toContain("B");
  });

  test("a BOM before a guard field does not let the field satisfy the check", () => {
    expect(carriesUserWords(stripGuardLines("\uFEFFUSER_REQUEST: rotate blue widgets\nDraw a chart"), ["rotate blue widgets"])).toBe(false);
  });

  test("verbatim fragments are word-aligned and never rebuilt from altered punctuation; three short words still count", () => {
    expect(carriesUserWords("fix-cache", ["fix/cache"])).toBe(false);
    expect(carriesUserWords("alpha beta", ["alpha-beta"])).toBe(false);
    expect(carriesUserWords("fix/cache here", ["fix/cache"])).toBe(true);
    expect(carriesUserWords("git rm src", ["Please run git rm src now"])).toBe(true);
    expect(carriesUserWords("git add src", ["Please run git rm src now"])).toBe(false);
  });

  test("a parenthesis in the request is not erased to build a fragment", () => {
    expect(carriesUserWords("use TLS instead", ["use (TLS) now"])).toBe(false);
    expect(carriesUserWords("abc defgh", ["abc (defgh"])).toBe(false);
  });

  test("a request inside another word is not a match, and a comma inside a verbatim fragment still matches", () => {
    expect(carriesUserWords("Document the deployment diagram.", ["deploy"])).toBe(false);
    expect(carriesUserWords("Please deploy it.", ["deploy"])).toBe(true);
    expect(carriesUserWords("Use CI, then report.", ["Run CI, then deploy."])).toBe(true);
  });
});
