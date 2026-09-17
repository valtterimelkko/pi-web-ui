/**
 * Adaptive operator simulator (Phase L6, plan §23; intent §14.1, §14.3, §14.5).
 *
 * The simulator is `an LLM playing me`: it is handed a persona, the current
 * beat's goal, the permissions the beat grants, and `heard` — the shadow-ASR
 * text of audio that actually *played* — and it answers with one JSON move.
 * Everything it proposes passes through the mechanical director
 * (`director.ts`) before it can be spoken; a rejected line is re-asked exactly
 * once with the reason appended, and a second consecutive rejection ends the
 * beat as `simulator-failure`.
 *
 * Two invariants make the instrument honest rather than merely convenient:
 *
 *   - **Reaction latency is segregated, never mixed in.** The simulator's model
 *     call (plus optional TTS) is stamped on its own event and flagged
 *     `excludedFromCandidateLatency`, so the scheduler can timestamp the
 *     candidate's silence and the operator's first audio frame separately
 *     (§14.5). A slow simulator must never look like a slow candidate.
 *   - **Offline runs need no network and no key.** `ScriptedSimulatorClient`
 *     replays queued replies, so the whole turn loop, the re-ask protocol and
 *     the failure attribution are testable hermetically.
 *
 * A frozen or branching beat never calls a model, so only this module spends
 * simulator tokens; and what it produces is tagged `provenance: synthetic` for
 * the rest of its life (see `buildFrozenVariant` and `cli.ts freeze`).
 */

import { sha256Bytes } from './record.js';
import type { AttemptManifest } from './record.js';
import type { LabEvent, MonotonicClock } from './scheduler.js';
import type { ScenarioBeat, VoiceScenario } from './scenario.js';
import {
  Director,
  MAX_REJECTION_RATE,
  RejectionLedger,
  formatReAsk,
  type BeatRunStatus,
  type DirectorDecision,
  type HeardSegment,
  type RejectionReason,
} from './director.js';

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

/**
 * The operator persona shipped with the lab (intent §14.5 draft, supplied
 * verbatim in the L6 task brief). A calibrated persona replaces this by
 * *version*, never by silent edit: changing it changes operator behaviour in
 * every adaptive beat and invalidates comparability with earlier attempts.
 */
export const DEFAULT_PERSONA = `You are playing the role of a busy senior software engineer in a voice conversation with
a coding agent (the "worker"). You are British, direct, informal, and you think out loud: you often
circle an instruction before landing it, you sometimes change your mind mid-sentence, and you get
impatient with being asked to confirm obvious things. You care most that your exact meaning reaches
the worker; you dislike being paraphrased, being told something was done when it was not, and being
read bookkeeping you did not ask for. You switch topics freely. You never speak markdown or paths
character by character. One to three sentences per turn. Speak as a person, not as a test.`;

/** Default simulator seat. The GLM peak-window twin is `commandcode/z-ai/glm-5.3-flash`. */
export const DEFAULT_OPERATOR_MODEL = 'commandcode/deepseek/deepseek-v4.1-flash';
export const DEFAULT_OPERATOR_THINKING = 'high';
export const DEFAULT_OPERATOR_TEMPERATURE = 0.7;
/** One ask plus exactly one re-ask (intent §14.5). */
export const MAX_PROPOSAL_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Permissions in plain words
// ---------------------------------------------------------------------------

const PERMISSION_PLAIN_WORDS: Record<string, string> = {
  'confirm:current-draft': 'confirm sending the draft the assistant just read back to you',
  'confirm:draft-proposed-in-this-beat':
    'confirm a send ONLY if the assistant has clearly proposed one and read it back to you',
  'answer:permission-request': "answer the worker's permission request",
  'card:confirm': 'tap the confirm button on the confirmation card',
  'card:cancel': 'tap the cancel button on the confirmation card',
  'card:original': 'choose to send the original wording rather than the tidied one',
  'stop-talker': 'tell the assistant to stop speaking',
  'level:verbatim': "ask for the worker's answer verbatim",
  'level:summary': "ask for a summary of the worker's answer",
  'level:headlines': "ask for headlines only of the worker's answer",
};

const NO_PERMISSION_WORDS =
  'nothing — you may only talk and ask questions; you cannot authorise anything';

/** Render a beat's `permissions` allow-list as the plain words of an instruction. */
export function renderPermissionsInPlainWords(permissions: string[]): string {
  if (permissions.length === 0) return NO_PERMISSION_WORDS;
  const rendered = permissions.map((permission) => {
    if (PERMISSION_PLAIN_WORDS[permission] !== undefined) return PERMISSION_PLAIN_WORDS[permission];
    // A suffixed grant (`answer:permission-request-1`) keeps its base meaning.
    const base = Object.keys(PERMISSION_PLAIN_WORDS).find(
      (key) => permission.startsWith(`${key}-`) || (key.endsWith('*') && permission.startsWith(key.slice(0, -1)))
    );
    if (base !== undefined) return PERMISSION_PLAIN_WORDS[base];
    return permission.replace(/[:_-]+/g, ' ');
  });
  return rendered.join('; ');
}

