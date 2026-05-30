/**
 * Session management store
 * Refactored to follow SpectrAI architecture pattern
 * - tool_use and tool_result are now independent messages (not embedded in assistant messages)
 * - Uses ConversationMessage types from @shared
 * @module stores/session-store
 */

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionState, SessionStatus, Message, Question, InteractivePanelState } from '@/types';
import type {
  ToolUseMessage,
  ToolResultMessage,
} from '@shared/index';
import { CONFIG_FILES } from '@/services/storage';
import { ensureDir, deleteFile } from '@/utils/fs';
import { useAgentStore } from './agent-store';
import { useProviderStore } from './provider-store';
import { useProjectStore } from './project-store';
import { useActivityStore } from './activity-store';
import { getSessionFilePath, saveSessionToDisk, loadSessionFromDisk } from '@/services/session-storage';

/** Maximum number of conversation rounds to keep in memory */
const MAX_ROUNDS = 200;

/** Initial number of rounds to load on startup */
const INITIAL_ROUNDS = 20;

/** Rounds per page for history loading */
const ROUNDS_PER_PAGE = 20;

/** @deprecated Use MAX_ROUNDS instead */
const MAX_MESSAGES = 500;

/** @deprecated Use INITIAL_ROUNDS instead */
const INITIAL_MESSAGES = 20;

/** @deprecated Use ROUNDS_PER_PAGE instead */
const MESSAGES_PER_PAGE = 20;

/**
 * Conversation round structure
 * A round = user message + all tool operations + assistant response
 */
interface ConversationRound {
  /** Index of the round (0-based) */
  roundIndex: number;
  /** Start index in the messages array */
  startIndex: number;
  /** End index in the messages array (exclusive) */
  endIndex: number;
  /** Number of messages in this round */
  messageCount: number;
  /** Timestamp of the user message */
  timestamp: string;
}

/**
 * Identify conversation rounds from messages
 * A round starts with a user message and ends before the next user message
 * @param messages Message array
 * @returns Array of conversation rounds
 */
function identifyRounds(messages: Message[]): ConversationRound[] {
  if (!messages || messages.length === 0) return [];

  const rounds: ConversationRound[] = [];
  let currentRoundStart = 0;
  let roundIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // A new round starts with a user message (except the first message)
    if (message.role === 'user' && i > 0) {
      // Close the previous round
      rounds.push({
        roundIndex,
        startIndex: currentRoundStart,
        endIndex: i,
        messageCount: i - currentRoundStart,
        timestamp: messages[currentRoundStart].timestamp,
      });
      currentRoundStart = i;
      roundIndex++;
    }
  }

  // Close the last round
  if (currentRoundStart < messages.length) {
    rounds.push({
      roundIndex,
      startIndex: currentRoundStart,
      endIndex: messages.length,
      messageCount: messages.length - currentRoundStart,
      timestamp: messages[currentRoundStart].timestamp,
    });
  }

  return rounds;
}

/**
 * Trim messages by conversation rounds
 * Keeps the most recent MAX_ROUNDS rounds
 * @param messages Message array
 * @returns Trimmed message array
 */
function trimMessagesByRounds(messages: Message[]): Message[] {
  if (!messages || messages.length === 0) return [];

  const rounds = identifyRounds(messages);

  if (rounds.length <= MAX_ROUNDS) {
    return messages;
  }

  // Keep the most recent MAX_ROUNDS rounds
  const roundsToKeep = rounds.slice(-MAX_ROUNDS);
  const startIndex = roundsToKeep[0].startIndex;

  console.log(`[SessionStore] Trimming messages: ${rounds.length} rounds -> ${MAX_ROUNDS} rounds, ${messages.length} messages -> ${messages.length - startIndex} messages`);

  return messages.slice(startIndex);
}

/**
 * Get messages for the most recent N rounds
 * @param messages Message array
 * @param numRounds Number of rounds to get
 * @returns Messages for the most recent N rounds
 */
function getRecentRounds(messages: Message[], numRounds: number): Message[] {
  if (!messages || messages.length === 0) return [];

  const rounds = identifyRounds(messages);

  if (rounds.length <= numRounds) {
    return [...messages]; // Return copy to ensure React detects change
  }

  const roundsToGet = rounds.slice(-numRounds);
  const startIndex = roundsToGet[0].startIndex;

  return messages.slice(startIndex);
}

/**
 * Get older messages by rounds (for history loading)
 * @param allMessages All messages from disk
 * @param currentMessages Messages already in memory
 * @param numRounds Number of rounds to load
 * @returns Messages to prepend (in chronological order)
 */
function getOlderRounds(allMessages: Message[], currentMessages: Message[], numRounds: number): Message[] {
  if (!allMessages || allMessages.length === 0) return [];
  if (!currentMessages) currentMessages = [];

  // Get IDs of messages already in memory
  const currentIds = new Set(currentMessages.map(m => m.id));

  // Find messages not in current memory
  const olderMessages = allMessages.filter(m => !currentIds.has(m.id));
  if (olderMessages.length === 0) return [];

  // Identify rounds in older messages
  const rounds = identifyRounds(olderMessages);
  if (rounds.length === 0) return [];

  // Get the most recent N rounds from older messages
  const roundsToLoad = rounds.slice(-numRounds);
  const startIndex = roundsToLoad[0].startIndex;

  // Return in chronological order (oldest first) for prepending
  return olderMessages.slice(startIndex);
}

/** Store state type for helper functions */
type StoreState = SessionState & SessionActions;

/** Zustand set function type for helper functions (replace param omitted as unused) */
type SetFunction = (
  partial: StoreState | Partial<StoreState> | ((state: StoreState) => StoreState | Partial<StoreState>)
) => void;

// ─────────────────────────────────────────────────────────────────────────────
// 进度事件监听器（参考 SpectrAI 的 sessionStore 模式）
// ★ 修复：使用 Map 支持多会话并发，每个会话独立监听器
// ─────────────────────────────────────────────────────────────────────────────

/** 进度监听器信息 */
interface ProgressListenerInfo {
  cleanup: () => void;
  callback: (event: any) => void;
  lastEventTime: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimeoutCount: number;
}

/** ★ 多会话进度监听器 Map */
const progressListeners = new Map<string, ProgressListenerInfo>();

/** ★ 多会话发送代数计数器（防止并发发送导致 Promise/Listener 泄漏） */
const sendGenerations = new Map<string, number>();

/** ★ 连接恢复提示的定时器（per-session，多会话并发隔离） */
const connectionNoticeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** ★ 上下文使用量刷新定时器（per-session，多会话并发隔离） */
const contextUsageTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** ★ 自适应心跳超时（退火策略）：第 1 次 10 分钟，第 2 次 20 分钟，第 3 次起 30 分钟 */
const HEARTBEAT_TIMEOUTS = [600000, 1200000, 1800000]; // 10min, 20min, 30min

/**
 * 设置进度事件监听器
 * 当有活跃会话时，监听主进程发送的进度事件
 */
function setupProgressListener(
  sessionId: string,
  onProgress: (event: {
    sessionId?: string;
    type: string;
    content: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolUseId?: string;
    isError?: boolean;
    initData?: {
      model?: string;
      tools?: string[];
      mcpServers?: { name: string; status: string }[];
      slashCommands?: string[];
      skills?: string[];
      plugins?: { name: string; path: string }[];
      agents?: string[];
      cwd?: string;
      projectSkillNames?: string[];
    };
    /** Status data for api_retry, task events, tool progress etc. */
    statusData?: {
      status: string;
      reason?: string;
      /** task_started / task_progress / task_updated */
      taskId?: string;
      subagentType?: string;
      description?: string;
      /** task_progress */
      toolUseId?: string;
      /** task_updated */
      taskStatus?: string;
      error?: string;
      /** tool_progress */
      toolName?: string;
      parentToolUseId?: string;
      elapsed_time_seconds?: number;
      /** tool_use_summary */
      precedingToolUseIds?: string[];
      /** session_state_changed */
      sessionState?: 'idle' | 'running' | 'requires_action';
      /** permission_denied */
      permissionDenied?: {
        toolName: string;
        reason: string;
      };
      /** rate_limit */
      rateLimit?: {
        tier: string;
        requestsRemaining?: number;
        resetAt?: string;
      };
      /** memory_recall */
      memories?: Array<{
        path: string;
        scope: string;
        content?: string;
      }>;
      /** notification */
      notification?: {
        level: 'info' | 'warning' | 'error';
        title?: string;
      };
      /** retrying (api_retry) */
      retryCount?: number;
      maxRetries?: number;
    };
    usageData?: {
      inputTokens: number;
      outputTokens: number;
      contextWindow: number;
    };
  }) => void
): void {
  // ★ 清理该会话的旧监听器（不影响其他会话）
  const existing = progressListeners.get(sessionId);
  if (existing) {
    existing.cleanup();
    if (existing.heartbeatTimer) {
      clearInterval(existing.heartbeatTimer);
    }
  }

  // ★ 使用一个共享的活跃标记对象，确保 cleanup 可以可靠地禁用回调
  const activeRef = { active: true };

  // ★ 创建新的监听器
  const listenerInfo: ProgressListenerInfo = {
    cleanup: () => {},
    callback: onProgress,
    lastEventTime: Date.now(),
    heartbeatTimer: null,
    heartbeatTimeoutCount: 0,
  };

  // 设置新的监听器
  const cleanup = window.api.claude.onProgress((event) => {
    // ★ 检查监听器是否已被 cleanup（activeRef 是可靠的双重保险）
    if (!activeRef.active) {
      console.log(`[TRACE-AI] [FRONTEND] Progress event IGNORED (listener cleaned up) | sessionId=${sessionId}`);
      return;
    }
    // 更新最后收到事件的时间
    listenerInfo.lastEventTime = Date.now();

    // ★ 按 event.sessionId 过滤，只处理当前会话的事件
    if (event.sessionId && event.sessionId !== sessionId) {
      return;
    }

    // 如果事件没有 sessionId 字段，也忽略
    if (!event.sessionId) {
      return;
    }

    onProgress(event);
  });

  // ★ 包装 cleanup 以确保 activeRef 也被标记为 false
  const wrappedCleanup = () => {
    activeRef.active = false;
    cleanup();
  };

  listenerInfo.cleanup = wrappedCleanup;
  progressListeners.set(sessionId, listenerInfo);

  console.log(`[TRACE-AI] [FRONTEND] Progress listener SETUP | sessionId=${sessionId} | total=${progressListeners.size}`);
}

