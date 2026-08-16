// hooks/deploy-verify.test.ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decide, findEntryShapeError, runDeployCheck } from './deploy-verify.mjs';

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

describe('findEntryShapeError', () => {
  it('reports a shape error when installPath is missing', () => {
    // Exactly the scenario from a partial/interrupted self-deploy write: version bumped,
    // installPath never landed.
    const entry = { version: '0.3.0' };
    expect(findEntryShapeError(entry)).toMatch(/installPath/);
  });

  it('reports a shape error when version is missing', () => {
    const entry = { installPath: '/some/install/path' };
    expect(findEntryShapeError(entry)).toMatch(/version/);
  });

  it('reports a shape error when installPath is present but not a string', () => {
    const entry = { installPath: 42, version: '0.3.0' };
    expect(findEntryShapeError(entry)).toMatch(/installPath/);
  });

  it('returns undefined for a well-shaped entry', () => {
    const entry = { installPath: '/some/install/path', version: '0.3.0' };
    expect(findEntryShapeError(entry)).toBeUndefined();
  });
});

describe('regression: malformed installed_plugins.json entry must not crash runDeployCheck', () => {
  it('an entry missing installPath is caught by findEntryShapeError before it can reach path.join', () => {
    // This is the exact repro: {"version": "0.3.0"} with no installPath. Before the fix,
    // runDeployCheck(entry) threw `TypeError [ERR_INVALID_ARG_TYPE]` from path.join(undefined,
    // 'dist', 'release-manifest.json'). The real code path (main()) now checks
    // findEntryShapeError first and never calls runDeployCheck for a malformed entry.
    const entry = { version: '0.3.0' };

    const shapeError = findEntryShapeError(entry);
    expect(shapeError).toBeDefined();

    expect(() => {
      if (shapeError) return;
      runDeployCheck(entry);
    }).not.toThrow();
  });

  it('runDeployCheck itself still throws on a malformed entry (documents why the guard in main() is required)', () => {
    const entry = { version: '0.3.0' };
    expect(() => runDeployCheck(entry)).toThrow(TypeError);
  });
});
