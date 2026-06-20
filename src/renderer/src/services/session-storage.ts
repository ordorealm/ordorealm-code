/**
 * Session Storage Service
 * Handles persistence of session data to local filesystem
 * @module services/session-storage
 */

import { ensureDir, readJsonFile, writeJsonFile, getUserDataPathAsync } from '@/utils/fs';
import { joinPath } from '@/utils/path';
import type { Session, Message } from '@/types';

/**
 * Session file structure for persistence
 */
interface SessionFile {
  version: string;
  session: Session;
  updatedAt: string;
}

const SESSION_FILE_VERSION = '1.0.0';

/**
 * Maximum number of conversation rounds to keep in disk storage
 * This prevents session files from growing indefinitely
 */
const MAX_DISK_ROUNDS = 200;

// ═══════════════════════════════════════════════════════════════
// 轮次裁剪函数（独立实现，避免循环依赖）
// ═══════════════════════════════════════════════════════════════

interface ConversationRound {
  roundIndex: number;
  startIndex: number;
  endIndex: number;
  messageCount: number;
  timestamp: string;
}

/**
 * Identify conversation rounds in message array
 * A round starts with a user message and ends before the next user message
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
 * Trim messages to keep only the most recent N rounds
 * This prevents session files from growing indefinitely
 */
function trimMessagesForDisk(messages: Message[]): Message[] {
  if (!messages || messages.length === 0) return [];

  const rounds = identifyRounds(messages);

  if (rounds.length <= MAX_DISK_ROUNDS) {
    return messages;
  }

  // Keep the most recent MAX_DISK_ROUNDS rounds
  const roundsToKeep = rounds.slice(-MAX_DISK_ROUNDS);
  const startIndex = roundsToKeep[0].startIndex;

  console.log(`[SessionStorage] Trimming for disk: ${rounds.length} rounds -> ${MAX_DISK_ROUNDS} rounds, ${messages.length} messages -> ${messages.length - startIndex} messages`);

  return messages.slice(startIndex);
}

/**
 * Get the file path for a session
 * @param sessionId Session ID
 * @returns Promise resolving to full path to the session file
 */
export async function getSessionFilePath(sessionId: string): Promise<string> {
  const dataPath = await getUserDataPathAsync();
  return joinPath(dataPath, 'sessions', `${sessionId}.json`);
}

/**
 * Ensure the sessions directory exists
 */
async function ensureSessionsDir(): Promise<string> {
  const dataPath = await getUserDataPathAsync();
  const sessionsDir = joinPath(dataPath, 'sessions');
  await ensureDir(sessionsDir);
  return sessionsDir;
}

/**
 * Save a session to disk
 * Automatically trims to MAX_DISK_ROUNDS to prevent file bloat
 * @param session Session to save
 */
export async function saveSessionToDisk(session: Session): Promise<boolean> {
  try {
    await ensureSessionsDir();

    // ★ 裁剪消息到最近 200 轮，防止文件无限增长
    const trimmedMessages = trimMessagesForDisk(session.messages);

    const filePath = await getSessionFilePath(session.id);
    const data: SessionFile = {
      version: SESSION_FILE_VERSION,
      session: {
        ...session,
        messages: trimmedMessages,
      },
      updatedAt: new Date().toISOString(),
    };

    return await writeJsonFile(filePath, data);
  } catch (error) {
    console.error('[SessionStorage] Failed to save session:', error);
    return false;
  }
}

/**
 * Load a session from disk
 * @param sessionId Session ID to load
 * @returns Session data or null if not found
 */
export async function loadSessionFromDisk(sessionId: string): Promise<Session | null> {
  try {
    const filePath = await getSessionFilePath(sessionId);
    const data = await readJsonFile<SessionFile>(filePath);

    if (!data) {
      return null;
    }

    // Version check for future migrations
    if (data.version !== SESSION_FILE_VERSION) {
      console.warn(`[SessionStorage] Session version mismatch: ${data.version}, expected: ${SESSION_FILE_VERSION}`);
      // Could add migration logic here
    }

    // ★ 清理孤立的 tool_result 消息
    if (data.session.messages && data.session.messages.length > 0) {
      const toolUseIds = new Set<string>();

      // 第一遍：收集所有 tool_use 的 ID
      for (const msg of data.session.messages) {
        if (msg.role === 'tool_use' && msg.toolUseId) {
          toolUseIds.add(msg.toolUseId);
        }
      }

      // 第二遍：过滤掉孤立的 tool_result
      const originalLength = data.session.messages.length;
      data.session.messages = data.session.messages.filter(msg => {
        if (msg.role === 'tool_result' && msg.toolUseId) {
          const hasMatchingToolUse = toolUseIds.has(msg.toolUseId);
          if (!hasMatchingToolUse) {
            console.log(`[SessionStorage] 清理孤立 tool_result: ${msg.toolUseId}`);
            return false;
          }
        }
        return true;
      });

      if (data.session.messages.length !== originalLength) {
        console.log(`[SessionStorage] 清理了 ${originalLength - data.session.messages.length} 条孤立消息`);
      }
    }

    return data.session;
  } catch (error) {
    console.error('[SessionStorage] Failed to load session:', error);
    return null;
  }
}

