#!/usr/bin/env python3
"""Rebuild sites.json from every slug/index.html on the site."""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "sites.json"
IGNORE = {
    ".git",
    ".github",
    "favicon",
    "bjvfi",
    "directory",
    "assets",
    "images",
    "img",
    "css",
    "js",
    "scripts",
    "sitedesk",
    "node_modules",
}


def load_prev() -> dict[str, dict]:
    if not OUT.exists():
        return {}
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}
    prev = {}
    for row in data if isinstance(data, list) else []:
        slug = row.get("s") or row.get("slug")
        if slug:
            prev[slug] = row
    return prev


def text_of(html: str, limit: int = 12000) -> str:
    return html[:limit]


def scrape(html: str) -> dict:
    title = ""
    m = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
    if m:
        title = re.sub(r"\s*[·|\-].*$", "", m.group(1).strip())
        title = re.sub(r"\s+", " ", title).strip()

    desc = ""
    m = re.search(r'name=["\']description["\']\s+content=["\']([^"\']*)["\']', html, re.I)
    if not m:
        m = re.search(r'content=["\']([^"\']*)["\']\s+name=["\']description["\']', html, re.I)
    if m:
        desc = m.group(1).strip()

    phone = ""
    m = re.search(r"tel:(\+?\d[\d\-()\s]{6,}\d)", html, re.I)
    if m:
        phone = re.sub(r"\s+", " ", m.group(1)).strip()

    return {"n": title, "c": "", "p": phone, "a": "", "desc": desc}


def main() -> None:
    prev = load_prev()
    sites = []
    for path in sorted(ROOT.iterdir(), key=lambda p: p.name.lower()):
        if not path.is_dir() or path.name in IGNORE or path.name.startswith("."):
            continue
        index = path / "index.html"
        if not index.is_file():
            continue
        slug = path.name
        html = index.read_text(encoding="utf-8", errors="replace")
        scraped = scrape(text_of(html))
        old = prev.get(slug, {})
        name = (old.get("n") or scraped["n"] or slug.replace("-", " ").title()).strip()
        category = (old.get("c") or scraped["c"] or "").strip()
        phone = (old.get("p") or scraped["p"] or "").strip()
        address = (old.get("a") or scraped["a"] or "").strip()
        sites.append(
            {
                "s": slug,
                "n": name,
                "c": category,
                "p": phone,
                "a": address,
            }
        )

    sites.sort(key=lambda x: (x["n"] or x["s"]).lower())
    # Keep the SiteDesk queue total in sync: the app fetches this fresh on
    # every queue visit, so it must be rewritten on every rebuild.
    # Grand total across all repos: this repo's sites plus every sub-repo
    # index chunk (sites-bjvfi1..5-p*.json). The sites-bjvfi-p*.json chunks
    # mirror sites.json itself and are excluded to avoid double counting.
    total_path = ROOT / "sitedesk" / "data" / "total.json"
    total_path.parent.mkdir(parents=True, exist_ok=True)
    grand_total = len(sites)
    print(f"main sites.json: {len(sites)}")
    for chunk_file in sorted(ROOT.glob("sites-bjvfi[1-9]*-p*.json")):
        try:
            n = len(json.loads(chunk_file.read_text(encoding="utf-8")))
            print(f"chunk {chunk_file.name}: {n}")
            grand_total += n
        except Exception as e:
            print(f"chunk {chunk_file.name}: ERROR {e}")
    print(f"grand total: {grand_total}")
    total_path.write_text(json.dumps({"total": grand_total}) + "\n", encoding="utf-8")
    new_text = json.dumps(sites, separators=(",", ":"), ensure_ascii=False) + "\n"
    old_text = OUT.read_text(encoding="utf-8") if OUT.exists() else None
    if old_text == new_text:
        print(f"sites.json unchanged ({len(sites)} sites)")
        return
    OUT.write_text(new_text, encoding="utf-8")
    print(f"wrote sites.json with {len(sites)} sites")


if __name__ == "__main__":
    main()
