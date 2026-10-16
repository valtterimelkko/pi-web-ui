import { memo, type ComponentProps } from 'react';
import { MessageBubble as SessionMessageBubble } from '@pi-web-ui/session-ui/MessageBubble';
import { WithClientSessionView } from './clientSessionView';

/** Moved to @pi-web-ui/session-ui (command-centre step 1a); this wrapper supplies Pi Web UI's stores. */
export const MessageBubble = memo(function MessageBubble(props: ComponentProps<typeof SessionMessageBubble>) {
  return <WithClientSessionView><SessionMessageBubble {...props} /></WithClientSessionView>;
});
