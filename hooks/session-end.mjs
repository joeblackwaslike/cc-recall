#!/usr/bin/env node
// cc-recall SessionEnd hook (spec §S2: forward capture).
//
// Fires when a session ends. It indexes the just-finished transcript into the sidecar
// and injects the discoverability record. Synthesis can call `claude -p` (slow), so this
// NEVER blocks or fails the session: it launches a detached background `cc-recall index`
// and returns immediately. Output is logged for debugging. Env knobs:
//   CC_RECALL_LLM=0       heuristic only (skip the LLM enrichment)
//   CC_RECALL_DB=<path>   sidecar database path
//   CC_RECALL_BASE_DIR=<path>  backup/log base directory

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const BYTES_PER_MIB = 1_048_576;
/** Rotate at 10MB, keep one previous generation. Measured at 23MB / 309k lines before this. */
const LOG_MAX_BYTES = 10 * BYTES_PER_MIB;

/**
 * Roll the log over when it grows past the cap.
 *
 * Entirely best-effort: this runs inside a SessionEnd hook, where the standing rule is that
 * nothing may fail the session. A rotation that throws would be a worse outcome than a large
 * log, so every step swallows. Keeping exactly one `.1` generation bounds the pair at ~20MB
 * instead of the unbounded single file it replaces.
 */
const rotateIfOversized = (logPath) => {
  try {
    if (statSync(logPath).size < LOG_MAX_BYTES) return;
    const previous = `${logPath}.1`;
    try {
      unlinkSync(previous);
    } catch {
      /* no previous generation to displace */
    }
    renameSync(logPath, previous);
  } catch {
    /* missing log, unwritable dir, racing hook — none of it may break the session */
  }
};

const respond = (object) => {
  process.stdout.write(JSON.stringify(object));
};
const proceed = () => respond({ continue: true, suppressOutput: true });

const readPayload = () => {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

const payload = readPayload();
const transcriptPath = payload.transcript_path;
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;

if (!transcriptPath || !pluginRoot) {
  proceed();
} else {
  const baseDir = process.env.CC_RECALL_BASE_DIR || path.join(homedir(), '.claude', 'cc-recall');
  const cli = path.join(pluginRoot, 'dist', 'bin', 'cc-recall.js');

  const args = ['index', transcriptPath, '--base-dir', baseDir];
  if (process.env.CC_RECALL_DB) args.push('--db', process.env.CC_RECALL_DB);
  if (process.env.CC_RECALL_LLM === '0' || process.env.CC_RECALL_LLM === 'false') {
    args.push('--no-llm');
  }

  try {
    const logDir = path.join(baseDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'session-end.log');
    rotateIfOversized(logPath);
    const logFd = openSync(logPath, 'a');
    const child = spawn(process.execPath, [cli, ...args], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
  } catch (error) {
    // forward capture is best-effort; a hook failure must never break the session
    process.stderr.write(`cc-recall session-end: ${error}\n`);
  }
  proceed();
}
