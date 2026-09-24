#!/usr/bin/env python3
"""Rebuild sites.json by checking all bjvfi sub-repos and adding missing slugs.

Keeps the auto-rebuild ON: merges (never deletes), so existing entries are
preserved and only slugs found in the repos but missing from sites.json get
added. Run on a schedule plus manual dispatch.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

OWNER = "iamnottaiiii"
SUB_REPOS = [f"bjvfi{i}" for i in range(1, 10)]
TOKEN = os.environ.get("GH_TOKEN", "")
SITES_JSON_PATH = os.environ.get("SITES_JSON_PATH", "sites.json")


def api(url):
    req = urllib.request.Request(url)
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "bjvfi-sitesjson-rebuild")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r), dict(r.headers)
    except urllib.error.HTTPError as e:
        if e.code == 403:
            # Rate limit: wait and retry once
            reset = e.headers.get("X-RateLimit-Reset")
            if reset:
                wait = max(int(reset) - int(time.time()) + 5, 5)
                print(f"  rate limited, waiting {wait}s...", file=sys.stderr)
                time.sleep(wait)
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.load(r), dict(r.headers)
        print(f"HTTP {e.code} for {url}", file=sys.stderr)
        raise


def get_top_level_dirs(repo):
    """Return the set of top-level directory names (site slugs) in a repo."""
    repo_info, _ = api(f"https://api.github.com/repos/{OWNER}/{repo}")
    sha = repo_info["default_branch"]
    tree, _ = api(
        f"https://api.github.com/repos/{OWNER}/{repo}/git/trees/{sha}")
    if not tree.get("truncated"):
        dirs = {e["path"] for e in tree.get("tree", [])
                if e.get("type") == "tree"}
        return {d for d in dirs if not d.startswith(".")}, False

    # Truncated: fall back to paginated root contents listing
    print(f"  tree truncated for {repo}, using paginated listing...",
          file=sys.stderr)
    dirs = set()
    page = 1
    while True:
        items, headers = api(
            f"https://api.github.com/repos/{OWNER}/{repo}/contents/"
            f"?per_page=100&page={page}")
        if not items:
            break
        for it in items:
            if it.get("type") == "dir" and not it["name"].startswith("."):
                dirs.add(it["name"])
        # Last page has fewer than 100 items
        if len(items) < 100:
            break
        page += 1
        if page % 50 == 0:
            print(f"  ...page {page} ({len(dirs):,} so far)",
                  file=sys.stderr)
    return dirs, True


def main():
    with open(SITES_JSON_PATH) as f:
        catalog = json.load(f)

    total_added = 0
    for repo in SUB_REPOS:
        print(f"Checking {repo}...", flush=True)
        try:
            live_dirs, paginated = get_top_level_dirs(repo)
        except Exception as e:
            print(f"  ERROR reading {repo}: {e} (keeping existing entries)",
                  file=sys.stderr)
            continue
        existing = set(catalog.get(repo, []))
        missing = live_dirs - existing
        if missing:
            merged = sorted(existing | live_dirs)
            catalog[repo] = merged
            total_added += len(missing)
            print(f"  added {len(missing):,} missing slugs "
                  f"({len(live_dirs):,} in repo, {len(existing):,} were listed)")
        else:
            print(f"  OK: {len(existing):,} slugs, nothing missing")

    with open(SITES_JSON_PATH, "w") as f:
        json.dump(catalog, f, separators=(",", ":"))

    grand_total = sum(len(v) for v in catalog.values())
    print(f"\nDone. Added {total_added:,} missing slugs. "
          f"Catalog total: {grand_total:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
