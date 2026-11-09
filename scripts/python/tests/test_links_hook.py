"""
File: scripts/python/tests/test_links_hook.py

Description: Tests of the website's link hook (issue 96), against its pure
  core: masking, anchors, and each way a link is kept, sent to GitHub, or
  refused.  Run with `make website-test` in `nix develop .#website`.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "site"))

import links_hook as h  # noqa: E402

REPO = "https://github.com/formalverification/agda-native-ide"
SITE = h.Site(
    published=frozenset({"index.md", "adr/0001-runtime.md", "notes/runtime.md"}),
    tracked=frozenset(
        {
            "docs/index.md",
            "docs/adr/0001-runtime.md",
            "docs/notes/runtime.md",
            "docs/measurements/playground-2026-10-12.json",
            "docs/GITHUB_PROJECT.md",
            "upstream/assets.sha256",
            "vscode/README.md",
            "NOTICE",
        }
    ),
    repo_url=REPO,
)


def rewrite(text: str, page: str = "adr/0001-runtime.md"):
    return h.rewrite_links(SITE, page, text)


def test_published_link_is_kept_and_its_anchor_moved_to_the_site_form():
    text, problems = rewrite("See [it](../notes/runtime.md#10--the-drive).")
    assert problems == ()
    assert text == "See [it](../notes/runtime.md#10-the-drive)."


def test_fragment_only_link_is_moved_to_the_site_form():
    text, _ = rewrite("[back](#4--the-notice)")
    assert text == "[back](#4-the-notice)"


def test_tracked_file_goes_to_github_blob_with_its_anchor_kept():
    text, problems = rewrite("[r](../measurements/playground-2026-10-12.json)")
    assert problems == ()
    assert text == f"[r]({REPO}/blob/main/docs/measurements/playground-2026-10-12.json)"
    text, _ = rewrite("[p](../GITHUB_PROJECT.md#milestone-9--x)")
    assert text == f"[p]({REPO}/blob/main/docs/GITHUB_PROJECT.md#milestone-9--x)"


def test_tracked_directory_goes_to_github_tree():
    text, problems = rewrite("[u]: ../../upstream/", page="notes/runtime.md")
    assert problems == ()
    assert text == f"[u]: {REPO}/tree/main/upstream"


def test_reference_definition_with_a_code_span_label_is_rewritten():
    text, _ = rewrite("[`vscode/README.md`]: ../../vscode/README.md")
    assert text == f"[`vscode/README.md`]: {REPO}/blob/main/vscode/README.md"


def test_untracked_target_is_a_problem_with_its_line():
    _, problems = rewrite("one\n\n[k](../kickoffs/k.md)\n")
    assert problems == (h.Problem(3, "../kickoffs/k.md", "docs/kickoffs/k.md"),)


def test_a_link_leaving_the_repository_is_a_problem():
    _, problems = rewrite("[x](../../../etc/passwd)")
    assert len(problems) == 1 and problems[0].resolved.startswith("..")


def test_urls_and_absolute_paths_are_left_alone():
    source = "[a](https://example.org/x#a--b) [m](mailto:x@y) [r](/root.md)"
    text, problems = rewrite(source)
    assert (text, problems) == (source, ())


def test_links_in_code_are_left_alone():
    source = (
        "`[x](../kickoffs/a.md)`\n\n"
        "```md\n[y](../kickoffs/b.md)\n```\n\n"
        "<!-- [z](../kickoffs/c.md) -->\n"
        "  ~~~~\n  [w](../kickoffs/d.md)\n  ~~~~\n"
    )
    text, problems = rewrite(source)
    assert (text, problems) == (source, ())


def test_a_code_span_does_not_cross_a_blank_line():
    text, _ = rewrite("a ` b\n\n[n](../../NOTICE) `")
    assert f"[n]({REPO}/blob/main/NOTICE)" in text


def test_title_and_angle_brackets_are_kept():
    text, _ = rewrite('[n](../../NOTICE "the notice") [v](<../../vscode/README.md>)')
    assert text == (
        f'[n]({REPO}/blob/main/NOTICE "the notice") '
        f"[v](<{REPO}/blob/main/vscode/README.md>)"
    )


def test_mask_keeps_length_and_newlines():
    source = "a `b`\n```\nc\n```\n<!--\nd -->"
    masked = h.mask(source)
    assert len(masked) == len(source)
    assert masked.count("\n") == source.count("\n")
    assert "b" not in masked and "c" not in masked and "d" not in masked


def test_a_wrapped_line_that_looks_like_a_definition_is_not_one():
    source = "the companion since\n   [#64]: the native engine as child processes\n"
    text, problems = rewrite(source)
    assert (text, problems) == (source, ())


def test_a_definition_with_a_title_is_rewritten():
    text, _ = rewrite('[n]: ../../NOTICE "the notice"')
    assert text == f'[n]: {REPO}/blob/main/NOTICE "the notice"'
