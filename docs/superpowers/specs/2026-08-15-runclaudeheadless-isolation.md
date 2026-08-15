# RunClaudeHeadless Isolation & Guardrail Simplification — Design Spec

## Context

Sibling repo `pieces-dev` shipped a fix for PM-005 (a Stop hook spawning ~18,234 ghost
`claude -p` sessions over 59 days, cascading through cc-recall and claude-mem). Its root cause —
a bare `claude -p` subprocess inherits the full session lifecycle (hooks, plugins, CLAUDE.md,
transcript persistence) — is the same failure class cc-recall's own `runClaudeHeadless`
(`src/record/synthesizer.ts`) has been defending against since Incident B, via a dedicated CWD,
prompt-signature self-recognition, and a spawn-rate ceiling. PM-005's fix — CLI isolation flags
that make the subprocess side-effect-free at the source — is structurally simpler than detecting
and excluding the side effects after the fact. This spec adopts it for cc-recall and audits the
existing guardrails for what becomes redundant.

Reference: `agent-skills:working-with-claude-code` →
`references/claude-setting-sources-isolation.md` (the pattern, already documented and verified
working in `pieces-dev`).

## Design Decision: Adopt `--setting-sources "" --no-session-persistence`

`runClaudeHeadless` currently spawns bare `claude -p --model <model>` via `child_process.spawn`,
piping the prompt over stdin, `cwd` pinned to `INDEXER_CWD`. The change: add
`--setting-sources ""` and `--no-session-persistence` to the spawn args. No change to how the
prompt is delivered — verified empirically (below) that stdin piping is unaffected by these flags.

**Bonus finding, discovered verifying this pattern for cc-recall specifically:** the *current*
bare invocation loads the user's full global `CLAUDE.md`/`AGENTS.md` (~20K tokens, including
unrelated personal/instructional content) into every enrichment call. Confirmed by sending an
adversarial test prompt through the current bare call — it returned a prompt-injection refusal
that referenced injected personal context, meaning the full instruction file was loaded. The
same prompt through `--setting-sources ""` returned a generic response with no such awareness.
This is a real, previously-invisible cost and prompt-cleanliness win, independent of the
pollution fix — enrichment is meant to be a narrow summarize-to-JSON task over a ~4k digest, and
has been paying for irrelevant context on every call since inception.

### Verified behavior (this session)

Tested with cc-recall's actual invocation shape (prompt piped via stdin, not passed positionally):

```bash
BEFORE=$(find ~/.claude/projects -maxdepth 2 -iname '*.jsonl' | wc -l)
echo 'Reply with exactly: {"ok":true}' | \
  claude -p --no-session-persistence --setting-sources "" --model claude-haiku-4-5-20251001 \
  > /dev/null 2>&1
AFTER=$(find ~/.claude/projects -maxdepth 2 -iname '*.jsonl' | wc -l)
# before == after: zero new transcript files
```

- `settings.json` mtime unchanged after invocation — zero hook invocations.
- Zero new `.jsonl` files anywhere under `~/.claude/projects/`, rigorously counted before/after.
- CLAUDE.md leak test: bare call leaks global instructions; `--setting-sources ""` does not.
- Model responds correctly to a stdin-piped prompt with these flags (no change in I/O shape).

cc-recall's enrichment call needs no MCP tools (`--strict-mcp-config`/`--mcp-config`/
`--allowedTools` from the pieces-dev pattern are irrelevant here — pure text-in/JSON-out).
`--system-prompt` is also unneeded: cc-recall already builds its full instruction
(`INDEXER_PROMPT_SIGNATURE` + JSON schema) and pipes it entirely via stdin, re-establishing
context explicitly rather than relying on CLAUDE.md auto-discovery.

## Phase A — Ship the isolation flags (no other changes)

Add `--setting-sources ""` and `--no-session-persistence` to the `spawn(...)` call in
`runClaudeHeadless`. Everything else — `INDEXER_CWD`, `isIndexerTranscript`, `isIndexerRun`,
the spawn-rate ceiling, `ops/cc-recall-watchdog` — stays exactly as-is. This is deliberately the
smallest possible change: prove the fix in production before touching anything it might make
redundant.