// ---------------------------------------------------------------------------
// Turn prompt assembly (§14.5)
// ---------------------------------------------------------------------------

export interface TurnPromptInput {
  persona?: string;
  beatGoal: string;
  permissions: string[];
  heard: HeardSegment[];
  earlierLines: string[];
}

/** One heard segment as a single line: seconds, speaker, text, `[interrupted]`. */
export function formatHeardSegment(segment: HeardSegment): string {
  const marker = segment.interrupted === true ? ' [interrupted]' : '';
  return `[${segment.atSeconds.toFixed(1)}s] ${segment.source ?? 'assistant'}: ${segment.text}${marker}`;
}

/**
 * Assemble the exact turn prompt of §14.5. The persona occupies the line the
 * template labels `<persona>` (it is a placeholder, like `<beat.goal>`), and
 * every literal section label is fixed so a prompt hash is comparable.
 */
export function assembleTurnPrompt(input: TurnPromptInput): string {
  const lines: string[] = [];
  lines.push(input.persona ?? DEFAULT_PERSONA);
  lines.push(`GOAL FOR THIS BEAT: ${input.beatGoal}`);
  lines.push(
    `YOU MAY: ${renderPermissionsInPlainWords(input.permissions)}. ` +
      'YOU MAY NOT: authorise anything else, invent facts about the worker, or claim to have seen a screen.'
  );
  lines.push('WHAT YOU HAVE HEARD SO FAR (newest last; [interrupted] marks where you cut in):');
  if (input.heard.length === 0) lines.push('(nothing yet)');
  else for (const segment of input.heard) lines.push(formatHeardSegment(segment));
  lines.push('YOUR EARLIER LINES:');
  if (input.earlierLines.length === 0) lines.push('(none)');
  else for (const line of input.earlierLines) lines.push(`- ${line}`);
  lines.push('Decide your next move. Reply ONLY with JSON:');
  lines.push(
    '{"say": "<what you say next, or null to stay silent>", "interrupt": <true if you cut in while it is talking>,'
  );
  lines.push(
    ' "waitMs": <how long to wait before speaking, 0-4000>, "beatDone": <true when the goal is met or clearly impossible>,'
  );
  lines.push(' "why": "<one sentence, for the record only>"}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Simulator transport
// ---------------------------------------------------------------------------

export interface SimulatorRequest {
  model: string;
  thinking: string;
  temperature: number;
  prompt: string;
  /** 0 = first ask; 1 = the single re-ask after a director rejection. */
  attempt: number;
}

export interface SimulatorUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}

export interface SimulatorResponse {
  text: string;
  /** Measured by the transport when it can; otherwise wall time is used. */
  latencyMs?: number;
  usage?: SimulatorUsage;
}

export type SimulatorClient = (request: SimulatorRequest) => Promise<SimulatorResponse>;

export interface ScriptedReply {
  text: string;
  latencyMs?: number;
}

/**
 * Hermetic simulator: replays queued replies and records every request, so the
 * prompt assembly, the re-ask protocol, the ledger and the latency events can
 * all be asserted offline. An exhausted script throws — a scripted run that
 * asks for an unqueued reply is a test defect, not a silent empty answer.
 */
export class ScriptedSimulatorClient {
  readonly calls: SimulatorRequest[] = [];
  private index = 0;

  constructor(private readonly replies: Array<string | ScriptedReply>) {}

  async next(request: SimulatorRequest): Promise<SimulatorResponse> {
    this.calls.push(request);
    if (this.index >= this.replies.length) {
      throw new Error(`scripted simulator exhausted after ${this.replies.length} replies`);
    }
    const reply = this.replies[this.index];
    this.index += 1;
    if (typeof reply === 'string') return { text: reply, latencyMs: 1 };
    return { text: reply.text, latencyMs: reply.latencyMs ?? 1 };
  }

  /** The client function to hand to `AdaptiveOperator`. */
  get client(): SimulatorClient {
    return (request) => this.next(request);
  }
}

/** Parse a simulator reply into a candidate object, tolerating fenced output. */
export function parseSimulatorReply(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let candidate = text.trim();
  if (candidate === '') return { ok: false, error: 'empty reply' };
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(candidate);
  if (fenced) candidate = fenced[1].trim();
  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) candidate = candidate.slice(start, end + 1);
  }
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

export const OPERATOR_SOURCE = 'operator';
export const DIRECTOR_SOURCE = 'director';

/** Kinds this module appends. Kept explicit so freeze/report can address them. */
export const OPERATOR_EVENT = {
  /** The assembled prompt (hashed, not stored verbatim). */
  TURN_PROMPT: 'operator_turn_prompt',
  /** One proposal, accepted or rejected, with its reason. */
  PROPOSAL: 'operator_proposal',
  /** A rejected proposal (same turn also emits `operator_proposal`). */
  REJECTION: 'director_rejection',
  /** A segment of audio that actually played, as shadow-ASR text. */
  HEARD: 'operator_heard',
  /** An accepted, spoken line. */
  LINE: 'operator_line',
  /** Segregated simulator reaction latency (model + TTS). */
  REACTION: 'operator_reaction_latency',
  BEAT_START: 'operator_beat_start',
  BEAT_DONE: 'operator_beat_done',
  SIMULATOR_FAILURE: 'simulator_failure',
} as const;

