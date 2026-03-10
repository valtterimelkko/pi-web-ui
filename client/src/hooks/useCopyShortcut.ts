import { useEffect } from 'react';
import { useSessionStore } from '../store';
import { copyToClipboard, extractMessageText } from '../lib/clipboard';

/**
 * Hook to handle Ctrl+Shift+C keyboard shortcut for copying the last assistant message
 */
export function useCopyShortcut() {
  const messages = useSessionStore((state) => state.messages);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+Shift+C (or Cmd+Shift+C on Mac)
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'C') {
        event.preventDefault();
        
        // Find the last assistant message
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'assistant') {
            const text = extractMessageText(messages[i].content);
            if (text) {
              copyToClipboard(text, 'Last message copied to clipboard');
            }
            return;
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [messages]);
}
