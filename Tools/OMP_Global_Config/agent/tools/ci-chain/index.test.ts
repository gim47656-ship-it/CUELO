import { describe, expect, test } from "bun:test";
import factory, {
  matchesRunTitle,
  runCiChain,
  type CiChainParams,
  type CiChainResult,
  type Exec,
  type ExecResult,
} from "./index";

const PRIVATE_REPO = "gim47656-ship-it/CUELO-private";
const PUBLIC_REPO = "gim47656-ship-it/CUELO";
const SHA_A = "09c5ab0ea0950957acd026e6bcc0940f55569ec2";
const SHA_B = "79166f8b5cb402700ff942a0c9d11e4908a48ab6";

function okJson(data: unknown): ExecResult {
  return { code: 0, stdout: JSON.stringify(data) };
}

describe("ci_chain", () => {
  test("matches private runs by headSha and excludes Publish CUELO web release", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      expect(cmd).toBe("gh");
      calls.push(args);
      if (args[0] === "run" && args[1] === "list") {
        return okJson([
          {
            databaseId: 40530805800,
            workflowName: "Publish CUELO web release",
            name: "Publish CUELO web release",
            headSha: SHA_A,
            status: "completed",
            conclusion: "skipped",
            createdAt: "2026-10-27T15:25:20Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40530805800`,
          },
          {
            databaseId: 40530489121,
            workflowName: "CI",
            name: "CI",
            headSha: SHA_A,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T15:23:28Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40530489121`,
          },
          {
            databaseId: 40530489228,
            workflowName: "Publish public mirror",
            name: "Publish public mirror",
            headSha: SHA_A,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T15:23:28Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40530489228`,
          },
        ]);
      }
      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    };

    const res = await runCiChain(
      {
        repo: PRIVATE_REPO,
        sha: SHA_A,
        workflows: ["CI", "Publish public mirror", "Publish CUELO web release"],
      },
      { exec, cwd: "/tmp" },
    );

    expect(res.ok).toBe(true);
    expect(res.legs.map((l) => l.workflow)).toEqual(["CI", "Publish public mirror"]);
    expect(res.legs[0]).toMatchObject({
      repo: PRIVATE_REPO,
      workflow: "CI",
      runId: 40530489121,
      status: "completed",
      conclusion: "success",
      matchedBy: "headSha",
      state: "completed",
    });
    expect(res.legs[1]).toMatchObject({
      repo: PRIVATE_REPO,
      workflow: "Publish public mirror",
      runId: 40530489228,
      status: "completed",
      conclusion: "success",
      matchedBy: "headSha",
      state: "completed",
    });
    expect(calls.length).toBe(1);
  });

  test("derives commit subject when mirror.title is absent and ignores older same-title mirror runs before publish", async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "run" && args[1] === "list" && args.includes(PRIVATE_REPO)) {
        return okJson([
          {
            databaseId: 40526167686,
            workflowName: "CI",
            headSha: SHA_B,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T14:57:26Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40526167686`,
          },
          {
            databaseId: 40526167443,
            workflowName: "Publish public mirror",
            headSha: SHA_B,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T14:57:26Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40526167443`,
          },
        ]);
      }
      if (args[0] === "run" && args[1] === "view" && args[2] === "40526167443" && args.includes("--log")) {
        return {
          code: 0,
          stdout: [
            "Publish to CUELO\tCommit and push\t2026-10-27T14:57:56Z ##[group]Run set -euo pipefail",
            'Publish to CUELO\tCommit and push\t2026-10-27T14:57:56Z   echo "Public tree already matches; nothing to publish."',
            "Publish to CUELO\tCommit and push\t2026-10-27T14:57:56Z ##[endgroup]",
            "Publish to CUELO\tCommit and push\t2026-10-27T14:57:57Z Pushed mirror commit 3a337de",
          ].join("\n"),
        };
      }
      if (args[0] === "api" && args[1] === `repos/${PRIVATE_REPO}/commits/${SHA_B}`) {
        return okJson({
          sha: SHA_B,
          commit: {
            message: "docs: second pass on stale statements\n\nDetailed commit body here.",
          },
        });
      }
      if (args[0] === "run" && args[1] === "list" && args.includes(PUBLIC_REPO)) {
        return okJson([
          {
            databaseId: 40526257528,
            workflowName: "CI",
            displayTitle: "docs: second pass on stale statements",
            headSha: "3a337def47d0fedb7583a64b528c039abd918350",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T14:57:58Z",
            url: `https://github.com/${PUBLIC_REPO}/actions/runs/40526257528`,
          },
          {
            databaseId: 40400000001,
            workflowName: "CI",
            displayTitle: "docs: second pass on stale statements",
            headSha: "1111111111111111111111111111111111111111",
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-10-27T14:00:00Z",
            url: `https://github.com/${PUBLIC_REPO}/actions/runs/40400000001`,
          },
        ]);
      }
      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    };

    const res = await runCiChain(
      {
        repo: PRIVATE_REPO,
        sha: SHA_B,
        workflows: ["CI", "Publish public mirror"],
        mirror: { repo: PUBLIC_REPO, workflows: ["CI"] },
      },
      { exec, cwd: "/tmp" },
    );

    expect(res.ok).toBe(true);
    expect(res.mirrorTitle).toBe("docs: second pass on stale statements");
    expect(res.legs[2]).toMatchObject({
      repo: PUBLIC_REPO,
      workflow: "CI",
      runId: 40526257528,
      status: "completed",
      conclusion: "success",
      matchedBy: "title",
      state: "completed",
    });

    // If only the older pre-publish run exists, it must not match
    const execOnlyOld: Exec = async (cmd, args, opts) => {
      if (args[0] === "run" && args[1] === "list" && args.includes(PUBLIC_REPO)) {
        return okJson([
          {
            databaseId: 40400000001,
            workflowName: "CI",
            displayTitle: "docs: second pass on stale statements",
            headSha: "1111111111111111111111111111111111111111",
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T14:00:00Z",
            url: `https://github.com/${PUBLIC_REPO}/actions/runs/40400000001`,
          },
        ]);
      }
      return exec(cmd, args, opts);
    };

    const oldOnlyRes = await runCiChain(
      {
        repo: PRIVATE_REPO,
        sha: SHA_B,
        workflows: ["CI", "Publish public mirror"],
        mirror: { repo: PUBLIC_REPO, workflows: ["CI"] },
      },
      { exec: execOnlyOld, cwd: "/tmp" },
    );
    expect(oldOnlyRes.legs[2]).toMatchObject({
      repo: PUBLIC_REPO,
      workflow: "CI",
      runId: null,
      matchedBy: "title",
      state: "pending",
    });
  });

  test("marks mirror legs skipped-no-public-change when Publish public mirror log says nothing to publish", async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "run" && args[1] === "list" && args.includes(PRIVATE_REPO)) {
        return okJson([
          {
            databaseId: 40530489121,
            workflowName: "CI",
            headSha: SHA_A,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T15:23:28Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40530489121`,
          },
          {
            databaseId: 40530489228,
            workflowName: "Publish public mirror",
            headSha: SHA_A,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T15:23:28Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40530489228`,
          },
        ]);
      }
      if (args[0] === "run" && args[1] === "view" && args[2] === "40530489228" && args.includes("--log")) {
        return {
          code: 0,
          stdout: "Publish to CUELO\tCommit and push\t2026-10-27T15:24:01Z Public tree already matches; nothing to publish.\n",
        };
      }
      throw new Error(`Should not query mirror runs when skipped: ${args.join(" ")}`);
    };

    const res = await runCiChain(
      {
        repo: PRIVATE_REPO,
        sha: SHA_A,
        workflows: ["CI", "Publish public mirror"],
        mirror: { repo: PUBLIC_REPO, workflows: ["CI"] },
      },
      { exec, cwd: "/tmp" },
    );

    expect(res.ok).toBe(true);
    expect(res.legs[2]).toMatchObject({
      repo: PUBLIC_REPO,
      workflow: "CI",
      runId: null,
      status: null,
      conclusion: null,
      matchedBy: "title",
      state: "skipped-no-public-change",
    });
  });

  test("returns pending for [] on snapshot and not-found-within-bound when waitSeconds expires", async () => {
    let clock = 1_000_000;
    const sleepCalls: number[] = [];
    const exec: Exec = async () => okJson([]);

    const snapshot = await runCiChain(
      { repo: PRIVATE_REPO, sha: SHA_A, workflows: ["CI"], waitSeconds: 0 },
      { exec, cwd: "/tmp" },
    );
    expect(snapshot.ok).toBe(false);
    expect(snapshot.polls).toBe(1);
    expect(snapshot.legs[0]?.state).toBe("pending");

    const bounded = await runCiChain(
      { repo: PRIVATE_REPO, sha: SHA_A, workflows: ["CI"], waitSeconds: 30, pollSeconds: 15 },
      {
        exec,
        cwd: "/tmp",
        now: () => clock,
        sleep: async (ms) => {
          sleepCalls.push(ms);
          clock += ms;
        },
      },
    );
    expect(bounded.ok).toBe(false);
    expect(bounded.polls).toBe(3);
    expect(sleepCalls).toEqual([15_000, 15_000]);
    expect(bounded.legs[0]?.state).toBe("not-found-within-bound");
  });

  test("treats gh non-zero exit, empty stdout, and unparsable JSON as explicit error, never pending", async () => {
    const nonZero = await runCiChain(
      { repo: PRIVATE_REPO, sha: SHA_A, workflows: ["CI"] },
      {
        exec: async () => ({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" }),
        cwd: "/tmp",
      },
    );
    expect(nonZero.legs[0]?.state).toBe("error");
    expect(nonZero.legs[0]?.error).toContain("gh exited 1");

    const emptyOut = await runCiChain(
      { repo: PRIVATE_REPO, sha: SHA_A, workflows: ["CI"] },
      {
        exec: async () => ({ code: 0, stdout: "   \n  " }),
        cwd: "/tmp",
      },
    );
    expect(emptyOut.legs[0]?.state).toBe("error");
    expect(emptyOut.legs[0]?.error).toContain("empty stdout");

    const badJson = await runCiChain(
      { repo: PRIVATE_REPO, sha: SHA_A, workflows: ["CI"] },
      {
        exec: async () => ({ code: 0, stdout: "{not-valid-json" }),
        cwd: "/tmp",
      },
    );
    expect(badJson.legs[0]?.state).toBe("error");
    expect(badJson.legs[0]?.error).toContain("unparsable JSON");
  });

  test("populates failedJobs and last 40 lines of logTail on failed runs and preserves cancelled conclusion", async () => {
    const fiftyFiveLines = Array.from(
      { length: 55 },
      (_, i) => `Publish to CUELO\tRefuse personal or secret content\tline-${i + 1}`,
    ).join("\n");

    const exec: Exec = async (_cmd, args) => {
      if (args[0] === "run" && args[1] === "list") {
        return okJson([
          {
            databaseId: 40149932501,
            workflowName: "Publish public mirror",
            headSha: SHA_A,
            status: "completed",
            conclusion: "failure",
            createdAt: "2026-10-25T01:15:36Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40149932501`,
          },
          {
            databaseId: 40149932427,
            workflowName: "CI",
            headSha: SHA_A,
            status: "completed",
            conclusion: "cancelled",
            createdAt: "2026-10-25T01:15:36Z",
            url: `https://github.com/${PRIVATE_REPO}/actions/runs/40149932427`,
          },
        ]);
      }
      if (args[0] === "run" && args[1] === "view" && args[2] === "40149932501" && args.includes("--json")) {
        return okJson({
          jobs: [
            { databaseId: 121039127578, name: "Publish to CUELO", status: "completed", conclusion: "failure" },
            { databaseId: 121039127579, name: "Aux job", status: "completed", conclusion: "success" },
          ],
        });
      }
      if (args[0] === "run" && args[1] === "view" && args[2] === "40149932501" && args.includes("--log-failed")) {
        return { code: 0, stdout: `${fiftyFiveLines}\n` };
      }
      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    };

    const res = await runCiChain(
      { repo: PRIVATE_REPO, sha: SHA_A, workflows: ["CI", "Publish public mirror"] },
      { exec, cwd: "/tmp" },
    );

    expect(res.ok).toBe(false);
    expect(res.legs[0]).toMatchObject({
      workflow: "CI",
      runId: 40149932427,
      state: "completed",
      conclusion: "cancelled",
    });
    expect(res.legs[0]?.failedJobs).toBeUndefined();

    expect(res.legs[1]).toMatchObject({
      workflow: "Publish public mirror",
      runId: 40149932501,
      state: "completed",
      conclusion: "failure",
      failedJobs: ["Publish to CUELO"],
    });
    expect(res.legs[1]?.logTail?.length).toBe(40);
    expect(res.legs[1]?.logTail?.[0]).toEndWith("line-16");
    expect(res.legs[1]?.logTail?.[39]).toEndWith("line-55");
  });

  test("matches GitHub ellipsis-truncated displayTitle and routes CustomToolFactory execute through pi.exec", async () => {
    expect(
      matchesRunTitle(
        "feat(translator): partner gender/age setting, fixed Vietnamese addres…",
        "feat(translator): partner gender/age setting, fixed Vietnamese address pair, transcript spacing fix (0.10.78)",
      ),
    ).toBe(true);
    expect(matchesRunTitle("docs: fix A", "docs: fix B")).toBe(false);

    const recorded: string[] = [];
    const fakePi = {
      cwd: "/tmp",
      zod: {
        object: (shape: unknown) => ({ shape, describe: () => ({}), optional: () => ({ shape, describe: () => ({}) }) }),
        string: () => ({ describe: () => ({}), optional: () => ({ describe: () => ({}) }) }),
        number: () => ({ optional: () => ({ describe: () => ({}) }) }),
        array: () => ({ describe: () => ({}) }),
      },
      exec: async (command: string, args: string[]) => {
        recorded.push([command, ...args].join(" "));
        return okJson([
          {
            databaseId: 40530489121,
            workflowName: "CI",
            headSha: SHA_A,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-10-27T15:23:28Z",
          },
        ]);
      },
    } as unknown as Parameters<typeof factory>[0];

    const tool = await factory(fakePi);
    expect(tool.name).toBe("ci_chain");
    const out = await tool.execute(
      "call-1",
      { repo: PRIVATE_REPO, sha: SHA_A, workflows: ["CI"] } satisfies CiChainParams,
      undefined,
      {} as unknown as Parameters<typeof tool.execute>[3],
      undefined,
    );
    expect(recorded.length).toBe(1);
    expect(recorded[0]).toStartWith("gh run list --repo gim47656-ship-it/CUELO-private --commit");
    const details = out.details as CiChainResult;
    expect(details.ok).toBe(true);
    const firstBlock = out.content[0] as { type: string; text?: string } | undefined;
    expect(firstBlock?.type).toBe("text");
    expect(firstBlock?.text).toContain("ci_chain ok");
  });
});

