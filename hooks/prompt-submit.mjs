#!/usr/bin/env node
// cc-recall UserPromptSubmit hook (spec §S4: adoption reminder).
//
// Detects "find/restore a past session" intent in the user's prompt and injects
// a system-reminder directing the agent to search the cc-recall sidecar before
// grepping raw transcripts. Must respond quickly and never block.

import { readFileSync } from 'node:fs';

const respond = (object) => {
  process.stdout.write(JSON.stringify(object));
};
const proceed = () => respond({ continue: true, suppressOutput: true });

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  proceed();
  process.exit(0);
}

const prompt = typeof payload.prompt === 'string' ? payload.prompt.toLowerCase() : '';

const INTENT_RE =
  /\b(find|restore|recall|recover|where did we|which session|past session|previous session|last time we|did we already|what session|search sessions?|look up.*session)\b/i;

if (!prompt || !INTENT_RE.test(prompt)) {
  proceed();
} else {
  respond({
    continue: true,
    suppressOutput: false,
    message:
      '**cc-recall**: To find a past session, search the sidecar first:\n' +
      '```\ncc-recall search "<what you remember>"\n```\n' +
      'or use `/recall:search`. Fall back to claude-mem or raw transcript grep only if the sidecar misses.',
  });
}
