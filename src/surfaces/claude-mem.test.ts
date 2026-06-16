import { describe, expect, it } from 'vitest';
import {
  type FetchLike,
  claudeMemHealth,
  searchClaudeMem,
  verifyClaudeMemG0,
} from './claude-mem.js';

const respond = (body: unknown, ok = true, status = 200): ReturnType<FetchLike> =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

const healthyFetch: FetchLike = (url) =>
  url.includes('/api/health')
    ? respond({ status: 'ok', version: '13.6.0', mcpReady: true })
    : respond({ content: [{ type: 'text', text: 'a result' }] });

const refusingFetch: FetchLike = () => Promise.reject(new Error('ECONNREFUSED'));

describe('claude-mem adapter', () => {
  it('reports health from the worker', async () => {
    const health = await claudeMemHealth({ fetch: healthyFetch });
    expect(health.reachable).toBe(true);
    expect(health.ready).toBe(true);
    expect(health.version).toBe('13.6.0');
  });

  it('never throws when the worker is down', async () => {
    const health = await claudeMemHealth({ fetch: refusingFetch });
    expect(health.reachable).toBe(false);
    expect(health.error).toContain('ECONNREFUSED');
  });

  it('returns search text on success', async () => {
    const result = await searchClaudeMem('pieces', { fetch: healthyFetch });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('a result');
  });

  it('G0 passes when reachable, ready, and search works', async () => {
    const g0 = await verifyClaudeMemG0({ fetch: healthyFetch });
    expect(g0.pass).toBe(true);
    expect(g0.searchOk).toBe(true);
  });

  it('G0 fails (without throwing) when the worker is unreachable', async () => {
    const g0 = await verifyClaudeMemG0({ fetch: refusingFetch });
    expect(g0.pass).toBe(false);
    expect(g0.health.reachable).toBe(false);
  });
});
