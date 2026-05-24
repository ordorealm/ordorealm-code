/**
 * Codex CLI App Server Adapter
 *
 * Interacts with Codex CLI via JSON-RPC over stdio protocol.
 * Protocol flow: initialize → initialized → thread/start → turn/start → events → turn/end
 *
 * Following SpectrAI's CodexAppServerAdapter implementation
 * @module adapters/CodexAppServerAdapter
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type {
  ConversationMessage,
  AdapterSessionConfig,
  ProviderEvent,
} from '@shared/index'
import { BaseProviderAdapter } from './BaseProviderAdapter'

// ─── JSON-RPC Types ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

// ─── Session State ──────────────────────────────────────────────────────────

interface CodexSession {
  /** SpectrAI unified session state */
  adapterSessionId: string
  /** Codex thread ID */
  threadId?: string
  /** Codex process */
  process?: ChildProcess
  /** Stdin writer */
  stdin?: WritableStream
  /** Response pending map */
  pendingResponses: Map<string, { resolve: (result: unknown) => void; reject: (err: Error) => void }>
  /** Current turn ID */
  currentTurnId?: string
  /** Configuration */
  config: AdapterSessionConfig
  /** Accumulated text for current turn */
  currentText: string
}

// ─── Executable Detection ────────────────────────────────────────────────────

function isExecutable(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function preferredCodexBinDirs(): string[] {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  if (process.platform === 'win32') return [`windows-${arch}`]
  if (process.platform === 'darwin') return [`darwin-${arch}`]
  if (process.platform === 'linux') return [`linux-${arch}`, `linux-${process.arch}`]
  return []
}

function scanCodexBinaryInBinDir(binDir: string): string | null {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex'] : ['codex', 'codex.exe']
  for (const subDir of preferredCodexBinDirs()) {
    for (const name of names) {
      const candidate = path.join(binDir, subDir, name)
      if (isExecutable(candidate)) return candidate
    }
  }

  // Fallback: recursive search in bin directory
  const queue = [binDir]
  while (queue.length > 0) {
    const current = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      if (names.includes(entry.name) && isExecutable(full)) {
        return full
      }
    }
  }
  return null
}

/**
 * Find Codex executable
 * Priority: Cursor/Trae extension dir > npm global
 */
function findCodexExecutable(configCommand?: string): string {
  if (configCommand && path.isAbsolute(configCommand) && isExecutable(configCommand)) {
    return configCommand
  }

  const fallback = configCommand?.trim() || 'codex'
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
  const searchBases = [
    path.join(home, '.trae', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ]

  for (const base of searchBases) {
    try {
      if (!fs.existsSync(base)) continue
      const entries = fs.readdirSync(base, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!entry.name.startsWith('openai.chatgpt-')) continue
        const binDir = path.join(base, entry.name, 'bin')
        if (!fs.existsSync(binDir)) continue
        const resolved = scanCodexBinaryInBinDir(binDir)
        if (resolved) return resolved
      }
    } catch {
      // ignore and continue
    }
  }

  // Windows npm global directory
  if (process.platform === 'win32') {
    const npmGlobalDirs: string[] = [
      path.join(home, 'AppData', 'Roaming', 'npm'),
    ]

    for (const dir of npmGlobalDirs) {
      for (const name of ['codex.cmd', 'codex.exe', 'codex']) {
        const candidate = path.join(dir, name)
        if (isExecutable(candidate)) return candidate
      }
    }
  }

  return fallback
}

// ─── Adapter Implementation ─────────────────────────────────────────────────

export class CodexAppServerAdapter extends BaseProviderAdapter {
  readonly providerId = 'codex'
  readonly displayName = 'Codex CLI'

  private sessions: Map<string, CodexSession> = new Map()
  private codexExecutablePath: string | null = null

  constructor() {
    super()
    this.codexExecutablePath = findCodexExecutable()
    console.log(`[CodexAdapter] Executable path: ${this.codexExecutablePath}`)
  }

  // ── Public Interface ───────────────────────────────────────────────────────

  async startSession(sessionId: string, config: AdapterSessionConfig): Promise<void> {
    console.log(`[CodexAdapter] Starting session: ${sessionId}`)

    // Create session context
    const session: CodexSession = {
      adapterSessionId: sessionId,
      pendingResponses: new Map(),
      config,
      currentText: '',
    }
    this.sessions.set(sessionId, session)

    // Spawn Codex process
    const executable = config.executablePath || this.codexExecutablePath || 'codex'
    const args = ['app-server', '--jsonrpc']

    console.log(`[CodexAdapter] Spawning: ${executable} ${args.join(' ')}`)

    const proc = spawn(executable, args, {
      cwd: config.workingDirectory,
      env: {
        ...process.env,
        ...config.envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    session.process = proc

    // Handle stdout (JSON-RPC responses)
    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      this.handleLine(sessionId, line)
    })

    // Handle stderr
    proc.stderr?.on('data', (data) => {
      console.error(`[CodexAdapter] stderr: ${data}`)
    })

    // Handle process exit
    proc.on('exit', (code) => {
      console.log(`[CodexAdapter] Process exited with code: ${code}`)
      this.emitSessionComplete(sessionId, code ?? 0)
      this.sessions.delete(sessionId)
    })

    // Send initialize request
    try {
      await this.sendRequest(sessionId, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'DevFlow', version: '1.0.0' },
      })
      console.log(`[CodexAdapter] Initialized`)

      // Send initialized notification
      this.sendNotification(sessionId, 'notifications/initialized', {})

      this.updateSessionStatus(sessionId, 'connected')
    } catch (err) {
      console.error(`[CodexAdapter] Initialize failed:`, err)
      this.updateSessionStatus(sessionId, 'error')
      throw err
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.threadId) {
      throw new Error(`Session ${sessionId} not ready`)
    }

