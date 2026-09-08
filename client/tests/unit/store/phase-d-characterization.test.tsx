import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiler, type ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Sidebar } from '../../../src/components/Sidebar/Sidebar';
import { NewSessionModal } from '../../../src/components/Session/NewSessionModal';
import { FilesTab } from '../../../src/components/Files/FilesTab';
import { useSessionStore } from '../../../src/store/sessionStore';
import { useUIStore } from '../../../src/store/uiStore';
import { useChatStore } from '../../../src/store/chatStore';
import { useFilesStore } from '../../../src/store/filesStore';

vi.mock('../../../src/hooks/useWebSocket', () => ({ useWebSocket: () => ({ createNewSession: vi.fn(), getSessions: vi.fn(), sendMessage: vi.fn() }) }));
vi.mock('../../../src/lib/api', () => ({ api: { get: vi.fn(async (path: string) => path.startsWith('/api/models')
  ? { models: [{ id: 'fixture', name: 'Fixture', provider: 'fixture', thinkingLevels: ['off'] }] }
  : { path: '/fixture', parent: null, items: [] }) } }));

const initial = {
  session: useSessionStore.getState(), ui: useUIStore.getState(),
  chat: useChatStore.getState(), files: useFilesStore.getState(),
};
beforeEach(() => {
  useSessionStore.setState({ ...initial.session, sessions: [], currentSessionId: null });
  useUIStore.setState({ ...initial.ui, recentFolders: [] });
  useChatStore.setState({ ...initial.chat, sidebarOpen: false });
  useFilesStore.setState({ ...initial.files, navigate: vi.fn(async () => {}), items: [], error: null });
});
afterEach(() => {
  cleanup();
  useSessionStore.setState(initial.session, true);
  useUIStore.setState(initial.ui, true);
  useChatStore.setState(initial.chat, true);
  useFilesStore.setState(initial.files, true);
});

// Deliberately no StrictMode. Measure actual target subtree commits after mount
// effects settle, not synthetic stand-ins or source-spelling checks. Relevant
// updates must also change visible output, so an inert target cannot pass.
async function mount(target: ReactNode) {
  const commits = vi.fn();
  await act(async () => { render(<Profiler id="real-target" onRender={commits}>{target}</Profiler>); });
  return commits;
}

describe('real component narrow-selector behaviour', () => {
  it('Sidebar ignores unrelated chat/UI state and visibly responds to sidebar state', async () => {
    const commits = await mount(<Sidebar />);
    expect(screen.getByTitle('Open sidebar')).toBeInTheDocument();
    const before = commits.mock.calls.length;
    act(() => {
      useChatStore.setState({ inputValue: 'unrelated draft' });
      useUIStore.setState({ settingsOpen: !useUIStore.getState().settingsOpen });
    });
    expect(commits).toHaveBeenCalledTimes(before);
    act(() => { useChatStore.setState({ sidebarOpen: true }); });
    expect(screen.getByTestId('session-sidebar')).toBeInTheDocument();
    expect(commits.mock.calls.length).toBeGreaterThan(before);
  });
  it('NewSessionModal ignores unrelated UI state and renders a changed recent folder', async () => {
    const commits = await mount(<NewSessionModal isOpen onClose={vi.fn()} onCreateSession={vi.fn()} />);
    const before = commits.mock.calls.length;
    act(() => { useUIStore.setState({ settingsOpen: !useUIStore.getState().settingsOpen }); });
    expect(commits).toHaveBeenCalledTimes(before);
    act(() => { useUIStore.setState({ recentFolders: [{ path: '/fixture/related-folder', label: 'Related folder', count: 1, lastUsed: Date.now() }] }); });
    expect(screen.getByText('Related folder')).toBeInTheDocument();
    expect(commits.mock.calls.length).toBeGreaterThan(before);
  });
  it('FilesTab ignores an unused store action and renders a changed error', async () => {
    const commits = await mount(<FilesTab />);
    const before = commits.mock.calls.length;
    act(() => { useFilesStore.setState({ setCurrentPath: vi.fn() }); });
    expect(commits).toHaveBeenCalledTimes(before);
    act(() => { useFilesStore.setState({ error: 'Related fixture error' }); });
    expect(screen.getByText('Related fixture error')).toBeInTheDocument();
    expect(commits.mock.calls.length).toBeGreaterThan(before);
  });
});
