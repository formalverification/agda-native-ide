#!/usr/bin/env python3
"""
File: scripts/python/site/links_hook.py

Description: The MkDocs hook that sends a published page's links to
  unpublished files to GitHub (issue 96).

  The website publishes a chosen part of docs/ (`exclude_docs` in
  mkdocs.yml), and the pages it publishes were written for a reader on
  GitHub: they link relatively into the rest of the repository
  (`../measurements/*.json`, `../../vscode/README.md`, `../upstream/`).  On
  GitHub those links work; on the site they would be 404s, and under
  `--strict` a link to an excluded file fails the build.  The sources stay
  as they are, which is right for their GitHub readers, and this hook
  rewrites each link at build time, before MkDocs validates links, as
  follows:

    +  A relative link whose target is a published page or file is kept,
       and MkDocs validates it, anchor included.  Its anchor is moved from
       GitHub's form to the site's: GitHub keeps one hyphen per space, so
       `## 10.  The library archives` is `#10--the-library-archives` there,
       and Python-Markdown collapses the run (`#10-the-library-archives`),
       whatever slugger is set.  An anchor that still does not resolve fails
       the build in MkDocs' own check.
    +  A relative link whose target is anything else in the repository is
       rewritten to that file or directory on GitHub, on `main`, the branch
       the site deploys from: `blob/main/<path>` for a file,
       `tree/main/<path>` for a directory, with its anchor (GitHub's form,
       which is right there) and its query kept.
    +  A relative link whose target is not in the repository fails the
       build, naming the page, the line, the link and where it resolved.

  "In the repository" means tracked by git, not present on disk: a
  gitignored file, such as `docs/kickoffs/`, exists on the machine that
  builds the site and not on GitHub.  The list of tracked files comes from
  the file `SITE_REPO_FILES` names (one path per line; the flake writes it
  from the flake's source, which holds exactly the tracked files, since
  the Nix sandbox has no git), or else from `git ls-files`.

  Only prose is read: a link inside a code span, a fenced code block or an
  HTML comment is an example and is left as written.  Both link forms are
  rewritten: the inline `[text](target)` and `![alt](target)`, and the
  reference definition `[label]: target`, which is how the ADRs cite files.

  Adapted from agda-native-air's scripts/python/site/links_hook.py at
  8004dc73 (the same author's, Apache-2.0 there), written again here with
  no dependency on that repository's utils package, which this repository
  does not carry.

Design Principles:
  +  Pure core.  `rewrite_links` takes the page's text, where the page is,
     what the site publishes and what the repository tracks, and returns
     the new text and every problem; the MkDocs edge gathers those inputs
     and raises.
  +  Masking, not deleting.  Code and comments are blanked in place, same
     length, newlines kept, so offsets found in the mask edit the original.
"""

from __future__ import annotations

import os
import posixpath
import re
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, FrozenSet, List, Optional, Tuple

# ----------------------------------------------------------------------
# The pure core

DOCS = "docs"

# A URL with a scheme (https:, mailto:), or protocol-relative.
_SCHEME = re.compile(r"^(?:[A-Za-z][A-Za-z0-9+.\-]*:|//)")

# An inline link's destination: `](dest)` or `](dest "title")`, the
# destination with no space and at most one level of nested parentheses.
_INLINE = re.compile(
    r"\]\((?P<dest><[^>\n]*>|(?:[^()\s]|\([^()\s]*\))+)"
    r"(?:\s+(?:\"[^\"\n]*\"|'[^'\n]*'))?\s*\)"
)

# A reference definition, at most three spaces in: `[label]: dest`, then
# at most a title, to the end of the line.  Python-Markdown finds one
# anywhere in a block, so a wrapped line that begins `[#64]: the native
# engine ...` is no definition only because words follow its "dest".
_DEFINITION = re.compile(
    r"^ {0,3}\[[^\[\]\n]+\]:[ \t]*(?P<dest><[^>\n]*>|\S+)"
    r"[ \t]*(?:(?:\"[^\"\n]*\"|'[^'\n]*'|\([^)\n]*\))[ \t]*)?$",
    re.MULTILINE,
)

