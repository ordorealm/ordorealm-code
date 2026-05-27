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
  if (messages.length === 0) return [];

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
  if (allMessages.length === 0) return [];

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
// ─────────────────────────────────────────────────────────────────────────────

let progressListenerCleanup: (() => void) | null = null;
let currentProgressSessionId: string | null = null;
/** ★ 当前活跃的进度回调引用，用于重连时重建监听器 */
let currentProgressCallback: ((event: any) => void) | null = null;
/** ★ 上次收到进度事件的时间，用于检测连接是否断开 */
let lastProgressEventTime: number = 0;
/** ★ 心跳检测定时器 */
let heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
/** ★ 自适应心跳超时（退火策略）：第 1 次 10 分钟，第 2 次 20 分钟，第 3 次起 30 分钟 */
const HEARTBEAT_TIMEOUTS = [600000, 1200000, 1800000]; // 10min, 20min, 30min
/** ★ 心跳超时计数（每次 sendMessage 重置为 0） */
let heartbeatTimeoutCount = 0;
/** ★ 连接恢复提示的定时器引用（用于清理） */
let connectionNoticeTimer: ReturnType<typeof setTimeout> | null = null;

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
  // 清理旧的监听器
  if (progressListenerCleanup) {
    progressListenerCleanup();
    progressListenerCleanup = null;
  }

  // 清理旧的心跳检测
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }

  currentProgressSessionId = sessionId;
  currentProgressCallback = onProgress;
  lastProgressEventTime = Date.now();
  heartbeatTimeoutCount = 0;

  // 设置新的监听器
  progressListenerCleanup = window.api.claude.onProgress((event) => {
    // 更新最后收到事件的时间
    lastProgressEventTime = Date.now();

    // ★ 方案 A：按 event.sessionId 过滤（修复会话内容串扰问题）
    // 主进程发送的所有 progress 事件都包含 sessionId 字段
    // 如果 sessionId 不匹配，忽略该事件
    if (event.sessionId && event.sessionId !== sessionId) {
      console.log(`[SessionStore] Ignoring event for different session: ${event.sessionId} (current: ${sessionId})`);
      return;
    }

    // 如果事件没有 sessionId 字段（旧版本兼容），也忽略
    // 这确保只有当前会话的事件被处理
    if (!event.sessionId) {
      console.warn(`[SessionStore] Received event without sessionId, ignoring (current: ${sessionId})`);
      return;
    }

    onProgress(event);
  });

  console.log(`[SessionStore] Progress listener setup for session: ${sessionId}`);
}

/**
 * 清理进度事件监听器
 */
