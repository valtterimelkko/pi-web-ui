import { appendFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RotatingMetricsFileOptions {
  dir: string;
  /** Base file name (newest data). Older generations use `<basename>.<n>`. */
  basename?: string;
  /** Rotation trigger: a file never grows past this bound (plus one line). */
  maxFileBytes: number;
  /** Hard bound on the number of generations kept, including the current file. */
  maxFiles: number;
}

/**
 * A size-bounded, rotating JSONL sink for the A2 health time series.
 *
 * Bounds (both are asserted by unit tests, not assumed):
 *  - at most `maxFiles` generations exist at any time;
 *  - every generation is at most `maxFileBytes` bytes, except that a single
 *    line longer than the bound is never split (a truncated JSON line is
 *    worse than one oversized line) — so the true total bound is
 *    `maxFiles * (maxFileBytes + longestLine)`.
 *
 * Rotation is serialised through one promise chain so concurrent samples cannot
 * interleave a partial line or race the rename.
 */
export class RotatingMetricsFile {
  private readonly dir: string;
  private readonly basename: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private currentBytes: number | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RotatingMetricsFileOptions) {
    this.dir = options.dir;
    this.basename = options.basename ?? 'health-metrics.jsonl';
    this.maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes));
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles));
  }

  get currentPath(): string {
    return path.join(this.dir, this.basename);
  }

  private generationPath(index: number): string {
    if (index === 0) return this.currentPath;
    const extension = path.extname(this.basename);
    const stem = extension ? this.basename.slice(0, -extension.length) : this.basename;
    return path.join(this.dir, `${stem}.${index}${extension}`);
  }

  /** Appends one line atomically with respect to other appends. */
  append(line: string): Promise<void> {
    this.queue = this.queue.then(() => this.appendNow(line), () => this.appendNow(line));
    return this.queue;
  }

  /** Resolves when every queued append has hit the disk. */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async appendNow(line: string): Promise<void> {
    const payload = line.endsWith('\n') ? line : `${line}\n`;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const size = await this.currentSize();
    if (size > 0 && size + Buffer.byteLength(payload) > this.maxFileBytes) {
      await this.rotate();
    }
    await appendFile(this.currentPath, payload, { mode: 0o600 });
    this.currentBytes = (this.currentBytes ?? 0) + Buffer.byteLength(payload);
  }

  private async currentSize(): Promise<number> {
    if (this.currentBytes !== undefined) return this.currentBytes;
    try {
      const info = await stat(this.currentPath);
      this.currentBytes = info.size;
    } catch {
      this.currentBytes = 0;
    }
    return this.currentBytes;
  }

  /** base → .1 → .2 … dropping the oldest generation beyond `maxFiles`. */
  private async rotate(): Promise<void> {
    const oldest = this.generationPath(this.maxFiles - 1);
    await rm(oldest, { force: true });
    for (let index = this.maxFiles - 2; index >= 0; index--) {
      const from = this.generationPath(index);
      const to = this.generationPath(index + 1);
      try {
        await rename(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await writeFile(this.currentPath, '', { mode: 0o600 });
    this.currentBytes = 0;
  }
}
