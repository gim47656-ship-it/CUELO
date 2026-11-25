import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { jsx, onCleanup, signal } from "@oh-my-pi/pi-tui";
import { normalizeCustomPanelLines, stripAnsi } from "./ansi.ts";
import { AgentSessionWrapper } from "./rpc-manager.ts";

for (const view of ["rows", "JSX"]) {
  test(`${view} custom UI publishes text and relays keys, then clears its web state`, async () => {
    const wrapper = new AgentSessionWrapper({ settings: {}, sessionId: `custom-${view}` }, new EventBus());
    const ui = wrapper.createExtensionUiContext();
    try {
      for (const cancel of [false, true]) {
        const controller = new AbortController();
        const initial = Promise.withResolvers();
        const updated = Promise.withResolvers();
        const frames = [];
        let handle;
        let disposeCount = 0;
        const stop = wrapper.onEvent((event) => {
          if (event.type !== "extension_ui_request" || event.method !== "custom") return;
          frames.push(event);
          if (event.closed) return;
          const text = normalizeCustomPanelLines(event.lines).map(stripAnsi).join("\n");
          if (text === "92x40: waiting") initial.resolve(event);
          if (text === "pressed a") updated.resolve(event);
        });
        try {
          const result = ui.custom((host, theme, keybindings, done) => {
            const { columns, rows } = host.size();
            const initialText = theme.bold(`${columns}x${rows}: waiting`);
            const label = signal(initialText);
            function onKey(key) {
              if (key === "a") label.set("pressed a");
              else if (key === "\r") done(label());
            }
            if (view === "rows") return {
              render: () => [label()],
              handleInput: onKey,
              dispose: () => { disposeCount++; },
            };
            onCleanup(() => { disposeCount++; });
            return jsx("col", {
              onKey(key) {
                onKey(key.raw === "\r" || keybindings.matches(key, "tui.select.confirm") ? "\r" : key.raw);
                return true;
              },
              children: label,
            });
          }, { overlay: true, onHandle: (value) => { handle = value; }, signal: controller.signal });
          const { id } = await initial.promise;
          assert.equal(handle.closed, false);
          await wrapper.send({ type: "extension_ui_input", id, data: "a" });
          const changed = await updated.promise;
          assert.equal(changed.id, id);
          const replay = [];
          wrapper.onEvent((event) => replay.push(event))();
          assert.deepEqual(replay, [changed]);

          if (cancel) {
            const reason = new Error("fixture cancelled");
            const rejected = assert.rejects(result, (error) => error === reason);
            controller.abort(reason);
            await rejected;
          } else {
            await wrapper.send({ type: "extension_ui_input", id, data: "\r" });
            assert.equal(await result, "pressed a");
          }
          assert.equal(handle.closed, true);
          assert.equal(disposeCount, 1);
          assert.deepEqual(frames.filter((frame) => frame.closed), [
            { type: "extension_ui_request", method: "custom", id, lines: [], closed: true },
          ]);
          assert.equal(wrapper.activeCustomUis.size, 0);
          assert.equal(wrapper.pendingUiRequests.size, 0);
        } finally {
          stop();
        }
      }
    } finally {
      wrapper.destroy("custom-ui-test");
    }
  });
}

test("an overlay handle hides the card without settling it when row cleanup throws", async () => {
  const wrapper = new AgentSessionWrapper({ settings: {}, sessionId: "custom-hide" }, new EventBus());
  const opened = Promise.withResolvers();
  const frames = [];
  const stop = wrapper.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.method === "custom") frames.push(event);
  });
  let finish;
  try {
    const result = wrapper.createExtensionUiContext().custom((_host, _theme, _keys, done) => {
      finish = done;
      return {
        render: () => ["overlay"],
        dispose() { throw new Error("fixture cleanup error"); },
      };
    }, { overlay: true, onHandle: opened.resolve });
    const handle = await opened.promise;
    handle.close();
    handle.close();
    assert.equal(handle.closed, true);
    assert.equal(wrapper.pendingUiRequests.size, 0);
    assert.equal(wrapper.activeCustomUis.size, 1);
    finish("done after hide");
    assert.equal(await result, "done after hide");
    assert.equal(wrapper.activeCustomUis.size, 0);
    assert.equal(frames.filter((frame) => frame.closed).length, 1);
  } finally {
    stop();
    wrapper.destroy("custom-ui-test");
  }
});
