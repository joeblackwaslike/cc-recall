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

interface InstalledEntryResult {
  entry?: InstalledPluginEntry | undefined;
  parseError?: string;
}

const readInstalledEntry = (installedPluginsPath: string): InstalledEntryResult => {
  let raw: InstalledPluginsFile;
  try {
    raw = JSON.parse(readFileSync(installedPluginsPath, 'utf8')) as InstalledPluginsFile;
  } catch (error) {
    return {
      parseError: `installed_plugins.json is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // cc-recall is installed at a single scope in practice, so only the first install-scope entry
  // is inspected — a second entry (e.g. project-scoped alongside user-scoped) is silently ignored.
  return { entry: raw.plugins?.[PLUGIN_ID]?.[0] };
};

/**
 * `existsSync` only rules out "nothing there" -- it returns `true` for a directory (or other
 * non-regular-file entry), so a manifest listing a path that resolves to one (a corrupted or
 * tampered manifest, exactly the failure mode this feature exists to detect) would otherwise
 * reach `readFileSync` and throw an uncaught EISDIR straight out of `verifyDeployedPlugin`. The
 * read is wrapped so ANY read failure -- missing, EISDIR, EACCES, whatever -- degrades to a
 * reported mismatch instead of crashing, mirroring hooks/deploy-verify.mjs's `decide`.
 */
const findHashMismatches = (installRoot: string, manifest: ReleaseManifest): string[] => {
  const mismatches: string[] = [];
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const filePath = path.join(installRoot, relativePath);
    if (!existsSync(filePath)) {
      mismatches.push(`${relativePath}: missing`);
      continue;
    }
    let actualHash: string;
    try {
      actualHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    } catch (error) {
      mismatches.push(
        `${relativePath}: unreadable — ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (actualHash !== expectedHash) mismatches.push(`${relativePath}: hash mismatch`);
  }
  return mismatches;
};

const notInstalled = (): DeployVerifyResult => ({
  pass: true,
  detail: 'not installed via marketplace — nothing to verify',
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const pluralize = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * `readInstalledEntry` casts the parsed JSON with no runtime validation, so a matched entry's
 * fields can be anything the JSON on disk happens to contain (schema drift, a manual edit, a
 * write that died mid-way). Validate the fields this module actually dereferences before they
 * reach `path.join` or a version comparison.
 */
const findEntryShapeError = (entry: InstalledPluginEntry): string | undefined => {
  if (!isNonEmptyString(entry.installPath)) {
    return `installed_plugins.json entry for ${PLUGIN_ID} is missing installPath`;
  }
  if (!isNonEmptyString(entry.version)) {
    return `installed_plugins.json entry for ${PLUGIN_ID} is missing version`;
  }
  return undefined;
};

type ResolvedEntry = { entry: InstalledPluginEntry } | { result: DeployVerifyResult };

/**
 * Reads and shape-validates the matched `installed_plugins.json` entry, collapsing the "not
 * installed" / "not valid JSON" / "malformed entry" outcomes into a single early-return result
 * so callers only need to branch on whether a usable entry came back.
 */
const resolveInstalledEntry = (installedPluginsPath: string): ResolvedEntry => {
  const { entry, parseError } = readInstalledEntry(installedPluginsPath);
  if (parseError) return { result: { pass: false, detail: parseError } };
  if (!entry) return { result: notInstalled() };

  const shapeError = findEntryShapeError(entry);
  if (shapeError) {
    return {
      result: {
        pass: false,
        detail: shapeError,
        ...(isNonEmptyString(entry.version) && { installedVersion: entry.version }),
      },
    };
  }

  return { entry };
};

type ResolvedManifest = { manifest: ReleaseManifest } | { result: DeployVerifyResult };

/**
 * Reads, parses, and shape-validates release-manifest.json, collapsing the "not valid JSON" and
 * "valid JSON but not a manifest object" (e.g. a literal `null`, a bare number, an array --
 * JSON.parse succeeds on all of those without throwing) outcomes into a single early-return
 * result, mirroring `resolveInstalledEntry` above.
 */
const resolveManifest = (manifestPath: string, entry: InstalledPluginEntry): ResolvedManifest => {
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      result: {
        pass: false,
        detail: `release-manifest.json is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
        installedVersion: entry.version,
      },
    };
  }

  if (!isPlainObject(parsedManifest)) {
    return {
      result: {
        pass: false,
        detail:
          'release-manifest.json does not contain a valid manifest object (parsed to null or a non-object value)',
        installedVersion: entry.version,
      },
    };
  }

  return { manifest: parsedManifest as unknown as ReleaseManifest };
};

/**
 * Verify the installed cc-recall plugin cache matches the release manifest it shipped with.
 * `pass: true` covers both "verified clean" and "not applicable" (not installed via the
 * marketplace, e.g. running from a dev checkout) -- there is nothing wrong to report either way.
 */
export const verifyDeployedPlugin = (
  installedPluginsPath: string = defaultInstalledPluginsPath(),
): DeployVerifyResult => {
  if (!existsSync(installedPluginsPath)) return notInstalled();

  const resolved = resolveInstalledEntry(installedPluginsPath);
  if ('result' in resolved) return resolved.result;
  const { entry } = resolved;

  const manifestPath = path.join(entry.installPath, 'dist', 'release-manifest.json');
  if (!existsSync(manifestPath)) {
    return {
      pass: false,
      detail: `installed cache has no release-manifest.json (predates this check, or a stale build) at ${manifestPath}`,
      installedVersion: entry.version,
    };
  }

  const resolvedManifest = resolveManifest(manifestPath, entry);
  if ('result' in resolvedManifest) return resolvedManifest.result;
  const { manifest } = resolvedManifest;

  if (manifest.version !== entry.version) {
    return {
      pass: false,
      detail: `installed_plugins.json reports version ${entry.version} but the shipped manifest says ${manifest.version} — self-deploy updated metadata without replacing files`,
      installedVersion: entry.version,
      manifestVersion: manifest.version,
    };
  }

  if (!isPlainObject(manifest.files)) {
    return {
      pass: false,
      detail: 'release-manifest.json is malformed — "files" is missing or not an object',
      installedVersion: entry.version,
      manifestVersion: manifest.version,
    };
  }

  const mismatches = findHashMismatches(entry.installPath, manifest);
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
    detail: `installed cache (v${entry.version}) matches its release manifest — ${pluralize(Object.keys(manifest.files).length, 'file')} verified`,
    installedVersion: entry.version,
    manifestVersion: manifest.version,
  };
};
