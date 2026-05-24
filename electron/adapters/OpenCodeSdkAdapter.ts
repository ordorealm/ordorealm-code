/**
 * OpenCode SDK Adapter
 *
 * Interacts with OpenCode HTTP server via @opencode-ai/sdk.
 * Lifecycle:
 *   1. spawn `opencode serve --port <port>` process
 *   2. Create SDK client connecting to that port
 *   3. Create OpenCode session via client.session.create()
 *   4. Subscribe to SSE event stream (client.event.subscribe())
 *   5. Send user messages via client.session.prompt()
 *
 * Following SpectrAI's OpenCodeSdkAdapter implementation
 * @module adapters/OpenCodeSdkAdapter
 */

import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import type {
  ConversationMessage,
  AdapterSessionConfig,
  ProviderEvent,
} from '@shared/index'
import { BaseProviderAdapter } from './BaseProviderAdapter'

// ─── OpenCode SDK Types (runtime loaded) ─────────────────────────────────────

/**
 * OpenCode SDK client interface
 * SDK is loaded dynamically via import()
 */
interface OpenCodeClient {
  session: {
    create: (options: { project: string }) => Promise<{ id: string }>
    prompt: (sessionId: string, options: { prompt: string }) => Promise<void>
  }
  event: {
    subscribe: (
      sessionId: string,
      callback: (event: OpenCodeEvent) => void,
      options?: { signal?: AbortSignal }
    ) => Promise<void>
  }
}

interface OpenCodeEvent {
  type: string
  sessionId?: string
  message?: OpenCodeMessage
  part?: OpenCodePart
  permission?: OpenCodePermission
}

interface OpenCodeMessage {
  id: string
  role: 'user' | 'assistant'
  parts: OpenCodePart[]
}

interface OpenCodePart {
  id: string
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  isError?: boolean
  delta?: string
}

interface OpenCodePermission {
  id: string
  message: string
}

// ─── Session State ──────────────────────────────────────────────────────────

interface OpenCodeSession {
  /** SpectrAI unified session state */
  adapterSessionId: string
  /** Configuration */
  config: AdapterSessionConfig
  /** OpenCode serve process */
  serverProcess?: ChildProcess
  /** SDK client */
  client?: OpenCodeClient
  /** OpenCode internal session ID (for resume) */
  opencodeSessionId?: string
  /** Server port */
  port?: number
  /** SSE AbortController */
  sseAbortController?: AbortController
  /** Current assistant text */
  currentAssistantText: string
  /** Working directory */
  workingDirectory: string
}

// ─── Executable Detection ────────────────────────────────────────────────────

function findOpenCodeExecutable(configCommand?: string): string {
  if (configCommand && path.isAbsolute(configCommand) && fs.existsSync(configCommand)) {
    return configCommand
  }

  const fallback = configCommand?.trim() || 'opencode'

  // Windows npm global directory
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
    const npmGlobalDirs = [path.join(home, 'AppData', 'Roaming', 'npm')]

    for (const dir of npmGlobalDirs) {
      for (const name of ['opencode.cmd', 'opencode.exe', 'opencode']) {
        const candidate = path.join(dir, name)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }

  return fallback
}

// ─── Port Detection ──────────────────────────────────────────────────────────

async function findAvailablePort(startPort = 14096): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => {
        server.close(() => resolve(true))
      })
      server.listen(port, '127.0.0.1')
    })
    if (available) return port
  }
  throw new Error(`No available port found in range ${startPort}–${startPort + 99}`)
}

// ─── Adapter Implementation ─────────────────────────────────────────────────

export class OpenCodeSdkAdapter extends BaseProviderAdapter {
  readonly providerId = 'opencode'
  readonly displayName = 'OpenCode'

  private sessions: Map<string, OpenCodeSession> = new Map()
  private opencodeExecutablePath: string | null = null
  private sdkModule: any = null

  constructor() {
    super()
    this.opencodeExecutablePath = findOpenCodeExecutable()
    console.log(`[OpenCodeAdapter] Executable path: ${this.opencodeExecutablePath}`)
  }

  /**
   * Load SDK module lazily
   * The SDK is loaded dynamically and might not be installed at compile time
   */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  private async loadSdk(): Promise<any> {
    if (!this.sdkModule) {
      try {
        // Dynamic import - module may not be installed
        this.sdkModule = await import(/* webpackIgnore: true */ '@opencode-ai/sdk')
        console.log('[OpenCodeAdapter] SDK loaded successfully')
      } catch (err) {
        console.error('[OpenCodeAdapter] Failed to load SDK:', err)
        throw new Error(
          `Failed to load @opencode-ai/sdk. Please install: npm install @opencode-ai/sdk\n` +
          `Original error: ${err}`
        )
      }
    }
    return this.sdkModule
  }

  // ── Public Interface ───────────────────────────────────────────────────────

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    console.log(`[OpenCodeAdapter] Starting session: ${sessionId}`)

    // Create session context
    const session: OpenCodeSession = {
      adapterSessionId: sessionId,
      config,
      currentAssistantText: '',
      workingDirectory: config.workingDirectory,
    }
    this.sessions.set(sessionId, session)

    // Update session status
    this.updateSessionStatus(sessionId, 'connecting')

