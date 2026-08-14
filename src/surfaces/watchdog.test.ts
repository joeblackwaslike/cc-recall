import { describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn<(...args: unknown[]) => Buffer>();
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const { checkWatchdogInstalled } = await import('./watchdog.js');

const LABEL = 'com.ccrecall.watchdog-light';

describe('checkWatchdogInstalled', () => {
  it('reports installed when launchctl list finds the label', () => {
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    const result = checkWatchdogInstalled(LABEL);
    expect(result.installed).toBe(true);
    expect(result.label).toBe(LABEL);
    expect(execFileSyncMock).toHaveBeenCalledWith('launchctl', ['list', LABEL], expect.anything());
  });

  it('reports not installed when launchctl exits non-zero (job not registered)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Could not find service');
    });
    const result = checkWatchdogInstalled(LABEL);
    expect(result.installed).toBe(false);
    expect(result.detail).toContain('Could not find service');
  });

  it('never throws when launchctl itself is unavailable (non-macOS)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT: spawn launchctl');
    });
    expect(() => checkWatchdogInstalled(LABEL)).not.toThrow();
  });
});