/**
 * ★ 修复：清理指定会话的进度监听器
 * @param sessionId 会话 ID
 */
function cleanupProgressListenerForSession(sessionId: string): void {
  console.log(`[TRACE-AI] [FRONTEND] cleanupProgressListenerForSession CALLED | sessionId=${sessionId} | timestamp=${Date.now()} | stack=${new Error().stack?.split('\n')[2]?.trim()}`);
  // ★ 确保该会话的待处理批量工具消息已写入
  immediateFlushToolBatchForSession(sessionId);

  const listenerInfo = progressListeners.get(sessionId);
  if (listenerInfo) {
    listenerInfo.cleanup();
    if (listenerInfo.heartbeatTimer) {
      clearInterval(listenerInfo.heartbeatTimer);
    }
    progressListeners.delete(sessionId);
    console.log(`[SessionStore] Progress listener cleaned up for session: ${sessionId} (remaining: ${progressListeners.size})`);
  }

  // 清理该会话的缓冲区
  cleanupStreamingBuffer(sessionId);
  cleanupToolBatch(sessionId);

  // ★ 清理该会话的 per-session 定时器
  const noticeTimer = connectionNoticeTimers.get(sessionId);
  if (noticeTimer) {
    clearTimeout(noticeTimer);
    connectionNoticeTimers.delete(sessionId);
  }
  stopContextUsageRefresh(sessionId);
  // 注意：sendGenerations 不在此清理 — 由 sendMessage finally 块负责
  // 若在此删除，正常 complete 流中的 sendGenerations 检查会失败，导致跳过 save
}
/**
 * ★ 启动上下文使用量定时刷新（每 5 秒）
 * 在模型执行期间调用 SDK 的 getContextUsage 获取准确的使用量
 * @param sessionId 会话 ID
 * @param set Zustand set 函数
 */
function startContextUsageRefresh(sessionId: string, set: SetFunction): void {
  // ★ 清理该会话的旧定时器（不影响其他会话）
  const existing = contextUsageTimers.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    contextUsageTimers.delete(sessionId);
  }

  console.log(`[SessionStore] Starting context usage refresh for session: ${sessionId}`);

  // 立即刷新一次
  refreshContextUsage(sessionId, set);

  // 每 5 秒刷新一次，使用 setTimeout 链式调用避免并发
  const scheduleNext = () => {
    const timer = setTimeout(async () => {
      // 检查定时器是否已被清理
      if (contextUsageTimers.get(sessionId) !== timer) return;
      await refreshContextUsage(sessionId, set);
      // 上一次完成后才调度下一次
      if (contextUsageTimers.get(sessionId) === timer) {
        scheduleNext();
      }
    }, 5000);
    contextUsageTimers.set(sessionId, timer);
  };
  scheduleNext();
}

/**
 * ★ 停止上下文使用量刷新
 * @param sessionId 可选：停止指定会话；不传则停止全部
 */
function stopContextUsageRefresh(sessionId?: string): void {
  if (sessionId) {
    const timer = contextUsageTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      contextUsageTimers.delete(sessionId);
    }
  } else {
    for (const timer of contextUsageTimers.values()) {
      clearTimeout(timer);
    }
    contextUsageTimers.clear();
  }
}

/**
 * ★ 刷新上下文使用量（调用 SDK getContextUsage）
 * @param sessionId 会话 ID
 * @param set Zustand set 函数
 */
async function refreshContextUsage(sessionId: string, set: SetFunction): Promise<void> {
  try {
    console.log(`[TRACE-AI] [FRONTEND] refreshContextUsage CALLING getContextUsage IPC | sessionId=${sessionId} | timestamp=${Date.now()}`);
    const result = await window.api.claude.getContextUsage(sessionId);

    if (!result.success || !result.data) {
      // 静默失败，不影响用户体验
      return;
    }

    const { totalTokens, maxTokens, percentage, categories } = result.data;

    console.log(`[SessionStore] Context usage refreshed: ${totalTokens}/${maxTokens} (${percentage.toFixed(1)}%)`);

    // 更新 session 的 tokenUsage
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      const currentUsage = existingSession.tokenUsage || { inputTokens: 0, outputTokens: 0 };

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            tokenUsage: {
              ...currentUsage,
              // ★ 使用 SDK 返回的准确值
              inputTokens: totalTokens,
              contextWindow: maxTokens,
              // 保留 outputTokens，SDK 的 getContextUsage 不返回 outputTokens
            },
          },
        },
      };
    });
  } catch (err) {
    // 静默失败
    console.warn('[SessionStore] Failed to refresh context usage:', err);
  }
}

/**
 * ★ 检查心跳超时，如果长时间没有收到事件，认为连接断开
 * @param sessionId 会话 ID
 * @param assistantMessageId 助手消息 ID
 * @param set Zustand set 函数
 */
function startHeartbeatCheck(
  sessionId: string,
  assistantMessageId: string,
  set: SetFunction
): void {
  // ★ 获取该会话的监听器信息
  const listenerInfo = progressListeners.get(sessionId);
  if (!listenerInfo) {
    console.warn(`[SessionStore] No listener found for session: ${sessionId}, skipping heartbeat check`);
    return;
  }

  // 清理该会话的旧心跳定时器
  if (listenerInfo.heartbeatTimer) {
    clearInterval(listenerInfo.heartbeatTimer);
  }

  listenerInfo.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const timeSinceLastEvent = now - listenerInfo.lastEventTime;

    // ★ 自适应超时：根据超时次数选择退火时间
    const currentTimeout = HEARTBEAT_TIMEOUTS[Math.min(listenerInfo.heartbeatTimeoutCount, HEARTBEAT_TIMEOUTS.length - 1)];

    if (timeSinceLastEvent > currentTimeout) {
      listenerInfo.heartbeatTimeoutCount++;
      const timeoutMinutes = Math.round(currentTimeout / 60000);
      console.warn(`[SessionStore] Heartbeat timeout #${listenerInfo.heartbeatTimeoutCount} for session: ${sessionId}, last event was ${Math.round(timeSinceLastEvent / 1000)}s ago (threshold: ${timeoutMinutes}min)`);

      // ★ 尝试重建会话（最多 3 次）
      if (listenerInfo.heartbeatTimeoutCount <= 3) {
        (async () => {
          // 显示重连提示
          const prevTimer = connectionNoticeTimers.get(sessionId);
          if (prevTimer) clearTimeout(prevTimer);
          set(state => {
            const s = state.sessions[sessionId];
            if (!s) return state;
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...s,
                  connectionNotice: `连接超时，正在重连（第 ${listenerInfo.heartbeatTimeoutCount}/3 次）...`
                }
              }
            };
          });

          try {
            // ★ 调用后端重建 API
            const result = await window.api.claude.retryHeartbeat(sessionId);

            if (result.success) {
              // 重连成功
              console.log(`[SessionStore] Heartbeat retry #${result.retryCount} success for session: ${sessionId}`);
              listenerInfo.lastEventTime = Date.now();
              listenerInfo.heartbeatTimeoutCount = 0;  // 重置计数
              startHeartbeatCheck(sessionId, assistantMessageId, set);

              // 显示恢复提示
              set(state => {
                const s = state.sessions[sessionId];
                if (!s) return state;
                return {
                  sessions: { ...state.sessions, [sessionId]: { ...s, connectionNotice: '连接已恢复' } }
                };
              });
              const noticeTimer = setTimeout(() => {
                connectionNoticeTimers.delete(sessionId);
                set(state => {
                  const s = state.sessions[sessionId];
                  if (!s || s.connectionNotice !== '连接已恢复') return state;
                  return { sessions: { ...state.sessions, [sessionId]: { ...s, connectionNotice: null } } };
                });
              }, 3000);
              connectionNoticeTimers.set(sessionId, noticeTimer);
              return;
            }

            // 重连失败
            console.warn(`[SessionStore] Heartbeat retry #${result.retryCount} failed: ${result.error}`);

            // ★ 同步后端返回的重试计数，保持前后端状态一致
            if (result.retryCount) {
              listenerInfo.heartbeatTimeoutCount = result.retryCount;
            }

            // 如果达到最大重试次数，执行中止
            if (result.retryCount && result.retryCount >= 3) {
              performHeartbeatAbort(sessionId, assistantMessageId, set, timeoutMinutes);
            }
            // 否则继续下一次心跳检查（等待下次超时触发）
          } catch (err) {
            console.warn('[SessionStore] retryHeartbeat failed:', err);
            // 异常情况也继续等待下次检查
          }
        })();
        return;
      }

      // ★ 第 3 次及以上：放弃重连，直接中止
      performHeartbeatAbort(sessionId, assistantMessageId, set, timeoutMinutes);
    } else {
      console.log(`[SessionStore] Heartbeat check for session: ${sessionId}, time since last event: ${Math.round(timeSinceLastEvent / 1000)}s`);
    }
  }, 60000);
}

/**
 * 心跳超时后的中止处理（提取为独立函数）
 */
function performHeartbeatAbort(
  sessionId: string,
  assistantMessageId: string,
  set: SetFunction,
  timeoutMinutes: number
): void {
  // ★ 清理该会话的心跳定时器
  const listenerInfo = progressListeners.get(sessionId);
  if (listenerInfo?.heartbeatTimer) {
    clearInterval(listenerInfo.heartbeatTimer);
    listenerInfo.heartbeatTimer = null;
  }

  (async () => {
    try {
      await window.api.claude.abort(sessionId);
      console.log('[SessionStore] Session abort request sent successfully');
    } catch (err) {
      console.warn('[SessionStore] Failed to abort session:', err);
    }
  })();

  immediateFlushBufferForSession(sessionId, set);
  set(state => {
    const existingSession = state.sessions[sessionId];
    if (!existingSession) return state;

    const updatedMessages = existingSession.messages.map(m =>
      m.id === assistantMessageId
        ? { ...m, isStreaming: false, isThinking: false, content: m.content + `\n\n⚠️ 连接超时（${timeoutMinutes}分钟无响应），请检查后端服务是否正常。如需继续，可尝试重新发送消息。` }
        : m
    );

    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...existingSession,
          messages: updatedMessages,
        },
      },
    };
  });

  useActivityStore.getState().endThinking(sessionId);
  useActivityStore.getState().endActivity(sessionId);
  // ★ 修复：只清理该会话的监听器
  cleanupProgressListenerForSession(sessionId);
}

