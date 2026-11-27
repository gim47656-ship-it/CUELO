// OMP_CORE_PATCH_TARGET=<isolated patched core> bun run patches/core-finalize-background-test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTurnPublication } from '../agent/extensions/lib/turn-publication';

const target = process.env.OMP_CORE_PATCH_TARGET;
assert.ok(target, 'An explicit isolated core target is required');
const root = process.argv[3] ?? mkdtempSync(join(tmpdir(), 'finalize-job-'));
if (process.argv[2] !== '--worker') {
  try {
    const run = Bun.spawnSync([process.execPath, import.meta.path, '--worker', root], {
      env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, 'profile'), OPENAI_API_KEY: 'fixture', OMP_FINALIZE_CHECKS_LEDGER: join(root, 'ledger') }, stdout: 'inherit', stderr: 'inherit',
    });
    process.exitCode = run.exitCode ?? 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  const core = join(resolve(target), 'src');
  // All SDK imports must come from the physical checkout the patch suite selected.
  const { createAgentSession } = await import(`${core}/sdk.ts`);
  const { Settings } = await import(`${core}/config/settings.ts`);
  const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
  const { createAssistantMessageEventStream } = await import(`${core}/../../pi-ai/src/utils/event-stream.ts`);
  const { initializeExtensions } = await import(`${core}/modes/runtime-init.ts`);
  const { resolveToolConcurrency } = await import(`${core}/../../pi-agent-core/src/agent-loop.ts`);
  const { loadCustomTools } = await import(`${core}/extensibility/custom-tools/loader.ts`);
  const work = join(root, 'work'), remote = join(root, 'remote.git'), profile = join(root, 'profile');
  mkdirSync(work); mkdirSync(profile, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', remote); git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const file = 'candidate.txt', path = join(work, file), started = join(root, 'checking');
  writeFileSync(path, 'baseline');
  // The marker is outside the checkout so instrumentation cannot change the publication candidate.
  writeFileSync(join(work, '.finalize-checks.json'), JSON.stringify({ version: 1, checks: [{ name: 'sleep', paths: [file], command: ['node', '-e', `const fs=require('node:fs');const mode=fs.readFileSync('${file}','utf8');fs.writeFileSync(${JSON.stringify(started)},mode);setTimeout(()=>process.exit(mode==='failure'?7:0),mode==='success'?3200:1200)`] }] }));
  git('add', '.'); git('commit', '-m', 'fixture'); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  const model = getBundledModel('openai', 'gpt-4o-mini');
  const toolPath = resolve(import.meta.dir, '../agent/tools/git-finalizer/index.ts');
  let firstCall: { type: 'toolCall'; id: string; name: string; arguments: object } | undefined;
  const { session } = await createAgentSession({ cwd: work, agentDir: profile, agentId: 'Main', model, getApiKey: () => 'fixture',
    settings: Settings.isolated({ 'async.enabled': true, 'launch.enabled': false }), preloadedCustomToolPaths: [{ path: toolPath }],
    bindProcessState: false, enableMCP: false, enableLsp: false, skipPythonPreflight: true, disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], toolNames: ['read', 'write', 'wait', 'git_finalize', 'git_integrate'] });
  let reply = '', seenUser = false, counter = 0;
  session.agent.streamFn = (_: unknown, context: { messages: unknown[] }) => {
    seenUser ||= JSON.stringify(context.messages).includes('status while checking?');
    const stream = createAssistantMessageEventStream();
    const call = firstCall; firstCall = undefined;
    const message = { role: 'assistant', content: call ? [call] : [{ type: 'text', text: reply || 'Received.' }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: call ? 'toolUse' : 'stop', timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); if (call) stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); });
    return stream;
  };
  const errors: unknown[] = [];
  try {
    await initializeExtensions(session, { reportSendError: (_: string, error: Error) => errors.push(error), reportRuntimeError: (error: Error) => errors.push(error) });
    const manager = session.asyncJobManager;
    const call = (name: string, args: object) => session.getToolByName(name).execute(`test-${++counter}`, args);
    for (const name of ['git_finalize', 'git_integrate']) assert.equal(resolveToolConcurrency(session.getToolByName(name), {}), 'exclusive', `${name} scheduler policy through both SDK adapters`);
    // The legacy loader invocation has no session job registrar. It must finish the real transaction inline.
    const legacy = await loadCustomTools([{ path: toolPath }], work, []);
    const legacyTool = legacy.tools.find((entry: { tool: { name: string } }) => entry.tool.name === 'git_finalize').tool;
    writeFileSync(path, 'success');
    const syncStart = performance.now();
    const inline = await legacyTool.execute('fallback', { files: [file], message: 'fallback' }, undefined, {});
    assert.equal(inline.details.stage, 'complete'); assert.match(inline.content[0].text, /^Committed and pushed /);
    assert.equal(inline.details.commitSha, git('--git-dir', remote, 'rev-parse', 'refs/heads/main'));
    console.log(`API absent: returned completed push after ${Math.round(performance.now() - syncStart)} ms; no job receipt`);
    writeFileSync(path, 'between baselines'); git('add', file); git('commit', '-m', 'reset fixture input'); git('push');
    const pub = createTurnPublication();
    async function launch(mode: string) {
      writeFileSync(path, mode);
      const input = { files: [file], message: mode };
      const before = performance.now(), res = await call('git_finalize', input), elapsed = performance.now() - before;
      assert.equal(res.details?.stage, 'pending', JSON.stringify(res));
      const id = res.details.jobId; assert.equal(typeof id, 'string'); assert.ok(elapsed < 5000, `foreground took ${elapsed}ms`);
      pub.observe({ toolName: 'git_finalize', input, details: res.details }, work);
      const job = manager.getJob(id); assert.equal(job.status, 'running'); assert.equal(job.ownerId, session.getAgentId());
      assert.ok(job.label.includes('git_finalize') && job.label.includes(work) && job.label.includes(mode));
      console.log(`${mode}: ${id} in ${Math.round(elapsed)} ms`); return job;
    }
    async function delivered(job: { id: string; promise: Promise<void> }) {
      await job.promise; await manager.drainDeliveries(); await session.waitForRunEnd();
      const messages = session.messages.filter((m: { customType?: string; details: { jobs: { jobId: string }[] } }) => m.customType === 'async-result' && m.details.jobs.some(j => j.jobId === job.id));
      assert.equal(messages.length, 1, `owner delivery for ${job.id}`); return messages[0];
    }
    async function checkStarted(mode: string) {
      const deadline = performance.now() + 5000;
      while (!(existsSync(started) && readFileSync(started, 'utf8') === mode)) {
        assert.ok(performance.now() < deadline, `check did not start: ${mode}`); await Bun.sleep(10);
      }
    }
    writeFileSync(path, 'success');
    const input = { files: [file], message: 'success' };
    const receipt = Promise.withResolvers<{ stage: string; jobId: string }>();
    const stop = session.subscribe((event: { type: string; toolCallId: string; result?: { details?: { stage: string; jobId: string } } }) => {
      if (event.type === 'tool_execution_end' && event.toolCallId === 'sdk-publish') {
        if (event.result?.details?.stage === 'pending') receipt.resolve(event.result.details);
        else receipt.reject(new Error(`Missing pending receipt: ${JSON.stringify(event.result)}`));
      }
    });
    firstCall = { type: 'toolCall', name: 'git_finalize', id: 'sdk-publish', arguments: input };
    const before = performance.now();
    const turn = session.prompt('Publish the fixture.'); turn.catch(receipt.reject);
    const details = await receipt.promise; stop();
    const elapsed = performance.now() - before;
    assert.ok(elapsed < 5000, `SDK call took ${elapsed}ms`); console.log(`success: ${details.jobId} in ${Math.round(elapsed)} ms including the SDK turn`);
    pub.observe({ toolName: 'git_finalize', input, details }, work);
    const success = manager.getJob(details.jobId); assert.equal(success.status, 'running');
    assert.match(pub.note(work, (options: { recentLimit: number }) => session.getAsyncJobSnapshot(options))!, /still running/);
    assert.ok(JSON.stringify((await call('read', { path: `proc://${success.id}` })).content).includes(success.id));
    const overlap = await call('git_finalize', { files: [file], message: 'overlap' });
    assert.equal(overlap.isError, false); assert.deepEqual(overlap.details.refused, { by: 'lock' });
    assert.match(overlap.content[0].text, /^\[refused by lock\] Not executed\.\ngit_finalize failed at lock:/);
    assert.ok(overlap.content[0].text.includes(success.id));
    reply = 'I can answer now.'; await session.prompt('status while checking?', { streamingBehavior: 'steer' }); await session.agent.waitForIdle(); await turn;
    assert.ok(seenUser && session.messages.some((m: { role: string; content: unknown }) => m.role === 'assistant' && JSON.stringify(m.content).includes(reply)));
    assert.equal(success.status, 'running', 'assistant reply precedes completion');
    const ok = await delivered(success); assert.equal(success.status, 'completed');
    assert.match(success.resultText, /^Committed and pushed /); assert.ok(ok.content.includes(success.resultText.split('\n')[0]));
    assert.equal(ok.details.jobs[0].toolResultDetails.commitSha, git('rev-parse', 'HEAD')); pub.settle(ok.details); assert.equal(pub.note(work), undefined);
    const head = git('rev-parse', 'HEAD'); assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/main'), head);
    const index = git('ls-files', '--stage');
    const failure = await launch('failure'), refused = await delivered(failure);
    assert.equal(failure.status, 'completed');
    assert.equal(refused.details.jobs[0].status, 'completed');
    assert.deepEqual(refused.details.jobs[0].toolResultDetails, { ok: false, stage: 'finalize-checks', refused: { by: 'finalize-checks' } });
    assert.match(failure.resultText, /^\[refused by finalize-checks\] Not executed\.\ngit_finalize failed at finalize-checks: sleep exited 7/);
    assert.ok(refused.content.includes(failure.resultText.split('\n')[0]));
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/main'), head);
    assert.equal(git('ls-files', '--stage'), index);
    pub.settle(refused.details);
    assert.match(pub.note(work)!, /refused by finalize-checks/);
    const stale = await launch('stale'); writeFileSync(path, 'changed after receipt'); await delivered(stale);
    assert.equal(stale.status, 'completed'); assert.match(stale.resultText, /^\[refused by cross-review\] Not executed\.\ngit_finalize failed at cross-review-verify:.*changed/); assert.equal(git('rev-parse', 'HEAD'), head);
    const branch = await launch('branch'); await checkStarted('branch');
    git('switch', '-c', 'wrong-ref'); await delivered(branch);
    assert.equal(branch.status, 'failed');
    assert.match(branch.errorText, /publication candidate inputs changed during the check/);
    assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('ls-remote', remote, 'refs/heads/wrong-ref'), ''); git('switch', 'main');
    const killed = await launch('cancel'); await checkStarted('cancel');
    const kill = await call('write', { path: `proc://${killed.id}/kill`, content: '' }); assert.ok(!kill.isError, JSON.stringify(kill)); await killed.promise; assert.equal(killed.status, 'cancelled');
    assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('status', '--porcelain').trimEnd(), `M ${file}`); assert.equal(readFileSync(path, 'utf8'), 'cancel');
    assert.match(pub.note(work, (o: { recentLimit: number }) => session.getAsyncJobSnapshot(o))!, /cancelled/); assert.equal(pub.note(work), undefined);
    const waited = await launch('wait'); const wait = await call('wait', {}); const row = wait.details.jobs.find((j: { id: string }) => j.id === waited.id); assert.equal(row.status, 'completed'); assert.match(row.resultText, /^Committed and pushed /);
    pub.observe({ toolName: 'wait', details: wait.details }, work); assert.equal(pub.note(work), undefined); assert.ok(manager.isJobResultConsumed(waited.id));
    assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/main'), git('rev-parse', 'HEAD'));
    const hook = join(work, '.git/hooks/pre-commit');
    writeFileSync(hook, `#!/bin/sh\nprintf committing > '${started}'\nsleep 2\n`, { mode: 0o755 });
    const protectedJob = await launch('protected'); await checkStarted('committing');
    await assert.rejects(call('write', { path: `proc://${protectedJob.id}/kill`, content: '' }), /is committing\/pushing; cannot cancel/);
    assert.equal(protectedJob.status, 'running'); const pushed = await delivered(protectedJob); assert.equal(protectedJob.status, 'completed');
    pub.settle(pushed.details); assert.equal(pub.note(work), undefined);
    assert.equal(pushed.details.jobs[0].toolResultDetails.commitSha, git('--git-dir', remote, 'rev-parse', 'refs/heads/main'));
    assert.deepEqual(errors, []);
    console.log('Real SDK custom loader, exclusive tools, proc read/kill, human reply, auto delivery, stale bytes, failure, wait and terminal publication settlement passed.');
  } finally { await session.dispose(); session.modelRegistry.authStorage.close(); }
}
