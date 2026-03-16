// StatusBar functionality has been absorbed into the MessageInput status strip and chat header.
// This component is kept for backward compatibility but is no longer rendered in the App layout.

interface StatusBarProps {
  onOpenSettings?: () => void;
}

export function StatusBar(_props: StatusBarProps) {
  // This component is no longer rendered. Its functionality lives in MessageInput and ChatView header.
  return null;
}