    try {
      // Find available port
      const port = await findAvailablePort()
      session.port = port
      console.log(`[OpenCodeAdapter] Using port: ${port}`)

      // Spawn OpenCode server
      const executable = config.executablePath || this.opencodeExecutablePath || 'opencode'
      const proc = spawn(executable, ['serve', '--port', String(port)], {
        cwd: config.workingDirectory,
        env: {
          ...process.env,
          ...config.envOverrides,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      session.serverProcess = proc

      // Handle stderr
      proc.stderr?.on('data', (data) => {
        console.error(`[OpenCodeAdapter] stderr: ${data}`)
      })

      // Handle exit
      proc.on('exit', (code) => {
        console.log(`[OpenCodeAdapter] Server exited with code: ${code}`)
        this.emitSessionComplete(sessionId, code ?? 0)
        this.sessions.delete(sessionId)
      })

      // Wait for server to be ready
      await this.waitForServer(port)

      // Load SDK and create client
      const sdk = await this.loadSdk()
      const client = sdk.createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` })
      session.client = client

      // Create OpenCode session
      const sessionResult = await client.session.create({
        project: config.workingDirectory,
      })
      session.opencodeSessionId = sessionResult.id
      console.log(`[OpenCodeAdapter] OpenCode session created: ${session.opencodeSessionId}`)

      // Subscribe to events
      const abortController = new AbortController()
      session.sseAbortController = abortController

      client.event.subscribe(
        session.opencodeSessionId,
        (event: OpenCodeEvent) => this.handleEvent(sessionId, event),
        { signal: abortController.signal }
      ).catch((err: Error) => {
        console.error('[OpenCodeAdapter] Event subscription error:', err)
      })

      this.updateSessionStatus(sessionId, 'connected')
      console.log(`[OpenCodeAdapter] Session ready: ${sessionId}`)
    } catch (err) {
      console.error(`[OpenCodeAdapter] Failed to start session:`, err)
      this.updateSessionStatus(sessionId, 'error')
      throw err
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.client || !session.opencodeSessionId) {
      throw new Error(`Session ${sessionId} not ready`)
    }

    console.log(`[OpenCodeAdapter] Sending message to session: ${sessionId}`)

    // Reset current text
    session.currentAssistantText = ''
    this.updateSessionStatus(sessionId, 'streaming')

    try {
      await session.client.session.prompt(session.opencodeSessionId, {
        prompt: message,
      })
      console.log(`[OpenCodeAdapter] Message sent`)
    } catch (err) {
      console.error(`[OpenCodeAdapter] Failed to send message:`, err)
      this.updateSessionStatus(sessionId, 'error')
      throw err
    }
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    // OpenCode doesn't use the same confirmation flow
    // Permission requests are handled differently
    console.log(`[OpenCodeAdapter] Confirmation requested: ${accept}`)
  }

  async abortCurrentTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[OpenCodeAdapter] Aborting turn for session: ${sessionId}`)
    // Abort SSE subscription
    session.sseAbortController?.abort()
    this.updateSessionStatus(sessionId, 'connected')
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[OpenCodeAdapter] Terminating session: ${sessionId}`)

    // Abort SSE
    session.sseAbortController?.abort()

    // Kill server process
    if (session.serverProcess) {
      session.serverProcess.kill()
    }

    this.sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    // OpenCode doesn't support resume in the same way
    // Start a new session instead
    await this.startSession(sessionId, config)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId)
    return session?.opencodeSessionId
  }

  getConversation(sessionId: string): ConversationMessage[] {
    const session = this.sessions.get(sessionId)
    return [] // Conversation managed by OpenCode
  }

  hasSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return session !== undefined && session.client !== undefined
  }

  cleanup(): void {
    console.log(`[OpenCodeAdapter] Cleaning up`)
    for (const [sessionId, session] of this.sessions) {
      session.sseAbortController?.abort()
      if (session.serverProcess) {
        session.serverProcess.kill()
      }
    }
    this.sessions.clear()
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private async waitForServer(port: number, timeout = 30000): Promise<void> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = new net.Socket()
          socket.once('connect', () => {
            socket.destroy()
            resolve()
          })
          socket.once('error', reject)
          socket.connect(port, '127.0.0.1')
        })
        console.log(`[OpenCodeAdapter] Server ready on port ${port}`)
        return
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    throw new Error(`Server not ready after ${timeout}ms`)
  }

  private handleEvent(sessionId: string, event: OpenCodeEvent): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[OpenCodeAdapter] Event: ${event.type}`)

    switch (event.type) {
      case 'message':
        if (event.message?.role === 'assistant') {
          for (const part of event.message.parts) {
            this.handlePart(sessionId, part)
          }
        }
        break

      case 'part.updated':
        if (event.part) {
          this.handlePart(sessionId, event.part)
        }
        break

      case 'session.idle':
        this.emitTurnComplete(sessionId)
        this.updateSessionStatus(sessionId, 'connected')
        break

      case 'permission':
        if (event.permission) {
          this.emitPermissionRequest(
            sessionId,
            event.permission.id,
            event.permission.message
          )
        }
        break

      default:
        // Unknown event, ignore
        break
    }
  }

  private handlePart(sessionId: string, part: OpenCodePart): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    switch (part.type) {
      case 'text':
        if (part.delta) {
          session.currentAssistantText += part.delta
          this.emitTextDelta(sessionId, part.delta)
        } else if (part.text && !session.currentAssistantText) {
          // Initial text without delta
          session.currentAssistantText = part.text
          this.emitTextDelta(sessionId, part.text)
        }
        break

      case 'tool_use':
        if (part.id && part.toolName) {
          this.emitToolUseStart(
            sessionId,
            part.id,
            part.toolName,
            part.toolInput
          )
        }
        break

      case 'tool_result':
        if (part.id) {
          this.emitToolUseEnd(
            sessionId,
            part.id,
            part.toolName || 'unknown',
            part.toolResult || '',
            part.isError ?? false
          )
        }
        break
    }
  }
}
