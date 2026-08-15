#!/usr/bin/env node
// scripts/generate-release-manifest.mjs
//
// Generates dist/release-manifest.json: sha256 of every built .js file under dist/, keyed by
// path relative to dist/. Ships inside dist/ itself so the installed plugin cache carries its
// own verification manifest -- no network fetch needed for doctor's 4th check or the
// SessionStart self-check to verify the installed cache matches what was actually released.
// Spec: docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md, Process Improvements.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const walkJsFiles = (dir, base = dir) => {
  const out = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(full, base));
    } else if (entry.name.endsWith('.js')) {
      out.push(path.relative(base, full));
    }
  }
  return out;
};

export const buildManifest = (distributionDir, version) => {
  const files = {};
  const relativePaths = walkJsFiles(distributionDir).toSorted((a, b) => a.localeCompare(b));
  for (const relativePath of relativePaths) {
    const bytes = readFileSync(path.join(distributionDir, relativePath));
    files[relativePath] = createHash('sha256').update(bytes).digest('hex');
  }
  return { version, generatedAt: new Date().toISOString(), files };
};

const main = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(here, '..');
  const distributionDir = path.join(repoRoot, 'dist');
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const manifest = buildManifest(distributionDir, packageJson.version);
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
