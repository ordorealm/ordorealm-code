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

/** Maximum number of messages per session in memory */
const MAX_MESSAGES = 500;

/** Initial number of messages to load on startup */
const INITIAL_MESSAGES = 20;

/** Messages per page for history loading */
const MESSAGES_PER_PAGE = 20;

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
/** ★ 上次收到进度事件的时间，用于检测连接是否断开 */
let lastProgressEventTime: number = 0;
/** ★ 心跳检测定时器 */
let heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
/** ★ 心跳超时时间（毫秒）- 如果超过这个时间没有收到任何事件，认为连接断开 */
const HEARTBEAT_TIMEOUT = 300000; // 5分钟（给长时间操作足够时间）
/** ★ 全局超时时间（毫秒）- 操作最大允许时间 */
const GLOBAL_TIMEOUT = 600000; // 10分钟

/**
 * 设置进度事件监听器
 * 当有活跃会话时，监听主进程发送的进度事件
 */
function setupProgressListener(
  sessionId: string,
  onProgress: (event: {
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
    statusData?: {
      status: string;
      reason?: string;
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
  lastProgressEventTime = Date.now();

  // 设置新的监听器
  progressListenerCleanup = window.api.claude.onProgress((event) => {
    // 更新最后收到事件的时间
    lastProgressEventTime = Date.now();
    // 只处理当前会话的事件
    if (currentProgressSessionId !== sessionId) return;
    onProgress(event);
  });

  console.log(`[SessionStore] Progress listener setup for session: ${sessionId}`);
}

/**
 * 清理进度事件监听器
 */
function cleanupProgressListener(): void {
  if (progressListenerCleanup) {
    progressListenerCleanup();
    progressListenerCleanup = null;
    currentProgressSessionId = null;
  }
  // 清理心跳检测
  if (heartbeatCheckTimer) {
    clearInterval(heartbeatCheckTimer);
    heartbeatCheckTimer = null;
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

    if (timeSinceLastEvent > HEARTBEAT_TIMEOUT) {
      console.warn(`[SessionStore] Heartbeat timeout detected for session: ${sessionId}, last event was ${Math.round(timeSinceLastEvent / 1000)}s ago`);

      // 清理心跳检测
      if (heartbeatCheckTimer) {
        clearInterval(heartbeatCheckTimer);
        heartbeatCheckTimer = null;
      }

      // 设置错误状态
      immediateFlushBuffer(set, sessionId);
      set(state => {
        const existingSession = state.sessions[sessionId];
        if (!existingSession) return state;

        const updatedMessages = existingSession.messages.map(m =>
          m.id === assistantMessageId
            ? { ...m, isStreaming: false, content: m.content + '\n\n⚠️ 连接超时（5分钟无响应），请检查后端服务是否正常。如需继续，可尝试重新发送消息。' }
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

      // 结束思考计时器和活动状态
      useActivityStore.getState().endThinking(sessionId);
      useActivityStore.getState().endActivity(sessionId);
      cleanupProgressListener();
    } else {
      // ★ 每次检查时输出日志，方便调试
      console.log(`[SessionStore] Heartbeat check for session: ${sessionId}, time since last event: ${Math.round(timeSinceLastEvent / 1000)}s`);
    }
  }, 60000); // 每 60 秒检查一次（减少检查频率）
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
 * @param messages Message array
 * @returns Trimmed message array
 */
function trimMessages(messages: Message[]): Message[] {
  if (messages.length <= MAX_MESSAGES) {
    return messages;
  }
  // Keep the most recent messages
  return messages.slice(messages.length - MAX_MESSAGES);
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
                  // ★ Fix: Only load the most recent INITIAL_MESSAGES on startup
                  // User can load older messages via "load history" button
                  const trimmedSession: Session = {
                    ...sessionData,
                    messages: sessionData.messages.length > INITIAL_MESSAGES
                      ? sessionData.messages.slice(-INITIAL_MESSAGES)
                      : sessionData.messages,
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
          // 处理状态事件（如 api_retry）
          console.log('[SessionStore] Status event:', statusData);
          if (statusData.status === 'retrying') {
            useActivityStore.getState().startActivity(sessionId, {
              type: 'status',
              detail: 'API 重试中...',
              timestamp: Date.now(),
            });
          }
        } else if (type === 'text') {
          // Use buffering to reduce re-renders during streaming
          bufferStreamingText(sessionId, assistantMessageId, eventContent, set);
          // Update activity: AI is responding
          useActivityStore.getState().startActivity(sessionId, {
            type: 'thinking',
            detail: '正在回复...',
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

            // Add tool_use message as independent message in the messages array
            // ★ Deduplication: Check if a tool_use message with this toolUseId already exists
            // This prevents duplicates when both content_block_start and assistant message emit the same tool call
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;

              // Skip if a tool_use message with this toolUseId already exists
              const existingToolUse = existingSession.messages.find(
                m => m.role === 'tool_use' && m.toolUseId === toolUseId
              );
              if (existingToolUse) {
                console.log('[SessionStore] Skipping duplicate tool_use message for toolUseId:', toolUseId);
                return state;
              }

              const updatedMessages = trimMessages([...existingSession.messages, toolUseMessage]);

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

            console.log('[SessionStore] Created independent tool_use message:', toolUseId, toolName);
          }
        } else if (type === 'tool_result') {
          // ★ SpectrAI Architecture: Create independent ToolResultMessage
          const toolUseId = progressEvent.toolUseId;
          const isError = progressEvent.isError || false;

          console.log('[SessionStore] Tool result received:', { toolUseId, isError, content: eventContent?.substring(0, 50) });

          // Add tool_result message as independent message in the messages array
          // Find the corresponding tool_use message to get toolName within the set callback
          set(state => {
            const existingSession = state.sessions[sessionId];
            if (!existingSession) return state;

            // Find the corresponding tool_use message to get toolName
            let matchingToolName = toolName || 'unknown';
            if (toolUseId) {
              const toolUseMessage = existingSession.messages.find(
                m => m.role === 'tool_use' && m.toolUseId === toolUseId
              );
              if (toolUseMessage?.toolName) {
                matchingToolName = toolUseMessage.toolName;
              }
            }

            // Create independent tool_result message (SpectrAI architecture)
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

            const updatedMessages = trimMessages([...existingSession.messages, toolResultMessage]);

            console.log('[SessionStore] Created independent tool_result message for toolUseId:', toolUseId);

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

          // End activity
          useActivityStore.getState().endActivity(sessionId);
        } else if (type === 'error') {
          // Flush any buffered text before handling error
          immediateFlushBuffer(set, sessionId);
          // Handle error
          get().updateMessage(sessionId, assistantMessageId, {
            content: `Error: ${eventContent}`,
            isStreaming: false,
          });
          // ★ 重要：结束思考计时器和活动状态
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);
          // 清理进度监听器
          cleanupProgressListener();
        } else if (type === 'complete') {
          // Flush any remaining buffered text before marking complete
          immediateFlushBuffer(set, sessionId);
          // Mark streaming as complete
          get().updateMessage(sessionId, assistantMessageId, {
            isStreaming: false,
          });
          // End thinking timer and clear activity
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);

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

        // ★ 超时保护（5分钟）- 必须重置 isStreaming 状态
        setTimeout(() => {
          clearInterval(checkInterval);
          // ★ 检查是否仍在 streaming，如果是则强制重置
          const currentSession = get().sessions[sessionId];
          const msg = currentSession?.messages.find(m => m.id === assistantMessageId);
          if (msg?.isStreaming) {
            console.warn(`[SessionStore] Timeout detected, forcing isStreaming to false for session: ${sessionId}`);
            // 重置状态
            immediateFlushBuffer(set, sessionId);
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;

              const updatedMessages = existingSession.messages.map(m =>
                m.id === assistantMessageId
                  ? { ...m, isStreaming: false, content: m.content + '\n\n⚠️ 操作超时（5分钟），已自动重置' }
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
          resolve();
        }, GLOBAL_TIMEOUT);
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
    const messagesToShow = loadedMessages.length > INITIAL_MESSAGES
      ? loadedMessages.slice(-INITIAL_MESSAGES)
      : [...loadedMessages];  // ★ 使用 spread 创建新数组

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
   * Load paginated history messages
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

    // Get IDs of messages already in session for deduplication
    const currentMessageIds = new Set(session.messages.map(m => m.id));

    // Filter to only messages NOT already in session
    const newMessages = diskMessages.filter(m => !currentMessageIds.has(m.id));

    if (newMessages.length === 0) {
      console.log(`[SessionStore] No new messages to load for session: ${sessionId}`);
      return [];
    }

    // ★ Fix: Always take the most recent MESSAGES_PER_PAGE from newMessages
    // This gets the messages that are chronologically just before the current ones
    // After prependMessages, the next call will return the next batch
    const startIndex = Math.max(0, newMessages.length - MESSAGES_PER_PAGE);
    const endIndex = newMessages.length;

    // Return in chronological order (oldest first) for prepending
    const pageMessages = newMessages.slice(startIndex, endIndex);

    console.log(`[SessionStore] Loaded ${pageMessages.length} history messages for session: ${sessionId}`);

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

    // Format answers as response message
    try {
      const answerText = Object.entries(answers)
        .map(([idx, answer]) => `Q${Number(idx) + 1}: ${answer}`)
        .join('\n');

      await window.api.claude.sendMessage(sessionId, answerText);

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
