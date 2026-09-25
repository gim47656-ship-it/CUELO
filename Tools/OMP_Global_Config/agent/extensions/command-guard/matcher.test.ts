import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { matchBlockedCommand, type GuardContext } from "./matcher";

function expectBlocked(command: string): void {
  const reason = matchBlockedCommand(command);
  expect(reason).toBeDefined();
  expect(reason).toMatch(/[가-힣]/);
  expect(reason?.toLowerCase()).not.toContain("bypass");
}

function expectAllowed(command: string): void {
  expect(matchBlockedCommand(command)).toBeUndefined();
}

function normalizePath(value: string): string {
  return resolve(value).replace(/\\/g, "/").toLowerCase();
}

describe("정책상 금지된 git 명령", () => {
  const cases = [
    ["git add exact paths", "git add src/app.ts package.json"],
    ["git add exact path with global option", "git -C repo add -- src/app.ts"],
    ["git commit normal", "git commit -m 'feat: safe change'"],
    ["git commit signed", "git commit -Skey-id -m 'signed change'"],
    ["git push normal", "git push origin main"],
    ["git push fixed refspec", "git push origin abc123:refs/heads/main"],
    ["git push follow tags", "git push --follow-tags origin main"],
    ["git commit-tree plumbing", "git commit-tree abc123 -p def456"],
    ["git update-ref plumbing", "git update-ref refs/heads/main abc123 def456"],
    ["git add -A", "git add -A"],
    ["git add --all with global option", "git -C repo add --all"],
    ["git add dot", "git --git-dir=.git add ."],
    ["git add dot after option delimiter", "git add -- ."],
    ["git commit -a", "git commit -a -m 'all tracked files'"],
    ["git commit --all", "git --no-pager commit --all -m update"],
    ["git commit combined -am", "git commit -am update"],
    ["git commit signed then all", "git commit -S -a -m update"],
    ["git commit attached signature then all", "git commit -Skey-id -a -m update"],
    ["git add tracked changes without paths", "git add -u"],
    ["git add repository-root pathspec", "git add :/"],
    ["git add root wildcard", "git add '*'"],
    ["git add current directory slash", "git add ./"],
    ["git add parent directory", "git add .."],
    ["git add parent directory slash", "git add ../"],
    ["git add current wildcard", "git add './*'"],
    ["git add recursive wildcard", "git add '**/*'"],
    ["git add current environment path", "git add \"$PWD\""],
    ["git rm broad current directory", "git rm -rf ."],
    ["git rm broad current directory slash", "git rm --recursive --force ./"],
    ["git reset --hard", "git -c core.quotePath=false reset --hard HEAD~1"],
    ["git clean -fd", "git clean -fd"],
    ["git clean -dfx", "git clean -dfx"],
    ["git clean long options with X", "git clean --force --directory -X"],
    ["git clean forced files", "git clean -f"],
    ["git push -f", "git push -f origin main"],
    ["git push --force", "git push origin main --force"],
    ["git push --force-with-lease", "git push --force-with-lease=main:abc origin main"],
    ["git reset abbreviated hard", "git reset --har HEAD"],
    ["git push abbreviated force", "git push --forc origin main"],
    ["git push abbreviated mirror", "git push --mir origin"],
    ["git add shortest all abbreviation", "git add --a"],
    ["git add shortest update abbreviation", "git add --u"],
    ["git clean shortest force abbreviation", "git clean --f"],
    ["git push shortest mirror abbreviation", "git push --m origin"],
    ["git push shortest force abbreviation", "git push --f origin main"],
    ["forced branch deletion -D", "git branch -D obsolete"],
    ["forced branch deletion long options", "git branch --delete --force obsolete"],
    ["tag deletion", "git tag -d v1.0.0"],
    ["remote ref deletion", "git push origin --delete obsolete"],
    ["remote ref deletion short option", "git push -d origin obsolete"],
    ["remote ref deletion refspec", "git push origin :obsolete"],
    ["remote mirror deletion", "git push --mirror origin"],
    ["remote prune deletion", "git push --prune origin"],
    ["forced refspec", "git push origin +main:main"],
    ["quoted executable is still executable", "\"git\" reset --hard"],
    ["escaped git command name", "g\\it reset --hard"],
    ["escaped rm command name", "r\\m -rf /"],
  ] as const;

  for (const [name, command] of cases) {
    test(name, () => expectBlocked(command));
  }
});

