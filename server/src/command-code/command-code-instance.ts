import type { CommandCodeService } from './command-code-service.js';

let service: CommandCodeService | undefined;

/** Install the process-owned Command Code service for browser/API projections. */
export function setCommandCodeService(next: CommandCodeService): void {
  service = next;
}

export function getCommandCodeService(): CommandCodeService | undefined {
  return service;
}