describe("ci_chain publish and failure logs", () => {
  const SHA_OLD = "c718a7a1fd667b968abaa1a6457dc66104d55f33";
  const publishRun = (conclusion: string) => ({
    databaseId: 40314813219, workflowName: "Publish public mirror", headSha: SHA_OLD, status: "completed", conclusion,
    createdAt: "2026-10-26T11:24:18Z", url: `https://github.com/${PRIVATE_REPO}/actions/runs/40314813219`,
  });
  const params: CiChainParams = {
    repo: PRIVATE_REPO, sha: SHA_OLD, workflows: ["Publish public mirror"],
    mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" },
  } as CiChainParams;
  const noSleep = async () => { throw new Error("must not wait"); };
  function route(handlers: { log?: ExecResult; jobLog?: ExecResult; mirrorRuns?: unknown[]; conclusion?: string }) {
    const calls: string[] = [];
    const exec: Exec = async (_cmd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "run" && args[1] === "list" && args.includes(PRIVATE_REPO)) return okJson([publishRun(handlers.conclusion ?? "success")]);
      if (args[0] === "run" && args[1] === "list" && args.includes(PUBLIC_REPO)) return okJson(handlers.mirrorRuns ?? []);
      if (args[0] === "run" && args[1] === "view" && args.includes("--log")) return handlers.log ?? { code: 0, stdout: "" };
      if (args[0] === "run" && args[1] === "view" && args.includes("jobs")) return okJson({ jobs: [{ databaseId: 121, name: "Publish to CUELO", conclusion: handlers.conclusion ?? "success" }] });
      if (args[0] === "run" && args[1] === "view" && args.includes("--log-failed")) return { code: 0, stdout: "" };
      if (args[0] === "api" && args[1] === "repos/gim47656-ship-it/CUELO-private/actions/jobs/121/logs") return handlers.jobLog ?? { code: 1, stdout: "", stderr: "HTTP 410" };
      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    };
    return { exec, calls };
  }

  test("an old run whose --log is empty is read through the job log and reported as no public change", async () => {
    const { exec, calls } = route({ jobLog: { code: 0, stdout: "2026-10-26T11:25:01Z Public tree already matches; nothing to publish.\n" } });
    const res = await runCiChain(params, { exec, cwd: "/tmp" });
    expect(res.legs[1]).toMatchObject({ repo: PUBLIC_REPO, state: "skipped-no-public-change" });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.startsWith("run list") && c.split(" ").includes(PUBLIC_REPO))).toBe(false);
  });

  test("a job log that only echoes the script line is a public change, so the mirror is still looked for", async () => {
    const echoed = '##[group]Run echo "Public tree already matches; nothing to publish."\n  shell: /usr/bin/bash -e {0}\n##[endgroup]\n2026-10-26T11:25:01Z pushed 1a2b3c\n';
    const { exec } = route({ jobLog: { code: 0, stdout: echoed } });
    const res = await runCiChain(params, { exec, cwd: "/tmp" });
    expect(res.legs[1]).toMatchObject({ repo: PUBLIC_REPO, state: "pending" });
  });

  test("an unreadable publish log is an error, not a guess", async () => {
    const exitOne = await runCiChain(params, { exec: route({ log: { code: 1, stdout: "", stderr: "HTTP 502" } }).exec, cwd: "/tmp" });
    expect(exitOne.legs[1]).toMatchObject({ state: "error", error: expect.stringContaining("HTTP 502") });
    const noJobLog = await runCiChain(params, { exec: route({}).exec, cwd: "/tmp" });
    expect(noJobLog.legs[1]).toMatchObject({ state: "error", error: expect.stringContaining("job 121") });
    expect(noJobLog.ok).toBe(false);
  });

  test("a failed publish ends the mirror legs at once instead of waiting out the bound", async () => {
    const { exec } = route({ conclusion: "failure", jobLog: { code: 0, stdout: "line\n".repeat(50) + "Refusing to publish\n" } });
    const res = await runCiChain({ ...params, waitSeconds: 60, pollSeconds: 1 } as CiChainParams, { exec, cwd: "/tmp", sleep: noSleep });
    expect(res.legs[1]).toMatchObject({ state: "error", error: expect.stringContaining("concluded failure") });
    expect(res.legs[0].logTail).toHaveLength(40);
    expect(res.legs[0].logTail?.at(-1)).toBe("Refusing to publish");
  });

  test("a failed run whose log cannot be fetched says so on the leg", async () => {
    const { exec } = route({ conclusion: "failure" });
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_OLD, workflows: ["Publish public mirror"] } as CiChainParams, { exec, cwd: "/tmp" });
    expect(res.legs[0]).toMatchObject({ state: "completed", conclusion: "failure", logTail: [], error: expect.stringContaining("exit 1") });
  });
});

