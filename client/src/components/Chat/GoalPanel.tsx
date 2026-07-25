import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useGoalStore, type GoalRecord } from '../../store/goalStore';
import { useUIStore } from '../../store/uiStore';
import { deriveGoalPhase, summarizeGoal, type GoalPhase, type GoalModel } from '../../lib/goalModel';
import { deriveGoalTag, type GoalControlAction, type RuntimeSdkType } from '../../lib/piExtensionControls';

/**
 * Goal surface for runtimes that ship a goal engine (Pi extension, OpenCode
 * server bridge). One collapsible panel replaces the previous always-open text
 * blob: a one-line header that is safe on a phone, an expandable structured
 * body, and — once the goal ends and the extension clears its widget — a
 * summary of the finished goal plus the session's earlier goals.
 *
 * Data is read-only. Controls are delegated to the caller, which routes them to
 * the runtime-appropriate path (Pi slash commands vs the OpenCode goal-control
 * message); runtimes without goal support render nothing here.
 */

interface GoalPanelProps {
  sessionId: string | null;
  sdkType: RuntimeSdkType;
  isStreaming: boolean;
  /** Latest `extension_status` text, used when no widget payload exists yet. */
  statusText: string | undefined;
  onControl: (action: GoalControlAction) => void;
}

/** Viewport at which the panel is roomy enough to start expanded (Tailwind md). */
const DESKTOP_MIN_WIDTH = 768;

function outcomeLabel(record: GoalRecord): string {
  if (record.outcome === 'achieved') return 'achieved';
  if (record.outcome === 'cleared') return 'cleared';
  return 'stopped';
}

function runsLabel(record: GoalRecord): string {
  const runs = record.outcomeRuns ?? record.model.runs;
  return `${runs} run${runs === 1 ? '' : 's'}`;
}

