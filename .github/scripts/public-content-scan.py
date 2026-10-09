"""Refuse personal-looking strings in the public mirror tree.

`.publicdeny` lists known private strings; this catches the shapes it cannot list in
advance: e-mail addresses outside reserved example domains, real user folders in
paths, and Windows machine names. Reads NUL-separated relative paths from stdin and
the tree root from argv[1]. Reports file:line and the kind only, never the value.

Local check: git ls-files -z | python3 .github/scripts/public-content-scan.py .
"""
import re
import sys
from pathlib import Path

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})")
# Reserved for documentation and tests (RFC 2606 / RFC 6761), plus GitHub's noreply form.
ALLOWED_EMAIL_DOMAIN = re.compile(
    r"(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com)$",
    re.IGNORECASE,
)
# Public credits that ship with bundled assets (voice model authors in voices.json).
ALLOWED_EMAILS = {"cs@tr1ppy.com"}

USER_PATH = re.compile(
    r"(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|/c/Users/|/Users/|/home/)([A-Za-z0-9%$~{*._-][^\\/\s\"'`<>()\[\],;:|]*)",
)
# Generic names used in examples and tests, CI runner accounts, and placeholders.
ALLOWED_USER_NAMES = {
    "me", "user", "username", "you", "name", "alex", "test", "x", "xxx", "omp",
    "example", "project", "runner", "runneradmin", "runner~1", "public", "default",
}
MACHINE_NAME = re.compile(r"\b(?:DESKTOP|LAPTOP)-[A-Z0-9]{5,}\b")


def user_name_allowed(name: str) -> bool:
    return name.lower() in ALLOWED_USER_NAMES or name[0] in "$%{*"


def scan(root: Path, paths: list[str]) -> list[str]:
    hits = []
    for rel in paths:
        path = root / rel
        try:
            data = path.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:8192]:
            continue
        text = data.decode("utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), 1):
            for match in EMAIL.finditer(line):
                if match.group(0).lower() in ALLOWED_EMAILS or ALLOWED_EMAIL_DOMAIN.search(match.group(1)):
                    continue
                hits.append(f"{rel}:{number}: e-mail address")
            for match in USER_PATH.finditer(line):
                if not user_name_allowed(match.group(1)):
                    hits.append(f"{rel}:{number}: user folder in a path")
            if MACHINE_NAME.search(line):
                hits.append(f"{rel}:{number}: machine name")
    return hits


def main() -> int:
    root = Path(sys.argv[1])
    paths = [p for p in sys.stdin.buffer.read().decode("utf-8").split("\0") if p]
    hits = scan(root, paths)
    if hits:
        print("::error::Refusing to publish: personal-looking strings at")
        print("\n".join(hits))
        return 1
    print(f"PUBLIC CONTENT SCAN OK: {len(paths)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