describe("ci_chain review findings", () => {
  const PUB = { databaseId: 501, workflowName: "Publish public mirror", headSha: SHA_B, status: "completed", conclusion: "success", createdAt: "2026-10-27T14:57:26Z", updatedAt: "2026-10-27T14:58:00Z" };
  const CI_FAIL = { databaseId: 502, workflowName: "CI", headSha: SHA_B, status: "completed", conclusion: "failure", createdAt: "2026-10-27T14:57:26Z", updatedAt: "2026-10-27T15:00:00Z" };
  const PUSHED_LOG = { code: 0, stdout: "##[group]Run set -euo pipefail\n  echo -n 'nothing to publish'\n  printf 'nothing to publish'\n##[endgroup]\nPushed mirror commit 3a337de\n" };
  type Handler = (args: string[], options: { timeout?: number }) => ExecResult | undefined;
  function exec(...handlers: Handler[]): { exec: Exec; calls: string[][]; timeouts: (number | undefined)[] } {
    const calls: string[][] = [];
    const timeouts: (number | undefined)[] = [];
    return {
      calls,
      timeouts,
      exec: async (_cmd, args, options) => {
        calls.push(args);
        timeouts.push(options.timeout);
        for (const handler of handlers) {
          const result = handler(args, options);
          if (result) return result;
        }
        throw new Error(`Unexpected gh args: ${args.join(" ")}`);
      },
    };
  }
  const privateRuns = (runs: unknown[]): Handler => (args) => (args[1] === "list" && args.includes(PRIVATE_REPO) ? okJson(runs) : undefined);
  const mirrorRuns = (runs: unknown[]): Handler => (args) => (args[1] === "list" && args.includes(PUBLIC_REPO) ? okJson(runs) : undefined);
  const publishLog = (result: ExecResult): Handler => (args) => (args[1] === "view" && args.includes("--log") ? result : undefined);
  const mirrorRun = (title: string, createdAt: string, id = 601) => ({ databaseId: id, workflowName: "CI", displayTitle: title, headSha: "3a337def47d0fedb7583a64b528c039abd918350", status: "completed", conclusion: "success", createdAt, updatedAt: createdAt });

  test("a failed abbreviated-SHA lookup is an error, not missing runs", async () => {
    const { exec: e } = exec(privateRuns([]), (args) => (args[0] === "api" ? { code: 1, stdout: "", stderr: "HTTP 502" } : undefined));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: "79166f8", workflows: ["CI"] } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[0]).toMatchObject({ state: "error", error: expect.stringContaining("HTTP 502") });
  });

  test("without the private publish run no mirror run is matched, even a same-title one", async () => {
    const { exec: e, calls } = exec(privateRuns([]), mirrorRuns([mirrorRun("docs: note", "2026-10-20T00:00:00Z")]));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[1]).toMatchObject({ repo: PUBLIC_REPO, runId: null, state: "pending" });
    expect(calls.some((args) => args.includes(PUBLIC_REPO))).toBe(false);
  });

  test("mirror runs are listed per workflow from the publish time, and only a run at or after it matches", async () => {
    const { exec: e, calls } = exec(privateRuns([PUB]), publishLog(PUSHED_LOG), mirrorRuns([mirrorRun("docs: note", "2026-10-27T14:00:00Z", 600), mirrorRun("docs: note", "2026-10-27T14:57:58Z", 601)]));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[1]).toMatchObject({ runId: 601, state: "completed" });
    const mirrorList = calls.find((args) => args.includes(PUBLIC_REPO))!;
    expect(mirrorList.slice(mirrorList.indexOf("--workflow"), mirrorList.indexOf("--workflow") + 2)).toEqual(["--workflow", "CI"]);
    expect(mirrorList[mirrorList.indexOf("--created") + 1]).toBe(">=2026-10-27T14:57:26Z");
  });

  test("script source inside the Run group (echo -n, printf) is not taken as nothing-to-publish output", async () => {
    const { exec: e } = exec(privateRuns([PUB]), publishLog(PUSHED_LOG), mirrorRuns([]));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[1].state).toBe("pending");
  });

  test("a run record without identity is an error rather than a matched leg", async () => {
    const { exec: e } = exec(privateRuns([{ workflowName: "CI", status: "completed", conclusion: "success" }]));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI"] } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[0]).toMatchObject({ state: "error", runId: null, error: expect.stringContaining("lacks") });
    expect(res.ok).toBe(false);
  });

  test("only GitHub's 70-character truncation is a prefix match", () => {
    const subject = "harness: wait up to 20 s for the advisory reviewer after required reviewers finish";
    expect(matchesRunTitle(`${subject.slice(0, 69)}…`, subject)).toBe(true);
    expect(matchesRunTitle("docs: investigate regression", "docs: investigate…")).toBe(false);
    expect(matchesRunTitle("docs: investigate…", "docs: investigate regression")).toBe(false);
  });

  test("an old failed run's tail joins every failed job's log, and lookup failures are reported", async () => {
    const jobs: Handler = (args) => (args.includes("jobs") ? okJson({ jobs: [{ databaseId: 1, name: "a", conclusion: "failure" }, { databaseId: 2, name: "b", conclusion: "failure" }] }) : undefined);
    const logs: Handler = (args) => {
      if (args.includes("--log-failed")) return { code: 0, stdout: "" };
      if (args[1]?.endsWith("/jobs/1/logs")) return { code: 0, stdout: "a1\na2\n" };
      if (args[1]?.endsWith("/jobs/2/logs")) return { code: 0, stdout: "b1\nb2\n" };
      return undefined;
    };
    const ok = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI"] } as CiChainParams, { exec: exec(privateRuns([CI_FAIL]), jobs, logs).exec, cwd: "/tmp" });
    expect(ok.legs[0]).toMatchObject({ failedJobs: ["a", "b"], logTail: ["a1", "a2", "b1", "b2"] });
    expect(ok.legs[0].error).toBeUndefined();

    const badJobs: Handler = (args) => (args.includes("jobs") ? { code: 1, stdout: "", stderr: "HTTP 500" } : undefined);
    const failed = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI"] } as CiChainParams, { exec: exec(privateRuns([CI_FAIL]), badJobs, (args) => (args.includes("--log-failed") ? { code: 0, stdout: "CI\tstep\tboom\n" } : undefined)).exec, cwd: "/tmp" });
    expect(failed.legs[0]).toMatchObject({ logTail: ["CI\tstep\tboom"], error: expect.stringContaining("HTTP 500") });
  });

  test("one unreadable publish job does not hide another job's nothing-to-publish line", async () => {
    const jobs: Handler = (args) => (args.includes("jobs") ? okJson({ jobs: [{ databaseId: 1 }, { databaseId: 2 }] }) : undefined);
    const logs: Handler = (args) => (args[1]?.endsWith("/jobs/1/logs") ? { code: 1, stdout: "" } : args[1]?.endsWith("/jobs/2/logs") ? { code: 0, stdout: "Public tree already matches; nothing to publish.\n" } : undefined);
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: exec(privateRuns([PUB]), publishLog({ code: 0, stdout: "" }), jobs, logs).exec, cwd: "/tmp" });
    expect(res.legs[1].state).toBe("skipped-no-public-change");
  });

  test("a rerun of the same run id is looked up again instead of served from the earlier attempt", async () => {
    let attempt = 1;
    const run = () => ({ ...CI_FAIL, updatedAt: `2026-10-27T15:0${attempt}:00Z` });
    const handlers: Handler[] = [
      (args) => (args[1] === "list" ? okJson([run()]) : undefined),
      (args) => (args.includes("jobs") ? okJson({ jobs: [{ databaseId: 9, name: "CI", conclusion: "failure" }] }) : undefined),
      (args) => (args.includes("--log-failed") ? { code: 0, stdout: `CI\tstep\tattempt ${attempt}\n` } : undefined),
    ];
    const { exec: e } = exec(...handlers);
    const sleep = async () => { attempt = 2; };
    let now = 0;
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI", "Publish public mirror"], waitSeconds: 1, pollSeconds: 1 } as CiChainParams, { exec: e, cwd: "/tmp", sleep, now: () => (now += 400) });
    expect(res.legs[0].logTail).toEqual(["CI\tstep\tattempt 2"]);
  });

  test("every gh call is bounded by a timeout", async () => {
    const { exec: e, timeouts } = exec(privateRuns([PUB]));
    await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"] } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((t) => typeof t === "number" && t > 0)).toBe(true);
  });

  test("a job-log exec that throws does not stop the other jobs from being read", async () => {
    const jobs: Handler = (args) => (args.includes("jobs") ? okJson({ jobs: [{ databaseId: 1, name: "a", conclusion: "failure" }, { databaseId: 2, name: "b", conclusion: "failure" }] }) : undefined);
    const logs: Handler = (args) => {
      if (args[1]?.endsWith("/jobs/1/logs")) throw new Error("boom");
      if (args[1]?.endsWith("/jobs/2/logs")) return { code: 0, stdout: "Public tree already matches; nothing to publish.\nb2\n" };
      if (args.includes("--log-failed") || args.includes("--log")) return { code: 0, stdout: "" };
      return undefined;
    };
    const publish = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: exec(privateRuns([PUB]), jobs, logs).exec, cwd: "/tmp" });
    expect(publish.legs[1].state).toBe("skipped-no-public-change");
    const failed = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI"] } as CiChainParams, { exec: exec(privateRuns([CI_FAIL]), jobs, logs).exec, cwd: "/tmp" });
    expect(failed.legs[0]).toMatchObject({ logTail: ["Public tree already matches; nothing to publish.", "b2"], error: expect.stringContaining("boom") });
  });

  test("a record whose id is not databaseId is still rejected", async () => {
    const { exec: e } = exec(privateRuns([{ id: 7, workflowName: "CI", headSha: SHA_B, status: "completed", conclusion: "success", createdAt: "2026-10-27T14:57:26Z" }]));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI"] } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[0].state).toBe("error");
  });

  test("the earliest same-title mirror run after publish wins over a later commit's run with the same subject", async () => {
    const { exec: e } = exec(privateRuns([PUB]), publishLog(PUSHED_LOG), mirrorRuns([mirrorRun("docs: note", "2026-10-27T16:00:00Z", 700), mirrorRun("docs: note", "2026-10-27T14:57:58Z", 601)]));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[1].runId).toBe(601);
  });

  test("a full mirror page without a match is an error, not pending", async () => {
    const page = Array.from({ length: 100 }, (_, i) => mirrorRun(`other ${i}`, "2026-10-27T15:00:00Z", 800 + i));
    const { exec: e } = exec(privateRuns([PUB]), publishLog(PUSHED_LOG), mirrorRuns(page));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[1]).toMatchObject({ state: "error", error: expect.stringContaining("past the page") });
  });

  test("a nameless startup_failure run on the same commit does not break the list", async () => {
    const nameless = { databaseId: 499, workflowName: "", headSha: SHA_B, status: "completed", conclusion: "startup_failure", createdAt: "2026-10-27T14:50:00Z" };
    const { exec: e } = exec(privateRuns([nameless, PUB]), publishLog(PUSHED_LOG));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"] } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[0]).toMatchObject({ runId: 501, state: "completed" });
  });

  test("a full mirror page is an error even when a later same-title run is on it", async () => {
    const page = [mirrorRun("docs: note", "2026-10-27T16:00:00Z", 700), ...Array.from({ length: 99 }, (_, i) => mirrorRun(`other ${i}`, "2026-10-27T15:00:00Z", 800 + i))];
    const { exec: e } = exec(privateRuns([PUB]), publishLog(PUSHED_LOG), mirrorRuns(page));
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: e, cwd: "/tmp" });
    expect(res.legs[1]).toMatchObject({ runId: null, state: "error" });
  });

  test("job-log reads in both fallbacks carry the gh timeout", async () => {
    const jobs: Handler = (args) => (args.includes("jobs") ? okJson({ jobs: [{ databaseId: 1, name: "a", conclusion: "failure" }] }) : undefined);
    const logs: Handler = (args) => (args.includes("--log-failed") || args.includes("--log") ? { code: 0, stdout: "" } : args[1]?.endsWith("/jobs/1/logs") ? { code: 0, stdout: "x\n" } : undefined);
    const { exec: e, calls, timeouts } = exec(privateRuns([PUB, { ...CI_FAIL }]), jobs, logs, mirrorRuns([]));
    await runCiChain({ repo: PRIVATE_REPO, sha: SHA_B, workflows: ["CI", "Publish public mirror"], mirror: { repo: PUBLIC_REPO, workflows: ["CI"], title: "docs: note" } } as CiChainParams, { exec: e, cwd: "/tmp" });
    const jobLogCalls = calls.flatMap((args, i) => (args[1]?.endsWith("/logs") ? [timeouts[i]] : []));
    expect(jobLogCalls.length).toBe(2);
    expect(jobLogCalls.every((t) => typeof t === "number" && t > 0)).toBe(true);
  });
});

