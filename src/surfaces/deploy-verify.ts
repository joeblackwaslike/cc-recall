// Compares the installed plugin cache against the release manifest it shipped with (see
// scripts/generate-release-manifest.mjs), catching a self-deploy that bumped
// installed_plugins.json's version metadata without actually replacing the fix-bearing files.
// Spec: docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md, Process Improvements.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface DeployVerifyResult {
  pass: boolean;
  detail: string;
  installedVersion?: string;
  manifestVersion?: string;
  mismatches?: string[];
}

const PLUGIN_ID = 'cc-recall@agent-marketplace';

interface InstalledPluginEntry {
  installPath: string;
  version: string;
}

interface InstalledPluginsFile {
  plugins?: Record<string, InstalledPluginEntry[]>;
}

interface ReleaseManifest {
  version: string;
  generatedAt: string;
  files: Record<string, string>;
}

export const defaultInstalledPluginsPath = (): string =>
  path.join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

const readInstalledEntry = (installedPluginsPath: string): InstalledPluginEntry | undefined => {
  const raw = JSON.parse(readFileSync(installedPluginsPath, 'utf8')) as InstalledPluginsFile;
  return raw.plugins?.[PLUGIN_ID]?.[0];
};

const findHashMismatches = (distributionDir: string, manifest: ReleaseManifest): string[] => {
  const mismatches: string[] = [];
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const filePath = path.join(distributionDir, relativePath);
    if (!existsSync(filePath)) {
      mismatches.push(`${relativePath}: missing`);
      continue;
    }
    const actualHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    if (actualHash !== expectedHash) mismatches.push(`${relativePath}: hash mismatch`);
  }
  return mismatches;
};

const notInstalled = (): DeployVerifyResult => ({
  pass: true,
  detail: 'not installed via marketplace — nothing to verify',
});

/**
 * Verify the installed cc-recall plugin cache matches the release manifest it shipped with.
 * `pass: true` covers both "verified clean" and "not applicable" (not installed via the
 * marketplace, e.g. running from a dev checkout) -- there is nothing wrong to report either way.
 */
export const verifyDeployedPlugin = (
  installedPluginsPath: string = defaultInstalledPluginsPath(),
): DeployVerifyResult => {
  if (!existsSync(installedPluginsPath)) return notInstalled();

  const entry = readInstalledEntry(installedPluginsPath);
  if (!entry) return notInstalled();

  const distributionDir = path.join(entry.installPath, 'dist');
  const manifestPath = path.join(distributionDir, 'release-manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      pass: false,
      detail: `installed cache has no release-manifest.json (predates this check, or a stale build) at ${manifestPath}`,
      installedVersion: entry.version,
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ReleaseManifest;
  if (manifest.version !== entry.version) {
    return {
      pass: false,
      detail: `installed_plugins.json reports version ${entry.version} but the shipped manifest says ${manifest.version} — self-deploy updated metadata without replacing files`,
      installedVersion: entry.version,
      manifestVersion: manifest.version,
    };
  }

  const mismatches = findHashMismatches(distributionDir, manifest);
  if (mismatches.length > 0) {
    return {
      pass: false,
      detail: `${mismatches.length} file(s) in the installed cache don't match the release manifest`,
      installedVersion: entry.version,
      manifestVersion: manifest.version,
      mismatches,
    };
  }

  return {
    pass: true,
    detail: `installed cache (v${entry.version}) matches its release manifest — ${Object.keys(manifest.files).length} files verified`,
    installedVersion: entry.version,
    manifestVersion: manifest.version,
  };
};
