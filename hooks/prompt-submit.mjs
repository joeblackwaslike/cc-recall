#!/usr/bin/env node
// cc-recall UserPromptSubmit hook (adoption reminder). Scaffolded (cc-recall-3i1) — not implemented.
import { readFileSync } from 'node:fs';
let _payload = '';
try {
  _payload = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}
// TODO(cc-recall §S2): detect "find/restore a past session" intent → inject a search reminder.
process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