function cleanupProgressListener(): void {
  // ★ 确保所有待处理的批量工具消息已写入
  immediateFlushToolBatch();
  if (progressListenerCleanup) {
    progressListenerCleanup();
    progressListenerCleanup = null;
    currentProgressSessionId = null;
    currentProgressCallback = null;
  }
  // 清理心跳检测
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }
  // 清理连接恢复提示定时器
  if (connectionNoticeTimer) {
    clearTimeout(connectionNoticeTimer);
    connectionNoticeTimer = null;
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
  // 清理旧的定时器
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
  }

  heartbeatCheckTimer = setInterval(() => {
    const now = Date.now();
    const timeSinceLastEvent = now - lastProgressEventTime;

    // ★ 自适应超时：根据超时次数选择退火时间
    const currentTimeout = HEARTBEAT_TIMEOUTS[Math.min(heartbeatTimeoutCount, HEARTBEAT_TIMEOUTS.length - 1)];

    if (timeSinceLastEvent > currentTimeout) {
      heartbeatTimeoutCount++;
      const timeoutMinutes = Math.round(currentTimeout / 60000);
      console.warn(`[SessionStore] Heartbeat timeout #${heartbeatTimeoutCount} for session: ${sessionId}, last event was ${Math.round(timeSinceLastEvent / 1000)}s ago (threshold: ${timeoutMinutes}min)`);

      // ★ 前 2 次超时：先尝试重连（ping 后端确认存活状态）
      if (heartbeatTimeoutCount < 3) {
        (async () => {
          try {
            const pingResult = await window.api.claude.pingSession(sessionId);
            if (pingResult.alive) {
              // 后端流仍存活 → 重置时间戳（监听器仍活跃，无需重建），重启心跳
              console.warn(`[SessionStore] Backend stream is alive (status: ${pingResult.status}), reconnecting...`);
              lastProgressEventTime = Date.now();
              // ★ 重启心跳检测（cleanupProgressListener 之后可能被调用过，这里显式重建）
              startHeartbeatCheck(sessionId, assistantMessageId, set);
              // ★ 设置 UI 提示（3 秒后自动清除）
              if (connectionNoticeTimer) clearTimeout(connectionNoticeTimer);
              set(state => {
                const s = state.sessions[sessionId];
                if (!s) return state;
                return { sessions: { ...state.sessions, [sessionId]: { ...s, connectionNotice: '连接已恢复' } } };
              });
              connectionNoticeTimer = setTimeout(() => {
                connectionNoticeTimer = null;
                set(state => {
                  const s = state.sessions[sessionId];
                  if (!s || s.connectionNotice !== '连接已恢复') return state;
                  return { sessions: { ...state.sessions, [sessionId]: { ...s, connectionNotice: null } } };
                });
              }, 3000);
              return;
            }
            console.warn(`[SessionStore] Backend stream is dead (status: ${pingResult.status}), aborting...`);
          } catch (err) {
            console.warn('[SessionStore] pingSession failed:', err);
          }
          // ping 失败或后端已死 → 执行中止
          performHeartbeatAbort(sessionId, assistantMessageId, set, timeoutMinutes);
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
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
  }

  (async () => {
    try {
      await window.api.claude.abort(sessionId);
      console.log('[SessionStore] Session abort request sent successfully');
    } catch (err) {
      console.warn('[SessionStore] Failed to abort session:', err);
    }
  })();

  immediateFlushBuffer(set, sessionId);
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
  cleanupProgressListener();
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

/** Global streaming buffer instance */
const streamingBuffer: StreamingBuffer = {
  pendingText: '',
  flushTimer: null,
  messageId: null,
  sessionId: null,
};

/** Delay in ms before flushing buffered updates (use requestAnimationFrame-like timing) */
const STREAM_FLUSH_DELAY = 16; // ~60fps

// ── Tool message batch queue ──────────────────────────────────────────────────
// Reduces React re-renders during long tool-heavy tasks (300+ tool calls):
// instead of one set() per tool event, batch up to 500ms of tool messages
// and apply them in a single state update.

interface ToolBatchEntry {
  message: Message
}

const toolBatch: {
  queue: ToolBatchEntry[]
  flushTimer: ReturnType<typeof setTimeout> | null
  sessionId: string | null
  setFn: SetFunction | null
} = {
  queue: [],
  flushTimer: null,
  sessionId: null,
  setFn: null,
}

const TOOL_BATCH_DELAY = 500

function flushToolBatch(): void {
  if (toolBatch.queue.length === 0) return
  const { queue, sessionId, setFn } = toolBatch
  if (!sessionId || !setFn) {
    toolBatch.queue = []
    return
  }
  if (toolBatch.flushTimer) {
    clearTimeout(toolBatch.flushTimer)
    toolBatch.flushTimer = null
  }

  const batchMessages = queue.map((q) => q.message)
  const batchIds = new Set(batchMessages.map((m) => m.id))
  toolBatch.queue = []

  setFn((state) => {
    const existingSession = state.sessions[sessionId]
    if (!existingSession) return state
    // Deduplicate: skip messages whose ID already exists in state
    const existingIds = new Set(existingSession.messages.map((m) => m.id))
    const newMessages = batchMessages.filter((m) => !existingIds.has(m.id))
    if (newMessages.length === 0) return state
    const updatedMessages = trimMessages([...existingSession.messages, ...newMessages])
    return {
      sessions: {
        ...state.sessions,
        [sessionId]: { ...existingSession, messages: updatedMessages },
      },
    }
  })
}

function enqueueToolMessage(message: Message, sessionId: string, setFn: SetFunction): void {
  // Flush if switching sessions
  if (toolBatch.sessionId !== sessionId && toolBatch.queue.length > 0) {
    flushToolBatch()
  }
  toolBatch.sessionId = sessionId
  toolBatch.setFn = setFn
  toolBatch.queue.push({ message })

  if (!toolBatch.flushTimer) {
    toolBatch.flushTimer = setTimeout(flushToolBatch, TOOL_BATCH_DELAY)
  }
}

/** Flush tool batch immediately (called before non-tool events like text/complete/error) */
function immediateFlushToolBatch(): void {
  if (toolBatch.flushTimer) {
    clearTimeout(toolBatch.flushTimer)
    toolBatch.flushTimer = null
  }
  flushToolBatch()
}

/** Look up a tool_use message from state AND pending batch queue */
function findToolUseMessage(sessionId: string, toolUseId: string): Message | undefined {
  // Check batch queue first (newest messages)
  for (const entry of toolBatch.queue) {
    if (entry.message.role === 'tool_use' && entry.message.toolUseId === toolUseId) {
      return entry.message
    }
  }
  // Fall back to state
  const existingSession = useSessionStore.getState().sessions[sessionId]
  return existingSession?.messages.find(
    (m) => m.role === 'tool_use' && m.toolUseId === toolUseId
  )
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
 * @param set Zustand set function
 */
function flushStreamingBuffer(set: SetFunction): void {
  if (!streamingBuffer.messageId || !streamingBuffer.sessionId || !streamingBuffer.pendingText) {
    return;
  }

  const sessionId = streamingBuffer.sessionId;
  const messageId = streamingBuffer.messageId;
  const textToAdd = streamingBuffer.pendingText;

  // Clear buffer before updating to prevent duplicate flushes
  streamingBuffer.pendingText = '';
  streamingBuffer.flushTimer = null;

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
  // Initialize buffer for new message if needed
  if (streamingBuffer.messageId !== messageId) {
    // Flush any previous buffer first (only if same session to avoid cross-session pollution)
    if (streamingBuffer.flushTimer !== null && streamingBuffer.sessionId === sessionId) {
      clearTimeout(streamingBuffer.flushTimer);
      flushStreamingBuffer(set);
    }
    streamingBuffer.messageId = messageId;
    streamingBuffer.sessionId = sessionId;
    streamingBuffer.pendingText = '';
    streamingBuffer.flushTimer = null;
  }

  // Guard: Only accumulate text if this is the current session's buffer
  // This prevents race conditions when multiple sessions stream simultaneously
  if (streamingBuffer.sessionId !== sessionId) {
    console.warn(`[SessionStore] Buffer race condition detected: expected session ${streamingBuffer.sessionId}, got ${sessionId}. Skipping.`);
    return;
  }

  // Accumulate text in buffer
  streamingBuffer.pendingText += text;

  // Schedule flush if not already scheduled
  if (streamingBuffer.flushTimer === null) {
    streamingBuffer.flushTimer = window.setTimeout(() => {
      flushStreamingBuffer(set);
    }, STREAM_FLUSH_DELAY);
  }
}

/**
 * Immediately flush the buffer and reset streaming state
 * Called on complete or error events
 * @param set Zustand set function
 * @param sessionId Optional session ID to validate before flushing (prevents cross-session flush)
 */
function immediateFlushBuffer(set: SetFunction, sessionId?: string): void {
  // ★ Flush pending tool batch first (preserves message ordering)
  immediateFlushToolBatch();

  // Guard: Only flush if session matches (when sessionId is provided)
  if (sessionId && streamingBuffer.sessionId !== sessionId) {
    console.warn(`[SessionStore] immediateFlushBuffer: session mismatch, expected ${streamingBuffer.sessionId}, got ${sessionId}. Skipping flush.`);
    streamingBuffer.messageId = null;
    streamingBuffer.sessionId = null;
    return;
  }

  if (streamingBuffer.flushTimer !== null) {
    clearTimeout(streamingBuffer.flushTimer);
  }
  flushStreamingBuffer(set);
  streamingBuffer.messageId = null;
  streamingBuffer.sessionId = null;
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

    // Use index for O(1) lookup
    const { sessions, projectSessionIndex } = get();
    console.log(`[SessionStore] createSession called for project: ${projectId}`);

    const existingSessionId = projectSessionIndex.get(projectId);
    if (existingSessionId && sessions[existingSessionId]) {
      // Set the existing session as active
      set({ activeSessionId: existingSessionId });
      console.log(`[SessionStore] Reusing existing session: ${existingSessionId} for project: ${projectId}`);
      return existingSessionId;
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

    console.log('[SessionStore] sendMessage called:', { sessionId, content: content.substring(0, 50) });

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

            // 从 Provider 获取 contextWindow
            const providerContextWindow = provider.contextWindow || 200000;
            console.log('[SessionStore] Provider contextWindow:', providerContextWindow);

            // 始终更新 contextWindow（用户可能修改了 Provider 配置）
            const currentUsage = existingSession.tokenUsage || { inputTokens: 0, outputTokens: 0, contextWindow: providerContextWindow };

            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...existingSession,
                  initData,
                  // 更新 tokenUsage，使用 Provider 配置的 contextWindow
                  tokenUsage: {
                    ...currentUsage,
                    contextWindow: providerContextWindow,
                  },
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
          immediateFlushToolBatch();
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
          immediateFlushToolBatch();
          immediateFlushBuffer(set, sessionId);
          // Handle error
          get().updateMessage(sessionId, assistantMessageId, {
            content: `Error: ${eventContent}`,
            isStreaming: false,
            isThinking: false,
          });
          // ★ 重要：结束思考计时器和活动状态
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);
          // 清理进度监听器
          cleanupProgressListener();
        } else if (type === 'complete') {
          // Flush any pending batches before marking complete
          immediateFlushToolBatch();
          immediateFlushBuffer(set, sessionId);
          // Mark streaming as complete and thinking as finished
          get().updateMessage(sessionId, assistantMessageId, {
            isStreaming: false,
            isThinking: false,
          });
          // End thinking timer and clear activity
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);
          // ★ 重要：清理进度监听器和心跳定时器
          cleanupProgressListener();

          // ★ 更新 token 使用量
          console.log('[SessionStore] Complete event received, usageData:', usageData);
          if (usageData) {
            console.log('[SessionStore] Updating token usage with:', usageData);
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;

              // 累积 token 使用量
              const currentUsage = existingSession.tokenUsage || { inputTokens: 0, outputTokens: 0, contextWindow: 200000 };

              // ★ 优先使用较大的 contextWindow 值
              // SDK 可能返回模型真实值，Provider 配置可能是用户扩展的（如 DeepSeek [1m]）
              const newContextWindow = Math.max(
                usageData.contextWindow || 0,
                currentUsage.contextWindow,
                provider.contextWindow || 0
              );

              const newUsage = {
                inputTokens: currentUsage.inputTokens + usageData.inputTokens,
                outputTokens: currentUsage.outputTokens + usageData.outputTokens,
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
          } else {
            console.log('[SessionStore] No usageData in complete event');
          }
        }
      });

      // ★ Step 3: 发送消息
      console.log('[SessionStore] Sending message...');
      const sendResult = await window.api.claude.sendMessage(sessionId, content);

      if (!sendResult.success) {
        throw new Error(sendResult.error || 'Failed to send message');
      }

      console.log('[SessionStore] Message sent, waiting for response...');

      // ★ 启动心跳检测
      startHeartbeatCheck(sessionId, assistantMessageId, set);

      // ★ Step 4: 等待完成（通过进度事件监听器处理）
      // 使用轮询检查 isStreaming 状态
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          const currentSession = get().sessions[sessionId];
          const msg = currentSession?.messages.find(m => m.id === assistantMessageId);
          if (msg && !msg.isStreaming) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);
      });

      console.log(`[SessionStore] Message sent and response received for session: ${sessionId}`);

      // Save session after message exchange
      await get().saveSession(sessionId);

    } catch (error) {
      // Flush any remaining buffered text before showing error
      immediateFlushBuffer(set, sessionId);
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
      // 清理进度监听器
      cleanupProgressListener();
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
  getSessionByProjectId: (projectId) => {
    const { sessions, projectSessionIndex } = get();
    const sessionId = projectSessionIndex.get(projectId);
    if (!sessionId) return undefined;
    return sessions[sessionId];
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

    // 清理进度监听器
    cleanupProgressListener();

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
   * Trigger compact and reload Claude.md
   * Sends /compact command followed by Claude.md reload prompt
   * @param sessionId Session ID
   */
  triggerCompact: async (sessionId) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    console.log(`[SessionStore] Triggering compact for session: ${sessionId}`);

    try {
      // 1. 发送 /compact 命令
      await window.api.claude.sendMessage(sessionId, '/compact');

      // 2. 等待压缩完成
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 3. 读取项目 .claude/Claude.md 文件
      const projectStore = useProjectStore.getState();
      const project = projectStore.projects.find(p => p.id === session.projectId);

      if (project?.path) {
        const claudeMdPath = `${project.path}/.claude/Claude.md`;
        try {
          const result = await window.api.fs.readFile(claudeMdPath);
          if (result.success && result.content) {
            // 4. 发送回顾提示词
            const reloadPrompt = `上下文已压缩。请重新阅读项目 .claude/Claude.md 文件，回顾当前项目的执行流程和规范，确保后续操作符合项目约定。

文件内容：
${result.content}`;

            await window.api.claude.sendMessage(sessionId, reloadPrompt);
            console.log(`[SessionStore] Claude.md reloaded for session: ${sessionId}`);
          } else {
            console.log(`[SessionStore] No .claude/Claude.md found for project: ${project.path}`);
          }
        } catch (err) {
          console.warn('[SessionStore] Failed to read Claude.md:', err);
        }
      }

      // 5. 重置 token 使用量（压缩后会减少）
      set(state => {
        const existingSession = state.sessions[sessionId];
        if (!existingSession || !existingSession.tokenUsage) return state;

        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...existingSession,
              tokenUsage: {
                ...existingSession.tokenUsage,
                inputTokens: Math.floor(existingSession.tokenUsage.inputTokens * 0.3), // 估算压缩后剩余 30%
              },
            },
          },
        };
      });

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
}));
