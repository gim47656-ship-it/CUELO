import { describe, expect, test } from "bun:test";
import { extractLeadingCdTarget } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";
import { createErrexitReset, errexitChange, leadingCdEnd, withErrexitReset, WSL_ADVICE } from "../../cuelo-plugins/errexit-reset/index";

function harness(wsl = false) {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  const logs: Record<string, unknown>[] = [];
  const pi = { on: (name: string, fn: Handler) => handlers.set(name, fn) };
  createErrexitReset({ log: (record) => logs.push(record), wsl })(pi as never);
  let id = 0;
  // 코어는 실행 전에 `tool_call`, 끝난 뒤 `tool_result`를 보낸다. 막힌 호출(ran=false)은 결과가 없다.
  const bash = (command: string, options: { session?: string; async?: boolean; ran?: boolean; output?: string } = {}) => {
    const ctx = { sessionManager: { getSessionId: () => options.session ?? "s1" } };
    const toolCallId = `c${++id}`;
    const input = { command, ...(options.async ? { async: true } : {}) };
    const call = handlers.get("tool_call")?.({ toolName: "bash", toolCallId, input }, ctx) as { input?: { command: string } } | undefined;
    const ran = call?.input ?? input;
    if (options.ran === false) return { command: ran.command, result: undefined };
    const result = handlers.get("tool_result")?.(
      { toolName: "bash", toolCallId, input: ran, isError: false, content: [{ type: "text", text: options.output ?? "" }] },
      ctx,
    ) as { additionalContext?: string } | undefined;
    return { command: ran.command, result };
  };
  return { bash, logs };
}

