import { useUIStore } from '../store';

/**
 * Extract text content from a message, removing thinking blocks
 */
export function extractMessageText(content: string | Array<{ type: string; text?: string }>): string {
  let text: string;
  
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => (part.type === 'text' ? part.text || '' : ''))
      .join('');
  } else {
    text = '';
  }
  
  // Remove thinking blocks
  return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
}

/**
 * Copy text to clipboard and show toast notification
 */
export async function copyToClipboard(text: string, successMessage = 'Copied to clipboard'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    useUIStore.getState().addToast({
      type: 'success',
      message: successMessage,
    });
    return true;
  } catch (error) {
    useUIStore.getState().addToast({
      type: 'error',
      message: 'Failed to copy to clipboard',
    });
    console.error('Failed to copy:', error);
    return false;
  }
}
