# BLOCKED

## [BACKEND] Branch protection requires GitHub Pro

**Step:** Migration step 2 — protect `main` and `develop` via the GitHub API.

**What happened:** `gh api repos/bganguly/nextjs-dashboard/branches/{main,develop}/protection`
returned HTTP 403:

> Upgrade to GitHub Pro or make this repository public to enable this feature.

Branch protection rules are not available on the free plan for **private** repositories.

**What succeeded:** Default branch was successfully switched to `develop`.

**Decision needed (yours to make):**
- Upgrade the repo's account to GitHub Pro/Team, **or**
- Make `nextjs-dashboard` public, **or**
- Accept no server-side protection and rely on workflow discipline only.

**Mitigation in the meantime:** All agents follow the convention manually —
feature/* branches off `develop`, PRs into `develop`, no direct commits to
`main`/`develop`. This is enforced by process, not by the server, until the
above decision is made.
