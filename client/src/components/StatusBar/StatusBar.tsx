// StatusBar functionality has been absorbed into the MessageInput status strip and chat header.
// This component is kept for backward compatibility but is no longer rendered in the App layout.

import { useSessionStore } from '../../store';
import { exportSession } from '../../lib/api';
import { copyToClipboard, extractMessageText } from '../../lib/clipboard';
import { useState } from 'react';

interface StatusBarProps {
  onOpenSettings: () => void;
}

export function StatusBar({ onOpenSettings }: StatusBarProps) {
  // This component is no longer rendered. Its functionality lives in MessageInput and ChatView header.
  return null;
}
