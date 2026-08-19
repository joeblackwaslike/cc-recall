# Cross-Provider Quota-Monitoring Plugin — Design Spec (Phase 6)

**Design-only. No code is written for this ticket** (`cc-recall-nfb`).

## Context

Incident B (`docs/superpowers/specs/2026-08-10-incident-b-root-cause-and-guardrails.md`) was a
Claude-Code-specific runaway hook-triggered re-indexing loop, caught only after the fact by a
hand-installed, hand-maintained `launchd` watchdog (`ops/cc-recall-watchdog`) bolted onto cc-recall
after the incident. That watchdog now has ~5 days of clean, zero-alert operation confirming its
spawn-rate-ceiling + sidecar-growth circuit breakers work — but it's single-provider, single-repo,
and manually installed per machine. `2026-08-15-runclaudeheadless-isolation.md` hit the identical
friction pattern a second time installing/reinstalling watchdogs, and separately noted cc-recall's
own headless-spawn self-recognition guardrail is exactly the kind of pattern a generalized,
distributable tool should catch build-time (lint) as well as runtime (detection) — for any repo,
not just this one, and (eventually) for Codex sessions as well as Claude Code sessions. This spec
is that generalization, written up as an architecture document per `cc-recall-nfb`'s acceptance
criteria: a complete spec, no implementation.

Two prior sessions already did real design work toward this without a dedicated spec file to hold
it: the original Phase 6 scope in the Incident B spec, and the "Phase 6 Impact & Design Guidance"
amendment in the RunClaudeHeadless spec (`cc-recall-68h`). This document supersedes both as the
single source of truth for Phase 6 and folds `cc-recall-68h`'s amendment in as instructed by that
ticket's notes.

## Scope: one plugin, two modes

**Build-time (lint).** A fast, deterministic pattern check — not an LLM in the loop — wired into
pre-commit, failing the commit on a detected unsafe headless-spawn pattern (e.g. a bare
`claude -p` / `codex exec` subprocess call missing isolation flags). Findings are handed off for
interpretation via paste-into-session or a slash command, which either fixes the finding or marks
a noqa-equivalent suppression for confirmed false positives. Rollout: retrofit existing repos,
wire into Husky pre-commit (a checked-in `.husky/pre-commit` command, matching this ecosystem's
existing convention for hooks `pnpm install` would otherwise wipe — see `AGENTS.md`'s Beads
section for the same pattern applied to `bd hooks run`), bake into `spinup-ts` so new projects get
it by default.

**Runtime (detection).** The original Phase 6 scope, unchanged: generalize the convergence-invariant
check and spawn-rate ceiling from Incident B's Phase 3 (`src/metrics/spawn-ceiling.ts` and the
in-repo watchdog) into provider-agnostic primitives, citing Incident B directly as the proof case.

Both modes share one underlying "what does an unsafe headless spawn look like" pattern-recognition
core, for one reason: arbitrary shell/Python/TS across arbitrary repos isn't reliably regex-able,
so a candidate finding — in either mode — gets confirmed by an LLM before either blocking CI or
escalating a runtime alert. Duplicating that interpretation step per mode would mean fixing false
positives twice.

## Data sources per provider

**Claude Code (existing, working).** Per-session JSONL transcripts under `~/.claude/projects/`,
already parsed by cc-recall's own indexer and by `ops/cc-recall-watchdog`'s light tick (sidecar
`index.db` size delta + `enrichment_spawn` event count in a rolling window). This is the reference
implementation for the runtime-detection primitive.

**Codex CLI — confirmed via official docs (`agent-skills:working-with-codex`), verified this
session rather than trusted from training data:**
- Codex has a real lifecycle-hooks mechanism, structurally parallel to Claude Code's: a plugin's
  `plugin.json` declares a `"hooks": "./hooks.json"` path (`references-plugin-json-spec.md`), and
  `config.yaml` supports lifecycle-hook admin controls (`allow_managed_hooks_only`,
  `docs-config.md` "Lifecycle hooks" section). The exact event names/payload shape available to a
  Codex plugin hook were **not** resolvable from this skill's cached docs snapshot (no
  `hooks.md` reference file exists in the current fetch) — confirm event names against
  `codex --help` / a live `codex doctor --json` run before implementing, don't assume 1:1 parity
  with Claude Code's `SessionStart`/`SessionEnd`/`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/
  `Stop` set.
- **Unconfirmed, third-party-sourced only:** community blog posts (not official docs) describe a
  TUI-only `/usage` command (`/usage daily|weekly|cumulative`) and a `/status` command for live
  quota snapshots, with no equivalent scriptable/file-based quota telemetry — i.e., no
  Codex-side analog to reading token counts out of a transcript file. The official docs skill's
  local `slash_commands.md` is a stub pointing at an external URL and doesn't confirm or deny
  this. **Before implementing, verify directly** (`codex --help`, a live session, or an updated
  fetch of `agent-skills:working-with-codex`) rather than trusting the blog claim as-is.
