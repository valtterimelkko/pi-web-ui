import {
  auditByteFidelity,
  auditGateLeak,
  auditWorkerStoreCoverage,
} from '/root/pi-web-ui/scripts/voice-live-lab/lib/voice-slice/slice-runner.js';
import { proposalHash } from '/root/pi-web-ui/server/src/talker/proposal-store.js';

type E = Record<string, unknown>;
const tidied = 'check the tests.';
const original = 'Tell the worker to check the tests.';
const sha = proposalHash(tidied, original);
const baseline = 'Use the bash tool to run exactly this command and wait for it to finish: sleep 45.';

const creation = (over: E = {}): E => ({
  event: 'proposal_created', proposalId: 'prop-1', version: 1, sha256: sha,
  tidiedExcerpt: tidied, tidiedChars: tidied.length, tidiedTruncated: false,
  originalExcerpt: original, originalChars: original.length, originalTruncated: false,
  ...over,
});
const authorisation = (over: E = {}): E => ({
  event: 'confirm_authorised', proposalId: 'prop-1', idempotencyKey: 'key-1',
  sha256: sha, variant: 'tidied', bytesExcerpt: tidied,
  bytesChars: tidied.length, bytesTruncated: false, ...over,
});
const delivery = (over: E = {}): E => ({
  event: 'delivery_attempt', proposalId: 'prop-1', idempotencyKey: 'key-1',
  sha256: sha, bytesExcerpt: tidied, bytesChars: tidied.length,
  bytesTruncated: false, ...over,
});
const excerptLog = (c: E = {}, a: E = {}, d: E = {}): E[] => [creation(c), authorisation(a), delivery(d)];
const legacyLog: E[] = [
  { event: 'proposal_created', proposalId: 'prop-1', version: 1, sha256: sha, tidied, original },
  { event: 'confirm_authorised', proposalId: 'prop-1', idempotencyKey: 'key-1', sha256: sha, variant: 'tidied', bytes: tidied },
  { event: 'delivery_attempt', proposalId: 'prop-1', idempotencyKey: 'key-1', sha256: sha, bytes: tidied },
];

function line(name: string, gate: boolean, fidelity: boolean, coverage: boolean, detail = '') {
  console.log(`${name}: gateLeak=${gate ? 'PASS' : 'FAIL'} byteFidelity=${fidelity ? 'PASS' : 'FAIL'} workerStoreCoverage=${coverage ? 'PASS' : 'FAIL'}${detail ? ` ${detail}` : ''}`);
}
function run(name: string, events: E[], inbox: string[], delivered: string[], allow: string[] = []) {
  const gate = auditGateLeak(events as never);
  const fidelity = auditByteFidelity(events as never, inbox);
  const coverage = auditWorkerStoreCoverage(inbox, delivered, allow);
  line(name, gate.ok, fidelity.ok, coverage.ok, `gateChecks=${gate.checks.filter((c) => !c.passed).map((c) => c.name).join('|') || 'none'}`);
}

run('NO_MATCHING_CONFIRM_AUTHORISED', [creation(), delivery()], [tidied], [tidied]);
run('DELIVERY_SHA_DOES_NOT_MATCH_KERNEL_DIGEST', excerptLog({ sha256: 'deadbeef' }, { sha256: 'deadbeef' }, { sha256: 'deadbeef' }), [tidied], [tidied]);
run('WORKER_STORE_INSTRUCTION_NEVER_DELIVERED', [], ['deploy to production.'], []);
run('WRAPPED_STORE_TEXT_CONTAINS_DELIVERY_PLUS_EXTRA_BYTES', [], [`${tidied} and also delete the logs.`], [tidied]);
run('CORRECT_EXCERPT_SHAPED_LOG', excerptLog(), [tidied], [tidied]);
run('CORRECT_LEGACY_FULL_TEXT_LOG', legacyLog, [tidied], [tidied]);

// The committed excerpt tests' deliberate honest-degradation case.
run(
  'CORRECT_TRUNCATED_EXCERPT_CHAIN',
  excerptLog(
    { tidiedExcerpt: 'check the tes', tidiedChars: tidied.length, tidiedTruncated: true },
    { bytesExcerpt: 'check the tes', bytesChars: tidied.length, bytesTruncated: true },
    { bytesExcerpt: 'check the tes', bytesChars: tidied.length, bytesTruncated: true },
  ),
  ['check the tes'], ['check the tes'],
);
