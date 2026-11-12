import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('check API persists manual verdicts, rejects invalid verdicts and GET groups only classified marks', { timeout: 60_000 }, () => {
  const script = `
    import assert from 'node:assert/strict';
    import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { setAgentDir } from '@oh-my-pi/pi-utils';
    const dir = mkdtempSync(join(tmpdir(), 'upkeep-precision-api-'));
    setAgentDir(dir);
    mkdirSync(join(dir,'sessions'), { recursive: true });
    const { POST, DELETE } = await import('./app/api/upkeep/check/route.ts');
    const { GET } = await import('./app/api/upkeep/route.ts');
    const { readCheckMarks, setCheckMark } = await import('./lib/upkeep/checks.ts');
    const request = (method, body) => new Request('http://127.0.0.1:30163/api/upkeep/check', { method, headers: { host: '127.0.0.1:30163', 'content-type': 'application/json', origin: 'http://127.0.0.1:30163' }, body: JSON.stringify(body) });
    try {
      for (const [metricId, verdict] of [['model:a','real'], ['model:b','false-positive'], ['model:legacy',undefined], ['purpose:x','real']]) {
        const response = await POST(request('POST', { metricId, verdict, criterionId: 'spoofed-rule' }));
        assert.equal(response.status, 200, await response.text());
      }
      assert.equal((await POST(request('POST', { metricId: 'model:bad', verdict: 'guessed' }))).status, 400);
      const response = await GET(new Request('http://127.0.0.1:30163/api/upkeep', { headers: { host: '127.0.0.1:30163' } }));
      assert.equal(response.status,200);
      const report = await response.json();
      assert.deepEqual(report.precision['model-cost-v2'], { real: 1, falsePositive: 1, precision: 0.5 });
      assert.deepEqual(report.precision['purpose-cost-v1'], { real: 1, falsePositive: 0, precision: 1 });
      assert.equal(report.precision['spoofed-rule'], undefined);
      const original = new Date(Date.now() - 3 * 86400000);
      setCheckMark(dir, 'ci', original, 'original review reason');
      assert.equal((await POST(request('POST', { metricId: 'ci', verdict: 'real' }))).status, 200);
      assert.deepEqual(readCheckMarks(dir).ci, { at: original.toISOString(), note: 'original review reason', verdict: 'real', criterionId: 'ci-v2' });
      assert.equal((await POST(request('POST', { metricId: 'ci', note: 'updated reason' }))).status, 200);
      assert.equal(readCheckMarks(dir).ci.verdict, 'real');
      assert.equal(readCheckMarks(dir).ci.at, original.toISOString());
      const cleared = await DELETE(request('DELETE', { metricId: 'model:b' }));
      assert.equal(cleared.status,200);
      assert.equal((await cleared.json()).precision['model-cost-v2'].precision,1);
      console.log('API precision: 1 real / 1 false-positive = 50%; legacy excluded; delete -> 100%; spoof ignored; invalid -> 400');
    } finally { rmSync(dir,{ recursive: true, force: true }); }
  `;
  const output = execFileSync(process.execPath, ['--eval', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 });
  assert.match(output, /API precision:/);
});