/**
 * Delete a session file from disk
 * @param sessionId Session ID to delete
 */
export async function deleteSessionFromDisk(sessionId: string): Promise<boolean> {
  try {
    const filePath = await getSessionFilePath(sessionId);
    await window.api.fs.delete(filePath);
    return true;
  } catch (error) {
    console.error('[SessionStorage] Failed to delete session:', error);
    return false;
  }
}

/**
 * List all session IDs in storage
 * @returns Array of session IDs
 */
export async function listAllSessions(): Promise<string[]> {
  try {
    const sessionsDir = await ensureSessionsDir();

    // Read directory contents
    const result = await window.api.fs.readDir(sessionsDir, 0);

    if (!result.success || !result.content) {
      return [];
    }

    // Filter for .json files and extract session IDs
    return result.content
      .filter(entry => entry.type === 'file' && entry.name.endsWith('.json'))
      .map(entry => entry.name.replace('.json', ''));
  } catch (error) {
    console.error('[SessionStorage] Failed to list sessions:', error);
    return [];
  }
}

/**
 * Load all sessions from disk
 * @returns Map of session ID to Session
 */
export async function loadAllSessions(): Promise<Record<string, Session>> {
  const sessionIds = await listAllSessions();
  const sessions: Record<string, Session> = {};

  for (const sessionId of sessionIds) {
    const session = await loadSessionFromDisk(sessionId);
    if (session) {
      sessions[sessionId] = session;
    }
  }

  return sessions;
}

/**
 * Get sessions for a specific project
 * @param projectId Project ID
 * @returns Array of sessions for the project
 */
export async function getSessionsByProject(projectId: string): Promise<Session[]> {
  const sessions = await loadAllSessions();
  return Object.values(sessions).filter(session => session.projectId === projectId);
}

/**
 * Clean up old sessions (sessions with no activity for more than 30 days)
 * @returns Number of sessions cleaned up
 */
export async function cleanupOldSessions(): Promise<number> {
  const sessions = await loadAllSessions();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let cleaned = 0;
  for (const session of Object.values(sessions)) {
    const lastActive = new Date(session.lastActiveAt);
    if (lastActive < thirtyDaysAgo) {
      await deleteSessionFromDisk(session.id);
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * ★ 输入草稿持久化
 * 实时保存用户输入，防止崩溃丢失
 */

/** 草稿保存防抖定时器 */
const draftSaveTimers = new Map<string, NodeJS.Timeout>();

/**
 * 获取草稿文件路径
 * @param sessionId 会话 ID
 */
export async function getDraftFilePath(sessionId: string): Promise<string> {
  const dataPath = await getUserDataPathAsync();
  return joinPath(dataPath, 'drafts', `${sessionId}.draft`);
}

/**
 * 保存输入草稿（防抖 500ms）
 * @param sessionId 会话 ID
 * @param draft 草稿内容
 */
export async function saveInputDraft(sessionId: string, draft: string): Promise<void> {
  // 取消之前的定时器
  const existingTimer = draftSaveTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // 创建新定时器，500ms 后保存
  const timer = setTimeout(async () => {
    draftSaveTimers.delete(sessionId);
    try {
      const dataPath = await getUserDataPathAsync();
      const draftsDir = joinPath(dataPath, 'drafts');
      await ensureDir(draftsDir);
      const filePath = await getDraftFilePath(sessionId);
      await window.api.fs.writeFile(filePath, draft);
      console.log(`[DraftStorage] Saved draft for session: ${sessionId}`);
    } catch (err) {
      console.error('[DraftStorage] Failed to save draft:', err);
    }
  }, 500);

  draftSaveTimers.set(sessionId, timer);
}

/**
 * 加载输入草稿
 * @param sessionId 会话 ID
 * @returns 草稿内容，不存在则返回空字符串
 */
export async function loadInputDraft(sessionId: string): Promise<string> {
  try {
    const filePath = await getDraftFilePath(sessionId);
    const result = await window.api.fs.readFile(filePath);
    if (result.success && result.content) {
      console.log(`[DraftStorage] Loaded draft for session: ${sessionId}`);
      return result.content;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 删除输入草稿
 * @param sessionId 会话 ID
 */
export async function deleteInputDraft(sessionId: string): Promise<void> {
  try {
    const filePath = await getDraftFilePath(sessionId);
    await window.api.fs.delete(filePath);
    console.log(`[DraftStorage] Deleted draft for session: ${sessionId}`);
  } catch {
    // 文件不存在，忽略
  }
}
