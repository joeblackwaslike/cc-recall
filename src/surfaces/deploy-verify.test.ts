import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDeployedPlugin } from './deploy-verify.js';

const PLUGIN_ID = 'cc-recall@agent-marketplace';
const RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
const GENERATED_AT = '2026-01-01T00:00:00.000Z';
// Manifest keys are install-root-relative (e.g. "dist/bin.js", "hooks/session-end.mjs"), not
// dist-relative -- see Finding 2, PR #77 review.
const BIN_JS = 'dist/bin.js';
const ORIGINAL_CONTENT = 'original content';

interface Fixture {
  root: string;
  installedPluginsPath: string;
  installPath: string;
}

const createFixture = (): Fixture => {
  const root = mkdtempSync(path.join(tmpdir(), 'cc-recall-deploy-verify-'));
  const installedPluginsPath = path.join(root, 'installed_plugins.json');
  const installPath = path.join(root, 'cache', 'cc-recall', '1.0.0');
  mkdirSync(path.join(installPath, 'dist'), { recursive: true });
  return { root, installedPluginsPath, installPath };
};

const writeInstalledPlugins = (fixture: Fixture, version: string): void => {
  writeFileSync(
    fixture.installedPluginsPath,
    JSON.stringify({
      version: '1.0.0',
      plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: fixture.installPath, version }] },
    }),
  );
};

const writeReleaseManifest = (
  fixture: Fixture,
  version: string,
  files: Record<string, string>,
): void => {
  writeFileSync(
    path.join(fixture.installPath, 'dist', RELEASE_MANIFEST_FILENAME),
    JSON.stringify({ version, generatedAt: GENERATED_AT, files }),
  );
};

describe('verifyDeployedPlugin', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('passes with a skip detail when installed_plugins.json does not exist', () => {
    const result = verifyDeployedPlugin(path.join(fixture.root, 'nope.json'));
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/not installed/);
  });

  it('passes with a skip detail when cc-recall has no entry in installed_plugins.json', () => {
    writeFileSync(fixture.installedPluginsPath, JSON.stringify({ version: '1.0.0', plugins: {} }));
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/not installed/);
  });

  it('fails when the installed cache has no shipped release-manifest.json', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/no release-manifest\.json/);
    expect(result.installedVersion).toBe('1.0.0');
  });

  it('fails when installed_plugins.json version diverges from the shipped manifest version', () => {
    writeInstalledPlugins(fixture, '1.1.0');
    writeReleaseManifest(fixture, '1.0.0', {});
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.installedVersion).toBe('1.1.0');
    expect(result.manifestVersion).toBe('1.0.0');
  });

  it('fails and lists mismatches when a file hash no longer matches', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    writeFileSync(path.join(fixture.installPath, BIN_JS), 'tampered content');
    writeReleaseManifest(fixture, '1.0.0', {
      [BIN_JS]: createHash('sha256').update(ORIGINAL_CONTENT).digest('hex'),
    });
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.mismatches).toEqual([`${BIN_JS}: hash mismatch`]);
  });

  it('passes when every file hash matches the shipped manifest', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    writeFileSync(path.join(fixture.installPath, BIN_JS), ORIGINAL_CONTENT);
    writeReleaseManifest(fixture, '1.0.0', {
      [BIN_JS]: createHash('sha256').update(ORIGINAL_CONTENT).digest('hex'),
    });
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/1 file verified/);
  });
});

