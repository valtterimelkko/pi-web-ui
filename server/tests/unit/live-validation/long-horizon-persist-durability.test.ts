import { describe, expect, it, vi } from 'vitest';

const { events } = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock('fs/promises', () => {
  const fileHandle = {
    writeFile: vi.fn(async () => { events.push('write'); }),
    sync: vi.fn(async () => { events.push('sync'); }),
    close: vi.fn(async () => { events.push('close'); }),
  };
  const dirHandle = {
    sync: vi.fn(async () => { events.push('dir-sync'); }),
    close: vi.fn(async () => { events.push('dir-close'); }),
  };
  let openCount = 0;
  return {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => { events.push('legacy-write'); }),
    open: vi.fn(async () => ++openCount === 1 ? fileHandle : dirHandle),
    rename: vi.fn(async () => { events.push('rename'); }),
    rm: vi.fn(async () => undefined),
  };
});

import { persistState, type LongHorizonRunState } from '../../../src/live-validation/long-horizon-runner.js';

describe('P1: long-horizon state durability', () => {
  it('fsyncs and closes the temporary file before the atomic rename', async () => {
    events.length = 0;
    await persistState('/tmp/lh-durable/state.json', {
      runId: 'run', status: 'running', iterations: 1,
    } as unknown as LongHorizonRunState);

    expect(events.slice(0, 4)).toEqual(['write', 'sync', 'close', 'rename']);
    expect(events).not.toContain('legacy-write');
  });
});
