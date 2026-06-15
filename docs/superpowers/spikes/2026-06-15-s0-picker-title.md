# S0 Spike: Session Picker & Title Generation

**Date:** 2026-06-15
**Source:** Reverse-engineering of VS Code extension v2.1.177 (`extension.js`, minified)

## Title Generation

**Location:** `~/.vscode-insiders/extensions/anthropic.claude-code-2.1.177-darwin-arm64/extension.js`

- `dse()` (line ~284): Generates title suggestions via `claude-haiku-4-5-20251001`
- `renameSession()` (line ~220): Persists title as `{"type":"ai-title","sessionId":"...","aiTitle":"..."}` in the transcript JSONL

**When it fires:** **Never automatically.** Only triggered by explicit manual UI rename action. No `SessionEnd` handler, no background worker, no auto-save. The infrastructure exists but never auto-persists.

**Root cause of 97.7% untitled:** Title generation is 100% manual. User must explicitly trigger rename via UI context menu or command, accept/provide title text, then `renameSession()` writes it. No session lifecycle event triggers title generation.

## Picker Enumeration

**Location:** `claudeVSCodeSessionsList` webview provider (line ~884)

- **Source:** `~/.claude/projects/-*/*.jsonl` — one file per session
- **Sort order:** `lastModified` (mtime), most recent first
- **Count cap:** None found in extension code; webview may impose frontend limit
- **Caching:** Async on-demand per project directory, no preload cache

## Title Display Priority (in Picker)

1. `custom-title` (user-set, highest — locks out ai-title)
2. `ai-title` (generated or injected)
3. `lastPrompt` (fallback)
4. `summaryHint` (fallback)
5. `firstPrompt` / `commandFallback` (final fallback)

## cc-recall Injection Compatibility

**Injected `ai-title` lines ARE honored by the picker**, with one condition:

- Format: `{"type":"ai-title","sessionId":"...","aiTitle":"...","source":"cc-recall","sourceHash":"..."}`
- Will display if and only if no `custom-title` record exists for that session
- If `custom-title` exists, all fallbacks including `ai-title` are ignored
- Extra fields (`source`, `sourceHash`) are ignored by the picker — no conflict

The extension reads both head and tail of the JSONL for title records, so appending to the end (as cc-recall does) works correctly.

## Implications for cc-recall

1. **cc-recall's transcript injection is the only mechanism that will title 97.7% of sessions** — the native path requires manual action per session
2. **No conflict risk:** cc-recall injects `ai-title`, not `custom-title`, so user renames always take precedence
3. **Upstream fix (U0):** Anthropic should add automatic title generation on session end — the `dse()` infrastructure already exists, it just needs a lifecycle trigger
