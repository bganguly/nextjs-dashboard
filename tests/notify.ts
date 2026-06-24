import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";

/**
 * Email notifications for the testing watcher.
 *
 * Credentials come from .env (gitignored):
 *   NOTIFY_EMAIL=you@gmail.com        # Gmail address used as sender + recipient
 *   NOTIFY_PASS=your-app-password     # Gmail App Password (NOT your login password)
 *
 * Generate an App Password at https://myaccount.google.com/apppasswords
 * (requires 2FA enabled on the Google account).
 */

/**
 * Minimal .env loader so this module works when run by plain `node`/`tsx`
 * outside of Next.js (which loads .env automatically). Existing process.env
 * values win; we never overwrite something already set.
 */
function loadDotEnv(file = resolve(process.cwd(), ".env")): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // no .env file — rely on whatever is already in process.env
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL ?? "";
const NOTIFY_PASS = process.env.NOTIFY_PASS ?? "";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";

// Values that mean "not filled in yet" — treated as unconfigured.
const PLACEHOLDERS = new Set([
  "you@gmail.com",
  "your-app-password",
  "PASTE_TOKEN_HERE",
  "123456:your-bot-token",
  "your-chat-id",
]);

function filled(v: string): boolean {
  return v.length > 0 && !PLACEHOLDERS.has(v);
}

export function emailConfigured(): boolean {
  return filled(NOTIFY_EMAIL) && filled(NOTIFY_PASS);
}

export function telegramConfigured(): boolean {
  return filled(TELEGRAM_TOKEN) && filled(TELEGRAM_CHAT_ID);
}

/** True if at least one notification channel is configured. */
export function notifyConfigured(): boolean {
  return emailConfigured() || telegramConfigured();
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: NOTIFY_EMAIL, pass: NOTIFY_PASS },
    });
  }
  return transporter;
}

async function sendEmail(subject: string, body: string): Promise<void> {
  await getTransporter().sendMail({
    from: NOTIFY_EMAIL,
    to: NOTIFY_EMAIL,
    subject,
    text: body,
  });
}

async function sendTelegram(subject: string, body: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `${subject}\n\n${body}`,
        disable_web_page_preview: true,
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${detail}`);
  }
}

export interface NotifyOptions {
  subject: string;
  body: string;
}

/**
 * Send a notification to every configured channel (email and/or Telegram).
 * Returns true if at least one channel delivered, false if none are
 * configured (so the watcher keeps running locally with placeholder .env
 * values without crashing). A failure in one channel does not prevent the
 * others from being attempted.
 */
export async function notify({ subject, body }: NotifyOptions): Promise<boolean> {
  if (!notifyConfigured()) {
    console.warn(
      "[notify] no channel configured (NOTIFY_EMAIL/NOTIFY_PASS or " +
        "TELEGRAM_TOKEN/TELEGRAM_CHAT_ID still placeholders?) — skipping.\n" +
        `[notify] would have sent: ${subject}`,
    );
    return false;
  }

  const channels: Array<[string, () => Promise<void>]> = [];
  if (emailConfigured()) channels.push(["email", () => sendEmail(subject, body)]);
  if (telegramConfigured())
    channels.push(["telegram", () => sendTelegram(subject, body)]);

  let anySent = false;
  for (const [name, send] of channels) {
    try {
      await send();
      anySent = true;
      console.log(`[notify] sent via ${name}: ${subject}`);
    } catch (err) {
      console.error(`[notify] ${name} delivery failed:`, err);
    }
  }
  return anySent;
}

/**
 * Called by the watcher when a single test fails 3 times in a row.
 */
export async function notifyBlocked(
  testName: string,
  failureCount: number,
  details: string,
): Promise<boolean> {
  const subject = `[TESTING] BLOCKED: ${testName} failed ${failureCount}x`;
  const body =
    `Test "${testName}" has failed ${failureCount} consecutive times.\n\n` +
    `Latest output:\n${details}\n\n` +
    `Worktree: ${process.cwd()}\n` +
    `Time: ${new Date().toISOString()}\n`;
  return notify({ subject, body });
}

// Allow `node tests/notify.ts --test` (or via tsx) to send a quick test email.
if (process.argv.includes("--test")) {
  notify({
    subject: "[TESTING] notify.ts self-test",
    body: "If you received this, notify.ts is configured correctly.",
  })
    .then((sent) =>
      console.log(sent ? "Test email sent." : "Skipped (not configured)."),
    )
    .catch((err) => {
      console.error("[notify] failed to send:", err);
      process.exitCode = 1;
    });
}
