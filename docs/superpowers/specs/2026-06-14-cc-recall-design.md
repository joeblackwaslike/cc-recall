# cc-recall — Design Spec

**Date:** 2026-06-14
**Status:** Approved for planning
**Repo:** `github.com/joeblackwaslike/cc-recall` (local: `~/github/joeblackwaslike/cc-recall`)

---

> ### ⬛ Revision — review & sign off (2026-06-14b)
> Changes in this pass, for quick review:
> 1. **Verified corpus numbers** (§1): **15,154** sessions / 149 projects; only **356 (2.3%) titled**, **14,798 (97.7%) untitled** — the headline problem is *missing titles*, not just drift.
> 2. **`/recall:doctor`** command — reclassifies the old `verify`: runs the claude-mem **G0** check + sidecar integrity + backfill coverage % + surface health, and suggests fixes.
> 3. **Skill renamed** `cc-recall` → **`using-cc-recall`** (matches the `using-superpowers` / `using-serena` convention).
> 4. **`src/types.ts`** added (§6) — shared domain types (was an omission); `record/schema.ts` keeps the `RecallRecord` + zod schema.
> 5. **Home-path normalization → new Phase 0 (§P0):** **11,557 sessions (76%)** sit under dead `-Users-joeblack-*` slugs; consolidate to `-Users-joe-*` (with merges) *before* backfill. New `/recall:migrate` command + `src/migrate/`.
> 6. **Upstream issue (§U0):** S0 now also attributes *where* the no-title deficiency originates (CLI core vs extension), and we file a detailed issue at `anthropics/claude-code`.

---

## 1. Problem

Claude Code writes every session to a `.jsonl` transcript under `~/.claude/projects/<encoded-cwd>/`.
There are **15,154** of them across **149** projects on this machine alone. They are indexed for
human retrieval by only three things: **ai-title, first user message, and recency (mtime)**.

**Measured discoverability (2026-06-14):**

| | Count | Share |
|---|---|---|
| Sessions with a title (discoverable by browsing) | 356 | **2.3%** |
| Sessions with no title (undiscoverable) | 14,798 | **97.7%** |
| **Total** | **15,154** | 100% |

The headline is not subtle: **97.7% of sessions have no title at all** — they surface in the picker
only by first message and recency, which is pure roulette. (`ai-title` appears to be a recent
feature, so the entire back-catalog is untitled — precisely what backfill exists to fix.) Titles
that *do* exist are often mislabeled by drift, so even the 2.3% overstates true discoverability.

Consequences, all observed in practice:

- Long sessions **drift** and get titled by how they *started*, not what they *did*. A 2-day,
  2,192-line session that resolved a full spec set was labelled "Design Pieces Monitor dashboard
  framework" — its actual work (systematic spec Q&A) was invisible.