// ---------------------------------------------------------------------------
// Adaptive operator
// ---------------------------------------------------------------------------

export interface SpokenLine {
  text: string;
  interrupt: boolean;
  waitMs: number;
  beatDone: boolean;
  why: string;
  model: string;
  thinking: string;
  /** 1 = first ask; 2 = accepted after one director rejection. */
  proposalAttempts: number;
  /** Simulator reaction (model + TTS); never a candidate latency metric. */
  reactionLatencyMs: number;
  modelMs: number;
  ttsMs: number;
  fixture?: SyntheticFixtureRef;
}

export interface SyntheticFixtureRef {
  id: string;
  sha256?: string;
  bytes?: number;
  durationMs?: number;
}

export type TurnOutcome =
  | { kind: 'spoken'; line: SpokenLine }
  | { kind: 'silent'; waitMs: number; why: string }
  | { kind: 'beat-done'; why: string }
  | { kind: 'simulator-failure'; reason: RejectionReason; detail: string; rejections: number };

export interface AdaptiveTurnInput {
  beat: ScenarioBeat;
  heard: HeardSegment[];
  earlierLines: string[];
}

export interface SynthesisResult {
  latencyMs?: number;
  id?: string;
  sha256?: string;
  bytes?: number;
  durationMs?: number;
}

export interface AdaptiveOperatorOptions {
  director: Director;
  client: SimulatorClient;
  persona?: string;
  model?: string;
  thinking?: string;
  temperature?: number;
  log?: { append(input: {
    source: string;
    kind: string;
    id?: string;
    causedBy?: string;
    mediaOffsetMs?: number;
    payload?: Record<string, unknown>;
  }): LabEvent };
  clock?: MonotonicClock;
  /** Overridable time source in milliseconds; defaults to the clock, then `Date.now`. */
  now?: () => number;
  /** Optional TTS leg. Its latency joins the operator's reaction and stays excluded. */
  synthesise?: (text: string, beatId: string) => Promise<SynthesisResult | void>;
}

export class AdaptiveOperator {
  private readonly director: Director;
  private readonly client: SimulatorClient;
  private readonly persona: string;
  private readonly model: string;
  private readonly thinking: string;
  private readonly temperature: number;
  private readonly log?: AdaptiveOperatorOptions['log'];
  private readonly now: () => number;
  private readonly synthesise?: AdaptiveOperatorOptions['synthesise'];
  private readonly startedBeats = new Set<string>();
  private turnCounter = 0;

  constructor(options: AdaptiveOperatorOptions) {
    this.director = options.director;
    this.client = options.client;
    this.persona = options.persona ?? DEFAULT_PERSONA;
    this.model = options.model ?? DEFAULT_OPERATOR_MODEL;
    this.thinking = options.thinking ?? DEFAULT_OPERATOR_THINKING;
    this.temperature = options.temperature ?? DEFAULT_OPERATOR_TEMPERATURE;
    this.log = options.log;
    if (options.now) this.now = options.now;
    else {
      const clock = options.clock;
      this.now = clock ? () => clock.nowMs() : () => Date.now();
    }
    this.synthesise = options.synthesise;
  }

  get latencyMsSamples(): number[] {
    return this.latencies;
  }

  /** The shared rejection ledger, for the Gate 4 report. */
  get rejections(): RejectionLedger {
    return this.director.rejections;
  }

  private readonly latencies: number[] = [];

  private ensureBeatStarted(beatId: string): void {
    if (this.startedBeats.has(beatId)) return;
    this.startedBeats.add(beatId);
    this.log?.append({
      source: OPERATOR_SOURCE,
      kind: OPERATOR_EVENT.BEAT_START,
      id: `${beatId}:start`,
      payload: { beatId, model: this.model, thinking: this.thinking },
    });
  }

  private promptFor(input: AdaptiveTurnInput, reAsk: string | null): string {
    const base = assembleTurnPrompt({
      persona: this.persona,
      beatGoal: input.beat.goal ?? input.beat.utterance ?? '',
      permissions: input.beat.permissions ?? [],
      heard: input.heard,
      earlierLines: input.earlierLines,
    });
    return reAsk === null ? base : `${base}\n\n${reAsk}`;
  }

