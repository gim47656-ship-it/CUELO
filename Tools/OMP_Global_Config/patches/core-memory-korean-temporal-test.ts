import { strict as assert } from "node:assert";
import { join } from "node:path";
import { homedir } from "node:os";
const core = process.env.OMP_CORE_PATCH_TARGET ?? join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent");
// The test selects a core installation at runtime; static imports would test the wrong copy.
const { extractTemporal } = await import(`${core}/../pi-mnemopi/src/core/temporal-parser.ts`);
const { classifyIntent } = await import(`${core}/../pi-mnemopi/src/core/query-intent.ts`);
const pairs = [["오늘", "today"], ["어제", "yesterday"], ["그제", "2 days ago"], ["그저께", "2 days ago"], ["지난주", "last week"], ["이번 주", "this week"], ["지난달", "last month"], ["3일 전", "3 days ago"], ["2주 전", "2 weeks ago"], ["3달 전", "3 months ago"]];
pairs.push(["어제 배포한 설정 확인", "yesterday 배포한 설정 확인"], ["어제가", "yesterday 가"], ["오늘이", "today 이"], ["지난주와", "last week 와"], ["어제로", "yesterday 로"]);
let failed = 0;
for (const reference of ["2026-10-29T00:30:00+09:00", "2024-03-01T23:30:00Z", "2026-01-01T00:00:00Z"]) {
 for (const [ko, en] of pairs) {
  try {
   assert.deepEqual(extractTemporal(ko, reference), extractTemporal(en, reference));
   assert.equal(classifyIntent(ko).category, "temporal");
   console.log(`PASS ${ko} = ${en} @ ${reference}`);
  } catch (error) { failed++; console.error(`FAIL ${ko} @ ${reference}: ${error}`); }
 }
}
console.log(`English precedence observation: ${JSON.stringify(extractTemporal("day before yesterday", "2026-10-29T00:00:00Z"))}`);
if (failed) process.exit(1);
