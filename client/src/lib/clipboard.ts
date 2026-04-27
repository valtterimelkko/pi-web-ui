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
 * Fallback copy using document.execCommand — works on mobile and in
 * contexts where the Clipboard API is unavailable or requires a
 * user gesture that has already expired.
 */
function fallbackCopy(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.setAttribute('aria-hidden', 'true');
  document.body.appendChild(textarea);

  textarea.focus();
  textarea.select();

  let success = false;
  try {
    success = document.execCommand('copy');
  } catch {
    success = false;
  }

  document.body.removeChild(textarea);
  return success;
}

/**
 * Copy text to clipboard and show toast notification.
 * Tries navigator.clipboard first, falls back to execCommand for
 * broader mobile / older-browser support.
 */
export async function copyToClipboard(text: string, successMessage = 'Copied to clipboard'): Promise<boolean> {
  let success = false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      success = true;
    } catch (err) {
      console.warn('Clipboard API failed, trying fallback:', err);
    }
  }

  if (!success) {
    success = fallbackCopy(text);
  }

  if (success) {
    useUIStore.getState().addToast({
      type: 'success',
      message: successMessage,
    });
  } else {
    useUIStore.getState().addToast({
      type: 'error',
      message: 'Failed to copy to clipboard',
    });
  }

  return success;
}