**Deliverables:**

- Modify `src/record/synthesizer.ts`: `runClaudeHeadless` spawn args.
- Red test first (TDD): assert the current bare call leaks settings/CLAUDE.md content (adapted
  from the empirical technique above — mock or a controlled fixture, not a live network call in
  the test suite); green after the flag change.
- `src/indexer-isolation.test.ts` / `src/indexer-self-recognition.test.ts` stay passing unchanged
  — Phase A is a strict behavioral superset (isolation gets stronger, nothing that currently
  passes stops passing).

## Phase B — Remove now-dead guardrail code (gated on verification)

**Trigger:** a real-usage window (days, not months — this repo's own established bar for "is
this actually fixed," most recently used for `cc-recall-8id`/`cc-recall-hie`) with zero
`indexer_recognition_mismatch` incidents and zero new sessions landing in
`INDEXER_PROJECT_DIR`. Only then does Phase B ship.

| Component | Current role | Disposition |
| --- | --- | --- |
| `INDEXER_CWD` + `INDEXER_PROJECT_DIR` exclusion in `listTranscripts` | Segregates enrichment's own transcripts so backfill can skip them wholesale | **Remove.** `--no-session-persistence` means no transcript is ever written, anywhere — nothing to segregate or exclude. |
| `isIndexerTranscript` / `INDEXER_PROMPT_SIGNATURE` | Recognizes an enrichment run by its opening prompt, for historical strays predating the dedicated CWD | **Remove from the shipped code path.** No new transcript will ever match it once Phase A ships. If the deferred historical-ghost cleanup happens later, the match logic is a one-line `startsWith` check, trivially reconstructed inline in a throwaway script — not worth a maintained export. |
| `isIndexerRun` dual-signal check + `logIncident('indexer_recognition_mismatch', ...)` | Cross-checks CWD vs. prompt signature, loudly logs disagreement (the PR #72 fix for `cc-recall-hie`) | **Remove.** Both signals it correlates become meaningless once neither can fire. |
| Enrichment spawn-rate ceiling (`admitEnrichmentSpawn`) | Hard cap on LLM calls per window, independent of cause | **Keep, unchanged.** Not specific to the self-triggering bug — a generic backstop against any future runaway-spend cause (a hash-check regression, a backfill loop bug, etc.). Orthogonal to this fix. |

**Deliverables:**

- Delete `INDEXER_CWD`, `INDEXER_PROJECT_DIR`, `isIndexerTranscript`, `INDEXER_PROMPT_SIGNATURE`,
  `isIndexerRun`, and the `indexer_recognition_mismatch` incident type from
  `src/engine.ts`/`src/record/synthesizer.ts`.
- Delete `src/indexer-isolation.test.ts` and `src/indexer-self-recognition.test.ts` (they test
  code that no longer exists), replaced by whatever Phase A's own tests already cover.
- `listTranscripts` no longer special-cases any directory.

## Phase C — Decommission `ops/cc-recall-watchdog` (gated on Phase B's bar, plus one witnessed cycle)

**Rationale for removal, not just simplification:** the watchdog's own design explicitly states
it exists because it does not trust cc-recall's in-process guardrails to always be *deployed* —
"that gate shipping to GitHub but never reaching the deployed plugin cache is exactly how
Incident B stayed live for six weeks." That is a general software-delivery problem (did the fix
actually reach the running artifact?), not one specific to cc-recall, and a bespoke per-repo
launchd daemon is a heavy, non-reusable answer to a problem every plugin in this ecosystem
shares. The better long-term, global answer is deployment verification built into the plugin
lifecycle itself (see Process Improvements, below) — not a daemon per project.

**Condition:** only after Phase B's verification bar is met, run one final watchdog cycle
deliberately as its last act — confirming no elevated spawn-rate or sidecar-growth signal during
that window — then decommission: `ops/cc-recall-watchdog/uninstall.sh`, remove the directory,
unregister the `com.ccrecall.watchdog-{light,audit}` launchd jobs.

**Honest gap this leaves:** until the Process Improvements section below actually ships (a
separate, cross-plugin effort), cc-recall loses its only signal independent of its own process.
That is an accepted, bounded window given the validation gate — not a silent regression — and is
called out explicitly here so it isn't rediscovered as a surprise later.

## Testing

Standard TDD per this repo's Tier 1 gate — red before green, stated explicitly in each PR:

- Phase A: a failing test proving the current bare call's settings/CLAUDE.md leakage, passing
  after the flag change.
- Phase B: deletion of dead code is verified by the full existing suite continuing to pass with
  the deleted tests removed (nothing else references the removed exports — a compile-time check
  via `tsc --noEmit` catches any straggler).
- Phase C: no code test — verification is operational (watchdog's last cycle, `launchctl list`
  confirming clean unregistration, `uninstall.sh`'s own idempotency).

## Process Improvements — Automated Self-Verification on Deploy

Not new scope invented for this spec — directly motivated by the honest gap Phase C opens, and
grounded in a repeated pattern: PM-001, PM-003, Incident B/`cc-recall-hie`, PM-005 (sibling repo,
same failure class), and this session's own manual re-derivation of "is the fix actually
deployed" all trace to the same undetected gap — a fix merged (or even released) that never
reached the running plugin cache.

**What already exists:** `settings.json`'s `extraKnownMarketplaces.agent-marketplace.autoUpdate:
true` means Claude Code *does* self-deploy plugin updates automatically — confirmed this session
(cc-recall's `installed_plugins.json` entry updated to 0.3.0 with no manual `claude plugin
update` involved). The gap is that self-deploy has no verification step after it: it updates
version metadata and stops there.

**Placement — no new skill.** Both pieces below belong in the existing `marketplace-publishing`
skill (`claude-extras.md` already routes "versioning/manifest format" questions there, and it
already documents the install/update/cache lifecycle), as a new subsection:

1. **Manual verification runbook** (what this session did, generalized): check
   `installed_plugins.json`'s `version`/`installPath`/`lastUpdated` for the plugin; do not trust
   `gitCommitSha` as a freshness signal (found stale — pointing at an unrelated commit — even
   when `version` correctly showed the current release); the definitive check is byte-diffing the
   fix-bearing file(s) between repo source and the installed cache path.
2. **Automated self-verification pattern**: at release time, ship a manifest of fix-critical
   files with expected content hashes for that version, generated by the release pipeline (not
   hand-maintained). A cheap, cooldown-gated `SessionStart` check (cooldown so it only fires after
   an actual version change, not every session — same shape as `pieces-mcp-register.sh`'s
   cooldown) compares the installed cache against the manifest. Match: silently update a
   last-verified marker. Mismatch: loud, not silent — surfaced with the same severity as a
   `doctor` failure. Rides the plugin's own `SessionStart` hook rather than a separate daemon —
   no `launchctl` install/maintain burden.

**Scope for this spec:** cc-recall is the flagship adopter — add this as a fourth check in
`cc-recall doctor` (alongside sidecar/coverage/G0) and/or a `SessionStart`-adjacent self-check,
proving the pattern before it becomes a documented recommendation for other plugins in this
ecosystem. Retrofitting agent-skills, lessons-learned, safety-net, etc. is real follow-on work,
same shape as the Phase 6 cross-repo rollout below — noted, not done here.

**Also update:** sharpen the existing `marketplace-publishing` bullet in `claude-extras.md` to
mention deployment verification explicitly, so this is discoverable from the one place that
already routes marketplace questions — not a second pointer.

## Phase 6 Impact & Design Guidance (`cc-recall-nfb`)

This is guidance for a **separate** brainstorm/spec when Phase 6 is actually picked up — it has
grown well past what belongs inside this spec (a new CC plugin, cross-repo retrofit, `spinup-ts`
template changes, pre-commit wiring, LLM-assisted remediation UX are each their own design
surface). Captured here so none of this session's design work is lost before that happens; the
recommendation is to update `cc-recall-nfb`'s bead notes to point at this section.

**Amendment, not rewrite** — the existing Phase 6 scope (generalized spawn-rate ceiling +
convergence-invariant check across providers, reusing `ops/watchdog`'s circuit breaker) stays
completely intact. What's added is a second mode on the same tool:

- **One new CC plugin, two modes:**
  - **Build-time (lint):** a fast, deterministic pattern check — not an LLM in the loop — wired
    into pre-commit, failing the commit on a detected unsafe headless-spawn pattern. Findings are
    handed off for interpretation via paste-into-session or a slash command, which either fixes
    the finding or marks a noqa-equivalent suppression for confirmed false positives. Rollout:
    retrofit existing repos, wire into Husky pre-commit (a checked-in `.husky/pre-commit` command,
    matching this ecosystem's existing convention for hooks `pnpm install` would otherwise wipe),
    bake into `spinup-ts` so new projects get it by default.
  - **Runtime (detection):** existing Phase 6 scope, unchanged.
  - Both modes share the same underlying "what does an unsafe headless spawn look like"
    pattern-recognition core — the reason an LLM-assisted interpretation step belongs in that
    shared core rather than duplicated per mode: arbitrary shell/Python/etc. across arbitrary
    repos isn't reliably regex-able, so a candidate finding gets confirmed by an LLM before either
    blocking CI or escalating a runtime alert.
- **Candidate mechanism for "no manual launchd install/maintain," to evaluate first when Phase 6
  is designed:** ride Claude Code's own plugin hook lifecycle (a cooldown-gated `SessionStart`/
  `Stop` check) instead of a separate always-on daemon — plugin-installed hooks register
  automatically on plugin install, no `launchctl bootstrap`/plist management at all. Directly
  solves the exact friction hit twice this session installing/reinstalling two separate
  hand-managed watchdogs.
- Phase 6 is also the natural long-term home for the general "is the deployed plugin cache
  actually current" check — the thing Phase C's watchdog removal leaves without an automatic
  replacement until this exists (the Process Improvements section above is the interim,
  cc-recall-local answer).

## Non-Goals

- Rewriting Phase 6 itself, or any other project's spec — guidance only, captured for later.
- Retrofitting the isolation pattern or self-verification check into any plugin other than
  cc-recall as part of this spec.
- The deferred historical-ghost session cleanup (already explicitly declined by the user in an
  earlier session) — out of scope here, independent of this spec.
- Reviving or modifying `pieces-dev`'s hook — already fixed there, referenced only as prior art.

## Implementation Sequencing

This spec spans work at different readiness levels — flagged here so the follow-on
`writing-plans` pass scopes correctly rather than trying to plan gated work prematurely:

- **Ready to plan and implement now:** Phase A (isolation flags + red/green test), the
  `cc-recall doctor` fourth check (self-verification, real code + tests), and the
  `marketplace-publishing`/`claude-extras.md` docs edits (docs-only — per the Docs-Only Override,
  these execute directly, no plan needed).
- **Gated, not planned yet:** Phase B (waits on the real-usage verification bar) and Phase C
  (waits on Phase B shipping, plus one final watchdog cycle). These get their own short plan
  once their trigger condition is actually met — writing a plan for them now would be planning
  against an unverified assumption.
- **Deferred, out of scope for planning:** the Phase 6 guidance is for whoever brainstorms that
  work separately, not an input to this spec's implementation plan.

## Verification

1. Phase A: `runClaudeHeadless` uses `--setting-sources "" --no-session-persistence`; the red
   test (settings/CLAUDE.md leak) passes green; `settings.json` mtime and `~/.claude/projects/`
   file count unchanged across a real enrichment call.
2. Phase B (after the trigger bar is met): `INDEXER_CWD`, `isIndexerTranscript`, `isIndexerRun`,
   and the two deleted test files are gone; `tsc --noEmit` clean; full suite green.
3. Phase C (after Phase B ships and one final watchdog cycle confirms clean signals):
   `launchctl list | grep ccrecall` returns nothing; `ops/cc-recall-watchdog/` removed.
4. Process Improvements: `cc-recall doctor` reports a fourth check (deployment self-verification);
   `marketplace-publishing` skill contains the new subsection; `claude-extras.md`'s existing
   bullet mentions deployment verification.
5. `cc-recall-nfb` bead notes updated to reference this spec's Phase 6 Impact section.