/**
 * Streaming text buffer for batching updates
 * Reduces re-renders by merging multiple text chunks before applying to state
 */
interface StreamingBuffer {
  /** Accumulated text content */
  pendingText: string;
  /** Scheduled flush timer ID */
  flushTimer: number | null;
  /** Target message ID being updated */
  messageId: string | null;
  /** Session ID being updated */
  sessionId: string | null;
}

/**
 * ★ 修复：使用 Map 结构支持多会话并发
 * 每个会话独立缓冲区，避免竞态条件
 */
const streamingBuffers = new Map<string, StreamingBuffer>();

/** Get or create buffer for a session */
function getStreamingBuffer(sessionId: string): StreamingBuffer {
  let buffer = streamingBuffers.get(sessionId);
  if (!buffer) {
    buffer = {
      pendingText: '',
      flushTimer: null,
      messageId: null,
      sessionId: sessionId,
    };
    streamingBuffers.set(sessionId, buffer);
  }
  return buffer;
}

/** Clean up buffer for a session (call when session ends) */
function cleanupStreamingBuffer(sessionId: string): void {
  const buffer = streamingBuffers.get(sessionId);
  if (buffer?.flushTimer) {
    clearTimeout(buffer.flushTimer);
  }
  streamingBuffers.delete(sessionId);
}

/** Delay in ms before flushing buffered updates (use requestAnimationFrame-like timing) */
const STREAM_FLUSH_DELAY = 16; // ~60fps

// ── Tool message batch queue ──────────────────────────────────────────────────
// Reduces React re-renders during long tool-heavy tasks (300+ tool calls):
// instead of one set() per tool event, batch up to 500ms of tool messages
// and apply them in a single state update.
// ★ 修复：使用 Map 结构支持多会话并发

interface ToolBatchEntry {
  message: Message
}

interface ToolBatchState {
  queue: ToolBatchEntry[]
  flushTimer: ReturnType<typeof setTimeout> | null
  setFn: SetFunction | null
}

const toolBatches = new Map<string, ToolBatchState>();

/** Get or create tool batch for a session */
function getToolBatch(sessionId: string): ToolBatchState {
  let batch = toolBatches.get(sessionId);
  if (!batch) {
    batch = {
      queue: [],
      flushTimer: null,
      setFn: null,
    };
    toolBatches.set(sessionId, batch);
  }
  return batch;
}

/** Clean up tool batch for a session */
function cleanupToolBatch(sessionId: string): void {
  const batch = toolBatches.get(sessionId);
  if (batch?.flushTimer) {
    clearTimeout(batch.flushTimer);
  }
  toolBatches.delete(sessionId);
}

const TOOL_BATCH_DELAY = 500

function flushToolBatchForSession(sessionId: string): void {
  const batch = toolBatches.get(sessionId);
  if (!batch || batch.queue.length === 0) return;

  const { queue, setFn } = batch;
  if (!setFn) {
    batch.queue = [];
    return;
  }
  if (batch.flushTimer) {
    clearTimeout(batch.flushTimer);
    batch.flushTimer = null;
  }

  const batchMessages = queue.map((q) => q.message);
  batch.queue = [];

  setFn((state) => {
    const existingSession = state.sessions[sessionId];
    if (!existingSession) return state;
    // Deduplicate: skip messages whose ID already exists in state
    const existingIds = new Set(existingSession.messages.map((m) => m.id));
    const newMessages = batchMessages.filter((m) => !existingIds.has(m.id));
    if (newMessages.length === 0) return state;
    const updatedMessages = trimMessages([...existingSession.messages, ...newMessages]);
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: { ...existingSession, messages: updatedMessages },
      },
    };
  });
}

function enqueueToolMessage(message: Message, sessionId: string, setFn: SetFunction): void {
  const batch = getToolBatch(sessionId);
  batch.setFn = setFn;
  batch.queue.push({ message });

  if (!batch.flushTimer) {
    batch.flushTimer = setTimeout(() => flushToolBatchForSession(sessionId), TOOL_BATCH_DELAY);
  }
}

/** Flush tool batch immediately for a specific session (called before non-tool events like text/complete/error) */
function immediateFlushToolBatchForSession(sessionId: string): void {
  flushToolBatchForSession(sessionId);
}

/** Flush all tool batches immediately (called during cleanup) */
function immediateFlushAllToolBatches(): void {
  for (const sessionId of toolBatches.keys()) {
    flushToolBatchForSession(sessionId);
  }
}

/** Look up a tool_use message from state AND pending batch queue */
function findToolUseMessage(sessionId: string, toolUseId: string): Message | undefined {
  // Check batch queue first (newest messages)
  const batch = toolBatches.get(sessionId);
  if (batch) {
    for (const entry of batch.queue) {
      if (entry.message.role === 'tool_use' && entry.message.toolUseId === toolUseId) {
        return entry.message;
      }
    }
  }
  // Fall back to state
  const existingSession = useSessionStore.getState().sessions[sessionId];
  return existingSession?.messages.find(
    (m) => m.role === 'tool_use' && m.toolUseId === toolUseId
  );
}

interface SessionActions {
  /** Create a new session for a project */
  createSession: (projectId: string) => string;
  /** Send a message and handle agent response (streaming) */
  sendMessage: (sessionId: string, content: string) => Promise<void>;
  /** Restart session connection (reconnect agent, keep history) */
  restartSession: (sessionId: string) => Promise<void>;
  /** Reset session to fresh state (new session ID, clear history) */
  resetSession: (sessionId: string) => Promise<void>;
  /** Load paginated history messages */
  loadHistory: (sessionId: string, page: number) => Promise<Message[]>;
  /** Save session to persistent storage */
  saveSession: (sessionId: string) => Promise<void>;
  /** Set the active session */
  setActiveSession: (sessionId: string | null) => void;
  /** Delete a session */
  deleteSession: (sessionId: string) => Promise<void>;
  /** Get session by project ID */
  getSessionByProjectId: (projectId: string) => Session | undefined;
  /** Add an assistant message to the session */
  addAssistantMessage: (sessionId: string, content: string, isStreaming?: boolean) => string;
  /** Update an existing message */
  updateMessage: (sessionId: string, messageId: string, updates: Partial<Message>) => void;
  /** Initialize store and load existing sessions */
  initialize: () => Promise<void>;
  /** Check if store is initialized */
  isInitialized: () => boolean;
  /** Close session and cleanup resources */
  closeSession: (sessionId: string) => Promise<void>;
  /** Set interactive panel state */
  setInteractivePanel: (sessionId: string, panel: Partial<InteractivePanelState>) => void;
  /** Clear interactive panel state */
  clearInteractivePanel: (sessionId: string) => void;
  /** Respond to permission request */
  respondToPermission: (sessionId: string, allowed: boolean) => Promise<void>;
  /** Respond to question */
  respondToQuestion: (sessionId: string, answers: Record<string, string>) => Promise<void>;
  /** Respond to plan approval */
  respondToApproval: (sessionId: string, approved: boolean) => Promise<void>;
  /** Prepend history messages to the beginning of message list */
  prependMessages: (sessionId: string, messages: Message[]) => void;
  /** Trigger compact and reload Claude.md */
  triggerCompact: (sessionId: string) => Promise<void>;
  /** Update token usage (for auto-compact detection) */
  updateTokenUsage: (sessionId: string, usage: { inputTokens: number; outputTokens: number; contextWindow: number }) => void;
  /** Update input draft - save unsent text when switching sessions/tabs */
  updateInputDraft: (sessionId: string, draft: string) => void;
  /** Set auto-compacted flag - prevents repeated auto-compact within same session */
  setAutoCompacted: (sessionId: string, value: boolean) => void;
}

/** Store initialization state */
let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * List of tools that require permission confirmation
 */
const PERMISSION_REQUIRED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'run_shell_command',
  'write_file',
  'replace',
  'multi_edit',
];

/**
 * Check if a tool requires permission confirmation
 * @param toolName Tool name
 * @returns Whether the tool requires permission
 */
function isPermissionRequiredTool(toolName: string): boolean {
  return PERMISSION_REQUIRED_TOOLS.includes(toolName);
}

/**
 * Build permission request message for display
 * @param toolName Tool name
 * @param toolInput Tool input parameters
 * @returns Permission request message
 */
function buildPermissionMessage(toolName: string, toolInput?: Record<string, unknown>): string {
  if (!toolInput) return `请求执行操作: ${toolName}`;

  switch (toolName) {
    case 'Bash':
    case 'run_shell_command':
      return `请求执行命令: ${String(toolInput.command || '').slice(0, 100)}`;
    case 'Write':
    case 'write_file':
      return `请求写入文件: ${String(toolInput.file_path || '未知文件')}`;
    case 'Edit':
    case 'replace':
    case 'multi_edit':
      return `请求编辑文件: ${String(toolInput.file_path || '未知文件')}`;
    default:
      return `请求执行操作: ${toolName}`;
  }
}

/**
 * Generate human-readable activity detail from tool name and input
 * @param toolName Tool name
 * @param toolInput Tool input parameters
 * @returns Activity detail string
 */
function getActivityDetail(toolName: string, toolInput?: Record<string, unknown>): string {
  if (!toolInput) return `正在执行 ${toolName}...`;

  const filePath = toolInput.file_path as string | undefined;
  const command = toolInput.command as string | undefined;
  const pattern = toolInput.pattern as string | undefined;

  switch (toolName) {
    case 'Read':
    case 'read_file':
      return filePath ? `正在读取 ${filePath}...` : '正在读取文件...';
    case 'Write':
    case 'write_file':
      return filePath ? `正在写入 ${filePath}...` : '正在写入文件...';
    case 'Edit':
    case 'replace':
    case 'multi_edit':
      return filePath ? `正在编辑 ${filePath}...` : '正在编辑文件...';
    case 'Bash':
    case 'run_shell_command':
      return command ? `正在执行: ${String(command).slice(0, 50)}...` : '正在执行命令...';
    case 'Glob':
      return pattern ? `正在搜索: ${pattern}...` : '正在搜索文件...';
    case 'Grep':
    case 'search_file_content':
      return pattern ? `正在搜索内容: ${pattern}...` : '正在搜索内容...';
    case 'WebSearch':
    case 'web_search':
      return '正在搜索网络...';
    case 'Task':
      return '正在执行子任务...';
    default:
      return `正在执行 ${toolName}...`;
  }
}

