import { describe, it, expect } from 'vitest';
import {
  buildPromptWithFiles,
  enforceFileCap,
} from '../../../src/lib/fileAttachments';
import { MAX_FILES_PER_MESSAGE } from '@pi-web-ui/shared';

describe('buildPromptWithFiles', () => {
  it('returns the content unchanged when no files are attached', () => {
    expect(buildPromptWithFiles('hello', [])).toBe('hello');
  });

  it('returns empty string when no files and empty content', () => {
    expect(buildPromptWithFiles('', [])).toBe('');
  });

  it('builds the single-file note and prepends it to the content', () => {
    const out = buildPromptWithFiles('summarize this', ['/tmp/pi-uploads/a.txt']);
    // Exact wording the runtimes already see — do not drift.
    expect(out).toBe(
      "I've uploaded a file. Please read it at: /tmp/pi-uploads/a.txt\n\nsummarize this",
    );
  });

  it('uses the single-file note alone when there is no user content', () => {
    const out = buildPromptWithFiles('', ['/tmp/pi-uploads/a.txt']);
    expect(out).toBe(
      "I've uploaded a file. Please read it at: /tmp/pi-uploads/a.txt",
    );
  });

  it('builds a multi-file note listing every path on its own line', () => {
    const out = buildPromptWithFiles('compare these', [
      '/tmp/pi-uploads/a.txt',
      '/tmp/pi-uploads/b.png',
    ]);
    expect(out).toBe(
      "I've uploaded 2 files. Please read them at:\n" +
        '/tmp/pi-uploads/a.txt\n' +
        '/tmp/pi-uploads/b.png\n\n' +
        'compare these',
    );
  });

  it('counts the files in the multi-file note (5 files = max)', () => {
    const paths = Array.from({ length: 5 }, (_, i) => `/tmp/pi-uploads/f${i}.txt`);
    const out = buildPromptWithFiles('review all', paths);
    expect(out.startsWith("I've uploaded 5 files. Please read them at:\n")).toBe(true);
    // Every path present, in order.
    for (const p of paths) {
      expect(out).toContain(p);
    }
  });

  it('uses the multi-file note alone when there is no user content', () => {
    const out = buildPromptWithFiles('', [
      '/tmp/pi-uploads/a.txt',
      '/tmp/pi-uploads/b.txt',
    ]);
    expect(out).toBe(
      "I've uploaded 2 files. Please read them at:\n/tmp/pi-uploads/a.txt\n/tmp/pi-uploads/b.txt",
    );
  });

  it('preserves the user content exactly, including blank lines', () => {
    const out = buildPromptWithFiles('line1\n\nline2', ['/tmp/pi-uploads/a.txt']);
    expect(out).toBe(
      "I've uploaded a file. Please read it at: /tmp/pi-uploads/a.txt\n\nline1\n\nline2",
    );
  });
});

describe('enforceFileCap', () => {
  it('accepts everything when the total stays under the cap', () => {
    const res = enforceFileCap(['a', 'b'], 0, 5);
    expect(res.accepted).toEqual(['a', 'b']);
    expect(res.rejectedCount).toBe(0);
  });

  it('accepts exactly up to the cap (boundary: 0 current + 5 incoming)', () => {
    const res = enforceFileCap(['a', 'b', 'c', 'd', 'e'], 0, 5);
    expect(res.accepted).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(res.rejectedCount).toBe(0);
  });

  it('rejects the overflow when incoming would cross the cap', () => {
    const res = enforceFileCap(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 0, 5);
    expect(res.accepted).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(res.rejectedCount).toBe(2);
  });

  it('accounts for files already attached (3 current + 3 incoming → 2 accepted)', () => {
    const res = enforceFileCap(['d', 'e', 'f'], 3, 5);
    expect(res.accepted).toEqual(['d', 'e']);
    expect(res.rejectedCount).toBe(1);
  });

  it('rejects everything when already at the cap', () => {
    const res = enforceFileCap(['x'], 5, 5);
    expect(res.accepted).toEqual([]);
    expect(res.rejectedCount).toBe(1);
  });

  it('handles a single new file under the cap', () => {
    const res = enforceFileCap(['only'], 0, 5);
    expect(res.accepted).toEqual(['only']);
    expect(res.rejectedCount).toBe(0);
  });

  it('defaults to the shared MAX_FILES_PER_MESSAGE constant when no max given', () => {
    // Guards the single source of truth: the default cap IS the shared constant.
    expect(MAX_FILES_PER_MESSAGE).toBe(5);
    const ok = enforceFileCap(['a', 'b', 'c', 'd', 'e'], 0);
    expect(ok.accepted).toHaveLength(5);
    expect(ok.rejectedCount).toBe(0);

    const over = enforceFileCap(['a', 'b', 'c', 'd', 'e', 'f'], 0);
    expect(over.accepted).toHaveLength(5);
    expect(over.rejectedCount).toBe(1);
  });

  it('does not mutate the incoming array', () => {
    const incoming = ['a', 'b', 'c', 'd', 'e', 'f'];
    const snapshot = [...incoming];
    enforceFileCap(incoming, 0, 5);
    expect(incoming).toEqual(snapshot);
  });

  it('works with non-string items (File objects)', () => {
    const f1 = { name: 'a' } as never;
    const f2 = { name: 'b' } as never;
    const res = enforceFileCap([f1, f2], 4, 5);
    expect(res.accepted).toEqual([f1]);
    expect(res.rejectedCount).toBe(1);
  });
});
