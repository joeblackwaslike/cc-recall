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
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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
    const logFd = openSync(path.join(logDir, 'session-end.log'), 'a');
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
