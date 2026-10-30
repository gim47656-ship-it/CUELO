import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { isNotRepositoryDiagnostic, matchBlockedCommand, type GuardContext } from "./matcher";

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
  // 드라이브 경로는 Windows에서만 절대경로다. Linux에서는 같은 모양의 POSIX 절대경로로 같은 경계를 검사한다.
  const ROOT = process.platform === "win32" ? "V:" : "/v";
  const sessionDirectory = resolve(`${ROOT}/Projects`);
  const externalDirectory = resolve(`${ROOT}/kasset-core-work`);
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
      matchBlockedCommand(`git -C ${ROOT}/Projects push`, {
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
        `git -C ${ROOT}/kasset-core-work push -u origin br`,
        contextFor(sessionDirectory),
      ),
    ).toBeUndefined();
  });

  test("다른 저장소의 commit을 허용한다", () => {
    expect(
      matchBlockedCommand(
        `git -C ${ROOT}/kasset-core-work commit -m x`,
        contextFor(sessionDirectory),
      ),
    ).toBeUndefined();
  });

  test("같은 저장소를 가리키는 -C push는 차단한다", () => {
    expect(
      matchBlockedCommand(`git -C ${ROOT}/Projects push`, contextFor(externalDirectory)),
    ).toBeDefined();
  });

  test("-C를 앞에서 뒤로 누적 적용한다", () => {
    const targets: string[] = [];
    const reason = matchBlockedCommand(
      `git -C ${ROOT}/kasset-core-work -C sub push`,
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
    const reason = matchBlockedCommand(`git -C${ROOT}/kasset-core-work push`, {
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
      `git --git-dir=${ROOT}/kasset-core-work/.git push`,
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
      `git --git-dir=.git -C ${ROOT}/kasset-core-work push`,
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

  const tildeExpansionCases = [
    ["단어 맨 앞 ~/", "git -C ~/other push"],
    ["단독 ~", "git -C ~ push"],
    ["assignment 꼴 =~", "git -C a=~/x push"],
    ["assignment 꼴 :~", "git -C x:~/y push"],
    ["붙여 쓴 -C~/", "git -C~/x push"],
    ["--git-dir=~/", "git --git-dir=~/x/.git push"],
    ["따옴표로 감싼 ~/도 보수적으로", "git -C '~/other' push"],
  ] as const;
  for (const [name, command] of tildeExpansionCases) {
    test(`tilde 확장 가능 값은 callback 없이 차단한다: ${name}`, () => {
      let callbackCalled = false;
      const reason = matchBlockedCommand(command, {
        cwd: sessionDirectory,
        isSessionRepository: () => {
          callbackCalled = true;
          return false;
        },
      });
      expect(reason).toBeDefined();
      expect(callbackCalled).toBeFalse();
    });
  }

  const shortNamePath = process.platform === "win32" ? "C:/Users/RUNNER~1/AppData/Local/Temp/ext" : "/home/RUNNER~1/tmp/ext";
  const shortNameCases = [
    ["-C 값", `git -C ${shortNamePath} push origin main`, shortNamePath],
    ["따옴표 -C 값", `git -C '${shortNamePath}' commit -m x`, shortNamePath],
    ["붙여 쓴 -C 값", `git -C${shortNamePath} push`, shortNamePath],
    ["--git-dir 값", `git --git-dir=${shortNamePath}/.git push`, `${shortNamePath}/.git`],
  ] as const;
  for (const [name, command, target] of shortNameCases) {
    test(`경로 중간 literal ~(8.3 이름)는 저장소 판정에 맡긴다: ${name}`, () => {
      const targets: string[] = [];
      const external = matchBlockedCommand(command, {
        cwd: sessionDirectory,
        isSessionRepository: (directory) => {
          targets.push(normalizePath(directory));
          return false;
        },
      });
      expect(external).toBeUndefined();
      expect(targets).toEqual([normalizePath(resolve(target))]);
      expect(
        matchBlockedCommand(command, { cwd: sessionDirectory, isSessionRepository: () => true }),
      ).toBeDefined();
    });
  }

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

  const sessionOnly: GuardContext = { cwd: sessionDirectory, isSessionRepository: () => true };
  const dryRunCases = [
    ["add --dry-run", "git add --dry-run README.md", false],
    ["add -n", "git add -n .", false],
    ["push --dry-run", "git push --dry-run origin main", false],
    ["push -n", "git push -n origin main", false],
    ["commit --dry-run", "git commit --dry-run", false],
    ["commit -n은 --no-verify", "git commit -n -m x", true],
    ["미리보기 뒤 실제 push", "git push --dry-run origin main && git push origin main", true],
  ] as const;
  for (const [name, command, blocked] of dryRunCases) {
    test(`세션 저장소의 미리보기만 허용한다: ${name}`, () => {
      expect(matchBlockedCommand(command, sessionOnly) !== undefined).toBe(blocked);
    });
  }

  const other = `${ROOT}/kasset-core-work`;
  const cdCases = [
    ["&&로 이어진 cd 뒤 다른 저장소 commit", `cd ${other} && git add -A && git commit -m x`, sessionDirectory, false],
    ["cd 실패에도 도는 ; 뒤 commit", `cd ${other}; git commit -m x`, sessionDirectory, true],
    ["|| 뒤 commit", `cd ${other} || true && git commit -m x`, sessionDirectory, true],
    ["변수 경로 cd", 'cd "$T" && git commit -m x', externalDirectory, true],
    ["subshell이 닫힌 뒤 commit", `(cd ${other} && git add -A) && git commit -m x`, sessionDirectory, true],
    ["cd 뒤 subshell 안 commit", `cd ${other} && (git add -A && git commit -m x)`, sessionDirectory, false],
    ["세션 저장소로 다시 cd", `cd ${other} && cd ${ROOT}/Projects && git push`, sessionDirectory, true],
    ["GIT_DIR를 쓰는 명령", `export GIT_DIR=${ROOT}/Projects/.git; cd ${other} && git commit -m x`, sessionDirectory, true],
  ] as const;
  for (const [name, command, cwd, blocked] of cdCases) {
    test(`명령 안의 cd를 따라 저장소를 판정한다: ${name}`, () => {
      expect(matchBlockedCommand(command, contextFor(cwd)) !== undefined).toBe(blocked);
    });
  }

  // 세션 브랜치를 대상 위로 옮기는 일은 git_integrate가 맡는다. fast-forward만 하는 갱신과 멈춘 merge 되돌리기는 남긴다.
  const integrateCases = [
    ["rebase", "git rebase origin/main", true],
    ["rebase --continue", "git rebase --continue", true],
    ["rebase --abort", "git -C . rebase --abort", true],
    ["pull", "git pull", true],
    ["pull --rebase", "git pull --ff-only --rebase", true],
    ["pull -r", "git pull -r --ff-only", true],
    ["merge", "git merge origin/main", true],
    ["merge --no-ff", "git merge --no-ff topic", true],
    ["ff-only 뒤 --ff", "git merge --ff-only --ff topic", true],
    ["축약한 ff-only", "git merge --ff-o origin/main", true],
    ["merge --continue", "git merge --continue", true],
    ["pull --ff-only", "git pull --ff-only", false],
    ["merge --ff-only", "git merge --ff-only origin/main", false],
    ["merge --abort", "git merge --abort", false],
    ["merge-base", "git merge-base --is-ancestor a b", false],
  ] as const;
  for (const [name, command, blocked] of integrateCases) {
    test(`세션 저장소의 rebase·merge·pull은 git_integrate로 보낸다: ${name}`, () => {
      const reason = matchBlockedCommand(command, sessionOnly);
      expect(reason !== undefined).toBe(blocked);
      if (blocked) expect(reason).toContain("git_integrate");
    });
  }

  test("다른 저장소의 rebase·merge·pull은 막지 않는다", () => {
    for (const command of ["git rebase main", "git pull", `git -C ${externalDirectory} merge topic`]) {
      expect(matchBlockedCommand(command, contextFor(externalDirectory))).toBeUndefined();
    }
    expect(matchBlockedCommand(`git -C ${externalDirectory} rebase main`, contextFor(sessionDirectory))).toBeUndefined();
    expect(matchBlockedCommand(`cd ${externalDirectory} && git pull`, contextFor(sessionDirectory))).toBeUndefined();
    expect(matchBlockedCommand("git rebase main", contextFor(sessionDirectory))).toBeDefined();
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

describe("Windows 드라이브 저장소의 Linux git", () => {
  const DRIVE_REPOSITORY = "/mnt/v/repo";
  const usesWindowsGit = (directory: string): boolean =>
    directory.replace(/\\/g, "/").toLowerCase().includes("/mnt/v/repo");
  const fromDrive: GuardContext = { cwd: `${DRIVE_REPOSITORY}/sub`, isSessionRepository: () => true, usesWindowsGit };
  const fromHome: GuardContext = { cwd: "/home/user/src/app", isSessionRepository: () => true, usesWindowsGit };

  const blocked = [
    ["status in the drive repository", "git status", fromDrive],
    ["diff with --no-optional-locks", "git --no-optional-locks diff --name-only -- .", fromDrive],
    ["read-only log", "git log --oneline -5", fromDrive],
    ["cd into the drive repository", `cd "${DRIVE_REPOSITORY}/sub" && git diff`, fromHome],
    ["-C into the drive repository", `git -C ${DRIVE_REPOSITORY} status`, fromHome],
    ["absolute -C after an unknown cd", `cd "$HOME" && git -C ${DRIVE_REPOSITORY} status`, fromHome],
    ["absolute Linux git path", "/usr/bin/git status", fromDrive],
    ["Linux PowerShell runs Linux git", "pwsh -c \"git status\"", fromDrive],
  ] as const;
  for (const [name, command, context] of blocked) {
    test(`blocks ${name}`, () => {
      expect(matchBlockedCommand(command, context)).toContain("git.exe");
    });
  }

  const allowed = [
    ["Windows git", "git.exe status", fromDrive],
    ["Windows git with -C", `git.exe -C "$(wslpath -w ${DRIVE_REPOSITORY})" status`, fromHome],
    ["git inside Windows PowerShell", "powershell.exe -NoProfile -Command \"git status\"", fromDrive],
    ["Linux repository after cd", "cd /home/user/src/app && git status", fromDrive],
    ["relative -C after an unknown cd", "cd \"$REPO\" && git -C sub status", fromHome],
    ["Linux repository cwd", "git status", fromHome],
    ["version", "git --version && git version", fromDrive],
    ["help", "git help status", fromDrive],
    ["unknown cd target", "cd \"$REPO\" && git status", fromHome],
  ] as const;
  for (const [name, command, context] of allowed) {
    test(`allows ${name}`, () => {
      expect(matchBlockedCommand(command, context)).toBeUndefined();
    });
  }

  test("판정 함수가 없으면 막지 않는다", () => {
    expect(matchBlockedCommand("git status", { cwd: DRIVE_REPOSITORY, isSessionRepository: () => true })).toBeUndefined();
  });
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

describe("중첩 셸과 실행 래퍼 안의 금지 명령", () => {
  const blocked = [
    ["bash -c", 'bash -c "git push origin main"'],
    ["sh -c with commit", "sh -c 'git commit -am x'"],
    ["zsh -c", "zsh -c 'git push'"],
    ["dash -c", "dash -c 'git push'"],
    ["clustered -lc", "bash -lc 'git push'"],
    ["clustered -ec", "bash -ec 'git push'"],
    ["-o value before -c", "bash -o pipefail -c 'git push'"],
    ["long option before -c", "bash --norc -c 'git push'"],
    ["absolute shell path", "/bin/bash -c 'git push'"],
    ["sudo shell", "sudo bash -c 'git push'"],
    ["shell inside shell", `bash -c "bash -c 'git push'"`],
    ["second command after separator", "bash -c 'echo hi; git push'"],
    ["nested remove", "bash -c 'rm -rf /'"],
    ["nested deploy", "bash -c 'wrangler deploy'"],
    ["nested SQL", `bash -c 'psql -c "DROP TABLE x"'`],
    ["nested checkout discard", "bash -c 'git checkout .'"],
    ["eval string", 'eval "git push"'],
    ["eval words", "eval git push"],
    ["su -c", "su -c 'git push' user"],
    ["flock -c", "flock /tmp/l -c 'git push'"],
    ["script -qc", "script -qc 'git push' /dev/null"],
    ["watch", "watch -n 5 git push"],
    ["if then", "if true; then git push origin main; fi"],
    ["for do", "for i in 1; do git commit -am x; done"],
    ["while do", "while true; do git push; done"],
    ["else branch", "if false; then echo a; else git push; fi"],
    ["elif branch", "if false; then echo a; elif true; then git push; fi"],
    ["negation", "! git push"],
    ["exec", "exec git push"],
    ["exec -a", "exec -a name git push"],
    ["nice", "nice git push"],
    ["nice -n", "nice -n 10 git push"],
    ["nice -10", "nice -10 git push"],
    ["setsid", "setsid git push"],
    ["setsid -f", "setsid -f git push"],
    ["ionice", "ionice -c 3 git push"],
    ["stdbuf attached", "stdbuf -oL git push"],
    ["stdbuf separate", "stdbuf -o L git push"],
    ["taskset cpu list", "taskset -c 0 git push"],
    ["taskset mask", "taskset 0x1 git push"],
    ["chrt", "chrt -f 10 git push"],
    ["flock command", "flock /tmp/lock git push"],
    ["flock -w", "flock -w 5 /tmp/lock git push"],
    ["xargs", "echo x | xargs git push"],
    ["xargs -n", "echo x | xargs -n 1 git push"],
    ["xargs -I", "echo x | xargs -I {} git push {}"],
    ["doas", "doas git push"],
    ["echo piped into a shell", 'echo "git push" | bash'],
    ["printf piped into a shell", "printf 'git push\\n' | sh"],
    ["here-string into a shell", 'bash <<< "git push"'],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["benign -c", "bash -c 'echo hi'"],
    ["quoted mention in -c", `bash -c "echo 'git push'"`],
    ["script file", "bash ./run.sh"],
    ["words after -c command are $0 and arguments", "bash -c 'echo $0' git push"],
    ["eval benign", 'eval "echo hi"'],
    ["benign if", "if true; then echo ok; fi"],
    ["benign nice", "nice -n 10 bun test"],
    ["benign xargs", "echo x | xargs echo"],
    ["benign setsid", "setsid -f bun run dev"],
    ["benign pipe into a shell", 'echo "hello" | sh'],
    ["finalizer dry run inside -c", "bash -c 'git push --dry-run'"],
    ["dry run inside substitution", 'echo "$(git push -n)"'],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }

  test("중첩 호출은 세그먼트가 도는 cwd의 저장소 경계를 그대로 쓴다", () => {
    const context = (cwd: string): GuardContext => ({
      cwd,
      isSessionRepository: (directory) => normalizePath(directory).includes("/repo/session"),
    });
    const command = "bash -c 'git push origin main'";
    expect(matchBlockedCommand(command, context("/repo/session"))).toBeDefined();
    expect(matchBlockedCommand(command, context("/repo/external"))).toBeUndefined();
    expect(matchBlockedCommand("cd /repo/external && bash -c 'git push'", context("/repo/session"))).toBeUndefined();
  });
});

describe("명령 치환 안의 금지 명령", () => {
  const blocked = [
    ["backtick", "echo `git push`"],
    ["double-quoted substitution", 'echo "$(git push)"'],
    ["double-quoted backtick", 'echo "`git push`"'],
    ["unquoted substitution", "echo $(git push)"],
    ["assignment substitution", "x=$(git push)"],
    ["substitution as -C value", "git -C $(pwd) push"],
    ["nested substitution", "echo $(echo $(git push))"],
    ["deploy in substitution", 'echo "$(wrangler deploy)"'],
    ["separator after backtick in a double-quoted word", 'echo "`date`"; git push'],
    ["parenthesis inside a quoted substitution argument", `echo "$(echo ')'; git push)"`],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["single-quoted substitution", "echo '$(git push)'"],
    ["escaped substitution", 'echo "\\$(git push)"'],
    ["benign backtick", "echo `date`"],
    ["benign substitution", 'echo "$(git rev-parse HEAD)"'],
    ["arithmetic", "echo $((1 + 2))"],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

describe("heredoc 본문", () => {
  const NL = "\n";
  const blocked = [
    ["unquoted body substitution", `cat > f <<EOF${NL}now $(git push)${NL}EOF`],
    ["unquoted body backtick", `cat > f <<EOF${NL}now \`git push\`${NL}EOF`],
    ["command after the terminator", `cat <<'EOF'${NL}hello${NL}EOF${NL}git push`],
    ["deploy after the terminator", `cat <<'EOF'${NL}x${NL}EOF${NL}wrangler deploy`],
    ["command owning the heredoc", `git push <<'EOF'${NL}x${NL}EOF`],
    ["heredoc piped into a shell", `cat <<'EOF' | bash${NL}git push${NL}EOF`],
    ["heredoc into a shell", `bash <<'EOF'${NL}git push${NL}EOF`],
    ["heredoc into sh", `sh <<EOF${NL}git commit -am x${NL}EOF`],
    ["SQL heredoc into psql", `psql <<'EOF'${NL}DROP TABLE x;${NL}EOF`],
    ["SQL here-string into psql", 'psql <<< "DROP TABLE x"'],
    ["SQL heredoc piped from cat", `cat <<'EOF' | psql${NL}TRUNCATE x;${NL}EOF`],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["quoted body with git commit", `cat > f <<'EOF'${NL}git commit -m x${NL}EOF`],
    ["quoted body with a regex alternation", `cat > f <<'EOF'${NL}const r = /(push|deploy|publish)/;${NL}EOF`],
    ["quoted body with the word deploy", `cat > f <<'EOF'${NL}deploy checklist${NL}EOF`],
    ["quoted body with an apostrophe", `cat > f <<'EOF'${NL}use it's rules${NL}git commit -m x${NL}EOF`],
    ["unquoted body without substitution", `cat > f <<EOF${NL}git commit -m x${NL}EOF`],
    ["quoted body substitution is inert", `cat > f <<'EOF'${NL}now $(git push)${NL}EOF`],
    ["double-quoted tag is inert", `cat > f <<"EOF"${NL}now $(git push)${NL}EOF`],
    ["backslash tag is inert", `cat > f <<\\EOF${NL}now $(git push)${NL}EOF`],
    ["tab-stripped body", `cat <<-EOF${NL}\tgit push${NL}\tEOF`],
    ["two heredocs on one line", `cat <<A <<B${NL}git push${NL}A${NL}git commit${NL}B`],
    ["shell reads a harmless body", `bash <<'EOF'${NL}echo hi${NL}EOF`],
    ["SQL string literal in the body", `psql <<'EOF'${NL}SELECT 'DROP TABLE x';${NL}EOF`],
    ["unterminated heredoc", `cat <<EOF${NL}git push`],
    ["substitution that only reads a heredoc", `echo "$(cat <<'EOF'${NL}text git push${NL}EOF${NL})"`],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

describe("wrangler 배포 하위 명령 정규화", () => {
  const blocked = [
    ["--env", "wrangler --env prod deploy"],
    ["-e", "wrangler -e prod deploy"],
    ["--env=", "wrangler --env=prod deploy"],
    ["config then env", "wrangler -c wrangler.toml -e prod deploy"],
    ["publish", "wrangler publish"],
    ["pages deploy", "wrangler pages deploy dist"],
    ["pages publish", "wrangler pages publish dist"],
    ["versions deploy", "wrangler versions deploy"],
    ["triggers deploy", "wrangler triggers deploy"],
    ["npx with @latest", "npx wrangler@latest deploy"],
    ["bunx with @major", "bunx wrangler@4 deploy"],
    ["npx with env", "npx wrangler -e prod deploy"],
    ["pnpm bin shorthand", "pnpm wrangler deploy"],
    ["yarn bin shorthand", "yarn wrangler deploy"],
    ["bun x", "bun x wrangler deploy"],
    ["npm exec with version", "npm exec -- wrangler@4 deploy"],
    ["pnpm exec versions deploy", "pnpm exec wrangler versions deploy"],
    ["Windows shim", "wrangler.cmd deploy"],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["dev with env", "wrangler --env prod dev"],
    ["env named deploy", "wrangler --env deploy dev"],
    ["versions list", "wrangler versions list"],
    ["pages dev", "wrangler pages dev dist"],
    ["whoami", "wrangler whoami"],
    ["tail through npx", "npx wrangler@latest tail"],
    ["installing the package", "npm install wrangler"],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

describe("psql 묶음 짧은 옵션의 -c", () => {
  const blocked = [
    ["-Atc", 'psql -Atc "DROP TABLE x"'],
    ["-qc", 'psql -qc "DROP TABLE x"'],
    ["-1c", 'psql -1c "TRUNCATE x"'],
    ["-Xc", 'psql -Xc "DROP TABLE x"'],
    ["attached query after a cluster", 'psql -Atc"DROP TABLE x"'],
    ["attached query after -c", 'psql -c"DROP TABLE x"'],
    ["value option before the cluster", 'psql -d db -Atc "DROP TABLE x"'],
    ["longer cluster", 'psql -U u -qtAc "DROP TABLE x"'],
    ["--command", 'psql --command "DROP TABLE x"'],
    ["--command=", 'psql --command="DROP TABLE x"'],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["clustered SELECT", 'psql -Atc "SELECT 1"'],
    ["clustered literal", `psql -Atc "SELECT 'DROP TABLE x'"`],
    ["-a is a flag, not the query", 'psql -ac "SELECT 1"'],
    ["database named like a verb", 'psql -d drop_db -c "SELECT 1"'],
    ["script file", "psql -f schema.sql"],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

describe("git clean 미리보기와 작업 폐기 명령", () => {
  const clean = [
    ["-n -f", "git clean -n -f"],
    ["-nf", "git clean -nf"],
    ["-fdn", "git clean -fdn"],
    ["--dry-run -f", "git clean --dry-run -f"],
    ["-f --dry-run", "git clean -f --dry-run -d"],
    ["abbreviated dry run", "git clean --dry -fd"],
  ] as const;
  for (const [name, command] of clean) {
    test(`allows the dry run ${name}`, () => expectAllowed(command));
  }
  test("실제로 지우는 git clean은 -e 값이 있어도 막는다", () => expectBlocked("git clean -fdx -e keep"));

  const blocked = [
    ["checkout -- .", "git checkout -- ."],
    ["checkout .", "git checkout ."],
    ["checkout revision -- .", "git checkout HEAD -- ."],
    ["checkout -f", "git checkout -f main"],
    ["checkout --force", "git checkout --force main"],
    ["checkout wildcard", "git checkout -- '*'"],
    ["checkout repository-root pathspec", "git checkout -- :/"],
    ["checkout clustered -fb", "git checkout -fb x"],
    ["checkout with -C", "git -C repo checkout ."],
    ["restore .", "git restore ."],
    ["restore -- .", "git restore -- ."],
    ["restore source and worktree", "git restore --source=HEAD --worktree ."],
    ["restore -s", "git restore -s HEAD ."],
    ["restore clustered -SW", "git restore -SW ."],
    ["restore staged and worktree", "git restore --staged --worktree ."],
    ["switch -f", "git switch -f main"],
    ["switch --force", "git switch --force main"],
    ["switch --discard-changes", "git switch --discard-changes main"],
    ["stash clear", "git stash clear"],
    ["stash drop", "git stash drop"],
    ["stash drop with a ref", "git stash drop stash@{1}"],
    ["worktree remove -f", "git worktree remove -f ../wt"],
    ["worktree remove --force", "git worktree remove --force ../wt"],
    ["worktree remove -f -f", "git worktree remove -f -f ../wt"],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => {
      expectBlocked(command);
      expect(matchBlockedCommand(command)).toContain("되돌릴 수 없게");
    });
  }

  const allowed = [
    ["checkout a branch", "git checkout main"],
    ["checkout -b", "git checkout -b feature"],
    ["checkout a single file", "git checkout -- src/a.ts"],
    ["checkout a file from a revision", "git checkout HEAD~1 -- src/a.ts"],
    ["checkout -b with a dotted name", "git checkout -b fix.x"],
    ["checkout a dotfile", "git checkout -- .gitignore"],
    ["restore a single file", "git restore src/a.ts"],
    ["restore --staged is index-only", "git restore --staged ."],
    ["restore -S is index-only", "git restore -S ."],
    ["switch a branch", "git switch main"],
    ["switch -c", "git switch -c feature"],
    ["stash", "git stash"],
    ["stash push", "git stash push -m drop"],
    ["stash list", "git stash list"],
    ["stash pop", "git stash pop"],
    ["stash apply", "git stash apply"],
    ["worktree add", "git worktree add ../wt"],
    ["worktree list", "git worktree list"],
    ["worktree remove without force", "git worktree remove ../wt"],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

describe("deploy-live 스크립트와 mysql 묶음 옵션", () => {
  const blocked = [
    ["direct deploy-live script", "./Tools/CUELO_Setup/deploy-live.ps1"],
    ["pwsh positional script", "pwsh Tools/CUELO_Setup/deploy-live.ps1"],
    ["pwsh -File", "pwsh -NoProfile -ExecutionPolicy Bypass -File Tools/CUELO_Setup/deploy-live.ps1"],
    ["Windows PowerShell with policy then script", "powershell.exe -ExecutionPolicy Bypass .\\Tools\\CUELO_Setup\\deploy-live.ps1"],
    ["pwsh working-directory value before the script", "pwsh -wd C:\\x .\\deploy-live.ps1"],
    ["bash deploy-live script", "bash Tools/CUELO_Setup/deploy-live.sh"],
    ["mysql -Ne", 'mysql -Ne "DROP TABLE x"'],
    ["mysql -Nse", 'mysql -Nse "DROP TABLE x"'],
    ["mysql -Be TRUNCATE", 'mysql -Be "TRUNCATE x"'],
    ["mysql password flag before -e", 'mysql -u root -p -e "DROP TABLE x"'],
    ["mysql attached user and password", 'mysql -uroot -psecret -Ne "DROP TABLE x"'],
    ["mysql database value before the cluster", 'mysql -D db -Ne "DROP TABLE x"'],
    ["mysql attached query", 'mysql -e"DROP TABLE x"'],
    ["mariadb repeated verbose flag", 'mariadb -vvv -e "DROP TABLE x"'],
    ["mysql --execute with a separate value", 'mysql --execute "DROP TABLE x"'],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["verify script", "pwsh Tools/CUELO_Setup/verify.ps1"],
    ["pwsh -File of another script", "pwsh -NoProfile -File verify.ps1"],
    ["pwsh -Command", "pwsh -Command Get-Date"],
    ["reading the deploy script", "cat Tools/CUELO_Setup/deploy-live.ps1"],
    ["diffing the deploy script", "git diff -- deploy-live.ps1"],
    ["mysql clustered SELECT", 'mysql -Ne "SELECT 1"'],
    ["mysql clustered literal", `mysql -Nse "SELECT 'DROP TABLE x'"`],
    ["mysql database named like a verb", 'mysql -D drop_db -Ne "SELECT 1"'],
    ["mysql password that looks like -e", 'mysql -uroot -pe -e "SELECT 1"'],
    ["mysql password that looks like a verb", 'mysql -pDROP -e "SELECT 1"'],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

describe("값을 받는 짧은 옵션·ionice·printf·heredoc 구분자", () => {
  const blocked = [
    ["git clean -e with an attached pattern is not a dry run", "git clean -fd -enode_modules"],
    ["git restore -s with an attached source", "git restore -sSTABLE ."],
    ["git restore -s attached source and top pathspec", "git restore -sHEAD~1 :/"],
    ["git push -o with an attached push option is not a dry run", "git push -onitro origin main"],
    ["ionice -t takes no argument", "ionice -t git reset --hard"],
    ["ionice -t after class options", "ionice -c 3 -t git reset --hard"],
    ["printf format with an empty %s", "printf 'git reset --hard\\n%s' '' | bash"],
    ["printf format filled by an argument", "printf 'git %s --hard\\n' reset | bash"],
    ["printf %b argument", "printf '%b' 'git reset --hard\\n' | bash"],
    ["printf format repeated for every argument", "printf '%s\\n' 'echo hi' 'git reset --hard' | bash"],
    ["printf SQL with substituted table", "printf 'DROP TABLE %s;\\n' users | mysql"],
    ["unquoted heredoc substitution stays live", "cat <<EOF\n$(git reset --hard)\nEOF"],
    ["command after an empty-delimiter heredoc", "cat <<''\ntext\n\ngit reset --hard"],
    ["empty-delimiter heredoc fed to a shell", "bash <<''\ngit reset --hard\n\n"],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["git clean with a dry run and a pattern", "git clean -fdn -e node_modules"],
    ["git switch -c with an attached branch name containing f", "git switch -cfeature"],
    ["git checkout -b with an attached branch name containing f", "git checkout -bfix main"],
    ["git tag -m with an attached message containing d", "git tag -mdelete v1"],
    ["git restore -s then --staged", "git restore -sSTABLE --staged ."],
    ["ionice -t with a harmless command", "ionice -t git status"],
    ["printf harmless script", "printf '%s\\n' 'echo hi' | bash"],
    ["printf joins %s values without spaces", "printf '%s' git reset --hard | bash"],
    ["printf with an empty %s and a harmless line", "printf 'git status\\n%s' '' | bash"],
    ["empty-delimiter heredoc body is inert", "cat <<''\ngit reset --hard\n\n"],
    ["heredoc delimiter quoted in the middle (backslash)", "cat <<E\\OF\n$(git reset --hard)\nEOF"],
    ["heredoc delimiter quoted in the middle (single quotes)", "cat <<'E'OF\n$(git reset --hard)\nEOF"],
    ["heredoc delimiter quoted in the middle (double quotes)", 'cat <<E"O"F\n$(git reset --hard)\nEOF'],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

describe("옵션 값 걷어내기와 printf 너비·정밀도", () => {
  const blocked = [
    ["git clean --exclude with a separate value that looks like -n", "git clean -fd --exclude -n"],
    ["git clean abbreviated --exclude value", "git clean -fd --exc -n"],
    ["git clean --exclude=-n attached value", "git clean -fd --exclude=-n"],
    ["git commit -m value that looks like --dry-run", "git commit -m --dry-run"],
    ["git commit --message value that looks like --dry-run", "git commit --message --dry-run"],
    ["git push --push-option value that looks like -n", "git push --push-option -n origin main"],
    ["git push -o separate value that looks like -n", "git push -o -n origin main"],
    ["git restore --source value that looks like --staged", "git restore --source --staged ."],
    ["printf precision keeps three characters", "printf '%.3s reset --hard\\n' github | bash"],
    ["printf precision from an argument", "printf '%.*s reset --hard\\n' 3 github | bash"],
    ["printf width padding trailing spaces", "printf '%-20s\\n' 'git reset --hard' | bash"],
    ["printf format repeated with a precision", "printf '%.3s reset --hard\\n' github gitlab | bash"],
    ["printf %b with a trailing \\c", "printf '%b\\n' 'git reset --hard\\c' | bash"],
    ["printf output before an invalid conversion", "printf 'git reset --hard\\n%z' | bash"],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expectBlocked(command));
  }

  const allowed = [
    ["git clean dry run next to an exclude", "git clean -n --exclude -f"],
    ["git tag --message value that looks like -d", "git tag --message -d v1"],
    ["printf precision 0 prints nothing", "printf '%.0s' 'git reset --hard' | bash"],
    ["printf precision cuts the command", "printf '%.3s\\n' 'git reset --hard' | bash"],
    ["printf %b \\c ends all output", "printf '%b' 'echo hi\\cgit reset --hard' | bash"],
    ["printf %b \\c skips the rest of the format", "printf 'x%b git reset --hard\\n' 'a\\c' | bash"],
    ["printf stops at an invalid conversion", "printf '%z git reset --hard\\n' | bash"],
    ["printf float conversion", "printf '%5.1f\\n' 3.14 | bash"],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expectAllowed(command));
  }
});

// 2026-10-28 가드 감사(doc/history/2026/10/28-guard-audit, cg.py.txt)가 원문으로 확인한 command-guard 차단 22건의 회귀 사례.
// 문맥은 index.ts의 실제 판정을 흉내 낸다: 세션 저장소가 아님을 증명하지 못한 곳은 모두 세션 저장소로 보고(차단), 어느 저장소에도
// 속하지 않음은 /tmp 아래와 그 세션의 새 저장소 자리에서만, 임시 작업 트리는 /tmp 아래에서만 증명된다.
describe("2026-10-28 감사 사례: 오탐은 통과, 실제 포착은 차단", () => {
  const SESSION = "/home/user/src/CUELO-private";
  const context = (cwd = SESSION): GuardContext => ({
    cwd,
    temporaryRoot: "/tmp",
    isSessionRepository: () => true,
    isOutsideRepository: (directory) =>
      directory.startsWith("/tmp/") || directory.startsWith("/home/user/omp-cwd-20261023/"),
    isTemporaryDirectory: (directory) => directory.startsWith("/tmp/"),
  });

  const allowed = [
    [
      "grep pattern with an escaped quote and deploy words (10-23 13:45:30)",
      String.raw`grep -rnE "RULES\.md.{0,6}(의|) ?(「|\")?(WSL 작업 결과|WSL 배포|배포 확인|CI 감시)|RULES.md.{0,30}(WSL deploy|Deploy confirmation|CI watching|Reflecting WSL)" --include=*.md . 2>/dev/null | grep -v node_modules`,
    ],
    [
      "checkout --detach -f inside /tmp/xr-sync (10-23 21:39:28)",
      "cd /tmp/xr-sync && git checkout -q --detach -f 2d27957e9003747e69a0d8e3ba65668b8741ebb6 && git status --porcelain | head -3",
    ],
    [
      "own /tmp worktree removed with --force (10-26 22:02:04)",
      "git worktree add -q --detach /tmp/cuelo-head HEAD && cd /tmp/cuelo-head && bun test x.test.mjs | grep pass; cd /home/user/src/CUELO-private && git worktree remove --force /tmp/cuelo-head && echo cleaned",
    ],
    [
      "/tmp worktree removed from the repository (10-26 23:06:46)",
      "cd /home/user/src/CUELO-private && git worktree add -q /tmp/hk-base HEAD 2>&1 | tail -1; cd /home/user/src/CUELO-private && rm /tmp/hk-base/node_modules && git worktree remove --force /tmp/hk-base && git worktree list",
    ],
    [
      "git init and add -A in a mktemp copy (10-26 00:54:37)",
      'set -e; T=$(mktemp -d /tmp/cuelo-manifest.XXXXXX); git ls-files -z --cached | tar --null -T - -cf - | tar -xf - -C "$T"; (cd "$T" && git init -q && git add -A >/dev/null 2>&1); rm -rf "$T"',
    ],
    [
      "public mirror dry run in a mktemp clone (10-27 07:08:55)",
      'set -euo pipefail\nW=$PWD; R=$(mktemp -d); public="$R/public"\ngit clone -q --depth 1 https://github.com/x/y.git "$public"\ngit -C "$public" rm -rq --ignore-unmatch .\ngit -C "$public" add -A\n(cd "$public" && python3 "$R/redact.py" && git add -A)\ngit -C "$public" diff --cached --stat | tail -3',
    ],
    ["git add -N on the session repository (10-19 19:31:43)", "cd ~/src/CUELO-private && git add -N doc/history/2026/10/19-x && git diff --check"],
    ["git add -N after an unknown cd (10-28 07:09:34)", "cd /w/m/Tools/CUELO_Setup && grep -n x f.js | head -3; cd ../.. && git add -N Tools/x.ts && git ls-files Tools/x.ts"],
    ["git add --intent-to-add", "git add --intent-to-add lib/new.ts"],
  ] as const;
  for (const [name, command] of allowed) {
    test(`allows ${name}`, () => expect(matchBlockedCommand(command, context())).toBeUndefined());
  }

  test("allows git init and commit in a new repository outside any repository (10-23 22:11:53)", () => {
    const command =
      'mkdir -p /tmp/plcfix3/hold && git init -q && git add -A && git -c user.name=review -c user.email=review@local commit -qm "sources + empty docs"';
    expect(matchBlockedCommand(command, context("/home/user/omp-cwd-20261023/plc_review"))).toBeUndefined();
  });

  const blocked = [
    ["git.exe stash drop chain (10-19 23:40:16)", "git.exe stash drop stash@{2} && git.exe stash drop stash@{1} && git.exe stash list"],
    ["quoted stash ref drop (10-24 00:37:15)", "git stash drop 'stash@{1}' && git diff --check"],
    ["stash drop after restore --staged (10-25 10:14:48)", "git restore --staged . && git stash drop && grep -c x HANDOFF.md"],
    ["add then stash drop (10-24 07:35:18)", "git add doc/README.md && git stash drop"],
    ["stash drop from a /tmp worktree still drops the shared stash", "cd /tmp/x && git stash drop"],
    ["gh release edit publishes release notes (10-18 20:08:45)", "python3 - <<'EOF'\nopen('/tmp/n.md','w').write('x')\nEOF\ngh release edit v0.10.31 -R x/y --notes-file /tmp/n.md"],
    ["sqlcmd DROP DATABASE (10-23 07:51:09)", `sqlcmd.exe -S 'localhost\\SQLEXPRESS' -d master -E -Q "DROP DATABASE HanseERP_AutoTest_perfgw"`],
    ["add -A after cd behind ';' may run in the session repository (10-17 21:17:55)", "D=~/omp-cwd-x; mkdir -p $D/.omp && cd $D && git init -q; echo x > README.md; git add -A"],
    ["worktree remove --force of an unknown path (10-28 00:22:03)", "for n in a b; do git worktree remove --force /home/user/src/dv-scratch/$n; done"],
    ["worktree remove --force outside the temp root", "git worktree remove --force ../scratch"],
    ["push from a mktemp clone", 'R=$(mktemp -d) && git clone -q https://github.com/x/y.git "$R/c" && git -C "$R/c" push origin main'],
    ["commit in a worktree the same command adds", "git worktree add /tmp/w main && cd /tmp/w && git commit -am x"],
    ["GIT_DIR points the add back at the session repository", "cd /tmp/x && GIT_DIR=/home/user/src/CUELO-private/.git git add -A"],
    ["GIT_WORK_TREE checkout -f from /tmp", "cd /tmp/x && GIT_WORK_TREE=/home/user/src/CUELO-private git checkout -f ."],
    ["child shell does not see an unexported mktemp variable", "T=$(mktemp -d); bash -c 'git -C \"$T\" add -A'"],
    ["mktemp template without --tmpdir is relative to the session cwd", 'T=$(mktemp -d scratch.XXXX) && git -C "$T" add -A'],
    ["variable reassigned to an unknown value", 'T=$(mktemp -d); T=$PWD; git -C "$T" add -A'],
    ["escaped git push", "g\\it push origin main"],
    ["escaped git push inside bash -c", 'bash -c "g\\it push origin main"'],
    ["escaped git push inside a shell heredoc", "bash <<'EOF'\ng\\it push origin main\nEOF"],
    // 2026-10-28 교차 검토(xr-20261027230602-20ecef) R1-OAI-2·3·4·7.
    ["inherited GIT_DIR reaches a child shell's commit", "GIT_DIR=/home/user/src/CUELO-private/.git GIT_WORK_TREE=/home/user/src/CUELO-private bash -c 'git -C /tmp/empty commit --allow-empty -m probe'"],
    ["commit in a worktree a child shell added", "bash -c 'git worktree add --detach /tmp/nw HEAD' && git -C /tmp/nw commit --allow-empty -m probe"],
    ["commit through a symlink the same command creates", "ln -s /home/user/src/CUELO-private /tmp/new-link && git -C /tmp/new-link commit --allow-empty -m probe"],
    ["checkout -f through a symlink the same command creates", "ln -sfn /home/user/src/CUELO-private /tmp/l && git -C /tmp/l checkout -f ."],
    ["add in a path the same command moved", "mv /tmp/old /tmp/moved && cd /tmp/moved && git add -A"],
    ["link destination behind a -t cluster", "ln -st /tmp/dir /home/user/src/CUELO-private && git -C /tmp/dir/CUELO-private add -A"],
    // R2-OAI-1: 피연산자 하나인 ln은 현재 폴더에 원본 이름의 링크를 만든다.
    ["commit through a single-operand ln link", "cd /tmp && ln -s /home/user/src/CUELO-private && git -C /tmp/CUELO-private commit -m test"],
    ["intent-to-add turned off again", "git add -N --no-intent-to-add new.ts"],
    ["intent-to-add turned off before -N", "git add --no-intent-to-add -N new.ts"],
    // R3-OAI-1: 값을 받는 옵션이 피연산자 하나인 ln을 둘처럼 보이게 하면 안 된다.
    ["single-operand ln behind --suffix", "cd /tmp && ln -s --suffix .bak /home/user/src/CUELO-private && git -C /tmp/CUELO-private commit -m t"],
    ["single-operand ln behind a -S cluster", "cd /tmp && ln -sS .bak /home/user/src/CUELO-private && git -C /tmp/CUELO-private commit -m t"],
    // R4-OAI-1: 다른 옵션의 붙은 값(--backup=none)은 명시한 목적지가 아니다.
    ["single-operand ln behind an inline option value", "cd /tmp && ln -s --backup=none /home/user/src/CUELO-private && git -C /tmp/CUELO-private commit -m t"],
    // R2-ADV-1: 같은 명령이 .git 링크·gitdir 파일을 만들면 그 부모 폴더의 git은 세션 저장소를 연다.
    ["commit beside a linked .git", "mkdir -p /tmp/x && ln -s /home/user/src/CUELO-private/.git /tmp/x/.git && git -C /tmp/x commit -m t"],
    ["checkout -f beside a gitdir file", 'mkdir -p /tmp/x && echo "gitdir: /home/user/src/CUELO-private/.git" > /tmp/x/.git && git -C /tmp/x checkout -f main'],
    ["commit beside an escaped .git link", "mkdir -p /tmp/x && ln -s /home/user/src/CUELO-private/.g\\it /tmp/x/.g'i't && git -C /tmp/x commit -m t"],
  ] as const;
  for (const [name, command] of blocked) {
    test(`blocks ${name}`, () => expect(matchBlockedCommand(command, context())).toBeDefined());
  }

  // R1-OAI-1: 셸이 건너뛰는 대입·cd를 믿으면 세션 저장소 push가 다른 저장소의 push로 보인다.
  test("a skipped assignment or cd does not move the git target", () => {
    const elsewhere: GuardContext = { ...context(), isSessionRepository: (directory) => directory.startsWith(SESSION) };
    for (const command of [
      `T=${SESSION}; false && T=/tmp/ext; git -C "$T" push`,
      `T=${SESSION}; true || T=/tmp/ext && git -C "$T" push`,
      `T=${SESSION}; T=/tmp/ext | cat; git -C "$T" push`,
      "true || cd /tmp/ext && git push",
      "cd /tmp/ext | cat && git push",
    ]) {
      expect(matchBlockedCommand(command, elsewhere)).toBeDefined();
    }
    // 끊기지 않은 && 사슬의 대입은 그대로 따라간다.
    expect(matchBlockedCommand('mkdir -p /tmp/a && T=/tmp/a/r && git -C "$T" push', elsewhere)).toBeUndefined();
  });

  test("a link elsewhere in the temporary tree keeps the worktree removal exempt (10-26 22:02:04 원문)", () => {
    const command =
      "git worktree add -q --detach /tmp/cuelo-head HEAD && ln -s /home/user/src/CUELO-private/node_modules /tmp/cuelo-head/node_modules && cd /tmp/cuelo-head && bun test x.test.mjs | grep pass; cd /home/user/src/CUELO-private && git worktree remove --force /tmp/cuelo-head";
    expect(matchBlockedCommand(command, context())).toBeUndefined();
    // 10-26 23:06:46 원문: ;로 위치를 모르게 된 뒤의 절대경로 링크도 worktree 제거를 막지 않는다.
    const after =
      "cd /home/user/src/CUELO-private && git worktree add -q /tmp/hk-base HEAD 2>&1 | tail -1; ln -s /home/user/src/CUELO-private/node_modules /tmp/hk-base/node_modules; cd /tmp/hk-base/Tools && bun test x.test.ts 2>&1 | tail -8; cd /home/user/src/CUELO-private && rm /tmp/hk-base/node_modules && git worktree remove --force /tmp/hk-base && git worktree list";
    expect(matchBlockedCommand(after, context())).toBeUndefined();
  });

  // R3-OAI-2: "어느 저장소도 아님"의 증명은 git의 그 진단 전체여야 한다. 경로에 문구가 든 다른 진단은 증명이 아니다.
  test("only git's whole not-a-repository diagnostic proves the absence of a repository", () => {
    expect(isNotRepositoryDiagnostic("fatal: not a git repository (or any of the parent directories): .git\n")).toBe(true);
    expect(
      isNotRepositoryDiagnostic(
        "fatal: not a git repository (or any parent up to mount point /tmp)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n",
      ),
    ).toBe(true);
    expect(isNotRepositoryDiagnostic("fatal: detected dubious ownership in repository at '/tmp/not a git repository'\n")).toBe(false);
    expect(isNotRepositoryDiagnostic("warning: x\nfatal: not a git repository (or any of the parent directories): .git\n")).toBe(false);
  });
});
