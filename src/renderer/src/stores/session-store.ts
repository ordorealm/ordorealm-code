/**
 * Session management store
 * Refactored to follow SpectrAI architecture pattern
 * - tool_use and tool_result are now independent messages (not embedded in assistant messages)
 * - Uses ConversationMessage types from @shared
 * @module stores/session-store
 */

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionState, SessionStatus, Message, Question, InteractivePanelState, SessionListItem } from '@/types';
import type {
  ToolUseMessage,
  ToolResultMessage,
} from '@shared/index';
import { CONFIG_FILES } from '@/services/storage';
import { deleteFile, getUserDataPathAsync, ensureDir } from '@/utils/fs';
import { joinPath } from '@/utils/path';
import { useAgentStore } from './agent-store';
import { useProviderStore } from './provider-store';
import { useProjectStore } from './project-store';
import { useActivityStore } from './activity-store';
import { getSessionFilePath, saveSessionToDisk, loadSessionFromDisk, saveInputDraft, loadInputDraft, deleteInputDraft, listAllSessions } from '@/services/session-storage';

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

// ═══════════════════════════════════════════════════════════════
// 上下文摘要相关常量和函数（用于重置会话时继承记忆）
// ═══════════════════════════════════════════════════════════════

/** 上下文摘要目标最小 token 数 */
const MIN_CONTEXT_TOKENS = 50000;

/** 上下文摘要最大 token 数 */
const MAX_CONTEXT_TOKENS = 80000;

/** 最少继承的对话轮数 */
const MIN_INHERIT_ROUNDS = 5;

/** 最多继承的对话轮数 */
const MAX_INHERIT_ROUNDS = 20;

/** @deprecated 使用 MIN_INHERIT_ROUNDS 替代 */
const INHERIT_ROUNDS = 5;

/**
 * 估算文本 token 数（与 token-count-cache.ts 保持一致）
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 128) {
      tokens += 0.3;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      tokens += 1.2;
    } else if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) {
      tokens += 1.2;
    } else {
      tokens += 1.0;
    }
  }
  return Math.max(1, Math.round(tokens * 1.5));
}

/**
 * 估算消息数组的 token 总数
 * @param messages 消息数组
 * @returns token 总数
 */
function estimateMessagesTokens(messages: Message[]): number {
  if (!messages || messages.length === 0) return 0;
  return messages.reduce((sum, msg) => {
    // 内容 token
    let msgTokens = estimateTokens(msg.content || '');
    // 工具相关字段的 token
    if (msg.toolName) msgTokens += estimateTokens(msg.toolName);
    if (msg.toolResult) msgTokens += estimateTokens(msg.toolResult);
    return sum + msgTokens;
  }, 0);
}

/**
 * 截断内容（保留开头和结尾）
 */
function truncateContentForSummary(content: string, maxLength: number): string {
  if (!content || content.length <= maxLength) {
    return content || '';
  }
  const half = Math.floor(maxLength / 2);
  return content.slice(0, half) + '\n...[已截断]...\n' + content.slice(-half);
}

/**
 * 格式化单轮对话（用于摘要）
 */
function formatRoundForSummary(index: number, messages: Message[]): string {
  const lines: string[] = [];

  lines.push(`### 第 ${index} 轮`);

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`**用户**: ${truncateContentForSummary(msg.content, 1000)}`);
    } else if (msg.role === 'assistant') {
      lines.push(`**AI**: ${truncateContentForSummary(msg.content, 1000)}`);
    } else if (msg.role === 'tool_use') {
      lines.push(`**🔧 调用工具**: \`${msg.toolName || 'unknown'}\``);
    } else if (msg.role === 'tool_result') {
      const isError = msg.isError;
      const icon = isError ? '❌' : '✅';
      const resultPreview = truncateContentForSummary(msg.toolResult || '', 300);
      lines.push(`**${icon} 工具结果**: ${resultPreview}`);
    }
  }

  lines.push('');  // 空行分隔
  return lines.join('\n');
}

/**
 * 从消息列表生成会话标题
 * 取第一条用户消息的前 50 个字符
 */
function generateSessionTitle(messages: Message[]): string {
  if (!messages || messages.length === 0) {
    return '新会话';
  }

  // 找到第一条用户消息
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (!firstUserMsg) {
    return '新会话';
  }

  const content = firstUserMsg.content || '';

  // 取第一行
  const firstLine = content.split('\n')[0].trim();

  // 限制长度
  if (firstLine.length > 50) {
    return firstLine.slice(0, 50) + '...';
  }

  return firstLine || '新会话';
}

/**
 * 构建上下文摘要（用户可见版本）
 */
function buildContextSummary(messages: Message[], maxTokens: number): string {
  const lines: string[] = [
    '## 📋 上下文记忆（从上一个会话继承）',
    '> 以下是对话摘要，AI 已了解这些内容：',
    '',
  ];

  let totalTokens = estimateTokens(lines.join('\n'));

  // 按轮次组织消息
  const rounds = identifyRounds(messages);

  let includedRounds = 0;
  for (let i = 0; i < rounds.length; i++) {
    const round = rounds[i];
    const roundMessages = messages.slice(round.startIndex, round.endIndex);
    const roundText = formatRoundForSummary(i + 1, roundMessages);
    const roundTokens = estimateTokens(roundText);

    if (totalTokens + roundTokens > maxTokens) {
      console.log(`[SessionStore] Token limit reached at round ${i}, truncating`);
      break;
    }

    lines.push(roundText);
    totalTokens += roundTokens;
    includedRounds++;
  }

  if (includedRounds < rounds.length) {
    lines.push(`*(已截断，共 ${rounds.length} 轮，显示 ${includedRounds} 轮)*`);
  }

  return lines.join('\n');
}

/**
 * ★ 增量持久化：防抖保存
 * 避免频繁写入磁盘，同时确保崩溃时最大丢失 2 秒数据
 */
const INCREMENTAL_SAVE_INTERVAL = 2000; // 2 秒
const incrementalSaveTimers = new Map<string, NodeJS.Timeout>();
const incrementalSavePending = new Map<string, boolean>();

/**
 * 触发增量保存（防抖）
 * @param sessionId 会话 ID
 */
function triggerIncrementalSave(sessionId: string): void {
  // 标记有待保存的数据
  incrementalSavePending.set(sessionId, true);

  // 如果已有定时器，不重复创建
  if (incrementalSaveTimers.has(sessionId)) {
    return;
  }

  // 创建定时器，2 秒后保存
  const timer = setTimeout(async () => {
    incrementalSaveTimers.delete(sessionId);

    // 检查是否仍有待保存的数据
    if (!incrementalSavePending.get(sessionId)) {
      return;
    }
    incrementalSavePending.delete(sessionId);

    // 执行保存 - 使用 getState() 获取当前状态
    const session = useSessionStore.getState().sessions[sessionId];
    if (session && session.messages?.length > 0) {
      console.log(`[SessionStore] Incremental save: ${sessionId}, messages: ${session.messages.length}`);
      try {
        await saveSessionToDisk(session);
      } catch (err) {
        console.error('[SessionStore] Incremental save failed:', err);
      }
    }
  }, INCREMENTAL_SAVE_INTERVAL);

  incrementalSaveTimers.set(sessionId, timer);
}

/**
 * 取消增量保存定时器
 * @param sessionId 会话 ID
 */
function cancelIncrementalSave(sessionId: string): void {
  const timer = incrementalSaveTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    incrementalSaveTimers.delete(sessionId);
  }
  incrementalSavePending.delete(sessionId);
}

/**
 * ★ 应用退出前强制保存所有待保存的会话
 * 确保崩溃或关闭时数据不丢失
 */
async function forceSaveAllPendingSessions(): Promise<void> {
  const pendingSessionIds = Array.from(incrementalSavePending.keys());
  if (pendingSessionIds.length === 0) return;

  console.log(`[SessionStore] Force saving ${pendingSessionIds.length} pending sessions before exit`);

  // 取消所有定时器
  for (const sessionId of pendingSessionIds) {
    cancelIncrementalSave(sessionId);
  }

  // 同步保存所有待保存的会话
  const store = useSessionStore.getState();
  for (const sessionId of pendingSessionIds) {
    const session = store.sessions[sessionId];
    if (session && session.messages?.length > 0) {
      try {
        await saveSessionToDisk(session);
        console.log(`[SessionStore] Force saved session: ${sessionId}`);
      } catch (err) {
        console.error(`[SessionStore] Failed to force save session ${sessionId}:`, err);
      }
    }
  }
}

/**
 * ★ 同步保存所有待保存会话（用于 beforeunload 等同步场景）
 * 使用 localStorage 作为临时备份，下次启动时恢复
 */
function syncSavePendingSessionsToBackup(): void {
  const pendingSessionIds = Array.from(incrementalSavePending.keys());
  if (pendingSessionIds.length === 0) return;

  console.log(`[SessionStore] Sync backup ${pendingSessionIds.length} pending sessions`);

  const store = useSessionStore.getState();
  const backupData: Record<string, { messages: Message[]; lastActiveAt: string }> = {};

  for (const sessionId of pendingSessionIds) {
    const session = store.sessions[sessionId];
    if (session && session.messages?.length > 0) {
      backupData[sessionId] = {
        messages: session.messages,
        lastActiveAt: session.lastActiveAt || new Date().toISOString(),
      };
    }
  }

  if (Object.keys(backupData).length > 0) {
    try {
      localStorage.setItem('session_backup_pending', JSON.stringify(backupData));
      console.log('[SessionStore] Sync backup saved to localStorage');
    } catch (err) {
      console.error('[SessionStore] Failed to sync backup:', err);
    }
  }
}

/**
 * ★ 恢复上次未保存的会话（启动时调用）
 */
async function restorePendingSessionsFromBackup(): Promise<void> {
  try {
    const backupStr = localStorage.getItem('session_backup_pending');
    if (!backupStr) return;

    const backupData = JSON.parse(backupStr);
    localStorage.removeItem('session_backup_pending'); // 清理备份

    const sessionIds = Object.keys(backupData);
    if (sessionIds.length === 0) return;

    console.log(`[SessionStore] Restoring ${sessionIds.length} pending sessions from backup`);

    for (const sessionId of sessionIds) {
      const data = backupData[sessionId];
      const existingSession = useSessionStore.getState().sessions[sessionId];

      // 仅当会话存在且备份的消息更多时才恢复
      if (existingSession && data.messages?.length > 0) {
        if (!existingSession.messages || data.messages.length > existingSession.messages.length) {
          // 更新会话消息
          useSessionStore.getState().updateSessionMessages(sessionId, data.messages);
          // 保存到磁盘
          const session = useSessionStore.getState().sessions[sessionId];
          if (session) {
            await saveSessionToDisk(session);
          }
          console.log(`[SessionStore] Restored session from backup: ${sessionId}`);
        }
      }
    }
  } catch (err) {
    console.error('[SessionStore] Failed to restore pending sessions:', err);
  }
}

/**
 * ★ 注册 beforeunload 事件处理
 * 在窗口关闭前强制保存所有待保存的会话
 */
