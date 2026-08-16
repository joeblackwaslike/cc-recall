# Deployment Self-Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth `cc-recall doctor` check and a cooldown-gated `SessionStart` self-check that both compare the installed plugin cache against a release-time manifest of content hashes, catching a self-deploy (`autoUpdate`) that bumps `installed_plugins.json`'s version metadata without actually replacing the fix-bearing files.

**Architecture:** A build step (`scripts/generate-release-manifest.mjs`) hashes every `dist/*.js` file after `tsc` and writes `dist/release-manifest.json`, so the manifest ships as part of the installed cache itself — no network fetch needed to verify. `src/surfaces/deploy-verify.ts` compares `installed_plugins.json`'s recorded version/path for `cc-recall@agent-marketplace` against that shipped manifest, reused directly by `cc-recall doctor`'s 4th check. `hooks/deploy-verify.mjs` is a standalone (no `dist/src` imports) `SessionStart` hook duplicating the same compare logic, gated by a version-change marker so it costs nothing once a version is confirmed clean — mirroring `pieces-dev`'s `pieces-mcp-register.sh` cooldown pattern.

**Tech Stack:** TypeScript (strict, ESM, `src/`), plain Node ESM `.mjs` for `hooks/` and `scripts/` (matching this repo's existing convention — hooks are untyped and outside `tsconfig.json`'s `include`), Vitest, `node:crypto` (`sha256`), `node:fs`.

---

## Context for the engineer

- Spec: `docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md`, section "Process Improvements — Automated Self-Verification on Deploy". Read it first — it has the full motivation (a fix merged/released that never reached the running plugin cache, observed repeatedly: PM-001, PM-003, Incident B, PM-005).
- `installed_plugins.json` lives at `~/.claude/plugins/installed_plugins.json`. Top-level shape: `{ version, plugins }` where `plugins` is keyed by `"<name>@<marketplace>"` (e.g. `"cc-recall@agent-marketplace"`) and each value is an **array** of install records (one per scope). A record looks like:
  ```json
  {
    "scope": "user",
    "installPath": "/Users/joe/.claude/plugins/cache/agent-marketplace/cc-recall/0.3.0",
    "version": "0.3.0",
    "installedAt": "2026-06-16T00:54:25.965Z",
    "lastUpdated": "2026-08-14T06:15:09.829Z",
    "gitCommitSha": "1bc6ec1fb99b0b782158ae0c0f89cc998f4bb367"
  }
  ```
  Per the spec: **do not trust `gitCommitSha` as a freshness signal** — it was found stale even when `version` was current. Use `version` + `installPath`.
- `installPath` points at a directory containing a full copy of this repo's shipped tree, including `dist/` — e.g. `<installPath>/dist/bin/cc-recall.js`. That's why the manifest ships inside `dist/`: whatever gets copied to `installPath` on install/update carries its own verification data with it.
- `bin/cc-recall.ts`'s existing `runDoctor` (lines ~251–269) runs three checks today (sidecar+coverage via `reportSidecar`, `compactSidecar`'s vacuum is informational not a check, claude-mem G0, and an already-present-but-undocumented 4th line for `cc-recall-watchdog`). Each check is just a plain function call plus an `out()`/`err()` line — there's no registry to extend, just append another block.
- House pattern for a disk-backed marker/log (used by `src/metrics/adoption.ts`'s `metricsDir()`): resolve `~/.claude/cc-recall/metrics/`, override via env var for tests, `mkdirSync(dir, { recursive: true })` before every write, tolerate a missing/corrupt file by treating it as absent.
- `hooks/` is **outside** `tsconfig.json`'s `include` (`["src", "bin"]`) — hooks are plain untyped `.mjs`, matching `hooks/session-end.mjs` and `hooks/prompt-submit.mjs`. `hooks/ensure-built.sh` is bash specifically because it builds `dist/` itself and so can't depend on `dist/` already existing — this plan's new hook must stay standalone (no `dist/src` imports) for the same reason, even though it's Node: hook execution order across multiple `SessionStart` entries in `hooks.json` isn't something to depend on.
- Vitest has no explicit `test.include` in `vitest.config.ts`, so it picks up any `*.test.ts` anywhere in the repo by default — a test file under `hooks/` or `scripts/` will run under plain `pnpm test` without further config changes, and won't be type-checked by `pnpm typecheck` (`tsc --noEmit`) since those directories are outside `tsconfig.json`'s `include` — this matches the existing hooks precedent exactly, not a regression.

---

### Task 1: Manifest generator (`scripts/generate-release-manifest.mjs`)

**Files:**
- Create: `scripts/generate-release-manifest.mjs`
- Test: `scripts/generate-release-manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
    expect(Object.keys(manifest.files).toSorted()).toEqual([
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run scripts/generate-release-manifest.test.ts`
Expected: FAIL — `Cannot find module './generate-release-manifest.mjs'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```js
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
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsFiles(full, base));
    } else if (entry.name.endsWith('.js')) {
      out.push(path.relative(base, full));
    }
  }
  return out;
};

