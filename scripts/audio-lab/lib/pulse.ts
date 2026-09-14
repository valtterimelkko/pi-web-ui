/**
 * Private PulseAudio capsule.
 *
 * The lab must never touch the host's shared sound configuration: the owner's
 * desktop audio, the VNC browser and any other agent all share the system
 * PulseAudio instance. This module starts a **separate daemon** with its own
 * unix socket, its own null sinks and its own runtime directory, and every
 * lab process (Chrome, parec, pacat) is pointed at it via an explicit
 * `PULSE_SERVER`. There is no `pactl set-default-sink` against the system
 * daemon and no `~/.config/pulse` write.
 *
 * Signal chain produced here:
 *   browser -> module-null-sink `pi_lab_main` -> `.monitor` -> parec (raw PCM)
 *
 * Two sinks exist: `pi_lab_calib` proves the record path is live WITHOUT
 * writing anything into the recording under test, and `pi_lab_main` is the
 * sink the scenario actually renders into. A calibration that played into the
 * main sink would put a known tone in the measurement window and confound
 * every head-loss measurement afterwards, so the separation is deliberate.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OwnedProcess } from './proc.js';

export interface PulseConfig {
  /** Directory holding the daemon socket, pid file and logs. */
  runtimeDir: string;
  mainSink: string;
  calibSink: string;
  sampleRate: number;
}

export const DEFAULT_MAIN_SINK = 'pi_lab_main';
export const DEFAULT_CALIB_SINK = 'pi_lab_calib';
export const DEFAULT_SAMPLE_RATE = 48000;

/** Render the daemon's `.pa` script. Exported so a test can assert that the
 *  module set is closed (no host default.pa include, no host socket). */
export function renderPulseConfig(config: PulseConfig): string {
  const socket = path.join(config.runtimeDir, 'native');
  return [
    '.fail',
    `load-module module-native-protocol-unix socket=${socket} auth-anonymous=1`,
    `load-module module-null-sink sink_name=${config.calibSink} sink_properties=device.description=${config.calibSink} rate=${config.sampleRate} channels=1`,
    `load-module module-null-sink sink_name=${config.mainSink} sink_properties=device.description=${config.mainSink} rate=${config.sampleRate} channels=1`,
    `set-default-sink ${config.mainSink}`,
    '',
  ].join('\n');
}

export function pulseEnv(config: PulseConfig): NodeJS.ProcessEnv {
  return {
    PULSE_SERVER: `unix:${path.join(config.runtimeDir, 'native')}`,
    // Keep PulseAudio from consulting or writing per-user client state.
    PULSE_RUNTIME_PATH: config.runtimeDir,
    PULSE_CONFIG_PATH: config.runtimeDir,
    XDG_RUNTIME_DIR: config.runtimeDir,
    HOME: config.runtimeDir,
  };
}

export class PulseCapsule {
  readonly config: PulseConfig;
  private daemon: OwnedProcess | null = null;
  private recorder: OwnedProcess | null = null;
  private readonly env: NodeJS.ProcessEnv;

  constructor(rootDir: string, overrides: Partial<PulseConfig> = {}) {
    this.config = {
      runtimeDir: path.join(rootDir, 'pulse'),
      mainSink: overrides.mainSink ?? DEFAULT_MAIN_SINK,
      calibSink: overrides.calibSink ?? DEFAULT_CALIB_SINK,
      sampleRate: overrides.sampleRate ?? DEFAULT_SAMPLE_RATE,
    };
    this.env = pulseEnv(this.config);
  }

  get clientEnv(): NodeJS.ProcessEnv {
    return { ...this.env };
  }

  get socketPath(): string {
    return path.join(this.config.runtimeDir, 'native');
  }

  get identities() {
    return [this.daemon, this.recorder].filter((p): p is OwnedProcess => p !== null).map((p) => p.identity);
  }

