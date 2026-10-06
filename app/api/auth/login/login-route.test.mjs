import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./[provider]/route.ts");

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?client_id=x&state=s";
const params = { params: Promise.resolve({ provider: "anthropic" }) };

/** core 의 oauth-code 흐름처럼 인증 주소를 알리고 붙여 넣은 값을 기다리는 가짜 로그인. */
function installFakeLogin(received) {
  globalThis.__ompRuntimePromise = Promise.resolve({
    authStorage: {
      oauth: {
        async login(_id, callbacks) {
          callbacks.onAuth({ url: AUTHORIZE_URL, launchUrl: "http://localhost:54545/launch" });
          const code = await callbacks.onManualCodeInput();
          if (callbacks.signal?.aborted) throw new Error("Login cancelled");
          received.push(code);
        },
      },
    },
  });
}

async function readFirstEvent(reader) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return JSON.parse(text.slice(text.indexOf("data: ") + 6, text.indexOf("\n\n")));
}

test("a phone that leaves for the browser can still finish the login by pasting the redirect", async () => {
  // 휴대폰은 로그인하러 브라우저로 넘어가면 CUELO 화면이 백그라운드로 가 SSE 가 끊긴다(2026-10-06 클라우드).
  const received = [];
  installFakeLogin(received);
  const client = new AbortController();
  const response = await GET(new Request("http://cuelo.test/api/auth/login/anthropic", { signal: client.signal }), params);
  const reader = response.body.getReader();
  const auth = await readFirstEvent(reader);

  // 화면에는 서버 자신의 localhost 가 아니라 원격 브라우저가 열 수 있는 실제 인증 주소가 간다.
  assert.equal(auth.type, "auth");
  assert.equal(auth.url, AUTHORIZE_URL);

  await reader.cancel();
  client.abort();

  const pasted = "http://localhost:54545/callback?code=abc&state=s";
  const reply = await POST(new Request("http://cuelo.test/api/auth/login/anthropic", {
    method: "POST",
    body: JSON.stringify({ token: auth.token, code: pasted }),
  }), params);
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { ok: true, provider: "anthropic", state: "success" });
  assert.deepEqual(received, [pasted]);
});
