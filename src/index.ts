// cc-recall — public library entry. Re-exports the engine so hooks, the CLI, and any
// future platform adapters import from one stable surface (`@cc-recall`).

export * from './types.js';
export * from './engine.js';
export * from './record/schema.js';
export * from './record/synthesizer.js';
export * from './transcript/parse.js';
export * from './surfaces/sidecar.js';
export * from './surfaces/claude-mem.js';
export * from './surfaces/native-memory.js';
export * from './surfaces/transcript-writer.js';
export * from './migrate/home-path.js';
