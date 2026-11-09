#!/usr/bin/env python3
"""
File: scripts/python/site/website_hook.py

Description: Two small MkDocs hooks of the website (issue 96).

  +  **Mermaid diagrams as their source**.  The platform brief carries
     three Mermaid diagrams, which GitHub draws.  Material would draw them
     too, but by fetching mermaid.min.js from unpkg.com, and a page of this
     site requests nothing from another origin; shipping Mermaid from the
     site instead means 3.5 MB of bundled third-party code, with its
     notices, for three diagrams in one secondary document.  So each
     ```mermaid fence is shown as its source, as text, under a line linking
     the page on GitHub, which draws it.  The website's own diagrams are
     inline SVG.
  +  **The playground in the nav**.  play/ is not a MkDocs page, so a nav
     entry written in mkdocs.yml fails `--strict` (`nav.not_found`), and an
     absolute one names the host.  MkDocs validates the nav before the
     `on_nav` hooks run, so a `Link` appended here is not checked, and
     Material writes it relative to each page.  The built tree's link check
     (scripts/pages/check.mjs) proves that it resolves.

Design Principles:
  +  Pure core: `show_mermaid_source` is a function of the page's text and
     its GitHub address.
"""

from __future__ import annotations

import re
from typing import Any

_MERMAID = re.compile(r"^(?P<fence>`{3,}|~{3,})mermaid[ \t]*$", re.MULTILINE)


def show_mermaid_source(text: str, github_url: str) -> str:
    """The page with each top-level Mermaid fence shown as text, under a
    line that links the page on GitHub."""

    def note(match: "re.Match[str]") -> str:
        return (
            f'<p class="diagram-source">A Mermaid diagram, drawn on '
            f'<a href="{github_url}">this page on GitHub</a>; its source '
            f"follows.</p>\n\n{match.group('fence')}text"
        )

    return _MERMAID.sub(note, text)


def on_page_markdown(markdown: str, page: Any, config: Any, **_: Any) -> str:
    github_url = f"{str(config.repo_url).rstrip('/')}/blob/main/docs/{page.file.src_uri}"
    return show_mermaid_source(markdown, github_url)


def on_nav(nav: Any, config: Any, files: Any, **_: Any) -> Any:
    from mkdocs.structure.nav import Link, Section

    section = next(
        (item for item in nav.items if isinstance(item, Section) and item.title == "The workbench"),
        None,
    )
    link = Link("The playground", "play/")
    if section is None:
        nav.items.append(link)
    else:
        link.parent = section
        section.children.append(link)
    return nav
