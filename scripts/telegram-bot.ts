/**
 * Teardown-proof Telegram status bot.
 *
 * Long-polls Telegram getUpdates and answers natural-language status questions
 * about the three worktrees (backend / frontend / testing) using the shared
 * heartbeat files in ../STATUS and each worktree's git log. Non-status replies
 * that look like decision answers are relayed (recorded) to scripts/.bot-inbox.log.
 *
 * Runs detached via scripts/start-bot.sh (nohup npx tsx ...), so it survives
 * the VS Code pane / editor being closed.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd(); // start-bot.sh cd's to the wt-testing root
const SCRIPTS = resolve(ROOT, "scripts");
const STATUS_DIR = resolve(ROOT, "..", "STATUS");
const STATE_FILE = resolve(SCRIPTS, ".bot-state.json");
const INBOX_FILE = resolve(SCRIPTS, ".bot-inbox.log");

// ---------------------------------------------------------------------------
// env + telegram
// ---------------------------------------------------------------------------
function loadEnv(): void {
  try {
    const raw = readFileSync(resolve(ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch {
    /* no .env — rely on process.env */
  }
}
loadEnv();

const TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN || !CHAT_ID) {
  console.error("[bot] TELEGRAM_TOKEN / TELEGRAM_CHAT_ID missing in .env — exiting.");
  process.exit(1);
}

async function tg(method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(35_000),
  });
  return res.json();
}

async function send(text: string): Promise<void> {
  // Telegram hard-caps messages at 4096 chars.
  const t = text.length > 4000 ? text.slice(0, 3990) + "\n…(truncated)" : text;
  try {
    await tg("sendMessage", { chat_id: CHAT_ID, text: t, disable_web_page_preview: true });
  } catch (err) {
    console.error("[bot] send failed:", err);
  }
}

// ---------------------------------------------------------------------------
// worktrees + aliases
// ---------------------------------------------------------------------------
type WT = "backend" | "frontend" | "testing";
const WTS: WT[] = ["backend", "frontend", "testing"];

const ALIASES: Record<WT, string[]> = {
  backend: ["wt1", "w1", "be", "back", "backend", "api", "server", "1", "one"],
  frontend: ["wt2", "w2", "fe", "front", "frontend", "ui", "client", "2", "two"],
  testing: ["wt3", "w3", "te", "test", "testing", "tests", "qa", "3", "three"],
};

const STATUS_KEYWORDS = [
  "where", "status", "what's", "whats", "hows", "how's",
  "progress", "update", "doing", "summary", "going",
];

function worktreeDir(wt: WT): string {
  return resolve(ROOT, "..", `wt-${wt}`);
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
interface State {
  offset: number;
  sessionStart: string;
  lastAsked: Record<WT, string>;
}
function nowISO(): string {
  return new Date().toISOString();
}
function loadState(): State {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
    } catch {
      /* fall through to fresh */
    }
  }
  const start = nowISO();
  return {
    offset: 0,
    sessionStart: start,
    lastAsked: { backend: start, frontend: start, testing: start },
  };
}
function saveState(s: State): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (err) {
    console.error("[bot] could not save state:", err);
  }
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------
function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
}

function isStatusRequest(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("where are we")) return true;
  if (STATUS_KEYWORDS.some((k) => lower.includes(k))) return true;
  // "full <wt>" / "everything <wt>" are status (full) commands.
  if ((lower.includes("full") || lower.includes("everything")) && resolveTargets(text).length > 0)
    return true;
  return false;
}

function isDecisionReply(text: string): boolean {
  return /^\s*(\d+\s*[a-z]?(\s+\d+\s*[a-z]?)*|done|skip|yes|no|y|n|ok|okay|proceed|continue|cancel|stop)\s*$/i.test(
    text,
  );
}

function isFullMode(text: string): boolean {
  const l = text.toLowerCase();
  return l.includes("full") || l.includes("everything");
}

