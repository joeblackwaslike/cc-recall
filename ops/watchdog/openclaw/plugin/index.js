import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
/**
 * claude-mem-watchdog — OpenClaw plugin (the Telegram approve/deny bridge).
 *
 * Registers an `inbound_claim` hook, which runs BEFORE command/agent dispatch.
 * For owner replies matching `approve <id>` / `deny <id>` it writes the decision
 * file the watchdog polls AND returns `{ handled: true }` to CLAIM the message —
 * so the OpenClaw agent never sees it and won't try to act on it. Any other
 * message is left unclaimed (returns undefined) and flows to the agent normally.
 *
 * Also self-bootstraps the owner's Telegram chat id from the first inbound
 * message (only if not already recorded).
 *
 * Fail-open: any error returns undefined (does NOT claim), so a bug here can
 * never swallow the owner's real messages to the agent.
 *
 * IMPORTANT: `definePluginEntry` lives on `openclaw/plugin-sdk/core`, NOT
 * `openclaw/plugin-sdk` (whose index does not re-export it). A plain-object
 * export loads without error but the loader never wires its register(), so the
 * hook silently never fires — the wrapper is required.
 */
import { definePluginEntry } from 'openclaw/plugin-sdk/core';

const STATE_DIR = path.join(os.homedir(), '.claude-mem-watchdog');
const DECISIONS_DIR = path.join(STATE_DIR, 'decisions');
const OWNER_FILE = path.join(STATE_DIR, 'owner.json');
const DECISION_RE = /^\s*(approve|deny)\s+([A-Za-z0-9_-]{2,64})\s*$/i;

async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf-8');
}

export default definePluginEntry({
  id: 'claude-mem-watchdog',
  name: 'claude-mem watchdog bridge',
  description:
    "Claims Telegram 'approve <id>' / 'deny <id>' replies for the claude-mem watchdog so the agent ignores them; self-bootstraps the owner chat id.",
  register(api) {
    api.on('inbound_claim', async (event, ctx) => {
      try {
        const channel = event?.channel ?? ctx?.channelId ?? '';
        if (channel && channel !== 'telegram') return; // only telegram; don't claim others

        const ownerId = String(
          event?.conversationId ?? ctx?.conversationId ?? event?.senderId ?? '',
        ).trim();

        // Self-bootstrap owner id once (only if not already recorded).
        if (ownerId) {
          try {
            await fs.access(OWNER_FILE);
          } catch {
            await writeJson(OWNER_FILE, {
              channel: 'telegram',
              id: ownerId,
              updatedAt: new Date().toISOString(),
            }).catch(() => {});
          }
        }

        const m = String(event?.content ?? '').match(DECISION_RE);
        if (!m) return; // not an approve/deny → let the agent handle it

        const verdict = m[1].toLowerCase();
        const requestId = m[2];
        await writeJson(path.join(DECISIONS_DIR, `${requestId}.json`), {
          requestId,
          verdict,
          from: ownerId,
          decidedAt: new Date().toISOString(),
        });
        api?.logger?.info?.(`claude-mem-watchdog: claimed "${verdict} ${requestId}"`);
        return { handled: true }; // claim → OpenClaw agent never processes it
      } catch (err) {
        api?.logger?.warn?.(`claude-mem-watchdog bridge error (failing open): ${String(err)}`);
        return; // fail open: never swallow real messages
      }
    });
  },
});
