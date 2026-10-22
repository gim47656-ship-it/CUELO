import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractRelativeLinks, lintDocmap, renderDocmapLint } from "../lib/docmap-lint";

const made: string[] = [];
const LINT = join(import.meta.dir, "..", "lib", "docmap-lint.ts");

/** 폴더 안의 모든 파일 경로와 바이트(16진수, 없는 폴더 구성까지)를 한 객체로 떠 둔다. 읽기 전용 검사는 이 객체가 그대로인지 본다. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) { out[`${path}/`] = ""; visit(path); } else out[path] = readFileSync(path).toString("hex");
    }
  };
  visit(dir);
  return out;
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "docmap-lint-"));
  made.push(dir);
  mkdirSync(join(dir, ".git"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function record(title: string, scope: string | undefined, status = "accepted", body = ""): string {
  return `# ${title}\n\nRECORD:\nDATE: 2026-10-05\n${scope === undefined ? "" : `SCOPE: ${scope}\n`}PATHS: lib/\nSTATUS: ${status}\n\n## 경과\n\n${body}\n`;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "docmap-lint-none-"));
  made.push(dir);
  return dir;
}

const hist = (name: string, file = "main.md") => `doc/history/2026/10/${name}/${file}`;

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("지도에 없는 기록", () => {
  test("지도에 링크된 기록은 빼고, 다른 문서가 링크하는 기록과 아무도 링크하지 않는 기록을 가른다", () => {
    const dir = repo({
      "HANDOFF.md": "# HANDOFF\n",
      "doc/README.md": "# 지도\n\n- [mapped](history/2026/10/01-mapped/main.md)\n",
      [hist("01-mapped")]: record("mapped", "mapped scope"),
      [hist("02-elsewhere")]: record("elsewhere", "elsewhere scope"),
      [hist("03-lonely")]: record("lonely", "lonely scope"),
      // evidence 파일로만 가는 링크는 기록 자체를 가리키지 않는다.
      [hist("04-evidence-only")]: record("evidence only", "evidence scope"),
      [hist("05-linker")]: record("linker", "linker scope", "accepted", "[x](../02-elsewhere/main.md) [y](../04-evidence-only/evidence/a.log)"),
      "doc/history/2026/10/04-evidence-only/evidence/a.log": "log",
      "doc/history/2026/10/05-linker/x.md": "x",
    });
    const r = lintDocmap(dir)!;
    expect(r.unmapped.linkedElsewhere).toEqual(["doc/history/2026/10/02-elsewhere"]);
    expect([...r.unmapped.noInboundLink].sort()).toEqual(["doc/history/2026/10/03-lonely", "doc/history/2026/10/04-evidence-only", "doc/history/2026/10/05-linker"]);
  });

  test("handoff-closure 사본이 한 링크는 다른 문서의 링크로 세지 않고, 자기 폴더 안의 링크도 세지 않는다", () => {
    const dir = repo({
      "HANDOFF.md": "# HANDOFF\n",
      "doc/README.md": "# 지도\n",
      "doc/history/2026/10/08-handoff-closure.md": "# closure\n\nRECORD:\nSCOPE: closure\n\n[a](10-target/main.md)\n",
      [hist("10-target")]: record("target", "target scope", "accepted", "[self](main.md)"),
    });
    const r = lintDocmap(dir)!;
    expect(r.unmapped.noInboundLink).toContain("doc/history/2026/10/10-target");
    expect(r.unmapped.linkedElsewhere).toEqual([]);
  });

  test("대표 파일에 RECORD:·SCOPE:가 없는 기록을 지도에 있어도 따로 알린다", () => {
    const dir = repo({
      "HANDOFF.md": "# HANDOFF\n",
      "doc/README.md": "# 지도\n\n[a](history/2026/10/01-bare/main.md) [b](history/2026/10/02-noscope/main.md) [c](history/2026/10/03-ok/main.md)\n",
      [hist("01-bare")]: "# bare\n\n## 경과\n\n본문\n",
      [hist("02-noscope")]: record("noscope", undefined),
      [hist("03-ok")]: record("ok", "ok scope"),
    });
    const r = lintDocmap(dir)!;
    expect(r.headerGaps.noRecordHeader).toEqual(["doc/history/2026/10/01-bare"]);
    expect(r.headerGaps.noScope).toEqual(["doc/history/2026/10/01-bare", "doc/history/2026/10/02-noscope"]);
    expect(r.unmapped.noInboundLink).toEqual([]);
  });
});

describe("끊어진 링크", () => {
  test("지도·HANDOFF·기록의 없는 대상만 실제 문제로 올리고 코드 안·밖 링크·사본은 따로 센다", () => {
    const dir = repo({
      "HANDOFF.md": "# HANDOFF\n\n[gone](doc/gone.md) [ok](doc/README.md) [web](https://example.com/x.md)\n",
      "doc/README.md": "# 지도\n\n[a](history/2026/10/01-a/main.md) [bad](history/2026/10/09-missing/main.md)\n\n```\n[example](not/real.md)\n```\n",
      [hist("01-a")]: record("a", "a scope", "accepted", "[ev](evidence/x.log) `[inline](nope.md)` [up](../../../../../../outside.md)"),
      "doc/history/2026/10/09-handoff-closure.md": "# closure\n\nRECORD:\nSCOPE: closure\n\n[x](doc/one.md) [y](doc/two.md)\n",
    });
    const r = lintDocmap(dir)!;
    const real = r.missingTargets.real.map((l) => `${l.source}:${l.line} ${l.href}`).sort();
    expect(real).toEqual(["HANDOFF.md:3 doc/gone.md", "doc/README.md:3 history/2026/10/09-missing/main.md", `${hist("01-a")}:11 evidence/x.log`].sort());
    expect(r.missingTargets.snapshotCount).toBe(2);
    expect(r.missingTargets.outsideRoot).toBe(1);
  });

  test("extractRelativeLinks는 코드 블록·인라인 코드·URL·앵커·절대 경로를 건너뛰고 쿼리·앵커를 뗀다", () => {
    const text = "[a](x.md#h) [b](y%20z.md?q=1) [c](#top) [d](/abs.md) [e](mailto:a@b.c) `[f](f.md)`\n~~~\n[g](g.md)\n~~~\n[h](<h i.md>)";
    expect(extractRelativeLinks(text)).toEqual([
      { line: 1, href: "x.md" },
      { line: 1, href: "y%20z.md" },
      { line: 5, href: "h i.md" },
    ]);
  });

  test("extractRelativeLinks는 목적지 뒤에 글이 이어지는 `[x](읽은 줄)` 같은 것은 링크로 세지 않고, 제목이 붙은 링크와 한 낱말 목적지는 센다", () => {
    const text = [
      "[코드](읽은 줄) [측정](베이스 .blend 읽기 전용 측정) [6]~[8](Main 조건의 경합 창) [23e](접두·stamp·옛 stamp 2종 재구축)",
      '[a](a.md "제목") [b](b.md \'제목\') [c](c.md (제목)) [d](<d e.md> "t") [23d](dense) [13](r2)',
      // 닫히지 않은 `<` 목적지와 `<`가 든 꺾쇠 목적지는 링크가 아니다.
      "[x](<broken.md) [y](<a<b>) [z](<ok.md>)",
    ].join("\n");
    expect(extractRelativeLinks(text).map((l) => `${l.line}:${l.href}`)).toEqual(["2:a.md", "2:b.md", "2:c.md", "2:d e.md", "2:dense", "2:r2", "3:ok.md"]);
  });

  test("extractRelativeLinks는 ```` 안의 짧은 ```로 코드 블록이 닫히지 않고, 같은 길이 이상으로 닫으면 끝난다", () => {
    // 앞쪽은 ```` 안에서 ```가 닫지 못함, 뒤쪽은 ```ts를 더 긴 ````가 닫음, 마지막 ```는 닫히지 않아 끝까지 코드다.
    const text = "````md\n```\n[in1](in1.md)\n```\n[in2](in2.md)\n````\n[out](out.md)\n\n```ts\n[c](c.md)\n```` \n[d](d.md)\n```\n[e](e.md)";
    expect(extractRelativeLinks(text).map((l) => l.href)).toEqual(["out.md", "d.md"]);
  });

  test("CRLF 줄바꿈 문서에서도 코드 블록 안의 링크는 끊어진 링크로 세지 않는다", () => {
    expect(extractRelativeLinks("```\r\n[x](missing.md)\r\n```\r\n[y](out.md)\r\n").map((l) => `${l.line}:${l.href}`)).toEqual(["4:out.md"]);
    const dir = repo({ "HANDOFF.md": "# HANDOFF\n", "doc/README.md": "# 지도\r\n\r\n```\r\n[x](missing.md)\r\n```\r\n" });
    expect(lintDocmap(dir)!.missingTargets.real).toEqual([]);
  });
});

describe("superseded-by", () => {
  const status = (to: string) => `superseded-by doc/history/2026/10/${to}/main.md`;
  const base = (extra: Record<string, string>) => repo({ "HANDOFF.md": "# HANDOFF\n", "doc/README.md": "# 지도\n", ...extra });

  test("대상이 없으면 올리고, 있는 기록·있는 정본 문서로 가는 것은 올리지 않는다", () => {
    const r = lintDocmap(
      base({
        [hist("01-gone")]: record("gone", "gone", status("99-nowhere")),
        [hist("02-ok")]: record("ok", "ok", status("03-new")),
        [hist("03-new")]: record("new", "new"),
        [hist("04-canon")]: record("canon", "canon", "superseded-by docs/guide.md"),
        "docs/guide.md": "# guide\n",
      }),
    )!;
    expect(r.superseded.missingTarget.map((p) => p.record)).toEqual(["doc/history/2026/10/01-gone"]);
    expect(r.superseded.cycles).toEqual([]);
    expect(r.superseded.tooLong).toEqual([]);
  });

  test("순환은 한 번만 올리고 자기 자신을 가리키는 것도 순환이다", () => {
    const r = lintDocmap(
      base({
        [hist("01-a")]: record("a", "a", status("02-b")),
        [hist("02-b")]: record("b", "b", status("01-a")),
        [hist("03-self")]: record("self", "self", status("03-self")),
      }),
    )!;
    expect(r.superseded.cycles).toHaveLength(2);
    const ab = r.superseded.cycles.find((c) => c.chain.includes("doc/history/2026/10/01-a"))!;
    expect(ab.chain.slice(0, -1).sort()).toEqual(["doc/history/2026/10/01-a", "doc/history/2026/10/02-b"]);
  });

  test("3단까지는 괜찮고 4단째부터 올리며 사슬 맨 앞 기록만 올린다", () => {
    const r = lintDocmap(
      base({
        [hist("01-a")]: record("a", "a", status("02-b")),
        [hist("02-b")]: record("b", "b", status("03-c")),
        [hist("03-c")]: record("c", "c", status("04-d")),
        [hist("04-d")]: record("d", "d", status("05-e")),
        [hist("05-e")]: record("e", "e"),
        [hist("11-p")]: record("p", "p", status("12-q")),
        [hist("12-q")]: record("q", "q", status("13-r")),
        [hist("13-r")]: record("r", "r", status("14-s")),
        [hist("14-s")]: record("s", "s"),
      }),
    )!;
    expect(r.superseded.tooLong.map((p) => p.record)).toEqual(["doc/history/2026/10/01-a"]);
    expect(r.superseded.tooLong[0]!.chain).toHaveLength(5);
  });

  test("기록 폴더 안의 없는 파일을 가리키면 폴더 이름만 맞아도 대상 없음이다", () => {
    const r = lintDocmap(
      base({
        [hist("01-a")]: record("a", "a", "superseded-by doc/history/2026/10/02-b/nope.md"),
        [hist("02-b")]: record("b", "b"),
        [hist("03-c")]: record("c", "c", "superseded-by doc/history/2026/10/02-b/main.md"),
      }),
    )!;
    expect(r.superseded.missingTarget.map((p) => p.record)).toEqual(["doc/history/2026/10/01-a"]);
  });

  test("마지막 대상이 정본 문서여도 한 단으로 세어 3단 초과를 알린다", () => {
    const canon = "superseded-by docs/guide.md";
    const r = lintDocmap(
      base({
        "docs/guide.md": "# guide\n",
        // 기록 3칸 + 정본 1칸 = 4단
        [hist("01-a")]: record("a", "a", status("02-b")),
        [hist("02-b")]: record("b", "b", status("03-c")),
        [hist("03-c")]: record("c", "c", status("04-d")),
        [hist("04-d")]: record("d", "d", canon),
        // 기록 2칸 + 정본 1칸 = 3단은 괜찮다
        [hist("11-p")]: record("p", "p", status("12-q")),
        [hist("12-q")]: record("q", "q", status("13-r")),
        [hist("13-r")]: record("r", "r", canon),
      }),
    )!;
    expect(r.superseded.tooLong.map((p) => p.record)).toEqual(["doc/history/2026/10/01-a"]);
    expect(r.superseded.tooLong[0]!.chain.at(-1)).toBe("docs/guide.md");
  });
});

describe("종합 절 후보", () => {
  // 후보 판정은 기록 수에 비례하는 일반어 컷을 쓰므로 주제가 다른 기록을 충분히 둔다.
  const fillers = Object.fromEntries(
    ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "sigma"].map((w, i) => [
      hist(`${String(20 + i)}-${w}`),
      record(`${w} 작업`, `${w} unique${w}`),
    ]),
  );

  test("SCOPE에서 3건 이상 되풀이되는데 정본 제목에 없는 낱말만 올리고, 정본 제목에 있는 낱말·2건뿐인 낱말·제목과 지도 줄에만 되풀이되는 낱말은 올리지 않는다", () => {
    const r = lintDocmap(
      repo({
        "HANDOFF.md": "# HANDOFF\n",
        "doc/README.md": "# 지도\n\n- mapword [t1](history/2026/10/06-t1/main.md)\n- mapword [t2](history/2026/10/06-t2/main.md)\n- mapword [t3](history/2026/10/06-t3/main.md)\n",
        "docs/guide.md": "# 안내\n\n## covered 주제\n",
        ...fillers,
        [hist("01-x")]: record("x", "wormhole covered 스티어링"),
        [hist("02-y")]: record("y", "wormhole covered 스티어링"),
        [hist("03-z")]: record("z", "wormhole covered rarepair"),
        [hist("04-w")]: record("w", "twoonly rarepair"),
        [hist("05-v")]: record("v", "twoonly"),
        // 제목과 지도 줄에만 되풀이되는 과정 낱말은 주제가 아니다.
        [hist("06-t1")]: record("followup cleanup", "soloa"),
        [hist("06-t2")]: record("followup cleanup", "solob"),
        [hist("06-t3")]: record("followup cleanup", "soloc"),
      }),
    )!;
    const terms = r.synthesis.map((c) => c.term);
    expect(terms).toContain("wormhole");
    expect(terms).not.toContain("covered");
    expect(terms).not.toContain("twoonly");
    expect(terms).not.toContain("rarepair");
    expect(terms).not.toContain("followup");
    expect(terms).not.toContain("cleanup");
    expect(terms).not.toContain("mapword");
    const worm = r.synthesis.find((c) => c.term === "wormhole")!;
    expect(worm.records).toBe(3);
    expect(worm.samples).toHaveLength(3);
    expect(worm.samples.every((s) => s.startsWith("doc/history/2026/10/0"))).toBe(true);
  });

  describe("별칭 묶음(doc/docmap-aliases.json)", () => {
    const alias = (groups: string[][]) => ({ "doc/docmap-aliases.json": JSON.stringify({ groups }) });
    // 일반어 상한은 기록 수의 15%이므로 합친 기록 4건이 상한에 걸리지 않도록 기록을 더 둔다.
    const extra = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [hist(`${String(40 + i)}-pad`), record(`pad ${i}`, `padscope${i}`)]));
    const base = { "HANDOFF.md": "# HANDOFF\n", "doc/README.md": "# 지도\n", ...fillers, ...extra };
    const spellings = {
      ...base,
      [hist("01-a")]: record("a", "wormhole"),
      [hist("02-b")]: record("b", "wormhole 웜홀"),
      [hist("03-c")]: record("c", "웜홀"),
      [hist("04-d")]: record("d", "웜홀"),
    };

    test("별칭 파일이 없거나 비어 있으면 출력이 같고 merged 필드도 없다", () => {
      const none = lintDocmap(repo(spellings))!;
      const empty = lintDocmap(repo({ ...spellings, ...alias([]) }))!;
      expect(empty).toEqual({ ...none, root: empty.root });
      expect(none.synthesis.map((c) => c.term)).toContain("웜홀");
      expect(none.synthesis.map((c) => c.term)).not.toContain("wormhole");
      expect(none.synthesis.some((c) => "merged" in c)).toBe(false);
    });

    test("표기가 둘 다 든 기록은 한 번만 세고, 합치면 한 후보로 나오며 항목은 따로 나오지 않는다", () => {
      const r = lintDocmap(repo({ ...spellings, ...alias([["wormhole", "웜홀"]]) }))!;
      const worm = r.synthesis.find((c) => c.term === "wormhole")!;
      // 2(wormhole) + 3(웜홀) - 1(둘 다 든 02-b) = 4. 더하기만 하면 5다.
      expect(worm.records).toBe(4);
      expect(worm.merged).toEqual(["웜홀"]);
      expect(r.synthesis.map((c) => c.term)).not.toContain("웜홀");
      expect(r.synthesis.filter((c) => c.term === "wormhole")).toHaveLength(1);
    });

    test("항목 하나라도 정본 제목에 있으면 묶음 전체가 정본에 있는 것이다", () => {
      const files = {
        ...base,
        "docs/guide.md": "# 안내\n\n## gizmo 안내\n",
        [hist("01-a")]: record("a", "gizmo"),
        [hist("02-b")]: record("b", "gizmo"),
        [hist("04-d")]: record("d", "기즈모"),
        [hist("05-e")]: record("e", "기즈모"),
        [hist("06-f")]: record("f", "기즈모"),
      };
      expect(lintDocmap(repo(files))!.synthesis.map((c) => c.term)).toContain("기즈모");
      const merged = lintDocmap(repo({ ...files, ...alias([["gizmo", "기즈모"]]) }))!.synthesis.map((c) => c.term);
      expect(merged).not.toContain("gizmo");
      expect(merged).not.toContain("기즈모");
    });

    test("해석하지 못하거나 묶음이 잘못된 별칭 파일은 통째로 무시하고 읽지 못한 파일로 알린다", () => {
      const bad: unknown[] = [
        "{ not json",
        JSON.stringify({ groups: "wormhole" }),
        JSON.stringify({ groups: [["wormhole", 3]] }),
        // 다른 묶음은 멀쩡해도 항목이 없는·하나뿐인 묶음, 빈 문자열·중복 항목(대소문자·공백 차이, 묶음 사이 포함)이 하나라도 있으면 파일 전체가 잘못이다.
        JSON.stringify({ groups: [["wormhole", "웜홀"], []] }),
        JSON.stringify({ groups: [["wormhole", "웜홀"], ["lonely"]] }),
        JSON.stringify({ groups: [["wormhole", "웜홀"], ["other", ""]] }),
        JSON.stringify({ groups: [["wormhole", "웜홀", " Wormhole "]] }),
        JSON.stringify({ groups: [["wormhole", "웜홀"], ["other", "웜홀"]] }),
      ];
      for (const text of bad) {
        const r = lintDocmap(repo({ ...spellings, "doc/docmap-aliases.json": String(text) }))!;
        expect(r.unreadable.files).toEqual(["doc/docmap-aliases.json"]);
        // 파일 전체를 무시하므로 멀쩡한 묶음도 적용되지 않는다.
        expect(r.synthesis.map((c) => c.term)).toContain("웜홀");
        expect(r.synthesis.map((c) => c.term)).not.toContain("wormhole");
      }
    });

    test("낱말 하나가 아닌 항목은 잘못된 파일이고, 항목 낱말이 없는 일반 후보를 지우지 않는다", () => {
      const quantum = Object.fromEntries(["a", "b", "c"].map((k, i) => [hist(`1${i}-q${k}`), record(k, "quantum")]));
      for (const group of [["quantum flux", "양자"], ["x-ray", "엑스레이"], ["q", "큐큐"]]) {
        const r = lintDocmap(repo({ ...base, ...quantum, ...alias([group]) }))!;
        expect(r.unreadable.files).toEqual(["doc/docmap-aliases.json"]);
        expect(r.synthesis.map((c) => c.term)).toContain("quantum");
      }
      // 낱말 하나짜리 항목의 유효한 파일은 다른 후보를 지우지 않는다.
      const ok = lintDocmap(repo({ ...base, ...quantum, ...spellings, ...alias([["wormhole", "웜홀"]]) }))!;
      expect(ok.unreadable.files).toEqual([]);
      expect(ok.synthesis.map((c) => c.term)).toContain("quantum");
    });
  });

  test("한글 조각은 조각이 나온 실제 낱말 하나로 합쳐 보여 준다", () => {
    const r = lintDocmap(
      repo({
        "HANDOFF.md": "# HANDOFF\n",
        "doc/README.md": "# 지도\n",
        ...fillers,
        [hist("01-x")]: record("x", "스티어링 수신"),
        [hist("02-y")]: record("y", "스티어링 지연"),
        [hist("03-z")]: record("z", "스티어링 판정"),
      }),
    )!;
    const terms = r.synthesis.map((c) => c.term);
    expect(terms).toContain("스티어링");
    expect(terms).not.toContain("티어");
    expect(terms).not.toContain("어링");
  });

  test("본문 곳곳에 나오는데 SCOPE에는 3번만 적힌 낱말은 집중도가 낮아 뺀다", () => {
    const common = Object.fromEntries(
      Object.entries(fillers).map(([path, text]) => [path, `${text}\n본문에 commonword가 반복된다. commonword commonword.\n`]),
    );
    const r = lintDocmap(
      repo({
        "HANDOFF.md": "# HANDOFF\n",
        "doc/README.md": "# 지도\n",
        ...common,
        [hist("01-x")]: record("x", "commonword realtopic", "accepted", "commonword"),
        [hist("02-y")]: record("y", "commonword realtopic", "accepted", "commonword"),
        [hist("03-z")]: record("z", "commonword realtopic", "accepted", "commonword"),
        [hist("04-a")]: record("a", "uniquea", "accepted", "commonword"),
        [hist("05-b")]: record("b", "uniqueb", "accepted", "commonword"),
        [hist("06-c")]: record("c", "uniquec", "accepted", "commonword"),
      }),
    )!;
    const terms = r.synthesis.map((c) => c.term);
    expect(terms).toContain("realtopic");
    expect(terms).not.toContain("commonword");
  });
});

describe("출력과 실행", () => {
  test("텍스트 출력은 네 구역을 세고, 지도가 없으면 undefined", () => {
    const dir = repo({ "HANDOFF.md": "# HANDOFF\n", "doc/README.md": "# 지도\n", [hist("01-a")]: record("a", "a scope") });
    const text = renderDocmapLint(lintDocmap(dir)!);
    for (const head of ["1. ", "2. ", "3. ", "4. "]) expect(text).toContain(`\n${head}`);
    expect(text).toContain("어디에서도 링크하지 않음: 1");
    expect(lintDocmap(scratch())).toBeUndefined();
  });

  test("CLI는 항상 exit 0이고 --json은 JSON, --limit은 목록을 줄인다", () => {
    const files: Record<string, string> = { "HANDOFF.md": "# HANDOFF\n", "doc/README.md": "# 지도\n" };
    for (let i = 10; i < 16; i++) files[hist(`${i}-r${i}`)] = record(`r${i}`, `scope${i}`);
    const dir = repo(files);
    const run = (...args: string[]) => Bun.spawnSync([process.execPath, LINT, dir, ...args], { cwd: dir });
    const json = run("--json");
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout.toString()).unmapped.noInboundLink).toHaveLength(6);
    const limited = run("--limit", "2");
    expect(limited.exitCode).toBe(0);
    expect(limited.stdout.toString()).toContain("… 4건 더");
  });

  test("--json은 지도가 없을 때와 오류일 때도 JSON 객체를 낸다", () => {
    const none = Bun.spawnSync([process.execPath, LINT, scratch(), "--json"]);
    expect(none.exitCode).toBe(0);
    expect(JSON.parse(none.stdout.toString()).error).toContain("문서 지도를 찾지 못했다");
    expect(Bun.spawnSync([process.execPath, LINT, scratch()]).stdout.toString()).toContain("문서 지도를 찾지 못했다");
    // 지도가 있고 기록 파일을 못 읽으면 말뭉치를 만드는 단계가 던진다.
    const broken = repo({ "HANDOFF.md": "# HANDOFF\n", "doc/README.md": "# 지도\n", [hist("01-a")]: record("a", "a") });
    const file = join(broken, hist("01-a"));
    if (process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      try {
        const err = Bun.spawnSync([process.execPath, LINT, broken, "--json"]);
        expect(err.exitCode).toBe(0);
        expect(typeof JSON.parse(err.stdout.toString()).error).toBe("string");
      } finally {
        chmodSync(file, 0o644);
      }
    }
  });

  test("어떤 실행 방식에서도 저장소의 파일과 폴더 구성이 바이트까지 그대로다", () => {
    const dir = repo({
      "HANDOFF.md": "# HANDOFF\n",
      "doc/README.md": "# 지도\n\n[a](history/2026/10/01-a/main.md)\n",
      [hist("01-a")]: record("a", "a scope", "superseded-by docs/guide.md"),
      [hist("02-b")]: record("b", "b scope"),
      "docs/guide.md": "# 안내\n",
    });
    // UTF-8로 해석하면 0xFF가 바뀌므로, 도구가 파일을 읽고 다시 썼다면 바이트 비교에서만 드러난다.
    writeFileSync(join(dir, "docs/blob.md"), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const before = snapshot(dir);
    lintDocmap(dir);
    for (const args of [[], ["--json"], ["--limit", "1"]]) {
      expect(Bun.spawnSync([process.execPath, LINT, dir, ...args], { cwd: dir }).exitCode).toBe(0);
    }
    expect(snapshot(dir)).toEqual(before);
  });

  test.skipIf(process.getuid?.() === 0)("읽지 못한 .md 파일과 폴더는 조용히 빼지 않고 세어 알린다", () => {
    const dir = repo({ "HANDOFF.md": "# HANDOFF\n", "doc/README.md": "# 지도\n", "docs/secret.md": "# s\n", "docs/locked/inner.md": "# i\n" });
    const secret = join(dir, "docs/secret.md");
    const locked = join(dir, "docs/locked");
    chmodSync(secret, 0o000);
    chmodSync(locked, 0o000);
    try {
      const r = lintDocmap(dir)!;
      expect(r.unreadable).toEqual({ files: ["docs/secret.md"], dirs: ["docs/locked"] });
      expect(renderDocmapLint(r)).toContain("읽지 못해 점검에서 빠진 경로: 2");
      expect(renderDocmapLint(r)).toContain("- 폴더 docs/locked");
      const cli = Bun.spawnSync([process.execPath, LINT, dir, "--json"]);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout.toString()).unreadable.dirs).toEqual(["docs/locked"]);
    } finally {
      chmodSync(secret, 0o644);
      chmodSync(locked, 0o755);
    }
  });
});
