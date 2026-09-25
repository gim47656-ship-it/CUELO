import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

// 관리 라우트 가드(loopback·테일넷)를 통과하는 요청. 값이 아니라 출처 헤더만 바꿔 가며 쓴다.
function handlesRequest(headers) {
  return new Request("http://localhost/api/gpt6/handles", {
    headers: { host: "localhost", "x-forwarded-for": "127.0.0.1", ...headers },
  });
}

/**
 * 커넥터에 넣는 것은 tunnel_id이고, 요청을 넘기는 tunnel-client는 집 PC에서 돈다. 그래서
 * 화면에 줄 대상 주소는 노출 호스트와 무관한 loopback이어야 하고, 요청자가 정하는 헤더가
 * 그 값을 움직이면 안 된다 — 움직이면 사용자가 엉뚱한 곳을 가리키게 된다.
 */
test("handles GET gives tunnel-client a loopback target that request headers cannot move", async () => {
  const previousPort = process.env.PORT;
  const previousHosts = process.env.CUELO_ALLOWED_HOSTS;
  process.env.PORT = "30141";
  process.env.CUELO_ALLOWED_HOSTS = "home-pc.tailnet.ts.net";

  try {
    const direct = await GET(handlesRequest({}));
    assert.equal(direct.status, 200);
    const body = await direct.json();
    assert.equal(body.tunnelTargetUrl, "http://127.0.0.1:30141/api/gpt6/mcp");
    // 직접 접속용 주소는 계속 노출 호스트를 따른다 — 두 주소의 의미가 다르다.
    assert.equal(body.mcpUrl, "https://home-pc.tailnet.ts.net/api/gpt6/mcp");

    const spoofed = await GET(handlesRequest({
      host: "home-pc.tailnet.ts.net",
      "x-forwarded-host": "evil.example.com",
      "x-forwarded-for": "100.64.0.7",
    }));
    assert.equal(spoofed.status, 200);
    assert.equal((await spoofed.json()).tunnelTargetUrl, body.tunnelTargetUrl);
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousHosts === undefined) delete process.env.CUELO_ALLOWED_HOSTS;
    else process.env.CUELO_ALLOWED_HOSTS = previousHosts;
  }
});
