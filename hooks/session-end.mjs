#!/usr/bin/env node
// cc-recall SessionEnd hook (S2 forward capture). Scaffolded (cc-recall-3i1) — not implemented.
// Will synthesize a discoverability record for the just-ended session and write the surfaces.
import { readFileSync } from 'node:fs';
let _payload = '';
try {
  _payload = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}
// TODO(cc-recall §S2): parse payload → cc-recall index <session>.
process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
