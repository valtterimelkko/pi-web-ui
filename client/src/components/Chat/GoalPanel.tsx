import type { ComponentProps } from 'react';
import { GoalPanel as SessionGoalPanel } from '@pi-web-ui/session-ui/GoalPanel';
import { useGoalStore } from '../../store/goalStore';
import { useUIStore } from '../../store/uiStore';

type GoalPanelProps = Omit<ComponentProps<typeof SessionGoalPanel>, 'goal' | 'expandedPreference' | 'onExpandedChange'>;

/** Moved to @pi-web-ui/session-ui (command-centre step 1a); this wrapper reads the goal and UI stores. */
export function GoalPanel(props: GoalPanelProps) {
  const bySession = useGoalStore((state) => state.bySession);
  const expandedBySession = useUIStore((state) => state.goalPanelExpanded);
  const setExpanded = useUIStore((state) => state.setGoalPanelExpanded);
  const { sessionId } = props;
  return (
    <SessionGoalPanel
      {...props}
      goal={sessionId ? bySession[sessionId] : undefined}
      expandedPreference={sessionId ? expandedBySession[sessionId] : undefined}
      onExpandedChange={setExpanded}
    />
  );
}
