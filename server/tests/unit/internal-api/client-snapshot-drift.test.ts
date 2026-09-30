import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALL_ERROR_CODES } from '../../../src/internal-api/error-codes.js';
import { INTERNAL_API_CONTRACT_VERSION } from '../../../src/internal-api/types.js';
import {
  generateSnapshot,
  type ClientContractSnapshot,
} from '../../../../scripts/generate-client-snapshot.js';

/**
 * C1 (orchestration-scaling plan): the thin parent client (`pi-orch`, a sibling
 * repo) validates its request builders and response parsers against a committed
 * contract snapshot that is DERIVED from this server's schemas and types.
 *
 * This test is the server-side half of the drift guard: if a developer changes
 * a zod-validated request schema, a response type, the error-code table or the
 * contract version without regenerating the snapshot, the committed file no
 * longer matches what the server would generate and CI fails here. The client
 * repo's own tests then validate against the (regenerated) snapshot.
 *
 * The snapshot is deliberately deterministic: no timestamps, no git metadata —
 * regeneration must be reproducible byte-for-byte so this comparison is exact.
 */

const snapshotPath = fileURLToPath(
  new URL('../../../../docs/contract/internal-api-client-snapshot.json', import.meta.url),
);

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

describe('Internal API client contract snapshot', () => {
  const committed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ClientContractSnapshot;

  it('matches what the server currently generates (regenerate if this fails)', () => {
    const generated = generateSnapshot({ repoRoot });
    expect(generated).toEqual(committed);
    // A failure above means a server schema/type changed without regenerating.
    // Fix: `npx tsx scripts/generate-client-snapshot.ts` from the repo root,
    // then review the diff and update the pi-orch client if the change is
    // client-visible.
  });

  it('is deterministic: two generations are identical', () => {
    expect(generateSnapshot({ repoRoot })).toEqual(generateSnapshot({ repoRoot }));
  });

  it('carries the current contract version', () => {
    expect(committed.contractVersion).toBe(INTERNAL_API_CONTRACT_VERSION);
  });

  it('carries the complete error-code table', () => {
    expect(committed.errorCodes).toEqual([...ALL_ERROR_CODES].sort());
  });

  it('anchors every route to a handler that exists in the route sources', () => {
    const sources = new Map<string, string>();
    for (const sourceFile of committed.source.routeFiles) {
      sources.set(sourceFile, readFileSync(`${repoRoot}${sourceFile}`, 'utf8'));
    }
    for (const [verb, route] of Object.entries(committed.routes)) {
      const source = sources.get(route.sourceFile);
      expect(source, `route ${verb} declares unknown sourceFile ${route.sourceFile}`).toBeTruthy();
      expect(
        source.includes(route.handler),
        `route ${verb} (${route.method} ${route.path}) anchors to handler ${route.handler}, which no longer exists in ${route.sourceFile} — update the route table in scripts/generate-client-snapshot.ts`,
      ).toBe(true);
    }
  });

  it('covers every route the client uses', () => {
    const required = [
      'getCapabilities',
      'getCapacity',
      'listModels',
      'createSession',
      'sendPrompt',
      'getRunReceipt',
      'registerWatch',
      'getWatch',
      'deleteWatch',
      'watchesWait',
      'sessionControl',
      'deleteSession',
      'listSessions',
      'getSessionTranscript',
      'getSessionGoal',
      'sessionGoalControl',
    ];
    expect(Object.keys(committed.routes).sort()).toEqual([...required].sort());
  });

  it('extracts every response/request type the client consumes', () => {
    const requiredTypes = [
      'ApiError',
      'CapacityResponse',
      'CapabilitiesResponse',
      'CreateSessionResponse',
      'DeleteWatchResponse',
      'DetachedPromptResponse',
      'DuplicatePromptResponse',
      'ListSessionsResponse',
      'ModelInfo',
      'ModelsResponse',
      'PromptResponse',
      'RegisterWatchRequest',
      'RunReceipt',
      'SendPromptRequest',
      'SessionControlRequest',
      'SessionControlResponse',
      'SessionDetail',
      'SessionGoalProjection',
      'SessionInfo',
      'TranscriptResponse',
      'WaitResponse',
      'WatchConditionSpec',
      'WatchFiring',
      'WatchOnFireAction',
      'WatchResponse',
      'WatchesWaitResponse',
    ];
    for (const name of requiredTypes) {
      expect(
        committed.types[name],
        `type ${name} is missing from the snapshot`,
      ).toBeTruthy();
    }
  });
});