/** Resolve which worktrees a message refers to via alias matching. */
function resolveTargets(text: string): WT[] {
  const tokens = new Set(tokenize(text));
  const lower = text.toLowerCase();
  const matched: WT[] = [];
  for (const wt of WTS) {
    const hit = ALIASES[wt].some((a) => {
      if (a.length >= 4) return tokens.has(a) || lower.includes(a);
      return tokens.has(a); // short/ambiguous aliases must be whole tokens
    });
    if (hit) matched.push(wt);
  }
  return matched;
}

// ---------------------------------------------------------------------------
// git + heartbeat readers
// ---------------------------------------------------------------------------
function gitBranch(wt: WT): string {
  try {
    return execFileSync("git", ["-C", worktreeDir(wt), "rev-parse", "--abbrev-ref", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "?";
  }
}
function gitCommits(wt: WT, branch: string, sinceISO: string, max: number): string[] {
  try {
    const out = execFileSync(
      "git",
      ["-C", worktreeDir(wt), "log", branch, "--oneline", `--since=${sinceISO}`, `-n${max}`],
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function gitCommitCount(wt: WT, branch: string, sinceISO: string): number {
  try {
    return Number(
      execFileSync(
        "git",
        ["-C", worktreeDir(wt), "rev-list", "--count", `--since=${sinceISO}`, branch],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .trim(),
    );
  } catch {
    return 0;
  }
}

function statusFiles(wt: WT): { log: string; current: string } {
  return {
    log: resolve(STATUS_DIR, `${wt}.log`),
    current: resolve(STATUS_DIR, `${wt}-current.txt`),
  };
}
function hasHeartbeat(wt: WT): boolean {
  const { current } = statusFiles(wt);
  return existsSync(current);
}
function currentLine(wt: WT): string {
  const { current } = statusFiles(wt);
  try {
    return readFileSync(current, "utf8").trim().split("\n")[0] || "no heartbeat yet";
  } catch {
    return "no heartbeat yet";
  }
}
function currentMtime(wt: WT): number {
  try {
    return statSync(statusFiles(wt).current).mtimeMs;
  } catch {
    return 0;
  }
}
/** Heartbeat log lines (the message part) newer than `sinceISO`. */
function logSince(wt: WT, sinceISO: string): string[] {
  const { log } = statusFiles(wt);
  const floor = new Date(sinceISO).getTime();
  let raw: string;
  try {
    raw = readFileSync(log, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const ts = new Date(line.slice(0, tab)).getTime();
    if (isNaN(ts) || ts <= floor) continue;
    const time = line.slice(11, 16); // HH:MM from the ISO prefix
    out.push(`${time} ${line.slice(tab + 1)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// synopsis builders
// ---------------------------------------------------------------------------
function truncateLog(lines: string[]): string {
  if (lines.length === 0) return "  — nothing new";
  if (lines.length > 10) {
    const head = lines.slice(0, 2);
    const tail = lines.slice(-5);
    const more = lines.length - head.length - tail.length;
    return [...head.map((l) => "  " + l), `  …(${more} more)…`, ...tail.map((l) => "  " + l)].join("\n");
  }
  return lines.map((l) => "  " + l).join("\n");
}

/** Detailed single-worktree synopsis. Advances lastAsked unless `full`. */
function synopsisSingle(wt: WT, state: State, full: boolean): string {
  if (!hasHeartbeat(wt)) return `${wt} hasn't started heartbeating yet.`;

  const branch = gitBranch(wt);
  const floor = full ? state.sessionStart : state.lastAsked[wt];
  const now = currentLine(wt);
  const logs = logSince(wt, floor);
  const maxCommits = full ? 20 : 6;
  const commits = gitCommits(wt, branch, floor, maxCommits);

  const lines: string[] = [];
  lines.push(`📦 ${wt.toUpperCase()} · ${branch}`);
  lines.push(`Now: ${now}`);
  lines.push(full ? "This session:" : "Since last asked:");
  lines.push(full ? logs.map((l) => "  " + l).join("\n") || "  — nothing" : truncateLog(logs));
  lines.push(
    `Commits:${commits.length ? "\n" + commits.map((c) => "  " + c).join("\n") : " — none"}`,
  );

  if (!full) {
    const stale = currentMtime(wt) <= new Date(state.lastAsked[wt]).getTime();
    if (stale && commits.length === 0) lines.push("⚠️ no movement — may be idle or stuck");
    state.lastAsked[wt] = nowISO(); // advance the peek window
  }
  return lines.join("\n");
}

/** Compact one-liner peek across worktrees. Does NOT advance lastAsked. */
function synopsisAllLine(wt: WT, state: State): string {
  if (!hasHeartbeat(wt)) return `📦 ${wt}: no heartbeat yet`;
  const branch = gitBranch(wt);
  const since = state.lastAsked[wt];
  const c = gitCommitCount(wt, branch, since);
  const m = logSince(wt, since).length;
  return `📦 ${wt}: ${currentLine(wt)} · ${c} commits / ${m} events since last ask`;
}

// ---------------------------------------------------------------------------
// message handling
// ---------------------------------------------------------------------------
const HELP = "Try: where are we on wt2 · what's backend doing · where are we";

async function handleMessage(text: string, state: State): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  // 1) Decision replies: relayed (recorded) and acknowledged, logic unchanged.
  if (!isStatusRequest(trimmed) && isDecisionReply(trimmed)) {
    try {
      appendFileSync(INBOX_FILE, `${nowISO()}\t${trimmed}\n`);
    } catch (err) {
      console.error("[bot] inbox write failed:", err);
    }
    await send(`✅ decision recorded: "${trimmed}"`);
    return;
  }

  // 2) Status requests.
  if (isStatusRequest(trimmed)) {
    const full = isFullMode(trimmed);
    const targets = resolveTargets(trimmed);

    if (full && targets.length >= 1) {
      const parts = targets.map((wt) => synopsisSingle(wt, state, true));
      await send(parts.join("\n\n"));
      saveState(state);
      return;
    }

    if (targets.length === 1) {
      const out = synopsisSingle(targets[0], state, false);
      await send(out);
      saveState(state);
      return;
    }

    if (targets.length === 0) {
      // no target → compact peek of all three (do not advance lastAsked)
      const out = WTS.map((wt) => synopsisAllLine(wt, state)).join("\n");
      await send(out);
      return;
    }

    // multiple specific targets → detailed for each (advances their windows)
    const parts = targets.map((wt) => synopsisSingle(wt, state, false));
    await send(parts.join("\n\n"));
    saveState(state);
    return;
  }

  // 3) Neither decision nor status.
  await send(HELP);
}

// ---------------------------------------------------------------------------
// main loop
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const state = loadState();

  // On a cold start with no offset, drain the backlog so we don't reply to old
  // messages — set the offset just past the latest pending update.
  if (!state.offset) {
    try {
      const r = await tg("getUpdates");
      const ids = (r.result ?? []).map((u: any) => u.update_id as number);
      state.offset = ids.length ? Math.max(...ids) + 1 : 0;
      saveState(state);
    } catch (err) {
      console.error("[bot] backlog drain failed:", err);
    }
  }

  console.log(`[bot] online. offset=${state.offset} sessionStart=${state.sessionStart}`);

  for (;;) {
    try {
      const r = await tg(`getUpdates?offset=${state.offset}&timeout=25`);
      for (const u of r.result ?? []) {
        state.offset = (u.update_id as number) + 1;
        const msg = u.message ?? u.edited_message;
        if (!msg || String(msg.chat?.id) !== CHAT_ID) continue; // only our chat
        const text = msg.text ?? "";
        console.log(`[bot] <- ${JSON.stringify(text)}`);
        await handleMessage(text, state);
      }
      saveState(state);
    } catch (err) {
      console.error("[bot] poll error:", err);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
