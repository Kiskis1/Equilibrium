"""Merge same-repository Equilibrium PRs only after verified, fresh CI.

Executed from the trusted main branch via workflow_run, never from PR code.
The unprivileged PR workflow uploads its event identity *before checkout* so
we can prove both the tested head SHA and the main SHA used for the test.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
from urllib.request import Request, urlopen

REPO = "Kiskis1/Equilibrium"
API = "https://api.github.com/repos/" + REPO
CI_WORKFLOW = "Equilibrium PR safety checks"
PROVENANCE = Path(".ci-provenance/pr.json")
SHA = re.compile(r"[0-9a-f]{40}\Z")
JOB_URL = re.compile(r"/actions/runs/([0-9]+)/job/[0-9]+(?:[/?#]|\Z)")
HOLD_LABELS = {"no-auto-merge", "hold", "do-not-merge"}


def github(method: str, path: str, token: str, payload=None):
    if not path.startswith("/") or "://" in path:
        raise ValueError("Unsafe GitHub API path")
    request = Request(
        API + path,
        method=method,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "equilibrium-verified-squash",
        },
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def all_pages(path: str, token: str, limit: int = 5):
    output = []
    for page in range(1, limit + 1):
        separator = "&" if "?" in path else "?"
        chunk = github("GET", f"{path}{separator}per_page=100&page={page}", token)
        if not isinstance(chunk, list):
            raise ValueError("Malformed paginated GitHub response")
        output.extend(chunk)
        if len(chunk) < 100:
            return output
    raise ValueError("Refusing truncated GitHub result set")


def verify_checks(head: str, run_id: int, token: str):
    response = github("GET", f"/commits/{head}/check-runs?filter=latest&per_page=100", token)
    checks = response.get("check_runs")
    if not isinstance(checks, list) or response.get("total_count", 101) > len(checks):
        return "missing-or-truncated-check-runs"
    names = {}
    for check in checks:
        name = check.get("name")
        if name in names:
            return "duplicate-check-" + str(name)
        names[name] = check
        if (check.get("head_sha") != head
                or check.get("status") != "completed"
                or check.get("conclusion") != "success"):
            return "nonpassing-check-" + str(name)

    required = names.get("verify")
    if required is None:
        return "missing-required-verify"
    if (required.get("app") or {}).get("slug") != "github-actions":
        return "untrusted-check-provider"
    match = JOB_URL.search(required.get("details_url") or "")
    if match is None or int(match.group(1)) != run_id:
        return "verify-not-from-triggering-run"

    statuses = github("GET", f"/commits/{head}/status", token).get("statuses")
    if not isinstance(statuses, list):
        raise ValueError("Malformed combined commit statuses")
    if any(item.get("state") != "success" for item in statuses):
        return "nonpassing-commit-status"
    return None


def inspect_pr(pr, origin, token: str):
    number = pr["number"]
    head, base = origin["head_sha"], origin["base_sha"]
    if pr.get("state") != "open" or pr.get("draft"):
        return "not-open-or-draft"
    if ((pr.get("head") or {}).get("sha") != head
            or ((pr.get("head") or {}).get("repo") or {}).get("full_name") != REPO
            or (pr.get("base") or {}).get("ref") != "main"
            or (pr.get("base") or {}).get("sha") != base):
        return "head-repository-or-base-mismatch"
    if any((label.get("name") or "").lower() in HOLD_LABELS
           for label in pr.get("labels", [])):
        return "explicit-merge-hold"
    if pr.get("mergeable") is not True or pr.get("mergeable_state") != "clean":
        return "not-cleanly-mergeable"

    files = all_pages(f"/pulls/{number}/files", token, limit=31)
    if not files:
        return "empty-pr"
    names = [item["filename"] for item in files]
    if any(name.startswith((".github/workflows/", ".github/actions/"))
           or name == "scripts/equilibrium_auto_squash.py" for name in names):
        return "privileged-ci-edit-requires-manual-review"

    problem = verify_checks(head, origin["run_id"], token)
    if problem:
        return problem

    # Re-read immediately before the merge; even a passed run is stale after
    # main moves or the PR head changes. The merge API also guards head SHA.
    latest = github("GET", f"/pulls/{number}", token)
    main = github("GET", "/branches/main", token)
    if (latest.get("state") != "open" or latest.get("draft")
            or (latest.get("head") or {}).get("sha") != head
            or (latest.get("base") or {}).get("sha") != base
            or (main.get("commit") or {}).get("sha") != base
            or latest.get("mergeable") is not True
            or latest.get("mergeable_state") != "clean"):
        return "pr-or-main-changed-since-ci"

    result = github("PUT", f"/pulls/{number}/merge", token, {
        "merge_method": "squash",
        "sha": head,
    })
    if result.get("merged") is not True:
        raise RuntimeError("GitHub did not confirm squash merge")
    return "SQUASH_MERGED"


def main():
    if os.environ.get("GITHUB_REPOSITORY") != REPO:
        raise RuntimeError("Unexpected repository")
    run_event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    run = run_event.get("workflow_run") or {}
    if (run.get("name") != CI_WORKFLOW
            or run.get("event") != "pull_request"
            or run.get("status") != "completed"
            or run.get("conclusion") != "success"):
        print("AUTO_SQUASH=NOT_APPLICABLE")
        return

    origin = json.loads(PROVENANCE.read_text(encoding="utf-8"))
    for field in ("head_sha", "base_sha"):
        if not isinstance(origin.get(field), str) or not SHA.fullmatch(origin[field]):
            raise ValueError("Invalid provenance " + field)
    for field in ("pr_number", "run_id", "run_attempt"):
        if type(origin.get(field)) is not int or origin[field] < 1:
            raise ValueError("Invalid provenance " + field)
    if (origin["run_id"] != run.get("id")
            or origin["run_attempt"] != run.get("run_attempt")
            or origin["head_sha"] != run.get("head_sha")):
        raise ValueError("Artifact not from triggering CI run")

    token = os.environ["GH_TOKEN"]
    pr = github("GET", f"/pulls/{origin['pr_number']}", token)
    result = inspect_pr(pr, origin, token)
    print(f"EQUILIBRIUM_AUTO_SQUASH PR#{origin['pr_number']}: {result}", flush=True)


if __name__ == "__main__":
    main()