describe("finalizer 전용 git 명령의 저장소 경계", () => {
  const sessionDirectory = resolve("V:/Projects");
  const externalDirectory = resolve("V:/kasset-core-work");
  const isSessionRepository = (directory: string): boolean =>
    normalizePath(directory) === normalizePath(sessionDirectory);
  const contextFor = (cwd: string): GuardContext => ({
    cwd,
    isSessionRepository,
  });

  test("context가 없으면 기존처럼 차단한다", () => {
    expect(matchBlockedCommand("git push origin main")).toBeDefined();
  });

  test("세션 저장소 callback은 push를 차단한다", () => {
    expect(
      matchBlockedCommand("git push origin main", {
        cwd: sessionDirectory,
        isSessionRepository: () => true,
      }),
    ).toBeDefined();
  });

  test("세션 저장소 callback은 -C push를 차단한다", () => {
    expect(
      matchBlockedCommand("git -C V:/Projects push", {
        cwd: sessionDirectory,
        isSessionRepository: () => true,
      }),
    ).toBeDefined();
  });

  test("세션 저장소 callback은 add를 차단한다", () => {
    expect(
      matchBlockedCommand("git add .", {
        cwd: sessionDirectory,
        isSessionRepository: () => true,
      }),
    ).toBeDefined();
  });

  test("다른 저장소의 push를 허용한다", () => {
    expect(
      matchBlockedCommand(
        "git -C V:/kasset-core-work push -u origin br",
        contextFor(sessionDirectory),
      ),
    ).toBeUndefined();
  });

  test("다른 저장소의 commit을 허용한다", () => {
    expect(
      matchBlockedCommand(
        "git -C V:/kasset-core-work commit -m x",
        contextFor(sessionDirectory),
      ),
    ).toBeUndefined();
  });

  test("같은 저장소를 가리키는 -C push는 차단한다", () => {
    expect(
      matchBlockedCommand("git -C V:/Projects push", contextFor(externalDirectory)),
    ).toBeDefined();
  });

  test("-C를 앞에서 뒤로 누적 적용한다", () => {
    const targets: string[] = [];
    const reason = matchBlockedCommand(
      "git -C V:/kasset-core-work -C sub push",
      {
        cwd: sessionDirectory,
        isSessionRepository: (directory) => {
          targets.push(normalizePath(directory));
          return false;
        },
      },
    );

    expect(reason).toBeUndefined();
    expect(targets).toEqual([normalizePath(resolve(externalDirectory, "sub"))]);
  });

  test("붙여 쓴 -C 값을 대상 디렉터리로 적용한다", () => {
    const targets: string[] = [];
    const reason = matchBlockedCommand("git -CV:/kasset-core-work push", {
      cwd: sessionDirectory,
      isSessionRepository: (directory) => {
        targets.push(normalizePath(directory));
        return false;
      },
    });

    expect(reason).toBeUndefined();
    expect(targets).toEqual([normalizePath(externalDirectory)]);
  });

  test("--git-dir 값을 대상 디렉터리로 적용한다", () => {
    const targets: string[] = [];
    const reason = matchBlockedCommand(
      "git --git-dir=V:/kasset-core-work/.git push",
      {
        cwd: sessionDirectory,
        isSessionRepository: (directory) => {
          targets.push(normalizePath(directory));
          return false;
        },
      },
    );

    expect(reason).toBeUndefined();
    expect(targets).toEqual([normalizePath(resolve(externalDirectory, ".git"))]);
  });

  test("상대 --git-dir 값은 모든 -C 적용 후 해석한다", () => {
    const targets: string[] = [];
    const reason = matchBlockedCommand(
      "git --git-dir=.git -C V:/kasset-core-work push",
      {
        cwd: sessionDirectory,
        isSessionRepository: (directory) => {
          targets.push(normalizePath(directory));
          return false;
        },
      },
    );

    expect(reason).toBeUndefined();
    expect(targets).toEqual([normalizePath(resolve(externalDirectory, ".git"))]);
  });

  test("셸 확장이 필요한 -C 값은 callback을 호출하지 않고 차단한다", () => {
    let callbackCalled = false;
    const reason = matchBlockedCommand('git -C "$REPO" push', {
      cwd: sessionDirectory,
      isSessionRepository: () => {
        callbackCalled = true;
        return false;
      },
    });

    expect(reason).toBeDefined();
    expect(callbackCalled).toBeFalse();
  });

  test("context cwd가 다른 저장소면 인자 없는 push를 허용한다", () => {
    expect(
      matchBlockedCommand("git push origin main", contextFor(externalDirectory)),
    ).toBeUndefined();
  });

  test("context cwd가 세션 저장소면 인자 없는 push를 차단한다", () => {
    expect(
      matchBlockedCommand("git push origin main", contextFor(sessionDirectory)),
    ).toBeDefined();
  });

  test("중첩 PowerShell 명령에도 같은 context를 적용한다", () => {
    expect(
      matchBlockedCommand(
        'pwsh -c "git push origin main"',
        contextFor(externalDirectory),
      ),
    ).toBeUndefined();
  });
});

