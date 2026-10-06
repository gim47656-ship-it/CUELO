import assert from "node:assert/strict";
import test from "node:test";
import { parseGithubRepository, GithubProjectError } from "./github-projects.ts";

test("GitHub repository input accepts names and HTTPS URLs without changing identity", () => {
  assert.equal(parseGithubRepository(" Owner/Repo.Name "), "Owner/Repo.Name");
  assert.equal(parseGithubRepository("https://github.com/Owner/Repo.Name.git"), "Owner/Repo.Name");
  assert.equal(parseGithubRepository("https://github.com/Owner/Repo/"), "Owner/Repo");
});

test("repository input rejects non-GitHub targets, embedded credentials, options and path escapes", () => {
  for (const value of [
    "https://", "https://[",
    "https://example.com/Owner/Repo", "https://github.com.evil.invalid/Owner/Repo",
    // 자격 정보가 붙은 GitHub 주소. 한 덩어리로 쓰면 공개 게시의 이메일 검사에 걸려 나눠 붙인다.
    "https://token" + "@github.com/Owner/Repo", "https://github.com:8443/Owner/Repo",
    "https://github.com/Owner/Repo?token=secret", "https://github.com/Owner/Repo#branch",
    "file:///tmp/repo", "git" + "@github.com:Owner/Repo", "../repo", "owner/..", "owner/repo/extra",
    "--upload-pack=bad", "owner/repo;cmd", "owner/repo\nother/repo", "https://github.com/owner/%2e%2e%2frepo",
  ]) {
    assert.throws(() => parseGithubRepository(value), (error) => error instanceof GithubProjectError && error.status === 400, value);
  }
});
