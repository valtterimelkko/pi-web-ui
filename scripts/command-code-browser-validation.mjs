const DEFAULT_MODEL = 'qwen/qwen3.8-max';
const DEFAULT_EFFORT = 'medium';
const EXPECTED_TEXT = 'COMMAND-CODE-BROWSER-LIVE-OK';

function fail(message) {
  throw new Error(`Command Code browser evidence: ${message}`);
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`);
  return value;
}

/**
 * Assert the evidence collected from the browser-facing WebSocket path.
 * This is intentionally payload-light but proves availability metadata,
 * exact model/effort binding, lifecycle delivery, and assistant output.
 */
export function assertBrowserWebSocketEvidence(input, options = {}) {
  const model = options.model ?? DEFAULT_MODEL;
  // An explicitly supplied `effort: undefined` is meaningful for Muse: it
  // proves the non-adjustable route did not receive or emit a native effort.
  const effort = Object.hasOwn(options, 'effort') ? options.effort : DEFAULT_EFFORT;
  const expectedText = options.expectedText ?? EXPECTED_TEXT;
  const evidence = asObject(input, 'evidence');
  const availability = asObject(evidence.availability, 'availability');
  if (availability.type !== 'commandcode_available' || availability.available !== true || availability.enabled !== true) {
    fail('availability did not advertise an enabled browser runtime');
  }
  if (!Array.isArray(availability.models) || !availability.models.some((entry) => {
    const candidate = asObject(entry, 'availability model');
    if (candidate.id !== model || candidate.provider !== 'command-code') return false;
    if (effort === undefined) {
      return candidate.supportsEffort === false
        && Array.isArray(candidate.effortLevels)
        && candidate.effortLevels.length === 0
        && candidate.defaultEffort === undefined;
    }
    return candidate.effortLevels?.includes(effort) && candidate.supportsEffort === true;
  })) {
    fail(effort === undefined
      ? `availability omitted exact non-adjustable model ${model}`
      : `availability omitted exact model ${model} and native effort ${effort}`);
  }

  const created = asObject(evidence.created, 'session_created');
  // The capability hash is allowed for Muse: it identifies the discovered
  // no-effort capability, but it is not an effort value or observation.
  const nativeEffortKeys = ['effort', 'requestedEffort', 'acceptedEffort', 'defaultEffort', 'effectiveEffort', 'effortEvidenceMethod'];
  const hasNativeEffortMetadata = (value) => nativeEffortKeys.some((key) => value[key] !== undefined);
  const createdEffortIsValid = effort === undefined
    ? created.effort === undefined && created.effortSource === 'none' && !hasNativeEffortMetadata({ ...created, effortSource: undefined })
    : created.effort === effort
      && created.requestedEffort === effort
      && created.acceptedEffort === effort
      && created.effortSource === 'explicit'
      && created.defaultEffort === 'medium';
  if (created.type !== 'session_created'
    || created.sdkType !== 'commandcode'
    || created.sessionId !== created.sessionPath
    || created.model !== model
    || !createdEffortIsValid) {
    fail(effort === undefined
      ? `session creation emitted native effort for non-adjustable model ${model}`
      : `session creation did not preserve exact model/effort (${model}/${effort})`);
  }

  if (evidence.replaySession !== undefined) {
    const replaySession = asObject(evidence.replaySession, 'replayed session');
    const replayEffortIsValid = effort === undefined
      ? replaySession.effort === undefined && replaySession.effortSource === 'none' && !hasNativeEffortMetadata({ ...replaySession, effortSource: undefined })
      : replaySession.effort === effort
        && replaySession.requestedEffort === effort
        && replaySession.acceptedEffort === effort
        && replaySession.effortSource === 'explicit'
        && replaySession.defaultEffort === 'medium';
    if (replaySession.type !== 'session_switched'
      || replaySession.sessionId !== replaySession.sessionPath
      || replaySession.sdkType !== 'commandcode'
      || replaySession.model !== model
      || !replayEffortIsValid) {
      fail(effort === undefined
        ? `replay emitted native effort for non-adjustable model ${model}`
        : `replay did not preserve exact model/effort (${model}/${effort})`);
    }
  }

  if (!Array.isArray(evidence.events)) fail('lifecycle events are missing');
  const eventTypes = new Set(evidence.events.map((event) => asObject(event, 'event').type));
  for (const type of ['agent_start', 'message_update', 'message_end', 'agent_end']) {
    if (!eventTypes.has(type)) fail(`lifecycle event ${type} was not received`);
  }
  if (typeof evidence.assistantText !== 'string' || !evidence.assistantText.includes(expectedText)) {
    fail('assistant output did not contain the exact browser fixture response');
  }
  if (typeof evidence.replayAssistantText !== 'string' || !evidence.replayAssistantText.includes(expectedText)) {
    fail('replayed browser output did not contain the exact fixture response');
  }
  return true;
}

/**
 * Assert the Internal API shadow surface cannot see a browser-contained
 * session. The browser path is intentionally WebSocket-only.
 */
export function assertBrowserInternalApiIsolation(input) {
  const evidence = asObject(input, 'isolation evidence');
  const runtime = asObject(asObject(evidence.capabilities, 'capabilities').runtimes?.commandcode, 'commandcode capabilities');
  if (runtime.available !== false || runtime.enabled !== false) {
    fail('Internal API shadow runtime was not disabled in browser-fixture mode');
  }
  const models = asObject(evidence.models, 'models');
  if (asObject(models.models, 'models.models').commandcode?.length !== 0) {
    fail('Internal API model catalogue exposed browser Command Code models');
  }
  const sessions = asObject(evidence.sessions, 'sessions');
  if (!Array.isArray(sessions.sessions) || sessions.sessions.some((entry) => asObject(entry, 'session').sessionId === evidence.sessionId)) {
    fail('browser session appeared in the Internal API session list');
  }
  if (evidence.sessionInfoStatus !== 404) fail('browser session detail was not hidden from the Internal API');
  if (evidence.sessionRootStatus !== 404) fail('browser session root was not hidden from the Internal API');
  for (const [surface, status] of Object.entries(evidence.hiddenSurfaceStatuses ?? {})) {
    if (status !== 404) fail(`browser session was visible through Internal API ${surface}`);
  }
  return true;
}

export { DEFAULT_MODEL, DEFAULT_EFFORT, EXPECTED_TEXT };