export function GoalPanel({ sessionId, sdkType, isStreaming, statusText, onControl }: GoalPanelProps) {
  const bySession = useGoalStore((state) => state.bySession);
  const expandedBySession = useUIStore((state) => state.goalPanelExpanded);
  const setExpanded = useUIStore((state) => state.setGoalPanelExpanded);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const view = (sessionId ? bySession[sessionId] : undefined) ?? { current: null, history: [] };
  const current = view.current;
  const lastFinished = view.history[0] ?? null;
  const earlier = view.history.slice(1);

  // Status-only fallback: a goal can be live before its first widget payload
  // arrives (and OpenCode replays status without a widget when hidden).
  const fallbackTag = deriveGoalTag(statusText, isStreaming);

  const phase: GoalPhase | null = useMemo(() => {
    if (!current) return null;
    return deriveGoalPhase({ model: current.model, isStreaming, updatedAt: current.updatedAt, now });
  }, [current, isStreaming, now]);

  // Tick only while a countdown is on screen.
  const counting = phase?.kind === 'continuing' && phase.secondsUntilContinue !== null;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting]);

  useEffect(() => {
    if (!current) setConfirmClear(false);
  }, [current]);

  const isLive = Boolean(current) || (!current && !lastFinished && fallbackTag.active);
  const detailRecord = current ?? lastFinished;
  const hasAnything = Boolean(current) || Boolean(lastFinished) || fallbackTag.active;
  const expanded = sessionId
    ? expandedBySession[sessionId] ?? (typeof window !== 'undefined' && window.innerWidth >= DESKTOP_MIN_WIDTH)
    : false;

  if (!hasAnything || !sessionId) return null;

  const paused = phase ? phase.paused : fallbackTag.paused;
  const pulsing = phase ? phase.pulsing : fallbackTag.pulsing;
  const finished = !current && Boolean(lastFinished);

  let headline: string;
  if (finished && lastFinished) {
    headline = `Last goal ${outcomeLabel(lastFinished)} · ${runsLabel(lastFinished)}`;
  } else if (phase && current) {
    const runPart = current.model.maxRuns
      ? `Run ${phase.displayRun}/${current.model.maxRuns}`
      : `Run ${phase.displayRun}`;
    headline = `Goal ${phase.label} · ${runPart}`;
  } else {
    headline = `Goal ${fallbackTag.label}${fallbackTag.run !== null ? ` · Run ${fallbackTag.run}` : ''}`;
  }

  // The headline already carries the run counter.
  const summary = current && phase ? summarizeGoal(current.model, phase, { includeRun: false }) : null;
  const controlsEnabled = isLive && Boolean(current || fallbackTag.active)
    && (sdkType === 'pi' || sdkType === 'opencode');
  const canExpand = Boolean(detailRecord);

  const toneClass = finished
    ? 'border-gray-200 bg-gray-50 text-gray-700'
    : paused
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-800';
  const dotClass = finished ? 'bg-gray-400' : paused ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="mb-2" data-testid="goal-panel">
      <div className="flex items-center gap-2 flex-wrap" data-testid="goal-tag">
        <button
          type="button"
          onClick={() => canExpand && setExpanded(sessionId, !expanded)}
          disabled={!canExpand}
          aria-expanded={expanded}
          title={canExpand ? (expanded ? 'Collapse goal details' : 'Show goal details') : undefined}
          data-testid="goal-panel-toggle"
          className={`inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass} ${canExpand ? 'hover:brightness-95' : ''}`}
        >
          <span
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotClass} ${pulsing ? 'animate-pulse' : ''}`}
            data-testid={pulsing ? 'goal-tag-pulse' : undefined}
          />
          <span className="truncate">🎯 {headline}</span>
          {summary && (
            <span className="hidden sm:inline text-[11px] font-normal opacity-80 truncate" data-testid="goal-panel-summary">
              · {summary}
            </span>
          )}
          {canExpand && (expanded
            ? <ChevronDown className="w-3 h-3 flex-shrink-0" />
            : <ChevronRight className="w-3 h-3 flex-shrink-0" />)}
        </button>

        {controlsEnabled && (
          <span className="inline-flex items-center gap-1" data-testid="goal-controls">
            {paused ? (
              <button
                type="button"
                onClick={() => onControl('resume')}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                title="Resume goal"
                data-testid="goal-resume"
              >
                ▶ Resume
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onControl('pause')}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100"
                title="Pause goal (stops the current run and halts auto-continuation)"
                data-testid="goal-pause"
              >
                ⏸ Pause
              </button>
            )}
            {confirmClear ? (
              <button
                type="button"
                onClick={() => { onControl('clear'); setConfirmClear(false); }}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-white bg-red-500 hover:bg-red-600"
                title="Confirm: clear this goal"
                data-testid="goal-clear-confirm"
              >
                Clear?
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="rounded px-1.5 py-0.5 text-xs font-medium text-gray-500 hover:bg-gray-100"
                title="Clear goal (removes it entirely)"
                data-testid="goal-clear"
              >
                ✕ Clear
              </button>
            )}
          </span>
        )}
      </div>

      {expanded && detailRecord && (
        <div
          className="mt-2 max-h-[40vh] overflow-y-auto overscroll-contain rounded-lg border border-blue-100 bg-blue-50/70 px-3 py-2 text-xs text-blue-950 shadow-sm"
          data-testid="goal-panel-body"
        >
          <GoalDetails record={detailRecord} finished={finished} />
          {finished && earlier.length > 0 && (
            <div className="mt-3 border-t border-blue-100 pt-2" data-testid="goal-history">
              <div className="font-semibold mb-1">Earlier goals in this session</div>
              <ul className="space-y-1">
                {earlier.map((record, index) => (
                  <li key={`${record.firstSeenAt}-${index}`} className="flex gap-2">
                    <span className="opacity-70 flex-shrink-0">{outcomeLabel(record)} · {runsLabel(record)}</span>
                    <span className="truncate">{record.model.objective}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="flex-shrink-0 opacity-70">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

function GoalDetails({ record, finished }: { record: GoalRecord; finished: boolean }) {
  const model: GoalModel = record.model;
  const verification = model.verification;

  return (
    <div className="space-y-1">
      <div className="font-semibold break-words">{model.objective || 'Goal'}</div>

      {model.question && (
        <div className="rounded bg-amber-100 text-amber-900 px-2 py-1">
          <span className="font-medium">Waiting on you: </span>{model.question}
        </div>
      )}

      {model.plan.length > 0 && (
        <ul className="py-1 space-y-0.5">
          {model.plan.map((item, index) => (
            <li key={index} className={item.done ? 'opacity-60' : ''}>
              {item.done ? '✓' : '☐'} {item.text}
            </li>
          ))}
        </ul>
      )}

      {model.progress && (
        <Row label={model.progress.label} value={`${model.progress.current}/${model.progress.total}`} />
      )}
      {model.reviewCycles && (
        <Row label="Review cycles" value={`${model.reviewCycles.completed}/${model.reviewCycles.required}`} />
      )}
      {verification.status && (
        <Row
          // The extension clears its widget on completion without sending a
          // final payload, so a finished goal's verification line is whatever
          // was true at the last run boundary. Say so rather than implying it
          // is the outcome (the header carries the real outcome).
          label={finished ? 'Verification (last update)' : 'Verification'}
          value={verification.command ? `${verification.status} — ${verification.command}` : verification.status}
        />
      )}
      {verification.result && <Row label="Result" value={verification.result} />}
      {model.lastRun && <Row label="Last run" value={model.lastRun} />}
      {!finished && model.continuationIntervalMs !== null && (
        <Row
          label="Continuation"
          value={`every ${Math.round(model.continuationIntervalMs / 1000)}s${model.suspicionRung ? ` (rung ${model.suspicionRung})` : ''}`}
        />
      )}
      {(model.tokensSpent !== null || model.usdSpent !== null) && (
        <Row
          label="Spend"
          value={[
            model.tokensSpent !== null
              ? `${model.tokensSpent.toLocaleString('en-US')}${model.tokenBudget ? ` / ${model.tokenBudget.toLocaleString('en-US')}` : ''} tokens`
              : null,
            model.usdSpent !== null
              ? `$${model.usdSpent.toFixed(2)}${model.usdBudget ? ` / $${model.usdBudget.toFixed(2)}` : ''}`
              : null,
          ].filter(Boolean).join(' · ')}
        />
      )}
      {model.compactions !== null && model.compactions > 0 && (
        <Row label="Compactions" value={String(model.compactions)} />
      )}
      {model.errors && model.errors.consecutive > 0 && (
        <Row label="Errors" value={`${model.errors.consecutive}${model.errors.lastMessage ? ` — ${model.errors.lastMessage}` : ''}`} />
      )}
      {model.startedAt && <Row label="Started" value={model.startedAt} />}
      {finished && record.endedAt && (
        <Row label="Ended" value={new Date(record.endedAt).toLocaleString()} />
      )}
      {model.raw.length > 0 && (
        <div className="pt-1 opacity-70">
          {model.raw.map((line, index) => <div key={index} className="break-words">{line}</div>)}
        </div>
      )}
    </div>
  );
}
