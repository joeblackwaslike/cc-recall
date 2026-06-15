---
description: "Phase 0 home-path normalization — consolidate dead joeblack-to-joe slugs."
---

# /recall:migrate

Consolidate sessions under dead home-path slugs (e.g. `-Users-joeblack-*` to `-Users-joe-*`) so they become visible from the current working directory. This is a prerequisite to backfill.

## Usage

**Always dry-run first (the default):**

```bash
cc-recall migrate [--from /Users/joeblack] [--to /Users/joe]
```

**Review the output, then apply:**

```bash
cc-recall migrate --apply
```

**If something goes wrong, revert:**

```bash
cc-recall migrate --revert
```

## What it does

1. **Directory slugs:** renames `-Users-joeblack-<rest>` dirs to `-Users-joe-<rest>`, merging when the destination already exists (UUIDs are unique, no filename collisions)
2. **In-transcript paths:** rewrites `/Users/joeblack/...` to `/Users/joe/...` inside transcript JSONL so `cwd` resolves to the live tree

## Safety

- Dry-run by default — nothing is written unless `--apply` is passed
- All originals are backed up before rewriting
- A manifest is saved at `~/.claude/cc-recall/migrate-manifest.json` for audit and rollback
- Integrity-checked: if a rewrite corrupts a transcript, it is auto-restored from backup
- `--revert` uses the manifest to undo the entire migration
