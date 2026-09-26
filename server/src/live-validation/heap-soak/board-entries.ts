export interface BoardEntryLike {
  id?: unknown;
  scope?: { repos?: unknown };
}

/** Filter already-parsed `agent-os board who --json` entries to those whose scope.repos references a run dir. */
export function filterBoardEntriesForRunDir(entries: readonly BoardEntryLike[], runDir: string): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    const repos = entry.scope?.repos;
    if (Array.isArray(repos) && repos.some((r) => typeof r === 'string' && r.includes(runDir))) {
      ids.push(typeof entry.id === 'string' ? entry.id : '(unknown id)');
    }
  }
  return ids;
}
