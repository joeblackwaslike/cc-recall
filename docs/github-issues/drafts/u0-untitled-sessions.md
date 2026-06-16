# U0 Upstream Issue Draft

**Target repo:** anthropics/claude-code
**Status:** Draft — file when cc-recall repo is polished and public-ready
**Rationale:** Drive traffic back to cc-recall as the immediate fix; maximize adoption before Anthropic addresses upstream

---

**Title:** `97.5% of sessions lack an ai-title, making them undiscoverable in the session picker`

## Problem

On a machine with 17,300 Claude Code sessions, only 440 (2.5%) have an `ai-title` record. The other 97.5% display as truncated first-messages in the session picker, making it nearly impossible to find past work by browsing.

Additionally, 14,322 sessions (82.8%) sit under dead home-path slugs (e.g. `-Users-joeblack-github-*`) because the macOS home directory was migrated from `/Users/joeblack` to `/Users/joe`. These sessions are invisible from any current working directory.

## Root cause

Reverse-engineering the VS Code extension (v2.1.177) shows that `ai-title` generation infrastructure exists — `dse()` calls `claude-haiku-4-5-20251001` to generate title suggestions — but **no session lifecycle event triggers it**. Title generation only fires on explicit manual rename via the UI. There is no `SessionEnd` hook, no background worker, and no auto-save path.

The title display priority in the picker is: `custom-title` > `ai-title` > `lastPrompt` > `summaryHint` > `firstPrompt`. Since `ai-title` is never auto-written, most sessions fall through to `lastPrompt` or `firstPrompt`, which are often truncated and non-descriptive.

## Measured data

| Metric | Count | % |
|--------|------:|--:|
| Total sessions | 17,300 | 100% |
| With `ai-title` | 440 | 2.5% |
| Without `ai-title` | 16,860 | 97.5% |
| Under dead home-path slugs | 14,322 | 82.8% |

## Request

1. **Automatic title generation on session end** — the `dse()` infrastructure already exists; it just needs a lifecycle trigger (e.g. `SessionEnd` or a deferred background task after the session closes). This would make all future sessions discoverable.

2. **Retroactive titling** — a one-time backfill pass over existing untitled sessions would recover the 97.5% that are currently lost.

3. **Home-path migration handling** — when the OS home directory changes, existing project slug directories become orphaned. A migration utility (or at minimum documentation) would help users consolidate these.

## Workaround

I built [cc-recall](https://github.com/joeblackwaslike/cc-recall), a Claude Code plugin that synthesizes discoverability records per session and injects `ai-title` lines into transcripts. It works (the picker honors injected `ai-title` records), but the upstream fix — automatic title generation — is the real cure.

## Environment

- Claude Code VS Code extension v2.1.177
- macOS Tahoe, M1 MacBook Pro
- 17,300 sessions across ~150 project directories
