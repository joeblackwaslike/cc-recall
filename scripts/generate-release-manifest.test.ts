// scripts/generate-release-manifest.test.ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest } from './generate-release-manifest.mjs';

describe('buildManifest', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cc-recall-manifest-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('hashes every .js file under the dist dir, keyed by relative path', () => {
    mkdirSync(path.join(dir, 'bin'), { recursive: true });
    mkdirSync(path.join(dir, 'src', 'engine'), { recursive: true });
    writeFileSync(path.join(dir, 'bin', 'cc-recall.js'), 'console.log(1);');
    writeFileSync(path.join(dir, 'src', 'engine', 'index.js'), 'export const x = 1;');
    writeFileSync(path.join(dir, 'bin', 'cc-recall.d.ts'), 'export {};');
    writeFileSync(path.join(dir, 'bin', 'cc-recall.js.map'), '{}');

    const manifest = buildManifest(dir, '1.2.3');

    expect(manifest.version).toBe('1.2.3');
    expect(Object.keys(manifest.files).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'bin/cc-recall.js',
      'src/engine/index.js',
    ]);
    expect(manifest.files['bin/cc-recall.js']).toBe(
      createHash('sha256').update('console.log(1);').digest('hex'),
    );
  });

  it('produces an empty file map for a dist dir with no .js files', () => {
    mkdirSync(dir, { recursive: true });
    const manifest = buildManifest(dir, '0.0.1');
    expect(manifest.files).toEqual({});
  });
});