/**
 * Trim messages if exceeding maximum limit
 * Now uses round-based trimming instead of message count
 * @param messages Message array
 * @returns Trimmed message array
 */
function trimMessages(messages: Message[]): Message[] {
  return trimMessagesByRounds(messages);
}

/**
 * Flush the streaming buffer and apply accumulated text to the message
 * This is the actual state update that triggers re-render
 * ★ 修复：支持多会话，按 sessionId 获取对应缓冲区
 * @param sessionId Session ID
 * @param set Zustand set function
 */
function flushStreamingBufferForSession(sessionId: string, set: SetFunction): void {
  const buffer = streamingBuffers.get(sessionId);
  if (!buffer || !buffer.messageId || !buffer.pendingText) {
    return;
  }

  const messageId = buffer.messageId;
  const textToAdd = buffer.pendingText;

  // Clear buffer before updating to prevent duplicate flushes
  buffer.pendingText = '';
  buffer.flushTimer = null;

  // Apply accumulated text in a single state update
  set(state => {
    const existingSession = state.sessions[sessionId];
    if (!existingSession) return state;

    const messageIndex = existingSession.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return state;

    const updatedMessages = [...existingSession.messages];
    const currentContent = updatedMessages[messageIndex].content || '';
    updatedMessages[messageIndex] = {
      ...updatedMessages[messageIndex],
      content: currentContent + textToAdd,
    };

    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...existingSession,
          messages: updatedMessages,
        },
      },
    };
  });
}

/**
 * Buffer streaming text and schedule a flush
 * Multiple chunks within the flush delay are merged into a single update
 * ★ 修复：使用 Map 结构，每个会话独立缓冲区
 * @param sessionId Session ID
 * @param messageId Message ID
 * @param text Text chunk to buffer
 * @param set Zustand set function
 */
function bufferStreamingText(
  sessionId: string,
  messageId: string,
  text: string,
  set: SetFunction
): void {
  const buffer = getStreamingBuffer(sessionId);

  // Initialize buffer for new message if needed
  if (buffer.messageId !== messageId) {
    // Flush any previous buffer for this session
    if (buffer.flushTimer !== null) {
      clearTimeout(buffer.flushTimer);
      flushStreamingBufferForSession(sessionId, set);
    }
    buffer.messageId = messageId;
    buffer.pendingText = '';
    buffer.flushTimer = null;
  }

  // Accumulate text in buffer
  buffer.pendingText += text;

  // Schedule flush if not already scheduled
  if (buffer.flushTimer === null) {
    buffer.flushTimer = window.setTimeout(() => {
      flushStreamingBufferForSession(sessionId, set);
    }, STREAM_FLUSH_DELAY);
  }
}

/**
 * Immediately flush the buffer for a specific session
 * Called on complete or error events
 * @param sessionId Session ID
 * @param set Zustand set function
 */
function immediateFlushBufferForSession(sessionId: string, set: SetFunction): void {
  // ★ Flush pending tool batch first (preserves message ordering)
  immediateFlushToolBatchForSession(sessionId);

  const buffer = streamingBuffers.get(sessionId);
  if (!buffer) return;

  if (buffer.flushTimer !== null) {
    clearTimeout(buffer.flushTimer);
  }
  flushStreamingBufferForSession(sessionId, set);

  // Reset buffer state
  buffer.messageId = null;
  buffer.pendingText = '';
}

/**
 * Immediately flush all buffers (called during cleanup)
 * @param set Zustand set function
 */
function immediateFlushAllBuffers(set: SetFunction): void {
  // Flush all tool batches first
  immediateFlushAllToolBatches();

  // Flush all streaming buffers
  for (const sessionId of streamingBuffers.keys()) {
    const buffer = streamingBuffers.get(sessionId);
    if (buffer?.flushTimer) {
      clearTimeout(buffer.flushTimer);
    }
    flushStreamingBufferForSession(sessionId, set);
  }
}

