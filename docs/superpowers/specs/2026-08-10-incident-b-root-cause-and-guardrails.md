# cc-recall — Incident B root-cause, postmortem, guardrails, re-enable

**Date:** 2026-08-10
**Status:** Approved for execution
**Repo:** `github.com/joeblackwaslike/cc-recall` (local: `~/github/joeblackwaslike/cc-recall`)
**Beads epic:** see §Work breakdown

---

## Context

cc-recall is currently **disabled** (`cc-recall@agent-marketplace: false` in
`~/.claude/settings.json`) behind a P0 banner in `README.md` (commit `70c2ca0`), pending a fix
for a runaway re-indexing bug that burns API quota. The public article draft
(`agent-marketplace/private-content/drafts/articles/2026-08-08-writing-the-plot.md`) already
names cc-recall's quota-burn incident publicly — readers will look for it, so the repo needs a
real, published postmortem and a visibly resolved state, not just a banner.

Investigation surfaced that **this is two incidents, not one**, and the existing paper trail is
incomplete and partially inconsistent:

1. **Incident A — backfill self-indexing (diagnosed, fixed, merged).** `/recall:backfill` spawned
   headless `claude -p` enrichment sessions that inherited the interactive model, inherited the
   full settings prefix, and wrote transcripts back into the corpus they were consuming —
   unbounded self-consumption. Root-caused and fixed 2026-07-31 (`c0713ca` #54, `f0190fd` #55).
   Documented in a **draft** postmortem: `postmortems/postmortems/001-cc-recall-quota-burn.md`
   (PM-001), sourced from a prior planning spec at
   `postmortems/docs/specs/001-toolchain-integrity.md`.
2. **Incident B — hook-triggered runaway (undocumented, unfixed, currently blocking).** Six days
   *after* Incident A's fix merged, with no further code changes on `main` in between, the same
   symptom recurred via a different path: "`SessionEnd`/`UserPromptSubmit` hooks... spawning
   duplicate indexing sub-agent sessions repeatedly (seconds apart)" (`README.md` banner,
   2026-08-06). **No beads issue, no postmortem, no root-cause investigation exists for this
   anywhere in the repo, the postmortems repo, or `.beads/`.** This is what's actually keeping
   the plugin disabled today, and the subject of this spec's Phase 1.

Two numeric accounts of Incident A disagree: PM-001 (measured mid-incident, Jul 30) reports 2,825
sessions / ~69% of quota over ~43h; the public article draft, written after the fact, uses
"8,528 of its own sessions" / "54%" over two calendar days. These plausibly measure overlapping
but non-identical things (PM-001 is derived from token/cost accounting; 8,528 looks like a raw
on-disk session-file count, which would also catch artifacts PM-001's method didn't — e.g. the
480 recursively-nested `-Users-joe--claude-projects--Users-joe...` project directories found on
disk). They need reconciliation with one clearly-labeled authoritative number, not a silent pick.

A third, unrelated bug the article also describes — a "background memory extractor" re-running 26
times against one transcript and 27 times against another, always failing because "Pieces MCP
server is not connected" — is **not cc-recall**. Its prompt signature ("You are a background
memory extractor...") doesn't match cc-recall's indexer prompt ("You are indexing a Claude Code
session transcript..."), and matches the global `~/.claude/hooks/pieces-memory-stop.sh` Stop hook
instead. Noted here so it isn't folded into cc-recall's RCA by mistake.

## Goals, in order

1. Root-cause and fix Incident B for real — confirm the mechanism, don't just document around it.
2. Finalize and publish the postmortem(s) in the private `postmortems` repo, reconciled numbers.
3. Ship structural guardrails so this class of bug is hard to repeat.
4. Produce a **design-only** spec (no implementation) for a generalized, cross-provider
   (Claude Code + Codex) quota-monitoring/early-detection plugin.
5. Get cc-recall back to a shippable, re-enabled state.

## Existing assets to reuse, not rebuild