  /**
   * One operator turn: call the model, validate mechanically, re-ask once on a
   * rejection, and return the outcome. An accepted `say: null` is a silent turn
   * (or `beat-done` when the model says so) and consumes no operator turn.
   */
  async nextTurn(input: AdaptiveTurnInput): Promise<TurnOutcome> {
    this.ensureBeatStarted(input.beat.id);
    let reAsk: string | null = null;
    let rejections = 0;
    let lastReason: RejectionReason = 'json-shape';
    let lastDetail = '';

    for (let attempt = 0; attempt < MAX_PROPOSAL_ATTEMPTS; attempt += 1) {
      const prompt = this.promptFor(input, reAsk);
      this.turnCounter += 1;
      const turnId = `${input.beat.id}:turn:${this.turnCounter}`;
      this.log?.append({
        source: OPERATOR_SOURCE,
        kind: OPERATOR_EVENT.TURN_PROMPT,
        id: `${turnId}:prompt`,
        payload: {
          beatId: input.beat.id,
          attempt,
          model: this.model,
          thinking: this.thinking,
          temperature: this.temperature,
          promptSha256: sha256Bytes(Buffer.from(prompt, 'utf8')),
          heardSegments: input.heard.length,
        },
      });

      const started = this.now();
      const response = await this.client({
        model: this.model,
        thinking: this.thinking,
        temperature: this.temperature,
        prompt,
        attempt,
      });
      const modelMs = response.latencyMs ?? this.now() - started;
      const parsed = parseSimulatorReply(response.text);
      const candidateValue = parsed.ok ? parsed.value : undefined;

      const decision: DirectorDecision = this.director.validate(candidateValue, {
        beat: input.beat,
        heard: input.heard,
        earlierLines: input.earlierLines,
      });

      const proposalText =
        parsed.ok && typeof candidateValue === 'object' && candidateValue !== null && 'say' in candidateValue
          ? (candidateValue as { say?: unknown }).say
          : null;

      this.log?.append({
        source: OPERATOR_SOURCE,
        kind: OPERATOR_EVENT.PROPOSAL,
        id: `${turnId}:proposal:${attempt}`,
        payload: {
          beatId: input.beat.id,
          attempt,
          accepted: decision.ok,
          reason: decision.ok ? undefined : decision.reason,
          detail: decision.ok ? undefined : decision.detail,
          modelMs,
        },
      });

      if (decision.ok) {
        const proposal = decision.proposal;
        if (proposal.say === null) {
          const why = proposal.why;
          if (proposal.beatDone) {
            this.emitBeatDone(input.beat.id, why);
            return { kind: 'beat-done', why };
          }
          return { kind: 'silent', waitMs: proposal.waitMs, why };
        }

        const say = proposal.say.trim();
        let ttsMs = 0;
        let fixture: SyntheticFixtureRef | undefined;
        if (this.synthesise) {
          const ttsStarted = this.now();
          const result = await this.synthesise(say, input.beat.id);
          ttsMs = result?.latencyMs ?? this.now() - ttsStarted;
          const id = result?.id ?? `synthetic:${input.beat.id}:${this.turnCounter}`;
          fixture = {
            id,
            sha256: result?.sha256,
            bytes: result?.bytes,
            durationMs: result?.durationMs,
          };
        }
        const reactionLatencyMs = modelMs + ttsMs;
        this.latencies.push(reactionLatencyMs);
        const line: SpokenLine = {
          text: say,
          interrupt: proposal.interrupt,
          waitMs: proposal.waitMs,
          beatDone: proposal.beatDone,
          why: proposal.why,
          model: this.model,
          thinking: this.thinking,
          proposalAttempts: attempt + 1,
          reactionLatencyMs,
          modelMs,
          ttsMs,
          fixture,
        };
        this.log?.append({
          source: OPERATOR_SOURCE,
          kind: OPERATOR_EVENT.LINE,
          id: `${turnId}:line`,
          causedBy: `${turnId}:proposal:${attempt}`,
          payload: {
            beatId: input.beat.id,
            text: say,
            interrupt: proposal.interrupt,
            waitMs: proposal.waitMs,
            beatDone: proposal.beatDone,
            why: proposal.why,
            model: this.model,
            thinking: this.thinking,
            proposalAttempts: attempt + 1,
            fixtureId: fixture?.id,
            fixtureSha256: fixture?.sha256,
            fixtureBytes: fixture?.bytes,
            fixtureDurationMs: fixture?.durationMs,
            provenance: 'synthetic',
          },
        });
        this.log?.append({
          source: OPERATOR_SOURCE,
          kind: OPERATOR_EVENT.REACTION,
          id: `${turnId}:reaction`,
          causedBy: `${turnId}:line`,
          payload: {
            beatId: input.beat.id,
            modelMs,
            ttsMs,
            totalMs: reactionLatencyMs,
            // The whole point of this event: the simulator's own reaction time
            // must never be mixed into a candidate latency metric (§14.5).
            excludedFromCandidateLatency: true,
          },
        });
        if (proposal.beatDone) this.emitBeatDone(input.beat.id, proposal.why);
        return { kind: 'spoken', line };
      }

      rejections += 1;
      lastReason = decision.reason;
      lastDetail = decision.detail;
      this.log?.append({
        source: DIRECTOR_SOURCE,
        kind: OPERATOR_EVENT.REJECTION,
        id: `${turnId}:rejection:${attempt}`,
        payload: {
          beatId: input.beat.id,
          attempt,
          reason: decision.reason,
          detail: decision.detail,
          // A leakage rejection must not carry the offending text into the
          // trace, or the offline verifier would see a golden string.
          say: decision.reason === 'golden-truth-leakage' ? null : proposalText,
          message: decision.message,
        },
      });
      if (attempt === MAX_PROPOSAL_ATTEMPTS - 1) break;
      reAsk = formatReAsk(decision);
    }

    this.log?.append({
      source: OPERATOR_SOURCE,
      kind: OPERATOR_EVENT.SIMULATOR_FAILURE,
      id: `${input.beat.id}:simulator-failure`,
      payload: { beatId: input.beat.id, reason: lastReason, detail: lastDetail, rejections },
    });
    return { kind: 'simulator-failure', reason: lastReason, detail: lastDetail, rejections };
  }

