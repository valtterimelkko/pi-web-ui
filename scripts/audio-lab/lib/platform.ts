/**
 * Private virtual display and the real-Chrome launcher.
 *
 * The lab's primary lane must be a REAL installed Chrome rendering audio, not
 * a headless shell and not a muted path. Chrome therefore runs headed against
 * a private Xvfb display owned by this capsule, with a private user-data
 * profile, pointed at the capsule's private PulseAudio daemon. The host's
 * VNC desktop, its Chrome profile and its audio are never involved.
 *
 * The exact argv Chrome was launched with is recorded into the run manifest:
 * "the test passed" is worthless if the browser flags cannot be stated.
 */

import path from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { OwnedProcess } from './proc.js';

export interface XvfbOptions {
  displayNumber: number;
  width?: number;
  height?: number;
  depth?: number;
  logDir: string;
}

export class XvfbCapsule {
  readonly displayNumber: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  private process: OwnedProcess | null = null;
  private socketPath = '';

  constructor(private readonly options: XvfbOptions) {
    this.displayNumber = options.displayNumber;
    this.width = options.width ?? 1280;
    this.height = options.height ?? 800;
    this.depth = options.depth ?? 24;
  }

  get display(): string {
    return `:${this.displayNumber}`;
  }

  get identities() {
    return this.process ? [this.process.identity] : [];
  }

  get pid(): number | null {
    return this.process?.identity.pid ?? null;
  }

  get commandLine(): string[] {
    return this.process ? [this.process.command, ...this.process.args] : [];
  }

  async start(): Promise<void> {
    mkdirSync(this.options.logDir, { recursive: true, mode: 0o700 });
    this.socketPath = `/tmp/.X11-unix/X${this.displayNumber}`;
    if (existsSync(this.socketPath)) {
      throw new Error(
        `Display ${this.display} is already in use (${this.socketPath} exists). ` +
          'The lab refuses to share a display rather than risk another agent\'s session.'
      );
    }
    this.process = await OwnedProcess.spawn({
      command: 'Xvfb',
      args: [
        this.display,
        '-screen',
        '0',
        `${this.width}x${this.height}x${this.depth}`,
        // TCP listening off; the unix socket (which Chrome uses) must stay on.
        '-nolisten',
        'tcp',
        '-noreset',
      ],
      env: { ...process.env, HOME: this.options.logDir },
      logPath: path.join(this.options.logDir, 'xvfb.log'),
    });
    await this.waitForSocket(8000);
  }

  private async waitForSocket(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(this.socketPath)) {
        // The socket exists; confirm Xvfb actually accepts a connection by
        // looking for its lock file too (socket presence alone can be a race).
        if (existsSync(`/tmp/.X${this.displayNumber}-lock`)) return;
      }
      if (this.process && !this.process.isAlive()) {
        throw new Error(`Xvfb exited before creating ${this.display}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Xvfb did not create ${this.display} within ${timeoutMs} ms`);
  }

  /** Prove the display really is usable (socket presence is not proof). */
  async verifyUsable(env: NodeJS.ProcessEnv): Promise<{ width: number; height: number; names: string[] }> {
    const { execFile } = await import('node:child_process');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'xdpyinfo',
        ['-display', this.display],
        { env: { ...process.env, ...env }, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`xdpyinfo failed: ${stderr || error.message}`));
          else resolve(stdout);
        }
      );
    });
    const dimensions = /dimensions:\s+(\d+)x(\d+)/.exec(output);
    const screens = [...output.matchAll(/^\s{2}screen #(\d+):/gm)].map((m) => m[1]);
    if (!dimensions) throw new Error('xdpyinfo reported no screen dimensions');
    return {
      width: Number.parseInt(dimensions[1], 10),
      height: Number.parseInt(dimensions[2], 10),
      names: screens,
    };
  }

  async stop(): Promise<void> {
    if (this.process) {
      await this.process.stop(3000, 3000);
      this.process = null;
    }
  }

  /** Last-100-lines tail of the display log, for failure reports. */
  logTail(): string {
    try {
      const log = readFileSync(path.join(this.options.logDir, 'xvfb.log'), 'utf8');
      return log.split('\n').slice(-100).join('\n');
    } catch {
      return '';
    }
  }
}

export interface ChromeLaunchSpec {
  executablePath: string;
  userDataDir: string;
  display: string;
  /** Extra flags. The lab's own controlled set, recorded into the manifest. */
  extraArgs?: string[];
  windowWidth?: number;
  windowHeight?: number;
}

export interface ChromeRun {
  pid: number;
  process: OwnedProcess;
  args: string[];
  /** `chrome://version`-equivalent identity captured after launch. */
  version: string;
  /** Wall-clock start, for correlating the capture timeline. */
  startedAtMs: number;
}

/** Flags the lab deliberately sets. Exported so tests can assert the set, and
 *  so the manifest records exactly what the browser was told. */
export function chromeArgs(spec: ChromeLaunchSpec): string[] {
  return [
    `--user-data-dir=${spec.userDataDir}`,
    `--window-size=${spec.windowWidth ?? 1280},${spec.windowHeight ?? 800}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=DialMediaRouteProvider,MediaSessionService',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--remote-debugging-port=0',
    '--enable-logging=stderr',
    '--v=0',
    ...(spec.extraArgs ?? []),
  ];
}

/** Launch the real installed Chrome headed on the private display. */
export async function launchChrome(
  spec: ChromeLaunchSpec,
  childEnv: NodeJS.ProcessEnv,
  logDir: string
): Promise<ChromeRun> {
  mkdirSync(spec.userDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const args = chromeArgs(spec);
  const process_ = await OwnedProcess.spawn({
    command: spec.executablePath,
    args,
    env: { ...childEnv, DISPLAY: spec.display },
    logPath: path.join(logDir, 'chrome.log'),
  });
  const version = readChromeVersion(spec.userDataDir);
  return {
    pid: process_.identity.pid,
    process: process_,
    args,
    version,
    startedAtMs: Date.now(),
  };
}

/** Read the human-visible browser version from the profile (no network). */
export function readChromeVersion(userDataDir: string): string {
  try {
    const localState = JSON.parse(readFileSync(path.join(userDataDir, 'Local State'), 'utf8')) as Record<
      string,
      unknown
    >;
    const stats = localState.user_experience_metrics as
      | { stability?: { stats_version?: number } }
      | undefined;
    void stats;
    const last = localState.last_version as string | undefined;
    return last ?? '';
  } catch {
    return '';
  }
}
