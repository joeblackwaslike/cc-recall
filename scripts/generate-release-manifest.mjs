#!/usr/bin/env node
// scripts/generate-release-manifest.mjs
//
// Generates dist/release-manifest.json: sha256 of every shipped, directly-executed file --
// dist/**/*.js plus the hooks/*.mjs and hooks/ensure-built.sh files that run as-is (never
// compiled into dist/) -- keyed by path relative to the plugin INSTALL ROOT (e.g.
// "dist/bin/cc-recall.js", "hooks/session-end.mjs"). Ships inside dist/ itself so the
// installed plugin cache carries its own verification manifest -- no network fetch needed for
// doctor's 4th check or the SessionStart self-check to verify the installed cache matches what
// was actually released.
// Spec: docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md, Process Improvements.
//
// CRITICAL -- release-only, never a local-build step:
// This script MUST ONLY be invoked by an actual release/publish process running from a clean,
// authoritative checkout (CI). It must NEVER be wired into `pnpm build`, and must never run as
// part of any locally-triggered rebuild -- hooks/ensure-built.sh's staleness-driven `pnpm
// build`, a developer's local `pnpm build`, etc. If a local rebuild regenerates this manifest
// from whatever happens to be on disk, the manifest becomes tautologically self-consistent with
// a possibly stale/partial/corrupted state, and the deploy self-verification feature this file
// exists to support would silently PASS on exactly the corrupted-deploy scenario it's meant to
// catch. Found in PR #77 review (chatgpt-codex-connector, P1) -- see the `build` vs
// `release:manifest` split in package.json.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const walkFiles = (dir, predicate, base = dir) => {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, predicate, base));
    } else if (predicate(entry.name)) {
      out.push(path.relative(base, full));
    }
  }
  return out;
};

const hashFile = (absolutePath) =>
  createHash('sha256').update(readFileSync(absolutePath)).digest('hex');

export const buildManifest = (distributionDir, hooksDir, version) => {
  const files = {};

  const distributionRelativePaths = walkFiles(
    distributionDir,
    (name) => name.endsWith('.js') && !name.endsWith('.test.js'),
  );
  for (const relativePath of distributionRelativePaths) {
    files[path.join('dist', relativePath)] = hashFile(path.join(distributionDir, relativePath));
  }

  const hookRelativePaths = walkFiles(hooksDir, (name) => name.endsWith('.mjs'));
  if (existsSync(path.join(hooksDir, 'ensure-built.sh'))) {
    hookRelativePaths.push('ensure-built.sh');
  }
  for (const relativePath of hookRelativePaths) {
    files[path.join('hooks', relativePath)] = hashFile(path.join(hooksDir, relativePath));
  }

  const sortedFiles = Object.fromEntries(
    Object.entries(files).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return { version, generatedAt: new Date().toISOString(), files: sortedFiles };
};

const main = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(here, '..');
  const distributionDir = path.join(repoRoot, 'dist');
  const hooksDir = path.join(repoRoot, 'hooks');
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const manifest = buildManifest(distributionDir, hooksDir, packageJson.version);
  writeFileSync(
    path.join(distributionDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `release-manifest.json: ${Object.keys(manifest.files).length} files, v${manifest.version}\n`,
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
