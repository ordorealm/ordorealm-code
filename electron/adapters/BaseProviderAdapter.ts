/**
 * Provider Adapter Base Class
 * Following SpectrAI's adapter pattern for multi-agent support
 * SDK V2 architecture — unified event flow interface
 * @module adapters/BaseProviderAdapter
 */

import { EventEmitter } from 'events'
import type {
  AgentAdapter,
  AdapterSessionConfig,
  SessionState,
  ConversationMessage,
  ProviderEvent,
} from '@shared/index'

/**
 * Base Provider Adapter
 *
 * Each AI CLI tool corresponds to an Adapter implementation, responsible for:
 * 1. Managing CLI process/SDK client lifecycle
 * 2. Converting Provider-specific message formats to unified ProviderEvent
 * 3. Maintaining conversation message history
 *
 * Events:
 * - 'event'(ProviderEvent) — unified event flow
 * - 'status-change'(sessionId, SessionState) — session state change
 */
export abstract class BaseProviderAdapter extends EventEmitter implements AgentAdapter {
  /** Provider unique identifier (e.g., 'claude-code', 'codex', 'opencode') */
  abstract readonly providerId: string

  /** Friendly display name (e.g., 'Claude Code', 'Codex CLI') */
  abstract readonly displayName: string

  // ── Public Interface ───────────────────────────────────────────────────────

  /**
   * Start a new session
   * Must be implemented by subclass
   */
  abstract startSession(sessionId: string, config: AdapterSessionConfig): Promise<void>

  /**
   * Send a user message (triggers a new turn)
   * Must be implemented by subclass
   */
  abstract sendMessage(sessionId: string, message: string): Promise<void>

  /**
   * Respond to permission confirmation request
   * Must be implemented by subclass
   */
  abstract sendConfirmation(sessionId: string, accept: boolean): Promise<void>

  /**
   * Abort current turn (soft interrupt)
   * Must be implemented by subclass
   */
  abstract abortCurrentTurn(sessionId: string): Promise<void>

  /**
   * Terminate session
   * Must be implemented by subclass
   */
  abstract terminateSession(sessionId: string): Promise<void>

  /**
   * Resume a previous session
   * Must be implemented by subclass
   */
  abstract resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void>

  /**
   * Get conversation history for a session
   * Must be implemented by subclass
   */
  abstract getConversation(sessionId: string): ConversationMessage[]

  /**
   * Check if session exists and is active
   * Must be implemented by subclass
   */
  abstract hasSession(sessionId: string): boolean

  /**
   * Get provider-side session ID (for resume)
   * Must be implemented by subclass
   */
  abstract getProviderSessionId(sessionId: string): string | undefined

  /**
   * Cleanup all resources (called on app exit)
   * Must be implemented by subclass
   */
  abstract cleanup(): void

  // ── Event Emission Helpers ─────────────────────────────────────────────────

  /**
   * Subscribe to provider events
   * @param callback - Event callback function
   * @returns Unsubscribe function
   */
  onEvent(callback: (event: ProviderEvent) => void): () => void {
    this.on('event', callback)
    return () => this.off('event', callback)
  }

  /**
   * Emit a provider event
   */
  protected emitProviderEvent(event: ProviderEvent): void {
    this.emit('event', event)
  }

  /**
   * Emit text delta event
   */
  protected emitTextDelta(sessionId: string, text: string): void {
    this.emitProviderEvent({
      type: 'text_delta',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { text },
    })
  }

  /**
   * Emit thinking event
   */
  protected emitThinking(sessionId: string, text: string): void {
    this.emitProviderEvent({
      type: 'thinking',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { text },
    })
  }

  /**
   * Emit tool use start event
   */
  protected emitToolUseStart(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    toolInput?: Record<string, unknown>
  ): void {
    this.emitProviderEvent({
      type: 'tool_use_start',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { toolUseId, toolName, toolInput },
    })
  }

  /**
   * Emit tool use end event
   */
  protected emitToolUseEnd(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    toolResult?: string,
    isError: boolean = false
  ): void {
    this.emitProviderEvent({
      type: 'tool_use_end',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { toolUseId, toolName, toolResult, isError },
    })
  }

  /**
   * Emit permission request event
   */
  protected emitPermissionRequest(
    sessionId: string,
    toolUseId: string,
    permissionPrompt: string
  ): void {
    this.emitProviderEvent({
      type: 'permission_request',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { toolUseId, permissionPrompt },
    })
  }

  /**
   * Emit turn complete event
   */
  protected emitTurnComplete(
    sessionId: string,
    usage?: { inputTokens: number; outputTokens: number }
  ): void {
    this.emitProviderEvent({
      type: 'turn_complete',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { usage },
    })
  }

  /**
   * Emit session complete event
   */
  protected emitSessionComplete(sessionId: string, exitCode: number = 0): void {
    this.emitProviderEvent({
      type: 'session_complete',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { exitCode },
    })
  }

  /**
   * Emit error event
   */
  protected emitProviderError(sessionId: string, message: string): void {
    this.emitProviderEvent({
      type: 'error',
      sessionId,
      timestamp: new Date().toISOString(),
      data: { text: message },
    })
  }

  /**
   * Emit status change event
   */
  protected emitStatusChange(sessionId: string, status: SessionState): void {
    this.emit('status-change', sessionId, status)
  }

  /**
   * Update session status and emit event
   * Helper for derived classes to call
   */
  protected updateSessionStatus(sessionId: string, status: SessionState): void {
    this.emit('status-change', sessionId, status)
  }
}
