/** Free-disk-space guard: skip heap snapshots (and ping) below the threshold. */

export const MIN_FREE_DISK_GB = 20;

/** Parse `df -Pk <path>` output (POSIX format, 1024-byte blocks) into available GB. */
export function parseDfAvailableGB(dfOutput: string): number {
  const lines = dfOutput.trim().split('\n');
  if (lines.length < 2) throw new Error(`Unexpected df output (no data line): ${dfOutput}`);
  const dataLine = lines[lines.length - 1];
  const columns = dataLine.trim().split(/\s+/);
  // POSIX `-P` format: Filesystem 1024-blocks Used Available Capacity Mounted-on
  const availableKB = Number(columns[3]);
  if (!Number.isFinite(availableKB)) throw new Error(`Could not parse available blocks from df output: ${dataLine}`);
  return availableKB / (1024 * 1024);
}

export function hasEnoughFreeDisk(freeGB: number, thresholdGB: number = MIN_FREE_DISK_GB): boolean {
  return freeGB >= thresholdGB;
}
