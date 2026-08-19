# Cross-Provider Quota-Monitoring Plugin — Design Spec (Phase 6)

**Status:** design-only (bd `cc-recall-nfb`, Phase 6 of the Incident B epic `cc-recall-ju2`).
**Provenance:** the core of this document (Motivation, Scope, Architecture, Primitives, Data
sources, Alerting, Self-verification, Verification, Work breakdown) was originally drafted
2026-08-12 and refined 2026-08-14 (PM-001 recurrence) on an unmerged branch
(`feat/phase6-quota-monitor-spec`) that sat in a stale worktree, undiscovered until 2026-08-18
while closing out this exact ticket from scratch a second time. **This document supersedes both
that branch's spec and a second, thinner spec briefly landed on `main` the same day** — the
second draft duplicated this work without knowing it already existed, in more depth, unmerged.
It's landed here now, merged with the one genuinely new piece the second draft added (the
build-time/runtime two-mode amendment from `cc-recall-68h`, and Codex hooks verified against
official docs rather than blog posts) rather than re-deriving from scratch a third time.

**Scope of this ticket:** a written architecture spec only. No implementation code ships as part
of `cc-recall-nfb`; the work breakdown below becomes follow-on tickets once this spec is approved.

## Motivation

Incident B was a hook-triggered runaway re-indexing loop that stayed live for six weeks because
the fix that closed it shipped to `main` but never reached the *running* plugin cache — the
in-process spawn-rate ceiling that should have caught it wasn't actually in effect. cc-recall's
own guardrails (Phase 3: `src/metrics/spawn-ceiling.ts`'s rolling-window admission gate, plus
`ops/cc-recall-watchdog`'s independent on-disk observer) now catch this failure mode for
cc-recall's own enrichment spawns specifically — confirmed working live as of 2026-08-18: 5+ days
of continuous 5-minute ticks, zero circuit-breaker trips. Nothing catches it — or the related
pattern of a single session quietly burning an abnormal number of tokens or wall-clock time — for
Claude Code or Codex usage in general. This spec generalizes those primitives into a standalone,
provider-agnostic monitor.

**Additional motivation (2026-08-14, PM-001 recurrence, bd `cc-recall-hie`):** since this spec was
first written, Phase 3's own detection logic was found to have the same "looks done, isn't"
shape twice over, in the system this spec is generalizing *from*. First,
`isIndexerTranscript()` — the self-recognition check that identifies cc-recall's own enrichment
runs — had a passing test suite for weeks while being completely inert in every production run,
because its test fixture never reproduced a real structural property of the data it runs against
(Claude Code tags a headless `claude -p` invocation's own prompt `promptSource: 'sdk'`; the
guard read from a field that filters exactly that out, and the fixture that "proved" the guard
worked never set it). Second, `ops/cc-recall-watchdog` itself — the independent observer built in
Phase 3 specifically to catch this class of thing — was found never actually installed as a
launchd job, for the entire time it existed in the repo. Both gaps are directly relevant here:
this spec's own provider adapters will contain the same kind of self-recognition logic
(recognizing a provider's own probe/self-invocation so it doesn't count against itself), and its
own watchdog will have the same "installed vs. actually running" distinction. See "Guard-fixture
realism" and "Self-verification" below.

## Scope

Detects two failure shapes, both motivated directly by Incident B and its detection gap:

1. **Spawn-rate / session-count anomalies** — the Incident B pattern itself: sessions spawning
   sessions faster than expected in a rolling window.
2. **Token-burn / long-running-session anomalies** — a single session or subprocess consuming an
   abnormal number of tokens or an abnormal amount of wall-clock time without necessarily
   spawning any additional sessions. A different failure shape than Incident B, but the same
   detection gap: nothing currently watches for it across either provider.

Built as a personal safety net first (tuned to this machine's usage), but designed as a real
plugin — not a one-off script — so it doesn't need a redesign to share later.

### Amendment: build-time lint mode (from `cc-recall-68h`, 2026-08-15 RunClaudeHeadless spec)

**One plugin, two modes**, not just the runtime detector above:

- **Build-time (lint).** A fast, deterministic pattern check — not an LLM in the loop — wired
  into pre-commit, failing the commit on a detected unsafe headless-spawn pattern (e.g. a bare
  `claude -p` / `codex exec` subprocess call missing isolation flags). Findings are handed off for
  interpretation via paste-into-session or a slash command, which either fixes the finding or
  marks a noqa-equivalent suppression for confirmed false positives. Rollout: retrofit existing
  repos, wire into Husky pre-commit (a checked-in `.husky/pre-commit` command, matching this
  ecosystem's existing convention for hooks `pnpm install` would otherwise wipe), bake into
  `spinup-ts` so new projects get it by default.
- **Runtime (detection).** The two primitives below, unchanged.
- Both modes share one underlying "what does an unsafe headless spawn look like"
  pattern-recognition core: arbitrary shell/Python/TS across arbitrary repos isn't reliably
  regex-able, so a candidate finding — in either mode — gets confirmed by an LLM before either
  blocking CI or escalating a runtime alert. Duplicating that interpretation step per mode would
  mean fixing false positives twice.

### Non-goals

- **No auto-fix.** Unlike `claude-mem-watchdog` (which safely restarts a dead worker, reaps
  orphan processes, repairs a config path), there is no generically safe auto-remediation for "a
  provider's spawn rate or token burn looks wrong." Every escalation is notify-only, exactly
  matching `ops/cc-recall-watchdog`'s existing reasoning — a human looks at *why*.
- **No per-provider hook instrumentation for the runtime detector.** It reads each provider's own
  on-disk session logs passively. Requiring either provider to emit spawn events in-process would
  make the monitor bypassable the same way Incident B's own fix was bypassed — the entire point
  is independence from whether the provider's in-process code is doing the right thing. (The
  build-time lint mode above is a separate, intentionally different mechanism — pre-commit, not
  passive observation — and is not in tension with this.)
- **No new alerting design.** Reuses `ops/watchdog`'s circuit-breaker (`cb_bump`/`cb_reset`) and
  notify/escalate primitives (`notify`, `request_create`) wholesale.
- **No literal quota/rate-limit API polling** unless a provider turns out to expose it locally
  (see Data sources, Codex) — detection is behavioral (spawn-rate, token/duration ceilings), not
  a wrapper around each provider's own quota dashboard.

## Architecture

An external, independent watchdog — `ops/quota-watchdog/`, a new sibling to `ops/watchdog/`
(claude-mem) and `ops/cc-recall-watchdog/` (cc-recall's own). Independence matters for the same
reason it matters for the existing two: it has to keep working even if a provider's own
detection code is stale, missing, or silently never reached the running install, which is
exactly how Incident B stayed live.

- **Outer loop — bash, unchanged pattern.** `lib.sh` ported (not shared — matching the existing
  precedent that the two current watchdogs keep independent copies rather than a cross-directory
  `source`), same launchd cadence, same circuit-breaker bookkeeping and escalation calls.
- **Detection core — a small TS CLI.** Each tick shells out to `quota-monitor probe
  --provider=<claude-code|codex> --check=<spawn-rate|token-burn>`, which does the actual
  log-parsing and prints back `{count, ceiling, windowMs, elevated}` JSON for the bash tick to
  feed into `cb_bump`/`cb_reset`. This directly reuses the shape of `admitEnrichmentSpawn` /
  `SpawnGateResult` (`src/metrics/spawn-ceiling.ts:41-107`) — same rolling-window math, same
  fail-closed semantics on a read error — but read-only: this CLI can only *report* an elevated
  reading, not admit or deny a spawn the way cc-recall's own gate does for itself.

Parsing structured per-provider log formats correctly is exactly cc-recall's existing job (it
already does this for its own transcripts), not a new one — doing it in TS rather than `jq`
avoids duplicating fragile log-parsing logic per provider in bash, which is where a pure-bash
approach (considered and rejected) would have gotten unwieldy.

**Candidate mechanism to evaluate first, before committing to the launchd design above:** ride
each provider's own plugin hook lifecycle (a cooldown-gated `SessionStart`/`Stop` check) instead
of a separate always-on `launchd` process. Plugin-installed hooks register automatically on
plugin install — no `launchctl bootstrap`/plist management at all. This directly targets the
friction hit twice already installing/reinstalling hand-managed watchdogs (Incident B's, then
this same class again for RunClaudeHeadless). **Verified this session (2026-08-18) via
`agent-skills:working-with-codex`'s official docs, not third-party sources:** Codex does have a
real lifecycle-hooks mechanism structurally parallel to Claude Code's — `plugin.json` supports a
`"hooks": "./hooks.json"` path (`references-plugin-json-spec.md`), and `config.yaml` has
admin-level lifecycle-hook controls (`docs-config.md`, "Lifecycle hooks" section) — so a
hook-based no-daemon design is plausible for both providers, not just Claude Code. The exact
event names/payload shape available to a Codex plugin hook were **not** resolvable from the
cached docs snapshot used this session (no `hooks.md` reference file present in that fetch) —
confirm against `codex --help` / a live `codex doctor --json` run during 6a below, don't assume
1:1 parity with Claude Code's `SessionStart`/`SessionEnd`/`PreToolUse`/`PostToolUse`/
`UserPromptSubmit`/`Stop` set. If a cooldown-gated hook tick proves too coarse-grained relative to
the bash/launchd design's tick cadence, fall back to the launchd model as a documented
non-default option, not the primary design.

## Primitives

Both primitives share one shape in the TS core — `{ceiling, windowMs, elevated}` — for
consistency and so the bash tick's circuit-breaker wiring doesn't need to special-case which
check produced the reading.

### 1. Rolling-window spawn-rate

Generalizes `admitEnrichmentSpawn`'s rolling-window count-against-ceiling logic
(`src/metrics/spawn-ceiling.ts`), minus the admit/deny decision — a passive provider can only
observe and report, not gate. Fails closed: a read error is reported as "unknown," never
silently interpreted as "healthy," matching the existing primitive's reasoning (a corrupted
mount or permissions failure must not present as a clean rate).

### 2. Token-burn / long-running-session ceiling

New primitive — no existing cc-recall precedent to generalize from, since Phase 3 only ever
covered spawn-rate. Per-session cumulative token usage and wall-clock duration, each checked
against a configurable ceiling. Scoped to *recently-active* sessions only (transcript mtime
inside the trailing detection window), never a full historical-corpus scan — see Data sources
below for why this bound matters.

### Convergence invariant: reinterpreted as a test template, not a runtime check

The parent spec's stub asks to "generalize the convergence-invariant check... into
provider-agnostic primitives." Having read `indexer-isolation.test.ts`, that check is a
build-time regression test asserting cc-recall's own indexer excludes its own output from the
corpus it's consuming — it is not something a watchdog can observe live in an arbitrary
provider's session logs, because most providers' local logs don't expose the parent/child
causality needed to detect "this session was triggered by consuming another session's own
artifact" generically.

The honest generalization: rolling-window spawn-rate (primitive 1) is the only *live* detection
mechanism the convergence bug class reduces to from the outside. The convergence invariant
itself generalizes as a **reusable test template** — a regression-test pattern each future
provider adapter should carry, proving its own detection/read code doesn't self-trigger (e.g.
the CC adapter's own log reads must never appear as a session in its own count), the same
discipline `indexer-isolation.test.ts` already enforces for cc-recall's indexer.

### Guard-fixture realism — a hard requirement, not a nice-to-have (PM-001 recurrence)

Every adapter here needs its own version of `isIndexerTranscript()`: a check that recognizes
"this is my own probe/self-invocation, don't count it against the provider being monitored."
PM-001's recurrence (2026-08-14) is the direct precedent for how this fails silently: the
equivalent cc-recall check had a passing unit test for weeks while being completely inert in
production, because the test's fixture was hand-written to "look like" a real transcript rather
than derived from one, and it happened to omit the one field (`promptSource: 'sdk'`) that
determined whether the real check fired at all. No error, no failing test, no CI signal —
just a guard that never actually triggered on real input.

**Requirement:** each provider adapter's self-recognition test fixture must be built from an
*actual captured sample* of that provider's real self-invocation output — not a hand-written
approximation. Concretely: before writing the CC adapter's (6b) or Codex adapter's (6c)
self-recognition test, capture one real on-disk sample of what that provider's own probe
invocation actually produces (its full raw JSON record, every field Claude Code or Codex itself
adds — not just the fields the developer assumes matter), and build the fixture from that
sample verbatim. A fixture that "looks right" by inspection is exactly what let this recur once
already in the system this spec generalizes from.

## Data sources

| Provider | Confirmed available | Unresearched |
|---|---|---|
| Claude Code | Session-start timestamps via transcript mtimes under `~/.claude/projects/**`. Per-message token usage inside each transcript's `.jsonl` (summable per session for primitive 2). Lifecycle hooks (`SessionStart`/`SessionEnd`/`PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`Stop`) confirmed via `agent-skills:working-with-codex`'s CC-equivalent conventions and this repo's own `hooks/` usage. | — |
| Codex | Session-start timestamps via `~/.codex/session_index.jsonl` (`{id, thread_name, updated_at}` per line, confirmed by direct read on this machine, 2026-08-12). A real lifecycle-hooks mechanism exists (`plugin.json`'s `"hooks"` field, `config.yaml`'s lifecycle-hook admin controls) — confirmed against official docs 2026-08-18, exact event-name parity with Claude Code's set unconfirmed. | Token usage per session; any local rate-limit/quota exposure. `session_index.jsonl`, `config.toml`, and `codex --help` showed nothing at the surface checked (2026-08-12); `logs_2.sqlite` (24MB, unexplored) may hold richer per-turn data. Third-party (non-official) sources describe a TUI-only `/usage`/`/status` command with no scriptable equivalent — treat as a lead to verify during 6a, not a given. This user's local `~/.codex` also looks like a customized harness install (`agent-harness`-symlinked `AGENTS.md`, extra `goals`/`memories`/`visualizations` state) rather than a stock install, which the research spike (6a) needs to account for — don't assume stock-CLI file layout without checking. Codex's exact lifecycle-hook event names/payload shape (see Architecture above). |

**CC-side scale note:** cc-recall's own `admitEnrichmentSpawn` only ever counts cc-recall's own
enrichment spawns via a small `adoption.jsonl` — a few events. Phase 6 has to observe *all*
Claude Code sessions on the machine, and `~/.claude/projects/**` holds 10k+ transcript files.
Primitive 1 (spawn-rate) can stay cheap by reading directory mtimes only, never opening
transcript content. Primitive 2 (token-burn) is unavoidably heavier since token counts live
inside transcript content — bounded by restricting reads to transcripts whose mtime falls inside
the trailing detection window (recently-active sessions), never the full historical corpus.

**Known risk class, confirmed via multiple upstream GitHub issues** (cited so Phase 6 isn't
motivated by a hypothetical for the Codex side): interrupted Codex sessions leaving orphaned
child processes (`openai/codex#7985`), MCP server processes surviving session close
(`Yeachan-Heo/oh-my-codex#900`), missing job control for long-running background commands
(`openai/codex#7932`), and idle high-CPU from background subprocess churn
(`openai/codex#15620`).

## Alerting

Unchanged from `ops/watchdog`'s existing design, reused wholesale: `cb_bump`/`cb_reset` circuit
breaker, `request_create` for a notify-only escalation, `notify` for the OpenClaw/Telegram path.
No new escalation payload shape beyond what an elevated `{count, ceiling, windowMs}` reading
already provides to the existing `request_create` call sites' JSON-extras pattern.

## Distribution

Packaged per `agent-skills:multi-provider-plugins` conventions as a Claude Code plugin and a
Codex plugin, both through the existing `agent-marketplace`. Each plugin ships: the
`quota-monitor` probe CLI, the build-time lint mode, and an install script wiring the shared bash
watchdog into launchd (mirroring `ops/cc-recall-watchdog/install.sh`) — or the hook-based
no-daemon mechanism above, if 6a/6d confirm it's viable.

**Repo & packaging note:** per the standing convention for AI/agent-specific tooling
(AI/agent-specific projects → `agent-marketplace/nursery`), this likely doesn't stay inside
cc-recall's own tree long-term — it's a standalone distributable plugin, not a cc-recall feature.
Final placement (develop in-repo under `ops/quota-watchdog/` first vs. start directly in
`agent-marketplace/nursery`) is an implementation-plan decision, not a spec-level one.

Phase 6 is also the natural long-term home for the general "is the deployed plugin cache actually
current" check — the thing Phase C's watchdog removal (`cc-recall-1o9`) leaves without an
automatic replacement until this exists. The interim answer is cc-recall's own local deployment
self-verification check (`doctor`'s 5th check, `cc-recall-4ej`'s manifest wiring); this plugin is
where that check becomes reusable across repos (`cc-recall-1k6`).

## Self-verification (PM-003 + `cc-recall-hie`)

`ops/cc-recall-watchdog` — built in Phase 3 specifically to independently catch a silently
non-functional in-process guard — was itself found never installed as a launchd job for as long
as it existed. A watchdog present in the repo is not the same claim as a watchdog running on the
machine; this spec's own monitor is not exempt from that distinction just because catching it
*for other systems* is its whole purpose.

**Requirement:** the install path (6e) does not end at `install.sh` exiting 0. It must leave a
way to positively confirm the job is actually ticking, not just that it was once registered:

- `install.sh` verifies its own postcondition — `launchctl list | grep <label>` actually shows
  the job immediately after bootstrap, not just that the bootstrap command returned success.
- A `quota-monitor doctor` (or equivalent) command checks, on demand: is the launchd job (or hook
  registration, if the no-daemon mechanism above is adopted) registered, and has it ticked
  recently (state file mtime inside the expected cadence)? This is the same shape as `cc-recall
  doctor`'s existing G0/sidecar checks — a cheap, explicit "is this actually alive" query a human
  (or another watchdog) can run, rather than inferring liveness from "I ran install.sh once."
- Distribution docs (6e) state explicitly: re-run `install.sh` (idempotent) after any Claude Code
  or Codex update that might touch launchd agent state, and periodically confirm via
  `quota-monitor doctor` — don't assume an install from months ago is still in effect.

## Non-Goals (packaging/retrofit scope)

- Retrofitting the isolation pattern or self-verification check into any plugin other than
  cc-recall as part of *this* spec (tracked separately as `cc-recall-1k6`).
- Redesigning `ops/cc-recall-watchdog` itself — it stays as-is until this plugin is implemented
  and proven, then Phase C (`cc-recall-1o9`) decommissions it.

## Verification

- Primitive 1 (spawn-rate): a synthetic session-spawn-rate spike test harness per provider proves
  the reading crosses the ceiling and the circuit breaker escalates after the configured
  consecutive-tick count — mirroring how `ops/cc-recall-watchdog`'s own `check_spawn_rate` is
  verified today.
- Primitive 2 (token-burn): a synthetic transcript fixture with inflated token counts / an
  artificially old start timestamp proves the ceiling trips; a fixture with normal usage proves
  it stays quiet.
- Convergence test template: each provider adapter ships a regression test proving its own log
  reads never count as a session of their own — same shape as `indexer-isolation.test.ts`'s
  corpus-exclusion assertion, adapted per provider, **built from a captured real sample per the
  Guard-fixture realism requirement above, not a hand-written fixture.**
- Self-verification: `quota-monitor doctor` (or equivalent) correctly reports "not installed"
  before `install.sh` runs and "installed, ticking" after — proving the liveness check itself
  isn't another guard that looks right but never fires.
- End-to-end: with the watchdog installed, a real multi-hour usage window on both providers stays
  quiet (no false escalation) under normal use — same bar Phase 5 verification already applies to
  `ops/cc-recall-watchdog`.
- Build-time lint mode: a fixture repo with a known-unsafe headless-spawn pattern fails
  pre-commit; a fixture with a properly-isolated spawn passes.

## Work breakdown

Follow-on implementation tickets, one per phase, sequenced 6a → 6b → (6c ∥ 6d) → 6e → 6f:

- **6a — Research spike:** confirm or refute Codex token/rate-limit exposure (`logs_2.sqlite`,
  any `--json`/status output), confirm Codex's exact lifecycle-hook event names/payload shape
  (`codex --help` / `codex doctor --json` / a live session), and confirm whether this user's
  customized `~/.codex` layout differs from a stock install in ways that affect the adapter
  design. Also resolve: is a hook-based no-daemon mechanism viable for both providers, or does
  the launchd design stay primary?
- **6b — TS probe CLI core + CC adapter:** both primitives' shared `{ceiling, windowMs, elevated}`
  logic, the CC adapter (mtime-scoped spawn-rate + window-bounded token-burn read), and the
  convergence test-template applied to it, **its fixture built from a captured real CC probe
  transcript (Guard-fixture realism)**. Built together since they share the adapter/read-path
  plumbing — building them separately would mean touching the same files twice.
- **6c — Codex adapter:** built on 6a's findings; same primitives, same test-template discipline,
  **its fixture built from a captured real Codex probe sample, not a guess at Codex's shape.**
- **6d — Bash watchdog wrapper (or hook-based equivalent, per 6a):** `lib.sh` port into
  `ops/quota-watchdog/`, circuit-breaker wiring, `quota-monitor probe` shell-out, **plus the
  `install.sh` postcondition check and `quota-monitor doctor` liveness command
  (Self-verification).** Can run in parallel with 6c once 6b lands.
- **6e — Build-time lint mode:** the pattern-recognition core shared with 6b/6c's LLM-assisted
  interpretation step, pre-commit wiring (checked-in `.husky/pre-commit`), `spinup-ts` default
  rollout.
- **6f — Packaging:** `agent-skills:multi-provider-plugins`-conventioned plugin manifests for
  both providers, `agent-marketplace` submission, install-script docs **explicitly covering
  re-install-after-update and periodic `quota-monitor doctor` checks (Self-verification).**

Each gets its own beads ticket once this spec is approved, blocked on `cc-recall-nfb` closing
(mirroring the epic's existing per-phase issue pattern).
