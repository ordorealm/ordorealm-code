/**
 * Chat Panel Component
 * Main chat interface with message list, input, and history loading
 * Refactored to follow SpectrAI architecture pattern
 * @module components/chat/ChatPanel
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useSessionStore } from '@/stores/session-store';
import { useActivityStore } from '@/stores/activity-store';
import { useProjectStore } from '@/stores/project-store';
import { ChatMessage } from './ChatMessage';
import { ToolOperationGroup } from './ToolOperationGroup';
import { ChatInput, type ChatInputRef } from './ChatInput';
import { StreamingIndicator } from './StreamingIndicator';
import { SessionToolbar } from './SessionToolbar';
import { PermissionPanel } from './PermissionPanel';
import { AskUserQuestionPanel } from './AskUserQuestionPanel';
import { PlanApprovalPanel } from './PlanApprovalPanel';
import { MessageFileChanges } from './MessageFileChanges';
import { groupMessages, isToolOperationGroup } from '@/utils/messageGrouping';
import { isGroupActive } from '@/utils/isGroupActive';
import type { GroupedMessage } from '@/utils/messageGrouping';
import type { Message } from '@/types';
import type { ChatMessage as ChatMessageType } from '@/types';

/**
 * Throttle function to limit execution rate
 * @param fn Function to throttle
 * @param delay Minimum delay between calls in ms
 * @returns Throttled function
 */
function throttle<T extends (...args: unknown[]) => unknown>(fn: T, delay: number): T {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return ((...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;

    if (timeSinceLastCall >= delay) {
      lastCall = now;
      fn(...args);
    } else if (!timeoutId) {
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        timeoutId = null;
        fn(...args);
      }, delay - timeSinceLastCall);
    }
  }) as T;
}

/** Scroll threshold for considering user at bottom (in pixels) */
const SCROLL_BOTTOM_THRESHOLD = 100;

/** Throttle delay for scroll handler in ms */
const SCROLL_THROTTLE_DELAY = 200;

/**
 * Get active session for current project
 * Ensures activeSessionId is set when a session is found
 * ★ Fix: Always prioritize finding session by project ID to ensure session-project alignment
 * ★ Priority: project.activeSessionId > projectSessionIndex > createSession
 */
function useActiveSession() {
  const { sessions, activeSessionId, createSession, getSessionByProjectId, setActiveSession, switchToSession } = useSessionStore();
  const { activeProjectId, projects } = useProjectStore();

  // ★ Fix: Always look up session by current project first (most reliable)
  // This ensures session-project alignment even when activeSessionId points to a different project
  // Note: getSessionByProjectId now handles index miss with direct search fallback
  let session = null;

  // ★ Priority 1: Use project's saved activeSessionId
  if (activeProjectId) {
    const project = projects.find(p => p.id === activeProjectId);
    if (project?.activeSessionId) {
      // Check if session exists in memory or on disk
      session = sessions[project.activeSessionId];
      if (!session) {
        // Session not in memory, will be loaded by switchToSession
        // Trigger async load
        queueMicrotask(() => {
          switchToSession(project.activeSessionId!).catch(err => {
            console.warn('[useActiveSession] Failed to load saved session:', err);
          });
        });
      }
    }
  }

  // ★ Priority 2: Look up session by current project ID via index
  if (!session && activeProjectId) {
    session = getSessionByProjectId(activeProjectId);
  }

  // Fallback: use activeSessionId only if it belongs to the current project
  // This handles edge cases where session exists but getSessionByProjectId returns null
  if (!session && activeSessionId) {
    const activeSession = sessions[activeSessionId];
    // Validate: only use if session belongs to current project
    if (activeSession && activeSession.projectId === activeProjectId) {
      session = activeSession;
    }
  }

  // Debug log (reduce frequency - only log when state changes)
  const sessionKey = session?.id || 'null';
  const logKey = `${activeProjectId}-${sessionKey}`;

  // Only log if this is a different state than last time
  if (typeof window !== 'undefined') {
    const lastLogKey = (window as unknown as { __lastSessionLogKey?: string }).__lastSessionLogKey;
    if (logKey !== lastLogKey) {
      console.log('[useActiveSession] State:', {
        activeProjectId,
        activeSessionId,
        foundSessionId: session?.id,
        foundSessionProjectId: session?.projectId,
        sessionsCount: Object.keys(sessions).length,
        isStreaming: session?.messages.some(m => m.isStreaming),
      });
      (window as unknown as { __lastSessionLogKey?: string }).__lastSessionLogKey = logKey;
    }
  }

  // If we found a session but activeSessionId is not set or mismatched, set it
  // This ensures the session is properly tracked as active
  if (session && activeSessionId !== session.id) {
    // Use a microtask to avoid setState during render
    queueMicrotask(() => {
      setActiveSession(session!.id);
    });
  }

  return { session, createSession, activeProjectId };
}