_FENCE_OPEN = re.compile(r"^[ \t]*(?P<fence>`{3,}|~{3,})")


@dataclass(frozen=True)
class Problem:
    """A link that leads nowhere: on `line` of the page, `link`, which
    resolved to `resolved` (a path from the repository's root)."""

    line: int
    link: str
    resolved: str


@dataclass(frozen=True)
class Site:
    """What a page's links are judged against."""

    published: FrozenSet[str]  # paths under docs/ that the site publishes
    tracked: FrozenSet[str]  # paths from the repository's root
    repo_url: str  # https://github.com/<owner>/<repo>, no trailing slash


def _blank(text: str, start: int, end: int) -> str:
    """`text` with [start, end) replaced by spaces, newlines kept."""
    return text[:start] + re.sub(r"[^\n]", " ", text[start:end]) + text[end:]


def _mask_fences(text: str) -> str:
    """Blank every fenced code block, the fences included."""
    lines = text.splitlines(keepends=True)
    out: List[str] = []
    fence: Optional[str] = None
    for line in lines:
        opened = _FENCE_OPEN.match(line)
        if fence is None and opened:
            fence = opened.group("fence")
            out.append(re.sub(r"[^\n]", " ", line))
        elif fence is not None:
            closing = line.strip()
            if closing.startswith(fence[0] * len(fence)) and set(closing) <= {fence[0]}:
                fence = None
            out.append(re.sub(r"[^\n]", " ", line))
        else:
            out.append(line)
    return "".join(out)


def _mask_comments(text: str) -> str:
    """Blank every HTML comment."""
    for match in reversed(list(re.finditer(r"<!--.*?-->", text, re.DOTALL))):
        text = _blank(text, match.start(), match.end())
    return text


def _mask_code_spans(text: str) -> str:
    """Blank every code span: a run of backticks, to the next run of the
    same length within the same block (a blank line ends a block)."""
    out = text
    i = 0
    while i < len(text):
        if text[i] != "`":
            i += 1
            continue
        run = re.match(r"`+", text[i:])
        width = len(run.group(0)) if run else 1
        block_end = text.find("\n\n", i)
        limit = len(text) if block_end < 0 else block_end
        closer = re.compile(r"(?<!`)" + "`" * width + r"(?!`)")
        close = closer.search(text, i + width, limit)
        if close is None:
            i += width
            continue
        out = _blank(out, i, close.end())
        i = close.end()
    return out


def mask(text: str) -> str:
    """The page's prose: code blocks, comments and code spans blanked in
    place, so every offset still points at the same character."""
    return _mask_code_spans(_mask_comments(_mask_fences(text)))


def site_anchor(fragment: str) -> str:
    """GitHub's anchor for a heading, in the site's form: runs of hyphens
    collapsed, as Python-Markdown's toc collapses whitespace first."""
    return re.sub(r"-{2,}", "-", fragment)


def _split(dest: str) -> Tuple[str, str, str]:
    """A destination's path, query (with its `?`) and fragment (with its
    `#`)."""
    path, hash_, fragment = dest.partition("#")
    path, question, query = path.partition("?")
    return path, question + query, hash_ + fragment


def resolve(page_uri: str, path: str) -> Optional[str]:
    """Where a relative `path` written on the page at `page_uri` (relative
    to docs/) leads, from the repository's root; None if it leaves the
    repository."""
    joined = posixpath.normpath(posixpath.join(DOCS, posixpath.dirname(page_uri), path))
    if joined == ".." or joined.startswith("../"):
        return None
    return "" if joined == "." else joined


def _is_directory(tracked: FrozenSet[str], path: str) -> bool:
    prefix = path.rstrip("/") + "/"
    return path == "" or any(name.startswith(prefix) for name in tracked)


