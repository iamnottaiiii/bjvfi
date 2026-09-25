#!/usr/bin/env python3
"""Rebuild sites.json by checking all bjvfi sub-repos and adding missing slugs.

Fast path: a shallow blob-less git clone plus `git ls-tree HEAD` lists every
top-level directory in one shot. No thousands of paginated API calls, no
rate-limit crawl.

Keeps the auto-rebuild ON: merges (never deletes), so existing entries are
preserved and only slugs found in the repos but missing from sites.json get
added. Run on a schedule plus manual dispatch.
"""
import json
import os
import shutil
import subprocess
import sys

OWNER = "iamnottaiiii"
# bjvfi1-8 only: bjvfi9 was deleted 2026-09-25 (its sites moved to bjvfi7)
SUB_REPOS = [f"bjvfi{i}" for i in range(1, 9)]
TOKEN = os.environ.get("GH_TOKEN", "")
SITES_JSON_PATH = os.environ.get("SITES_JSON_PATH", "sites.json")
WORKDIR_BASE = os.environ.get("REBUILD_WORKDIR", "/tmp/sitesjson-rebuild")


def get_top_level_dirs(repo):
    """Return the set of top-level directory names (site slugs) in a repo."""
    workdir = os.path.join(WORKDIR_BASE, repo)
    shutil.rmtree(workdir, ignore_errors=True)
    os.makedirs(WORKDIR_BASE, exist_ok=True)
    if TOKEN:
        url = f"https://x-access-token:{TOKEN}@github.com/{OWNER}/{repo}.git"
    else:
        url = f"https://github.com/{OWNER}/{repo}.git"
    clone = subprocess.run(
        ["git", "clone", "--depth", "1", "--filter=blob:none",
         "--no-checkout", url, workdir],
        capture_output=True, text=True, timeout=1200)
    if clone.returncode != 0:
        raise RuntimeError(
            f"git clone failed for {repo}: {clone.stderr[-500:]}")
    try:
        ls = subprocess.run(
            ["git", "-C", workdir, "ls-tree", "HEAD"],
            capture_output=True, text=True, timeout=600, check=True)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    dirs = set()
    for line in ls.stdout.splitlines():
        if "\t" not in line:
            continue
        meta, name = line.split("\t", 1)
        parts = meta.split()
        if (len(parts) >= 2 and parts[1] == "tree"
                and name and not name.startswith(".")):
            dirs.add(name)
    return dirs


def main():
    with open(SITES_JSON_PATH) as f:
        catalog = json.load(f)

    total_added = 0
    for repo in SUB_REPOS:
        print(f"Checking {repo}...", flush=True)
        try:
            live_dirs = get_top_level_dirs(repo)
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
                  f"({len(live_dirs):,} in repo, {len(existing):,} listed)",
                  flush=True)
        else:
            print(f"  OK: {len(existing):,} slugs, nothing missing",
                  flush=True)

    with open(SITES_JSON_PATH, "w") as f:
        json.dump(catalog, f, separators=(",", ":"))

    grand_total = sum(len(v) for v in catalog.values())
    print(f"\nDone. Added {total_added:,} missing slugs. "
          f"Catalog total: {grand_total:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