  async start(): Promise<void> {
    const dir = this.config.runtimeDir;
    mkdirSync(path.join(dir, 'log'), { recursive: true, mode: 0o700 });
    mkdirSync(path.join(dir, 'state'), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, 'daemon.pa'), renderPulseConfig(this.config), { mode: 0o600 });
    this.daemon = await OwnedProcess.spawn({
      command: 'pulseaudio',
      args: [
        '--daemonize=no',
        '--exit-idle-time=-1',
        '--disallow-exit',
        '--disable-shm=true',
        '-n',
        `--file=${path.join(dir, 'daemon.pa')}`,
        `--log-target=file:${path.join(dir, 'log', 'daemon.log')}`,
        '--log-level=info',
      ],
      env: { ...process.env, ...this.env },
      logPath: path.join(dir, 'log', 'daemon.stderr.log'),
    });
    await this.waitForSink(this.config.calibSink, 8000);
    await this.waitForSink(this.config.mainSink, 8000);
  }

  private async pactl(args: string[]): Promise<string> {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      execFile(
        'pactl',
        args,
        { env: { ...process.env, ...this.env }, timeout: 15000 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(`pactl ${args.join(' ')} failed: ${stderr || error.message}`));
          else resolve(stdout);
        }
      );
    });
  }

  private async waitForSink(name: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const output = await this.pactl(['list', 'short', 'sinks']);
        if (output.split('\n').some((line) => line.split('\t').includes(name))) return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`PulseAudio sink ${name} never appeared (${lastError})`);
  }

  async listSources(): Promise<string> {
    return this.pactl(['list', 'short', 'sources']);
  }

  /** Write a probe tone into a sink with `pacat`. Used only on the
   *  calibration sink so the scenario recording stays clean. */
  async playTone(sink: string, frequencyHz: number, durationMs: number, amplitude = 0.5): Promise<void> {
    const rate = this.config.sampleRate;
    const frames = Math.round((durationMs / 1000) * rate);
    const buffer = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequencyHz * i) / rate));
      buffer.writeInt16LE(value, i * 2);
    }
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'pacat',
        [
          '--playback',
          '-d',
          sink,
          '--format=s16le',
          `--rate=${rate}`,
          '--channels=1',
          '--raw',
        ],
        { env: { ...process.env, ...this.env }, stdio: ['pipe', 'ignore', 'pipe'] }
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pacat exited ${code}: ${stderr}`));
      });
      child.stdin.end(buffer);
    });
  }

  /**
   * Start the independent OS-level monitor recording of `sink`.
   *
   * `parec` is a separate PulseAudio client process with no relationship to
   * Chrome or to the product code, which is what makes this layer independent
   * evidence rather than a self-report. Output is raw PCM16 deliberately: a WAV
   * header written by a process that is then signalled is easy to get wrong,
   * and a wrong header would silently truncate the analysed audio. The raw
   * stream is remuxed to WAV by FFmpeg after the recorder has stopped.
   */
  async startRecorder(sink: string, rawPath: string): Promise<void> {
    if (this.recorder) throw new Error('Recorder already running');
    this.recorder = await OwnedProcess.spawn({
      command: 'parec',
      args: [
        '-d',
        `${sink}.monitor`,
        '--format=s16le',
        `--rate=${this.config.sampleRate}`,
        '--channels=1',
        '--raw',
        '--latency-msec=50',
      ],
      env: { ...process.env, ...this.env },
      // The recorder's stdout IS the audio, so it must go straight to the PCM
      // file. Piping it would let an undrained pipe buffer stall the recorder
      // and silently drop audio from the middle of the measurement.
      stdoutPath: rawPath,
      logPath: `${rawPath}.log`,
    });
  }

  /** Raw byte count of the recording so far, for readiness checks. */
  recordedBytes(rawPath: string): number {
    try {
      return statSync(rawPath).size;
    } catch {
      return 0;
    }
  }

  /** Wait until the recorder has produced real (non-header) audio frames. */
  async waitForRecorderReady(rawPath: string, minBytes: number, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let size = 0;
    while (Date.now() < deadline) {
      size = this.recordedBytes(rawPath);
      if (size >= minBytes) return size;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Recorder produced only ${size} bytes in ${timeoutMs} ms (needed ${minBytes})`);
  }

  async stopRecorder(): Promise<'exited' | 'killed' | 'timeout'> {
    if (!this.recorder) return 'exited';
    const outcome = await this.recorder.stop(2000, 2000);
    this.recorder = null;
    return outcome;
  }

  async stop(): Promise<void> {
    await this.stopRecorder();
    if (this.daemon) {
      await this.daemon.stop(3000, 3000);
      this.daemon = null;
    }
  }

  /** True when the private daemon socket file is present and the daemon is
   *  still the exact process that was started. */
  isDaemonAlive(): boolean {
    return this.daemon !== null && this.daemon.isAlive();
  }
}

/** Read a raw PCM16 recording into an Int16Array view. */
export function readRawPcm16(filePath: string): Int16Array {
  const buffer = readFileSync(filePath);
  const frames = Math.floor(buffer.byteLength / 2);
  return new Int16Array(buffer.buffer, buffer.byteOffset, frames);
}