- **`ops/watchdog/`** (this repo) — a proven launchd watchdog pattern for exactly this class of
  problem (claude-mem's 2026-06-14 20GB-bloat incident): light/audit tick scripts, a circuit
  breaker (`bin/lib.sh`), `etc/*.conf` thresholds, an `incidents.jsonl` audit log, and a
  detect-and-propose/escalate-vs-auto-fix boundary with a parked Telegram approval bridge via
  OpenClaw (`cc-recall-mfr`). Template for both the in-repo guardrail watchdog (Phase 3) and the
  bonus cross-provider monitor's alerting design (Phase 6).
- **`src/indexer-isolation.test.ts`** — the existing convergence-invariant regression test from
  Incident A's fix. Extend it for the hook-triggered path; don't write a parallel one.
- **Beads issues already scoped for related hardening**, all filed 2026-07-31, all still open:
  `cc-recall-bub` / `cc-recall-kg8` (P0), `cc-recall-4ax` (P1, circuit breaker — fixed on
  unmerged branch `aa772a7`), `cc-recall-4mt`, `cc-recall-7xx`, `cc-recall-sey`, `cc-recall-vfn`,
  `cc-recall-crc`, `cc-recall-di4`. Six of these already have fixes on `fix/retention-and-rotation`
  and `fix/transcript-write-safety` — **unmerged**. Land those instead of re-deriving the work.
- **`postmortems` repo conventions** — PM-001's frontmatter schema (`type`, `id`, `date`, `status`,
  `severity`, `cost`, `systems`, `symptoms`, `resolution`, `tags`) and the split-by-audience model
  from `docs/specs/001-toolchain-integrity.md` Phase 3: private narrative → `postmortems` repo,
  generalizable failure mode → a public skill's `references/known-failures.md`, enforceable rule
  → `lessons-learned` DB.

## Phase 1 — Root-cause Incident B (the live blocker)

Has to happen first and for real — Incident B's postmortem can't be written until this is
confirmed.

**Leading hypothesis, evidence-backed but not yet confirmed:** a headless `claude -p` enrichment
session (`runClaudeHeadless` in `src/record/synthesizer.ts`) is itself a full Claude Code session
subject to the *same installed plugin hooks* as any interactive session — `cwd` is pinned to
`INDEXER_CWD`, but `--setting-sources` is not overridden (overriding it breaks auth, verified in
PM-001), so it still loads global settings including cc-recall's own `SessionEnd` hook. When that
inner session ends, its own `SessionEnd` fires `cc-recall index` against its own transcript —
which `isIndexerTranscript` *should* catch and skip cheaply, but each occurrence is still a real
subprocess spawn "seconds apart," matching the banner. Supporting evidence: `~/.claude/plugins/cache/`
contains **206 `temp_github_*` throwaway checkouts** of this repo (marketplace install/update
mechanism), dated continuously 2026-07-31 through 2026-08-06 — consistent with abnormally high
session-start volume during that window.

**Steps** (`superpowers:systematic-debugging`):

1. Confirm whether the installed plugin cache (`~/.claude/plugins/cache/agent-marketplace/cc-recall`)
   ran post-`c0713ca` `dist/` during 2026-08-01–06, or whether `ensure-built.sh`'s "only build if
   `dist/bin/cc-recall.js` is missing" logic meant a stale pre-fix build kept running
   (`cc-recall-vfn`: build failures are swallowed with `|| true`).
2. Reproduce the nested-hook-firing mechanism directly: run a headless `claude -p` with the
   plugin installed, confirm/deny whether its own `SessionEnd` fires and what it spawns, with
   `CC_RECALL_LLM` on and off.
3. Check whether `hooks/session-end.mjs`'s background spawn has any concurrency guard (it
   currently has none). If plugin-cache duplication causes the *same* `SessionEnd` event to fire
   the hook command more than once, nothing today collapses duplicate concurrent
   `cc-recall index <same-transcript>` invocations into one.
4. Fix at the layer the bug actually lives in — likely one or both of:
   - An idempotency lock keyed by transcript path (+ content hash) in `indexSession`/CLI entry.
   - `CC_RECALL_LLM=0` (or equivalent) forced for any `claude -p` subprocess cc-recall itself
     spawns, so a nested indexer session can never trigger another LLM call.
   - If stale-plugin-cache is confirmed instead/also: fix `cc-recall-vfn` for real and clean the
     206 `temp_github_*` accumulation; consider a corroborating upstream report on the
     marketplace temp-checkout accumulation itself.
5. A regression test that is red on pre-fix code and green after — don't declare fixed on a test
   that was never red.

## Phase 2 — Land the hardening that already exists but never merged

`fix/retention-and-rotation` and `fix/transcript-write-safety` collectively close `cc-recall-bub`
(remaining unhandled-rejection net), `cc-recall-4ax` (circuit breaker/backoff), `cc-recall-4mt`
(enrichment-degradation visibility), `cc-recall-sey` (log rotation + sidecar VACUUM),
`cc-recall-vfn` (build-failure surfacing), `cc-recall-crc`, `cc-recall-di4`. Review each branch's
diff against its ticket's acceptance criteria, rebase onto current `main`, merge via normal PR
review. `cc-recall-kg8` (live-session read-modify-rename race) has no implementation on any
branch yet — needs actual work per the proposed fix shape already on file (skip transcripts with
recent mtime or matching `CLAUDE_SESSION_ID`).

