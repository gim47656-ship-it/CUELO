import { describe, expect, test } from "bun:test";
import { historyWithout, stoppedTurnLines } from "./useInterpreterCall.ts";

// The turn order of the 2026-10-26 Codex replay where moderation stopped the K4 interpretation.
const before = [
  { id: 0, role: "user", text: "아, 이거 너무 비싸다. 3만 5천 원이라고요?" },
  { id: 1, role: "assistant", text: "Ôi, cái này đắt quá. Ba mươi lăm nghìn won á?" },
];
const stopped = [
  { id: 2, role: "user", text: "와, 진짜 배고파 죽겠다. 여기 뭐가 제일 맛있어" },
  { id: 3, role: "assistant", text: "Trời ơi, đói muốn chết luôn" },
  { id: 4, role: "assistant", text: "." },
];
const lines = (history) => history.map(({ role, text }) => `${role}: ${text}`);

describe("reconnecting after Codex stopped an interpretation", () => {
  test("the stopped turn is the last heard line and everything interpreted after it", () => {
    expect(stoppedTurnLines([...before, ...stopped])).toEqual(stopped);
    expect(stoppedTurnLines([{ id: 0, role: "assistant", text: "Xin chào." }])).toEqual([]);
  });

  test("only the stopped turns' own lines leave the history, never the same words said in other turns", () => {
    const yes = (id) => ({ id, role: "user", text: "네." });
    const ok = (id) => ({ id, role: "assistant", text: "Vâng." });
    // "네." is said and interpreted, then a "네." turn gets stopped, then "네." is said again.
    const firstStop = [yes(12), { id: 13, role: "assistant", text: "Dạ, đói muốn chết" }];
    const atFirstStop = [yes(10), ok(11), ...firstStop];
    const dropped = [...stoppedTurnLines(atFirstStop)];
    expect(lines(historyWithout(atFirstStop, dropped))).toEqual(["user: 네.", "assistant: Vâng."]);

    const secondStop = [{ id: 16, role: "user", text: "배고파 죽겠다" }, { id: 17, role: "assistant", text: "Đói muốn chết" }];
    const atSecondStop = [...atFirstStop, yes(14), ok(15), ...secondStop];
    dropped.push(...stoppedTurnLines(atSecondStop));
    expect(lines(historyWithout([...atSecondStop, yes(18)], dropped))).toEqual([
      "user: 네.", "assistant: Vâng.", "user: 네.", "assistant: Vâng.", "user: 네.",
    ]);
    expect(lines(historyWithout(before, []))).toEqual(lines(before));
  });
});
