# Deployment Verification Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the deployment self-verification pattern (manual runbook + automated pattern) as a new subsection in the `marketplace-publishing` skill, and sharpen `claude-extras.md`'s existing marketplace-publishing bullet to point at it — completing the two docs-only deliverables of `cc-recall-x35` (the code deliverables — `cc-recall doctor`'s 4th check and the `SessionStart` self-check — ship separately via `docs/superpowers/plans/2026-08-15-deployment-self-verification.md`).

**Architecture:** Pure documentation. Two files, two different repos, no code:
- `/Users/joe/github/joeblackwaslike/personal-agent-skills/skills/marketplace-publishing/SKILL.md` — gains a new `## Deployment self-verification` subsection.
- `/Users/joe/github/joeblackwaslike/agent-harness/dist/claude-extras.md` — the *canonical* source (symlinked to `~/.claude/claude-extras.md`, confirmed via `readlink`) gets its existing marketplace-publishing bullet (lines 141–143) sharpened to mention deployment verification explicitly, so it's discoverable from the one place that already routes marketplace questions.

**Tech Stack:** Markdown only.

---

## Context for the engineer

- Spec: `docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md` (in the `cc-recall` repo), section "Process Improvements — Automated Self-Verification on Deploy" — read it first for the full motivation and the exact two pieces this plan documents (numbered list under "Placement — no new skill").
- **Why two repos:** `marketplace-publishing` is a skill that ships from `personal-agent-skills` (confirmed via `find`, and via `installed_plugins.json`'s `personal-agent-skills@agent-marketplace` entry pointing at a cache dir sourced from that repo — NOT the sibling `agent-skills` repo, which is a different, larger skills collection). `claude-extras.md` is Claude-Code-specific tool wiring that lives in `agent-harness` and is imported into every session via `~/.claude/CLAUDE.md`'s `@claude-extras.md` — confirmed via `readlink -f ~/.claude/claude-extras.md` → `/Users/joe/github/joeblackwaslike/agent-harness/dist/claude-extras.md`. Editing the symlink target edits what every session loads; nothing to run afterward.
- **RED check already run this session:** `grep -c "deployment verification\|self-verification\|release-manifest" <both files>` → `0` in both. Confirms the gap this plan closes. Re-run the same grep after each edit as that task's GREEN check.
- Per `claude-extras.md`'s own "Plan Execution Docs-Only Override," a plan whose every file action is markdown would normally execute directly, skipping `subagent-driven-development`. This plan is an explicit exception, per Joe's direct request in this session — implement it via `subagent-driven-development` as asked, not the direct-execution default.
- Content for the new skill subsection comes from the spec's own "Process Improvements" section (numbered items 1–2, `docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md` lines ~200–213) — this plan's Task 1 step gives the exact final prose already adapted for the skill's voice, not a placeholder to fill in later.
- The automated-pattern subsection should reference cc-recall's shipped implementation as the concrete example once `docs/superpowers/plans/2026-08-15-deployment-self-verification.md` ships: `scripts/generate-release-manifest.mjs` (manifest generation), `src/surfaces/deploy-verify.ts` (the compare logic, reused by `cc-recall doctor`'s 4th check), `hooks/deploy-verify.mjs` (the cooldown-gated `SessionStart` hook). If that plan hasn't shipped yet when this task runs, still write the pattern description (it's accurate regardless of shipping order) but phrase the cc-recall reference as "cc-recall's implementation" without claiming specific file paths are live — check with `git log --oneline -5` in the `cc-recall` repo or `bd show cc-recall-x35` first to know which phrasing applies.

---

### Task 1: Add the deployment self-verification subsection to `marketplace-publishing`

**Files:**
- Modify: `/Users/joe/github/joeblackwaslike/personal-agent-skills/skills/marketplace-publishing/SKILL.md`

- [ ] **Step 1: RED — confirm the gap**

Run: `grep -c "deployment verification\|self-verification\|release-manifest" /Users/joe/github/joeblackwaslike/personal-agent-skills/skills/marketplace-publishing/SKILL.md`
Expected: `0` (already confirmed this session — re-run to reconfirm current state before editing).

- [ ] **Step 2: Insert the new subsection**

The file's `## Versioning` section ends right before `## Key rules` (see the file's current structure — `Versioning` covers `plugin.json` version bumps, then `Key rules` is a flat bullet list). Insert a new `## Deployment self-verification` section between them:

```diff
 ## Versioning

 - Bump `version` in `.claude-plugin/plugin.json` on every Claude Code release — users only get updates when the string changes
 - Do not set `version` in both `plugin.json` and `marketplace.json` — `plugin.json` wins silently, so a stale manifest will block updates
 - Omit `version` entirely for git SHA versioning (every commit = new version, good for active dev) — this is the default pattern for Codex entries

+## Deployment self-verification
+
+`settings.json`'s `extraKnownMarketplaces.agent-marketplace.autoUpdate: true` means Claude Code
+self-deploys plugin updates automatically — but self-deploy has no verification step after it:
+it updates `installed_plugins.json`'s version metadata and stops there. A fix merged (or even
+released) can silently never reach the running plugin cache — this has recurred across multiple
+incidents (cc-recall's PM-001, PM-003, Incident B; see `cc-recall`'s
+`docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md` for the full pattern).
+
+### Manual verification runbook
+
+When you need to confirm a fix actually reached the installed plugin cache (not just the repo):
+
+1. Check `~/.claude/plugins/installed_plugins.json`'s entry for the plugin — read `version`,
+   `installPath`, and `lastUpdated`.
+2. **Do not trust `gitCommitSha` as a freshness signal** — it has been found stale (pointing at
+   an unrelated commit) even when `version` correctly showed the current release.
+3. The definitive check is byte-diffing the fix-bearing file(s) between the repo source and the
+   installed cache path (`diff <repo>/dist/<file> <installPath>/dist/<file>`, or a content hash
+   comparison for a whole directory).
+
+### Automated self-verification pattern
+
+For a plugin where this class of drift matters enough to check every session, not just when
+manually suspected:
+
+1. **At release time**, ship a manifest of fix-critical files with expected content hashes for
+   that version, generated by the build/release pipeline — not hand-maintained, so it can't go
+   stale independently of the code it describes.
+2. **A cheap, cooldown-gated `SessionStart` check** compares the installed cache against the
+   manifest. Cooldown so it only fires after an actual version change, not every session (same
+   shape as a version-change guard before a time-based cooldown, so the common case — same
+   version as last confirmed-clean check — costs nothing).
+3. **Match:** silently update a last-verified marker. **Mismatch:** loud, not silent — surfaced
+   with the same severity as a `doctor`/health-check failure, never swallowed.
+4. Ride the plugin's own `SessionStart` hook rather than a separate daemon — no `launchctl`
+   install/maintain burden, and it ships with the plugin itself.
+
+`cc-recall` is the reference implementation of this pattern: `scripts/generate-release-manifest.mjs`
+generates `dist/release-manifest.json` (sha256 of every built `.js` file) as part of its build;
+`src/surfaces/deploy-verify.ts` compares the installed cache against that shipped manifest, reused
+by both `cc-recall doctor`'s 4th check and `hooks/deploy-verify.mjs` (the cooldown-gated
+`SessionStart` hook). Read those three files directly for a concrete, working example before
+building a new instance of this pattern for another plugin.
+
 ## Key rules
```

- [ ] **Step 3: GREEN — confirm the edit landed**

Run: `grep -c "deployment verification\|self-verification\|release-manifest" /Users/joe/github/joeblackwaslike/personal-agent-skills/skills/marketplace-publishing/SKILL.md`
Expected: non-zero (several matches now).

- [ ] **Step 4: Commit**

```bash
cd /Users/joe/github/joeblackwaslike/personal-agent-skills
git add skills/marketplace-publishing/SKILL.md
git commit -m "docs(marketplace-publishing): add deployment self-verification subsection"
git push
```

(Per this repo's PR & Merge Autonomy standing grant — commit and push directly, no PR step needed unless this repo's own convention requires one; check `git log` first for the established pattern if unsure.)

---

### Task 2: Sharpen the `claude-extras.md` marketplace-publishing bullet

**Files:**
- Modify: `/Users/joe/github/joeblackwaslike/agent-harness/dist/claude-extras.md`

- [ ] **Step 1: RED — confirm the gap**

Run: `grep -c "deployment verification\|self-verification" /Users/joe/github/joeblackwaslike/agent-harness/dist/claude-extras.md`
Expected: `0` (already confirmed this session — re-run to reconfirm current state before editing).

- [ ] **Step 2: Sharpen the existing bullet**

Current text (lines 141–143 of `agent-harness/dist/claude-extras.md`):

```diff
 Self-hosted marketplace at `github.com/joeblackwaslike/agent-marketplace` supports Claude Code
 and Codex CLI. When asked to add/set up something as a plugin (Claude or Codex), or about
-versioning/manifest format/official submission, invoke the `marketplace-publishing` skill.
+versioning/manifest format/official submission/deployment verification (confirming a fix
+actually reached the installed plugin cache, not just the repo), invoke the
+`marketplace-publishing` skill.
```

- [ ] **Step 3: GREEN — confirm the edit landed**

Run: `grep -c "deployment verification\|self-verification" /Users/joe/github/joeblackwaslike/agent-harness/dist/claude-extras.md`
Expected: non-zero.

- [ ] **Step 4: Commit**

```bash
cd /Users/joe/github/joeblackwaslike/agent-harness
git add dist/claude-extras.md
git commit -m "docs(claude-extras): mention deployment verification in the marketplace-publishing bullet"
git push
```

(This file is symlinked into every session's live config — no separate deploy/reload step; the edit is live on the next session read. Per this repo's own exception in `AGENTS.md`'s "Git Worktrees for Parallel / Agent Work" section, work directly on `main` here, not a worktree.)

---

### Task 3: Verify and close out

- [ ] **Step 1: Confirm both files read correctly end-to-end**

Run: `sed -n '1,50p' /Users/joe/github/joeblackwaslike/personal-agent-skills/skills/marketplace-publishing/SKILL.md` and confirm the new section reads coherently in place (correct heading level, no stray diff markers left behind).

Run: `sed -n '138,148p' /Users/joe/github/joeblackwaslike/agent-harness/dist/claude-extras.md` and confirm the sharpened bullet reads coherently.

- [ ] **Step 2: Update bd**

Add a note to `cc-recall-x35` recording that the docs-only half shipped, referencing both commits (from Task 1 Step 4 and Task 2 Step 4). Only close `cc-recall-x35` once the code half (`docs/superpowers/plans/2026-08-15-deployment-self-verification.md`) has also shipped — this plan covers half of that bd issue, not all of it.

```bash
cd /Users/joe/github/joeblackwaslike/cc-recall
bd update cc-recall-x35 --notes="Docs half shipped: marketplace-publishing skill subsection (personal-agent-skills, commit <sha>) and claude-extras.md bullet sharpening (agent-harness, commit <sha>). Code half (doctor 4th check + SessionStart self-check) tracked separately via docs/superpowers/plans/2026-08-15-deployment-self-verification.md."
```