let beforeUnloadHandlerRegistered = false;
function registerBeforeUnloadHandler(): void {
  if (beforeUnloadHandlerRegistered) return;
  beforeUnloadHandlerRegistered = true;

  // ★ 使用 pagehide 事件（比 beforeunload 更可靠）
  window.addEventListener('pagehide', (event) => {
    console.log('[SessionStore] pagehide triggered, persistState:', event.persisted);
    // 同步保存到 localStorage 作为备份
    syncSavePendingSessionsToBackup();
    // 同时尝试异步保存（可能无法完成）
    forceSaveAllPendingSessions().catch(err => {
      console.error('[SessionStore] Failed to save on pagehide:', err);
    });
    // ★ 清理控制器监听器
    cleanupControllerListeners();
  });

  // ★ 兼容旧浏览器
  window.addEventListener('beforeunload', () => {
    console.log('[SessionStore] beforeunload triggered');
    // 同步保存到 localStorage 作为备份
    syncSavePendingSessionsToBackup();
    // ★ 清理控制器监听器
    cleanupControllerListeners();
  });
}

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
 * 智能加载结果
 */
interface SmartLoadResult {
  /** 选中的消息 */
  messages: Message[];
  /** 加载的轮数 */
  roundsLoaded: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 停止原因 */
  stoppedReason: 'min_target_reached' | 'max_tokens_reached' | 'max_rounds_reached' | 'no_more_rounds';
}

/**
 * 智能加载对话历史
 * 根据信息量动态决定加载轮数：
 * - 至少加载 MIN_INHERIT_ROUNDS 轮
 * - 如果信息量 < MIN_CONTEXT_TOKENS，继续向前加载
 * - 直到信息量 >= MIN_CONTEXT_TOKENS 或达到 MAX_CONTEXT_TOKENS 或达到 MAX_INHERIT_ROUNDS
 * @param messages 消息数组
 * @returns 智能加载结果
 */
function getSmartRounds(messages: Message[]): SmartLoadResult {
  if (!messages || messages.length === 0) {
    return { messages: [], roundsLoaded: 0, totalTokens: 0, stoppedReason: 'no_more_rounds' };
  }

  const rounds = identifyRounds(messages);

  // 如果总轮数 <= 最少轮数，直接返回全部
  if (rounds.length <= MIN_INHERIT_ROUNDS) {
    const totalTokens = estimateMessagesTokens(messages);
    // 根据是否达到目标决定停止原因
    const stoppedReason = totalTokens >= MIN_CONTEXT_TOKENS
      ? 'min_target_reached'
      : 'no_more_rounds';
    return {
      messages: [...messages],
      roundsLoaded: rounds.length,
      totalTokens,
      stoppedReason
    };
  }

  // Step 1: 先加载最近 MIN_INHERIT_ROUNDS 轮
  const initialRounds = rounds.slice(-MIN_INHERIT_ROUNDS);
  const startIndex = initialRounds[0].startIndex;
  let selectedMessages = messages.slice(startIndex);
  let totalTokens = estimateMessagesTokens(selectedMessages);
  let roundsLoaded = MIN_INHERIT_ROUNDS;

  // 如果已达到目标，直接返回
  if (totalTokens >= MIN_CONTEXT_TOKENS) {
    return {
      messages: selectedMessages,
      roundsLoaded,
      totalTokens,
      stoppedReason: 'min_target_reached'
    };
  }

  // Step 2: 继续向前加载更早的轮次
  const earlierRounds = rounds.slice(0, -MIN_INHERIT_ROUNDS).reverse();

  for (const round of earlierRounds) {
    const roundMessages = messages.slice(round.startIndex, round.endIndex);
    const roundTokens = estimateMessagesTokens(roundMessages);

    // 检查是否超过上限
    if (totalTokens + roundTokens > MAX_CONTEXT_TOKENS) {
      // 超过上限，停止加载
      console.log(`[SessionStore] Smart load: max tokens reached (${totalTokens} + ${roundTokens} > ${MAX_CONTEXT_TOKENS})`);
      return {
        messages: selectedMessages,
        roundsLoaded,
        totalTokens,
        stoppedReason: 'max_tokens_reached'
      };
    }

    // 前置这一轮的消息
    selectedMessages = [...roundMessages, ...selectedMessages];
    totalTokens += roundTokens;
    roundsLoaded++;

    // 检查是否达到目标
    if (totalTokens >= MIN_CONTEXT_TOKENS) {
      console.log(`[SessionStore] Smart load: min target reached (${totalTokens} >= ${MIN_CONTEXT_TOKENS})`);
      return {
        messages: selectedMessages,
        roundsLoaded,
        totalTokens,
        stoppedReason: 'min_target_reached'
      };
    }

    // 检查是否达到最大轮数
    if (roundsLoaded >= MAX_INHERIT_ROUNDS) {
      console.log(`[SessionStore] Smart load: max rounds reached (${roundsLoaded} >= ${MAX_INHERIT_ROUNDS})`);
      return {
        messages: selectedMessages,
        roundsLoaded,
        totalTokens,
        stoppedReason: 'max_rounds_reached'
      };
    }
  }

  // 所有更早的轮次都加载完了，但还没达到目标
  console.log(`[SessionStore] Smart load: loaded all available rounds (${roundsLoaded}, ${totalTokens} tokens)`);
  return {
    messages: selectedMessages,
    roundsLoaded,
    totalTokens,
    stoppedReason: 'no_more_rounds'
  };
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

/** Zustand get function type for helper functions */
type GetFunction = () => StoreState;

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

/** ★ 流活跃检测配置 */
const STREAMING_ACTIVITY_CHECK_INTERVAL = 30000; // 30秒检测一次
const STREAMING_ACTIVITY_IDLE_THRESHOLD = 2; // 连续2次无新内容才查询后端
/** ★ 绝对超时：streaming 状态最大持续时间（30分钟）*/
const ABSOLUTE_STREAMING_TIMEOUT = 30 * 60 * 1000;

/** ★ 自动压缩冷却时间（60秒）- 防止频繁触发自动压缩 */
export const COMPACT_COOLDOWN_MS = 60000;

/** ★ 输出 token 预留空间（32K 为模型最大输出限制）
 * 用于计算有效的上下文使用率，防止输出超过限制导致模型死机
 */
export const OUTPUT_TOKEN_RESERVE = 32000;

/** ★ 安全解析日期时间戳，处理无效日期返回 0 */
function safeParseTimestamp(dateStr: string | number | null | undefined): number {
  if (!dateStr) return 0;
  const timestamp = typeof dateStr === 'number' ? dateStr : new Date(dateStr).getTime();
  // NaN 检查：无效日期字符串会返回 NaN
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** ★ 流活跃状态（用于检测流断开但无 error/complete 事件的情况） */
interface StreamingActivity {
  /** 上次事件时间 */
  lastEventTime: number;
  /** 上次内容长度 */
  lastContentLength: number;
  /** 连续空闲计数 */
  idleCount: number;
  /** 检测定时器 */
  checkTimer: ReturnType<typeof setInterval> | null;
  /** 是否正在执行 pingSession 检查（防止并发） */
  isChecking: boolean;
  /** ★ streaming 开始时间（用于绝对超时检测） */
  streamingStartTime: number;
}

/** ★ 多会话流活跃状态 Map */
const streamingActivities = new Map<string, StreamingActivity>();

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
 * @param get Zustand get 函数
 */
function startHeartbeatCheck(
  sessionId: string,
  assistantMessageId: string,
  set: SetFunction,
  get: GetFunction
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
              startHeartbeatCheck(sessionId, assistantMessageId, set, get);

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
              performHeartbeatAbort(sessionId, assistantMessageId, set, get, timeoutMinutes);
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
      performHeartbeatAbort(sessionId, assistantMessageId, set, get, timeoutMinutes);
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
  get: GetFunction,
  timeoutMinutes: number
): void {
  // ★ 清理该会话的心跳定时器
  const listenerInfo = progressListeners.get(sessionId);
  if (listenerInfo?.heartbeatTimer) {
    clearInterval(listenerInfo.heartbeatTimer);
    listenerInfo.heartbeatTimer = null;
  }

  // ★ 停止流活跃检测
  stopStreamingActivityCheck(sessionId);

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
  // ★ 清除交互面板（AskUserQuestion 等，防止超时后残留）
  get().clearInteractivePanel(sessionId);
  // ★ 修复：只清理该会话的监听器
  cleanupProgressListenerForSession(sessionId);
}

/**
 * ★ 强制重置 streaming 状态（兜底机制）
 * 用于异常情况下的状态同步
 * @param sessionId 会话 ID
 * @param set Zustand set 函数
 * @param message 提示消息
 */
function forceResetStreamingState(
  sessionId: string,
  set: SetFunction,
  message: string
): void {
  console.warn(`[SessionStore] Force resetting streaming state for session: ${sessionId}`);

  set(state => {
    const existingSession = state.sessions[sessionId];
    if (!existingSession) return state;

    return {
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...existingSession,
          messages: existingSession.messages.map(m =>
            m.isStreaming
              ? { ...m, isStreaming: false, isThinking: false, content: m.content + `\n\n⚠️ ${message}` }
              : m
          ),
          connectionNotice: message,
        },
      },
    };
  });

  useActivityStore.getState().endThinking(sessionId);
  useActivityStore.getState().endActivity(sessionId);

  // ★ 清理 streamingActivities（不清除 connectionNotice，区别于 stopStreamingActivityCheck）
  const activity = streamingActivities.get(sessionId);
  if (activity) {
    if (activity.checkTimer) {
      clearInterval(activity.checkTimer);
      activity.checkTimer = null;
    }
    streamingActivities.delete(sessionId);
  }

  cleanupProgressListenerForSession(sessionId);
}

/**
 * ★ 流活跃检测：启动检测定时器
 * 每 30 秒检查是否有新内容，如果连续无新内容则查询后端状态
 */
