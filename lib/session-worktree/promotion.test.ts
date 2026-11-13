import { afterEach, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import type { SessionInfo } from "../types";
import type * as AgentHook from "../../hooks/useAgentSession";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useAgentSession } = await jiti.import<typeof AgentHook>("../../hooks/useAgentSession.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("MAIN-2: an automatically moved session retains its requested project during promotion", async () => {
  for (const effectiveCwd of ["/tmp/main-project", "/tmp/main-project-worktrees/wt-s-20261113-abcd1234"]) {
    const promoted: SessionInfo[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      let result: unknown;
      if (url === "/api/agent/new") result = { sessionId: "created", cwd: effectiveCwd };
      else if (init?.method === "POST") result = { success: true, data: { output: effectiveCwd, exitCode: 0 } };
      else result = { sessionId: "created", context: { messages: [], entryIds: [] }, tree: [], leafId: null };
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const fixture: { hook: { handleSend(message: string): Promise<unknown> } | null } = { hook: null };
    function Harness() {
      fixture.hook = useAgentSession({ session: null, newSessionCwd: "/tmp/main-project", onSessionCreated: (session) => promoted.push(session) });
      return null;
    }
    renderToStaticMarkup(React.createElement(Harness));
    await fixture.hook!.handleSend("!pwd");
    expect(promoted).toHaveLength(1);
    expect(promoted[0].cwd).toBe(effectiveCwd);
    // Mirrors the sidebar's cold-list lookup: cwd changes must not become project changes.
    expect(promoted[0].projectRoot ?? promoted[0].cwd).toBe("/tmp/main-project");
  }
});