- Codex does write local session logs — reported as `~/.codex/sessions/*.jsonl` (per-session,
  date-organized, structurally analogous to Claude Code's transcripts) plus diagnostic logs at
  `$CODEX_HOME/log/codex-tui.log` or a `logs_2.sqlite` under the Codex state dir, discoverable via
  `codex doctor --json`. Same caveat as above: sourced from a third-party deep-dive post, not the
  official doc set — treat the exact path as a starting point to verify, not a given.
- **Known risk class, confirmed via multiple upstream GitHub issues** (real, checkable, cited so
  Phase 6 isn't motivated by a hypothetical): interrupted Codex sessions leaving orphaned child
  processes (`openai/codex#7985`), MCP server processes surviving session close
  (`Yeachan-Heo/oh-my-codex#900`), missing job control for long-running background commands
  (`openai/codex#7932`), and idle high-CPU from background subprocess churn
  (`openai/codex#15620`). These are Codex's version of Incident B's failure class — an actual
  Codex-side runaway/leak problem exists to detect, which is the strongest argument for building
  this cross-provider rather than assuming Claude Code was a one-off.

**Implication for the spec:** the runtime-detection mode's Codex adapter cannot assume Claude
Code's data richness (in particular, no confirmed local machine-readable quota/token-usage
source). Design it to work off session-log presence/growth-rate and process-count signals first
(directly analogous to what `ops/cc-recall-watchdog` already does), and treat any token/quota-level
telemetry as a stretch enhancement gated on confirming the `/usage` API surface, not a
day-one requirement.

## Alerting

Reuse `ops/watchdog`'s circuit-breaker + OpenClaw/Telegram escalation wholesale — do not design a
new one. Same threshold-file shape as `~/.cc-recall-watchdog/state.json`
(`cb_spawn_rate`, `cb_sidecar_growth`), same `CIRCUIT_BREAKER_FAILS` consecutive-elevated-tick
escalation model.

## Distribution

Claude Code + Codex plugin via `agent-skills:multi-provider-plugins` conventions, published
through the existing `agent-marketplace`. One plugin, provider-detected at install/runtime rather
than two separate packages, consistent with how `multi-provider-plugins` already structures
provider adapters for other tools in this ecosystem.

## Candidate mechanism: no manual `launchd` install

Evaluate **first**, before any daemon-based design, riding each provider's own plugin hook
lifecycle (a cooldown-gated `SessionStart`/`Stop` check) instead of a separate always-on process.
Plugin-installed hooks register automatically on plugin install — no `launchctl bootstrap`/plist
management, no `codex` equivalent process-management step, at all. This directly solves the exact
friction hit twice already (Incident B's watchdog, then RunClaudeHeadless's watchdog) installing
and maintaining two separate hand-managed daemons per machine. If a cooldown-gated hook tick proves
too coarse-grained (5-minute `launchd` StartInterval vs. session-boundary-only firing), fall back
to the current daemon model as a documented non-default option, not the primary design.

Phase 6 is also the natural long-term home for the general "is the deployed plugin cache actually
current" check — the thing Phase C's watchdog removal (`cc-recall-1o9`) leaves without an automatic
replacement until this exists. The interim answer is cc-recall's own local deployment
self-verification check (`doctor`'s 5th check, `cc-recall-4ej`'s manifest wiring); this plugin is
where that check becomes reusable across repos (`cc-recall-1k6`).

## Non-Goals

- Implementation of any kind — this ticket is the spec only.
- Retrofitting the isolation pattern or self-verification check into any plugin other than
  cc-recall as part of *this* spec (tracked separately as `cc-recall-1k6`).
- Redesigning `ops/cc-recall-watchdog` itself — it stays as-is until this plugin is implemented
  and proven, then Phase C (`cc-recall-1o9`) decommissions it.
- Resolving the unconfirmed Codex `/usage` API / hooks event-name questions above — those are
  flagged as pre-implementation verification steps, not answered here.

## Work breakdown

This spec produces no new beads issues on its own — `cc-recall-nfb` (this spec) closes on landing
this document; `cc-recall-68h` (fold Phase 6 Impact guidance in) closes as satisfied by this
document superseding both source sections. Actual implementation planning (a `writing-plans` pass)
happens whenever Phase 6 is picked up for real, per the parent epic's note that Phase 6 has no
blocking dependency and can run independently of Phases 1-5.

## Verification

N/A for this ticket — no code, no tests. The spec itself is verified by: this document existing at
`docs/superpowers/specs/`, `cc-recall-nfb`'s bead notes pointing here, and `cc-recall-68h`'s
Phase-6-Impact content being fully represented above rather than only in the RunClaudeHeadless
spec.
