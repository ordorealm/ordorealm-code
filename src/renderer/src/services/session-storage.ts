/**
 * Session Storage Service
 * Handles persistence of session data to local filesystem
 * @module services/session-storage
 */

import { ensureDir, readJsonFile, writeJsonFile, getUserDataPathAsync } from '@/utils/fs';
import { joinPath } from '@/utils/path';
import type { Session } from '@/types';

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
 * @param session Session to save
 */
export async function saveSessionToDisk(session: Session): Promise<boolean> {
  try {
    await ensureSessionsDir();

    const filePath = await getSessionFilePath(session.id);
    const data: SessionFile = {
      version: SESSION_FILE_VERSION,
      session,
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
