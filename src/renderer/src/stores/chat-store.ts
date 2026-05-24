/**
 * Chat interface store
 * @module stores/chat-store
 *
 * @compatibility
 * This store is maintained for backward compatibility with legacy components.
 *
 * **Recommended migration path:**
 * - For new components: Use `useSessionStore` directly
 * - For reactive message updates: Use `useChatMessages()` hook
 * - For streaming state: Use `useIsStreaming()` hook
 *
 * **Current usage:**
 * - Acts as a compatibility layer delegating to session-store
 * - Provides helper hooks for common patterns
 * - Maintains local state sync with session store
 *
 * @see session-store.ts for primary session management
 */

import { create } from 'zustand';
import type { ChatMessage, ChatState } from '@/types';
import { useSessionStore } from './session-store';
import { useProjectStore } from './project-store';

interface ChatActions {
  setInputValue: (value: string) => void;
  sendMessage: () => Promise<void>;
  loadHistory: (page: number) => Promise<void>;
  clearMessages: () => void;
  appendMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
}

/** Store state type for helper functions */
type StoreState = ChatState & ChatActions;

/**
 * Generate UUID for messages
 */
const generateId = () => crypto.randomUUID();

/**
 * Chat store
 * This is a compatibility layer that delegates to session-store
 */
export const useChatStore = create<ChatState & ChatActions>((set, get) => ({
  messages: [],
  inputValue: '',
  isLoading: false,
  isStreaming: false,

  setInputValue: (value) => {
    set({ inputValue: value });
  },

  /**
   * Send message - delegates to session store
   */
  sendMessage: async () => {
    const { inputValue, isLoading } = get();
    if (!inputValue.trim() || isLoading) return;

    const sessionStore = useSessionStore.getState();
    const projectStore = useProjectStore.getState();

    // Get active session
    const sessionId = sessionStore.activeSessionId;
    const projectId = projectStore.activeProjectId;

    if (!sessionId && projectId) {
      // Create session if needed
      const newSessionId = sessionStore.createSession(projectId);
      await sessionStore.sendMessage(newSessionId, inputValue.trim());
    } else if (sessionId) {
      await sessionStore.sendMessage(sessionId, inputValue.trim());
    }

    set({ inputValue: '' });
  },

  /**
   * Load history - delegates to session store
   */
  loadHistory: async (page) => {
    const sessionStore = useSessionStore.getState();
    const sessionId = sessionStore.activeSessionId;

    if (!sessionId) {
      console.log('[ChatStore] No active session for history loading');
      return;
    }

    await sessionStore.loadHistory(sessionId, page);
  },

  /**
   * Clear messages - resets current session
   */
  clearMessages: () => {
    const sessionStore = useSessionStore.getState();
    const sessionId = sessionStore.activeSessionId;

    if (sessionId) {
      sessionStore.resetSession(sessionId);
    }

    set({ messages: [], inputValue: '' });
  },

  /**
   * Append message to current session
   */
  appendMessage: (message) => {
    const sessionStore = useSessionStore.getState();
    const sessionId = sessionStore.activeSessionId;

    if (!sessionId) return;

    // Update local state for compatibility
    set(state => ({ messages: [...state.messages, message] }));
  },

  /**
   * Update message in current session
   */
  updateMessage: (id, updates) => {
    const sessionStore = useSessionStore.getState();
    const sessionId = sessionStore.activeSessionId;

    if (!sessionId) return;

    sessionStore.updateMessage(sessionId, id, updates);

    // Update local state for compatibility
    set(state => ({
      messages: state.messages.map(m =>
        m.id === id ? { ...m, ...updates } : m
      ),
    }));
  },
}));

/**
 * Hook to get messages from active session
 * Use this for reactive updates from session store
 */
export function useChatMessages(): ChatMessage[] {
  const sessionStore = useSessionStore();

  if (!sessionStore.activeSessionId) {
    return [];
  }

  const session = sessionStore.sessions[sessionStore.activeSessionId];
  return session?.messages ?? [];
}

/**
 * Hook to check if streaming is in progress
 */
export function useIsStreaming(): boolean {
  const sessionStore = useSessionStore();

  if (!sessionStore.activeSessionId) {
    return false;
  }

  const session = sessionStore.sessions[sessionStore.activeSessionId];
  return session?.messages.some(m => m.isStreaming) ?? false;
}