describe("광범위한 파일 삭제", () => {
  const cases = [
    ["POSIX root", "rm -rf /"],
    ["current directory glob", "rm -fr ./*"],
    ["parent directory", "sudo rm --recursive --force -- .."],
    ["home directory", "rm -rf \"$HOME\""],
    ["home directory trailing slash", "rm -rf \"$HOME/\""],
    ["unquoted home directory trailing slash", "rm -rf $HOME/"],
    ["POSIX abbreviated long options", "rm --rec --for /"],
    ["POSIX shortest long options", "rm --r --f /"],
    ["Windows drive root", "rm -rf C:\\"],
    ["PowerShell current directory", "Remove-Item -Path . -Recurse -Force"],
    ["PowerShell drive root", "Remove-Item C:\\ -Force -Recurse"],
    [
      "nested PowerShell command",
      "powershell -NoProfile -Command \"Remove-Item -Path . -Recurse -Force\"",
    ],
    ["Remove-Item abbreviated options", "Remove-Item -Path . -Rec -For"],
    ["Remove-Item shortest recurse prefix", "Remove-Item -Path . -Re -For"],
    ["PowerShell ri alias", "ri -Path . -Rec -For"],
    ["PowerShell del alias", "del -Path . -Recurse -Force"],
    ["cmd del recursive quiet", "del /s /q C:\\"],
    ["cmd rd recursive quiet", "rd /s /q ."],
  ] as const;

  for (const [name, command] of cases) {
    test(name, () => expectBlocked(command));
  }
});

describe("실제 데이터베이스 클라이언트의 파괴 SQL", () => {
  const cases = [
    ["sqlcmd DROP", "sqlcmd -S . -Q \"DROP DATABASE production\""],
    ["psql TRUNCATE", "psql app -c \"TRUNCATE TABLE audit_log\""],
    ["mysql DROP", "mysql app --execute=\"DROP TABLE sessions\""],
    ["sqlite3 DROP", "sqlite3 app.db \"DROP TABLE cache\""],
    ["duckdb TRUNCATE", "duckdb app.db \"TRUNCATE TABLE events\""],
    ["Invoke-Sqlcmd DROP", "Invoke-Sqlcmd -Query \"DROP TABLE dbo.Temp\""],
    ["piped SQL", "echo \"DROP TABLE audit\" | psql app"],
    ["printf piped SQL", "printf '%s\\n' 'TRUNCATE TABLE audit' | mysql app"],
    ["piped SQL into subshell", "echo \"DROP TABLE audit\" | (psql app)"],
  ] as const;

  for (const [name, command] of cases) {
    test(name, () => expectBlocked(command));
  }
});

describe("배포·게시·릴리스 실행", () => {
  const cases = [
    ["wrangler deploy", "wrangler --config wrangler.toml deploy"],
    ["npx wrangler deploy", "npx wrangler deploy"],
    ["pnpm dlx wrangler deploy", "pnpm dlx wrangler deploy"],
    ["npm exec wrangler deploy", "npm exec -- wrangler deploy"],
    ["npm publish", "npm publish"],
    ["pnpm filtered publish", "pnpm --filter app publish"],
    ["Yarn Berry publish", "yarn npm publish"],
    ["bun publish", "bun publish"],
    ["cargo publish", "cargo publish"],
    ["GitHub release creation", "gh release create v1.0.0"],
    ["GitHub release upload", "gh --repo org/repo release upload v1 artifact.zip"],
    ["npm deploy script", "npm run deploy"],
    ["pnpm release script", "pnpm --filter web run release:prod"],
    ["yarn direct script", "yarn deploy"],
    ["shell deploy script", "./scripts/deploy.sh"],
    ["PowerShell release file", "pwsh -File .\\scripts\\release.ps1"],
    ["make release target", "make release"],
  ] as const;

  for (const [name, command] of cases) {
    test(name, () => expectBlocked(command));
  }
});