describe("errexit-reset", () => {
  test("a call that leaves set -e on makes only the next call start with set +e", () => {
    const h = harness();
    expect(h.bash("set -euo pipefail; make test").command).toBe("set -euo pipefail; make test");
    expect(h.bash("cp backup.ts a.ts; bun test; cp fixed.ts a.ts").command).toBe("set +e; cp backup.ts a.ts; bun test; cp fixed.ts a.ts");
    expect(h.bash("ls").command).toBe("ls");
    expect(h.logs).toEqual([{ type: "reset", sessionId: "s1" }]);
  });

  test("only a call that starts by turning errexit off proves the shell is clean; anything else that enabled it resets the next call", () => {
    const h = harness();
    h.bash("set -x; echo hi");
    expect(h.bash("ls").command).toBe("ls");
    // 서브셸 안의 `set +e`는 세션 셸을 끄지 않는다.
    h.bash("set -e; (set +e)");
    expect(h.bash("false; echo recovered").command).toBe("set +e; false; echo recovered");
    // 뒤에 둔 `set +e`는 앞 실패에서 멈추면 실행되지 않는다. 글로는 알 수 없으니 다음 호출을 한 번 더 끈다.
    h.bash("set -e; build; set +e");
    expect(h.bash("ls").command).toBe("set +e; ls");
    expect(h.bash("ls").command).toBe("ls");
    h.bash("if [ -n \"$CI\" ]; then set -o errexit; fi");
    expect(h.bash("ls").command).toBe("set +e; ls");
  });

  test("a leading cd target stays first so the core still hoists it", () => {
    const h = harness();
    h.bash("set -e");
    expect(h.bash("cd /repo && bun test").command).toBe("cd /repo && set +e && bun test");
    h.bash("set -e");
    expect(h.bash("cd 'a b'; ls").command).toBe("cd 'a b'; set +e ; ls");
    h.bash("set -e");
    expect(h.bash("cd /tmp 2>/dev/null && ls").command).toBe("set +e; cd /tmp 2>/dev/null && ls");
  });

  test("every command the core hoists keeps the same cd target and remainder after the reset", () => {
    for (const command of ["cd /repo && x", "cd 'a b'; y", 'cd "q\\"x" && z', "cd a\\ b && w", "cd x;y", "cd /tmp\t&&\tls"]) {
      const core = extractLeadingCdTarget(command);
      expect(core).not.toBeNull();
      const revised = extractLeadingCdTarget(withErrexitReset(command));
      expect(revised?.path).toBe(core!.path);
      expect(revised?.separator).toBe(core!.separator);
      expect(revised?.rest).toBe(`set +e ${core!.separator} ${core!.rest}`);
    }
    for (const command of ["cd /tmp 2>/dev/null && ls", "cd x || y", "cd x | y", "cd x;; y", "echo cd x && y"]) {
      expect(extractLeadingCdTarget(command)).toBeNull();
      expect(leadingCdEnd(command)).toBeNull();
    }
  });

  test("background calls and calls run in a busy-shell copy do not touch the session shell state", () => {
    const h = harness();
    h.bash("set -e; long-job", { async: true });
    expect(h.bash("ls").command).toBe("ls");
    h.bash("set -e", { output: "x\nRan in a copy of the busy session shell; changes here won't persist." });
    expect(h.bash("ls").command).toBe("ls");
    h.bash("set -e");
    expect(h.bash("sleep 1", { async: true }).command).toBe("sleep 1");
    expect(h.bash("ls", { output: "Ran in a copy of the busy session shell; changes here won't persist." }).command).toBe("set +e; ls");
    expect(h.bash("ls").command).toBe("set +e; ls");
  });

  test("a reset call blocked before running keeps the next call reset", () => {
    const h = harness();
    h.bash("set -e");
    expect(h.bash("rm -rf x", { ran: false }).command).toBe("set +e; rm -rf x");
    expect(h.bash("ls").command).toBe("set +e; ls");
    expect(h.bash("ls").command).toBe("ls");
  });

  test("sessions keep separate shells", () => {
    const h = harness();
    h.bash("set -e", { session: "main" });
    expect(h.bash("ls", { session: "maker" }).command).toBe("ls");
    expect(h.bash("ls", { session: "main" }).command).toBe("set +e; ls");
  });

  test("on WSL the input is never revised and the leaking call gets one advice", () => {
    const h = harness(true);
    const first = h.bash("set -e; make");
    expect(first.command).toBe("set -e; make");
    expect(first.result?.additionalContext).toBe(WSL_ADVICE);
    const second = h.bash("set -e; make again");
    expect(second.command).toBe("set -e; make again");
    expect(second.result).toBeUndefined();
    h.bash("set +e");
    expect(h.bash("set -e").result?.additionalContext).toBe(WSL_ADVICE);
    expect(h.logs.map((record) => record.type)).toEqual(["advice", "advice"]);
  });

  test("errexit change: plain set arguments are read exactly, anything the shell could reinterpret counts as enabling", () => {
    expect(errexitChange("set -eu")).toEqual({ enables: true, startsOff: false });
    expect(errexitChange("x && set -o errexit -o pipefail")).toEqual({ enables: true, startsOff: false });
    expect(errexitChange("set -e\nrun\nset +e")).toEqual({ enables: true, startsOff: false });
    expect(errexitChange("echo set -e")).toEqual({ enables: true, startsOff: false });
    expect(errexitChange("set +e; run")).toEqual({ enables: false, startsOff: true });
    expect(errexitChange("cd /repo && set +o errexit && run")).toEqual({ enables: false, startsOff: true });
    expect(errexitChange("set +e; set -e; run")).toEqual({ enables: true, startsOff: true });
    for (const plain of ["set -o pipefail", "set -x; echo hi", "echo set -x", "set -- -e", "set -x # -e", "reset -e; asset -e", "cd . && ls ./src"]) {
      expect(errexitChange(plain)).toEqual({ enables: false, startsOff: false });
    }
    // 셸이 따옴표, 확장, 제어문, 읽어 들인 스크립트로 바꿀 수 있는 글은 켜졌을 수 있다고 본다.
    for (const opaque of [
      "set \"-e\"",
      "set -'e'",
      "set -o 'errexit'",
      "set -o err\"exit\"",
      "set $FLAGS",
      "eval 'set -e'; run",
      "eval \"$cmd\"",
      "source ./env.sh && run",
      "if true; then source ./env.sh; fi",
      "builtin source ./env.sh",
      "[ -f env ] && . ./env",
      "set >/dev/null -e",
      "set `printf -- -e`",
      "s\"\"et -e",
      "s\\et -e",
      "set \\\n-e",
      "sou\"\"rce ./env.sh",
      "$'set' -e",
    ]) {
      expect(errexitChange(opaque).enables).toBe(true);
    }
    // 끔은 셸이 글자 그대로 받는 맨 앞 `set +e`, `set +o errexit`만 인정한다.
    expect(errexitChange("set \"'+e'\"").startsOff).toBe(false);
    expect(errexitChange("set '+e'; run").startsOff).toBe(false);
    expect(errexitChange("echo x; set +e").startsOff).toBe(false);
    expect(errexitChange("\r\nset +e").startsOff).toBe(false);
    expect(errexitChange("\nset +e\nrun").startsOff).toBe(true);
    expect(errexitChange("set +e;; echo cleared").startsOff).toBe(false);
    expect(errexitChange("set +e;& echo cleared").startsOff).toBe(false);
  });
});
