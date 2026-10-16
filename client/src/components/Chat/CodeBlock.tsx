import type { ComponentProps } from 'react';
import { CodeBlock as SessionCodeBlock } from '@pi-web-ui/session-ui/CodeBlock';
import { WithClientSessionView } from './clientSessionView';

/** Moved to @pi-web-ui/session-ui (command-centre step 1a); this wrapper supplies the toast-backed copy. */
export function CodeBlock(props: ComponentProps<typeof SessionCodeBlock>) {
  return <WithClientSessionView><SessionCodeBlock {...props} /></WithClientSessionView>;
}