def rewrite_destination(
    site: Site, page_uri: str, dest: str
) -> Tuple[str, Optional[str]]:
    """A destination as the site should carry it, and where it resolved
    when it leads nowhere (None otherwise)."""
    if not dest or _SCHEME.match(dest) or dest.startswith("/"):
        return dest, None
    path, query, fragment = _split(dest)
    if not path:
        return path + query + site_anchor(fragment), None
    resolved = resolve(page_uri, path)
    if resolved is None:
        return dest, posixpath.normpath(posixpath.join(DOCS, posixpath.dirname(page_uri), path))
    under_docs = resolved[len(DOCS) + 1 :] if resolved.startswith(DOCS + "/") else None
    if under_docs is not None and under_docs in site.published:
        return path + query + site_anchor(fragment), None
    if resolved in site.tracked:
        return f"{site.repo_url}/blob/main/{resolved}{query}{fragment}", None
    if _is_directory(site.tracked, resolved):
        tail = resolved.rstrip("/")
        return f"{site.repo_url}/tree/main/{tail}{query}{fragment}", None
    return dest, resolved


def rewrite_links(site: Site, page_uri: str, text: str) -> Tuple[str, Tuple[Problem, ...]]:
    """The page's text with every relative link rewritten for the site,
    and every link that leads nowhere."""
    prose = mask(text)
    spans = sorted(
        [m.span("dest") for m in _INLINE.finditer(prose)]
        + [m.span("dest") for m in _DEFINITION.finditer(prose)]
    )
    problems: List[Problem] = []
    out = text
    for start, end in reversed(spans):
        written = text[start:end]
        angled = written.startswith("<") and written.endswith(">")
        dest = written[1:-1] if angled else written
        new, nowhere = rewrite_destination(site, page_uri, dest)
        if nowhere is not None:
            problems.append(Problem(text.count("\n", 0, start) + 1, dest, nowhere))
        elif new != dest:
            out = out[:start] + (f"<{new}>" if angled else new) + out[end:]
    return out, tuple(sorted(problems, key=lambda p: p.line))


def describe(page: str, problems: Tuple[Problem, ...]) -> str:
    """One line per problem, for the build's error."""
    return "\n".join(
        f"{page}:{p.line}: {p.link} resolves to {p.resolved}, which git does not track"
        for p in problems
    )


# ----------------------------------------------------------------------
# The MkDocs edge


@lru_cache(maxsize=4)
def tracked_files(root: str, listing: Optional[str]) -> FrozenSet[str]:
    """The repository's tracked files: from `listing` when given (one per
    line), else from `git ls-files` in `root`."""
    if listing:
        text = Path(listing).read_text(encoding="utf-8")
    else:
        text = subprocess.run(
            ["git", "-C", root, "ls-files", "-z"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.replace("\0", "\n")
    return frozenset(line for line in text.splitlines() if line)


def on_pre_build(config: Any, **_: Any) -> None:
    # `mkdocs serve` rebuilds in one process: read the repository again.
    tracked_files.cache_clear()


def on_page_markdown(markdown: str, page: Any, config: Any, files: Any, **_: Any) -> str:
    from mkdocs.exceptions import PluginError

    root = str(Path(config.config_file_path).resolve().parent)
    site = Site(
        published=frozenset(
            f.src_uri for f in files if not f.inclusion.is_excluded()
        ),
        tracked=tracked_files(root, os.environ.get("SITE_REPO_FILES")),
        repo_url=str(config.repo_url).rstrip("/"),
    )
    text, problems = rewrite_links(site, page.file.src_uri, markdown)
    if problems:
        # MkDocs strips the front matter before this hook; count it back.
        offset = max(0, page.file.content_string.count("\n") - markdown.count("\n"))
        shifted = tuple(Problem(p.line + offset, p.link, p.resolved) for p in problems)
        raise PluginError(describe(f"{DOCS}/{page.file.src_uri}", shifted))
    return text