function startStreamingActivityCheck(
  sessionId: string,
  set: SetFunction,
  get: GetFunction
): void {
  // 获取或创建活跃状态
  let activity = streamingActivities.get(sessionId);
  if (activity) {
    // ★ 复用已有对象时，重置关键状态字段，避免继承旧的高空闲计数
    activity.lastEventTime = Date.now();
    activity.lastContentLength = 0;
    activity.idleCount = 0;
    activity.isChecking = false;
    activity.streamingStartTime = Date.now(); // ★ 重置 streaming 开始时间
  } else {
    activity = {
      lastEventTime: Date.now(),
      lastContentLength: 0,
      idleCount: 0,
      checkTimer: null,
      isChecking: false,
      streamingStartTime: Date.now(), // ★ 记录 streaming 开始时间
    };
    streamingActivities.set(sessionId, activity);
  }

  // 清理旧定时器
  if (activity.checkTimer) {
    clearInterval(activity.checkTimer);
  }

  console.log(`[SessionStore] Starting streaming activity check for session: ${sessionId}`);

  activity.checkTimer = setInterval(async () => {
    const currentActivity = streamingActivities.get(sessionId);
    if (!currentActivity) {
      return;
    }

    const session = get().sessions[sessionId];
    if (!session) {
      stopStreamingActivityCheck(sessionId);
      return;
    }

    // 找到 streaming 的消息
    const streamingMsg = session.messages.find((m: Message) => m.isStreaming);
    if (!streamingMsg) {
      // 没有 streaming 消息，停止检测
      console.log(`[SessionStore] No streaming message, stopping activity check`);
      stopStreamingActivityCheck(sessionId);
      return;
    }

    // ★★★ 绝对超时检测：streaming 状态超过阈值时间，强制重置 ★★★
    const streamingDuration = Date.now() - currentActivity.streamingStartTime;
    if (streamingDuration > ABSOLUTE_STREAMING_TIMEOUT) {
      console.warn(`[SessionStore] Absolute timeout reached (${Math.round(streamingDuration / 60000)}min), forcing reset`);
      forceResetStreamingState(sessionId, set, `响应超时（${Math.round(ABSOLUTE_STREAMING_TIMEOUT / 60000)}分钟），请重新发送消息`);
      return;
    }

    const currentContentLength = streamingMsg.content?.length ?? 0;
    const timeSinceLastEvent = Date.now() - currentActivity.lastEventTime;

    // ★ 优化空闲检测逻辑：只有当内容有新内容时才重置空闲计数
    // 避免事件频繁触发但内容无变化时误判为活动状态
    const hasNewContent = currentContentLength > currentActivity.lastContentLength;
    const hasRecentEvent = timeSinceLastEvent < STREAMING_ACTIVITY_CHECK_INTERVAL;

    // ★ 检测工具使用：如果有 tool_use 内容块，说明 AI 正在工作
    const hasToolUse = streamingMsg.contentBlocks?.some(b => b.type === 'tool_use') ?? false;

    if (hasNewContent) {
      // 有新内容，重置计数
      currentActivity.lastContentLength = currentContentLength;
      currentActivity.lastEventTime = Date.now();
      currentActivity.idleCount = 0;
      console.log(`[SessionStore] Streaming activity detected, content length: ${currentContentLength}`);
    } else if (hasRecentEvent || hasToolUse) {
      // 最近有事件或有工具使用，只更新时间，不重置计数
      // ★ 有工具使用时刷新绝对超时时间，因为 AI 正在工作
      if (hasToolUse) {
        currentActivity.streamingStartTime = Date.now();
        console.log(`[SessionStore] Tool use detected, refreshing streaming timeout`);
      }
      currentActivity.lastEventTime = Date.now();
      console.log(`[SessionStore] Recent event but no new content, keeping idle count: ${currentActivity.idleCount}`);
    } else {
      // 无新内容且无最近事件
      currentActivity.idleCount++;
      const idleTime = currentActivity.idleCount * STREAMING_ACTIVITY_CHECK_INTERVAL / 1000;

      console.warn(`[SessionStore] Streaming idle for ${idleTime}s, count: ${currentActivity.idleCount}`);

      if (currentActivity.idleCount === 1) {
        // 第一次空闲：显示提示
        set(state => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: {
                ...s,
                connectionNotice: '响应缓慢，请稍候...'
              }
            }
          };
        });
      } else if (currentActivity.idleCount >= STREAMING_ACTIVITY_IDLE_THRESHOLD) {
        // 达到阈值：查询后端状态
        // ★ 防止并发：如果上一次检查还未完成，跳过本次
        if (currentActivity.isChecking) {
          console.log(`[SessionStore] Activity check already in progress, skipping`);
          return;
        }
        currentActivity.isChecking = true;
        console.log(`[SessionStore] Checking backend status via pingSession...`);

        try {
          const result = await window.api.claude.pingSession(sessionId);
          console.log(`[SessionStore] pingSession result:`, result);

          if (!result.alive) {
            // 后端已死，强制同步状态
            console.warn(`[SessionStore] Backend stream is dead, forcing sync`);

            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;

              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...existingSession,
                    messages: existingSession.messages.map(m =>
                      m.isStreaming
                        ? { ...m, isStreaming: false, isThinking: false, content: m.content + '\n\n⚠️ 连接已断开，请重新发送消息。' }
                        : m
                    ),
                    connectionNotice: '连接已断开',
                  },
                },
              };
            });

            useActivityStore.getState().endThinking(sessionId);
            useActivityStore.getState().endActivity(sessionId);
            stopStreamingActivityCheck(sessionId);
            cleanupProgressListenerForSession(sessionId);
          } else {
            // 后端还活着，显示检查结果
            set(state => {
              const s = state.sessions[sessionId];
              if (!s) return state;
              return {
                sessions: {
                  ...state.sessions,
                  [sessionId]: {
                    ...s,
                    connectionNotice: `后端正常，等待响应中... (${Math.round((Date.now() - result.lastActivity) / 1000)}s前活跃)`
                  }
                }
              };
            });
          }
        } catch (err) {
          console.error('[SessionStore] pingSession failed:', err);
          // ★ pingSession 失败通常意味着 IPC 通信异常或后端进程问题
          // 直接重置状态，让用户可以继续操作
          console.warn('[SessionStore] pingSession failed, forcing reset');
          forceResetStreamingState(sessionId, set, '连接异常，请重新发送消息');
          return; // forceResetStreamingState 已清理，直接退出检测循环
        } finally {
          // ★ 重置检查标志
          const finalActivity = streamingActivities.get(sessionId);
          if (finalActivity) {
            finalActivity.isChecking = false;
          }
        }
      }
    }
  }, STREAMING_ACTIVITY_CHECK_INTERVAL);
}

/**
 * ★ 流活跃检测：停止检测定时器
 */
function stopStreamingActivityCheck(sessionId: string): void {
  const activity = streamingActivities.get(sessionId);
  if (activity) {
    if (activity.checkTimer) {
      clearInterval(activity.checkTimer);
      activity.checkTimer = null;
    }
    streamingActivities.delete(sessionId);
    console.log(`[SessionStore] Stopped streaming activity check for session: ${sessionId}`);
  }

  // ★ 修复：清除该会话的 connectionNotice，避免残留显示
  const store = useSessionStore.getState();
  const session = store.sessions[sessionId];
  if (session && session.connectionNotice) {
    useSessionStore.setState(state => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...state.sessions[sessionId], connectionNotice: null }
      }
    }));
    console.log(`[SessionStore] Cleared connectionNotice for session: ${sessionId}`);
  }
}

/**
 * ★ 流活跃检测：更新活跃状态（在 text/thinking 事件时调用）
 */
function updateStreamingActivity(
  sessionId: string,
  contentLength: number,
  set: SetFunction,
  get: GetFunction
): void {
  const activity = streamingActivities.get(sessionId);
  if (activity) {
    activity.lastEventTime = Date.now();
    activity.lastContentLength = contentLength;
    // 有新事件，重置空闲计数
    if (activity.idleCount > 0) {
      activity.idleCount = 0;
    }
  }

  // ★ 修复：无论 idleCount 值如何，只要有新内容到达就清除 connectionNotice
  // 这样正常对话内容可以覆盖掉残留的提示信息
  const session = get().sessions[sessionId];
  if (session?.connectionNotice) {
    // 清除所有类型的 connectionNotice（响应缓慢、等待响应、连接已断开等）
    set(state => {
      const s = state.sessions[sessionId];
      if (!s || !s.connectionNotice) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...s, connectionNotice: null } }
      };
    });
    console.log(`[SessionStore] Cleared connectionNotice on activity update for session: ${sessionId}`);
  }
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
  /** Create a new blank session (does not reuse existing) */
  createNewSession: (projectId: string) => Promise<string>;
  /** Send a message and handle agent response (streaming) */
  sendMessage: (sessionId: string, content: string) => Promise<void>;
  /** Restart session connection (reconnect agent, keep history) */
  restartSession: (sessionId: string) => Promise<void>;
  /** Reset session (archive old session, create new session with inherited context) */
  resetSession: (sessionId: string) => Promise<void>;
  /** Clone a session (copy messages to new session with context) */
  cloneSession: (sessionId: string) => Promise<string>;
  /** Create new session with inherited context from source session */
  createSessionWithContext: (sourceSession: Session, options?: { titlePrefix?: string }) => Promise<string>;
  /** Archive a session */
  archiveSession: (sessionId: string) => Promise<void>;
  /** Unarchive a session */
  unarchiveSession: (sessionId: string) => Promise<void>;
  /** Cleanup expired archived sessions (max 30) */
  cleanupArchivedSessions: () => Promise<void>;
  /** Get session list (lightweight, for UI display) */
  getSessionList: (projectId?: string) => Promise<SessionListItem[]>;
  /** Switch to a different session */
  switchToSession: (sessionId: string) => Promise<void>;
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
  /** Update session messages array (for crash recovery) */
  updateSessionMessages: (sessionId: string, messages: Message[]) => void;
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
  /** Set controller input request */
  setControllerInputRequest: (sessionId: string, request: {
    requestId: string;
    question: string;
    type: 'text' | 'choice' | 'confirm';
    options?: Array<{ value: string; label: string }>;
  } | null) => void;
  /** Clear controller input request */
  clearControllerInputRequest: (sessionId: string) => void;
  /** Respond to controller input request */
  respondToControllerInput: (sessionId: string, requestId: string, answer: string | string[]) => void;
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
  /** Set last compact timestamp - for cooldown mechanism */
  setLastCompactAt: (sessionId: string, timestamp: string | null) => void;
  /** Set session-level Provider override */
  setOverrideProvider: (sessionId: string, providerId: string | null) => void;
  /** Set session-level model override */
  setOverrideModel: (sessionId: string, model: string | null) => void;
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

/**
 * Agent 调用 toolCallId 映射表
 * Key: `${sessionId}:${agentName}` → Value: toolCallId
 * 用于 task_complete 回调时精确匹配 Agent 调用
 */
const agentToolCallMap = new Map<string, string>()

/**
 * Pending Agent 调用信息
 * 用于 complete 事件时发送结果
 */
interface PendingAgentCall {
  sessionId: string
  agentName: string
  toolCallId: string
  prompt: string
  startedAt: number
}
const pendingAgentCalls = new Map<string, PendingAgentCall>()

/**
 * 解析 Agent 输出内容
 * 支持 JSON 代码块、纯 JSON、纯文本三种格式
 * 只要解析出有效 JSON，就返回 AgentResult 结构
 */
