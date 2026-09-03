import { spawn } from 'node:child_process';

type Notify = (args: string[]) => Promise<void> | void;
type Environment = Pick<NodeJS.ProcessEnv, 'NOTIFY_SOCKET' | 'WATCHDOG_USEC'>;

interface SystemdNotifierOptions {
  environment?: Environment;
  notify?: Notify;
  logger?: { warn: (message: string) => void };
}

function runSystemdNotify(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/systemd-notify', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`systemd-notify exited ${code}`)));
  });
}

export function startSystemdNotifier(options: SystemdNotifierOptions = {}): () => void {
  const environment = options.environment ?? process.env;
  if (!environment.NOTIFY_SOCKET) return () => {};

  const notify = options.notify ?? runSystemdNotify;
  let stopped = false;
  let inFlight = false;
  const send = (args: string[]): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    void Promise.resolve(notify(args))
      .catch((error: unknown) => options.logger?.warn(`systemd notification failed: ${String(error)}`))
      .finally(() => { inFlight = false; });
  };

  send(['--ready', '--status=Pi Web UI ready']);
  if (!environment.WATCHDOG_USEC) return () => { stopped = true; };

  const timer = setInterval(() => send(['--watchdog']), 10_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
