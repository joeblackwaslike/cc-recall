# Known failures

## A headless `claude -p` subprocess still loads the caller's global hooks

A plugin that spawns a headless `claude -p` session (e.g. for LLM enrichment) is spawning a
full Claude Code session, subject to the same installed plugin hooks as any interactive
session — including its own. Pinning the subprocess `cwd` does not change this: without an
explicit override, `--setting-sources` resolves to the caller's global settings.

**Update:** `--setting-sources ""` combined with `--no-session-persistence` suppresses hooks,
plugins, and CLAUDE.md loading, and writes no session transcript at all — verified to *not*
break auth (Max subscription / Keychain-based OAuth resolution is unaffected). This is now the
primary fix: cc-recall's own `runClaudeHeadless` (`src/record/synthesizer.ts`) passes both
flags. `CLAUDE_CONFIG_DIR` was tried first and rejected — *that* override is what breaks
Keychain auth (credentials are keyed by config-dir path hash); `--setting-sources` carries no
such cost. See `docs/superpowers/specs/2026-08-15-runclaudeheadless-isolation.md` for the full
verification.

Confirmed by direct reproduction (prior to the fix above): a headless subprocess fires the
caller's configured `SessionEnd` hook on **normal completion**, not only on `SIGTERM` (the only
case Claude Code's own docs describe). There is no documented Claude-Code-level
nesting-detection to suppress this.

**Consequence (pre-fix, or for a caller that can't adopt the flags above):** if that
`SessionEnd` hook re-triggers the same plugin — e.g. an indexer re-indexing the transcript the
subprocess just wrote — the plugin can spawn itself repeatedly, seconds apart, with no natural
stopping point.

**Defense-in-depth guard, still in place pending removal (`--no-session-persistence` means no
transcript is ever written, so these can no longer fire, but the code hasn't been deleted yet):**

- Recognize and skip your own subprocess's output by content/prompt-signature before doing any
  further LLM-costing work, not just by output location (cwd isolation alone is not sufficient —
  historical output predating the isolation can still be scattered across the corpus). cc-recall's
  concrete implementation: `isIndexerTranscript` matches a fixed prompt-signature sentinel and is
  checked at the indexing entry point before any LLM call, so a nested `SessionEnd` firing against
  the subprocess's own transcript is a cheap no-op rather than a further spawn.
- Add an idempotency guard keyed by the unit of work (e.g. transcript path + content hash) so a
  duplicate or nested trigger for the same input is a cheap no-op even if the content check above
  is ever bypassed.

Cross-referenced in the private `postmortems` repository (PM-001, PM-003) — not publicly
accessible; this file carries the full generalizable guidance on its own.
