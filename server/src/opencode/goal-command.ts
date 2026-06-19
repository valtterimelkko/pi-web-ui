/**
 * Parser for `/goal …` slash commands typed in the web UI for OpenCode
 * sessions. OpenCode (unlike Pi) does not intercept slash commands, so the web
 * UI server interprets these itself and drives the goal-engine state directly
 * instead of forwarding the text to the model.
 */

export type GoalCommand = 'pause' | 'resume' | 'clear' | 'status';

/**
 * Parse a raw prompt string into a goal command, or null if it is not a goal
 * slash command (and should be sent to the model as a normal prompt).
 *
 * Accepts both the spaced form (`/goal pause`) and the hyphenated TUI form
 * (`/goal-pause`). `/goal pause-now` and `/goal-pause-now` map to `pause`
 * (the UI pause is always immediate). A bare `/goal` shows status.
 */
export function parseGoalCommand(raw: string): GoalCommand | null {
  const text = raw.trim().toLowerCase();
  if (!text.startsWith('/goal')) return null;

  // Normalize "/goal-pause" → "goal pause", "/goal pause" → "goal pause".
  const rest = text
    .slice('/goal'.length)
    .replace(/^[-\s]+/, '')
    .trim();

  if (rest === '') return 'status';

  const verb = rest.split(/[\s-]+/)[0];
  switch (verb) {
    case 'pause':
      return 'pause';
    case 'resume':
    case 'continue':
      return 'resume';
    case 'clear':
    case 'stop':
      return 'clear';
    case 'status':
    case 'show':
      return 'status';
    default:
      return null;
  }
}