  private emitBeatDone(beatId: string, why: string): void {
    this.log?.append({
      source: OPERATOR_SOURCE,
      kind: OPERATOR_EVENT.BEAT_DONE,
      id: `${beatId}:done`,
      payload: { beatId, why },
    });
  }
}

// ---------------------------------------------------------------------------
// Beat loop
// ---------------------------------------------------------------------------

export interface BeatPort {
  /** Speak an accepted line; resolves once the harness has taken it. */
  speak(line: SpokenLine): Promise<void>;
  /** Wait the simulator's requested gap before speaking. */
  wait(ms: number): Promise<void>;
  /** Segments played since the previous call, oldest first. */
  heard(): HeardSegment[];
}

export interface BeatRunInput {
  beat: ScenarioBeat;
  maxTurns?: number;
  earlierLines?: string[];
}

export interface BeatRun {
  beatId: string;
  status: BeatRunStatus;
  turns: number;
  lines: SpokenLine[];
  why?: string;
}

/**
 * Drive one adaptive beat to a terminal state. Every exit is one of the three
 * outcomes the report taxonomy needs: `completed`, `simulator-failure`
 * (instrument failure, excluded from candidate denominators) or
 * `budget-stopped`.
 */
export async function runAdaptiveBeat(
  operator: AdaptiveOperator,
  port: BeatPort,
  input: BeatRunInput
): Promise<BeatRun> {
  const budget = input.maxTurns ?? input.beat.maxTurns ?? Number.POSITIVE_INFINITY;
  const earlierLines = [...(input.earlierLines ?? [])];
  const lines: SpokenLine[] = [];
  let turns = 0;

  while (turns < budget) {
    const outcome = await operator.nextTurn({
      beat: input.beat,
      heard: port.heard(),
      earlierLines,
    });

    if (outcome.kind === 'simulator-failure') {
      return { beatId: input.beat.id, status: 'simulator-failure', turns, lines };
    }
    if (outcome.kind === 'beat-done') {
      return { beatId: input.beat.id, status: 'completed', turns, lines, why: outcome.why };
    }
    if (outcome.kind === 'silent') {
      await port.wait(outcome.waitMs);
      continue;
    }

    if (outcome.line.waitMs > 0) await port.wait(outcome.line.waitMs);
    await port.speak(outcome.line);
    lines.push(outcome.line);
    earlierLines.push(outcome.line.text);
    turns += 1;
    if (outcome.line.beatDone) {
      return { beatId: input.beat.id, status: 'completed', turns, lines, why: outcome.line.why };
    }
  }

  return { beatId: input.beat.id, status: 'budget-stopped', turns, lines };
}

/**
 * Gate 4 — the instrument entry gate (§14.5 rule 1).
 *
 * The adaptive simulator is the only measurement component in the lab with no
 * oracle, so before it is allowed to run adaptive beats it is driven against
 * the frozen and branching beats, where the correct next line *is* known. Two
 * numbers decide whether L6 may start: how often the simulator reproduces
 * known-good owner behaviour, and the director's rejection rate. If it cannot
 * reproduce fixed answers, adaptive mode produces noise.
 *
 * The known line is deliberately NOT handed to the model: `goal` describes the
 * intent, while `expected` stays on this side of the fence. For the same reason
 * a frozen beat's golden `utterance` is stripped from the prompt beat, so the
 * gate cannot be passed by reading the answer out of its own script.
 */

export interface EntryGateCase {
  id: string;
  /** The beat's intent — never the expected wording. */
  goal: string;
  /** The known-correct next line for this frozen/branching beat. */
  expected: string;
  /** Known-good alternatives that count as agreement too. */
  alsoAcceptable?: string[];
  /** The frozen/branching beat whose permissions and trigger apply. */
  beat: ScenarioBeat;
  /** Audio that actually played before this turn. */
  heard: HeardSegment[];
  earlierLines?: string[];
}

export interface EntryGateCaseResult {
  id: string;
  expected: string;
  spoken: string | null;
  outcome: TurnOutcome['kind'];
  /** Best agreement with `expected` or any declared alternative, 0..1. */
  agreement: number;
}

