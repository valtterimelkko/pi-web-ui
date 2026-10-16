import { forwardRef, memo, type ComponentProps } from 'react';
import {
  VirtualizedMessageList as SessionMessageList,
  type VirtualizedMessageListHandle,
} from '@pi-web-ui/session-ui/VirtualizedMessageList';
import { WithClientSessionView } from './clientSessionView';

export type { VirtualizedMessageListHandle };

/** Moved to @pi-web-ui/session-ui (command-centre step 1a); this wrapper supplies Pi Web UI's stores. */
export const VirtualizedMessageList = memo(forwardRef<
  VirtualizedMessageListHandle,
  ComponentProps<typeof SessionMessageList>
>(function VirtualizedMessageList(props, ref) {
  return <WithClientSessionView><SessionMessageList ref={ref} {...props} /></WithClientSessionView>;
}));