describe("ci_chain pushes skipped by a workflow path filter", () => {
  const SHA_P = "d".repeat(40); // the pushed tip, which has no run
  const SHA_Q = "e".repeat(40); // its parent
  const SHA_R = "f".repeat(40); // the parent's parent
  const CI_YAML = `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\n    paths-ignore:\n      - "doc/**"\n      - HANDOFF.md\n`;
  const PUBLISH_YAML = `name: Publish public mirror\non:\n  push:\n    branches: [main]\n    paths:\n      - "**"\n      - "!doc/**"\n      - "!HANDOFF.md"\n      - "!Tools/**"\n`;
  const NO_FILTER_YAML = `name: CI\non:\n  push:\n    branches: [main]\n`;
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const run = (workflowName: string, headSha: string) => ({ databaseId: 7, workflowName, headSha, status: "completed", conclusion: "success", createdAt: "2026-10-28T01:00:00Z", url: "u" });

  type Commit = { files: string[]; parent?: string; parents?: number };
  /**
   * Fake gh for one repository. `commits` is the history by sha; `runs` lists which commits have a run of which workflow
   * (`sha -> workflow names`). By default the tip is doc-only and its parent Q is an earlier push's tip that has runs.
   */
  function route(options: { commits?: Record<string, Commit>; runs?: Record<string, string[]>; ciYaml?: string; commitFails?: boolean; listing?: unknown }) {
    const commits = options.commits ?? { [SHA_P]: { files: ["doc/a.md", "HANDOFF.md"], parent: SHA_Q } };
    const runs = options.runs ?? { [SHA_Q]: ["CI", "Publish public mirror"] };
    const calls: string[] = [];
    const exec: Exec = async (_cmd, args) => {
      calls.push(args.join(" "));
      if (args[0] === "run" && args[1] === "list") {
        const sha = args[args.indexOf("--commit") + 1];
        return okJson((runs[sha] ?? []).map((name) => run(name, sha)));
      }
      const commit = Object.entries(commits).find(([sha]) => args[1] === `repos/${PRIVATE_REPO}/commits/${sha}`);
      if (args[0] === "api" && commit) {
        if (options.commitFails) return { code: 1, stdout: "", stderr: "HTTP 502" };
        const [sha, { files, parent, parents }] = commit;
        const parentShas = Array.from({ length: parents ?? 1 }, (_, i) => (i === 0 && parent ? parent : "9".repeat(40)));
        return okJson({ sha, parents: parentShas.map((p) => ({ sha: p })), files: files.map((filename) => ({ filename })), commit: { message: "docs: record" } });
      }
      if (args[0] === "api" && args[1] === `repos/${PRIVATE_REPO}/actions/workflows?per_page=100`) {
        return okJson(options.listing ?? { total_count: 2, workflows: [{ name: "CI", path: ".github/workflows/ci.yml" }, { name: "Publish public mirror", path: ".github/workflows/publish-public.yml" }] });
      }
      if (args[0] === "api" && args[1] === `repos/${PRIVATE_REPO}/contents/.github/workflows/ci.yml?ref=${SHA_P}`) return okJson({ encoding: "base64", content: b64(options.ciYaml ?? CI_YAML) });
      if (args[0] === "api" && args[1] === `repos/${PRIVATE_REPO}/contents/.github/workflows/publish-public.yml?ref=${SHA_P}`) return okJson({ encoding: "base64", content: b64(PUBLISH_YAML) });
      throw new Error(`Unexpected gh args: ${args.join(" ")}`);
    };
    return { exec, calls };
  }
  const params: CiChainParams = {
    repo: PRIVATE_REPO, sha: SHA_P, workflows: ["CI", "Publish public mirror"],
    mirror: { repo: PUBLIC_REPO, workflows: ["CI"] }, waitSeconds: 600,
  } as CiChainParams;
  const single = { ...params, workflows: ["CI"], mirror: undefined, waitSeconds: 0 } as CiChainParams;
  const mustNotWait = async () => { throw new Error("a skipped push must not be waited on"); };

  test("a commit whose files are all filtered out, on top of an earlier push's tip, ends every leg at once instead of waiting out the bound", async () => {
    const { exec } = route({});
    const res = await runCiChain(params, { exec, cwd: "/tmp", sleep: mustNotWait });
    expect(res.ok).toBe(true);
    expect(res.polls).toBe(1);
    expect(res.legs.map((leg) => [leg.repo, leg.workflow, leg.state, leg.runId])).toEqual([
      [PRIVATE_REPO, "CI", "skipped-paths-ignored", null],
      [PRIVATE_REPO, "Publish public mirror", "skipped-paths-ignored", null],
      [PUBLIC_REPO, "CI", "skipped-paths-ignored", null],
    ]);
    expect(res.verdict).toContain("CI=skipped-paths-ignored");
  });

  test("each workflow is judged by its own filter: a file only the publish filter drops still leaves CI pending", async () => {
    const { exec } = route({ commits: { [SHA_P]: { files: ["Tools/CUELO_Setup/README.md"], parent: SHA_Q } } });
    const res = await runCiChain({ ...params, waitSeconds: 0 }, { exec, cwd: "/tmp" });
    expect(res.legs.map((leg) => [leg.workflow, leg.state])).toEqual([
      ["CI", "pending"],
      ["Publish public mirror", "skipped-paths-ignored"],
      ["CI", "skipped-paths-ignored"],
    ]);
    expect(res.ok).toBe(false);
  });

  test("a file the filter lets through is a run that has not appeared yet, so the wait still times out as not-found", async () => {
    const { exec, calls } = route({ commits: { [SHA_P]: { files: ["doc/a.md", "lib/rpc-manager.ts"], parent: SHA_Q } } });
    let clock = 0;
    const res = await runCiChain(
      { ...single, waitSeconds: 30, pollSeconds: 15 },
      { exec, cwd: "/tmp", now: () => clock, sleep: async (ms) => { clock += ms; } },
    );
    expect(res.legs[0]?.state).toBe("not-found-within-bound");
    // Three polls, one lookup each of the workflow list, the workflow file and the commit.
    expect(calls.filter((call) => call.includes("/contents/") || call.includes("/commits/") || call.includes("actions/workflows")).length).toBe(3);
  });

  test("a doc-only tip pushed together with a code commit is not skipped: the diff of the whole push needs a run", async () => {
    // SHA_Q changed code and has no run yet (it is not an earlier push's tip); SHA_P only changed docs.
    const { exec } = route({
      commits: { [SHA_P]: { files: ["doc/a.md"], parent: SHA_Q }, [SHA_Q]: { files: ["lib/a.ts"], parent: SHA_R } },
      runs: { [SHA_R]: ["CI"] },
    });
    const res = await runCiChain(single, { exec, cwd: "/tmp" });
    expect(res.legs[0]?.state).toBe("pending");
    expect(res.ok).toBe(false);
  });

  test("several doc-only commits pushed together are skipped, and so are doc-only pushes stacked on one another", async () => {
    const { exec } = route({
      commits: { [SHA_P]: { files: ["doc/a.md"], parent: SHA_Q }, [SHA_Q]: { files: ["HANDOFF.md"], parent: SHA_R } },
      runs: { [SHA_R]: ["CI"] },
    });
    const res = await runCiChain(single, { exec, cwd: "/tmp" });
    expect(res.legs[0]?.state).toBe("skipped-paths-ignored");
  });

  test("an earlier tip that ran a different workflow only does not end the walk for this workflow", async () => {
    const { exec } = route({
      commits: { [SHA_P]: { files: ["doc/a.md"], parent: SHA_Q }, [SHA_Q]: { files: ["lib/a.ts"], parent: SHA_R } },
      runs: { [SHA_Q]: ["Publish public mirror"], [SHA_R]: ["CI"] },
    });
    const res = await runCiChain(single, { exec, cwd: "/tmp" });
    expect(res.legs[0]?.state).toBe("pending");
  });

  test("a leg that has a run is never second-guessed by the filter and costs no extra lookups", async () => {
    const { exec, calls } = route({ runs: { [SHA_P]: ["CI"] } });
    const res = await runCiChain({ repo: PRIVATE_REPO, sha: SHA_P, workflows: ["CI"] }, { exec, cwd: "/tmp" });
    expect(res.legs[0]).toMatchObject({ state: "completed", runId: 7 });
    expect(calls.every((call) => call.startsWith("run list"))).toBe(true);
  });

  test("anything it cannot read stays pending: a merge commit, a failed commit lookup, a filterless workflow, a root commit", async () => {
    const cases = [
      { commits: { [SHA_P]: { files: ["doc/a.md"], parents: 2 } } },
      { commitFails: true },
      { ciYaml: NO_FILTER_YAML },
      { commits: { [SHA_P]: { files: ["doc/a.md"] } }, runs: {} },
    ];
    for (const options of cases) {
      const { exec } = route(options as Parameters<typeof route>[0]);
      const res = await runCiChain(single, { exec, cwd: "/tmp" });
      expect(res.legs[0]?.state, JSON.stringify(options)).toBe("pending");
    }
  });

  test("a commit with 300 or more files is not trusted as the push diff", async () => {
    const { exec } = route({ commits: { [SHA_P]: { files: Array.from({ length: 300 }, (_, i) => `doc/${i}.md`), parent: SHA_Q } } });
    const res = await runCiChain(single, { exec, cwd: "/tmp" });
    expect(res.legs[0]?.state).toBe("pending");
  });

  test("a chain of unrun commits longer than the walk limit stays pending", async () => {
    const shas = Array.from({ length: 12 }, (_, i) => (i === 0 ? SHA_P : i.toString(16).padStart(40, "1")));
    const commits = Object.fromEntries(shas.map((sha, i) => [sha, { files: ["doc/a.md"], parent: shas[i + 1] ?? SHA_R }]));
    const { exec } = route({ commits, runs: { [SHA_R]: ["CI"] } });
    const res = await runCiChain(single, { exec, cwd: "/tmp" });
    expect(res.legs[0]?.state).toBe("pending");
  });

  test("a name the repository has no workflow for ends as an error at once instead of waiting for a run that cannot come", async () => {
    const { exec } = route({});
    const res = await runCiChain({ ...params, workflows: ["CI", "Setup source manifest"], mirror: undefined }, { exec, cwd: "/tmp", sleep: mustNotWait });
    expect(res.polls).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.legs[0]).toMatchObject({ workflow: "CI", state: "skipped-paths-ignored" });
    expect(res.legs[1]).toMatchObject({ workflow: "Setup source manifest", state: "error", error: expect.stringContaining("its workflows are: CI, Publish public mirror") });
  });

  test("a listing that cannot prove the name absent leaves the leg pending: more than one page, no or a malformed total, an unreadable entry", async () => {
    const ci = { name: "CI", path: ".github/workflows/ci.yml" };
    const listings = [
      { total_count: 150, workflows: [ci] },
      { workflows: [ci] },
      { total_count: -1, workflows: [ci] },
      { total_count: 2, workflows: [ci, { name: "Setup source manifest" }] },
    ];
    for (const listing of listings) {
      const { exec } = route({ listing });
      const res = await runCiChain({ ...single, workflows: ["Setup source manifest"] }, { exec, cwd: "/tmp" });
      expect(res.legs[0]?.state).toBe("pending");
    }
  });
});
