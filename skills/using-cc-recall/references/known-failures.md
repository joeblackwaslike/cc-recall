# Known failures

## A headless `claude -p` subprocess still loads the caller's global hooks

A plugin that spawns a headless `claude -p` session (e.g. for LLM enrichment) is spawning a
full Claude Code session, subject to the same installed plugin hooks as any interactive
session — including its own. Pinning the subprocess `cwd` does not change this:
`--setting-sources` still resolves to the caller's global settings unless explicitly overridden,
and overriding it can break auth (verified: it breaks OAuth token resolution). There is no
process-level flag that suppresses hooks without also breaking auth — the safe alternative is
recognizing your own output by content, not by suppressing the hook that fires on it (see
below).

Confirmed by direct reproduction: a headless subprocess fires the caller's configured
`SessionEnd` hook on **normal completion**, not only on `SIGTERM` (the only case Claude Code's
own docs describe). There is no documented Claude-Code-level nesting-detection to suppress this.

**Consequence:** if that `SessionEnd` hook re-triggers the same plugin — e.g. an indexer
re-indexing the transcript the subprocess just wrote — the plugin can spawn itself repeatedly,
seconds apart, with no natural stopping point.

**Guard against it explicitly:**

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
