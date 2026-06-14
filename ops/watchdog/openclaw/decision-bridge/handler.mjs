/**
 * claude-mem-watchdog — OpenClaw decision bridge
 *
 * Registered as an internal `message_received` hook handler. Runs inside the
 * always-on OpenClaw Gateway, which is the only process actually listening to
 * Telegram. The launchd watchdog NEVER listens — it polls the files this
 * handler writes.
 *
 * Responsibilities:
 *  1. Self-bootstrap the owner's Telegram chat id (so the watchdog knows whom
 *     to DM) by recording the sender id of any inbound Telegram message.
 *  2. Translate an owner reply of `approve <id>` / `deny <id>` into a decision
 *     file the watchdog reads on its next tick.
 *
 * Defensive against OpenClaw event-envelope variations: reads fields from both
 * the spread context and a nested `.context`, and dumps the raw event to a
 * debug log on every call so the real shape can be confirmed during the spike.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".claude-mem-watchdog");
const DECISIONS_DIR = path.join(STATE_DIR, "decisions");
const OWNER_FILE = path.join(STATE_DIR, "owner.json");
const DEBUG_LOG = path.join(STATE_DIR, "logs", "bridge-debug.jsonl");

const DECISION_RE = /^\s*(approve|deny)\s+([A-Za-z0-9_-]{2,64})\s*$/i;

function fieldsFrom(event) {
  // Internal "message" hook event shape:
  //   { type: "message", action: "received", context: { from, content, channelId,
  //     conversationId, messageId, metadata: { senderId, ... } } }
  // Read from `.context` first; fall back to top-level for other envelopes.
  const ctx = (event && typeof event === "object" && event.context) ? event.context : event || {};
  const md = ctx.metadata || event?.metadata || {};
  const content = ctx.content ?? event?.content ?? "";
  const channelId = ctx.channelId ?? event?.channelId ?? "";
  const conversationId = ctx.conversationId ?? event?.conversationId ?? "";
  const from = ctx.from ?? event?.from ?? "";
  const senderId = md.senderId ?? ctx.senderId ?? from ?? "";
  return { content, channelId, conversationId, from, senderId };
}

// Debug logging is OFF by default — it would otherwise log every inbound
// message and grow unbounded (the exact failure class this project guards
// against). Enable by creating ~/.claude-mem-watchdog/BRIDGE_DEBUG.
let debugEnabled = null;
async function debug(line) {
  try {
    if (debugEnabled === null) {
      debugEnabled = await fs.access(path.join(STATE_DIR, "BRIDGE_DEBUG")).then(() => true).catch(() => false);
    }
    if (!debugEnabled) return;
    await fs.mkdir(path.dirname(DEBUG_LOG), { recursive: true });
    await fs.appendFile(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n", "utf-8");
  } catch { /* never throw from the hook */ }
}

export default async function onMessageReceived(event) {
  try {
    // Registered for internal event type "message"; only act on inbound ("received"),
    // never on the bot's own outbound ("sent") or other actions.
    if (event && event.action && event.action !== "received") return;

    const { content, channelId, conversationId, from, senderId } = fieldsFrom(event);
    await debug({ kind: "recv", channelId, senderId, from, conversationId, content: String(content).slice(0, 200) });

    // Only act on Telegram (channelId may be empty in some envelopes; allow through if unknown).
    if (channelId && channelId !== "telegram") return;

    // The id we DM back to. Prefer conversationId (chat), fall back to sender.
    const ownerId = String(conversationId || senderId || from || "").trim();
    if (ownerId) {
      try {
        await fs.mkdir(STATE_DIR, { recursive: true });
        await fs.writeFile(
          OWNER_FILE,
          JSON.stringify({ channel: "telegram", id: ownerId, updatedAt: new Date().toISOString() }, null, 2),
          "utf-8",
        );
      } catch { /* non-fatal */ }
    }

    const m = String(content || "").match(DECISION_RE);
    if (!m) return;
    const verdict = m[1].toLowerCase();
    const requestId = m[2];

    await fs.mkdir(DECISIONS_DIR, { recursive: true });
    await fs.writeFile(
      path.join(DECISIONS_DIR, `${requestId}.json`),
      JSON.stringify({ requestId, verdict, from: ownerId, decidedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );
    await debug({ kind: "decision", requestId, verdict, ownerId });
  } catch (err) {
    await debug({ kind: "error", error: String(err && err.stack ? err.stack : err) });
  }
}
