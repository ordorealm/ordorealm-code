/**
 * WeChat Relay HTTP Server
 *
 * Implements the OpenAI-compatible chat completions API that WeClaw's
 * HTTP agent calls. This allows the WeClaw daemon to route incoming
 * WeChat messages through our app's master-agent instead of its own
 * built-in Claude CLI.
 *
 * Protocol (WeClaw HTTP agent):
 *   POST /v1/chat/completions
 *   Body: { "model": "...", "messages": [{ "role": "user", "content": "..." }] }
 *   Response: { "choices": [{ "message": { "content": "reply" } }] }
 *
 * @module main/services/wx-relay-server
 */

import * as http from 'http'
import { execSync } from 'child_process'
import { Logger } from '../utils/logger'

// ─── Constants ───────────────────────────────────────────────────────────────

const RELAY_PORT = 19800
const RELAY_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 25_000  // 短于 WeClaw 客户端~30s 超时，确保我们能主动返回

// ─── Types ───────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: string
  content: string
}

interface ChatCompletionRequest {
  model?: string
  messages: ChatMessage[]
}

interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string
    }
    finish_reason: 'stop'
  }>
}

/**
 * Callback invoked when a message is received from WeChat via the daemon.
 * Returns the reply text the daemon should send back to WeChat.
 */
export type WxMessageHandler = (message: string, conversationId: string) => Promise<string>

// ─── Relay Server ────────────────────────────────────────────────────────────

export class WxRelayServer {
  private server: http.Server | null = null
  private logger: Logger
  private handler: WxMessageHandler | null = null
  private lastError: string | null = null

  constructor() {
    this.logger = new Logger('WxRelayServer')
  }

  /**
   * Set the message handler callback.
   */
  setHandler(handler: WxMessageHandler): void {
    this.handler = handler
  }

  /**
   * Start the HTTP relay server.
   */
  async start(): Promise<void> {
    if (this.server) {
      this.logger.warn('Server already running')
      return
    }

    this.lastError = null

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      // Startup error: listen() failure (e.g. EADDRINUSE)
      const onStartupError = (err: NodeJS.ErrnoException): void => {
        this.lastError = err.code === 'EADDRINUSE'
          ? `端口 ${RELAY_PORT} 被占用`
          : err.message
        this.server = null
        reject(err)
      }

      this.server.once('error', onStartupError)

      this.server.listen(RELAY_PORT, RELAY_HOST, () => {
        // Startup succeeded — swap to persistent runtime error handler
        this.server!.removeListener('error', onStartupError)
        this.server!.on('error', (err: NodeJS.ErrnoException) => {
          this.logger.error('Server runtime error:', err)
          this.lastError = err.message
          this.server = null
        })
        this.logger.info(`Relay server listening on http://${RELAY_HOST}:${RELAY_PORT}`)
        resolve()
      })
    })
  }

  /**
   * Start with automatic port conflict resolution and retries.
   */
  async startWithRetry(maxRetries: number = 3): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.start()
        return
      } catch (err) {
        const error = err as NodeJS.ErrnoException
        if (error.code === 'EADDRINUSE' && attempt < maxRetries) {
          this.logger.warn(
            `Port ${RELAY_PORT} in use (attempt ${attempt + 1}/${maxRetries + 1}), trying cleanup...`
          )
          await this.killPortOccupant()
          await new Promise((r) => setTimeout(r, 500))
        } else if (error.code === 'EADDRINUSE') {
          // Out of retries for EADDRINUSE
          throw err
        } else {
          // Non-EADDRINUSE error — not recoverable by retry, throw immediately
          throw err
        }
      }
    }
  }

  /**
   * Stop the HTTP relay server.
   */
  async stop(): Promise<void> {
    if (!this.server) return

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.logger.info('Relay server stopped')
        this.server = null
        resolve()
      })
    })
  }

  /**
   * Check if the server is running.
   */
  isRunning(): boolean {
    return this.server !== null
  }

  /**
   * Get the reason for the last startup failure, if any.
   */
  getLastError(): string | null {
    return this.lastError
  }

  /**
   * Try to kill the process(es) occupying the relay port.
   * Used during automatic port conflict recovery.
   */
  private async killPortOccupant(): Promise<void> {
    try {
      const output = execSync(`lsof -ti :${RELAY_PORT}`, {
        encoding: 'utf-8',
        timeout: 3000,
      })
      const pids = output.trim().split('\n').filter(Boolean)
      for (const pid of pids) {
        this.logger.warn(`Killing process on port ${RELAY_PORT}: PID ${pid}`)
        execSync(`kill -9 ${pid}`, { timeout: 3000 })
      }
    } catch {
      // lsof fails when no process is found — that's fine
      this.logger.debug('No occupying process found or lsof unavailable')
    }
  }

  // ─── Request Handling ───────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Only handle POST /v1/chat/completions
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    if (!this.handler) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No message handler configured' }))
      return
    }

    // Read body
    let body = ''
    try {
      body = await this.readBody(req)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Failed to read request body' }))
      return
    }

    // Parse request
    let request: ChatCompletionRequest
    try {
      request = JSON.parse(body)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Invalid JSON' }))
      return
    }

    if (!request.messages || !Array.isArray(request.messages)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Missing messages array' }))
      return
    }

    // Extract the user's message (last message with role "user")
    const userMessages = request.messages.filter((m) => m.role === 'user')
    if (userMessages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'No user message found' }))
      return
    }

    const lastUserMessage = userMessages[userMessages.length - 1].content.trim()
    if (!lastUserMessage) {
      // Empty message — return empty ok
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.buildResponse('')))
      return
    }

    // Use the WeChat user ID from the first user message as conversationId
    // (WeClaw daemon passes the ilink_user_id as part of conversation tracking)
    const conversationId = 'wechat-user'

    this.logger.info(
      `[WX-RELAY] received from daemon: "${lastUserMessage.substring(0, 100)}"`
    )

    // Set timeout
    const timeoutId = setTimeout(() => {
      res.writeHead(504, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request timeout' }))
    }, REQUEST_TIMEOUT_MS)

    try {
      const reply = await this.handler(lastUserMessage, conversationId)
      clearTimeout(timeoutId)

      this.logger.info(
        `[WX-RELAY] reply (${reply.length} chars): "${reply.substring(0, 100)}"`
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(this.buildResponse(reply)))
    } catch (err) {
      clearTimeout(timeoutId)
      const errorMsg = (err as Error).message
      this.logger.error(`[WX-RELAY] handler error: ${errorMsg}`)

      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `处理消息时出错: ${errorMsg}` },
          finish_reason: 'stop',
        }],
      }))
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      req.on('error', reject)
    })
  }

  private buildResponse(content: string): ChatCompletionResponse {
    return {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'devflow-master-agent',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
    }
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let instance: WxRelayServer | null = null

export function getWxRelayServer(): WxRelayServer {
  if (!instance) {
    instance = new WxRelayServer()
  }
  return instance
}
