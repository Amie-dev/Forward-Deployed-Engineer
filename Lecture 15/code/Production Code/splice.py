"""Splice real source files into guide chapters.

A guide chapter contains placeholder lines of the form:

    <!--FILE:src/config/env.ts-->

This script replaces each one with a fenced block containing the file's actual
contents, so every code block in the guide is byte-exact by construction rather
than by careful copying.
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
PLACEHOLDER = re.compile(r"^<!--FILE:(.+?)-->$", re.MULTILINE)


def language_for(path: str) -> str:
    if path.endswith(".json"):
        return "json"
    if path.endswith(".env") or path.endswith(".env.example"):
        return "bash"
    return "ts"


def fence(path: str) -> str:
    text = (ROOT / path).read_text(encoding="utf-8").rstrip()
    return f"```{language_for(path)}\n{text}\n```"


def splice(target: pathlib.Path) -> int:
    source = target.read_text(encoding="utf-8")
    count = len(PLACEHOLDER.findall(source))

    def replace(match: re.Match[str]) -> str:
        return fence(match.group(1).strip())

    target.write_text(PLACEHOLDER.sub(replace, source), encoding="utf-8")
    return count


def main() -> None:
    targets = [pathlib.Path(arg) for arg in sys.argv[1:]]
    total = 0

    for target in targets:
        if not target.exists():
            print(f"missing: {target}")
            continue

        spliced = splice(target)
        total += spliced
        print(f"spliced {spliced:2d} file(s) into {target.name}")

    print(f"total: {total}")


if __name__ == "__main__":
    main()