export interface EntryGateReport {
  cases: EntryGateCaseResult[];
  /** Mean agreement across the gate. */
  agreement: number;
  /** Fraction of cases reaching the agreement floor. */
  agreementRate: number;
  /** The shared director ledger's rate across the whole gate. */
  rejectionRate: number;
  rejected: number;
  totalProposals: number;
  insufficientEvidence: boolean;
  passed: boolean;
}

export interface EntryGateOptions {
  /** Per-case agreement needed to count as reproducing known behaviour. */
  agreementThreshold?: number;
  /** Fraction of cases that must reproduce it. */
  agreementFloor?: number;
  /** The pre-registered rejection ceiling (§14.5 rule 2). */
  rejectionCeiling?: number;
}

export const ENTRY_GATE_AGREEMENT_THRESHOLD = 0.6;
export const ENTRY_GATE_AGREEMENT_FLOOR = 0.8;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
}

/** Token-F1 between the known line and what the simulator said (0..1). */
export function lineAgreement(expected: string, spoken: string | null): number {
  if (spoken === null) return 0;
  const reference = new Set(words(expected));
  const hypothesis = new Set(words(spoken));
  if (reference.size === 0 && hypothesis.size === 0) return 1;
  let shared = 0;
  for (const word of hypothesis) if (reference.has(word)) shared += 1;
  const precision = hypothesis.size === 0 ? 0 : shared / hypothesis.size;
  const recall = reference.size === 0 ? 1 : shared / reference.size;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

/** Run the Gate 4 entry gate and return the two numbers the phase gate needs. */
export async function runInstrumentEntryGate(
  operator: AdaptiveOperator,
  cases: EntryGateCase[],
  options: EntryGateOptions = {}
): Promise<EntryGateReport> {
  const agreementThreshold = options.agreementThreshold ?? ENTRY_GATE_AGREEMENT_THRESHOLD;
  const agreementFloor = options.agreementFloor ?? ENTRY_GATE_AGREEMENT_FLOOR;
  const rejectionCeiling = options.rejectionCeiling ?? MAX_REJECTION_RATE;

  const results: EntryGateCaseResult[] = [];
  for (const entry of cases) {
    const promptBeat: ScenarioBeat = { ...entry.beat, goal: entry.goal, utterance: undefined };
    const outcome = await operator.nextTurn({
      beat: promptBeat,
      heard: entry.heard,
      earlierLines: entry.earlierLines ?? [],
    });
    const spoken = outcome.kind === 'spoken' ? outcome.line.text : null;
    const candidates = [entry.expected, ...(entry.alsoAcceptable ?? [])];
    const agreement = candidates.reduce((best, candidate) => Math.max(best, lineAgreement(candidate, spoken)), 0);
    results.push({ id: entry.id, expected: entry.expected, spoken, outcome: outcome.kind, agreement });
  }

  const ledger: RejectionLedger = operator.rejections;
  const agreement = results.length === 0 ? 0 : results.reduce((sum, r) => sum + r.agreement, 0) / results.length;
  const reproduced = results.filter((result) => result.agreement >= agreementThreshold).length;
  const agreementRate = results.length === 0 ? 0 : reproduced / results.length;
  const insufficientEvidence = ledger.insufficientEvidence(rejectionCeiling);

  return {
    cases: results,
    agreement,
    agreementRate,
    rejectionRate: ledger.rejectionRate,
    rejected: ledger.rejectedCount,
    totalProposals: ledger.totalProposals,
    insufficientEvidence,
    // The gate is a conjunction: reproduce known behaviour AND stay legal.
    passed: results.length > 0 && agreementRate >= agreementFloor && !insufficientEvidence,
  };
}

// ---------------------------------------------------------------------------
// Latency segregation from the record
// ---------------------------------------------------------------------------

export interface OperatorLatencySample {
  beatId?: string;
  modelMs: number;
  ttsMs: number;
  totalMs: number;
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === 'number' ? value : 0;
}

/** The simulator's own reaction samples, read back from the event log. */
export function operatorLatencyFromEvents(events: LabEvent[]): OperatorLatencySample[] {
  return events
    .filter((event) => event.kind === OPERATOR_EVENT.REACTION)
    .map((event) => ({
      beatId: typeof event.payload.beatId === 'string' ? event.payload.beatId : undefined,
      modelMs: numberField(event.payload, 'modelMs'),
      ttsMs: numberField(event.payload, 'ttsMs'),
      totalMs: numberField(event.payload, 'totalMs'),
    }));
}

/**
 * Guard assertion for a run record: every operator reaction in the trace is
 * flagged excluded from candidate latency. A missing or unflagged sample means
 * the segregation is broken and candidate latency numbers cannot be trusted.
 */
export function operatorLatencyIsSegregated(events: LabEvent[]): boolean {
  const reactions = events.filter((event) => event.kind === OPERATOR_EVENT.REACTION);
  return reactions.every((event) => event.payload.excludedFromCandidateLatency === true);
}

// ---------------------------------------------------------------------------
// Freezing discoveries (§14.5)
// ---------------------------------------------------------------------------

export interface FrozenLine {
  text: string;
  atSeconds: number;
  interrupt: boolean;
  reactionLatencyMs: number;
  why: string;
  fixture?: SyntheticFixtureRef;
}

export interface BeatEvidence {
  beatId: string;
  lines: FrozenLine[];
  heard: HeardSegment[];
  fixtures: SyntheticFixtureRef[];
}

function secondsField(tMs: number, origin: number): number {
  return Math.max(0, (tMs - origin) / 1000);
}

/**
 * Everything the record actually holds for one beat: the lines the simulator
 * spoke, the segments that played around them, and the synthetic fixtures they
 * produced. Nothing here is inferred from the model — it is read back from the
 * append-only log.
 */
export function extractBeatEvidence(events: LabEvent[], beatId: string): BeatEvidence {
  const lineEvents = events.filter(
    (event) => event.kind === OPERATOR_EVENT.LINE && event.payload.beatId === beatId
  );
  const origin = events.length > 0 ? events[0].tMs : 0;
  const lines: FrozenLine[] = [];
  const byEventId = new Map<string, FrozenLine>();
  for (const event of lineEvents) {
    const payload = event.payload;
    const fixtureId = typeof payload.fixtureId === 'string' ? payload.fixtureId : undefined;
    const fixture: SyntheticFixtureRef | undefined =
      fixtureId === undefined
        ? undefined
        : {
            id: fixtureId,
            sha256: typeof payload.fixtureSha256 === 'string' ? payload.fixtureSha256 : undefined,
            bytes: typeof payload.fixtureBytes === 'number' ? payload.fixtureBytes : undefined,
            durationMs: typeof payload.fixtureDurationMs === 'number' ? payload.fixtureDurationMs : undefined,
          };
    const line: FrozenLine = {
      text: typeof payload.text === 'string' ? payload.text : '',
      atSeconds: secondsField(event.tMs, origin),
      interrupt: payload.interrupt === true,
      reactionLatencyMs: 0,
      why: typeof payload.why === 'string' ? payload.why : '',
      fixture,
    };
    lines.push(line);
    byEventId.set(event.id, line);
  }

  // Reaction latency lives on its own event, linked to the line it belongs to.
  for (const event of events) {
    if (event.kind !== OPERATOR_EVENT.REACTION) continue;
    if (event.causedBy === undefined) continue;
    const target = byEventId.get(event.causedBy);
    if (target) target.reactionLatencyMs = numberField(event.payload, 'totalMs');
  }

  const beatEvent = (kind: string): number[] =>
    events.filter((event) => event.kind === kind && event.payload.beatId === beatId).map((event) => event.seq);
  const startSeqs = beatEvent(OPERATOR_EVENT.BEAT_START).concat(beatEvent(OPERATOR_EVENT.LINE));
  const endSeqs = beatEvent(OPERATOR_EVENT.BEAT_DONE).concat(beatEvent(OPERATOR_EVENT.SIMULATOR_FAILURE));
  // The beat's own window: from its first to its last beat-scoped event. An
  // untagged heard segment inside it belongs to this beat; one tagged for
  // another beat never does. Beats run sequentially, so this is unambiguous.
  const firstSeq = startSeqs.length > 0 ? Math.min(...startSeqs) : -1;
  const lastSeq =
    endSeqs.length > 0
      ? Math.max(...endSeqs)
      : startSeqs.length > 0
        ? Math.max(...startSeqs)
        : -1;
  const heard: HeardSegment[] = events
    .filter((event) => {
      if (event.kind !== OPERATOR_EVENT.HEARD) return false;
      if (event.payload.beatId === beatId) return true;
      if (event.payload.beatId !== undefined) return false;
      return firstSeq !== -1 && event.seq >= firstSeq && event.seq <= lastSeq;
    })
    .map((event) => ({
      index: numberField(event.payload, 'index'),
      text: typeof event.payload.text === 'string' ? event.payload.text : '',
      atSeconds: numberField(event.payload, 'atSeconds'),
      interrupted: event.payload.interrupted === true,
      source: typeof event.payload.source === 'string' ? event.payload.source : undefined,
    }));

  const fixtures: SyntheticFixtureRef[] = [];
  for (const line of lines) {
    if (line.fixture && !fixtures.some((fixture) => fixture.id === line.fixture?.id)) {
      fixtures.push(line.fixture);
    }
  }

  return { beatId, lines, heard, fixtures };
}

export interface FrozenVariantInput {
  events: LabEvent[];
  attemptId: string;
  beatId: string;
  scenario?: VoiceScenario;
  allowPromotion?: boolean;
  promotionNote?: string;
}

export interface FrozenBeat extends ScenarioBeat {
  mode: 'frozen';
  provenance: 'synthetic';
  sourceAttempt: string;
  sourceBeat: string;
  syntheticLines: FrozenLine[];
  heard: HeardSegment[];
  fixtures: SyntheticFixtureRef[];
}

export interface FrozenVariant {
  schema: 'voice-lab.scenario/1';
  id: string;
  tier: 1 | 2 | 3;
  provenance: 'synthetic';
  mode: 'frozen';
  sourceAttempt: string;
  sourceBeat: string;
  sourceScenario?: string;
  world?: string;
  persona?: string;
  language: string;
  voice: VoiceScenario['voice'];
  endpointing: 'E' | 'N';
  budgets: VoiceScenario['budgets'];
  description: string;
  beats: FrozenBeat[];
  promotion: {
    promoted: boolean;
    note?: string;
    syntheticBackboneEligible: boolean;
  };
}

export const DEFAULT_VARIANT_BUDGETS: VoiceScenario['budgets'] = {
  maxRunMs: 480000,
  maxOperatorTurns: 24,
  maxCandidateSpeechMs: 240000,
  maxSpendUsd: 0.5,
};

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Turn one beat of one attempt into a frozen regression variant.
 *
 * The variant keeps `provenance: synthetic` on both the scenario and the beat,
 * and is not eligible for the frozen backbone — the hand-authored beats that
 * carry scored conditions — unless promotion is granted explicitly *and* a
 * manifest note explains it. Without that note a future reader cannot tell
 * ground truth from the simulator's imagination (§14.5).
 */
export function buildFrozenVariant(input: FrozenVariantInput): FrozenVariant {
  const evidence = extractBeatEvidence(input.events, input.beatId);
  if (evidence.lines.length === 0) {
    throw new Error(
      `freeze found no spoken lines for beat "${input.beatId}" in attempt ${input.attemptId}: ` +
        'a frozen variant without a golden utterance would be an invalid scenario'
    );
  }
  const sourceScenario = input.scenario;
  const sourceBeat = sourceScenario?.beats.find((beat) => beat.id === input.beatId);
  const allowPromotion = input.allowPromotion === true;
  const note = input.promotionNote?.trim();

  if (allowPromotion && (note === undefined || note === '')) {
    throw new Error(
      'freeze refuses promotion into the frozen backbone without a manifest note: ' +
        'a synthetic input must be explained before it stops being synthetic (§14.5)'
    );
  }

  const scenarioId = sourceScenario?.id ?? `t1-frozen-${slug(input.attemptId)}`;
  const utterance = evidence.lines[0].text;
  const frozenBeat: FrozenBeat = {
    id: sourceBeat?.id ?? input.beatId,
    mode: 'frozen',
    utterance,
    trigger: sourceBeat?.trigger ?? { at: 'run-start', delayMs: 1500 },
    interrupt: sourceBeat?.interrupt,
    gesture: sourceBeat?.gesture,
    permissions: sourceBeat?.permissions ?? [],
    expect: sourceBeat?.expect ?? { relay: false },
    labels: sourceBeat?.labels,
    notes: sourceBeat?.notes,
    provenance: 'synthetic',
    sourceAttempt: input.attemptId,
    sourceBeat: input.beatId,
    syntheticLines: evidence.lines,
    heard: evidence.heard,
    fixtures: evidence.fixtures,
  };

  return {
    schema: 'voice-lab.scenario/1',
    id: `${scenarioId}-frozen-${slug(input.beatId)}`,
    tier: sourceScenario?.tier ?? 1,
    provenance: 'synthetic',
    mode: 'frozen',
    sourceAttempt: input.attemptId,
    sourceBeat: input.beatId,
    sourceScenario: sourceScenario?.id,
    world: sourceScenario?.world,
    persona: sourceScenario?.persona,
    language: sourceScenario?.language ?? 'en-GB',
    voice: sourceScenario?.voice ?? { engine: 'supertonic-3', voice: 'M1' },
    endpointing: sourceScenario?.endpointing ?? 'E',
    budgets: sourceScenario?.budgets ?? DEFAULT_VARIANT_BUDGETS,
    description:
      `Frozen from attempt ${input.attemptId}, beat ${input.beatId}: ` +
      `${evidence.lines.length} synthetic line(s) become a regression case. ` +
      'PROVENANCE synthetic — not part of the frozen comparison backbone.',
    beats: [frozenBeat],
    promotion: {
      promoted: allowPromotion,
      note,
      syntheticBackboneEligible: allowPromotion,
    },
  };
}

/** A manifest fragment a run record can carry alongside a written variant. */
export function freezeManifestNote(variant: FrozenVariant): Record<string, unknown> {
  return {
    kind: 'frozen-variant',
    variantId: variant.id,
    provenance: variant.provenance,
    sourceAttempt: variant.sourceAttempt,
    sourceBeat: variant.sourceBeat,
    promoted: variant.promotion.promoted,
    note: variant.promotion.note,
    syntheticBackboneEligible: variant.promotion.syntheticBackboneEligible,
  };
}

/** Narrowing helper so the CLI can read an untyped manifest without casts. */
export function manifestEventLogPath(manifest: Partial<AttemptManifest> | Record<string, unknown>): string {
  const value = (manifest as { eventLog?: unknown }).eventLog;
  return typeof value === 'string' && value !== '' ? value : 'application/events.jsonl';
}
