/**
 * IPC Event Channels and Utilities
 * Following SpectrAI's multi-channel event architecture
 * @module main/ipc-events
 */

import { BrowserWindow } from 'electron'
import {
  IPC_CHANNELS,
  type IpcChannel,
  type ConversationMessagePayload,
  type ActivityPayload,
  type StateChangePayload,
  type ErrorPayload,
  type SessionEventPayload,
  type ConversationMessage,
  type ActivityState,
  type SessionState,
  type ErrorInfo,
} from '@shared/index'

// Re-export for convenience
export { IPC_CHANNELS }

// ============ Event Emission Functions ============

/**
 * Emit a conversation message event
 */
export function emitConversationMessage(
  webContents: Electron.WebContents,
  sessionId: string,
  message: ConversationMessage
): void {
  const payload: ConversationMessagePayload = { sessionId, message }
  webContents.send(IPC_CHANNELS.CONVERSATION_MESSAGE, payload)
}

/**
 * Emit an activity event
 */
export function emitActivity(
  webContents: Electron.WebContents,
  sessionId: string,
  activity: ActivityState
): void {
  const payload: ActivityPayload = { sessionId, activity }
  webContents.send(IPC_CHANNELS.ACTIVITY, payload)
}

/**
 * Emit a state change event
 */
export function emitStateChange(
  webContents: Electron.WebContents,
  sessionId: string,
  newState: SessionState,
  previousState?: SessionState
): void {
  const payload: StateChangePayload = {
    sessionId,
    previousState: previousState ?? 'disconnected',
    newState,
  }
  webContents.send(IPC_CHANNELS.STATE_CHANGE, payload)
}

/**
 * Emit an error event
 */
export function emitError(
  webContents: Electron.WebContents,
  sessionId: string,
  error: ErrorInfo
): void {
  const payload: ErrorPayload = { sessionId, error }
  webContents.send(IPC_CHANNELS.ERROR, payload)
}

/**
 * Emit a session event
 */
export function emitSessionEvent(
  webContents: Electron.WebContents,
  sessionId: string,
  event: SessionEventPayload['event'],
  data?: Record<string, unknown>
): void {
  const payload: SessionEventPayload = { sessionId, event, data }
  webContents.send(IPC_CHANNELS.SESSION_EVENT, payload)
}

// ============ Legacy Compatibility Functions ============

/**
 * Legacy progress event type for backward compatibility
 */
export interface LegacyProgressEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'complete' | 'init'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  isError?: boolean
  initData?: {
    model?: string
    tools?: string[]
    mcpServers?: string[]
  }
}

/**
 * Emit a legacy progress event for backward compatibility
 * This allows gradual migration from the old single-channel system
 */
export function emitLegacyProgress(
  webContents: Electron.WebContents,
  event: LegacyProgressEvent
): void {
  webContents.send(IPC_CHANNELS.LEGACY_PROGRESS, event)
}

// ============ Helper Functions ============

/**
 * Get the main browser window
 */
export function getMainWindow(): Electron.BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows()
  return windows.length > 0 ? windows[0] : null
}

/**
 * Emit to main window (convenience function)
 */
export function emitToMainWindow(
  channel: IpcChannel,
  payload: unknown
): void {
  const mainWindow = getMainWindow()
  if (mainWindow) {
    mainWindow.webContents.send(channel, payload)
  }
}

/**
 * Create a session-bound emitter
 * Returns functions that are pre-bound to a specific session ID
 */
export function createSessionEmitter(
  webContents: Electron.WebContents,
  sessionId: string
) {
  return {
    emitMessage: (message: ConversationMessage) =>
      emitConversationMessage(webContents, sessionId, message),

    emitActivity: (activity: ActivityState) =>
      emitActivity(webContents, sessionId, activity),

    emitStateChange: (newState: SessionState, previousState?: SessionState) =>
      emitStateChange(webContents, sessionId, newState, previousState),

    emitError: (error: ErrorInfo) =>
      emitError(webContents, sessionId, error),

    emitSessionEvent: (
      event: SessionEventPayload['event'],
      data?: Record<string, unknown>
    ) => emitSessionEvent(webContents, sessionId, event, data),

    emitLegacyProgress: (event: LegacyProgressEvent) =>
      emitLegacyProgress(webContents, event),
  }
}

// Re-export types
export type {
  IpcChannel,
  ConversationMessagePayload,
  ActivityPayload,
  StateChangePayload,
  ErrorPayload,
  SessionEventPayload,
}
