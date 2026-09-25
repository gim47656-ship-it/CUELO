import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SubagentArchivePanel } = await jiti.import("./SubagentArchivePanel.tsx");

const client = {
  async getArchive() { return { sessionId: "session", dir: "", found: true, subagents: [] }; },
  async getArchiveTranscript() { return { sessionId: "session", name: "maker", bytes: 0, truncated: false, entries: [] }; },
  async getLiveSnapshots() { return { runtime: "running", subagents: [] }; },
  async getLiveTranscript() { return { fromByte: 0, nextByte: 0, reset: false, entries: [] }; },
};

function renderCard(options = {}) {
  const assignment = options.assignment ?? [
    "TASK_GUARD:",
    "WORK_CLASS: feature",
    "PRIMARY_DELIVERABLE: 카드가 실제 담당업무를 표시한다",
    "OWNED_PATHS: components/workspace/",
    "TASK_TITLE: 서브카드 실제 담당업무 표시",
    "TODO_TASKS: [\"stable title 구현\", \"focused 검증\"]",
  ].join("\n");
  const task = options.task ?? "follow-up hub DM: 검증만 이어서 실행해줘";
  return renderToStaticMarkup(createElement(SubagentArchivePanel, {
    title: "Subagent",
    sessionId: "session",
    sessionPath: "C:/sessions/session.jsonl",
    client,
    liveSubagents: [{
      id: "ProgressVisibility",
      index: 0,
      agent: "maker",
      agentSource: "project",
      status: "running",
      task,
      assignment,
      lastUpdate: 100,
      progress: {
        id: "ProgressVisibility",
        index: 0,
        agent: "maker",
        agentSource: "project",
        status: "running",
        task,
        lastIntent: "focused 검증 실행",
        currentTool: "bash",
        recentTools: [],
        recentOutput: [],
        toolCount: 8,
        requests: 2,
        tokens: 1200,
        cost: 0,
        durationMs: 5000,
      },
    }],
  }));
}

test("카드는 최초 TASK_TITLE과 현재 follow-up 단계를 별도 행으로 표시한다", () => {
  const html = renderCard();
  assert.match(html, /class="subagent-task-line"[^>]*>서브카드 실제 담당업무 표시</);
  assert.match(html, /class="subagent-stage-line"[^>]*>[\s\S]*현재 단계[\s\S]*focused 검증 실행 · bash/);
  assert.doesNotMatch(html, />follow-up hub DM: 검증만 이어서 실행해줘</);
  assert.match(html, /aria-label="[^"]*업무 서브카드 실제 담당업무 표시, 현재 단계 focused 검증 실행 · bash/);
});

test("stable 제목 근거가 없으면 raw guard나 후속 지시 대신 미확인으로 표시한다", () => {
  const html = renderCard({
    assignment: "TASK_GUARD:\nWORK_CLASS: feature\nPRIMARY_DELIVERABLE: TASK_TITLE: guard 가짜\nOWNED_PATHS: components/",
    task: "후속 DM의 긴 실행 지시",
  });
  assert.match(html, /class="subagent-task-line"[^>]*>담당 업무 미확인</);
  assert.doesNotMatch(html, />후속 DM의 긴 실행 지시</);
  assert.doesNotMatch(html, />TASK_GUARD:/);
});
