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
const STATUS_MANIFEST_INVALID = 'manifest-invalid';
const STATUS_MANIFEST_MALFORMED = 'manifest-malformed';
const STATUS_PASS = 'pass';

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
 *
 * `manifest === undefined` means "genuinely no manifest file" (predates this feature) --
 * `runDeployCheck` only passes `undefined` here when `existsSync` already confirmed the file
 * is absent. A manifest that exists but fails to parse, or parses but has a malformed `files`
 * key, is a distinct real-problem case and must not collapse into this same no-manifest status
 * (mirrors src/surfaces/deploy-verify.ts's verifyDeployedPlugin, commit dba66b8).
 *
 * Valid JSON `null` (or a number/string/array) parses without throwing, so it never reaches the
 * `undefined` branch above -- `!manifest` used to treat `null` as "genuinely no manifest" too,
 * silently passing through the exact "truncated mid-deploy write" scenario this feature exists
 * to catch. Anything that isn't a plain object at this point is malformed, not absent.
 */
export const decide = (entry, manifest, readFile) => {
  if (manifest === undefined) return { status: STATUS_NO_MANIFEST };
  if (!isPlainObject(manifest)) return { status: STATUS_MANIFEST_MALFORMED };
  if (manifest.version !== entry.version) {
    return { status: 'version-mismatch', manifestVersion: manifest.version };
  }
  if (!isPlainObject(manifest.files)) {
    return { status: STATUS_MANIFEST_MALFORMED };
  }
  const mismatches = [];
  const files = Object.entries(manifest.files);
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
  // relativePath now comes from the manifest's install-root-relative keys (e.g.
  // "dist/bin/cc-recall.js", "hooks/session-end.mjs") -- it already carries its own dist/ or
  // hooks/ prefix, so this resolves against the install root, not dist/ directly.
  const readFile = (relativePath) => readFileSync(path.join(entry.installPath, relativePath));

  if (!existsSync(manifestPath)) {
    // Genuinely absent -- predates this feature (older release, or a stale/corrupt build).
    // Harmless by convention, so this is the only case that reaches `decide` with `undefined`.
    return decide(entry, undefined, readFile);
  }

  const manifest = readJson(manifestPath);
  if (manifest === undefined) {
    // The file exists but readJson's JSON.parse failed -- the exact "truncated mid-deploy
    // write" scenario this whole feature exists to catch. Must not collapse into no-manifest.
    return { status: STATUS_MANIFEST_INVALID };
  }

  return decide(entry, manifest, readFile);
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

// Every non-pass, non-"genuinely no manifest" outcome is a real mismatch: same 'mismatch'
// marker, same systemMessage severity, just a status-specific message. Keyed by result.status
// so reportResult stays a flat dispatch instead of a long if/else chain.
const MISMATCH_MESSAGES = {
  [STATUS_MANIFEST_INVALID]: () =>
    'cc-recall: release-manifest.json in the installed plugin cache is not valid JSON — the cache may be corrupted. Run: claude plugin update cc-recall',
  [STATUS_MANIFEST_MALFORMED]: () =>
    'cc-recall: release-manifest.json in the installed plugin cache is malformed (missing or invalid "files") — the cache may be corrupted. Run: claude plugin update cc-recall',
  'version-mismatch': (entry, result) =>
    `cc-recall: installed_plugins.json reports v${entry.version} but the shipped manifest says v${result.manifestVersion} — self-deploy may not have replaced files. Run: claude plugin update cc-recall`,
  'file-mismatch': (entry, result) =>
    `cc-recall: ${result.mismatches.length} file(s) in the installed plugin cache don't match its own release manifest (v${entry.version}) — the cache may be corrupted. Run: claude plugin update cc-recall`,
};

const reportResult = (entry, result) => {
  if (result.status === STATUS_NO_MANIFEST) {
    // Predates this check (older release, or a stale/corrupt build) -- not necessarily a real
    // problem, so don't alarm on every session either.
    writeMarker(entry.version, STATUS_NO_MANIFEST);
    proceed();
    return;
  }
  if (result.status === STATUS_PASS) {
    writeMarker(entry.version, STATUS_PASS);
    proceed();
    return;
  }
  writeMarker(entry.version, 'mismatch');
  warn(MISMATCH_MESSAGES[result.status](entry, result));
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