describe('verifyDeployedPlugin malformed input handling', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('fails without throwing when installed_plugins.json is not valid JSON', () => {
    writeFileSync(fixture.installedPluginsPath, '{not valid json');
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/installed_plugins\.json is not valid JSON/);
  });

  it('fails without throwing when release-manifest.json is not valid JSON', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    writeFileSync(
      path.join(fixture.installPath, 'dist', RELEASE_MANIFEST_FILENAME),
      '{not valid json',
    );
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/release-manifest\.json is not valid JSON/);
  });

  it('fails without throwing when release-manifest.json contains valid JSON `null`', () => {
    // JSON.parse('null') succeeds and returns null -- it never throws, so the "not valid JSON"
    // catch above never fires. Without an explicit non-object guard, `manifest.version` on the
    // next line throws `TypeError: Cannot read properties of null`.
    writeInstalledPlugins(fixture, '1.0.0');
    writeFileSync(path.join(fixture.installPath, 'dist', RELEASE_MANIFEST_FILENAME), 'null');
    let result: ReturnType<typeof verifyDeployedPlugin> | undefined;
    expect(() => {
      result = verifyDeployedPlugin(fixture.installedPluginsPath);
    }).not.toThrow();
    expect(result?.pass).toBe(false);
    expect(result?.detail).toMatch(/does not contain a valid manifest object/);
  });

  it('fails without throwing when release-manifest.json contains a JSON array', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    writeFileSync(path.join(fixture.installPath, 'dist', RELEASE_MANIFEST_FILENAME), '[]');
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/does not contain a valid manifest object/);
  });

  it('fails without throwing when release-manifest.json contains a bare JSON number', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    writeFileSync(path.join(fixture.installPath, 'dist', RELEASE_MANIFEST_FILENAME), '42');
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/does not contain a valid manifest object/);
  });

  it('fails without throwing when the manifest has no files object', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    writeFileSync(
      path.join(fixture.installPath, 'dist', RELEASE_MANIFEST_FILENAME),
      JSON.stringify({ version: '1.0.0', generatedAt: GENERATED_AT }),
    );
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
  });
});

describe('verifyDeployedPlugin malformed input handling: entry shape and missing files', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
  });

  it('lists a manifest-listed file that is missing on disk as a mismatch', () => {
    writeInstalledPlugins(fixture, '1.0.0');
    writeReleaseManifest(fixture, '1.0.0', {
      [BIN_JS]: createHash('sha256').update(ORIGINAL_CONTENT).digest('hex'),
    });
    const result = verifyDeployedPlugin(fixture.installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.mismatches).toEqual([`${BIN_JS}: missing`]);
  });

  it('lists a manifest-listed path that resolves to a directory as a mismatch, without throwing', () => {
    // existsSync returns true for a directory, so without a read-failure guard this reaches
    // readFileSync and throws an uncaught EISDIR -- exactly the corrupted/tampered-manifest
    // failure mode this feature exists to detect (see findHashMismatches in deploy-verify.ts).
    writeInstalledPlugins(fixture, '1.0.0');
    mkdirSync(path.join(fixture.installPath, 'dist', 'not-a-file'));
    writeReleaseManifest(fixture, '1.0.0', {
      'dist/not-a-file': createHash('sha256').update(ORIGINAL_CONTENT).digest('hex'),
    });
    let result: ReturnType<typeof verifyDeployedPlugin> | undefined;
    expect(() => {
      result = verifyDeployedPlugin(fixture.installedPluginsPath);
    }).not.toThrow();
    expect(result?.pass).toBe(false);
    expect(result?.mismatches).toEqual([expect.stringContaining('dist/not-a-file')]);
  });

  it('fails without throwing when the matched entry has no installPath', () => {
    writeFileSync(
      fixture.installedPluginsPath,
      JSON.stringify({
        version: '1.0.0',
        plugins: { [PLUGIN_ID]: [{ version: '1.0.0' }] },
      }),
    );
    let result: ReturnType<typeof verifyDeployedPlugin> | undefined;
    expect(() => {
      result = verifyDeployedPlugin(fixture.installedPluginsPath);
    }).not.toThrow();
    expect(result?.pass).toBe(false);
    expect(result?.detail).toMatch(/missing installPath/);
  });

  it('fails without throwing when the matched entry has no version', () => {
    writeFileSync(
      fixture.installedPluginsPath,
      JSON.stringify({
        version: '1.0.0',
        plugins: { [PLUGIN_ID]: [{ installPath: fixture.installPath }] },
      }),
    );
    let result: ReturnType<typeof verifyDeployedPlugin> | undefined;
    expect(() => {
      result = verifyDeployedPlugin(fixture.installedPluginsPath);
    }).not.toThrow();
    expect(result?.pass).toBe(false);
    expect(result?.detail).toMatch(/missing version/);
  });
});