/**
 * ChatPanel component
 * Full chat interface with message list and input
 */
export function ChatPanel({ onSwitchToFileTab }: { onSwitchToFileTab?: () => void } = {}): JSX.Element {
  const { session, createSession, activeProjectId } = useActiveSession();
  const {
    sendMessage,
    loadHistory,
    closeSession,
    respondToPermission,
    respondToQuestion,
    respondToApproval,
    clearInteractivePanel,
    prependMessages,
    updateInputDraft,
  } = useSessionStore();
  const sessionId = session?.id;

  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  // Track if user has scrolled up (away from bottom)
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  // Track if sending message (for input loading state)
  const [isSending, setIsSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isLoadingHistoryRef = useRef(false);
  const chatInputRef = useRef<ChatInputRef>(null);
  // ★ Fix: Flag to prevent auto-scroll when loading history
  const isRestoringScrollRef = useRef(false);
  // ★ Fix: Throttle streaming scroll to avoid flickering
  const streamingScrollThrottleRef = useRef<number>(0);
  const STREAMING_SCROLL_THROTTLE = 100; // ms

  // ★ Fix: Reset isSending when session changes (switching projects)
  const prevSessionIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevSessionIdRef.current !== undefined && prevSessionIdRef.current !== sessionId) {
      console.log('[ChatPanel] Session changed, resetting isSending:', {
        prevSessionId: prevSessionIdRef.current,
        newSessionId: sessionId,
      });
      setIsSending(false);
    }
    prevSessionIdRef.current = sessionId;
  }, [sessionId]);

  /**
   * Check if user is scrolled to bottom
   */
  const isScrolledToBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;

    const { scrollTop, scrollHeight, clientHeight } = container;
    // Consider "at bottom" if within threshold
    return scrollHeight - scrollTop - clientHeight < SCROLL_BOTTOM_THRESHOLD;
  }, []);

  // Scroll to bottom on new messages (respects user scroll position)
  const scrollToBottom = useCallback(() => {
    // Only auto-scroll if user hasn't scrolled up
    if (!isUserScrolledUp) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isUserScrolledUp]);

  // ★ Fix: Scroll to bottom on session initialization or switch
  useEffect(() => {
    if (session?.messages.length && session.messages.length > 0) {
      // Use setTimeout to ensure DOM is rendered
      const timer = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [sessionId]); // Only trigger on session change

  // Auto-scroll when new messages arrive (only if user hasn't scrolled up)
  useEffect(() => {
    // ★ Fix: Skip auto-scroll when restoring scroll position (loading history)
    if (isRestoringScrollRef.current) {
      isRestoringScrollRef.current = false;
      return;
    }

    if (session?.messages.length) {
      const lastMessage = session.messages[session.messages.length - 1];

      // Always scroll when user sends a new message
      if (lastMessage.role === 'user') {
        setIsUserScrolledUp(false);
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [session?.messages.length, isUserScrolledUp]);

  // ★ Fix: Throttled auto-scroll during streaming (avoids flickering)
  // Uses 'auto' behavior for instant scroll without animation
  useEffect(() => {
    if (!session?.messages.length || isUserScrolledUp) return;

    const lastMessage = session.messages[session.messages.length - 1];
    if (lastMessage.isStreaming) {
      const now = Date.now();
      // Throttle: only scroll every 100ms
      if (now - streamingScrollThrottleRef.current >= STREAMING_SCROLL_THROTTLE) {
        streamingScrollThrottleRef.current = now;
        // Use instant scroll (no animation) during streaming to avoid flickering
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    }
  }, [session?.messages, isUserScrolledUp]);

  // Initialize session if not exists (only after store initialization)
  useEffect(() => {
    if (activeProjectId && !session && useSessionStore.getState().isInitialized()) {
      createSession(activeProjectId);
    }
  }, [activeProjectId, session, createSession]);

  // ★ Fix: Reset history state when session changes
  useEffect(() => {
    setHasMoreHistory(true);
    setIsLoadingHistory(false);
    isLoadingHistoryRef.current = false;
  }, [sessionId]);

  /**
   * Handle send message
   */
  const handleSend = useCallback(
    async (content: string) => {
      if (!session) return;

      setIsSending(true);
      // Reset scroll state when sending
      setIsUserScrolledUp(false);

      try {
        await sendMessage(session.id, content);
      } finally {
        setIsSending(false);
      }
    },
    [session, sendMessage]
  );

  /**
   * Handle abort streaming
   * 发送中断请求后，主动重置前端状态作为保险
   */
  const handleAbort = useCallback(async () => {
    if (!sessionId) return;

    // ★ 先记录当前 streaming 的消息 ID，防止竞态条件
    const session = useSessionStore.getState().sessions[sessionId];
    const streamingMsgId = session?.messages.find(m => m.role === 'assistant' && m.isStreaming)?.id;

    if (!streamingMsgId) {
      console.log('[ChatPanel] No streaming message to abort');
      return;
    }

    try {
      await window.api.claude.abort(sessionId);
      // ★ 同时中止控制器引擎，停止 Agent 结果监听和超时定时器
      await window.api.controller.abort(sessionId);
    } catch (err) {
      console.error('[ChatPanel] Failed to abort:', err);
    }

    // ★ 再次检查，确保只更新之前记录的消息 ID
    // 这样即使期间创建了新消息，也不会被错误更新
    const currentSession = useSessionStore.getState().sessions[sessionId];
    if (currentSession) {
      // 只更新之前记录的消息
      const msg = currentSession.messages.find(m => m.id === streamingMsgId);
      if (msg && msg.isStreaming) {
        useSessionStore.getState().updateMessage(sessionId, streamingMsgId, {
          isStreaming: false,
          content: msg.content || '⚠️ 已中断',
        });
      }

      // ★ 为所有没有 tool_result 的 tool_use 添加中断标记
      const toolUseIds = new Set<string>();
      const toolResultIds = new Set<string>();

      currentSession.messages.forEach(m => {
        if (m.role === 'tool_use' && m.toolUseId) {
          toolUseIds.add(m.toolUseId);
        }
        if (m.role === 'tool_result' && m.toolUseId) {
          toolResultIds.add(m.toolUseId);
        }
      });

      const pendingToolUseIds = [...toolUseIds].filter(id => !toolResultIds.has(id));

      if (pendingToolUseIds.length > 0) {
        console.log('[ChatPanel] Adding abort tool_result for pending tools:', pendingToolUseIds);

        const abortResults = pendingToolUseIds.map(toolUseId => {
          const toolUseMsg = currentSession.messages.find(m => m.toolUseId === toolUseId);
          return {
            id: uuidv4(),
            role: 'tool_result' as const,
            content: '⚠️ 操作已中断',
            timestamp: new Date().toISOString(),
            sessionId,
            toolUseId,
            toolName: toolUseMsg?.toolName || 'unknown',
            toolResult: '⚠️ 操作已中断',
            isError: true,
          };
        });

        useSessionStore.getState().prependMessages(sessionId, abortResults);
      }

      useActivityStore.getState().endThinking(sessionId);
      useActivityStore.getState().endActivity(sessionId);
    }
  }, [sessionId]);

  /**
   * Handle skill command insertion
   * Inserts the slash command into the input field
   */
  const handleSkillInsert = useCallback((command: string) => {
    chatInputRef.current?.insertText(command);
  }, []);

  /**
   * Handle draft change - save input draft when switching sessions/tabs
   */
  const handleDraftChange = useCallback((draft: string) => {
    if (sessionId) {
      updateInputDraft(sessionId, draft);
    }
  }, [sessionId, updateInputDraft]);

  /**
   * Handle permission response
   */
  const handlePermissionResponse = useCallback(async (allowed: boolean) => {
    if (!sessionId) return;
    await respondToPermission(sessionId, allowed);
  }, [sessionId, respondToPermission]);

  /**
   * Handle question submission
   */
  const handleQuestionSubmit = useCallback(async (answers: Record<string, string>) => {
    if (!sessionId) return;
    await respondToQuestion(sessionId, answers);
  }, [sessionId, respondToQuestion]);

  /**
   * Handle plan approval response
   */
  const handleApprovalResponse = useCallback(async (approved: boolean) => {
    if (!sessionId) return;
    await respondToApproval(sessionId, approved);
  }, [sessionId, respondToApproval]);

  /**
   * Handle scroll events:
   * 1. Load more history when scrolled to top
   * 2. Track if user has scrolled up (to pause auto-scroll)
   */
  const handleScrollBase = useCallback(async () => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // Update user scroll state
    const atBottom = isScrolledToBottom();
    setIsUserScrolledUp(!atBottom);

    // Load history if scrolled to top
    if (isLoadingHistoryRef.current || !hasMoreHistory || !session) return;

    if (container.scrollTop < 50) {
      isLoadingHistoryRef.current = true;
      setIsLoadingHistory(true);

      // ★ Save current scroll position for restoration after loading
      const oldScrollHeight = container.scrollHeight;

      try {
        // loadHistory always returns the next batch of older messages
        const newMessages = await loadHistory(session.id, 1);

        // If no more messages, mark as no more history
        if (newMessages.length === 0) {
          setHasMoreHistory(false);
        }

        // Add loaded messages to session
        if (newMessages.length > 0) {
          // Set flag to prevent auto-scroll from interfering
          isRestoringScrollRef.current = true;
          prependMessages(session.id, newMessages);

          // Restore scroll position to prevent jump
          // Use double requestAnimationFrame to ensure DOM is updated
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (messagesContainerRef.current) {
                const newScrollHeight = messagesContainerRef.current.scrollHeight;
                messagesContainerRef.current.scrollTop = newScrollHeight - oldScrollHeight;
              }
            });
          });
        }
      } catch (error) {
        console.error('Failed to load history:', error);
      } finally {
        setIsLoadingHistory(false);
        isLoadingHistoryRef.current = false;
      }
    }
  }, [hasMoreHistory, loadHistory, session, isScrolledToBottom, prependMessages]);

  // Store latest callback in ref to avoid recreating throttle function
  const handleScrollBaseRef = useRef(handleScrollBase);
  handleScrollBaseRef.current = handleScrollBase;

  // Stable throttled scroll handler - created once, maintains throttling state
  const handleScrollRef = useRef<(() => void) | null>(null);
  if (!handleScrollRef.current) {
    handleScrollRef.current = throttle(() => handleScrollBaseRef.current(), SCROLL_THROTTLE_DELAY);
  }
  const handleScroll = handleScrollRef.current;

  /**
   * Check if streaming is in progress
   */
  const isStreaming = session?.messages.some(m => m.isStreaming) ?? false;

  /**
   * Combined loading state for ChatInput
   */
  const isLoading = isSending;

  // Debug log for input state
  useEffect(() => {
    console.log('[ChatPanel] Input state:', {
      sessionId: sessionId?.substring(0, 8),
      isSending,
      isStreaming,
      isLoading,
      messagesCount: session?.messages.length,
    });
  }, [sessionId, isSending, isStreaming, isLoading, session?.messages.length]);

  // Render empty state
  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-bg-secondary">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 flex items-center justify-center bg-bg-tertiary rounded-full">
            <span className="text-3xl">💬</span>
          </div>
          <p className="text-text-secondary mb-1">开始对话</p>
          <p className="text-sm text-text-muted">选择或创建一个项目开始与 Agent 对话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-bg-primary min-h-0 overflow-hidden">
      {/* Messages container */}
      <div
        ref={messagesContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 space-y-2 min-h-0"
      >
        {/* History loading indicator */}
        {isLoadingHistory && (
          <div className="flex items-center justify-center py-4">
            <svg className="w-5 h-5 animate-spin text-text-muted" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <span className="ml-2 text-sm text-text-muted">加载历史消息...</span>
          </div>
        )}

        {/* Load more button (alternative to scroll) */}
        {hasMoreHistory && session.messages.length > 0 && !isLoadingHistory && (
          <button
            onClick={handleScroll}
            className="w-full py-2 text-sm text-accent-indigo hover:text-accent-indigo/80 hover:underline"
          >
            ↑ 加载更早的消息
          </button>
        )}

        {/* Connection notice banner */}
        {session.connectionNotice && (
          <div className="flex items-center justify-center gap-2 py-2 px-4 bg-accent-green/10 border border-accent-green/30 rounded-lg text-sm text-accent-green animate-in fade-in slide-in-from-top-2 duration-300">
            <span>🔗</span>
            <span>{session.connectionNotice}</span>
          </div>
        )}

        {/* Empty state */}
        {session.messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-16 h-16 mb-4 flex items-center justify-center bg-bg-tertiary rounded-full">
              <span className="text-3xl">🤖</span>
            </div>
            <p className="text-text-primary font-medium mb-1">开始与 Agent 对话</p>
            <p className="text-sm text-text-muted">
              输入你的开发需求，Agent 将帮助你完成任务
            </p>
          </div>
        )}

        {/* Message list */}
        {(() => {
          const groupedMessages = groupMessages(session.messages as ChatMessageType[]);
          return groupedMessages.map((item, index) => (
            <GroupedMessageItem
              key={`${item.id}-${index}`}
              item={item}
              messages={groupedMessages}
              index={index}
              onSwitchToFileTab={onSwitchToFileTab}
            />
          ));
        })()}

        {/* Interactive panels */}
        {session.interactivePanel?.pendingPermission && (
          <PermissionPanel
            message={session.interactivePanel.pendingPermission.message}
            onAllow={() => handlePermissionResponse(true)}
            onDeny={() => handlePermissionResponse(false)}
            disabled={isStreaming && !session.interactivePanel?.pendingPermission}
          />
        )}
        {session.interactivePanel?.pendingQuestion && (
          <AskUserQuestionPanel
            questions={session.interactivePanel.pendingQuestion.questions}
            onSubmit={handleQuestionSubmit}
            disabled={isStreaming && !session.interactivePanel?.pendingQuestion}
          />
        )}
        {session.interactivePanel?.pendingApproval && (
          <PlanApprovalPanel
            toolInput={session.interactivePanel.pendingApproval.planContent as Record<string, unknown>}
            onApprove={() => handleApprovalResponse(true)}
            onReject={() => handleApprovalResponse(false)}
            disabled={isStreaming && !session.interactivePanel?.pendingApproval}
          />
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      {/* Streaming indicator */}
      {isStreaming && sessionId && (
        <StreamingIndicator
          sessionId={sessionId}
          isStreaming={isStreaming}
          onAbort={handleAbort}
        />
      )}

      {/* Session toolbar with skills and MCP status */}
      {sessionId && (
        <SessionToolbar
          sessionId={sessionId}
          onSkillClick={handleSkillInsert}
        />
      )}

      <ChatInput
        ref={chatInputRef}
        isLoading={isLoading}
        isStreaming={isStreaming}
        onSend={handleSend}
        placeholder="输入消息..."
        sessionId={sessionId}
        draft={session?.inputDraft}
        onDraftChange={handleDraftChange}
      />
    </div>
  );
}

/**
 * Grouped message item - handles both regular messages and tool operation groups
 * Following SpectrAI architecture: tool_use/tool_result are grouped separately
 * Uses position-based active state detection
 */
function GroupedMessageItem({
  item,
  messages,
  index,
  onSwitchToFileTab
}: {
  item: GroupedMessage;
  messages: GroupedMessage[];
  index: number;
  onSwitchToFileTab?: () => void;
}): JSX.Element {
  if (isToolOperationGroup(item)) {
    // Use position-based active detection (SpectrAI architecture)
    const isActive = isGroupActive(item, messages, index);

    // ★ 方案 B 改进：直接从 toolCalls 中提取文件修改
    const fileChanges: Array<{ path: string; type: 'created' | 'modified' | 'deleted' }> = [];
    for (const tc of item.toolCalls) {
      if (tc.input?.file_path && tc.status === 'completed') {
        const filePath = String(tc.input.file_path);
        if (tc.name === 'Write' || tc.name === 'write_file') {
          fileChanges.push({ path: filePath, type: 'created' });
        } else if (tc.name === 'Edit' || tc.name === 'replace' || tc.name === 'multi_edit') {
          fileChanges.push({ path: filePath, type: 'modified' });
        }
      }
    }

    // 去重
    const uniqueFileChanges = fileChanges.filter((f, i, arr) =>
      arr.findIndex(x => x.path === f.path) === i
    );

    return (
      <>
        <ToolOperationGroup group={item} isActive={isActive} />
        {/* ★ 在工具调用组后面显示文件修改 */}
        {uniqueFileChanges.length > 0 && (
          <MessageFileChanges
            fileChanges={uniqueFileChanges}
            onSwitchToFileTab={onSwitchToFileTab}
          />
        )}
      </>
    );
  }

  // Render regular message (user, assistant, system, or standalone tool_use/tool_result)
  const message = item as Message;

  // ★ 方案 B：不再隐藏 assistant 消息的文件修改，因为现在从 toolCalls 直接提取
  return <ChatMessage message={message} onSwitchToFileTab={onSwitchToFileTab} />;
}