- The native picker silently drops sessions (a structurally-identical predecessor of a shown
  session did not appear — cause is in the extension's enumeration logic, not the file).
- Dozens of non-trivial sessions (300–3,800 lines) have **no title at all**.

Net: most substantial work is effectively unfindable by browsing. It is not lost — every byte is
on disk — but it is **un-indexed by content**. The only reliable retrieval today is manual content
search over raw transcripts.

## 2. Goal

Make every session — the ~15k existing and all future ones — discoverable by **what was done,
what was asked, and what was questioned**, through a single consistent record per session written
to multiple surfaces, with retrieval that an agent is *guaranteed* to use.

## 3. Non-goals (YAGNI)

- Not a general-purpose log analytics platform.
- Not a replacement for claude-mem, Pieces, or Serena — it complements them.
- No bespoke search UI in v1. We reuse existing query tools (sqlite/grep/claude-mem) and only build
  a dedicated `find-session` tool **if** the reminder-driven approach measurably underperforms (§9).
- Pseudo-session splitting is **future** (§11), not v1.

## P0. Home-path normalization — runs first (prerequisite to backfill)

Joe's home moved **`/Users/joeblack` → `/Users/joe`**; the old path no longer exists on disk.
Because `~/.claude/projects/` dirs are slugged from cwd, this fragmented the corpus:

| | Count |
|---|---|
| Sessions under dead `-Users-joeblack-*` slugs | **11,557 (76% of all sessions)** |
| Old-home project dirs | 33 |
| Projects existing under **both** homes (need merge) | 16+ |

Those 11,557 sessions are **invisible from every working directory in use today**, because the
picker keys off the live cwd slug. Normalization is a **prerequisite to backfill** — we consolidate
identity before synthesizing records and lineage, or every cross-home project's history computes as
two disconnected halves.

Two layers, both reusing the edit-in-place safety machinery (§13):

1. **Directory slug:** `-Users-joeblack-<rest>` → `-Users-joe-<rest>`. On collision with an existing
   new-home dir, **merge** by moving session files in — UUIDs are unique so no filename clash, but
   verify before each move. Includes non-github prefixes (`-Users-joeblack-projects-*`,
   `-Users-joeblack-Library-*`, bare `-Users-joeblack`).
2. **In-transcript paths:** rewrite `cwd` (and path fields in records) `/Users/joeblack/...` →
   `/Users/joe/...` so tools reading cwd resolve into the live tree.

**Configurable** (`--from /Users/joeblack --to /Users/joe`), idempotent, dry-run default, reversible
(`/recall:migrate --revert`), with a manifest logging every move/rewrite for audit and rollback.
Component: `src/migrate/home-path.ts`; command `/recall:migrate`.

## 4. Distribution shape (decided)

`cc-recall` is its **own repo** and ships as a **Claude Code plugin**, installable with a one-liner
via Joe's self-hosted marketplace. A future Codex/Gemini path is in scope architecturally (§10) but
not built in v1. This requirement shapes the layout: hooks, commands, skills, and an optional MCP
server are all first-class plugin components wired through the manifest.

## 5. Architecture

```text
                        ┌─────────────────────────────────────────────┐
   new session ends ──► │  SessionEnd hook  ─┐                          │
                        │                     ├─► cc-recall index <id>   │
   backfill run ──────► │  cc-recall backfill ┘        │                 │
                        └──────────────────────────────┼─────────────────┘
                                                        ▼
                                          ┌──────────────────────────┐
                                          │     Record Synthesizer    │  (one shared module)
                                          │  transcript → Record      │
                                          └──────────────┬───────────┘
                                                         │ writes to 4 surfaces
            ┌──────────────────────┬─────────────────────┼───────────────────────┬─────────────────┐
            ▼                      ▼                     ▼                        ▼                 ▼
   ① Sidecar SQLite        ② In-transcript        ③ claude-mem            ④ Native memory     (lineage graph
   (PRIMARY, source        edit-in-place          upsert observation       curated front page   derived from
    of truth)              (title + record)       (SECONDARY, gated)       (pointers only)      handoff refs)

   retrieval:  UserPromptSubmit hook detects "find/restore a session" intent
               → reminder to query ① + ③ + CLAUDE.md  → (dedicated tool only if needed)
```

**Surface roles & failure isolation:**

| # | Surface | Role | Failure mode |
|---|---------|------|--------------|
| ① | **Sidecar SQLite** | Primary source of truth; one queryable file for all sessions | hard dependency — owned by us, no external service |
| ② | In-transcript record + title | Self-describing files; feeds whatever the native picker honors | per-session, reversible; failure skips that session |
| ③ | claude-mem observation (upsert) | Semantic recall | **gated on G0**; degrades gracefully — absence never breaks retrieval |
| ④ | Claude native memory | Curated front page (pointers + top sessions), not bulk | best-effort |

The sidecar being primary is the core de-risking decision: **claude-mem and native memory are
secondary and optional; a failure in either never breaks the system.**

## 6. Components (code layout)

```text
cc-recall/
  .claude-plugin/plugin.json     # Claude Code plugin manifest (canonical location)
  commands/                      # /recall:search, /recall:backfill, /recall:migrate, /recall:status, /recall:lineage, /recall:doctor
  skills/using-cc-recall/SKILL.md# thin "how to find a past session" skill
  hooks/
    hooks.json                   # SessionEnd + UserPromptSubmit registration
    session-end.mjs              # forward capture → cc-recall index
    prompt-submit.mjs            # adoption reminder
  src/
    types.ts                     # shared domain types (transcript-record union, tool-call, handoff)
    transcript/parse.ts          # JSONL reader, record-type model, cwd/title/timestamps
    record/schema.ts             # RecallRecord type + zod schema + schema_version
    record/synthesizer.ts        # transcript → Record (shared by forward + backfill)
    migrate/home-path.ts         # Phase 0: joeblack→joe slug merge + in-transcript cwd rewrite
    surfaces/sidecar.ts          # SQLite read/write (PRIMARY)
    surfaces/transcript-writer.ts# edit-in-place: backup, inject record, rewrite title, integrity, revert
    surfaces/claude-mem.ts       # upsert adapter (guarded by G0)
    surfaces/native-memory.ts    # front-page maintainer
    lineage/match.ts             # handoff_out ↔ successor first-message matching
  bin/cc-recall.ts               # CLI entry (commander)
  package.json                   # @cc-recall, ESM, Node 22+, Biome, Vitest
  docs/superpowers/specs/        # this spec
```

Hooks and MCP paths use `$CLAUDE_PLUGIN_ROOT` — never absolute paths.

## 7. The Discoverability Record (S1)

One canonical schema, identical whether forward-captured, backfilled, or hand-edited.

```ts
type RecallRecord = {
  type: 'recall-record';
  schema_version: number;
  session_id: string;
  project: string;            // encoded-cwd dir name
  cwd: string;                // dominant cwd in the session
  git_branch?: string;
  started_at: string;         // from in-transcript timestamps, NOT mtime
  ended_at: string;
  line_count: number;
  title: string;              // one line — also written to the ai-title record
  summary: string;            // 2–4 sentences
  asks_implemented: string[]; // user requests that became real changes
  completions: string[];      // end-of-work summaries the assistant printed
  handoff_in:  { from_session: string | null; text: string } | null;
  handoff_out: { to_session: string | null; text: string } | null;
  artifacts: {
    files_touched: string[];
    top_tools: { name: string; count: number }[];
    distinctive_phrases: string[];
  };
  facets: {                   // the three retrieval axes
    completed: string[];
    questioned: string[];
    asked_about: string[];
  };
  provenance: 'forward' | 'backfill' | 'manual';
  generated_at: string;
  synthesizer_version: string;
};
```

**Handoff lineage (your refinement):** `handoff_in.from_session` / `handoff_out.to_session` are
resolved by matching a handoff prompt's text to a candidate session's first user message (text
similarity + time proximity). This turns the flat 15k list into a **navigable DAG of work-threads**
— `/recall:lineage <id>` walks a thread across sessions. Unresolved links stay `null` (honest, not
fuzzy).

**Timestamps come from in-transcript records, never mtime** (the bug that caused a phantom "lost
session" this session — encoded as a hard rule).

## 8. Surfaces in detail

### ① Sidecar SQLite (primary)
A single DB at a stable path (e.g., `~/.claude/cc-recall/index.db`). One row per session (record
columns + FTS over title/summary/facets/phrases). Retrieval queries this one file instead of
opening 15k transcripts. Owned entirely by cc-recall; rebuildable from transcripts at any time.

### ② In-transcript edit-in-place (safety-critical)
- **Backup** original transcript before first edit (`~/.claude/cc-recall/backups/<id>.jsonl`).
- Inject the record as a **new JSONL record type** (`recall-record`) — non-destructive to existing
  records. Update/insert the `ai-title` record with the synthesized one-line title.
- **Idempotent:** keyed by `session_id` + source content hash; re-running replaces the record.
- **Integrity:** re-parse the whole file after write; on any parse failure, restore from backup.
- **Reversible:** `cc-recall revert <id>` restores the backup.

### ③ claude-mem (secondary, gated)
Upsert by `session_id` to enrich/replace the existing auto-observation rather than duplicate.
**Enabled only after G0 passes** (§12). All calls wrapped so failure logs and continues.

### ④ Native memory (front page)
Maintains a curated index (pointers to the sidecar + the N most significant sessions) — not bulk
storage, to avoid bloating auto-injected context.

## 9. Capture, backfill & retrieval

- **S2 Forward capture:** `SessionEnd` hook runs `cc-recall index <session>` for every new session,
  using the same synthesizer → permanent consistency.
- **S3 Backfill engine:** `cc-recall backfill [--scope <glob>] [--dry-run] [--limit N]` iterates
  transcripts, idempotent and resumable (skips up-to-date hashes), reversible, integrity-checked.
- **S4 Retrieval + adoption:**
  - Records + sidecar make sessions queryable with tools already present (sqlite/grep/claude-mem).
  - A `UserPromptSubmit` hook detects "find/restore a past session" intent and **injects a reminder**
    to search the sidecar + claude-mem + CLAUDE.md before grepping raw transcripts. Hooks are the
    only layer that *guarantees* firing.
  - **YAGNI gate:** we measure whether reminder + existing search suffices. A dedicated `find-session`
    command/MCP tool is built **only if** that underperforms.

## 10. Plugin packaging & distribution

`cc-recall` is the plugin. Components map directly to plugin primitives:

| Need | Plugin component |
|------|------------------|
| forward capture | `hooks/hooks.json` → `SessionEnd` |
| adoption reminder | `hooks/hooks.json` → `UserPromptSubmit` |
| manual ops | `commands/` → `/recall:search`, `/recall:backfill`, `/recall:status`, `/recall:lineage` |
| home-path normalization (Phase 0) | `commands/` → `/recall:migrate` (joeblack→joe consolidation + cwd rewrite) |
| health & diagnostics | `commands/` → `/recall:doctor` (G0 claude-mem check + sidecar integrity + coverage % + fix suggestions) |
| "how to find a session" guidance | `skills/using-cc-recall/SKILL.md` |
| cross-tool retrieval (future) | optional MCP server exposing `search`/`lineage` |

**Manifest** — `.claude-plugin/plugin.json` (root `plugin.json` is ignored by Claude Code):

```json
{
  "name": "cc-recall",
  "description": "Make every Claude Code session discoverable by what was done, asked, and questioned.",
  "author": { "name": "Joe Black", "email": "joeblackwaslike@gmail.com" },
  "homepage": "https://github.com/joeblackwaslike/cc-recall",
  "repository": "https://github.com/joeblackwaslike/cc-recall",
  "license": "MIT"
}
```

**Marketplace entry** — add to `joeblackwaslike/agent-marketplace/.claude-plugin/marketplace.json`:

```json
{
  "name": "cc-recall",
  "description": "Session discoverability + enrichment for Claude Code.",
  "source": { "source": "github", "repo": "joeblackwaslike/cc-recall" },
  "version": "0.1.0",
  "author": { "name": "Joe Black", "email": "joeblackwaslike@gmail.com" }
}
```

**One-liner install:**
```text
/plugin marketplace add joeblackwaslike/agent-marketplace
/plugin install cc-recall@agent-marketplace
```

**Future Codex/Gemini:** Codex needs only a `.codex-plugin/marketplace.json` entry (category
`memory`/`productivity`, keywords; no per-repo manifest). Skills are portable; hooks and MCP need
per-platform adapters. Architecturally we keep the engine (`src/`, `bin/`) platform-agnostic and put
platform glue in the hook/command/MCP layers so a Codex/Gemini port is additive.

## 11. Pseudo-session splitting (future)

Detect topic drift within a long session and emit per-chunk sub-records so a drifted marathon
surfaces under each facet. Deferred — the lineage DAG + facets already mitigate most of the pain,
and splitting adds significant synthesis complexity. Revisit after v1 retrieval data.

## 12. Gates & blockers

- **G0 — claude-mem verification (BLOCKER for surface ③):** `cc-recall doctor` exercises claude-mem
  end-to-end (observation generation, search, retrieval round-trip) and reports pass/fail. No
  claude-mem-dependent code path is enabled until G0 is green. Rationale: claude-mem was recently
  repaired; we will not build a cascade of dependencies on an unverified component.
- **S0 — picker & title-generation spike (gates ② title strategy):** reverse-engineer (a) the VS
  Code extension's session enumeration (count cap? sort key? cache?) to know what title/metadata
  edits the native picker will honor, and (b) **where and when `ai-title` is generated** — Claude
  Code CLI/core vs the VS Code extension — and **why 97.7% of sessions lack one**. Working
  hypothesis: titling runs only forward from a recent feature release with no retroactive backfill,
  and the `joeblack→joe` home move orphaned 76% under dead slugs. Output documented; ② proceeds
  sidecar-first regardless of outcome. **Deliverable: a detailed upstream issue (§U0).**

- **U0 — upstream issue (deliverable, not a blocker):** file a well-evidenced issue at
  `anthropics/claude-code` reporting the indexing deficiency with the measured data (15,154 sessions,
  **2.3% titled / 97.7% untitled**, 11,557 under a dead home slug), the attributed root cause from
  S0, and a request for retroactive titling + home-path migration handling. cc-recall is the
  workaround; the upstream fix is the real cure.

## 13. Safety & reversibility (edit-in-place)

1. Never edit without a backup.
2. Non-destructive injection (new record type) + single title upsert.
3. Idempotent by content hash.
4. Post-write full re-parse; auto-restore on failure.
5. `revert` command + `backfill --dry-run`.
6. The sidecar can be fully rebuilt from transcripts, so it is never a single point of data loss.

## 14. Testing

- **Unit:** synthesizer against fixture transcripts (drifted, handoff-chained, untitled, tiny).
- **Lineage:** handoff matching precision on known chains (e.g., the Jun 4–12 pieces-dev chain).
- **Safety:** edit → re-parse → revert round-trip; integrity failure triggers restore.
- **Backfill:** run on a small fixture dir; assert idempotency (second run = no-ops).
- **Hooks:** SessionEnd produces a record; UserPromptSubmit injects reminder on intent, stays silent
  otherwise.
- **G0:** the `doctor` command itself is the claude-mem acceptance test.

## 15. Rollout phases

1. **Build core** — S0 spike (incl. title-generation attribution) + G0 verify + synthesizer +
   sidecar + transcript-writer + **`src/migrate/home-path.ts`**; test on a tiny sample (the 8
   pieces-dev sessions). File the **U0 upstream issue** once S0 attribution is in hand.
2. **Phase 0 — home-path normalization (runs before any backfill):** `/recall:migrate --dry-run`,
   review the manifest, then migrate for real — consolidate the 11,557 old-home sessions (with
   merges) and rewrite in-transcript cwd.
3. **Trial backfill** — run over the now-consolidated ~15k transcripts (your designated trial),
   `--dry-run` first, then for real; validate sidecar + a spot-check of edited transcripts.
4. **Forward capture** — enable the `SessionEnd` hook.
5. **Secondary surfaces** — after G0: claude-mem upsert + native-memory front page.
6. **Packaging** — plugin manifest, commands, skill, marketplace entry, one-liner install.
7. **Adoption measurement** — reminder hook live; decide whether a dedicated tool is warranted.
8. **(future)** remaining transcript types (subagent sidechains, other machines); pseudo-splitting.

## 16. Open questions / risks

- **S0 unknown:** if the picker caps at N and ignores edits, native-picker discoverability is
  capped regardless — mitigated by sidecar-first retrieval.
- **Synthesizer cost:** 15k summarization passes have a token/time cost; backfill must be batched,
  resumable, and rate-aware.
- **claude-mem upsert semantics:** exact API for replace-vs-duplicate confirmed during G0.
- **Handoff match precision:** fuzzy text matching may mis-link; keep links nullable and auditable.
- **Migration blast radius (Phase 0):** moves/edits ~11.5k files across 33 dirs with 16+ merges —
  run only with a full backup, `--dry-run` + manifest review first, and ideally while Claude Code /
  claude-mem indexing is idle; collisions merge by unique UUID with pre-move verification.