## Phase 3 — Guardrails: make this class of bug structurally hard to repeat

A **hard ceiling enforced before spawning**, not just better cleanup after, in
`src/record/synthesizer.ts` / `src/engine.ts`:

- Session-spawn-rate ceiling (max N `claude -p` enrichment calls per rolling hour), tracked in
  `~/.claude/cc-recall/metrics/` (extend the existing `adoption.jsonl` convention from
  `hooks/prompt-submit.mjs`, don't invent a second format). Exceeding it pauses enrichment,
  falls back to heuristic-only, logs an incident, does not auto-retry.
- Extend `indexer-isolation.test.ts`'s convergence invariant to cover the hook-triggered path
  confirmed in Phase 1, not just backfill.
- A lightweight local watchdog for cc-recall built on `ops/watchdog/bin/lib.sh`'s
  circuit-breaker/notify primitives — a light tick checking session-spawn rate and sidecar growth
  rate, escalating like claude-mem's watchdog.

## Phase 4 — Postmortem documents (private `postmortems` repo)

- Finalize PM-001 (`postmortems/postmortems/001-cc-recall-quota-burn.md`): `status: draft` →
  `final`, add the 2,825/69% vs. 8,528/54% reconciliation note.
- Write PM-003 for Incident B (PM-002 is Serena, already in the repo): full RCA per Phase 1's
  confirmed root cause, impact, detection gap, resolution, lessons — PM-001's frontmatter schema.
- Emit the generalizable failure mode to a public skill's `references/known-failures.md` (a
  headless `claude -p` subprocess still loads the caller's global hooks; a plugin that spawns one
  must guard against its own hooks re-triggering it).
- File the enforceable lessons in `lessons-learned` (verify `ll-mz3` covers deliberate model
  selection + convergence testing; add one for Incident B's confirmed root cause).

## Phase 5 — Ship it

1. Remove the `README.md` P0 banner once Phase 1's fix is verified, not before.
2. Cut a release covering everything merged in Phases 1–3 (the existing `0.2.0` tag on
   `release-please--branches--main--components--cc-recall` only covers Incident A and predates
   the banner — supersede it).
3. Re-enable the plugin (`cc-recall@agent-marketplace: true`) and watch a real usage window
   (session-spawn rate, `session-end.log`, sidecar growth) before calling this closed.
4. Link the published postmortem(s) from the article draft (coordinate separately; this spec
   doesn't edit the article).

## Phase 6 (bonus, design-only) — Cross-provider quota-monitoring plugin spec

A written architecture spec, not an implementation:

- Data sources per provider: Claude Code (local transcript/session counting, generalized beyond
  cc-recall's own spawns) and Codex (needs research into what it exposes locally).
- Detection heuristics: generalize the convergence-invariant check and spawn-rate ceiling from
  Phase 3 into provider-agnostic primitives; cite this incident directly as the proof case.
- Alerting: reuse `ops/watchdog`'s circuit-breaker + OpenClaw/Telegram escalation wholesale.
- Distribution: Claude Code + Codex plugin via `agent-skills:multi-provider-plugins` conventions,
  through the existing `agent-marketplace`.
- Explicitly out of scope: writing code for it.

## Verification

- Phase 1: regression test red on pre-fix code (confirm by stashing the fix), green after. A
  bounded real session triggers `SessionEnd` and produces exactly one indexing attempt, verified
  via `session-end.log`.
- Phase 2: `pnpm test` green after each branch merge; each merged branch re-checked against its
  beads ticket's acceptance criteria before closing.
- Phase 3: extended convergence test covers the hook path and fails without Phase 1's fix.
  Manually exceed the spawn-rate ceiling in a test harness and confirm it pauses to heuristic.
- Phase 4: PM-001 and PM-003 render correctly (frontmatter matches PM-001's schema); `bd search`
  / `bd list` shows the new lessons/issues filed.
- Phase 5: with the plugin re-enabled, `~/.claude/cc-recall/logs/session-end.log` and sidecar
  session count stay proportional to actual usage over a real multi-hour window.

## Work breakdown

See beads: epic `cc-recall-postmortem-epic` (title: "EPIC: Incident B root-cause, postmortem,
guardrails, re-enable"), with one issue per phase above, dependencies sequenced Phase 1 → 2 → 3,
Phase 4 depends on Phase 1 only, Phase 5 depends on 1–4, Phase 6 has no dependency.
