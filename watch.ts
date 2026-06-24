import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import chokidar from "chokidar";
import { notifyBlocked } from "./tests/notify";

/**
 * Watcher: re-runs the Playwright suite whenever the backend or frontend
 * worktrees change. When any single test fails 3 times in a row it both
 * (a) records the block in BLOCKED.md ([TESTING] prefix) and commits/pushes it,
 * and (b) alerts via notifyBlocked (Telegram and/or email).
 *
 * Run with:  npx tsx watch.ts
 *
 * Env:
 *   WATCH_DIRS   comma-separated dirs to watch (default ../wt-backend,../wt-frontend)
 *   BASE_URL     passed through to Playwright (the app under test)
 */

const WATCH_DIRS = (process.env.WATCH_DIRS ?? "../wt-backend,../wt-frontend")
  .split(",")
  .map((d) => resolve(process.cwd(), d.trim()))
  .filter((d) => existsSync(d));

const RESULTS_FILE = resolve(process.cwd(), "test-results/results.json");
const BLOCKED_FILE = resolve(process.cwd(), "BLOCKED.md");
const FAIL_THRESHOLD = 3;
const DEBOUNCE_MS = 800;
// Auto-commit/push BLOCKED.md when a test becomes blocked (set to "0" to skip).
const BLOCKED_PUSH = process.env.BLOCKED_PUSH !== "0";

/** consecutive-failure count per fully-qualified test title */
const failStreak = new Map<string, number>();
/** titles we've already alerted on, to avoid re-spamming until they recover */
const alerted = new Set<string>();

let running = false;
let rerunQueued = false;
let debounceTimer: NodeJS.Timeout | null = null;

interface PwResult {
  status?: string;
}
interface PwTest {
  results?: PwResult[];
}
interface PwSpec {
  title?: string;
  ok?: boolean;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
}

/** Walk the Playwright JSON report into a flat {title -> passed?} map. */
function collectSpecs(report: PwReport): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const walk = (suite: PwSuite, prefix: string) => {
    const path = [prefix, suite.title].filter(Boolean).join(" › ");
    for (const spec of suite.specs ?? []) {
      const title = [path, spec.title].filter(Boolean).join(" › ");
      const passed =
        spec.ok ??
        (spec.tests ?? []).every((t) =>
          (t.results ?? []).every(
            (r) => r.status === "passed" || r.status === "skipped",
          ),
        );
      out.set(title, passed);
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const s of report.suites ?? []) walk(s, "");
  return out;
}

/**
 * Record a blocked test in BLOCKED.md (with the [TESTING] prefix) and, unless
 * disabled, commit + push it. Best-effort: a git failure is logged but never
 * crashes the watcher.
 */
function writeBlocked(title: string, streak: number, details: string): void {
  const header = existsSync(BLOCKED_FILE)
    ? ""
    : "# [TESTING] Blocked tests\n\n" +
      "Appended automatically by watch.ts when a test fails " +
      `${FAIL_THRESHOLD} times in a row.\n`;
  const entry =
    `\n## [TESTING] ${title}\n\n` +
    `- **Failed:** ${streak}x consecutively\n` +
    `- **At:** ${new Date().toISOString()}\n` +
    `- **Details:**\n\n` +
    "```\n" +
    `${details.trim()}\n` +
    "```\n";
  try {
    appendFileSync(BLOCKED_FILE, header + entry);
    console.log(`[watch] wrote BLOCKED.md entry for: ${title}`);
  } catch (err) {
    console.error("[watch] failed to write BLOCKED.md:", err);
    return;
  }

  if (!BLOCKED_PUSH) return;
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: process.cwd(), stdio: "pipe" });
    git("add", "BLOCKED.md");
    git(
      "commit",
      "-m",
      `[TESTING] blocked: ${title} failed ${streak}x`,
    );
    git("push", "origin", "HEAD");
    console.log("[watch] committed + pushed BLOCKED.md");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[watch] could not commit/push BLOCKED.md: ${msg}`);
  }
}

function runTests(): Promise<void> {
  if (running) {
    rerunQueued = true;
    return Promise.resolve();
  }
  running = true;
  console.log(`\n[watch] ${new Date().toISOString()} running playwright…`);

  return new Promise<void>((resolvePromise) => {
    const child = spawn(
      "npx",
      ["playwright", "test", "--reporter=json,list"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
        shell: process.platform === "win32",
      },
    );

    let stderrTail = "";
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      process.stderr.write(d);
    });

    child.on("close", async (code) => {
      await processResults(code ?? 1, stderrTail);
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        runTests().then(resolvePromise);
      } else {
        resolvePromise();
      }
    });
  });
}

async function processResults(exitCode: number, stderrTail: string): Promise<void> {
  let report: PwReport | null = null;
  try {
    if (existsSync(RESULTS_FILE)) {
      report = JSON.parse(readFileSync(RESULTS_FILE, "utf8")) as PwReport;
    }
  } catch (err) {
    console.error("[watch] could not parse results.json:", err);
  }

  if (!report) {
    // No machine-readable results — likely a runner/config error (exit code
    // not from test failures). Surface it but don't touch streaks.
    console.error(
      `[watch] playwright exited ${exitCode} with no parseable report; ` +
        `not updating failure streaks.`,
    );
    return;
  }

  const specs = collectSpecs(report);
  for (const [title, passed] of specs) {
    if (passed) {
      if (failStreak.get(title)) console.log(`[watch] ✓ recovered: ${title}`);
      failStreak.set(title, 0);
      alerted.delete(title);
      continue;
    }

    const streak = (failStreak.get(title) ?? 0) + 1;
    failStreak.set(title, streak);
    console.log(`[watch] ✗ failed (${streak}x): ${title}`);

    if (streak >= FAIL_THRESHOLD && !alerted.has(title)) {
      alerted.add(title);
      const details =
        `Exit code: ${exitCode}\n` +
        (stderrTail ? `\nstderr (tail):\n${stderrTail}` : "");

      // 1) Persist the block to BLOCKED.md (and commit/push).
      writeBlocked(title, streak, details);

      // 2) Alert over every configured channel (Telegram and/or email).
      try {
        const sent = await notifyBlocked(title, streak, details);
        console.log(
          sent
            ? `[watch] alerted (telegram/email): ${title}`
            : `[watch] alert skipped (no channel configured): ${title}`,
        );
      } catch (err) {
        console.error(`[watch] failed to send alert for ${title}:`, err);
      }
    }
  }
}

function scheduleRun(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    console.log(`[watch] change detected (${reason})`);
    runTests();
  }, DEBOUNCE_MS);
}

function main(): void {
  if (WATCH_DIRS.length === 0) {
    console.error("[watch] no watch dirs exist; set WATCH_DIRS. Exiting.");
    process.exit(1);
  }
  console.log("[watch] watching:");
  for (const d of WATCH_DIRS) console.log(`  - ${d}`);

  const watcher = chokidar.watch(WATCH_DIRS, {
    ignoreInitial: true,
    ignored: [
      /(^|[/\\])\../, // dotfiles/dirs (.git, .next, etc.)
      /node_modules/,
      /[/\\](\.next|dist|build|coverage|test-results)[/\\]/,
    ],
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  watcher
    .on("all", (event, path) => scheduleRun(`${event} ${path}`))
    .on("ready", () => {
      console.log("[watch] initial scan complete. Running once to baseline…");
      runTests();
    })
    .on("error", (err) => console.error("[watch] watcher error:", err));

  const shutdown = () => {
    console.log("\n[watch] shutting down.");
    watcher.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
