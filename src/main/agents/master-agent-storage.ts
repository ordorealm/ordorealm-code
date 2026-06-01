/**
 * Master Agent Session Storage
 *
 * Handles persistence of master agent conversation history.
 * Stores messages and provider session ID for context recovery.
 *
 * @module main/agents/master-agent-storage
 */

import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MasterAgentMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

export interface MasterAgentHistory {
  version: string
  messages: MasterAgentMessage[]
  providerSessionId?: string
  lastActiveAt: string
  createdAt: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_VERSION = '1.0.0'
const MAX_MESSAGES = 100 // 保留最近 100 条消息

// ─── Storage Path ────────────────────────────────────────────────────────────

let storageDir: string | null = null
let historyFilePath: string | null = null

function getStorageDir(): string {
  if (!storageDir) {
    storageDir = path.join(app.getPath('userData'), 'master-agent')
  }
  return storageDir
}

function getHistoryFilePath(): string {
  if (!historyFilePath) {
    historyFilePath = path.join(getStorageDir(), 'history.json')
  }
  return historyFilePath
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Ensure storage directory exists
 */
export async function ensureStorageDir(): Promise<void> {
  const dir = getStorageDir()
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true })
  }
}

/**
 * Load master agent history from disk
 */
export async function loadMasterAgentHistory(): Promise<MasterAgentHistory | null> {
  try {
    const filePath = getHistoryFilePath()
    if (!fs.existsSync(filePath)) {
      return null
    }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    const data = JSON.parse(content) as MasterAgentHistory

    // Version check
    if (data.version !== STORAGE_VERSION) {
      console.warn(`[MasterAgentStorage] Version mismatch: ${data.version}, expected: ${STORAGE_VERSION}`)
    }

    console.log(`[MasterAgentStorage] Loaded ${data.messages?.length || 0} messages from disk`)
    return data
  } catch (err) {
    console.error('[MasterAgentStorage] Failed to load history:', err)
    return null
  }
}

/**
 * Save master agent history to disk
 */
export async function saveMasterAgentHistory(history: MasterAgentHistory): Promise<boolean> {
  try {
    await ensureStorageDir()

    // Trim messages to max limit
    const trimmedMessages = history.messages.slice(-MAX_MESSAGES)

    const data: MasterAgentHistory = {
      ...history,
      messages: trimmedMessages,
      lastActiveAt: new Date().toISOString(),
    }

    const filePath = getHistoryFilePath()
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')

    console.log(`[MasterAgentStorage] Saved ${trimmedMessages.length} messages to disk`)
    return true
  } catch (err) {
    console.error('[MasterAgentStorage] Failed to save history:', err)
    return false
  }
}

/**
 * Append a message to history
 */
export async function appendMasterAgentMessage(
  role: 'user' | 'assistant',
  content: string,
  existingHistory?: MasterAgentHistory
): Promise<MasterAgentHistory> {
  let history: MasterAgentHistory

  if (existingHistory) {
    history = existingHistory
  } else {
    const loaded = await loadMasterAgentHistory()
    if (loaded) {
      history = loaded
    } else {
      history = {
        version: STORAGE_VERSION,
        messages: [],
        lastActiveAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      }
    }
  }

  history.messages.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  })

  return history
}

/**
 * Update provider session ID (for SDK resume)
 * @param sessionId - The provider session ID
 * @param existingHistory - Optional existing history to update (avoids disk reload)
 */
export async function updateProviderSessionId(
  sessionId: string,
  existingHistory?: MasterAgentHistory
): Promise<void> {
  try {
    let history: MasterAgentHistory | null = existingHistory || null

    if (!history) {
      history = await loadMasterAgentHistory()
    }

    if (history) {
      history.providerSessionId = sessionId
      await saveMasterAgentHistory(history)
      console.log(`[MasterAgentStorage] Updated provider session ID: ${sessionId}`)
    }
  } catch (err) {
    console.error('[MasterAgentStorage] Failed to update provider session ID:', err)
  }
}

/**
 * Clear master agent history
 */
export async function clearMasterAgentHistory(): Promise<boolean> {
  try {
    const filePath = getHistoryFilePath()
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath)
    }
    console.log('[MasterAgentStorage] History cleared')
    return true
  } catch (err) {
    console.error('[MasterAgentStorage] Failed to clear history:', err)
    return false
  }
}
