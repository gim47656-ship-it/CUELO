import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== '--isolated') {
  test('only the named, completed local problem run can be recovered through the inbox route', { timeout: 60_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), 'nightly-recovery-'));
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], {
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, GIT_CEILING_DIRECTORIES: home }, stdio: 'inherit' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
} else {
  const { getAgentDir } = await import('@oh-my-pi/pi-utils');
  const { cacheSessionPath } = await import('../session-reader.ts');
  const { createNightlyBranch, planInboxRun } = await import('./nightly-inbox.ts');
  const { nightlyStateAfterRun, planNightlyRun, writeNightlyState } = await import('./nightly.ts');
  const { inspectNightlyResult } = await import('./nightly-result.ts');
  const { kstDate } = await import('./prompt.ts');
  const { POST } = await import('../../app/api/upkeep/nightly/route.ts');
  const root = process.env.HOME, repo = join(root,'repo'), inbox = join(root,'inbox'), outbox = join(root,'outbox');
  const now = new Date(), date = kstDate(now.toISOString()), id = '00000000-1111-4444-8000-000000000001';
  const git = (cwd, ...args) => execFileSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  mkdirSync(inbox); mkdirSync(outbox);
  git(root,'init','--bare','-q','-b','main','origin.git'); git(root,'clone','-q','origin.git','repo');
  writeFileSync(join(repo,'README.md'),'base'); git(repo,'add','README.md');git(repo,'commit','-qm','base');git(repo,'push','-q','origin','main');
  Object.assign(process.env,{CUELO_NIGHTLY_INBOX_DIR:inbox,CUELO_NIGHTLY_OUTBOX_DIR:outbox,CUELO_NIGHTLY_REPO:repo});
  globalThis.fetch = async () => { throw new Error('offline'); };
  const fixture = JSON.parse(readFileSync(new URL('./fixture-report.json',import.meta.url)));
  const primary = planNightlyRun({...fixture,repoCwd:repo},null,now,[],[]);
  assert.equal(primary.action,'run');
  const tree = join(root,primary.branch.replace('/','-'));
  git(repo,'worktree','add','-qb',primary.branch,tree);
  const source = {source:'pc',version:1,generatedAt:now.toISOString(),problems:[],toolFailures:[],skillCandidates:[]};
  writeFileSync(join(inbox,'pc.json'),JSON.stringify(source));
  const legacy = nightlyStateAfterRun(primary,null,id,tree,now.toISOString());
  legacy.sources = {pc:{skillsScannedAt:'2026-01-01T00:00:00Z'}}; // Carried forward from an older inbox night.
  writeNightlyState(getAgentDir(),legacy);
  const file = join(root,'session.jsonl');
  function transcript(prompt,stopReason='stop') {
    writeFileSync(file,[{type:'session',id,cwd:tree,timestamp:now.toISOString()},
      {type:'message',message:{role:'user',content:prompt}}, {type:'message',timestamp:now.toISOString(),message:{role:'assistant',content:'reviewed',stopReason}}].map(row=>JSON.stringify(row)).join('\n')+'\n');
    cacheSessionPath(id,file);
  }
  const qs = `&recoverLocal=${id}`;
  async function request(query) {
    return POST(new Request('http://127.0.0.1/api/upkeep/nightly?mode=inbox&dryRun=1'+query,{method:'POST',headers:{host:'127.0.0.1'}}));
  }
  transcript(primary.prompt);
  assert.equal((await (await request('')).json()).reason,'already-ran-today');
  assert.equal((await request(qs+'1')).status,400);
  const nowPlan = (await (await request(qs)).json()).plan;
  assert.equal(nowPlan.branch,primary.branch+'-inbox'); assert.deepEqual(nowPlan.sources.map(r=>r.source),['pc']);
  assert.match(nowPlan.prompt,/비식별 집계/); assert.match(nowPlan.prompt,/다음 정기 동기화/);
  transcript(nowPlan.prompt+'\n'+primary.prompt); assert.equal((await request(qs)).status,409,'an inbox quoting a local prompt is not a local run');
  transcript(primary.prompt.split('\n\n---\n\n')[0]); assert.equal((await request(qs)).status,409,'incomplete local report');
  transcript(primary.prompt.replace(/(\n\n---\n\nCUELO 보수 전체 점검\n)[\s\S]+(\n6\. [^\n]+)$/, '$1$2'));
  assert.equal((await request(qs)).status,409,'report heading and footer are not a local board row');
  transcript(primary.prompt,'toolUse'); assert.equal((await request(qs)).status,409);
  transcript(primary.prompt);writeFileSync(join(tree,'held'),'preserve');
  assert.equal((await (await request(qs)).json()).plan.branch,nowPlan.branch);
  const issued = {status:'unavailable',reason:'offline',repo:null};
  const parsedSource = {...source, skillUsage:{rows:[],unused:[]},failureExcerpts:[]};
  assert.equal(planInboxRun([parsedSource],legacy,now,[id],repo,outbox,issued,null,null,id).action,'skip');
  rmSync(join(inbox,'pc.json')); assert.equal((await request(qs)).status,409); writeFileSync(join(inbox,'pc.json'),JSON.stringify(source));
  const base=git(repo,'rev-parse','origin/main'); await createNightlyBranch(repo,nowPlan.branch,base,true);
  await assert.rejects(createNightlyBranch(repo,nowPlan.branch,base,true));
  const {beginGuardedSessionDeletion}=await import('../rpc-manager.ts');
  const competing=beginGuardedSessionDeletion(id,{onlyWhenIdle:true});
  try {
    const busy=await POST(new Request('http://127.0.0.1/api/upkeep/nightly?mode=inbox'+qs,{method:'POST',headers:{host:'127.0.0.1'}}));
    assert.equal(busy.status,409,'do not create or reuse a recovery branch while the old session is reserved');
  } finally {competing.release();}
  const recovered=join(root,nowPlan.branch.replace('/','-'));git(repo,'worktree','add','-q',recovered,nowPlan.branch);
  const newState=nightlyStateAfterRun(nowPlan,legacy,'recovered',recovered,now.toISOString());writeNightlyState(getAgentDir(),newState);
  assert.equal((await request(qs)).status,409);assert.equal((await (await request('')).json()).reason,'already-ran-today');
  for (const outcome of ['clean','held']) {
    if (outcome==='held') writeFileSync(join(recovered,'pending'),'pending');
    const result=await inspectNightlyResult({state:newState,interrupted:false,sessionFile:file});
    assert.deepEqual([result.outcome,result.branch],[outcome,nowPlan.branch]);
  }
  assert.equal(readFileSync(join(tree,'held'),'utf8'),'preserve');assert.equal(git(tree,'branch','--show-current'),primary.branch);
  const tomorrow=new Date(now.getTime()+86400000);assert.equal(planInboxRun([parsedSource],newState,tomorrow,[],repo,outbox,issued).branch,`wt/nightly-${kstDate(tomorrow.toISOString()).replaceAll('-','')}`);
  console.log('Verified recovery of',date,': original clean/held preserved, only manual inbox eligible, duplicate denied; clean/held catch-up result names actual branch; next day normal.');
}
