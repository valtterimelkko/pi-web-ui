import type { Message } from '../store/sessionStore';

export function getLastAssistantText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p) => p.type === 'text')
          .map((p) => p.text);
        if (textParts.length > 0) return textParts.join('\n');
      }
    }
  }
  return null;
}
