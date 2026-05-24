/**
 * Adapter Integration Module
 * Bridges the adapter architecture with existing IPC handlers
 * This allows gradual migration from direct SDK calls to adapter-based calls
 * Following SpectrAI architecture pattern
 * @module main/adapter-integration
 */

import { BrowserWindow } from 'electron'
import { AdapterRegistry, registerDefaultAdapters, configureAdaptersWithRuntime } from '../adapters'
import type { RuntimeManager } from './runtime-manager'
import type {
  AdapterSessionConfig,
  ProviderEvent,
  ConversationMessage,
  ActivityState,
  SessionState,
  ErrorInfo,
  AdapterType,
} from '@shared/index'
import {
  isUserMessage,
  isAssistantMessage,
  isToolUseMessage,
  isToolResultMessage,
} from '@shared/index'

/**
 * Progress event for backward compatibility with existing IPC
 */
interface ProgressEvent {
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

// Active sessions: sessionId -> adapterType
const activeSessions = new Map<string, AdapterType>()

// Session configs (stored for potential resume)
const sessionConfigs = new Map<string, AdapterSessionConfig>()

// Event subscriptions (for cleanup)
const sessionUnsubscribes = new Map<string, () => void>()

/**
 * Initialize the adapter system
 * @param runtimeManager - Optional runtime manager for bundled tools
 */
export async function initializeAdapterSystem(runtimeManager?: RuntimeManager): Promise<void> {
  await registerDefaultAdapters()

  // Configure adapters with runtime manager if provided
  if (runtimeManager) {
    await configureAdaptersWithRuntime(runtimeManager)
  }

  console.log('[AdapterIntegration] Adapter system initialized')
}

/**
 * Start a session using the adapter
 */
export async function startSessionWithAdapter(
  sessionId: string,
  workingDirectory: string,
  apiKey: string,
  apiType: 'anthropic' | 'openai' = 'anthropic',
  baseUrl?: string,
  model?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const registry = AdapterRegistry.getInstance()

    // Determine adapter type based on API type
    // Note: In the new architecture, we select adapter by provider
    const adapterType: AdapterType = apiType === 'anthropic' ? 'claude-sdk' : 'codex-appserver'

    // Check if adapter is registered
    if (!registry.has(adapterType === 'claude-sdk' ? 'claude-code' : 'codex')) {
      return { success: false, error: `Adapter for ${apiType} not available` }
    }

    // Get adapter instance
    const adapter = registry.getByType(adapterType)

    // Build session config
    const config: AdapterSessionConfig = {
      command: '',  // Not used in new architecture
      workingDirectory,
      autoAccept: true,
      model,
      envOverrides: apiKey ? {
        ANTHROPIC_API_KEY: apiKey,
        OPENAI_API_KEY: apiKey,
      } : undefined,
    }

    // Store config for potential resume
    sessionConfigs.set(sessionId, config)

    // Set up event forwarding
    const unsubscribe = adapter.onEvent((event: ProviderEvent) => {
      handleProviderEvent(sessionId, event)
    })

    // Store unsubscribe function for cleanup
    sessionUnsubscribes.set(sessionId, unsubscribe)

    // Start session
    await adapter.startSession(sessionId, config)

    // Track active session
    activeSessions.set(sessionId, adapterType)

    console.log(`[AdapterIntegration] Session started: ${sessionId}`)
    return { success: true }
  } catch (err: any) {
    console.error('[AdapterIntegration] Failed to start session:', err)
    // Cleanup on failure
    const unsubscribe = sessionUnsubscribes.get(sessionId)
    if (unsubscribe) {
      unsubscribe()
      sessionUnsubscribes.delete(sessionId)
    }
    sessionConfigs.delete(sessionId)
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Send a message using the adapter
 */
export async function sendMessageWithAdapter(
  sessionId: string,
  message: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const adapterType = activeSessions.get(sessionId)
    if (!adapterType) {
      return { success: false, error: `Session ${sessionId} not found` }
    }

    const registry = AdapterRegistry.getInstance()
    const adapter = registry.getByType(adapterType)

    if (!adapter.hasSession(sessionId)) {
      return { success: false, error: 'Session not active' }
    }

    await adapter.sendMessage(sessionId, message)

    return { success: true }
  } catch (err: any) {
    console.error('[AdapterIntegration] Failed to send message:', err)
    return { success: false, error: err.message || String(err) }
  }
}

/**
 * Abort a session using the adapter
 */
export async function abortSessionWithAdapter(
  sessionId: string
): Promise<{ success: boolean }> {
  try {
    const adapterType = activeSessions.get(sessionId)
    if (!adapterType) {
      return { success: false }
    }

    const registry = AdapterRegistry.getInstance()
    const adapter = registry.getByType(adapterType)

    await adapter.abortCurrentTurn(sessionId)

    return { success: true }
  } catch (err) {
    console.error('[AdapterIntegration] Failed to abort session:', err)
    return { success: false }
  }
}

/**
 * Close a session using the adapter
 */
export async function closeSessionWithAdapter(
  sessionId: string
): Promise<{ success: boolean }> {
  try {
    const adapterType = activeSessions.get(sessionId)
    if (!adapterType) {
      return { success: false }
    }

    // Cleanup event subscription first
    const unsubscribe = sessionUnsubscribes.get(sessionId)
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch (err) {
        console.warn('[AdapterIntegration] Error unsubscribing from events:', err)
      }
      sessionUnsubscribes.delete(sessionId)
    }

    const registry = AdapterRegistry.getInstance()
    const adapter = registry.getByType(adapterType)

    await adapter.terminateSession(sessionId)

    // Cleanup tracking maps
    activeSessions.delete(sessionId)
    sessionConfigs.delete(sessionId)

    return { success: true }
  } catch (err) {
    console.error('[AdapterIntegration] Failed to close session:', err)
    return { success: false }
  }
}

