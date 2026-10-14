/** browser.run 의 페이지 listener 범위(createRunPageScope)가 Puppeteer 자신의 구독을 남기는지 확인한다(공개 이슈 #25).
 *
 * 18.10.4 는 run 동안 page.on 으로 붙은 listener 를 모두 run 소유로 기록하고 run 이 끝날 때 떼었다. Puppeteer 는
 * request 마다 자기 `request` handler 안에서 requestfinished·requestfailed·response 를 구독해 in-flight 수를 세므로,
 * 앞 run 에서 시작해 run 이 끝난 뒤 완료된 요청이 영영 빠지지 않고 다음 run 의 waitForNetworkIdle 이 타임아웃됐다.
 *
 * 실제 코어 함수(설치본 src/tools/browser/tab-worker.ts 와 CLI 번들 dist/cli.js 의 같은 함수)를 그대로 잘라
 * 실제 puppeteer-core Page·HTTPRequest 위에서 돌린다. 대신하는 경계는 CDP 이벤트가 도착하는 시점뿐이다.
 *
 * 실행: OMP_CORE_PATCH_TARGET=<사본> bun run patches/core-browser-run-scope-test.ts
 * 미패치 사본에서는 RED, 패치 사본에서는 GREEN 이다.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function resolveCoreRoot(): string {
	const env = process.env.OMP_CORE_PATCH_TARGET;
	if (env) return env;
	const root = join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "npm/node_modules");
	const candidates = [
		join(root, "cuelo/node_modules/@oh-my-pi/pi-coding-agent"),
		join(homedir(), "cuelo-run/node_modules/@oh-my-pi/pi-coding-agent"),
		join(root, "@oh-my-pi/pi-coding-agent"),
	];
	const hit = candidates.find(p => existsSync(join(p, "src/tools/browser/tab-worker.ts")));
	if (!hit) throw new Error(`CUELO 코어를 찾지 못했다: ${candidates.join(", ")}`);
	return hit;
}

const CORE = resolveCoreRoot();
const puppeteerRoot = join(createRequire(join(CORE, "package.json")).resolve("puppeteer-core/package.json"), "..");
// 시험 대상 코어(OMP_CORE_PATCH_TARGET)가 쓰는 puppeteer-core 를 실행 때 찾으므로 정적 import 로 쓸 수 없다.
const { Page } = await import(pathToFileURL(join(puppeteerRoot, "lib/puppeteer/api/Page.js")).href);
const { HTTPRequest } = await import(pathToFileURL(join(puppeteerRoot, "lib/puppeteer/api/HTTPRequest.js")).href);

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
	if (cond) {
		pass++;
		console.log(`  PASS  ${name}`);
	} else {
		fail++;
		console.log(`  FAIL  ${name} ${detail}`);
	}
}

/** `{` 부터 짝이 맞는 `}` 까지. 두 함수 본문의 문자열·주석에는 중괄호가 없다. */
function sliceFunction(text: string, start: number): string {
	let depth = 0;
	for (let i = text.indexOf("{", start); i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
	}
	throw new Error("함수 끝을 찾지 못했다");
}

type RunScope = { detach(): void };
type ScopeFactory = (page: unknown, restore: () => Promise<void>) => RunScope;

function fromSource(): ScopeFactory {
	const text = readFileSync(join(CORE, "src/tools/browser/tab-worker.ts"), "utf8");
	const start = text.indexOf("function createRunPageScope(");
	if (start < 0) throw new Error("src 에 createRunPageScope 가 없다");
	const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`${sliceFunction(text, start)}\nexport { createRunPageScope };`);
	return new Function(`${js.replace(/export\s*\{[^}]*\};?\s*$/, "")}\nreturn createRunPageScope;`)() as ScopeFactory;
}

function fromBundle(): ScopeFactory {
	const text = readFileSync(join(CORE, "dist/cli.js"), "utf8");
	const probe = /getOwnPropertyDescriptor\([\w$]+,"setRequestInterception"\)/.exec(text);
	if (!probe) throw new Error("dist/cli.js 에 run scope 가 없다");
	const start = text.lastIndexOf("function ", probe.index);
	return new Function(`return (${sliceFunction(text, start)});`)() as ScopeFactory;
}

const listenerCounts = (page: { listenerCount(type: string): number }): number[] =>
	["requestfinished", "requestfailed", "response"].map(type => page.listenerCount(type));

async function scenario(label: string, createRunPageScope: ScopeFactory): Promise<void> {
	const page = new Page();
	const baseline = listenerCounts(page);
	const run1 = createRunPageScope(page, async () => {});
	let userCalls = 0;
	let onceCalls = 0;
	page.on("console", () => userCalls++);
	page.once("console", () => onceCalls++);
	// run 이 단 handler 가 전달 중에 붙인 listener 도 run 소유여야 한다.
	let nestedCalls = 0;
	page.on("load", () => page.on("dialog", () => nestedCalls++));
	page.emit("load", undefined);

	const request = new HTTPRequest();
	request.id = "slow-request";
	page.emit("request", request);
	await request.finalizeInterceptions();
	const pending = listenerCounts(page);
	run1.detach();
	page.emit("console", {});
	page.emit("dialog", {});
	page.emit("requestfinished", request);

	const run2 = createRunPageScope(page, async () => {});
	let observed: string;
	try {
		await page.waitForNetworkIdle({ idleTime: 20, timeout: 500 });
		observed = "idle";
	} catch (error) {
		observed = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} finally {
		run2.detach();
		page.emit("close");
	}

	check(`${label}: 요청 시작 시 Puppeteer 완료 구독이 붙는다`, pending.every((n, i) => n === baseline[i] + 1), JSON.stringify({ baseline, pending }));
	check(`${label}: 앞 run 에서 시작한 요청이 끝나면 다음 run 이 idle 로 끝난다`, observed === "idle", observed);
	check(`${label}: 완료 뒤 Puppeteer 구독이 스스로 풀린다`, listenerCounts(page).every((n, i) => n === baseline[i]), JSON.stringify(listenerCounts(page)));
	check(`${label}: run 이 단 on·once handler 는 detach 로 떨어진다`, userCalls === 0 && onceCalls === 0, JSON.stringify({ userCalls, onceCalls }));
	check(`${label}: run handler 가 전달 중 붙인 listener 도 detach 로 떨어진다`, nestedCalls === 0, JSON.stringify({ nestedCalls }));
}

console.log(`core-browser-run-scope-test (core ${CORE}, puppeteer-core ${JSON.parse(readFileSync(join(puppeteerRoot, "package.json"), "utf8")).version})`);
await scenario("src", fromSource());
await scenario("dist", fromBundle());
console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
