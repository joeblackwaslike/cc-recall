// scripts/generate-release-manifest.test.ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest } from './generate-release-manifest.mjs';

const MODULE_CONTENT = 'export const x = 1;';
const BIN_CONTENT = 'console.log(1);';

describe('buildManifest', () => {
  let dir: string;
  let distributionDir: string;
  let hooksDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cc-recall-manifest-'));
    distributionDir = path.join(dir, 'dist');
    hooksDir = path.join(dir, 'hooks');
    mkdirSync(distributionDir, { recursive: true });
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes every .js file under dist, keyed install-root-relative with a dist/ prefix', () => {
    mkdirSync(path.join(distributionDir, 'bin'), { recursive: true });
    mkdirSync(path.join(distributionDir, 'src', 'engine'), { recursive: true });
    writeFileSync(path.join(distributionDir, 'bin', 'cc-recall.js'), BIN_CONTENT);
    writeFileSync(path.join(distributionDir, 'src', 'engine', 'index.js'), MODULE_CONTENT);
    writeFileSync(path.join(distributionDir, 'bin', 'cc-recall.d.ts'), 'export {};');
    writeFileSync(path.join(distributionDir, 'bin', 'cc-recall.js.map'), '{}');

    const manifest = buildManifest(distributionDir, hooksDir, '1.2.3');

    expect(manifest.version).toBe('1.2.3');
    expect(Object.keys(manifest.files).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'dist/bin/cc-recall.js',
      'dist/src/engine/index.js',
    ]);
    expect(manifest.files['dist/bin/cc-recall.js']).toBe(
      createHash('sha256').update(BIN_CONTENT).digest('hex'),
    );
  });

  it('hashes hooks/*.mjs and hooks/ensure-built.sh, keyed with a hooks/ prefix', () => {
    writeFileSync(path.join(hooksDir, 'session-end.mjs'), MODULE_CONTENT);
    writeFileSync(path.join(hooksDir, 'ensure-built.sh'), '#!/usr/bin/env bash\necho hi\n');
    writeFileSync(path.join(hooksDir, 'hooks.json'), '{}');
    writeFileSync(path.join(hooksDir, 'session-end.test.ts'), 'it.todo("x");');

    const manifest = buildManifest(distributionDir, hooksDir, '1.2.3');

    expect(Object.keys(manifest.files).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'hooks/ensure-built.sh',
      'hooks/session-end.mjs',
    ]);
    expect(manifest.files['hooks/session-end.mjs']).toBe(
      createHash('sha256').update(MODULE_CONTENT).digest('hex'),
    );
  });

  it('produces an empty file map when dist and hooks have no matching files', () => {
    const manifest = buildManifest(distributionDir, hooksDir, '0.0.1');
    expect(manifest.files).toEqual({});
  });

  it('excludes compiled test files from the dist walk', () => {
    mkdirSync(path.join(distributionDir, 'bin'), { recursive: true });
    mkdirSync(path.join(distributionDir, 'src'), { recursive: true });
    writeFileSync(path.join(distributionDir, 'bin', 'cc-recall.js'), BIN_CONTENT);
    writeFileSync(path.join(distributionDir, 'src', 'engine.test.js'), 'it.todo("x");');

    const manifest = buildManifest(distributionDir, hooksDir, '1.2.3');

    expect(Object.keys(manifest.files)).toEqual(['dist/bin/cc-recall.js']);
    expect(manifest.files).not.toHaveProperty('dist/src/engine.test.js');
  });
});
