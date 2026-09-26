import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDfAvailableGB } from '../../server/src/live-validation/heap-soak/disk.js';

const execFile = promisify(execFileCb);

export async function getFreeDiskGB(targetPath: string): Promise<number> {
  const { stdout } = await execFile('df', ['-Pk', targetPath]);
  return parseDfAvailableGB(stdout);
}