function parseAgentOutput(content: string): {
  success: boolean;
  status: string;
  modifiedFiles: string[];
  summary: string;
  issues?: Array<{ severity: string; location: string; description: string; suggestion?: string }>;
  error?: string;
  output?: Record<string, unknown>;
} | null {
  // 1. 尝试提取 JSON 代码块
  const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      // 只要解析出有效 JSON 对象，就认为是 Agent 结果
      if (parsed && typeof parsed === 'object') {
        // 如果 status 和 success 都没有，默认为失败
        const success = parsed.success ?? (parsed.status === 'done' || parsed.status === 'completed' || parsed.status === 'passed') ?? false;
        const status = parsed.status || (success ? 'done' : 'failed');
        return {
          success,
          status,
          modifiedFiles: parsed.modifiedFiles || [],
          summary: parsed.summary || '',
          issues: parsed.issues,
          error: parsed.error,
          output: parsed.output || parsed,
        };
      }
    } catch {
      // JSON 解析失败，继续尝试其他方式
    }
  }

  // 2. 尝试提取 --- 后面的 JSON（Markdown 分隔符后）
  const separatorMatch = content.match(/---\s*([\s\S]*?)$/);
  if (separatorMatch) {
    try {
      const parsed = JSON.parse(separatorMatch[1].trim());
      if (parsed && typeof parsed === 'object') {
        const success = parsed.success ?? (parsed.status === 'done' || parsed.status === 'completed' || parsed.status === 'passed') ?? false;
        const status = parsed.status || (success ? 'done' : 'failed');
        return {
          success,
          status,
          modifiedFiles: parsed.modifiedFiles || [],
          summary: parsed.summary || '',
          issues: parsed.issues,
          error: parsed.error,
          output: parsed.output || parsed,
        };
      }
    } catch {
      // 解析失败，继续尝试其他方式
    }
  }

  // 3. 尝试直接解析整个内容为 JSON
  try {
    const parsed = JSON.parse(content);
    // 只要解析出有效 JSON 对象，就认为是 Agent 结果
    if (parsed && typeof parsed === 'object') {
      // 如果 status 和 success 都没有，默认为失败
      const success = parsed.success ?? (parsed.status === 'done' || parsed.status === 'completed' || parsed.status === 'passed') ?? false;
      const status = parsed.status || (success ? 'done' : 'failed');
      return {
        success,
        status,
        modifiedFiles: parsed.modifiedFiles || [],
        summary: parsed.summary || '',
        issues: parsed.issues,
        error: parsed.error,
        output: parsed.output || parsed,
      };
    }
  } catch {
    // 不是有效 JSON
  }

  // 4. 尝试提取内容中任何位置的 JSON 对象（使用非贪婪匹配）
  const jsonObjectMatch = content.match(/\{[\s\S]*?"success"[\s\S]*?\}|\{[\s\S]*?"status"[\s\S]*?\}/);
  if (jsonObjectMatch) {
    try {
      // 尝试找到完整的 JSON 对象
      let jsonStr = jsonObjectMatch[0];
      // 确保是完整的 JSON（匹配括号）
      let braceCount = 0;
      let endIndex = 0;
      for (let i = 0; i < jsonStr.length; i++) {
        if (jsonStr[i] === '{') braceCount++;
        if (jsonStr[i] === '}') {
          braceCount--;
          if (braceCount === 0) {
            endIndex = i + 1;
            break;
          }
        }
      }
      if (endIndex > 0) {
        jsonStr = jsonStr.substring(0, endIndex);
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object') {
          const success = parsed.success ?? (parsed.status === 'done' || parsed.status === 'completed' || parsed.status === 'passed') ?? false;
          const status = parsed.status || (success ? 'done' : 'failed');
          return {
            success,
            status,
            modifiedFiles: parsed.modifiedFiles || [],
            summary: parsed.summary || '',
            issues: parsed.issues,
            error: parsed.error,
            output: parsed.output || parsed,
          };
        }
      }
    } catch {
      // 解析失败
    }
  }

  // 5. 纯文本：无法解析为 JSON，返回 null 表示不是 Agent 结果
  return null;
}

/**
 * Setup controller IPC listeners
 * Handles input requests and agent calls from controller
 */
function setupControllerListeners(): void {
  // ★ 监听控制器发送的消息（通过 output action）
  const unsubscribeConversation = window.api.claude.onConversationMessage((payload) => {
    console.log('[SessionStore] Controller conversation message received:', payload);
    const { sessionId, message } = payload;

    // 获取会话
    const state = useSessionStore.getState();
    const session = state.sessions[sessionId];
    if (!session) {
      console.warn('[SessionStore] Session not found for controller message:', sessionId);
      return;
    }

    // ★ 类型守卫：只处理有 content 属性的消息（AssistantMessage/UserMessage/SystemMessage）
    // ToolUseMessage 和 ToolResultMessage 没有 content 属性
    if (!('content' in message)) {
      console.log('[SessionStore] Skipping non-content message:', message.role);
      return;
    }

    // 提取文本内容
    const messageContent = message.content;
    const contentText = typeof messageContent === 'string'
      ? messageContent
      : (messageContent as Array<{ type: string; text?: string }>)?.[0]?.text || '';

    // 将控制器消息追加到 streaming 的 assistant message 中
    // 找到最后一个 streaming 的 assistant message
    const messages = [...session.messages];
    let assistantMsg: Message | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant' && messages[i].isStreaming) {
        assistantMsg = messages[i];
        break;
      }
    }

    if (assistantMsg) {
      // 追加内容到现有的 assistant message
      const updatedContent = (assistantMsg.content || '') + contentText;
      useSessionStore.getState().updateMessage(sessionId, assistantMsg.id, {
        content: updatedContent,
      });
    } else {
      // 没有找到 streaming 的 assistant message，创建新的
      const newMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: contentText,
        timestamp: new Date().toISOString(),
        isStreaming: false,
      };
      useSessionStore.setState((prevState) => {
        const existingSession = prevState.sessions[sessionId];
        if (!existingSession) return prevState;
        return {
          sessions: {
            ...prevState.sessions,
            [sessionId]: {
              ...existingSession,
              messages: [...existingSession.messages, newMessage],
              lastActiveAt: new Date().toISOString(),
            },
          },
        };
      });
    }
  });

  // 监听控制器输入请求
  const unsubscribeInput = window.api.controller.onInputRequest((data) => {
    console.log('[SessionStore] Controller input request received:', data);

    // 设置待处理的输入请求
    useSessionStore.getState().setControllerInputRequest(data.sessionId, {
      requestId: data.requestId,
      question: data.question,
      type: data.type,
      options: data.options,
    });
  });

  // 监听 Agent 调用
  const unsubscribeAgent = window.api.controller.onAgentCall(async (data) => {
    console.log('='.repeat(80));
    console.log('[SessionStore] ★★★ Controller agent call received ★★★');
    console.log('[SessionStore] data:', JSON.stringify(data, null, 2));
    console.log('='.repeat(80));
    const { sessionId, agentName, toolCallId, prompt } = data;

    // 存储 toolCallId 以便 complete 事件时精确匹配
    const agentCallKey = `${sessionId}:${agentName}`;
    agentToolCallMap.set(agentCallKey, toolCallId);
    console.log('[SessionStore] agentToolCallMap.set:', agentCallKey, '->', toolCallId);

    // ★ 存储 pending agent call 信息，用于 complete 事件时发送结果
    pendingAgentCalls.set(agentCallKey, {
      sessionId,
      agentName,
      toolCallId,
      prompt,
      startedAt: Date.now()
    });
    console.log('[SessionStore] pendingAgentCalls.set:', agentCallKey);

    // 获取会话和项目信息
    const state = useSessionStore.getState();
    const session = state.sessions[sessionId];
    console.log('[SessionStore] session found:', !!session, 'sessionIds:', Object.keys(state.sessions));
    if (!session) {
      console.error('[SessionStore] Session not found for agent call:', sessionId);
      agentToolCallMap.delete(agentCallKey);
      pendingAgentCalls.delete(agentCallKey);
      return;
    }

    // 获取项目路径
    const projectStore = useProjectStore.getState();
    const project = projectStore.projects.find(p => p.id === session.projectId);
    console.log('[SessionStore] project found:', !!project);
    if (!project) {
      console.error('[SessionStore] Project not found for agent call');
      agentToolCallMap.delete(agentCallKey);
      pendingAgentCalls.delete(agentCallKey);
      return;
    }

    try {
      // 将 Agent prompt 作为用户消息发送给 AI
      // AI 会根据 prompt 中的指示执行 Agent 定义的逻辑（包括多轮对话）
      // 最终调用 task_complete 工具返回结果
      //
      // ★ 修复：调用 sendMessage action 而不是直接调用 window.api.claude.sendMessage
      // sendMessage action 会自动处理 startSession、setupProgressListener 等流程

      console.log('[SessionStore] 准备发送消息给 AI, prompt:', prompt);

      console.log(`[SessionStore] ★★★ Sending agent prompt to AI via sendMessage action ★★★`);
      console.log(`[SessionStore] sessionId: ${sessionId}`);
      console.log(`[SessionStore] agentName: ${agentName}`);
      console.log(`[SessionStore] prompt: ${prompt}`);
      console.log(`[SessionStore] toolCallId: ${toolCallId}`);

      // ★ 调用 sendMessage action（会自动处理 startSession、setupProgressListener、消息入队等）
      // 不使用 await，让 AI 异步执行多轮对话
      // 结果通过 complete 事件返回
      useSessionStore.getState().sendMessage(sessionId, prompt).then(() => {
        console.log(`[SessionStore] ★★★ sendMessage action completed ★★★`);
      }).catch((error: Error) => {
        console.error('[SessionStore] ★★★ sendMessage action error ★★★');
        console.error('[SessionStore] error:', error);

        // 发送失败时通知控制器
        const pendingToolCallId = agentToolCallMap.get(agentCallKey) || toolCallId;
        window.api.controller.sendAgentResult(sessionId, agentName, pendingToolCallId, {
          success: false,
          status: 'failed',
          modifiedFiles: [],
          summary: `Agent ${agentName} 执行失败`,
          error: error instanceof Error ? error.message : String(error),
        });
        agentToolCallMap.delete(agentCallKey);
        pendingAgentCalls.delete(agentCallKey);
      });

    } catch (error) {
      console.error('[SessionStore] Agent call setup failed:', error);

      // 发送失败结果（使用 toolCallId 精确匹配）
      const pendingToolCallId = agentToolCallMap.get(agentCallKey) || toolCallId;
      window.api.controller.sendAgentResult(sessionId, agentName, pendingToolCallId, {
        success: false,
        status: 'failed',
        modifiedFiles: [],
        summary: `Agent ${agentName} 执行失败`,
        error: error instanceof Error ? error.message : String(error),
      });
      agentToolCallMap.delete(agentCallKey);
    }
  });

  // 监听超时通知
  const unsubscribeTimeout = window.api.controller.onTimeout((data) => {
    console.log('[SessionStore] Controller timeout received:', data);
    const { sessionId, type, agentName, question } = data;

    // 清除待处理的输入请求（如果是用户输入超时）
    if (type === 'user_input') {
      useSessionStore.getState().clearControllerInputRequest(sessionId);
    }

    // 清理 agentToolCallMap 和 pendingAgentCalls（如果是 agent 超时）
    if (type === 'agent' && agentName) {
      const agentCallKey = `${sessionId}:${agentName}`;
      agentToolCallMap.delete(agentCallKey);
      pendingAgentCalls.delete(agentCallKey);
      console.log('[SessionStore] Cleaned up pending agent call due to timeout:', agentCallKey);
    }

    // 添加超时提示消息
    const state = useSessionStore.getState();
    const session = state.sessions[sessionId];
    if (session) {
      const timeoutMessage: Message = {
        id: uuidv4(),
        role: 'assistant',
        content: type === 'agent'
          ? `⏱️ Agent ${agentName || 'unknown'} 执行超时，请检查或重试`
          : `⏱️ 用户输入超时（问题: ${question?.slice(0, 50) || 'unknown'}...）`,
        timestamp: new Date().toISOString(),
      };

      useSessionStore.setState((prevState) => {
        const existingSession = prevState.sessions[sessionId];
        if (!existingSession) return prevState;
        return {
          sessions: {
            ...prevState.sessions,
            [sessionId]: {
              ...existingSession,
              messages: [...existingSession.messages, timeoutMessage],
              lastActiveAt: new Date().toISOString(),
            },
          },
        };
      });
    }
  });

  // 保存取消订阅函数，用于清理
  (window as any).__controllerListenersCleanup = () => {
    unsubscribeInput();
    unsubscribeAgent();
    unsubscribeTimeout();
  };

  console.log('[SessionStore] Controller listeners registered');
}

