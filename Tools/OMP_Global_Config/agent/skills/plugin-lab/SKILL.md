---
name: plugin-lab
description: "Build a trial plugin (a new tool and/or a side panel) for this user's own CUELO profile during a conversation, test it live, and leave promotion to the nightly loop. Open when the user asks for a new tool, a small automation, a custom panel, or says \"make a plugin\", \"플러그인 만들어\", \"도구 하나 만들어 붙여\"."
---

# Plugin Lab

CUELO's Creator Mode. A trial plugin runs only in this user's profile on this PC, with the user's own privileges
(it can read and write whatever the user can). Say so to the user before you write one. Nothing here is reviewed,
committed or deployed: the nightly loop looks at trial plugins that proved useful over several days and promotes them
through review, CI and deployment. Never copy a plugin into the repository or `cuelo-plugins/` yourself.

## Where it lives

- Trial: `~/.omp/agent/plugin-lab/<id>/` (find the exact root with `plugin_lab` `action: "list"`).
- Promoted (written only by the nightly loop): `~/.omp/agent/cuelo-plugins/<id>/`. A promoted id hides the trial copy.
- `<id>` is kebab-case (`a-z`, `0-9`, single dashes) and equals the folder name.

## plugin.json

```json
{
  "id": "word-count",
  "name": "Word count",
  "description": "Counts words in a file and shows the last result in a panel.",
  "createdAt": "2026-11-04T10:00:00.000Z",
  "extension": "index.ts",
  "tools": ["lab_word_count"],
  "panel": "panel.html"
}
```

`extension`, `tools` and `panel` are optional, but `tools` must list exactly the tool names the extension registers:
usage is counted by that list, and the nightly loop judges usefulness from it. Paths are relative, stay inside the
folder, and may not be symlinks that point outside it.

## Extension template

Run `plugin_lab` `action: "inspect"` first and pick tool names nobody uses yet (prefix them `lab_`).
Lab plugins cannot import npm packages at runtime: use `import type` only, and the `pi` API (`pi.zod` for schemas).

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";

export default function wordCount(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool({
    name: "lab_word_count",
    label: "Word count",
    loadMode: "essential", // without this the tool is only reachable through tool search
    description: "Count the words in a text file.",
    parameters: z.object({ path: z.string() }),
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      const { path } = params as { path: string };
      const words = (await readFile(path, "utf8")).split(/\s+/).filter(Boolean).length;
      // Optional: push lines to this plugin's panel (latest lines per session).
      ctx.ui.setWidget("lab:word-count", [`${path}: ${words} words`]);
      return { content: [{ type: "text", text: `${words} words` }] };
    },
  });
}
```

Throwing on load does not break the session: the plugin is skipped and its error shows as its `problem`.

## Panel template

The panel is one HTML file shown in CUELO's side deck inside `<iframe sandbox="allow-scripts">`: inline script and
style only, no network, no storage, no same-origin access. Talk to the host with `postMessage` only.

```html
<!doctype html>
<meta charset="utf-8">
<style>body { font: 13px system-ui; margin: 8px; } pre { white-space: pre-wrap; }</style>
<pre id="out">waiting…</pre>
<button id="ask">Ask the agent to recount</button>
<script>
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === "cuelo-lab:state") {
      document.getElementById("out").textContent = data.lines.join("\n") || "(no result yet)";
    }
  });
  document.getElementById("ask").onclick = () => {
    parent.postMessage({ type: "cuelo-lab:draft", text: "Count the words in README.md again." }, "*");
  };
  parent.postMessage({ type: "cuelo-lab:ready" }, "*");
</script>
```

- Panel → host: `{ type: "cuelo-lab:ready" }`; `{ type: "cuelo-lab:draft", text }` puts `text` (max 4000 characters)
  into the chat input as a draft. The user decides whether to send it; nothing is sent automatically.
- Host → panel: `{ type: "cuelo-lab:state", sessionId, lines }`, where `lines` are the latest
  `ctx.ui.setWidget("lab:<id>", lines)` lines of the current session.

## Loop

1. Tell the user what the plugin will do and that it runs with their privileges on this PC only.
2. Write `plugin.json` and the files under the trial folder.
3. `plugin_lab` `action: "check", id: "<id>"` and fix every listed problem.
4. Ask the user to start a new session or run `/reload` (an idle session restarts in place with the same history).
5. Call the new tool once and show the result. A panel opens from the side deck.
6. Tell the user it is a trial: `plugin_lab` `action: "disable"` turns it off, and the nightly loop proposes promotion
   once it has been used without failures. Deleting a plugin is the user's call.