export const useSessionStore = create<SessionState & SessionActions>((set, get) => ({
  sessions: {},
  activeSessionId: null,
  projectSessionIndex: new Map<string, string>(),

  /**
   * Initialize store and load existing sessions from disk
   */
  initialize: async () => {
    if (initialized) {
      console.log('[SessionStore] Already initialized, skipping');
      return;
    }
    if (initPromise) {
      console.log('[SessionStore] Initialization in progress, waiting');
      return initPromise;
    }

    initPromise = (async () => {
      try {
        // Use async version to ensure correct path
        const { getUserDataPathAsync } = await import('@/utils/fs');
        const dataPath = await getUserDataPathAsync();
        const sessionsDir = `${dataPath}/sessions`;

        console.log('[SessionStore] Data path:', dataPath);
        console.log('[SessionStore] Sessions directory:', sessionsDir);
        await ensureDir(sessionsDir);

        // Load all session files
        console.log('[SessionStore] Reading directory...');
        const result = await window.api.fs.readDir(sessionsDir, 1);
        console.log('[SessionStore] ReadDir result:', { success: result.success, error: result.error, contentLength: result.content?.length });

        if (result.success && result.content) {
          const loadedSessions: Record<string, Session> = {};
          const projectSessionIndex = new Map<string, string>();
          let loadedCount = 0;

          for (const entry of result.content) {
            if (entry.type === 'file' && entry.name.endsWith('.json')) {
              const sessionId = entry.name.replace('.json', '');
              try {
                const sessionData = await loadSessionFromDisk(sessionId);
                console.log(`[SessionStore] Loaded session ${sessionId}: ${sessionData?.messages?.length || 0} messages from disk`);
                if (sessionData) {
                  // ★ Round-based loading: Only load the most recent INITIAL_ROUNDS on startup
                  // User can load older messages via "load history" button
                  const trimmedSession: Session = {
                    ...sessionData,
                    messages: getRecentRounds(sessionData.messages, INITIAL_ROUNDS),
                  };
                  loadedSessions[sessionId] = trimmedSession;

                  // Build index: projectId → sessionId
                  if (trimmedSession.projectId) {
                    projectSessionIndex.set(trimmedSession.projectId, sessionId);
                  }

                  console.log(`[SessionStore] Trimmed session ${sessionId}: ${trimmedSession.messages.length} messages`);
                  loadedCount++;
                }
              } catch (e) {
                console.error(`[SessionStore] Failed to load session ${sessionId}:`, e);
              }
            }
          }

          set({ sessions: loadedSessions, projectSessionIndex });
          console.log(`[SessionStore] Loaded ${loadedCount} sessions, total in store: ${Object.keys(loadedSessions).length}`);
          console.log(`[SessionStore] Project index size: ${projectSessionIndex.size}`);

          // Log some session IDs for debugging
          const sessionIds = Object.keys(loadedSessions);
          if (sessionIds.length > 0) {
            console.log('[SessionStore] Sample session IDs:', sessionIds.slice(0, 3));
          }
        } else {
          console.log('[SessionStore] No sessions found or read failed');
        }

        initialized = true;
        console.log('[SessionStore] Initialization complete');
      } catch (error) {
        console.error('[SessionStore] Initialization failed:', error);
        initPromise = null;
        throw error;
      }
    })();

    return initPromise;
  },

  /**
   * Create a new session for a project
   * If a session already exists for this project, return it instead of creating a new one
   * This ensures "one project, one session" design principle
   * @param projectId Project ID
   * @returns Session ID
   */
  createSession: (projectId) => {
    // Ensure initialization is complete before creating session
    if (!initialized) {
      console.error('[SessionStore] createSession called before initialization!');
      return '';
    }

    console.log(`[SessionStore] createSession called for project: ${projectId}`);

    // Use getSessionByProjectId which handles index miss with direct search
    const existingSession = get().getSessionByProjectId(projectId);
    if (existingSession) {
      // Set the existing session as active
      set({ activeSessionId: existingSession.id });
      console.log(`[SessionStore] Reusing existing session: ${existingSession.id} for project: ${projectId}`);
      return existingSession.id;
    }

    console.log(`[SessionStore] No existing session found, creating new one`);

    // Create new session only if none exists
    const sessionId = uuidv4();
    const now = new Date().toISOString();
    const newSession: Session = {
      id: sessionId,
      projectId,
      messages: [],
      createdAt: now,
      lastActiveAt: now,
      status: 'connected',
    };

    set(state => ({
      sessions: { ...state.sessions, [sessionId]: newSession },
      activeSessionId: sessionId,
      // Update index
      projectSessionIndex: new Map(state.projectSessionIndex).set(projectId, sessionId),
    }));

    // Save to disk
    get().saveSession(sessionId).catch(err => {
      console.error('[SessionStore] Failed to save new session:', err);
    });

    console.log(`[SessionStore] Created new session: ${sessionId} for project: ${projectId}`);
    return sessionId;
  },

  /**
   * Send a message and handle agent response (streaming)
   * 使用新的会话管理 API（参考 SpectrAI 的模式）
   * @param sessionId Session ID
   * @param content Message content
   */
  sendMessage: async (sessionId, content) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    // ★ 生成追踪 ID
    const traceId = `${sessionId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log(`[TRACE-AI] ========================================`);
    console.log(`[TRACE-AI] [FRONTEND] sendMessage ENTRY | traceId=${traceId} | content="${content.substring(0, 50)}"`);
    console.log(`[TRACE-AI] ========================================`);

    // ★ 并发防护：递增代数，旧 send 检测到代数不匹配后会自行退出
    const sendGen = (sendGenerations.get(sessionId) || 0) + 1;
    sendGenerations.set(sessionId, sendGen);

    // Create user message
    const userMessage: Message = {
      id: uuidv4(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };

    // Add user message and update session
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      const updatedMessages = trimMessages([...existingSession.messages, userMessage]);

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            messages: updatedMessages,
            lastActiveAt: new Date().toISOString(),
          },
        },
      };
    });

    // Create placeholder for assistant message
    const assistantMessageId = get().addAssistantMessage(sessionId, '', true);
    console.log('[SessionStore] Assistant message created:', assistantMessageId);

    // Get provider and project for agent call
    const agentStore = useAgentStore.getState();
    const providerStore = useProviderStore.getState();
    const projectStore = useProjectStore.getState();

    console.log('[SessionStore] Agent status:', agentStore.status);

    // Check if agent is connected
    if (agentStore.status !== 'connected') {
      console.error('[SessionStore] Agent not connected, status:', agentStore.status);
      get().updateMessage(sessionId, assistantMessageId, {
        content: `Agent 未连接 (状态: ${agentStore.status})，请先连接 Agent 服务`,
        isStreaming: false,
      });
      return;
    }

    // Get provider
    const providerId = agentStore.config?.providerId;
    if (!providerId) {
      console.error('[SessionStore] No providerId in agent config');
      get().updateMessage(sessionId, assistantMessageId, {
        content: '未配置 API Provider',
        isStreaming: false,
      });
      return;
    }

    // ★ 重新加载 providers 确保获取最新的 API Key
    await useProviderStore.getState().loadProviders();
    const provider = useProviderStore.getState().providers.find(p => p.id === providerId);
    if (!provider) {
      console.error('[SessionStore] Provider not found:', providerId);
      get().updateMessage(sessionId, assistantMessageId, {
        content: `Provider 配置未找到 (ID: ${providerId})`,
        isStreaming: false,
      });
      return;
    }

    console.log('[SessionStore] Provider loaded, apiKey (first 20 chars):', provider.apiKey?.substring(0, 20));
    console.log('[SessionStore] Provider apiKey length:', provider.apiKey?.length);

    // Get project working directory
    const project = projectStore.projects.find(p => p.id === session.projectId);
    if (!project) {
      console.error('[SessionStore] Project not found:', session.projectId);
      get().updateMessage(sessionId, assistantMessageId, {
        content: '项目未找到',
        isStreaming: false,
      });
      return;
    }

    try {
      // ★ Step 0: 启动思考计时器
      console.log('[SessionStore] Starting thinking timer for session:', sessionId);
      useActivityStore.getState().startThinking(sessionId);

      // Debug: Verify activity was set
      const activityState = useActivityStore.getState().sessions[sessionId];
      console.log('[SessionStore] Activity state after startThinking:', {
        sessionId: sessionId.substring(0, 8),
        current: activityState?.current,
        thinkingStartTime: activityState?.thinkingStartTime,
      });

      // ★ Step 1: 启动会话（创建持久的 SDK query）
      console.log(`[TRACE-AI] [FRONTEND] Calling startSession | traceId=${traceId}`);
      console.log('[SessionStore] Starting session...');

      // 获取 API Key（明文存储，直接使用）
      const apiKey = provider.apiKey;
      if (!apiKey) {
        throw new Error('API Key not configured');
      }
      console.log('[SessionStore] apiKey (first 20 chars):', apiKey?.substring(0, 20));
      console.log('[SessionStore] apiKey length:', apiKey?.length);
      console.log('[SessionStore] provider.defaultModel:', provider.defaultModel);
      console.log('[SessionStore] provider.baseUrl:', provider.baseUrl);
      console.log('[SessionStore] provider.apiType:', provider.apiType);

      const startResult = await window.api.claude.startSession({
        sessionId,
        workingDirectory: project.path,
        apiKey: apiKey,
        baseUrl: provider.baseUrl,
        model: provider.defaultModel,
        apiType: provider.apiType,
        envOverrides: provider.envOverrides,
        contextWindow: provider.contextWindow,  // ★ 传递上下文窗口配置
      });

      if (!startResult.success) {
        throw new Error(startResult.error || 'Failed to start session');
      }

      // ★ Step 2: 设置进度事件监听器
      setupProgressListener(sessionId, (progressEvent) => {
        const { type, content: eventContent, toolName, toolInput, initData, statusData, usageData } = progressEvent;

        console.log('[SessionStore] Progress event:', type, eventContent?.substring(0, 100));

        // ★ keepalive 事件：回复 pong，仅刷新时间戳，不做任何 UI 更新
        if (type === 'keepalive') {
          window.api.claude.pong(sessionId).catch(() => {});
          return;
        }

        if (type === 'init' && initData) {
          // 保存 session init data (tools, mcpServers, etc.)
          set(state => {
            const existingSession = state.sessions[sessionId];
            if (!existingSession) return state;

            // ★ 不再使用 Provider 配置的 contextWindow
            // contextWindow 由 SDK 的 getContextUsage() 返回的真实模型上下文窗口决定
            // 这样可以准确反映模型的真实限制，而不是用户配置的值
            const currentUsage = existingSession.tokenUsage || { inputTokens: 0, outputTokens: 0, contextWindow: 200000 };

            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...existingSession,
                  initData,
                  // ★ 保留现有 tokenUsage，不覆盖 contextWindow
                  // contextWindow 由 refreshContextUsage() 从 SDK 获取真实值
                  tokenUsage: currentUsage,
                },
              },
            };
          });
          console.log('[SessionStore] Session init data saved:', initData);
        } else if (type === 'status' && statusData) {
          // ★ 处理各种状态事件（api_retry、子 Agent 状态、工具进度等）
          console.log('[SessionStore] Status event:', statusData);

          switch (statusData.status) {
            case 'retrying':
              useActivityStore.getState().startActivity(sessionId, {
                type: 'status',
                detail: eventContent || `空内容重试中（第 ${statusData.retryCount || '?'}/${statusData.maxRetries || '?'} 次）...`,
                timestamp: Date.now(),
              });
              break;

            case 'task_started':
              // 子 Agent/任务开始
              useActivityStore.getState().startActivity(sessionId, {
                type: 'tool_use',
                detail: `启动子任务: ${statusData.subagentType || statusData.description || 'unknown'}`,
                timestamp: Date.now(),
                metadata: { taskId: statusData.taskId, subagentType: statusData.subagentType },
              });
              break;

            case 'task_progress':
              // 子 Agent/任务进度更新
              useActivityStore.getState().startActivity(sessionId, {
                type: 'tool_use',
                detail: statusData.description || '子任务执行中...',
                timestamp: Date.now(),
                metadata: { taskId: statusData.taskId, toolUseId: statusData.toolUseId },
              });
              break;

            case 'task_updated':
              // 子 Agent/任务状态变化
              if (statusData.taskStatus === 'completed') {
                useActivityStore.getState().startActivity(sessionId, {
                  type: 'tool_result',
                  detail: '子任务完成',
                  timestamp: Date.now(),
                  metadata: { taskId: statusData.taskId },
                });
              } else if (statusData.taskStatus === 'failed') {
                useActivityStore.getState().startActivity(sessionId, {
                  type: 'status',
                  detail: `子任务失败: ${statusData.error || 'unknown'}`,
                  timestamp: Date.now(),
                  metadata: { taskId: statusData.taskId, error: statusData.error },
                });
              }
              break;

            case 'tool_progress':
              // 工具执行进度（包括子 Agent）
              useActivityStore.getState().startActivity(sessionId, {
                type: 'tool_use',
                detail: `${statusData.toolName || 'Tool'} 执行中...`,
                timestamp: Date.now(),
                metadata: {
                  toolName: statusData.toolName,
                  toolUseId: statusData.toolUseId,
                  parentToolUseId: statusData.parentToolUseId,
                },
              });
              break;

            case 'tool_summary':
              // 工具使用摘要
              if (statusData.precedingToolUseIds) {
                console.log('[SessionStore] Tool summary for tools:', statusData.precedingToolUseIds);
              }
              break;

            case 'session_state_changed':
              // 会话状态变化（权威的轮次结束信号）
              console.log('[SessionStore] Session state changed:', statusData.sessionState);
              if (statusData.sessionState === 'requires_action') {
                useActivityStore.getState().startActivity(sessionId, {
                  type: 'status',
                  detail: '等待用户操作...',
                  timestamp: Date.now(),
                });
              }
              break;

            case 'permission_denied':
              // 权限被拒绝
              console.log('[SessionStore] Permission denied:', statusData.permissionDenied);
              useActivityStore.getState().startActivity(sessionId, {
                type: 'status',
                detail: `工具 ${statusData.permissionDenied?.toolName || 'unknown'} 被拒绝`,
                timestamp: Date.now(),
              });
              break;

            case 'memory_recall':
              // 记忆召回
              console.log('[SessionStore] Memory recall:', statusData.memories?.length, 'memories');
              break;

            case 'task_notification':
              // 后台任务通知
              console.log('[SessionStore] Task notification:', statusData.taskId);
              useActivityStore.getState().startActivity(sessionId, {
                type: 'status',
                detail: eventContent || '后台任务通知',
                timestamp: Date.now(),
                metadata: { taskId: statusData.taskId },
              });
              break;

            case 'notification':
              // 通用通知
              console.log('[SessionStore] Notification:', statusData.notification);
              useActivityStore.getState().startActivity(sessionId, {
                type: 'status',
                detail: eventContent,
                timestamp: Date.now(),
              });
              break;

            case 'elicitation_complete':
              // MCP elicitation 完成
              console.log('[SessionStore] MCP elicitation complete');
              break;

            case 'compact_boundary':
              // 上下文压缩
              console.log('[SessionStore] Context compacted');
              useActivityStore.getState().startActivity(sessionId, {
                type: 'status',
                detail: '上下文已压缩',
                timestamp: Date.now(),
              });
              break;

            case 'api_retry':
              // ★ SDK 错误自动重试
              useActivityStore.getState().startActivity(sessionId, {
                type: 'status',
                detail: eventContent || `SDK 错误，自动重试中...`,
                timestamp: Date.now(),
              });
              break;

            case 'auth_status':
              // 认证状态
              console.log('[SessionStore] Auth status:', eventContent);
              break;

            case 'prompt_suggestion':
              // 提示建议
              console.log('[SessionStore] Prompt suggestion available');
              break;

            default:
              // 其他状态事件，记录日志
              console.log('[SessionStore] Unhandled status type:', statusData.status);
          }
        } else if (type === 'rate_limit') {
          // ★ 速率限制事件
          console.log('[SessionStore] Rate limit:', statusData?.rateLimit);
          useActivityStore.getState().startActivity(sessionId, {
            type: 'status',
            detail: `速率限制: ${statusData?.rateLimit?.tier || 'unknown'}`,
            timestamp: Date.now(),
            metadata: { rateLimit: statusData?.rateLimit },
          });
        } else if (type === 'text') {
          // ★ Flush pending tool batch before text (preserves message order)
          immediateFlushToolBatchForSession(sessionId);
          // Use buffering to reduce re-renders during streaming
          bufferStreamingText(sessionId, assistantMessageId, eventContent, set);
          // Update activity: AI is responding
          useActivityStore.getState().startActivity(sessionId, {
            type: 'thinking',
            detail: '正在回复...',
            timestamp: Date.now(),
          });
        } else if (type === 'thinking') {
          // ★ 处理 thinking 事件（来自 thinking_delta 或 thinking 块）
          // 累积 thinking 内容到消息的 thinkingText 字段
          if (eventContent) {
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;
              const msg = existingSession.messages.find(m => m.id === assistantMessageId);
              if (!msg) return state;

              const updatedMessages = existingSession.messages.map(m =>
                m.id === assistantMessageId
                  ? {
                      ...m,
                      thinkingText: (m.thinkingText || '') + eventContent,
                      isThinking: true,
                    }
                  : m
              );

              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...existingSession,
                    messages: updatedMessages,
                  },
                },
              };
            });
          }
          // 更新活动状态，表示 AI 正在思考（防止心跳超时）
          useActivityStore.getState().startActivity(sessionId, {
            type: 'thinking',
            detail: '正在思考...',
            timestamp: Date.now(),
          });
        } else if (type === 'tool_use' && toolName) {
          // ★ SpectrAI Architecture: Create independent ToolUseMessage
          // Instead of embedding toolCalls in assistant message, add as independent message
          const toolUseId = progressEvent.toolUseId || uuidv4();

          if (toolName === 'AskUserQuestion' && toolInput?.questions) {
            // Handle AskUserQuestion tool - this requires user interaction
            console.log('[SessionStore] AskUserQuestion tool detected:', toolInput);
            const questions = toolInput.questions as Question[];
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;
              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...existingSession,
                    interactivePanel: {
                      pendingPermission: existingSession.interactivePanel?.pendingPermission || null,
                      pendingQuestion: { questions, toolUseId },
                      pendingApproval: existingSession.interactivePanel?.pendingApproval || null,
                    },
                  },
                },
              };
            });
          } else if (toolName === 'ExitPlanMode' && toolInput) {
            // Handle ExitPlanMode tool (plan approval) - this requires user interaction
            console.log('[SessionStore] ExitPlanMode tool detected:', toolInput);
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;
              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...existingSession,
                    interactivePanel: {
                      pendingPermission: existingSession.interactivePanel?.pendingPermission || null,
                      pendingQuestion: existingSession.interactivePanel?.pendingQuestion || null,
                      pendingApproval: { planContent: toolInput, toolUseId },
                    },
                  },
                },
              };
            });
          } else {
            // ★ All other tools (including Write, Edit, Bash) - create tool_use message
            // Note: We use bypassPermissions in SDK, so no permission popup needed
            // The tool will execute automatically, just show it in the tool list
            const activityDetail = getActivityDetail(toolName, toolInput);
            useActivityStore.getState().startActivity(sessionId, {
              type: 'tool_use',
              detail: activityDetail,
              timestamp: Date.now(),
              metadata: { toolName, toolInput },
            });

            // Create independent tool_use message (SpectrAI architecture)
            const toolUseMessage: Message = {
              id: uuidv4(),
              role: 'tool_use',
              content: '', // tool_use messages don't have text content
              timestamp: new Date().toISOString(),
              sessionId,
              toolUseId,
              toolName,
              toolInput: toolInput || {},
            };

            // ★ Batch: enqueue tool_use message for batched state update (reduces re-renders)
            const existingSession = get().sessions[sessionId];
            const existingToolUse = existingSession?.messages.find(
              m => m.role === 'tool_use' && m.toolUseId === toolUseId
            );
            if (existingToolUse) {
              console.log('[SessionStore] Skipping duplicate tool_use message for toolUseId:', toolUseId);
            } else if (findToolUseMessage(sessionId, toolUseId)) {
              console.log('[SessionStore] Skipping duplicate tool_use (in batch) for toolUseId:', toolUseId);
            } else {
              enqueueToolMessage(toolUseMessage, sessionId, set);
              console.log('[SessionStore] Enqueued tool_use message:', toolUseId, toolName);
            }
          }
        } else if (type === 'tool_result') {
          // ★ SpectrAI Architecture: Create independent ToolResultMessage
          const toolUseId = progressEvent.toolUseId;
          const isError = progressEvent.isError || false;

          console.log('[SessionStore] Tool result received:', { toolUseId, isError, content: eventContent?.substring(0, 50) });

          // ★ 查找 toolName（检查 state 和批处理队列）
          let matchingToolName = toolName || 'unknown';
          if (toolUseId) {
            const foundMsg = findToolUseMessage(sessionId, toolUseId);
            if (foundMsg?.toolName) {
              matchingToolName = foundMsg.toolName;
            }
          }

          // ★ Batch: enqueue tool_result for batched state update
          const toolResultMessage: Message = {
            id: uuidv4(),
            role: 'tool_result',
            content: eventContent || '',
            timestamp: new Date().toISOString(),
            sessionId,
            toolUseId: toolUseId || '',
            toolName: matchingToolName,
            toolResult: eventContent || '',
            isError,
          };
          enqueueToolMessage(toolResultMessage, sessionId, set);
          console.log('[SessionStore] Enqueued tool_result message for toolUseId:', toolUseId);

          // ★ 不在这里调用 endActivity！
          // tool_result 只是某个工具的返回结果，父 Agent 可能还在继续执行
          // 只有 complete/error 事件才应该清除活动状态
          // 改为更新活动状态，表示工具已完成
          useActivityStore.getState().startActivity(sessionId, {
            type: 'tool_result',
            detail: matchingToolName ? `${matchingToolName} 完成` : '工具执行完成',
            timestamp: Date.now(),
          });
        } else if (type === 'error') {
          // Flush any pending batches before handling error
          immediateFlushToolBatchForSession(sessionId);
          immediateFlushBufferForSession(sessionId, set);
          // Handle error
          get().updateMessage(sessionId, assistantMessageId, {
            content: `Error: ${eventContent}`,
            isStreaming: false,
            isThinking: false,
          });
          // ★ 重要：结束思考计时器和活动状态
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);
          // ★ 修复：只清理该会话的监听器
          cleanupProgressListenerForSession(sessionId);
        } else if (type === 'complete') {
          // Flush any pending batches before marking complete
          immediateFlushToolBatchForSession(sessionId);
          immediateFlushBufferForSession(sessionId, set);

          // ★ 会话结束时再刷新一次上下文使用量，确保最终值准确
          // 使用 void 显式忽略 Promise，因为回调函数不返回 Promise
          void refreshContextUsage(sessionId, set);

          // Mark streaming as complete and thinking as finished
          get().updateMessage(sessionId, assistantMessageId, {
            isStreaming: false,
            isThinking: false,
          });
          // End thinking timer and clear activity
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);
          // ★ 修复：只清理该会话的监听器和心跳定时器
          cleanupProgressListenerForSession(sessionId);

          // ★ 更新 token 使用量
          console.log('[SessionStore] Complete event received, usageData:', usageData);
          if (usageData) {
            console.log('[SessionStore] Updating token usage with:', usageData);
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;

              const currentUsage = existingSession.tokenUsage || { inputTokens: 0, outputTokens: 0, contextWindow: 200000 };

              // ★ contextWindow：优先使用 SDK 返回的模型真实值
              const newContextWindow = usageData.contextWindow || currentUsage.contextWindow;

              const newUsage = {
                // ★ inputTokens 由 refreshContextUsage 维护（SDK 累积值，即真实值）
                // 这里不追加，避免与 refreshContextUsage 竞态导致重复累加 >100%
                inputTokens: currentUsage.inputTokens,
                // ★ outputTokens：仅展示本次输出，不累加（不参与百分比计算）
                outputTokens: usageData.outputTokens || 0,
                contextWindow: newContextWindow,
              };

              console.log('[SessionStore] Token usage updated:', newUsage);

              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...existingSession,
                    tokenUsage: newUsage,
                  },
                },
              };
            });

            // ★ 流式传输结束后检查是否需要自动压缩
            // 使用共享的 autoCompacted 状态，避免与 SessionToolbar 重复触发
            const latestSession = get().sessions[sessionId];
            const latestUsage = latestSession?.tokenUsage;
            const alreadyCompacted = latestSession?.autoCompacted ?? false;

            if (latestUsage && !alreadyCompacted) {
              const newPercentage = (latestUsage.inputTokens / latestUsage.contextWindow) * 100;
              if (newPercentage > 80) {
                console.log('[SessionStore] Auto-compact needed after message, percentage:', newPercentage.toFixed(1), '%');
                // 设置 autoCompacted 标志，防止重复触发
                get().setAutoCompacted(sessionId, true);
                // 延迟触发，避免阻塞当前响应
                setTimeout(() => {
                  const currentSession = get().sessions[sessionId];
                  // 再次检查，确保仍需要压缩
                  const currentUsage = currentSession?.tokenUsage;
                  if (currentUsage) {
                    const pct = (currentUsage.inputTokens / currentUsage.contextWindow) * 100;
                    if (pct > 80) {
                      console.log('[SessionStore] Triggering delayed auto-compact, percentage:', pct.toFixed(1), '%');
                      get().triggerCompact(sessionId);
                    } else {
                      // 压缩不再需要，重置标志
                      get().setAutoCompacted(sessionId, false);
                    }
                  }
                }, 2000);
              }
            }
          } else {
            console.log('[SessionStore] No usageData in complete event');
          }
        }
      });

      // ★ Step 3: 发送消息
      console.log(`[TRACE-AI] [FRONTEND] Calling claude.sendMessage IPC | traceId=${traceId}`);
      console.log('[SessionStore] Sending message...');
      const sendResult = await window.api.claude.sendMessage(sessionId, content);

      if (!sendResult.success) {
        throw new Error(sendResult.error || 'Failed to send message');
      }

      console.log('[SessionStore] Message sent, waiting for response...');

      // ★ 启动心跳检测
      startHeartbeatCheck(sessionId, assistantMessageId, set);

      // ★ 启动上下文使用量刷新（每 5 秒），支持自动压缩检测
      startContextUsageRefresh(sessionId, set);

      // ★ Step 4: 等待完成（通过进度事件监听器处理）
      // 使用轮询检查 isStreaming 状态
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          // ★ 并发防护：检查是否被新的 sendMessage 取代
          if (sendGenerations.get(sessionId) !== sendGen) {
            clearInterval(checkInterval);
            resolve();
            return;
          }
          const currentSession = get().sessions[sessionId];
          const msg = currentSession?.messages.find(m => m.id === assistantMessageId);
          if (msg && !msg.isStreaming) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });

      // ★ 并发防护：如果被取代，跳过保存，直接退出（finally 清理）
      if (sendGenerations.get(sessionId) !== sendGen) {
        console.log(`[SessionStore] Send superseded for session: ${sessionId}`);
        return;
      }

      console.log(`[SessionStore] Message sent and response received for session: ${sessionId}`);

      // Save session after message exchange
      await get().saveSession(sessionId);

    } catch (error) {
      // Flush any remaining buffered text before showing error
      immediateFlushBufferForSession(sessionId, set);
      // End thinking timer and clear activity
      useActivityStore.getState().endThinking(sessionId);
      useActivityStore.getState().endActivity(sessionId);
      const errorMessage = error instanceof Error ? error.message : String(error);
      get().updateMessage(sessionId, assistantMessageId, {
        content: `发送消息失败: ${errorMessage}`,
        isStreaming: false,
        isThinking: false,
      });
      console.error('[SessionStore] Failed to send message:', error);
    } finally {
      // ★ 并发防护：仅当仍是当前代时才清理，避免误删新 send 的监听器
      if (sendGenerations.get(sessionId) === sendGen) {
        sendGenerations.delete(sessionId);
        cleanupProgressListenerForSession(sessionId);
      }
    }
  },

  /**
   * Restart session connection (reconnect agent, keep history)
   * Reloads messages from disk to ensure history is preserved
   * @param sessionId Session ID
   */
  restartSession: async (sessionId) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    console.log(`[SessionStore] Restarting session: ${sessionId}`);

    // Set status to connecting
    set(state => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          status: 'connecting' as SessionStatus,
          lastActiveAt: new Date().toISOString(),
        },
      },
    }));

    // Get provider and project for session restart
    const agentStore = useAgentStore.getState();
    const providerStore = useProviderStore.getState();
    const projectStore = useProjectStore.getState();

    const providerId = agentStore.config?.providerId;
    if (!providerId) {
      console.error('[SessionStore] No providerId in agent config');
      set(state => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            status: 'error',
          },
        },
      }));
      return;
    }

    await useProviderStore.getState().loadProviders();
    const provider = useProviderStore.getState().providers.find(p => p.id === providerId);
    if (!provider) {
      console.error('[SessionStore] Provider not found:', providerId);
      set(state => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            status: 'error',
          },
        },
      }));
      return;
    }

    const project = projectStore.projects.find(p => p.id === session.projectId);
    if (!project) {
      console.error('[SessionStore] Project not found:', session.projectId);
      set(state => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            status: 'error',
          },
        },
      }));
      return;
    }

    // Reload messages from disk
    const diskSession = await loadSessionFromDisk(sessionId);
    const loadedMessages = diskSession?.messages || session.messages;

    console.log(`[SessionStore] Loaded ${loadedMessages.length} messages from disk for session: ${sessionId}`);

    // Restart the Claude session with proper environment
    const apiKey = provider.apiKey;
    if (!apiKey) {
      console.error('[SessionStore] No API Key configured');
      set(state => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            status: 'error',
          },
        },
      }));
      return;
    }

    const startResult = await window.api.claude.startSession({
      sessionId,
      workingDirectory: project.path,
      apiKey: apiKey,
      baseUrl: provider.baseUrl,
      model: provider.defaultModel,
      apiType: provider.apiType,
      envOverrides: provider.envOverrides,
      contextWindow: provider.contextWindow,  // ★ 传递上下文窗口配置
    });

    if (!startResult.success) {
      console.error('[SessionStore] Failed to restart session:', startResult.error);
      set(state => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            status: 'error',
          },
        },
      }));
      return;
    }

    // ★ 关键修复：必须确保 messages 是全新的数组，这样 React 才会检测到变化
    // 并且要确保 sessionId 作为 activeSessionId 被设置，触发 UI 重新渲染
    // Round-based loading: Only load the most recent INITIAL_ROUNDS
    const messagesToShow = getRecentRounds(loadedMessages, INITIAL_ROUNDS);

    set(state => ({
      activeSessionId: state.activeSessionId || sessionId,  // 确保激活
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          status: 'connected',
          lastActiveAt: new Date().toISOString(),
          messages: messagesToShow,
        },
      },
    }));

    console.log(`[SessionStore] Session restarted: ${sessionId}, messages loaded: ${messagesToShow.length}`);
  },

  /**
   * Reset session to fresh state (new session ID, clear history)
   * @param sessionId Session ID
   */
  resetSession: async (sessionId) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    const oldSessionId = sessionId;
    const newSessionId = uuidv4();
    const now = new Date().toISOString();

    // Create fresh session with new ID
    const newSession: Session = {
      id: newSessionId,
      projectId: session.projectId,
      messages: [],
      createdAt: now,
      lastActiveAt: now,
      status: 'connected',
    };

    // Update state
    set(state => {
      const { [oldSessionId]: _, ...remainingSessions } = state.sessions;
      return {
        sessions: {
          ...remainingSessions,
          [newSessionId]: newSession,
        },
        activeSessionId: state.activeSessionId === oldSessionId ? newSessionId : state.activeSessionId,
      };
    });

    // Delete old session file
    const oldFilePath = await getSessionFilePath(oldSessionId);
    await deleteFile(oldFilePath);

    // Save new session
    await get().saveSession(newSessionId);

    console.log(`[SessionStore] Session reset: ${oldSessionId} -> ${newSessionId}`);
  },

  /**
   * Load paginated history messages (round-based)
   * Returns messages from disk that are NOT already in the current session.
   * This is used for "load older messages" functionality.
   * @param sessionId Session ID
   * @param _page Page number (1-based) - not used, kept for API compatibility
   * @returns Array of messages for the page in **chronological order** (oldest first).
   *          This is suitable for prepending to the message list.
   *          Only returns messages NOT already in session.messages.
   */
  loadHistory: async (sessionId, _page) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return [];
    }

    const sessionData = await loadSessionFromDisk(sessionId);

    if (!sessionData) {
      console.log(`[SessionStore] No history file found for session: ${sessionId}`);
      return [];
    }

    const diskMessages = sessionData.messages || [];

    // ★ Round-based loading: Load older messages by conversation rounds
    const pageMessages = getOlderRounds(diskMessages, session.messages, ROUNDS_PER_PAGE);

    console.log(`[SessionStore] Loaded ${pageMessages.length} history messages (${ROUNDS_PER_PAGE} rounds) for session: ${sessionId}`);

    return pageMessages;
  },

  /**
   * Save session to persistent storage
   * @param sessionId Session ID
   */
  saveSession: async (sessionId) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    console.log(`[SessionStore] Saving session: ${sessionId}, messages: ${session.messages?.length || 0}`);

    try {
      const success = await saveSessionToDisk(session);

      if (success) {
        console.log(`[SessionStore] Session saved successfully: ${sessionId}`);
      } else {
        console.error(`[SessionStore] Failed to save session: ${sessionId}`);
      }
    } catch (error) {
      console.error('[SessionStore] Failed to save session:', error);
    }
  },

  /**
   * Set the active session
   * @param sessionId Session ID or null
   */
  setActiveSession: (sessionId) => {
    set({ activeSessionId: sessionId });
    console.log(`[SessionStore] Active session set to: ${sessionId}`);
  },

  /**
   * Delete a session
   * @param sessionId Session ID
   */
  deleteSession: async (sessionId) => {
    const { sessions, activeSessionId, projectSessionIndex } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    // Remove from state and update index
    set(state => {
      const { [sessionId]: _, ...remainingSessions } = state.sessions;

      // Update index: remove projectId mapping
      const newProjectSessionIndex = new Map(state.projectSessionIndex);
      if (session.projectId) {
        // Only delete if this session is the one in the index
        if (newProjectSessionIndex.get(session.projectId) === sessionId) {
          newProjectSessionIndex.delete(session.projectId);
        }
      }

      return {
        sessions: remainingSessions,
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
        projectSessionIndex: newProjectSessionIndex,
      };
    });

    // Delete session file
    const filePath = await getSessionFilePath(sessionId);
    await deleteFile(filePath);

    // Clear activity store data for this session
    useActivityStore.getState().clearSession(sessionId);

    console.log(`[SessionStore] Session deleted: ${sessionId}`);
  },

  /**
   * Get session by project ID
   * Uses index for O(1) lookup
   * @param projectId Project ID
   * @returns Session or undefined
   */
  /**
   * Get session by project ID
   * First checks the index, then falls back to direct search if index miss
   * @param projectId Project ID
   * @returns Session or undefined
   */
  getSessionByProjectId: (projectId) => {
    const { sessions, projectSessionIndex } = get();

    // Primary lookup: via index (O(1))
    const sessionId = projectSessionIndex.get(projectId);
    if (sessionId && sessions[sessionId]) {
      return sessions[sessionId];
    }

    // Fallback: direct search in sessions (O(n)) - handles index miss
    const foundSession = Object.values(sessions).find(s => s.projectId === projectId);
    if (foundSession) {
      console.log(`[SessionStore] getSessionByProjectId: Found session by direct search (index miss) for project: ${projectId}`);
      // Auto-repair index
      set(state => ({
        projectSessionIndex: new Map(state.projectSessionIndex).set(projectId, foundSession.id),
      }));
      return foundSession;
    }

    return undefined;
  },

  /**
   * Add an assistant message to the session
   * @param sessionId Session ID
   * @param content Message content
   * @param isStreaming Whether the message is streaming
   * @returns Message ID
   */
  addAssistantMessage: (sessionId, content, isStreaming = false) => {
    const messageId = uuidv4();
    const message: Message = {
      id: messageId,
      role: 'assistant',
      content,
      timestamp: new Date().toISOString(),
      isStreaming,
      thinkingText: '',
      isThinking: false,
    };

    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      const updatedMessages = trimMessages([...session.messages, message]);

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messages: updatedMessages,
            lastActiveAt: new Date().toISOString(),
          },
        },
      };
    });

    console.log(`[SessionStore] Assistant message added: ${messageId}`);
    return messageId;
  },

  /**
   * Update an existing message
   * @param sessionId Session ID
   * @param messageId Message ID
   * @param updates Partial message updates
   */
  updateMessage: (sessionId, messageId, updates) => {
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      const updatedMessages = session.messages.map(m =>
        m.id === messageId ? { ...m, ...updates } : m
      );

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messages: updatedMessages,
            lastActiveAt: new Date().toISOString(),
          },
        },
      };
    });
  },

  /**
   * Close session and cleanup resources
   * @param sessionId Session ID
   */
  closeSession: async (sessionId) => {
    console.log(`[SessionStore] Closing session: ${sessionId}`);

    // ★ 修复：先将所有 streaming 消息标记为完成，解锁 sendMessage 轮询 Promise
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      const hasStreaming = session.messages.some(m => m.isStreaming);
      if (!hasStreaming) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messages: session.messages.map(m =>
              m.isStreaming ? { ...m, isStreaming: false, isThinking: false } : m
            ),
          },
        },
      };
    });

    // ★ 修复：只清理该会话的监听器和缓冲区，不影响其他会话
    cleanupProgressListenerForSession(sessionId);

    // 通知主进程关闭会话
    try {
      await window.api.claude.closeSession(sessionId);
    } catch (err) {
      console.warn('[SessionStore] Error closing session in main process:', err);
    }

    // Clear activity store data for this session
    useActivityStore.getState().clearSession(sessionId);

    console.log(`[SessionStore] Session closed: ${sessionId}`);
  },

  /**
   * Check if store is initialized
   * @returns Whether the store has been initialized
   */
  isInitialized: () => initialized,

  /**
   * Set interactive panel state
   * @param sessionId Session ID
   * @param panel Partial panel state to set
   */
  setInteractivePanel: (sessionId, panel) => {
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            interactivePanel: {
              pendingPermission: panel.pendingPermission ?? session.interactivePanel?.pendingPermission ?? null,
              pendingQuestion: panel.pendingQuestion ?? session.interactivePanel?.pendingQuestion ?? null,
              pendingApproval: panel.pendingApproval ?? session.interactivePanel?.pendingApproval ?? null,
            },
          },
        },
      };
    });
  },

  /**
   * Clear interactive panel state
   * @param sessionId Session ID
   */
  clearInteractivePanel: (sessionId) => {
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            interactivePanel: {
              pendingPermission: null,
              pendingQuestion: null,
              pendingApproval: null,
            },
          },
        },
      };
    });
  },

  /**
   * Respond to permission request
   * @param sessionId Session ID
   * @param allowed Whether to allow the action
   */
  respondToPermission: async (sessionId, allowed) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    const pendingPermission = session?.interactivePanel?.pendingPermission;

    if (!pendingPermission) {
      console.warn('[SessionStore] No pending permission to respond to');
      return;
    }

    console.log(`[TRACE-AI] [FRONTEND] respondToPermission calling claude.sendMessage | sessionId=${sessionId} | allowed=${allowed}`);
    console.log('[SessionStore] Responding to permission:', allowed);

    // Send response via IPC (send as user message with tool result)
    try {
      const responseMessage = allowed
        ? 'Permission granted. Proceed with the action.'
        : 'Permission denied. Please do not proceed with this action.';

      await window.api.claude.sendMessage(sessionId, responseMessage);

      // Clear the pending state
      get().clearInteractivePanel(sessionId);
    } catch (error) {
      console.error('[SessionStore] Failed to respond to permission:', error);
    }
  },

  /**
   * Respond to question
   * @param sessionId Session ID
   * @param answers User's answers
   */
  respondToQuestion: async (sessionId, answers) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    const pendingQuestion = session?.interactivePanel?.pendingQuestion;

    if (!pendingQuestion) {
      console.warn('[SessionStore] No pending question to respond to');
      return;
    }

    console.log('[SessionStore] Responding to question:', answers);

    // ★ 调用 answerQuestion IPC 将答案传回 SDK 的 canUseTool 回调
    // 不能使用 sendMessage，因为那会发送新消息而不是回答工具调用
    try {
      const result = await window.api.claude.answerQuestion(sessionId, answers);
      console.log('[SessionStore] answerQuestion result:', result);

      // Clear the pending state
      get().clearInteractivePanel(sessionId);
    } catch (error) {
      console.error('[SessionStore] Failed to respond to question:', error);
    }
  },

  /**
   * Respond to plan approval
   * @param sessionId Session ID
   * @param approved Whether to approve the plan
   */
  respondToApproval: async (sessionId, approved) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    const pendingApproval = session?.interactivePanel?.pendingApproval;

    if (!pendingApproval) {
      console.warn('[SessionStore] No pending approval to respond to');
      return;
    }

    console.log(`[TRACE-AI] [FRONTEND] respondToApproval calling claude.sendMessage | sessionId=${sessionId} | approved=${approved}`);
    console.log('[SessionStore] Responding to approval:', approved);

    // Send approval response
    try {
      const responseMessage = approved
        ? 'Plan approved. Please proceed with the execution.'
        : 'Plan rejected. Please revise the plan or ask for clarification.';

      await window.api.claude.sendMessage(sessionId, responseMessage);

      // Clear the pending state
      get().clearInteractivePanel(sessionId);
    } catch (error) {
      console.error('[SessionStore] Failed to respond to approval:', error);
    }
  },

  /**
   * Prepend history messages to the beginning of message list
   * Used when loading older messages from disk for scroll-up history loading
   * @param sessionId Session ID
   * @param messages Messages to prepend (in chronological order, oldest first)
   */
  prependMessages: (sessionId, messages) => {
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      // Deduplicate: filter out messages that already exist
      const existingIds = new Set(session.messages.map(m => m.id));
      const newMessages = messages.filter(m => !existingIds.has(m.id));

      if (newMessages.length === 0) return state;

      // Add to the beginning of message list
      const updatedMessages = trimMessages([...newMessages, ...session.messages]);

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messages: updatedMessages,
          },
        },
      };
    });

    console.log(`[SessionStore] Prepended ${messages.length} messages to session: ${sessionId}`);
  },

  /**
   * Trigger compact and refresh context usage
   * Sends /compact command and waits for SDK compact_boundary event
   * @param sessionId Session ID
   */
  triggerCompact: async (sessionId) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    console.log(`[TRACE-AI] [FRONTEND] triggerCompact ENTRY | sessionId=${sessionId}`);
    console.log(`[SessionStore] Triggering compact for session: ${sessionId}`);

    try {
      // 设置临时监听器，等待 SDK 的 compact_boundary 事件
      const compactComplete = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          console.log('[SessionStore] Compact timeout, proceeding anyway');
          resolve();
        }, 15000);

        const cleanup = window.api.claude.onProgress((event) => {
          if (event.sessionId !== sessionId) return;
          if (event.type === 'status' && event.statusData?.status === 'compact_boundary') {
            console.log('[SessionStore] Compact boundary received, compaction complete');
            clearTimeout(timeout);
            cleanup();
            resolve();
          }
        });
      });

      // 发送 /compact 命令（仅压缩，不发送额外消息）
      console.log(`[TRACE-AI] [FRONTEND] triggerCompact calling claude.sendMessage('/compact') | sessionId=${sessionId}`);
      await window.api.claude.sendMessage(sessionId, '/compact');
      console.log('[SessionStore] /compact command sent');

      // 等待 compact_boundary 事件或 15 秒超时
      await compactComplete;

      // 刷新上下文使用量
      await refreshContextUsage(sessionId, set);
      console.log(`[SessionStore] Context usage refreshed after compact for session: ${sessionId}`);

      // ★ 新增：验证压缩效果
      const updatedSession = get().sessions[sessionId];
      const usage = updatedSession?.tokenUsage;
      if (usage) {
        const newPercentage = (usage.inputTokens / usage.contextWindow) * 100;
        console.log('[SessionStore] After compact, percentage:', newPercentage.toFixed(1), '%');

        // 如果压缩后仍 > 80%，记录警告
        if (newPercentage > 80) {
          console.warn('[SessionStore] ⚠️ Compact ineffective, still at', newPercentage.toFixed(1), '%');
        } else {
          console.log('[SessionStore] ✅ Compact effective, reduced to', newPercentage.toFixed(1), '%');
          // ★ 压缩成功，重置 autoCompacted 标志，允许后续再次触发自动压缩
          get().setAutoCompacted(sessionId, false);
        }
      }

    } catch (error) {
      console.error('[SessionStore] Failed to trigger compact:', error);
    }
  },

  /**
   * Update token usage (for auto-compact detection)
   * @param sessionId Session ID
   * @param usage Token usage data
   */
  updateTokenUsage: (sessionId, usage) => {
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            tokenUsage: usage,
          },
        },
      };
    });
  },

  /**
   * Update input draft - save unsent text when switching sessions/tabs
   * @param sessionId Session ID
   * @param draft Input draft text
   */
  updateInputDraft: (sessionId, draft) => {
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            inputDraft: draft,
          },
        },
      };
    });
  },

  /**
   * Set auto-compacted flag - prevents repeated auto-compact within same session
   * @param sessionId Session ID
   * @param value Auto-compacted flag value
   */
  setAutoCompacted: (sessionId, value) => {
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            autoCompacted: value,
          },
        },
      };
    });
  },
}));