/**
 * Cleanup controller IPC listeners
 */
function cleanupControllerListeners(): void {
  if ((window as any).__controllerListenersCleanup) {
    (window as any).__controllerListenersCleanup();
    delete (window as any).__controllerListenersCleanup;
    console.log('[SessionStore] Controller listeners cleaned up');
  }
}

export const useSessionStore = create<SessionState & SessionActions>((set, get) => ({
  sessions: {},
  activeSessionId: null,
  projectSessionIndex: new Map<string, string>(),
  rulesInjectedSessions: new Set<string>(),

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
                  // ★ 清理残留的 streaming 状态（前端重启后后端已终止）
                  const trimmedMessages = getRecentRounds(sessionData.messages, INITIAL_ROUNDS).map(m =>
                    m.isStreaming ? { ...m, isStreaming: false, isThinking: false } : m
                  );
                  const trimmedSession: Session = {
                    ...sessionData,
                    messages: trimmedMessages,
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

        // ★ 注册应用退出前的强制保存处理
        registerBeforeUnloadHandler();

        // ★ 恢复上次未保存的会话（崩溃恢复）
        await restorePendingSessionsFromBackup();

        // ★ 注册控制器 IPC 监听器
        setupControllerListeners();

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
      // ★ 更新 Project 的 activeSessionId（持久化）
      const projectStore = useProjectStore.getState();
      projectStore.updateProject(projectId, { activeSessionId: existingSession.id });
      // ★ 加载已保存的草稿
      loadInputDraft(existingSession.id).then(draft => {
        if (draft) {
          set(state => ({
            sessions: {
              ...state.sessions,
              [existingSession.id]: {
                ...state.sessions[existingSession.id],
                inputDraft: draft,
              },
            },
          }));
          console.log(`[SessionStore] Loaded saved draft for session: ${existingSession.id}`);
        }
      }).catch(err => {
        console.warn('[SessionStore] Failed to load draft:', err);
      });
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

    // ★ 更新 Project 的 activeSessionId（持久化）
    const projectStore = useProjectStore.getState();
    projectStore.updateProject(projectId, { activeSessionId: sessionId });

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

    // ★ 控制器命令拦截 - 只设置标记，继续执行普通消息流程
    const controllerMatch = content.match(/^\/([\w-]+-controller)/);
    const isControllerCommand = !!controllerMatch;
    const skillName = controllerMatch ? controllerMatch[1] : null;

    if (isControllerCommand) {
      console.log(`[SessionStore] Controller command detected: ${skillName}`);
    }

    // ★ 生成追踪 ID
    const traceId = `${sessionId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    console.log(`[TRACE-AI] ========================================`);
    console.log(`[TRACE-AI] [FRONTEND] sendMessage ENTRY | traceId=${traceId} | content="${content.substring(0, 50)}"`);
    console.log(`[TRACE-AI] ========================================`);

    // ★ 清除残留的 connectionNotice，确保新会话不会显示旧的提示
    if (session.connectionNotice) {
      set(state => {
        const s = state.sessions[sessionId];
        if (!s) return state;
        return {
          sessions: { ...state.sessions, [sessionId]: { ...s, connectionNotice: null } }
        };
      });
      console.log(`[SessionStore] Cleared residual connectionNotice for session: ${sessionId}`);
    }

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

      // ★ Auto-generate title from first user message if not set
      const shouldUpdateTitle = !existingSession.title || existingSession.title === '新会话';
      const newTitle = shouldUpdateTitle
        ? (() => {
            const firstLine = content.split('\n')[0].trim();
            return firstLine.length > 50 ? firstLine.slice(0, 50) + '...' : firstLine;
          })()
        : existingSession.title;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            messages: updatedMessages,
            lastActiveAt: new Date().toISOString(),
            title: newTitle,
          },
        },
      };
    });

    // Create placeholder for assistant message
    // 控制器命令直接创建 isStreaming: false，普通消息创建 isStreaming: true
    const assistantMessageId = get().addAssistantMessage(sessionId, '', !isControllerCommand);
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

    // ★ Get provider - 优先使用会话级覆盖，其次使用全局默认
    const providerId = session?.overrideProviderId || agentStore.config?.providerId;
    if (!providerId) {
      console.error('[SessionStore] No providerId available');
      get().updateMessage(sessionId, assistantMessageId, {
        content: '未配置 API Provider',
        isStreaming: false,
      });
      return;
    }

    // ★ 检测 Provider 变更，中止当前流式响应
    if (session?.lastUsedProviderId && session.lastUsedProviderId !== providerId) {
      console.log('[SessionStore] Provider changed from', session.lastUsedProviderId, 'to', providerId, '- aborting current turn');
      // ★ 停止流活跃检测
      stopStreamingActivityCheck(sessionId);
      // ★ 清除交互面板（AskUserQuestion 等，防止切换后残留）
      get().clearInteractivePanel(sessionId);
      try {
        await window.api.claude.abort(sessionId);
      } catch (err) {
        console.warn('[SessionStore] Failed to abort session:', err);
      }
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

    // ★ 记录本次使用的 Provider ID
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            lastUsedProviderId: providerId,
          },
        },
      };
    });

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

      // ★ 获取模型 - 优先使用会话级覆盖，其次使用 Provider 默认
      const model = session?.overrideModel || provider.defaultModel;

      console.log('[SessionStore] apiKey (first 20 chars):', apiKey?.substring(0, 20));
      console.log('[SessionStore] apiKey length:', apiKey?.length);
      console.log('[SessionStore] model:', model);
      console.log('[SessionStore] provider.baseUrl:', provider.baseUrl);
      console.log('[SessionStore] provider.apiType:', provider.apiType);

      const startResult = await window.api.claude.startSession({
        sessionId,
        workingDirectory: project.path,
        apiKey: apiKey,
        baseUrl: provider.baseUrl,
        model: model,  // ★ 使用会话级或 Provider 默认模型
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
              // 会话状态变化
              console.log('[SessionStore] Session state changed:', statusData.sessionState);
              if (statusData.sessionState === 'requires_action') {
                useActivityStore.getState().startActivity(sessionId, {
                  type: 'status',
                  detail: '等待用户操作...',
                  timestamp: Date.now(),
                });
              } else if (statusData.sessionState === 'idle') {
                // ★ SDK 已空闲，检查前端是否还在 streaming（状态不同步）
                const currentSession = get().sessions[sessionId];
                const hasStreaming = currentSession?.messages.some(m => m.isStreaming);
                if (hasStreaming) {
                  console.warn('[SessionStore] SDK idle but frontend still streaming, forcing sync');
                  // 强制同步状态
                  set(state => {
                    const existingSession = state.sessions[sessionId];
                    if (!existingSession) return state;
                    return {
                      sessions: {
                        ...state.sessions,
                        [sessionId]: {
                          ...existingSession,
                          messages: existingSession.messages.map(m =>
                            m.isStreaming ? { ...m, isStreaming: false, isThinking: false } : m
                          ),
                        },
                      },
                    };
                  });
                  useActivityStore.getState().endThinking(sessionId);
                  useActivityStore.getState().endActivity(sessionId);
                  stopStreamingActivityCheck(sessionId);
                }
              }
              // 注意：Agent 完成检测已移到 complete 事件处理中（通过 JSON status 字段检测）
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
        } else if (type === 'remote_user_message') {
          // ★ 远程用户消息（来自微信/远程控制）
          // 添加用户消息到会话，确保对话完整显示和持久化
          console.log('[SessionStore] Remote user message:', eventContent?.substring(0, 50));
          const userMessage: Message = {
            id: uuidv4(),
            role: 'user',
            content: eventContent || '',
            timestamp: new Date().toISOString(),
            sessionId,
            isRemote: true, // 标记为远程消息
          };
          set(state => {
            const existingSession = state.sessions[sessionId];
            if (!existingSession) return state;
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...existingSession,
                  messages: trimMessages([...existingSession.messages, userMessage]),
                  lastActiveAt: new Date().toISOString(),
                },
              },
            };
          });
          // ★ 触发增量保存
          triggerIncrementalSave(sessionId);
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
          // ★ 流活跃检测：更新活跃状态
          const session = get().sessions[sessionId];
          const streamingMsg = session?.messages.find(m => m.id === assistantMessageId);
          if (streamingMsg) {
            updateStreamingActivity(sessionId, streamingMsg.content?.length ?? 0, set, get);
          }
          // ★ 增量保存：流式文本每 2 秒保存一次
          triggerIncrementalSave(sessionId);
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
          // ★ 流活跃检测：thinking 事件也更新活跃状态
          const thinkingSession = get().sessions[sessionId];
          const thinkingMsg = thinkingSession?.messages.find(m => m.id === assistantMessageId);
          if (thinkingMsg) {
            updateStreamingActivity(sessionId, thinkingMsg.content?.length ?? 0, set, get);
          }
        } else if (type === 'tool_use' && toolName) {
          // ★ SpectrAI Architecture: Create independent ToolUseMessage
          // Instead of embedding toolCalls in assistant message, add as independent message
          const toolUseId = progressEvent.toolUseId || uuidv4();

          // ★ Debug: 检查 toolInput
          console.log('[SessionStore] tool_use event:', { toolName, toolUseId, toolInput, hasToolInput: !!toolInput, keys: toolInput ? Object.keys(toolInput) : [] });

          if (toolName === 'AskUserQuestion' && toolInput?.questions) {
            // Handle AskUserQuestion tool - this requires user interaction
            console.log('[SessionStore] AskUserQuestion tool detected:', toolInput);
            console.log('[SessionStore] AskUserQuestion questions:', JSON.stringify(toolInput.questions, null, 2));
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
                      pendingControllerInput: existingSession.interactivePanel?.pendingControllerInput || null,
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
                      pendingControllerInput: existingSession.interactivePanel?.pendingControllerInput || null,
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
          // ★ 增量保存：工具结果到达时保存
          triggerIncrementalSave(sessionId);
        } else if (type === 'tool_use_update') {
          // ★ 更新已有的 tool_use 消息的 input（流式开始时 input 为空，这里补充完整参数）
          const toolUseId = progressEvent.toolUseId;
          console.log('[SessionStore] Tool use update received:', { toolUseId, toolName, toolInput });

          if (toolUseId && toolInput) {
            // 先刷新批处理队列，确保 tool_use 消息已经在 state 中
            immediateFlushToolBatchForSession(sessionId);

            // ★ 特殊处理：AskUserQuestion 工具需要更新 pendingQuestion
            if (toolName === 'AskUserQuestion' && toolInput.questions) {
              console.log('[SessionStore] AskUserQuestion tool_use_update - setting pendingQuestion');
              console.log('[SessionStore] questions data:', JSON.stringify(toolInput.questions, null, 2));
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
                        pendingControllerInput: existingSession.interactivePanel?.pendingControllerInput || null,
                      },
                    },
                  },
                };
              });
            } else if (toolName === 'ExitPlanMode' && toolInput) {
              // ★ 特殊处理：ExitPlanMode 工具需要更新 pendingApproval
              console.log('[SessionStore] ExitPlanMode tool_use_update - setting pendingApproval');
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
                        pendingControllerInput: existingSession.interactivePanel?.pendingControllerInput || null,
                      },
                    },
                  },
                };
              });
            }

            // 更新已有的 tool_use 消息的 toolInput
            set(state => {
              const existingSession = state.sessions[sessionId];
              if (!existingSession) return state;

              const updatedMessages = existingSession.messages.map(m => {
                if (m.role === 'tool_use' && m.toolUseId === toolUseId) {
                  // 只有当 input 为空或键数为 0 时才更新
                  const currentInput = m.toolInput || {};
                  const hasEmptyInput = Object.keys(currentInput).length === 0;
                  if (hasEmptyInput) {
                    console.log('[SessionStore] Updating toolInput for toolUseId:', toolUseId, 'keys:', Object.keys(toolInput));
                    return { ...m, toolInput };
                  }
                }
                return m;
              });

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
        } else if (type === 'error') {
          // ★ 流活跃检测：停止检测
          stopStreamingActivityCheck(sessionId);

          // Flush any pending batches before handling error
          immediateFlushToolBatchForSession(sessionId);
          immediateFlushBufferForSession(sessionId, set);

          // ★★★ 修复：查找并更新所有 streaming 消息，解决并发/监听器替换问题 ★★★
          set(state => {
            const existingSession = state.sessions[sessionId];
            if (!existingSession) return state;

            // 更新所有 streaming 消息，添加错误内容
            const updatedMessages = existingSession.messages.map(m => {
              if (m.isStreaming) {
                return {
                  ...m,
                  content: m.content ? `${m.content}\n\nError: ${eventContent}` : `Error: ${eventContent}`,
                  isStreaming: false,
                  isThinking: false,
                };
              }
              return m;
            });

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

          // ★ 重要：结束思考计时器和活动状态
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);
          // ★ 取消增量保存定时器
          cancelIncrementalSave(sessionId);
          // ★ 错误时也要保存，防止崩溃丢失数据
          const session = get().sessions[sessionId];
          if (session && session.messages?.length > 0) {
            saveSessionToDisk(session).catch(err => {
              console.error('[SessionStore] Failed to save session on error:', err);
            });
          }
          // ★ 清除交互面板（AskUserQuestion 等）
          get().clearInteractivePanel(sessionId);
          // ★ 修复：只清理该会话的监听器
          cleanupProgressListenerForSession(sessionId);
        } else if (type === 'complete') {
          // ★ 流活跃检测：停止检测
          stopStreamingActivityCheck(sessionId);

          // Flush any pending batches before marking complete
          immediateFlushToolBatchForSession(sessionId);
          immediateFlushBufferForSession(sessionId, set);

          // ★ 会话结束时再刷新一次上下文使用量，确保最终值准确
          // 使用 void 显式忽略 Promise，因为回调函数不返回 Promise
          void refreshContextUsage(sessionId, set);

          // ★★★ 修复：查找并更新所有 streaming 消息，解决并发/监听器替换问题 ★★★
          // 不再依赖单个 assistantMessageId，而是批量处理所有 isStreaming 的消息
          set(state => {
            const existingSession = state.sessions[sessionId];
            if (!existingSession) return state;

            const hasStreamingMsg = existingSession.messages.some(m => m.isStreaming);
            if (!hasStreamingMsg) return state;

            console.log('[SessionStore] Complete: resetting all streaming messages for session:', sessionId);

            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...existingSession,
                  messages: existingSession.messages.map(m => {
                    if (!m.isStreaming) return m;
                    return { ...m, isStreaming: false, isThinking: false };
                  }),
                },
              },
            };
          });

          // End thinking timer and clear activity
          useActivityStore.getState().endThinking(sessionId);
          useActivityStore.getState().endActivity(sessionId);
          // ★ 清除交互面板（AskUserQuestion 等，防止软中断后残留）
          get().clearInteractivePanel(sessionId);
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
            const latestSession = get().sessions[sessionId];
            const latestUsage = latestSession?.tokenUsage;

            if (latestUsage) {
              // ★ 计算有效使用率：输入 + 输出预留空间
              const effectiveUsed = latestUsage.inputTokens + OUTPUT_TOKEN_RESERVE;
              const newPercentage = (effectiveUsed / latestUsage.contextWindow) * 100;
              if (newPercentage > 80) {
                console.log('[SessionStore] Auto-compact needed after message, percentage:', newPercentage.toFixed(1), '%');
                // 延迟 2 秒触发，避免阻塞当前响应
                setTimeout(() => {
                  const currentSession = get().sessions[sessionId];
                  const currentUsage = currentSession?.tokenUsage;

                  if (currentUsage) {
                    const effectiveUsedDelayed = currentUsage.inputTokens + OUTPUT_TOKEN_RESERVE;
                    const pct = (effectiveUsedDelayed / currentUsage.contextWindow) * 100;
                    if (pct > 80) {
                      console.log('[SessionStore] Triggering auto-compact, percentage:', pct.toFixed(1), '%');
                      get().triggerCompact(sessionId);
                    }
                  }
                }, 2000);
              }
            }
          } else {
            console.log('[SessionStore] No usageData in complete event');
          }

          // ★★★ Agent 完成检测：检测最后一条 assistant 消息中的 JSON 结果 ★★★
          // 只要解析出有效 JSON，就认为 Agent 完成
          for (const [agentCallKey, pendingCall] of pendingAgentCalls) {
            if (pendingCall.sessionId === sessionId) {
              console.log('[SessionStore] ★ Agent 完成检测：检查 pending agent call:', agentCallKey);

              const session = get().sessions[sessionId];
              // 找到最后一条非流式的 assistant 消息
              const lastAssistantMsg = [...session.messages]
                .reverse()
                .find(m => m.role === 'assistant' && !m.isStreaming);

              if (lastAssistantMsg?.content) {
                const result = parseAgentOutput(lastAssistantMsg.content);
                console.log('[SessionStore] ★ parseAgentOutput 结果:', result ? `status=${result.status}, success=${result.success}` : 'null');

                // 只要解析出有效 JSON，就认为 Agent 完成
                if (result) {
                  console.log('[SessionStore] ★★★ Agent 完成 (JSON 检测) ★★★');
                  console.log('[SessionStore] ★ agentName:', pendingCall.agentName);
                  console.log('[SessionStore] ★ toolCallId:', pendingCall.toolCallId);
                  console.log('[SessionStore] ★ status:', result.status);
                  console.log('[SessionStore] ★ success:', result.success);
                  console.log('[SessionStore] ★ summary:', result.summary?.slice(0, 100));

                  // ★ 验证并转换 status 为合法的字面量类型
                  const validStatuses = ['done', 'failed', 'blocked'] as const;
                  const normalizedStatus: 'done' | 'failed' | 'blocked' =
                    validStatuses.includes(result.status as typeof validStatuses[number])
                      ? (result.status as 'done' | 'failed' | 'blocked')
                      : (result.success ? 'done' : 'failed');

                  // 发送 Agent 结果给控制器
                  window.api.controller.sendAgentResult(
                    sessionId,
                    pendingCall.agentName,
                    pendingCall.toolCallId,
                    {
                      ...result,
                      status: normalizedStatus,
                    }
                  );

                  // 清理映射表
                  pendingAgentCalls.delete(agentCallKey);
                  agentToolCallMap.delete(agentCallKey);
                  console.log('[SessionStore] ★ 已清理 pendingAgentCalls 和 agentToolCallMap');
                }
              } else {
                console.log('[SessionStore] ★ 未找到有效的 assistant 消息');
              }
            }
          }
        }
      });

      // ★ Step 3: 检查是否有继承的上下文摘要（重置会话后第一次发送）
      let finalContent = content;
      const currentSession = get().sessions[sessionId];

      // ★ 计算当前轮次（用户消息数量）
      const currentTurnCount = currentSession?.messages.filter(m => m.role === 'user').length || 0;

      // ★ 本次启动后首次交互：注入完整开发行为准则
      const rulesInjectedSessions = get().rulesInjectedSessions;
      const shouldInjectRules = !rulesInjectedSessions.has(sessionId);

      if (shouldInjectRules) {
        const DEVELOPMENT_RULES = `## 开发行为准则 [MANDATORY]

### 1. 先思考再编码
- 明确假设，不确定先问
- 多种理解时列出选项，不私下选择
- 存在更简方案时说明，必要时反驳
- 困惑时停止，命名困惑点，提问

### 2. 简洁优先
- 只写解决问题所需的最少代码
- 不添加未请求的功能/抽象/配置
- 200 行能写成 50 行就重写

### 3. 手术式修改
- 只触碰必须修改的地方
- 不"改进"相邻代码/注释/格式
- 匹配现有风格

### 4. 目标驱动
- 任务转化为可验证目标
- 多步任务先陈述简短计划

### 5. 开发流程 [CRITICAL]

**功能开发流程：**
1. codegraph_explore 理解代码
2. 输出方案
3. [STOP] 等用户确认
4. 编码实现
5. git status && git diff 复核变更
6. git add && git commit 提交

**问题修复流程：**
1. 定位根因
2. 输出修复方案
3. [STOP] 等用户确认
4. 修改代码
5. git status && git diff 复核变更
6. git add && git commit 提交

[CRITICAL] 看到 [STOP] 必须停止，等待用户确认后再继续。

---

`;
        finalContent = DEVELOPMENT_RULES + finalContent;
        // 标记该会话已注入规则
        set(state => ({
          rulesInjectedSessions: new Set(state.rulesInjectedSessions).add(sessionId)
        }));
        console.log('[SessionStore] First interaction after launch: injecting development rules for session', sessionId);
      }

      // ★ 周期性流程提醒：每 5 轮注入一次简版提醒（加强记忆）
      const REMINDER_INTERVAL = 5;
      const PROCESS_REMINDER = `[流程提醒]
1. 先思考再编码：不确定先问
2. 简洁优先：最少代码解决问题
3. 手术式修改：只改必须改的
4. [STOP] 方案输出后等确认再编码
5. 完成后 Git 提交：git status → git diff → git add → git commit
`;

      if (currentTurnCount > 0 && currentTurnCount % REMINDER_INTERVAL === 0) {
        finalContent = PROCESS_REMINDER + '\n\n[用户消息]\n' + finalContent;
        console.log(`[SessionStore] Injecting process reminder at turn ${currentTurnCount}`);
      }

      // ★ 使用 ID 前缀精确匹配，避免字符串内容匹配的误判
      const contextSummaryMsg = currentSession?.messages.find(
        m => m.id.startsWith('context-summary-') && !m.content.includes('*(已发送给 AI)*')
      );

      if (contextSummaryMsg) {
        // 将摘要附加到用户消息前面发送给 AI
        finalContent = `${contextSummaryMsg.content}\n\n---\n\n**用户当前问题**: ${finalContent}`;
        console.log('[SessionStore] First message after reset: attaching context summary for AI');

        // 标记摘要已发送，后续不再附加
        get().updateMessage(sessionId, contextSummaryMsg.id, {
          content: contextSummaryMsg.content + '\n\n*(已发送给 AI)*'
        });
      }

      // ★ Step 4: 发送消息或控制器命令
      console.log(`[TRACE-AI] [FRONTEND] Step 4 | traceId=${traceId}`);

      if (isControllerCommand && skillName) {
        // ★ 控制器命令：调用 controller.run 而不是 sendMessage
        console.log('[SessionStore] Calling controller.run...');
        const result = await window.api.controller.run({
          sessionId,
          projectRoot: project.path,
          skillName,
        });

        if (!result.success) {
          throw new Error(result.error || 'Controller run failed');
        }
        console.log('[SessionStore] Controller started, waiting for Agent calls...');
      } else {
        // ★ 普通消息：调用 sendMessage
        console.log(`[TRACE-AI] [FRONTEND] Calling claude.sendMessage IPC | traceId=${traceId}`);
        console.log('[SessionStore] Sending message...');
        const sendResult = await window.api.claude.sendMessage(sessionId, finalContent);

        if (!sendResult.success) {
          throw new Error(sendResult.error || 'Failed to send message');
        }
        console.log('[SessionStore] Message sent, waiting for response...');
      }

      // ★ 启动心跳检测
      startHeartbeatCheck(sessionId, assistantMessageId, set, get);

      // ★ 启动流活跃检测（30秒级）
      startStreamingActivityCheck(sessionId, set, get);

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

      // ★ 取消增量保存定时器（因为会立即执行最终保存）
      cancelIncrementalSave(sessionId);

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
      // ★ 发送失败时也要保存会话，防止用户消息丢失
      cancelIncrementalSave(sessionId);
      const session = get().sessions[sessionId];
      if (session && session.messages?.length > 0) {
        await saveSessionToDisk(session).catch(err => {
          console.error('[SessionStore] Failed to save session on send error:', err);
        });
      }
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

    // ★ 取消增量保存定时器
    cancelIncrementalSave(sessionId);

    // ★ 重启前保存当前状态
    if (session.messages?.length > 0) {
      console.log(`[SessionStore] Saving session before restart: ${sessionId}`);
      await saveSessionToDisk(session).catch(err => {
        console.error('[SessionStore] Failed to save session before restart:', err);
      });
    }

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
   * Reset session (archive old session, create new session with inherited context)
   * @param sessionId Session ID
   */
  resetSession: async (sessionId) => {
    const { sessions, activeSessionId } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    console.log(`[SessionStore] Resetting session: ${sessionId}`);

    // ★ Step 1: 创建新会话并继承上下文
    const newSessionId = await get().createSessionWithContext(session);

    // ★ Step 2: 切换到新会话（强制切换）
    if (newSessionId) {
      get().switchToSession(newSessionId);
    }

    // ★ Step 3: 归档原会话（切换后再归档，避免活跃会话归档错误）
    await get().archiveSession(sessionId);

    console.log(`[SessionStore] Session reset complete: ${sessionId} → ${newSessionId}`);
  },

  /**
   * ★ 核心逻辑：创建新会话并继承上下文
   * 从源会话智能加载历史，生成摘要，创建新会话
   * 用于 cloneSession 和 95% 兜底压缩
   *
   * @param sourceSession 源会话
   * @param options.titlePrefix 标题前缀（如 "[克隆]"）
   * @returns 新会话 ID
   */
  createSessionWithContext: async (sourceSession: Session, options?: { titlePrefix?: string }): Promise<string> => {
    const newSessionId = uuidv4();
    const now = new Date().toISOString();

    // ★ Step 1: 智能加载对话历史（动态轮数，目标 50K-80K tokens）
    const smartLoadResult = getSmartRounds(sourceSession.messages);
    const { messages: recentMessages, roundsLoaded, totalTokens, stoppedReason } = smartLoadResult;
    console.log(`[SessionStore] createSessionWithContext: Smart loaded ${recentMessages.length} messages from ${roundsLoaded} rounds (${totalTokens} tokens, reason: ${stoppedReason})`);

    // ★ Step 2: 创建继承消息
    // - session-inherited-divider: 元数据标记，前端显示分隔线
    // - context-summary-xxx: 摘要文本，首次发送给 AI
    // - 原始消息: 前端显示 + 历史记录持久化
    let initialMessages: Message[] = [];
    if (recentMessages.length > 0) {
      // 生成摘要（用于首次发送给 AI）
      const contextSummary = buildContextSummary(recentMessages, 10000);

      initialMessages = [
        {
          id: `session-inherited-divider-${newSessionId}`,
          role: 'system',
          content: JSON.stringify({
            rounds: roundsLoaded,
            tokens: totalTokens,
            reason: stoppedReason,
          }),
          timestamp: now,
        },
        {
          id: `context-summary-${uuidv4()}`,
          role: 'system',
          content: contextSummary,
          timestamp: now,
        },
        ...recentMessages,  // 原始消息用于前端显示和历史记录
      ];
    }

    // ★ Step 3: 生成标题
    const originalTitle = sourceSession.title || generateSessionTitle(sourceSession.messages);
    const newTitle = options?.titlePrefix
      ? `${options.titlePrefix} ${originalTitle}`
      : originalTitle;

    // ★ Step 4: 创建新会话
    const newSession: Session = {
      id: newSessionId,
      projectId: sourceSession.projectId,
      messages: initialMessages,
      createdAt: now,
      lastActiveAt: now,
      status: 'connected',
      title: newTitle,
    };

    // ★ Step 5: 添加到内存
    set(state => ({
      sessions: { ...state.sessions, [newSessionId]: newSession },
    }));

    // ★ Step 6: 保存到磁盘
    await saveSessionToDisk(newSession);

    console.log(`[SessionStore] Created new session with context: ${newSessionId} (from ${sourceSession.id})${recentMessages.length > 0 ? ` with ${recentMessages.length} inherited messages` : ''}`);

    return newSessionId;
  },


  /**
   * Create a new blank session (does not reuse existing session)
   * Used for "New Session" button in session history selector
   * @param projectId Project ID
   * @returns New session ID
   */
  createNewSession: async (projectId) => {
    if (!initialized) {
      console.error('[SessionStore] createNewSession called before initialization!');
      return '';
    }

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
      projectSessionIndex: new Map(state.projectSessionIndex).set(projectId, sessionId),
    }));

    // ★ 更新 Project 的 activeSessionId（与 switchToSession 保持一致）
    const projectStore = useProjectStore.getState();
    projectStore.updateProject(projectId, { activeSessionId: sessionId });

    // Save to disk
    await get().saveSession(sessionId);

    console.log(`[SessionStore] Created new blank session: ${sessionId} for project: ${projectId}`);
    return sessionId;
  },

  /**
   * Clone a session (copy messages to new session)
   * @param sessionId Source session ID
   * @returns New session ID
   */
  cloneSession: async (sessionId) => {
    const { sessions } = get();
    let sourceSession = sessions[sessionId];

    if (!sourceSession) {
      // Try to load from disk
      const diskSession = await loadSessionFromDisk(sessionId);
      if (!diskSession) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      sourceSession = diskSession;
    }

    // ★ 使用核心逻辑创建新会话（继承上下文）
    const newSessionId = await get().createSessionWithContext(sourceSession, { titlePrefix: '[克隆]' });

    console.log('[SessionStore] Cloned session with context:', sessionId, '->', newSessionId);
    return newSessionId;
  },

  /**
   * Archive a session
   * @param sessionId Session ID
   */
  archiveSession: async (sessionId) => {
    const { sessions, activeSessionId } = get();

    // Cannot archive active session
    if (sessionId === activeSessionId) {
      throw new Error('无法归档当前活跃会话，请先切换到其他会话');
    }

    const session = sessions[sessionId];
    if (!session) {
      throw new Error('会话不存在');
    }

    const now = new Date().toISOString();

    // Mark as archived
    set(state => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          archived: true,
          archivedAt: now,
        },
      },
    }));

    // Save to disk
    await get().saveSession(sessionId);

    // Cleanup expired archives
    await get().cleanupArchivedSessions();

    console.log('[SessionStore] Archived session:', sessionId);
  },

  /**
   * Unarchive a session
   * @param sessionId Session ID
   */
  unarchiveSession: async (sessionId) => {
    const { sessions } = get();
    const session = sessions[sessionId];

    if (!session) {
      throw new Error('会话不存在');
    }

    // Remove archived flag
    set(state => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          archived: false,
          archivedAt: undefined,
        },
      },
    }));

    // Save to disk
    await get().saveSession(sessionId);

    console.log('[SessionStore] Unarchived session:', sessionId);
  },

  /**
   * Cleanup expired archived sessions (max 30)
   * Note: Claude Code session files are not deleted automatically
   * as there's no IPC interface for home directory access
   */
  cleanupArchivedSessions: async () => {
    const { sessions } = get();
    const ARCHIVE_LIMIT = 30;

    // Get all archived sessions, sorted by archivedAt (oldest first)
    const archivedSessions = Object.values(sessions)
      .filter(s => s.archived && s.archivedAt)
      .sort((a, b) => new Date(a.archivedAt!).getTime() - new Date(b.archivedAt!).getTime());

    if (archivedSessions.length <= ARCHIVE_LIMIT) {
      return;
    }

    // Delete oldest archives that exceed limit
    const toDelete = archivedSessions.slice(0, archivedSessions.length - ARCHIVE_LIMIT);

    for (const session of toDelete) {
      // Remove from memory
      set(state => {
        const { [session.id]: _, ...remaining } = state.sessions;
        return { sessions: remaining };
      });

      // Delete app session file
      const filePath = await getSessionFilePath(session.id);
      try {
        await deleteFile(filePath);
      } catch (err) {
        console.warn('[SessionStore] Failed to delete session file:', err);
      }

      console.log('[SessionStore] Deleted expired archive:', session.id);
    }
  },

  /**
   * Get session list (lightweight, for UI display)
   * @param projectId Optional project ID to filter by
   * @returns Session list sorted by lastActiveAt
   */
  getSessionList: async (projectId?: string): Promise<SessionListItem[]> => {
    try {
      const sessionIds = await listAllSessions();
      const projectStore = useProjectStore.getState();

      const sessionList = await Promise.all(
        sessionIds.map(async (sessionId) => {
          const session = await loadSessionFromDisk(sessionId);
          if (!session) {
            return null;
          }

          // Filter by project if specified
          if (projectId && session.projectId !== projectId) {
            return null;
          }

          // Get project name
          const project = projectStore.projects.find(p => p.id === session.projectId);

          return {
            id: session.id,
            projectId: session.projectId,
            projectName: project?.name,
            title: session.title || generateSessionTitle(session.messages),
            createdAt: session.createdAt,
            lastActiveAt: session.lastActiveAt,
            archived: session.archived || false,
            archivedAt: session.archivedAt,
            messageCount: session.messages?.length || 0,
          } as SessionListItem;
        })
      );

      // Filter out null entries and sort by lastActiveAt (newest first)
      return sessionList
        .filter((s): s is SessionListItem => s !== null)
        .sort((a, b) =>
          new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
        );
    } catch (err) {
      console.error('[SessionStore] Failed to load session list:', err);
      return [];
    }
  },

  /**
   * Switch to a different session
   * @param sessionId Target session ID
   */
  switchToSession: async (sessionId) => {
    const { sessions, activeSessionId } = get();

    if (sessionId === activeSessionId) {
      console.log('[SessionStore] Already on this session');
      return;
    }

    // Save current session draft
    if (activeSessionId) {
      const currentDraft = sessions[activeSessionId]?.inputDraft;
      if (currentDraft) {
        await saveInputDraft(activeSessionId, currentDraft);
      }
    }

    // Close current SDK session
    if (activeSessionId) {
      try {
        await window.api.claude.closeSession(activeSessionId);
        console.log('[SessionStore] Closed SDK session:', activeSessionId);
      } catch (err) {
        console.warn('[SessionStore] Failed to close SDK session:', err);
      }
    }

    // Load target session if not in memory
    let targetSession = sessions[sessionId];
    if (!targetSession) {
      const sessionData = await loadSessionFromDisk(sessionId);
      if (!sessionData) {
        console.error('[SessionStore] Session not found on disk:', sessionId);
        return;
      }
      targetSession = sessionData;

      // Add to memory
      set(state => ({
        sessions: { ...state.sessions, [sessionId]: targetSession },
      }));
    }

    // Set as active session
    set({ activeSessionId: sessionId });

    // Update project index
    set(state => ({
      projectSessionIndex: new Map(state.projectSessionIndex).set(
        targetSession.projectId,
        sessionId
      ),
    }));

    // ★ 更新 Project 的 activeSessionId（持久化）
    const projectStore = useProjectStore.getState();
    projectStore.updateProject(targetSession.projectId, { activeSessionId: sessionId });

    // Load draft
    const draft = await loadInputDraft(sessionId);
    if (draft) {
      set(state => ({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...state.sessions[sessionId], inputDraft: draft },
        },
      }));
    }

    console.log('[SessionStore] Switched to session:', sessionId);
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
    const { activeSessionId, sessions } = get();

    // ★ 切换前保存旧会话的待保存数据
    if (activeSessionId && activeSessionId !== sessionId) {
      const oldSession = sessions[activeSessionId];
      if (oldSession && oldSession.messages?.length > 0) {
        // 检查是否有待保存的数据
        if (incrementalSavePending.get(activeSessionId)) {
          cancelIncrementalSave(activeSessionId);
          saveSessionToDisk(oldSession).catch(err => {
            console.error('[SessionStore] Failed to save session on switch:', err);
          });
        }
      }
    }

    set({ activeSessionId: sessionId });
    console.log(`[SessionStore] Active session set to: ${sessionId}`);

    // ★ 切换后加载新会话的草稿
    if (sessionId && sessionId !== activeSessionId) {
      loadInputDraft(sessionId).then(draft => {
        if (draft) {
          set(state => {
            const session = state.sessions[sessionId];
            if (!session) return state;
            return {
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...session,
                  inputDraft: draft,
                },
              },
            };
          });
          console.log(`[SessionStore] Loaded draft for session: ${sessionId}`);
        }
      }).catch(err => {
        console.warn('[SessionStore] Failed to load draft:', err);
      });
    }
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

    // ★ 取消增量保存定时器
    cancelIncrementalSave(sessionId);

    // ★ 停止流活跃检测定时器
    stopStreamingActivityCheck(sessionId);

    // ★ 清理进度监听器
    cleanupProgressListenerForSession(sessionId);

    // ★ 中止后端会话
    try {
      await window.api.claude.abort(sessionId);
    } catch (err) {
      console.warn('[SessionStore] Failed to abort session on delete:', err);
    }

    // ★ 关闭后端会话
    try {
      await window.api.claude.closeSession(sessionId);
    } catch (err) {
      console.warn('[SessionStore] Failed to close session on delete:', err);
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

    // ★ 删除草稿文件
    await deleteInputDraft(sessionId);

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
   * ★ 更新会话的消息列表（用于崩溃恢复）
   * @param sessionId Session ID
   * @param messages New messages array
   */
  updateSessionMessages: (sessionId, messages) => {
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messages,
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

    // ★ 取消增量保存定时器
    cancelIncrementalSave(sessionId);

    // ★ 停止流活跃检测定时器
    stopStreamingActivityCheck(sessionId);

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
              pendingControllerInput: panel.pendingControllerInput ?? session.interactivePanel?.pendingControllerInput ?? null,
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
              pendingControllerInput: null,
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
   * Set controller input request
   * Called when controller requests user input via IPC
   * @param sessionId Session ID
   * @param request Input request data
   */
  setControllerInputRequest: (sessionId, request) => {
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            interactivePanel: {
              pendingPermission: session.interactivePanel?.pendingPermission || null,
              pendingQuestion: session.interactivePanel?.pendingQuestion || null,
              pendingApproval: session.interactivePanel?.pendingApproval || null,
              pendingControllerInput: request,
            },
          },
        },
      };
    });

    if (request) {
      console.log(`[SessionStore] Controller input request set for session: ${sessionId}`);
    }
  },

  /**
   * Clear controller input request
   * @param sessionId Session ID
   */
  clearControllerInputRequest: (sessionId) => {
    set(state => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      const currentPanel = session.interactivePanel || {
        pendingPermission: null,
        pendingQuestion: null,
        pendingApproval: null,
        pendingControllerInput: null,
      };

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            interactivePanel: {
              pendingPermission: currentPanel.pendingPermission,
              pendingQuestion: currentPanel.pendingQuestion,
              pendingApproval: currentPanel.pendingApproval,
              pendingControllerInput: null,
            },
          },
        },
      };
    });

    console.log(`[SessionStore] Controller input request cleared for session: ${sessionId}`);
  },

  /**
   * Respond to controller input request
   * Sends the answer back to the controller via IPC
   * @param sessionId Session ID
   * @param requestId Request ID
   * @param answer User's answer
   */
  respondToControllerInput: (sessionId, requestId, answer) => {
    const { sessions } = get();
    const session = sessions[sessionId];
    if (!session) {
      console.warn(`[SessionStore] Session not found: ${sessionId}`);
      return;
    }

    // 防止重复调用：检查请求是否仍然待处理
    const pendingInput = session.interactivePanel?.pendingControllerInput;
    if (!pendingInput || pendingInput.requestId !== requestId) {
      console.warn(`[SessionStore] Controller input already handled or mismatched: ${requestId}`);
      return;
    }

    // Send response to controller via IPC
    window.api.controller.respondToInput(requestId, answer);

    // Clear the pending state
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
              pendingApproval: existingSession.interactivePanel?.pendingApproval || null,
              pendingControllerInput: null,
            },
          },
        },
      };
    });

    console.log(`[SessionStore] Controller input response sent: ${requestId}`);
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

    // ★ 防抖检查：冷却期内跳过
    if (session.lastCompactAt) {
      const lastCompact = new Date(session.lastCompactAt).getTime();
      const elapsed = Date.now() - lastCompact;
      if (elapsed < COMPACT_COOLDOWN_MS) {
        console.log(`[SessionStore] Compact cooldown, skipping (${Math.round(elapsed / 1000)}s ago, need ${COMPACT_COOLDOWN_MS / 1000}s)`);
        return;
      }
    }

    // ★ 压缩前取消增量保存定时器，避免竞态
    cancelIncrementalSave(sessionId);

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

      // ★ 压缩指令：保留最近3轮完整对话，更早内容精简摘要
      const compactInstructions = `永久保留最近3轮完整原始对话不压缩，更早所有对话精简摘要。摘要严格记录：用户硬性约束、已定参数、确定方案、遗留待解决内容。剔除：闲聊、无效试错、冗余日志。`;

      // ★ 发送命令前先设置时间戳，防止并发触发
      get().setLastCompactAt(sessionId, new Date().toISOString());

      // 发送 /compact 命令（带自定义压缩指令）
      console.log(`[TRACE-AI] [FRONTEND] triggerCompact calling claude.sendMessage('/compact') | sessionId=${sessionId}`);
      await window.api.claude.sendMessage(sessionId, `/compact ${compactInstructions}`);
      console.log('[SessionStore] /compact command sent with instructions');

      // 等待 compact_boundary 事件或 15 秒超时
      await compactComplete;

      // 刷新上下文使用量
      await refreshContextUsage(sessionId, set);
      console.log(`[SessionStore] Context usage refreshed after compact for session: ${sessionId}`);

      // ★ 新增：验证压缩效果
      const updatedSession = get().sessions[sessionId];
      const usage = updatedSession?.tokenUsage;

      if (usage) {
        // ★ 使用与前端显示一致的计算方式：inputTokens + OUTPUT_TOKEN_RESERVE
        const effectiveUsed = usage.inputTokens + OUTPUT_TOKEN_RESERVE;
        const newPercentage = (effectiveUsed / usage.contextWindow) * 100;
        console.log('[SessionStore] After compact, percentage:', newPercentage.toFixed(1), '% (input:', usage.inputTokens, '+ reserve:', OUTPUT_TOKEN_RESERVE, ')');

        // ★ 兜底压缩：压缩后 >95% 时自动创建新会话（保留旧会话）
        // 这是当 Claude Code 压缩失败（内容超上下文等）时的兜底机制
        if (newPercentage > 95) {
          console.warn('[SessionStore] ⚠️ Compact ineffective (>95%), auto-creating new session as fallback');

          // 获取当前会话
          const currentSession = get().sessions[sessionId];
          if (currentSession) {
            // 归档旧会话（保留原标题）
            set(state => ({
              sessions: {
                ...state.sessions,
                [sessionId]: {
                  ...state.sessions[sessionId],
                  archived: true,
                  archivedAt: new Date().toISOString(),
                },
              },
            }));
            await get().saveSession(sessionId);

            // ★ 使用核心逻辑创建新会话（继承上下文）
            const newSessionId = await get().createSessionWithContext(currentSession);
            console.log('[SessionStore] Created new session from fallback:', newSessionId);

            // 切换到新会话
            await get().switchToSession(newSessionId);

            // 清理过期归档
            await get().cleanupArchivedSessions();
          }
          return;
        }

        // 重置 autoCompacted 标志，允许后续再次触发压缩
        get().setAutoCompacted(sessionId, false);

        if (newPercentage > 80) {
          console.warn('[SessionStore] ⚠️ Compact partial, still at', newPercentage.toFixed(1), '%');
          console.log('[SessionStore] Will allow retry after 60s cooldown');
        } else {
          console.log('[SessionStore] ✅ Compact effective, reduced to', newPercentage.toFixed(1), '%');
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
    // ★ 持久化草稿（防抖 500ms）
    saveInputDraft(sessionId, draft).catch(err => {
      console.error('[SessionStore] Failed to save draft:', err);
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

  /**
   * Set last compact timestamp - for cooldown mechanism
   * @param sessionId Session ID
   * @param timestamp ISO8601 timestamp (null to clear)
   */
  setLastCompactAt: (sessionId, timestamp) => {
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            lastCompactAt: timestamp ?? undefined,
          },
        },
      };
    });
  },

  /**
   * Set session-level Provider override
   * @param sessionId Session ID
   * @param providerId Provider ID (null to use global default)
   */
  setOverrideProvider: (sessionId, providerId) => {
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            overrideProviderId: providerId || undefined,
          },
        },
      };
    });
  },

  /**
   * Set session-level model override
   * @param sessionId Session ID
   * @param model Model ID (null to use Provider default)
   */
  setOverrideModel: (sessionId, model) => {
    set(state => {
      const existingSession = state.sessions[sessionId];
      if (!existingSession) return state;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...existingSession,
            overrideModel: model || undefined,
          },
        },
      };
    });
  },
}));
