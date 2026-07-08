import { execFileSync, spawnSync } from "node:child_process";
import { notify } from "./tests/notify";

/**
 * Agent-3 PR watcher.
 *
 * Polls open PRs targeting `main`, runs the Playwright suite against each
 * (BASE_URL must point at a running deployment/preview of that PR's code), and
 * posts a `playwright` commit status on the PR head SHA so branch protection
 * can gate merges on it. New failures are also emailed via notify().
 *
 * Run with:  npx tsx pr-watch.ts
 *
 * Env:
 *   BASE_URL       app under test for the current PR (default http://localhost:3003)
 *   PR_BASE        base branch to watch (default main)
 *   POLL_MS        poll interval (default 60000)
 *   REPO           owner/repo (default: inferred from gh)
 */

const PR_BASE = process.env.PR_BASE ?? "main";
const POLL_MS = Number(process.env.POLL_MS ?? "60000");
const STATUS_CONTEXT = "playwright";

interface PR {
  number: number;
  headRefName: string;
  headRefOid: string;
}

const repo =
  process.env.REPO ??
  execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    .toString()
    .trim();

// head SHAs we've already tested → avoid re-running the suite for the same code.
const tested = new Map<string, "success" | "failure">();

function listOpenPRs(): PR[] {
  try {
    const out = execFileSync("gh", [
      "pr",
      "list",
      "--base",
      PR_BASE,
      "--state",
      "open",
      "--json",
      "number,headRefName,headRefOid",
    ]).toString();
    return JSON.parse(out) as PR[];
  } catch (err) {
    console.error("[pr-watch] gh pr list failed:", err);
    return [];
  }
}

function postStatus(sha: string, state: "success" | "failure" | "pending", description: string): void {
  try {
    execFileSync("gh", [
      "api",
      `repos/${repo}/statuses/${sha}`,
      "-X",
      "POST",
      "-f",
      `state=${state}`,
      "-f",
      `context=${STATUS_CONTEXT}`,
      "-f",
      `description=${description.slice(0, 140)}`,
    ], { stdio: "pipe" });
    console.log(`[pr-watch] status ${state} -> ${sha.slice(0, 7)} (${description})`);
  } catch (err) {
    console.error(`[pr-watch] failed to post status for ${sha.slice(0, 7)}:`, err);
  }
}

function runSuite(): { ok: boolean; output: string } {
  const res = spawnSync("npx", ["playwright", "test", "--reporter=line"], {
    env: { ...process.env },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
  return { ok: res.status === 0, output };
}

async function checkPR(pr: PR): Promise<void> {
  if (tested.has(pr.headRefOid)) return; // already evaluated this exact commit
  console.log(
    `[pr-watch] testing PR #${pr.number} (${pr.headRefName} @ ${pr.headRefOid.slice(0, 7)})`,
  );
  postStatus(pr.headRefOid, "pending", "Playwright suite running");

  const { ok, output } = runSuite();
  const state = ok ? "success" : "failure";
  tested.set(pr.headRefOid, state);
  postStatus(
    pr.headRefOid,
    state,
    ok ? "All Playwright specs passed" : "Playwright specs failed",
  );

  if (!ok) {
    const tail = output.split("\n").slice(-25).join("\n");
    await notify({
      subject: `[TESTING] PR #${pr.number} (${pr.headRefName}) failed Playwright`,
      body: `Commit ${pr.headRefOid}\n\n${tail}`,
    }).catch((err) => console.error("[pr-watch] notify failed:", err));
  }
}

async function tick(): Promise<void> {
  const prs = listOpenPRs();
  if (prs.length === 0) {
    console.log(`[pr-watch] no open PRs targeting ${PR_BASE}.`);
    return;
  }
  for (const pr of prs) await checkPR(pr);
}

async function main(): Promise<void> {
  console.log(
    `[pr-watch] repo=${repo} base=${PR_BASE} interval=${POLL_MS}ms ` +
      `BASE_URL=${process.env.BASE_URL ?? "http://localhost:3003"}`,
  );
  // NOTE: the suite only passes when BASE_URL serves the PR's running app.
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error("[pr-watch] fatal:", err);
  process.exit(1);
});