    console.log(`[CodexAdapter] Sending message to session: ${sessionId}`)

    // Reset current text
    session.currentText = ''
    this.updateSessionStatus(sessionId, 'streaming')

    // Start a new turn
    try {
      const result = await this.sendRequest(sessionId, 'thread/turn/start', {
        threadId: session.threadId,
        prompt: message,
      }) as { turnId: string }
      session.currentTurnId = result.turnId
      console.log(`[CodexAdapter] Turn started: ${result.turnId}`)
    } catch (err) {
      console.error(`[CodexAdapter] Failed to start turn:`, err)
      this.updateSessionStatus(sessionId, 'error')
      throw err
    }
  }

  async sendConfirmation(sessionId: string, accept: boolean): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.currentTurnId) {
      throw new Error(`No pending confirmation for session ${sessionId}`)
    }

    console.log(`[CodexAdapter] Sending confirmation: ${accept}`)

    try {
      await this.sendRequest(sessionId, 'thread/turn/response', {
        turnId: session.currentTurnId,
        response: accept ? 'approve' : 'reject',
      })
    } catch (err) {
      console.error(`[CodexAdapter] Failed to send confirmation:`, err)
      throw err
    }
  }

  async abortCurrentTurn(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[CodexAdapter] Aborting turn for session: ${sessionId}`)

    if (session.currentTurnId) {
      try {
        await this.sendRequest(sessionId, 'thread/turn/cancel', {
          turnId: session.currentTurnId,
        })
      } catch (err) {
        console.error(`[CodexAdapter] Failed to cancel turn:`, err)
      }
    }

    this.updateSessionStatus(sessionId, 'connected')
  }

  async terminateSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[CodexAdapter] Terminating session: ${sessionId}`)

    if (session.process) {
      session.process.kill()
    }

    this.sessions.delete(sessionId)
  }

  async resumeSession(
    sessionId: string,
    providerSessionId: string,
    config: AdapterSessionConfig
  ): Promise<void> {
    // Codex doesn't support resume in the same way
    // Start a new session instead
    await this.startSession(sessionId, config)
  }

  getProviderSessionId(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId)
    return session?.threadId
  }

  getConversation(sessionId: string): ConversationMessage[] {
    const session = this.sessions.get(sessionId)
    return [] // Conversation managed by Codex CLI
  }

  hasSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    return session !== undefined && session.process !== undefined
  }

  cleanup(): void {
    console.log(`[CodexAdapter] Cleaning up`)
    for (const [sessionId, session] of this.sessions) {
      if (session.process) {
        session.process.kill()
      }
    }
    this.sessions.clear()
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private sendRequest<T = unknown>(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.process?.stdin) {
      return Promise.reject(new Error(`Session ${sessionId} not found`))
    }

    // TypeScript narrow: session.process is defined at this point
    const stdin = session.process.stdin
    const id = uuidv4()
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      session.pendingResponses.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      })

      const line = JSON.stringify(request) + '\n'
      stdin.write(line)
      console.log(`[CodexAdapter] → ${method}`)
    })
  }

  private sendNotification(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session || !session.process?.stdin) return

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    }

    const line = JSON.stringify(notification) + '\n'
    session.process.stdin.write(line)
    console.log(`[CodexAdapter] → notification: ${method}`)
  }

  private handleLine(sessionId: string, line: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    let msg: JsonRpcResponse | JsonRpcNotification
    try {
      msg = JSON.parse(line)
    } catch {
      console.warn(`[CodexAdapter] Invalid JSON: ${line}`)
      return
    }

    // Handle response
    if ('id' in msg && msg.id) {
      const pending = session.pendingResponses.get(msg.id)
      if (pending) {
        session.pendingResponses.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(msg.error.message))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // Handle notification
    if ('method' in msg) {
      this.handleNotification(sessionId, msg.method, msg.params)
    }
  }

  private handleNotification(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    console.log(`[CodexAdapter] ← ${method}`)

    switch (method) {
      case 'thread/created':
        if (params?.threadId) {
          session.threadId = params.threadId as string
          console.log(`[CodexAdapter] Thread created: ${session.threadId}`)
        }
        break

      case 'thread/turn/started':
        if (params?.turnId) {
          session.currentTurnId = params.turnId as string
        }
        break

      case 'thread/turn/text':
        if (params?.text) {
          const text = params.text as string
          session.currentText += text
          this.emitTextDelta(sessionId, text)
        }
        break

      case 'thread/turn/tool_call':
        if (params?.toolCallId && params?.toolName) {
          this.emitToolUseStart(
            sessionId,
            params.toolCallId as string,
            params.toolName as string,
            params.toolInput as Record<string, unknown>
          )
        }
        break

      case 'thread/turn/tool_result':
        if (params?.toolCallId && params?.toolName) {
          this.emitToolUseEnd(
            sessionId,
            params.toolCallId as string,
            params.toolName as string,
            params.toolResult as string,
            (params.isError as boolean) ?? false
          )
        }
        break

      case 'thread/turn/permission':
        if (params?.toolCallId && params?.prompt) {
          this.emitPermissionRequest(
            sessionId,
            params.toolCallId as string,
            params.prompt as string
          )
        }
        break

      case 'thread/turn/completed':
        this.emitTurnComplete(sessionId)
        this.updateSessionStatus(sessionId, 'connected')
        session.currentTurnId = undefined
        break

      default:
        // Unknown notification, ignore
        break
    }
  }
}