export const buildManifest = (distDir, version) => {
  const files = {};
  for (const relPath of walkJsFiles(distDir).toSorted()) {
    const bytes = readFileSync(path.join(distDir, relPath));
    files[relPath] = createHash('sha256').update(bytes).digest('hex');
  }
  return { version, generatedAt: new Date().toISOString(), files };
};

const main = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.join(here, '..');
  const distDir = path.join(repoRoot, 'dist');
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const manifest = buildManifest(distDir, pkg.version);
  writeFileSync(
    path.join(distDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  process.stdout.write(
    `release-manifest.json: ${Object.keys(manifest.files).length} files, v${manifest.version}\n`,
  );
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run scripts/generate-release-manifest.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into the build**

Edit `package.json`'s `"build"` script:

```diff
-    "build": "tsc",
+    "build": "tsc && node scripts/generate-release-manifest.mjs",
```

- [ ] **Step 6: Verify the real build produces a real manifest**

Run: `pnpm run build && cat dist/release-manifest.json | head -20`
Expected: valid JSON with `version` matching `package.json`'s current version, a `files` map with real `dist/**/*.js` paths and 64-char hex hashes.

- [ ] **Step 7: Commit**

```bash
git add scripts/generate-release-manifest.mjs scripts/generate-release-manifest.test.ts package.json
git commit -m "feat(release): generate a content-hash manifest of dist/ at build time"
```

---

### Task 2: `verifyDeployedPlugin` (`src/surfaces/deploy-verify.ts`)

**Files:**
- Create: `src/surfaces/deploy-verify.ts`
- Test: `src/surfaces/deploy-verify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/surfaces/deploy-verify.test.ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyDeployedPlugin } from './deploy-verify.js';

const PLUGIN_ID = 'cc-recall@agent-marketplace';

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
    writeFileSync(
      path.join(installPath, 'dist', 'release-manifest.json'),
      JSON.stringify({ version: '1.0.0', generatedAt: '2026-01-01T00:00:00.000Z', files: {} }),
    );
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.installedVersion).toBe('1.1.0');
    expect(result.manifestVersion).toBe('1.0.0');
  });

  it('fails and lists mismatches when a file hash no longer matches', () => {
    writeInstalledPlugins('1.0.0');
    writeFileSync(path.join(installPath, 'dist', 'bin.js'), 'tampered content');
    writeFileSync(
      path.join(installPath, 'dist', 'release-manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        files: { 'bin.js': createHash('sha256').update('original content').digest('hex') },
      }),
    );
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(false);
    expect(result.mismatches).toEqual(['bin.js: hash mismatch']);
  });

  it('passes when every file hash matches the shipped manifest', () => {
    writeInstalledPlugins('1.0.0');
    writeFileSync(path.join(installPath, 'dist', 'bin.js'), 'original content');
    writeFileSync(
      path.join(installPath, 'dist', 'release-manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        files: { 'bin.js': createHash('sha256').update('original content').digest('hex') },
      }),
    );
    const result = verifyDeployedPlugin(installedPluginsPath);
    expect(result.pass).toBe(true);
    expect(result.detail).toMatch(/1 files verified/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/surfaces/deploy-verify.test.ts`
Expected: FAIL — `Cannot find module './deploy-verify.js'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/surfaces/deploy-verify.ts
//
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

/**
 * Verify the installed cc-recall plugin cache matches the release manifest it shipped with.
 * `pass: true` covers both "verified clean" and "not applicable" (not installed via the
 * marketplace, e.g. running from a dev checkout) -- there is nothing wrong to report either way.
 */
export const verifyDeployedPlugin = (
  installedPluginsPath: string = defaultInstalledPluginsPath(),
): DeployVerifyResult => {
  if (!existsSync(installedPluginsPath)) {
    return { pass: true, detail: 'not installed via marketplace — nothing to verify' };
  }
  const entry = readInstalledEntry(installedPluginsPath);
  if (!entry) {
    return { pass: true, detail: 'not installed via marketplace — nothing to verify' };
  }
  const manifestPath = path.join(entry.installPath, 'dist', 'release-manifest.json');
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
  const mismatches: string[] = [];
  for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
    const filePath = path.join(entry.installPath, 'dist', relPath);
    if (!existsSync(filePath)) {
      mismatches.push(`${relPath}: missing`);
      continue;
    }
    const actualHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    if (actualHash !== expectedHash) mismatches.push(`${relPath}: hash mismatch`);
  }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/surfaces/deploy-verify.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm run typecheck`
Expected: clean, no errors.

- [ ] **Step 6: Commit**

```bash
git add src/surfaces/deploy-verify.ts src/surfaces/deploy-verify.test.ts
git commit -m "feat(doctor): add verifyDeployedPlugin, compares installed cache to its release manifest"
```

---

### Task 3: Wire into `cc-recall doctor` (4th check)

**Files:**
- Modify: `bin/cc-recall.ts`

- [ ] **Step 1: Add the import**

In `bin/cc-recall.ts`, add alongside the existing surface imports (after the `checkWatchdogInstalled` import, line 26):

```diff
+import { verifyDeployedPlugin } from '../src/surfaces/deploy-verify.js';
 import { checkWatchdogInstalled } from '../src/surfaces/watchdog.js';
```

(Keep the block alphabetically sorted the way the existing imports are — `deploy-verify` sorts before `watchdog`, so insert it on the line before.)

- [ ] **Step 2: Append the 4th check to `runDoctor`**

In `bin/cc-recall.ts`, extend `runDoctor` (currently lines 251–269):

```diff
   const watchdog = checkWatchdogInstalled();
   out(
     watchdog.installed
       ? `cc-recall-watchdog: installed (${watchdog.label})`
       : 'cc-recall-watchdog: NOT installed — independent spawn-rate/sidecar-growth observer is not running (run ops/cc-recall-watchdog/install.sh)',
   );
+  const deploy = verifyDeployedPlugin();
+  if (!deploy.pass) process.exitCode = 1;
+  out(deploy.pass ? `deployment: OK — ${deploy.detail}` : `deployment: MISMATCH — ${deploy.detail}`);
 };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm run typecheck`
Expected: clean.

- [ ] **Step 4: Build and smoke-test the real CLI**

Run: `pnpm run build && node dist/bin/cc-recall.js doctor`
Expected: five output lines (`sidecar`, `coverage`, `vacuum`, `claude-mem G0`, `cc-recall-watchdog`, `deployment`) — `deployment` line present and either `OK` (if cc-recall is installed via the marketplace and its cache matches) or a clear `MISMATCH` detail.

- [ ] **Step 5: Update the stale doctor docs**

`commands/recall/doctor.md` currently documents only 3 checks (`## What it checks`, lines 15–19), but `runDoctor` already ran a 4th (`cc-recall-watchdog`) before this plan even started — this plan adds a 5th (`deployment`). Apply this diff:

```diff
 ## What it checks
 
 1. **Sidecar integrity** — opens the database, counts sessions, runs an FTS probe. Reports OK or the error.
 2. **Backfill coverage** — what percentage of on-disk transcripts are indexed in the sidecar.
 3. **claude-mem G0** (spec S12) — probes the claude-mem worker for health, readiness, and a search round-trip. Surface 3 (claude-mem observations) stays disabled unless G0 passes. A G0 failure does NOT affect the sidecar or transcript surfaces.
+4. **cc-recall-watchdog liveness** — queries `launchctl` directly to confirm the independent spawn-rate/sidecar-growth observer is actually registered, not just installed at some point in the past.
+5. **Deployment self-verification** — compares the installed plugin cache (`installed_plugins.json`'s `version`/`installPath`) against the release-time content-hash manifest shipped inside `dist/release-manifest.json`, catching a self-deploy that bumped version metadata without actually replacing the fix-bearing files.
 
 ## Interpreting output
 
 ```text
 sidecar: OK — 15154 sessions at ~/.claude/cc-recall/index.db
 coverage: 98.2% (14882/15154 transcripts indexed)
 claude-mem G0: PASS — health + readiness + search round-trip OK (v2.1.0)
+cc-recall-watchdog: installed (com.ccrecall.watchdog-light)
+deployment: OK — installed cache (v0.3.0) matches its release manifest — 42 files verified
 ```
 
 Or on failure:
 
 ```text
 claude-mem G0: FAIL — worker not reachable (surface 3 stays disabled — sidecar unaffected)
+deployment: MISMATCH — installed_plugins.json reports version 0.3.0 but the shipped manifest says 0.2.2 — self-deploy updated metadata without replacing files
 ```
```

- [ ] **Step 6: Commit**

```bash
git add bin/cc-recall.ts commands/recall/doctor.md
git commit -m "feat(doctor): wire verifyDeployedPlugin in as the 4th (5th) health check"
```

---

### Task 4: `SessionStart` self-check hook (`hooks/deploy-verify.mjs`)

**Files:**
- Create: `hooks/deploy-verify.mjs`
- Test: `hooks/deploy-verify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// hooks/deploy-verify.test.ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decide } from './deploy-verify.mjs';

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
    const manifest = { version: '1.0.0', files: { 'bin/cc-recall.js': 'deadbeef' } };
    const result = decide(entry, manifest, () => Buffer.from('actual content'));
    expect(result).toEqual({ status: 'file-mismatch', mismatches: ['bin/cc-recall.js'] });
  });

  it('reports file-mismatch when a listed file is missing entirely', () => {
    const entry = { version: '1.0.0' };
    const manifest = { version: '1.0.0', files: { 'bin/cc-recall.js': 'deadbeef' } };
    const readFile = () => {
      throw new Error('ENOENT');
    };
    const result = decide(entry, manifest, readFile);
    expect(result).toEqual({ status: 'file-mismatch', mismatches: ['bin/cc-recall.js'] });
  });

  it('reports pass when every file hash matches', () => {
    const entry = { version: '1.0.0' };
    const hash = createHash('sha256').update('actual content').digest('hex');
    const manifest = { version: '1.0.0', files: { 'bin/cc-recall.js': hash } };
    const result = decide(entry, manifest, () => Buffer.from('actual content'));
    expect(result).toEqual({ status: 'pass' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run hooks/deploy-verify.test.ts`
Expected: FAIL — `Cannot find module './deploy-verify.mjs'`.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// hooks/deploy-verify.mjs
//
// cc-recall SessionStart self-check: does the installed plugin cache match the release
// manifest it shipped with? Catches a self-deploy (autoUpdate) that bumped version metadata
// without actually replacing the fix-bearing files. Never blocks the session -- a mismatch is
// surfaced via systemMessage (same severity as a `doctor` failure), not a hard stop.
//
// Standalone by design, no imports from dist/src: SessionStart hook order isn't something to
// depend on (ensure-built.sh's own reason for staying bash instead of node), and this hook
// only ever reads JSON + hashes files from the INSTALLED cache path, never its own dist/.
//
// Cooldown mirrors pieces-dev's pieces-mcp-register.sh: a version-change guard skips
// re-verifying a version already confirmed clean, so this costs nothing on the common case
// (same version, every session).
// Spec: docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md, Process Improvements.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const PLUGIN_ID = 'cc-recall@agent-marketplace';

export const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Pure decision: given the installed_plugins.json entry and its shipped release manifest
 * (both already loaded), decide pass/mismatch/no-manifest and the file-level mismatches, if
 * any. `readFile(relPath)` is injected so tests can supply fixture bytes without touching disk.
 */
export const decide = (entry, manifest, readFile) => {
  if (!manifest) return { status: 'no-manifest' };
  if (manifest.version !== entry.version) {
    return { status: 'version-mismatch', manifestVersion: manifest.version };
  }
  const mismatches = [];
  for (const [relPath, expectedHash] of Object.entries(manifest.files ?? {})) {
    let actualHash;
    try {
      actualHash = createHash('sha256').update(readFile(relPath)).digest('hex');
    } catch {
      mismatches.push(relPath);
      continue;
    }
    if (actualHash !== expectedHash) mismatches.push(relPath);
  }
  return mismatches.length > 0 ? { status: 'file-mismatch', mismatches } : { status: 'pass' };
};

const main = () => {
  const respond = (object) => process.stdout.write(JSON.stringify(object));
  const proceed = () => respond({ continue: true, suppressOutput: true });
  const warn = (message) => respond({ continue: true, systemMessage: message });

  const markerPath = path.join(
    homedir(),
    '.claude',
    'cc-recall',
    'metrics',
    'deploy-verify-last.json',
  );
  const installedPluginsPath = path.join(homedir(), '.claude', 'plugins', 'installed_plugins.json');

  const installed = readJson(installedPluginsPath);
  const entry = installed?.plugins?.[PLUGIN_ID]?.[0];
  if (!entry) {
    proceed();
    return;
  }

  const marker = readJson(markerPath);
  if (marker && marker.version === entry.version && marker.result === 'pass') {
    proceed();
    return;
  }

  const manifestPath = path.join(entry.installPath, 'dist', 'release-manifest.json');
  const manifest = existsSync(manifestPath) ? readJson(manifestPath) : undefined;
  const result = decide(entry, manifest, (relPath) =>
    readFileSync(path.join(entry.installPath, 'dist', relPath)),
  );

  const writeMarker = (outcome) => {
    try {
      mkdirSync(path.dirname(markerPath), { recursive: true });
      writeFileSync(
        markerPath,
        JSON.stringify({
          version: entry.version,
          result: outcome,
          checkedAt: new Date().toISOString(),
        }),
      );
    } catch {
      /* best-effort */
    }
  };

  if (result.status === 'no-manifest') {
    // Predates this check (older release, or a stale/corrupt build) -- not necessarily a real
    // problem, so don't alarm on every session either.
    writeMarker('no-manifest');
    proceed();
    return;
  }
  if (result.status === 'version-mismatch') {
    writeMarker('mismatch');
    warn(
      `cc-recall: installed_plugins.json reports v${entry.version} but the shipped manifest says v${result.manifestVersion} — self-deploy may not have replaced files. Run: claude plugin update cc-recall`,
    );
    return;
  }
  if (result.status === 'file-mismatch') {
    writeMarker('mismatch');
    warn(
      `cc-recall: ${result.mismatches.length} file(s) in the installed plugin cache don't match its own release manifest (v${entry.version}) — the cache may be corrupted. Run: claude plugin update cc-recall`,
    );
    return;
  }
  writeMarker('pass');
  proceed();
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run hooks/deploy-verify.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add hooks/deploy-verify.mjs hooks/deploy-verify.test.ts
git commit -m "feat(hooks): add cooldown-gated SessionStart deployment self-check"
```

---

### Task 5: Wire the hook into `hooks/hooks.json`

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 1: Add a second `SessionStart` entry**

```diff
   "hooks": {
     "SessionStart": [
       {
         "hooks": [
           {
             "type": "command",
             "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/ensure-built.sh\"",
             "timeout": 120
           }
         ]
+      },
+      {
+        "hooks": [
+          {
+            "type": "command",
+            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/deploy-verify.mjs\"",
+            "timeout": 10
+          }
+        ]
       }
     ],
```

- [ ] **Step 2: Manual smoke test — clean pass path**

Run (simulating a session with no `installed_plugins.json` entry, using a scratch `HOME`):

```bash
mkdir -p /tmp/cc-recall-hook-smoke/.claude/plugins
echo '{"version":"1.0.0","plugins":{}}' > /tmp/cc-recall-hook-smoke/.claude/plugins/installed_plugins.json
HOME=/tmp/cc-recall-hook-smoke node hooks/deploy-verify.mjs
```

Expected stdout: `{"continue":true,"suppressOutput":true}` (no entry for cc-recall → proceed silently).

- [ ] **Step 3: Manual smoke test — mismatch path**

```bash
mkdir -p /tmp/cc-recall-hook-smoke/.claude/plugins/cache/cc-recall/1.0.0/dist
cat > /tmp/cc-recall-hook-smoke/.claude/plugins/installed_plugins.json <<'JSON'
{"version":"1.0.0","plugins":{"cc-recall@agent-marketplace":[{"scope":"user","installPath":"/tmp/cc-recall-hook-smoke/.claude/plugins/cache/cc-recall/1.0.0","version":"1.0.0"}]}}
JSON
echo 'tampered' > /tmp/cc-recall-hook-smoke/.claude/plugins/cache/cc-recall/1.0.0/dist/bin.js
cat > /tmp/cc-recall-hook-smoke/.claude/plugins/cache/cc-recall/1.0.0/dist/release-manifest.json <<'JSON'
{"version":"1.0.0","generatedAt":"2026-01-01T00:00:00.000Z","files":{"bin.js":"0000000000000000000000000000000000000000000000000000000000000000"}}
JSON
HOME=/tmp/cc-recall-hook-smoke node hooks/deploy-verify.mjs
```

Expected stdout: a JSON object with `"continue":true` and a `"systemMessage"` mentioning `bin.js` / mismatch.

Clean up: `rm -rf /tmp/cc-recall-hook-smoke`

- [ ] **Step 4: Commit**

```bash
git add hooks/hooks.json
git commit -m "chore(hooks): register the deployment self-check as a SessionStart hook"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full typecheck**

Run: `pnpm run typecheck`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `pnpm exec vitest run`
Expected: all tests green, including the 2 + 6 + 5 new tests from Tasks 1, 2, 4 (13 new).

- [ ] **Step 3: Lint**

Run: `pnpm run lint` (or the repo's biome/eslint script — check `package.json`'s `scripts` block for the exact name if `lint` isn't it)
Expected: clean.

- [ ] **Step 4: Full build + real doctor run**

Run: `pnpm run build && node dist/bin/cc-recall.js doctor`
Expected: `deployment:` line present, `OK` if this machine's installed cc-recall cache (if any) matches its manifest.

- [ ] **Step 5: Close the bd issue**

```bash
bd close cc-recall-x35 --reason="Doctor's 4th check (verifyDeployedPlugin) and the cooldown-gated SessionStart self-check (hooks/deploy-verify.mjs) shipped and tested. Docs subsections (marketplace-publishing skill, claude-extras.md bullet) handled separately per the Docs-Only Override."
```

(Only close once the docs-only portions of `cc-recall-x35` — the `marketplace-publishing` skill subsection and the `claude-extras.md` bullet sharpening — are also done; those are handled directly, outside this plan, per the Docs-Only Override.)
