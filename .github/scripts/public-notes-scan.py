"""Refuse internal details in the public CHANGELOG.md and README.md.

The release body is the CHANGELOG section of the version (release.yml), so these two
files must describe only what a user sees. They must not carry: implementation traces
(commit hashes, core patch counts, source files and internal calls, test counts),
personal account operation (a character tied to an account or selection rule), the
models and role grades used to develop CUELO, or the concrete model behind a feature.
Provider and service names (Anthropic, OpenAI Codex, ChatGPT, Google Antigravity,
OpenCode Go), dependency versions and character names stay allowed.

A hit means: rewrite the sentence. There is no allow list to get past it.
Reads the tree root from argv[1]. Reports file:line and the kind only, never the value.

Local check: python .github/scripts/public-notes-scan.py .
"""
import re
import sys
from pathlib import Path

# Korean particles attach directly to ASCII names ("Opus로", "HARD_CODE_SOL이") and are
# word characters to `re`, so `\b` would miss them. Boundaries here are ASCII-only.
L = r"(?<![A-Za-z0-9_])"
R = r"(?![A-Za-z0-9_])"
CHARACTERS = L + r"(?:RIN|MIO|YUKI|ISANA|NOVA|SHION|HIKARI)" + R

# (kind, pattern, files it applies to)
RULES = [
    ("commit hash", re.compile(r"`[0-9a-f]{7,40}`"), {"CHANGELOG.md", "README.md"}),
    # README describes the public harness contents ("SDK core 패치"); only release notes
    # must not report patch work or counts.
    ("core patch detail", re.compile(r"core\s*(?:patch|패치)|코어\s*패치", re.IGNORECASE), {"CHANGELOG.md"}),
    ("model name", re.compile(
        L + r"(?:Opus|Sonnet|Haiku|Gemini|DeepSeek|Muse|Astra|Sol)" + R
        + r"|(?<![A-Za-z])(?:Chat)?GPT[- ]?\d"
        + r"|" + L + r"6\s?PRO" + R
        + r"|" + L + r"SWE-\d"
        + r"|" + L + r"jev-\d",
        re.IGNORECASE,
    ), {"CHANGELOG.md", "README.md"}),
    ("role grade or slot", re.compile(
        L + r"(?:NORMAL|HARD)_[A-Z][A-Z_]*|" + L + r"impl[A-Z][A-Za-z]*" + R
    ), {"CHANGELOG.md", "README.md"}),
    ("character tied to an account", re.compile(
        CHARACTERS + r".*(?:계정|account|OAuth|credential|우선)"
        r"|(?:계정|account|OAuth|credential|우선).*" + CHARACTERS,
        re.IGNORECASE,
    ), {"CHANGELOG.md", "README.md"}),
    ("test count", re.compile(
        L + r"\d+\s*(?:pass|passed|fail|failed|tests?)" + R + r"|테스트\s*\d+\s*건|" + L + r"\d+/\d+" + R,
        re.IGNORECASE,
    ), {"CHANGELOG.md", "README.md"}),
    ("source file or internal call", re.compile(
        r"`[\w./@-]+\.(?:ts|tsx|mjs|js|py)`|`[\w.]+\(\)`"
    ), {"CHANGELOG.md"}),
]

FILES = ("CHANGELOG.md", "README.md")


def scan(root: Path) -> list[str]:
    hits = []
    for name in FILES:
        path = root / name
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), 1):
            for kind, pattern, targets in RULES:
                if name in targets and pattern.search(line):
                    hits.append(f"{name}:{number}: {kind}")
    return hits


def main() -> int:
    root = Path(sys.argv[1])
    hits = scan(root)
    if hits:
        print("::error::Refusing to publish: internal details in public release notes at")
        print("\n".join(hits))
        return 1
    print(f"PUBLIC NOTES SCAN OK: {', '.join(name for name in FILES if (root / name).is_file())}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
