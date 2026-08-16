// hooks/deploy-verify.test.ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decide } from './deploy-verify.mjs';

const TARGET_FILE = 'bin/cc-recall.js';
const ACTUAL_CONTENT = 'actual content';

const throwEnoent = () => {
  throw new Error('ENOENT');
};

describe('decide', () => {
  it('reports no-manifest when the installed cache predates this check', () => {
    const result = decide({ version: '1.0.0' }, undefined, () => Buffer.from(''));
    expect(result).toEqual({ status: 'no-manifest' });
  });

  it('reports version-mismatch when installed_plugins.json diverges from the shipped manifest', () => {
    const entry = { version: '1.1.0' };
    const manifest = { version: '1.0.0', files: {} };
    const result = decide(entry, manifest, () => Buffer.from(''));
    expect(result).toEqual({ status: 'version-mismatch', manifestVersion: '1.0.0' });
  });

  it('reports file-mismatch when a file hash no longer matches', () => {
    const entry = { version: '1.0.0' };
    const manifest = { version: '1.0.0', files: { [TARGET_FILE]: 'deadbeef' } };
    const result = decide(entry, manifest, () => Buffer.from(ACTUAL_CONTENT));
    expect(result).toEqual({ status: 'file-mismatch', mismatches: [TARGET_FILE] });
  });

  it('reports file-mismatch when a listed file is missing entirely', () => {
    const entry = { version: '1.0.0' };
    const manifest = { version: '1.0.0', files: { [TARGET_FILE]: 'deadbeef' } };
    const result = decide(entry, manifest, throwEnoent);
    expect(result).toEqual({ status: 'file-mismatch', mismatches: [TARGET_FILE] });
  });

  it('reports pass when every file hash matches', () => {
    const entry = { version: '1.0.0' };
    const hash = createHash('sha256').update(ACTUAL_CONTENT).digest('hex');
    const manifest = { version: '1.0.0', files: { [TARGET_FILE]: hash } };
    const result = decide(entry, manifest, () => Buffer.from(ACTUAL_CONTENT));
    expect(result).toEqual({ status: 'pass' });
  });
});
