// hooks/deploy-verify.test.ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decide, findEntryShapeError, runDeployCheck } from './deploy-verify.mjs';

const TARGET_FILE = 'bin/cc-recall.js';
const ACTUAL_CONTENT = 'actual content';
const STATUS_MANIFEST_MALFORMED = 'manifest-malformed';
const TMP_DIR_PREFIX = 'cc-recall-deploy-verify-';

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

  it('reports manifest-malformed (not a silent pass) when a valid manifest is missing "files"', () => {
    // Regression: manifest.files ?? {} previously made a missing `files` key indistinguishable
    // from an empty-but-valid file list, so this collapsed into a false "pass" with zero
    // mismatches checked. That's the same "truncated mid-deploy write" scenario the JSON-parse
    // case exists to catch, just one step further along -- valid JSON, malformed contents.
    const entry = { version: '1.0.0' };
    const manifest = { version: '1.0.0' };
    const result = decide(entry, manifest, () => Buffer.from(ACTUAL_CONTENT));
    expect(result).toEqual({ status: STATUS_MANIFEST_MALFORMED });
  });

  it('reports manifest-malformed when "files" is present but not a plain object', () => {
    const entry = { version: '1.0.0' };
    const manifest = { version: '1.0.0', files: ['not', 'an', 'object'] };
    const result = decide(entry, manifest, () => Buffer.from(ACTUAL_CONTENT));
    expect(result).toEqual({ status: STATUS_MANIFEST_MALFORMED });
  });
});

describe('runDeployCheck: manifest exists but is corrupt/malformed', () => {
  // These reproduce the exact "truncated mid-deploy write" scenario this feature exists to
  // catch, and the divergence a holistic review found between this hook and
  // src/surfaces/deploy-verify.ts's verifyDeployedPlugin (commit dba66b8): before this fix,
  // `existsSync(manifestPath) ? readJson(manifestPath) : undefined` produced `undefined` both
  // when the manifest file is genuinely absent AND when it exists but fails to parse, so a
  // corrupt manifest silently collapsed into the harmless no-manifest status instead of warning.
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports manifest-invalid (not no-manifest) when release-manifest.json is present but not valid JSON', () => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_DIR_PREFIX));
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'dist', 'release-manifest.json'), 'not valid json {');

    const entry = { installPath: dir, version: '1.0.0' };
    const result = runDeployCheck(entry);

    expect(result).toEqual({ status: 'manifest-invalid' });
  });

  it('reports manifest-malformed (not no-manifest) when release-manifest.json is valid JSON but "files" is missing', () => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_DIR_PREFIX));
    mkdirSync(path.join(dir, 'dist'), { recursive: true });
    writeFileSync(
      path.join(dir, 'dist', 'release-manifest.json'),
      JSON.stringify({ version: '1.0.0' }),
    );

    const entry = { installPath: dir, version: '1.0.0' };
    const result = runDeployCheck(entry);

    expect(result).toEqual({ status: STATUS_MANIFEST_MALFORMED });
  });

  it('still reports no-manifest when release-manifest.json genuinely does not exist', () => {
    dir = mkdtempSync(path.join(tmpdir(), TMP_DIR_PREFIX));
    mkdirSync(path.join(dir, 'dist'), { recursive: true });

    const entry = { installPath: dir, version: '1.0.0' };
    const result = runDeployCheck(entry);

    expect(result).toEqual({ status: 'no-manifest' });
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