/**
 * Handle provider events and forward to renderer
 */
function handleProviderEvent(sessionId: string, event: ProviderEvent): void {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn('[AdapterIntegration] No valid window to send event')
    return
  }

  switch (event.type) {
    case 'text_delta':
      if (event.data.text) {
        mainWindow.webContents.send('claude:progress', {
          type: 'text',
          content: event.data.text,
        } as ProgressEvent)
      }
      break

    case 'thinking':
      // Could be used for extended thinking display
      if (event.data.text) {
        console.log(`[AdapterIntegration] Thinking: ${event.data.text.slice(0, 100)}...`)
      }
      break

    case 'tool_use_start':
      if (event.data.toolUseId && event.data.toolName) {
        mainWindow.webContents.send('claude:progress', {
          type: 'tool_use',
          content: `Tool: ${event.data.toolName}`,
          toolName: event.data.toolName,
          toolInput: event.data.toolInput,
          toolUseId: event.data.toolUseId,
        } as ProgressEvent)
      }
      break

    case 'tool_use_end':
      if (event.data.toolUseId) {
        mainWindow.webContents.send('claude:progress', {
          type: 'tool_result',
          content: event.data.toolResult || '',
          toolUseId: event.data.toolUseId,
          toolName: event.data.toolName,
          isError: event.data.isError ?? false,
        } as ProgressEvent)
      }
      break

    case 'permission_request':
      // Handle permission request - could prompt user
      if (event.data.permissionPrompt) {
        console.log(`[AdapterIntegration] Permission request: ${event.data.permissionPrompt}`)
        // TODO: Implement permission dialog in renderer
      }
      break

    case 'turn_complete':
      mainWindow.webContents.send('claude:progress', {
        type: 'complete',
        content: '',
      } as ProgressEvent)
      break

    case 'session_complete':
      // Cleanup on session complete
      const unsubscribe = sessionUnsubscribes.get(sessionId)
      if (unsubscribe) {
        unsubscribe()
        sessionUnsubscribes.delete(sessionId)
      }
      activeSessions.delete(sessionId)
      console.log(`[AdapterIntegration] Session complete: ${sessionId}`)
      break

    case 'error':
      if (event.data.text) {
        mainWindow.webContents.send('claude:progress', {
          type: 'error',
          content: event.data.text,
        } as ProgressEvent)
      }
      break
  }
}

/**
 * Check if adapter mode is enabled
 */
export function isAdapterModeEnabled(): boolean {
  // For now, return false to use existing implementation
  // Set to true to enable adapter-based implementation
  return process.env.DEVFLOW_ADAPTER_MODE === 'true'
}

/**
 * Get available adapters
 */
export function getAvailableAdapters(): string[] {
  const registry = AdapterRegistry.getInstance()
  return registry.getRegisteredIds()
}
