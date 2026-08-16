#!/usr/bin/env node
// hooks/deploy-verify.mjs
//
// cc-recall SessionStart self-check: does the installed plugin cache match the release
// manifest it shipped with? Catches a self-deploy (autoUpdate) that bumped version metadata
// without actually replacing the fix-bearing files. Never blocks the session -- a mismatch is
// surfaced via systemMessage (same severity as a `doctor` failure), not a hard stop.
//
// Standalone by design, no imports from dist/src: SessionStart hook order isn't something to
// depend on (ensure-built.sh's own reason for staying bash instead of node), and this hook
// only ever reads JSON + hashes files from the INSTALLED cache path, never its own dist/.
//
// Cooldown mirrors pieces-dev's pieces-mcp-register.sh: a version-change guard skips
// re-verifying a version already confirmed clean, so this costs nothing on the common case
// (same version, every session).
// Spec: docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md, Process Improvements.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'cc-recall@agent-marketplace';
const STATUS_NO_MANIFEST = 'no-manifest';
const STATUS_PASS = 'pass';

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * `entry` is whatever `installed_plugins.json` on disk happens to contain for this plugin --
 * schema drift, a manual edit, or a write that died mid-way (e.g. an interrupted self-deploy)
 * can all leave it missing fields this module dereferences. Validate before `installPath`
 * reaches `path.join` (same bug class fixed in src/surfaces/deploy-verify.ts, commit 003e691).
 */
export const findEntryShapeError = (entry) => {
  if (!isNonEmptyString(entry.installPath)) {
    return `installed_plugins.json entry for ${PLUGIN_ID} is missing installPath`;
  }
  if (!isNonEmptyString(entry.version)) {
    return `installed_plugins.json entry for ${PLUGIN_ID} is missing version`;
  }
};

const MARKER_PATH = path.join(
  homedir(),
  '.claude',
  'cc-recall',
  'metrics',
  'deploy-verify-last.json',
);
const INSTALLED_PLUGINS_PATH = path.join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

export const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return;
  }
};

/**
 * Pure decision: given the installed_plugins.json entry and its shipped release manifest
 * (both already loaded), decide pass/mismatch/no-manifest and the file-level mismatches, if
 * any. `readFile(relativePath)` is injected so tests can supply fixture bytes without touching
 * disk.
 */
export const decide = (entry, manifest, readFile) => {
  if (!manifest) return { status: STATUS_NO_MANIFEST };
  if (manifest.version !== entry.version) {
    return { status: 'version-mismatch', manifestVersion: manifest.version };
  }
  const mismatches = [];
  const files = Object.entries(manifest.files ?? {});
  for (const [relativePath, expectedHash] of files) {
    let actualHash;
    try {
      actualHash = createHash('sha256').update(readFile(relativePath)).digest('hex');
    } catch {
      mismatches.push(relativePath);
      continue;
    }
    if (actualHash !== expectedHash) mismatches.push(relativePath);
  }
  return mismatches.length > 0 ? { status: 'file-mismatch', mismatches } : { status: STATUS_PASS };
};

const respond = (object) => process.stdout.write(JSON.stringify(object));
const proceed = () => respond({ continue: true, suppressOutput: true });
const warn = (message) => respond({ continue: true, systemMessage: message });

const writeMarker = (version, outcome) => {
  try {
    mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
    writeFileSync(
      MARKER_PATH,
      JSON.stringify({ version, result: outcome, checkedAt: new Date().toISOString() }),
    );
  } catch {
    /* best-effort */
  }
};

const isAlreadyVerified = (marker, entry) =>
  marker !== undefined && marker.version === entry.version && marker.result === STATUS_PASS;

export const runDeployCheck = (entry) => {
  const manifestPath = path.join(entry.installPath, 'dist', 'release-manifest.json');
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : undefined;
  return decide(entry, manifest, (relativePath) =>
    readFileSync(path.join(entry.installPath, 'dist', relativePath)),
  );
};

const reportInvalidEntry = (entry, detail) => {
  // Only key the marker on a version we can trust; a missing/invalid version means there's
  // nothing sane to compare against next session, so leave the marker alone rather than write
  // one that would never satisfy isAlreadyVerified.
  if (isNonEmptyString(entry.version)) writeMarker(entry.version, 'mismatch');
  warn(
    `cc-recall: ${detail} -- the plugin cache metadata may be corrupted. Run: claude plugin update cc-recall`,
  );
};

const reportResult = (entry, result) => {
  if (result.status === STATUS_NO_MANIFEST) {
    // Predates this check (older release, or a stale/corrupt build) -- not necessarily a real
    // problem, so don't alarm on every session either.
    writeMarker(entry.version, STATUS_NO_MANIFEST);
    proceed();
    return;
  }
  if (result.status === 'version-mismatch') {
    writeMarker(entry.version, 'mismatch');
    warn(
      `cc-recall: installed_plugins.json reports v${entry.version} but the shipped manifest says v${result.manifestVersion} — self-deploy may not have replaced files. Run: claude plugin update cc-recall`,
    );
    return;
  }
  if (result.status === 'file-mismatch') {
    writeMarker(entry.version, 'mismatch');
    warn(
      `cc-recall: ${result.mismatches.length} file(s) in the installed plugin cache don't match its own release manifest (v${entry.version}) — the cache may be corrupted. Run: claude plugin update cc-recall`,
    );
    return;
  }
  writeMarker(entry.version, STATUS_PASS);
  proceed();
};

const main = () => {
  // Defense in depth: findEntryShapeError below is the primary fix for the known "malformed
  // installed_plugins.json entry" case and produces a clean, specific systemMessage for it.
  // This try/catch is only a safety net for genuinely unexpected failures -- this hook must
  // never let an uncaught exception escape and surface a raw Node stack trace on session start.
  try {
    const installed = readJson(INSTALLED_PLUGINS_PATH);
    const entry = installed?.plugins?.[PLUGIN_ID]?.[0];
    if (!entry) {
      proceed();
      return;
    }

    const shapeError = findEntryShapeError(entry);
    if (shapeError) {
      reportInvalidEntry(entry, shapeError);
      return;
    }

    const marker = readJson(MARKER_PATH);
    if (isAlreadyVerified(marker, entry)) {
      proceed();
      return;
    }

    reportResult(entry, runDeployCheck(entry));
  } catch {
    proceed();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
