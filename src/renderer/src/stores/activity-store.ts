/**
 * Activity Store
 * Tracks live activity for streaming display
 * @module stores/activity-store
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

/**
 * Activity types for progress tracking
 */
export type ActivityType =
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'command_execute'
  | 'file_edit'
  | 'file_write'
  | 'file_read'
  | 'web_search'
  | 'waiting_confirmation'
  | 'status'  // For status events like api_retry
  | 'idle';

/**
 * Activity record for progress display
 */
export interface Activity {
  /** Activity type */
  type: ActivityType;
  /** Human-readable detail text */
  detail: string;
  /** Timestamp when activity started */
  timestamp: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Activity state for a session
 */
export interface SessionActivityState {
  /** Current activity */
  current: Activity | null;
  /** Activity history (last N activities) */
  history: Activity[];
  /** Thinking start time (for timer) */
  thinkingStartTime: number | null;
}

/**
 * Global activity store state
 */
export interface ActivityState {
  /** Map of session ID to activity state */
  sessions: Record<string, SessionActivityState>;

  // Actions
  /** Start a new activity */
  startActivity: (sessionId: string, activity: Activity) => void;
  /** End current activity */
  endActivity: (sessionId: string) => void;
  /** Start thinking timer */
  startThinking: (sessionId: string) => void;
  /** End thinking timer */
  endThinking: (sessionId: string) => void;
  /** Get thinking duration in seconds */
  getThinkingDuration: (sessionId: string) => number;
  /** Clear all activities for a session */
  clearSession: (sessionId: string) => void;
  /** Get current activity detail text */
  getCurrentDetail: (sessionId: string) => string;
}

/** Maximum history size per session */
const MAX_HISTORY_SIZE = 20;

/**
 * Format thinking time: over 60s show minutes
 */
export function formatThinkingTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Create default session activity state
 */
function createDefaultSessionState(): SessionActivityState {
  return {
    current: null,
    history: [],
    thinkingStartTime: null,
  };
}

/**
 * Activity store for tracking live progress
 */
export const useActivityStore = create<ActivityState>((set, get) => ({
  sessions: {},

  startActivity: (sessionId, activity) => {
    set(state => {
      const sessionState = state.sessions[sessionId] || createDefaultSessionState();
      const newHistory = [activity, ...sessionState.history].slice(0, MAX_HISTORY_SIZE);

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...sessionState,
            current: activity,
            history: newHistory,
          },
        },
      };
    });
  },

  endActivity: sessionId => {
    set(state => {
      const sessionState = state.sessions[sessionId];
      if (!sessionState) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...sessionState,
            current: null,
          },
        },
      };
    });
  },

  startThinking: sessionId => {
    set(state => {
      const sessionState = state.sessions[sessionId] || createDefaultSessionState();

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...sessionState,
            thinkingStartTime: Date.now(),
            current: {
              type: 'thinking',
              detail: '正在思考...',
              timestamp: Date.now(),
            },
          },
        },
      };
    });
  },

  endThinking: sessionId => {
    set(state => {
      const sessionState = state.sessions[sessionId];
      if (!sessionState) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...sessionState,
            thinkingStartTime: null,
            current: null,
          },
        },
      };
    });
  },

  getThinkingDuration: sessionId => {
    const state = get();
    const sessionState = state.sessions[sessionId];
    if (!sessionState?.thinkingStartTime) return 0;
    return Math.floor((Date.now() - sessionState.thinkingStartTime) / 1000);
  },

  clearSession: sessionId => {
    set(state => {
      const { [sessionId]: _, ...remaining } = state.sessions;
      return { sessions: remaining };
    });
  },

  getCurrentDetail: sessionId => {
    const state = get();
    const sessionState = state.sessions[sessionId];
    if (!sessionState?.current) return '';
    return sessionState.current.detail;
  },
}));

/**
 * Hook to get thinking duration with auto-update
 */
export function useThinkingDuration(sessionId: string): number {
  const thinkingStartTime = useActivityStore(
    useShallow(state => state.sessions[sessionId]?.thinkingStartTime)
  );

  // This will be updated by the component using setInterval
  return thinkingStartTime ? Math.floor((Date.now() - thinkingStartTime) / 1000) : 0;
}

/**
 * Hook to get current activity detail
 */
export function useCurrentActivity(sessionId: string): Activity | null {
  return useActivityStore(
    useShallow(state => state.sessions[sessionId]?.current || null)
  );
}

/**
 * Optimized selector for activity data
 * Returns stable reference when data hasn't changed
 */
export function useSessionActivity(sessionId: string): {
  current: Activity | null;
  thinkingStartTime: number | null;
} {
  return useActivityStore(
    useShallow(state => ({
      current: state.sessions[sessionId]?.current || null,
      thinkingStartTime: state.sessions[sessionId]?.thinkingStartTime || null,
    }))
  );
}
