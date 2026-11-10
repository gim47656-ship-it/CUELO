---
name: plugin-lab
description: "Build a plugin (a new tool and/or a side panel) for this user's own CUELO profile, written straight into the repository's formal plugin folder and shipped in the same turn. Open when the user asks for a new tool, a small automation, a custom panel, or says \"make a plugin\", \"플러그인 만들어\", \"도구 하나 만들어 붙여\"."
---

# Plugin Lab

A plugin runs only in this user's profile on this PC, with the user's own privileges (it can read and
write whatever the user can). Say so to the user before you write one. There is no trial stage: the
plugin is written into the repository and ships in the same turn. It becomes active only once that
deploy has restarted the server.

## Where it lives

- Source: `Tools/OMP_Global_Config/agent/cuelo-plugins/<id>/` in the repository. Write here.
- Installed: the profile sync copies that folder to `~/.omp/agent/cuelo-plugins/<id>/`, which is what
  sessions load. `plugin_lab` `action: "list"` shows the installed root.
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
usage is counted by that list. Paths are relative, stay inside the folder, and may not be symlinks that point
outside it.

## Extension template

Run `plugin_lab` `action: "inspect"` first and pick tool names nobody uses yet (prefix them `lab_`).
An installed plugin cannot resolve packages at runtime: use `import type` only, and the `pi` API (`pi.zod` for schemas).

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

## Ship it in the same turn

1. Tell the user what the plugin will do and that it runs with their privileges.
2. Write `plugin.json` and the files directly under `Tools/OMP_Global_Config/agent/cuelo-plugins/<id>/`.
3. `plugin_lab` `action: "check", id: "<id>"` reads that repository copy; fix every listed problem.
4. Add a focused test under `Tools/OMP_Global_Config/agent/extensions/tests/` for any tool the plugin
   registers, and run it.
5. Bump the patch version, write the CHANGELOG entry in the user's words, run `cross_review`, publish
   with `git_finalize` (`git_integrate` from a `wt/` worktree), watch the public CI run to success and
   then deploy this PC. The repository's standing deploy approval covers harness profile changes, so
   that one needs no further approval; a failed or unobserved CI means no deploy.
6. Do not stop at "written". The turn is done when that deploy has restarted the server, so the plugin
   is active.
7. Call the new tool once and show the result, or open the panel from the side deck.

The user can turn the plugin off from the plugin panel with `plugin_lab` `action: "disable"`, and
deleting it is the user's call.
