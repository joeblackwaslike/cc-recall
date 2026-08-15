import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDeployedPlugin } from './deploy-verify.js';

const PLUGIN_ID = 'cc-recall@agent-marketplace';
const RELEASE_MANIFEST_FILENAME = 'release-manifest.json';
const GENERATED_AT = '2026-01-01T00:00:00.000Z';
const BIN_JS = 'bin.js';
const ORIGINAL_CONTENT = 'original content';

describe('verifyDeployedPlugin', () => {
  let root: string;
  let installedPluginsPath: string;
  let installPath: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'cc-recall-deploy-verify-'));
    installedPluginsPath = path.join(root, 'installed_plugins.json');
    installPath = path.join(root, 'cache', 'cc-recall', '1.0.0');
    mkdirSync(path.join(installPath, 'dist'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeInstalledPlugins = (version: string): void => {
    writeFileSync(
      installedPluginsPath,
      JSON.stringify({
        version: '1.0.0',
        plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath, version }] },
      }),
    );
  };

  const writeReleaseManifest = (version: string, files: Record<string, string>): void => {
    writeFileSync(
      path.join(installPath, 'dist', RELEASE_MANIFEST_FILENAME),
      JSON.stringify({ version, generatedAt: GENERATED_AT, files }),
    );
  };

  it('passes with a skip detail when installed_plugins.json does not exist', () => {
    const result = verifyDeployedPlugin(path.join(root, 'nope.json'));
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/not installed/);
  });

  it('passes with a skip detail when cc-recall has no entry in installed_plugins.json', () => {
    writeFileSync(installedPluginsPath, JSON.stringify({ version: '1.0.0', plugins: {} }));
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/not installed/);
  });

  it('fails when the installed cache has no shipped release-manifest.json', () => {
    writeInstalledPlugins('1.0.0');
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.detail).toMatch(/no release-manifest\.json/);
    expect(result.installedVersion).toBe('1.0.0');
  });

  it('fails when installed_plugins.json version diverges from the shipped manifest version', () => {
    writeInstalledPlugins('1.1.0');
    writeReleaseManifest('1.0.0', {});
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.installedVersion).toBe('1.1.0');
    expect(result.manifestVersion).toBe('1.0.0');
  });

  it('fails and lists mismatches when a file hash no longer matches', () => {
    writeInstalledPlugins('1.0.0');
    writeFileSync(path.join(installPath, 'dist', BIN_JS), 'tampered content');
    writeReleaseManifest('1.0.0', {
      [BIN_JS]: createHash('sha256').update(ORIGINAL_CONTENT).digest('hex'),
    });
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.mismatches).toEqual([`${BIN_JS}: hash mismatch`]);
  });

  it('passes when every file hash matches the shipped manifest', () => {
    writeInstalledPlugins('1.0.0');
    writeFileSync(path.join(installPath, 'dist', BIN_JS), ORIGINAL_CONTENT);
    writeReleaseManifest('1.0.0', {
      [BIN_JS]: createHash('sha256').update(ORIGINAL_CONTENT).digest('hex'),
    });
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/1 files verified/);
  });
});
