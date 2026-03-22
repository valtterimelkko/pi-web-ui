/**
 * Orchestration Store - State management for parallel orchestration
 *
 * Manages orchestration state, worktrees, tasks, and sessions.
 */

import { create } from 'zustand';

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  baseBranch: string;
  sessionId?: string;
  status: 'idle' | 'running' | 'completed' | 'error' | 'merged';
  createdAt: string;
  taskDescription: string;
  commitCount: number;
  hasUncommittedChanges: boolean;
  progress?: number;
}

export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  files: string[];
  dependencies: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  agent?: string;
  parallelGroup: number;
  status: 'pending' | 'running' | 'completed' | 'error' | 'merged';
  worktreeId?: string;
  sessionId?: string;
  progress: number;
}

export interface SessionInfo {
  id: string;
  worktreeId: string;
  taskId: string;
  status: 'pending' | 'starting' | 'running' | 'completed' | 'error';
  progress: number;
  messageCount: number;
  error?: string;
  startTime?: string;
  endTime?: string;
}

export interface OrchestrationInfo {
  id: string;
  planTitle: string;
  planPath: string;
  repoPath: string;
  status: 'initializing' | 'running' | 'paused' | 'completed' | 'error';
  currentGroup: number;
  totalGroups: number;
  startTime: string;
  endTime?: string;
}

export interface OrchestrationState {
  // Active orchestration
  activeOrchestration: OrchestrationInfo | null;
  
  // Worktrees for current orchestration
  worktrees: WorktreeInfo[];
  
  // Tasks from the plan
  tasks: TaskInfo[];
  
  // Active sessions (one per worktree)
  sessions: Map<string, SessionInfo>;
  
  // Selected worktree/session for viewing
  selectedSessionId: string | null;
  
  // Merge preview state
  mergePreview: {
    worktreeId: string;
    files: Array<{
      path: string;
      additions: number;
      deletions: number;
      status: 'added' | 'modified' | 'deleted' | 'renamed';
    }>;
    hasConflicts: boolean;
  } | null;
  
  // UI state
  isLoading: boolean;
  error: string | null;
}

export interface OrchestrationActions {
  // Orchestration management
  setActiveOrchestration: (orchestration: OrchestrationInfo | null) => void;
  updateOrchestrationStatus: (status: OrchestrationInfo['status']) => void;
  
  // Worktree management
  setWorktrees: (worktrees: WorktreeInfo[]) => void;
  addWorktree: (worktree: WorktreeInfo) => void;
  updateWorktree: (id: string, updates: Partial<WorktreeInfo>) => void;
  removeWorktree: (id: string) => void;
  
  // Task management
  setTasks: (tasks: TaskInfo[]) => void;
  updateTaskStatus: (id: string, status: TaskInfo['status'], progress?: number) => void;
  
  // Session management
  addSession: (session: SessionInfo) => void;
  updateSession: (id: string, updates: Partial<SessionInfo>) => void;
  removeSession: (id: string) => void;
  
  // Selection
  setSelectedSession: (sessionId: string | null) => void;
  
  // Merge preview
  setMergePreview: (preview: OrchestrationState['mergePreview']) => void;
  clearMergePreview: () => void;
  
  // UI state
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  
  // Reset
  reset: () => void;
  
  // Computed getters
  getWorktreeBySession: (sessionId: string) => WorktreeInfo | undefined;
  getTaskByWorktree: (worktreeId: string) => TaskInfo | undefined;
  getSessionsByStatus: (status: SessionInfo['status']) => SessionInfo[];
  getSummary: () => { total: number; completed: number; running: number; error: number; pending: number };
}

const initialState: OrchestrationState = {
  activeOrchestration: null,
  worktrees: [],
  tasks: [],
  sessions: new Map(),
  selectedSessionId: null,
  mergePreview: null,
  isLoading: false,
  error: null,
};

export const useOrchestrationStore = create<OrchestrationState & OrchestrationActions>((set, get) => ({
  ...initialState,
  
  // Orchestration management
  setActiveOrchestration: (orchestration) => set({ activeOrchestration: orchestration }),
  
  updateOrchestrationStatus: (status) => set((state) => ({
    activeOrchestration: state.activeOrchestration
      ? { ...state.activeOrchestration, status }
      : null,
  })),
  
  // Worktree management
  setWorktrees: (worktrees) => set({ worktrees }),
  
  addWorktree: (worktree) => set((state) => ({
    worktrees: [...state.worktrees, worktree],
  })),
  
  updateWorktree: (id, updates) => set((state) => ({
    worktrees: state.worktrees.map((wt) =>
      wt.id === id ? { ...wt, ...updates } : wt
    ),
  })),
  
  removeWorktree: (id) => set((state) => ({
    worktrees: state.worktrees.filter((wt) => wt.id !== id),
  })),
  
  // Task management
  setTasks: (tasks) => set({ tasks }),
  
  updateTaskStatus: (id, status, progress) => set((state) => ({
    tasks: state.tasks.map((task) =>
      task.id === id ? { ...task, status, progress: progress ?? task.progress } : task
    ),
  })),
  
  // Session management
  addSession: (session) => set((state) => {
    const newSessions = new Map(state.sessions);
    newSessions.set(session.id, session);
    return { sessions: newSessions };
  }),
  
  updateSession: (id, updates) => set((state) => {
    const newSessions = new Map(state.sessions);
    const existing = newSessions.get(id);
    if (existing) {
      newSessions.set(id, { ...existing, ...updates });
    }
    return { sessions: newSessions };
  }),
  
  removeSession: (id) => set((state) => {
    const newSessions = new Map(state.sessions);
    newSessions.delete(id);
    return { sessions: newSessions };
  }),
  
  // Selection
  setSelectedSession: (sessionId) => set({ selectedSessionId: sessionId }),
  
  // Merge preview
  setMergePreview: (preview) => set({ mergePreview: preview }),
  
  clearMergePreview: () => set({ mergePreview: null }),
  
  // UI state
  setLoading: (loading) => set({ isLoading: loading }),
  
  setError: (error) => set({ error }),
  
  // Reset
  reset: () => set(initialState),
  
  // Computed getters
  getWorktreeBySession: (sessionId) => {
    const state = get();
    return state.worktrees.find((wt) => wt.sessionId === sessionId);
  },
  
  getTaskByWorktree: (worktreeId) => {
    const state = get();
    return state.tasks.find((task) => task.worktreeId === worktreeId);
  },
  
  getSessionsByStatus: (status) => {
    const state = get();
    return Array.from(state.sessions.values()).filter((s) => s.status === status);
  },
  
  getSummary: () => {
    const state = get();
    let completed = 0;
    let running = 0;
    let error = 0;
    let pending = 0;
    
    for (const session of state.sessions.values()) {
      switch (session.status) {
        case 'completed':
          completed++;
          break;
        case 'running':
        case 'starting':
          running++;
          break;
        case 'error':
          error++;
          break;
        case 'pending':
        default:
          pending++;
          break;
      }
    }
    
    return { total: state.sessions.size, completed, running, error, pending };
  },
}));

// Selector hooks for performance
export const useActiveOrchestration = () => useOrchestrationStore((s) => s.activeOrchestration);
export const useWorktrees = () => useOrchestrationStore((s) => s.worktrees);
export const useTasks = () => useOrchestrationStore((s) => s.tasks);
export const useSelectedSession = () => useOrchestrationStore((s) => s.selectedSessionId);
export const useOrchestrationSummary = () => useOrchestrationStore((s) => s.getSummary());
