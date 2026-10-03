// E2a-3 harness — tiny exec shims so drivers never build shell strings.
import { execFile } from 'node:child_process';

export function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: opts.timeoutMs ?? 30_000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function runOk(file, args, opts = {}) {
  try {
    return await run(file, args, opts);
  } catch (err) {
    throw new Error(`${file} ${args.join(' ')} failed: ${err.message}\nstderr: ${err.stderr ?? ''}`);
  }
}

export async function tryRun(file, args, opts = {}) {
  try {
    const { stdout } = await run(file, args, opts);
    return stdout;
  } catch {
    return undefined;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(predicate, { timeoutMs = 30_000, pollMs = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(pollMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}