describe("셸 구분자와 중첩 명령", () => {
  const cases = [
    ["semicolon", "git diff; git add -A"],
    ["and", "bun test && git reset --hard"],
    ["or", "false || git clean -fdx"],
    ["pipe", "echo ok | git push --force origin main"],
    ["newline", "git status\ngit tag -d v1"],
    ["background separator", "echo ok & git reset --hard"],
    ["POSIX line continuation remove", "rm -rf " + "\\" + "\n/"],
    ["POSIX line continuation git", "git reset " + "\\" + "\n--hard"],
    ["nested PowerShell git", "pwsh -c \"git reset --hard\""],
    [
      "nested PowerShell separator",
      "powershell -Command \"Get-Date; Remove-Item -Recurse -Force .\"",
    ],
    ["parenthesized git", "(git reset --hard)"],
    ["spaced parenthesized remove", "( rm -rf / )"],
    ["parenthesized publish", "(npm publish)"],
    ["parenthesized remote mirror", "(git push --mirror origin)"],
    ["and then parenthesized git", "true && (git reset --hard)"],
    ["pipe into parenthesized git", "echo x | (git reset --hard)"],
    ["glued output redirection", "git reset --hard>/dev/null"],
    ["prefix output redirection", ">/dev/null git reset --hard"],
    ["middle file descriptor redirection", "git 2>/dev/null reset --hard"],
    ["descriptor duplication", "git reset --hard 2>&1"],
    ["time wrapper git", "time git reset --hard"],
    ["time portability wrapper git", "time -p git reset --hard"],
    ["external time output wrapper git", "/usr/bin/time -o timing.txt git reset --hard"],
    ["command path wrapper git", "command -p git reset --hard"],
    ["nohup delimiter wrapper git", "nohup -- git reset --hard"],
    ["timeout wrapper remove", "timeout 60 rm -rf /"],
    ["timeout option wrapper push", "timeout -k 5 60 git push --force origin main"],
    ["timeout long option wrapper publish", "timeout --signal=KILL 60 npm publish"],
    ["time wrapper database", "time psql app -c \"TRUNCATE TABLE audit_log\""],
  ] as const;

  for (const [name, command] of cases) {
    test(name, () => expectBlocked(command));
  }
});

describe("정상 개발 명령", () => {
  const commands = [
    "bun test agent/extensions/command-guard/matcher.test.ts",
    "bun run build",
    "npm test",
    "grep -R -- 'needle' src",
    "git diff --stat",
    "git status",
    "git clean -n",
    "(git status)",
    "git status>/dev/null",
    ">/dev/null git status",
    "echo '(git reset --hard)'",
    "git branch -d merged-branch",
    "rm -rf dist",
    "rm --recursive --force ./build",
    "rm --rec --for ./build",
    "rm --r --f ./build",
    "git rm -rf dist",
    "time git status",
    "time -p bun test",
    "timeout 60 bun test",
    "command -v git",
    "command -V git",
    "nohup -- git status",
    "timeout --help git reset --hard",
    "/usr/bin/time --version git reset --hard",
    "Remove-Item -Recurse -Force ./dist",
    "powershell -Command \"Remove-Item ./build -Recurse -Force\"",
    "Remove-Item ./dist -Rec -For",
    "sqlcmd -Q \"SELECT 1\"",
    "psql app -c \"SELECT 'DROP TABLE documentation'\"",
    "mysql app -e \"-- DROP TABLE documentation\\nSELECT 1\"",
    "echo 'DROP TABLE documentation'",
    "wrangler dev",
    "npm pack",
    "npm run build:release",
    "gh release list",
    "gh release view v1.0.0",
  ] as const;

  for (const command of commands) {
    test(command, () => expectAllowed(command));
  }
});

describe("인용문·문서·주석의 금지 명령 언급", () => {
  const commands = [
    "echo 'git add -A && git reset --hard; rm -rf /'",
    "printf '%s\\n' 'wrangler deploy and npm publish'",
    "git grep 'git reset --hard'",
    "echo \"docs: explain git commit -a and git clean -fdx\"",
    "Write-Output 'Remove-Item -Recurse -Force .'",
    "powershell -Command \"Write-Output 'git reset --hard; wrangler deploy'\"",
    "git diff # git reset --hard",
    "git diff # git clean -fdx\ngit status",
    "echo '# git push --force-with-lease'",
    "echo 'DROP TABLE audit' | grep DROP",
    "echo \"quoted separator: git reset --hard | rm -rf /\"",
    "echo 'background text: x & git reset --hard'",
    "printf '%s' 'rm -rf \\\n/'",
    "echo 'escaped command text: g\\it reset --hard'",
  ] as const;

  for (const command of commands) {
    test(command, () => expectAllowed(command));
  }
});
