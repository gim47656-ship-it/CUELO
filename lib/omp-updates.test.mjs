import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  compareVersions,
  getCueloUpdateStatus,
} = await jiti.import("./omp-updates.ts");

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetcher(release, status = 200) {
  return async (url) => {
    if (url === "https://api.github.com/repos/gim47656-ship-it/CUELO/releases/latest") return response(release ?? {}, status);
    throw new Error(`Unexpected URL: ${url}`);
  };
}

const release = {
  tag_name: "v0.1.8",
  name: "v0.1.8",
  body: "## Fixed\n\n- A release fix",
  html_url: "https://github.com/gim47656-ship-it/CUELO/releases/tag/v0.1.8",
  published_at: "2026-08-05T01:32:09Z",
};

test("compares release versions with prerelease ordering", () => {
  assert.equal(compareVersions("v0.1.8", "0.1.7"), 1);
  assert.equal(compareVersions("0.1.8-rc.1", "0.1.8"), -1);
  assert.equal(compareVersions("0.1.8+build.2", "0.1.8+build.1"), 0);
  assert.equal(compareVersions("not-a-version", "0.1.8"), 0);
});

test("announces a newer CUELO release with its changelog", async () => {
  const status = await getCueloUpdateStatus({ currentAppVersion: "0.1.7", fetcher: fetcher(release) });

  assert.equal(status.updateAvailable, true);
  assert.equal(status.currentAppVersion, "0.1.7");
  assert.equal(status.latestRelease?.version, "0.1.8");
  assert.equal(status.latestRelease?.body, release.body);
  assert.equal(status.latestRelease?.htmlUrl, release.html_url);
});

test("stays quiet when the latest release is not newer", async () => {
  const status = await getCueloUpdateStatus({ currentAppVersion: "0.1.8", fetcher: fetcher(release) });

  assert.equal(status.updateAvailable, false);
  assert.equal(status.latestRelease?.version, "0.1.8");
});

test("treats a repository without releases as up to date", async () => {
  const status = await getCueloUpdateStatus({ currentAppVersion: "0.1.7", fetcher: fetcher(null, 404) });

  assert.equal(status.updateAvailable, false);
  assert.equal(status.latestRelease, null);
});

test("never links a release page outside the CUELO repository", async () => {
  const status = await getCueloUpdateStatus({
    currentAppVersion: "0.1.7",
    fetcher: fetcher({ ...release, html_url: "https://github.com/ddallabenetta/omp-web/releases/tag/v0.1.8" }),
  });

  assert.equal(status.latestRelease?.htmlUrl, "https://github.com/gim47656-ship-it/CUELO/releases/tag/v0.1.8");
});

test("reports an unavailable update source as an error", async () => {
  await assert.rejects(
    getCueloUpdateStatus({ currentAppVersion: "0.1.7", fetcher: fetcher(null, 503) }),
    /HTTP 503/,
  );
});
