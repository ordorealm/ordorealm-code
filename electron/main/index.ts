import { app, BrowserWindow, shell, ipcMain, dialog, clipboard } from 'electron'
import { join } from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as pathModule from 'path'
import { execSync } from 'child_process'
import chokidar, { type FSWatcher } from 'chokidar'
import { AsyncIterableQueue } from '../shared/async-queue'
import { SecureStorage } from './secure-storage'
import * as git from './git'
import { RuntimeManager } from './runtime-manager'
import { registerSkillLibraryHandlers } from './skill-library-handlers'

// Check if running in development mode
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged

// Runtime manager instance (initialized on app ready)
let runtimeManager: RuntimeManager | null = null

/**
 * 检测 Agent CLI 安装状态
 * 支持 Claude Code, Codex, OpenCode 等
 * 使用 RuntimeManager 提供的环境（内置 Node.js PATH）
 */
function checkAgentInstalled(agentType: string): { installed: boolean; version: string | null } {
  const commands: Record<string, string> = {
    'claude-code': 'claude --version',
    'codex': 'codex --version',
    'opencode': 'opencode --version',
  }

  const cmd = commands[agentType]
  if (!cmd) {
    return { installed: false, version: null }
  }

  try {
    // 使用 RuntimeManager 提供的环境变量（包含内置 Node.js PATH）
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (runtimeManager) {
      try {
        const runtimeEnv = runtimeManager.getEnvConfig()
        env.PATH = runtimeEnv.pathEnv
      } catch {
        // RuntimeManager not initialized, use system defaults
      }
    }

    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    }).trim()

    // 解析版本号
    const versionMatch = result.match(/(\d+\.\d+\.\d+)/)
    const version = versionMatch ? versionMatch[1] : result.split('\n')[0]

    console.log(`[AgentDetector] ${agentType} installed, version: ${version}`)
    return { installed: true, version }
  } catch (error) {
    // 命令不存在或执行失败
    console.log(`[AgentDetector] ${agentType} not installed`)
    return { installed: false, version: null }
  }
}

// 文件系统操作结果类型
interface FsResult<T = void> {
  success: boolean
  error?: string
  content?: T
}

// 目录条目类型
interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: DirEntry[]
}

// Claude Code 执行结果类型
interface ClaudeCodeResult {
  success: boolean
  output?: string
  error?: string
  toolCalls?: ToolCallResult[]
  duration?: number
}

// 工具调用结果类型
interface ToolCallResult {
  name: string
  input: Record<string, unknown>
  output?: string
  status: 'success' | 'error'
  duration: number
}

// Claude Code 执行选项
interface ClaudeExecuteOptions {
  prompt: string
  workingDirectory: string
  apiKey: string
  baseUrl?: string
  model?: string
  timeout?: number
  apiType?: 'anthropic' | 'openai'
}

// 进度事件类型
interface ProgressEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'complete' | 'init' | 'status'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  /** Tool use ID for matching tool_result to tool_use */
  toolUseId?: string
  /** Whether the tool result is an error */
  isError?: boolean
  /** Init data from SDK */
  initData?: {
    model?: string
    tools?: string[]
    mcpServers?: string[]
  }
  /** Status data for api_retry etc. */
  statusData?: {
    status: string
    reason?: string
  }
  /** Token usage data from SDK result */
  usageData?: {
    inputTokens: number
    outputTokens: number
    contextWindow: number
  }
}

// SDK 类型定义
type SDKQuery = {
  close(): void
  interrupt(): Promise<void>
  [Symbol.asyncIterator](): AsyncIterator<any>
}

// SDK 模块缓存
let sdkModule: any = null

// ─────────────────────────────────────────────────────────────────────────────
// 会话管理（参考 SpectrAI 的 AgentManagerV2 模式）
// ─────────────────────────────────────────────────────────────────────────────

interface ClaudeSession {
  id: string
  workingDirectory: string
  inputStream: AsyncIterableQueue<any>
  sdkQuery: SDKQuery | null
  abortController: AbortController
  status: string  // 'idle' | 'running' | 'error' - 使用 string 避免 TS 控制流窄化
  output: string
  lastActivity: number
  /** 保存原始环境变量，用于会话关闭时恢复 */
  originalEnv?: Record<string, string | undefined>
}

// 活跃会话映射
const activeSessions = new Map<string, ClaudeSession>()

// 会话创建锁（防止并发创建同一会话）
const sessionCreationLocks = new Map<string, Promise<ClaudeSession>>()

/**
 * 写入调试日志到文件
 */
function debugLog(message: string): void {
  console.log(message)
  try {
    const logPath = join(app.getPath('userData'), 'debug.log')
    const timestamp = new Date().toISOString()
    fsSync.appendFileSync(logPath, `[${timestamp}] ${message}\n`, 'utf-8')
  } catch {}
}

/**
 * 解析 Claude Code 原生二进制路径
 * 在打包模式下，SDK 内部的 require.resolve 可能无法正确找到 ASAR unpacked 中的原生二进制
 * 因此需要手动构建路径并传给 SDK
 */
function resolveClaudeBinaryPath(): string | null {
  try {
    const platform = process.platform
    const arch = process.arch

    // 平台-架构映射
    const platformArchMap: Record<string, string> = {
      darwin_x64: 'darwin-x64',
      darwin_arm64: 'darwin-arm64',
      win32_x64: 'win32-x64',
      win32_arm64: 'win32-arm64',
      linux_x64: 'linux-x64',
      linux_arm64: 'linux-arm64',
    }

    const platformSuffix = platformArchMap[`${platform}_${arch}`]
    if (!platformSuffix) {
      debugLog(`[Claude SDK] Unsupported platform: ${platform}-${arch}`)
      return null
    }

    const binaryPackage = `@anthropic-ai/claude-agent-sdk-${platformSuffix}`
    const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'

    // 尝试通过 require.resolve 解析（开发模式通常能成功）
    if (isDev) {
      try {
        const binaryPath = require.resolve(`${binaryPackage}/${binaryName}`)
        debugLog(`[Claude SDK] Dev mode - resolved binary: ${binaryPath}`)
        return binaryPath
      } catch (err) {
        debugLog('[Claude SDK] Dev mode - require.resolve failed: ' + err)
      }
    }

    // 打包模式：直接使用 process.resourcesPath 构建 unpacked 路径
    // 这比 app.getAppPath() 更可靠
    const resourcesPath = process.resourcesPath
    const unpackedPath = join(resourcesPath, 'app.asar.unpacked')
    const binaryPath = join(unpackedPath, 'node_modules', binaryPackage, binaryName)

    debugLog('[Claude SDK] Packaged mode:')
    debugLog('  resourcesPath: ' + resourcesPath)
    debugLog('  unpackedPath: ' + unpackedPath)
    debugLog('  binaryPath: ' + binaryPath)

    if (fsSync.existsSync(binaryPath)) {
      debugLog(`[Claude SDK] Found binary at: ${binaryPath}`)
      return binaryPath
    }

    // 备选方案：尝试使用 app.getAppPath()
    const appPath = app.getAppPath()
    const altUnpackedPath = appPath.replace(/app\.asar$/, 'app.asar.unpacked')
    const altBinaryPath = join(altUnpackedPath, 'node_modules', binaryPackage, binaryName)

    debugLog('[Claude SDK] Fallback:')
    debugLog('  appPath: ' + appPath)
    debugLog('  altBinaryPath: ' + altBinaryPath)

    if (fsSync.existsSync(altBinaryPath)) {
      debugLog(`[Claude SDK] Found binary at fallback: ${altBinaryPath}`)
      return altBinaryPath
    }

    debugLog(`[Claude SDK] Binary not found at any location`)
    return null
  } catch (err) {
    debugLog('[Claude SDK] Failed to resolve binary path: ' + err)
    return null
  }
}

/**
 * 延迟加载 SDK 模块
 */
async function loadSdk(): Promise<any> {
  if (!sdkModule) {
    try {
      sdkModule = await import('@anthropic-ai/claude-agent-sdk')
      console.log('[Claude SDK] Loaded successfully')
    } catch (err) {
      console.error('[Claude SDK] Failed to load:', err)
      throw new Error(
        `Failed to load @anthropic-ai/claude-agent-sdk. ` +
        `Please install: npm install @anthropic-ai/claude-agent-sdk\n` +
        `Original error: ${err}`
      )
    }
  }
  return sdkModule
}

/**
 * 创建或获取会话
 * 参考 SpectrAI 的 startSession 模式
 *
 * 使用锁机制防止并发创建同一会话
 */
async function getOrCreateSession(
  sessionId: string,
  workingDirectory: string,
  apiKey: string,
  apiType: 'anthropic' | 'openai',
  baseUrl?: string,
  model?: string,
  envOverrides?: Record<string, string>
): Promise<ClaudeSession> {
  // 检查是否已有活跃会话
  const existing = activeSessions.get(sessionId)
  if (existing && existing.status !== 'error') {
    return existing
  }

  // 检查是否有正在创建中的会话（并发锁）
  const pendingCreation = sessionCreationLocks.get(sessionId)
  if (pendingCreation) {
    console.log(`[Claude SDK] Waiting for pending session creation: ${sessionId}`)
    return pendingCreation
  }

  // 创建新的会话 Promise 并注册锁
  const creationPromise = (async (): Promise<ClaudeSession> => {
    try {
      console.log(`[Claude SDK] Creating new session: ${sessionId}`)

      const sdk = await loadSdk()

      // ── 构建环境变量 ──
      // SDK 会继承 process.env，然后应用 settings 层的 env 配置
      // 我们使用 flag settings 层来覆盖 user settings 层的 env 值

      // 保存原始值以便会话关闭时恢复
      const originalEnv: Record<string, string | undefined> = {
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      }

      // ── 调试日志 ──
      console.log('[Claude SDK] ===== DEBUG API CONFIG =====')
      console.log('[Claude SDK] apiType:', apiType)
      console.log('[Claude SDK] apiKey (first 20 chars):', apiKey?.substring(0, 20))
      console.log('[Claude SDK] apiKey length:', apiKey?.length)
      console.log('[Claude SDK] baseUrl:', baseUrl || 'default')
      console.log('[Claude SDK] model:', model || 'not set')
      console.log('[Claude SDK] ===== END DEBUG =====')

      const abortController = new AbortController()
      const inputStream = new AsyncIterableQueue<any>()

      // 读取全局 MCP 配置（从 ~/.claude.json）
      let globalMcpServers: Record<string, any> = {}
      try {
        const claudeJsonPath = join(app.getPath('home'), '.claude.json')
        const claudeJsonContent = await fs.readFile(claudeJsonPath, 'utf-8')
        const claudeJson = JSON.parse(claudeJsonContent)
        globalMcpServers = claudeJson.mcpServers || {}
        console.log('[Claude SDK] Loaded global MCP servers:', Object.keys(globalMcpServers))
      } catch (err) {
        console.log('[Claude SDK] No global MCP config found')
      }

      // 继承所有系统环境变量
      const cleanEnv: NodeJS.ProcessEnv = { ...process.env }

      // 清除 Claude Code 嵌套检测环境变量
      delete cleanEnv.CLAUDECODE
      delete cleanEnv.CLAUDE_CODE_ENTRYPOINT

      // 使用内置运行时环境（如果可用）
      if (runtimeManager) {
        try {
          const runtimeEnv = runtimeManager.getEnvConfig()
          // 覆盖 PATH 以使用内置 Node.js 和 Git
          cleanEnv.PATH = runtimeEnv.pathEnv
          // 设置 Shell
          cleanEnv.SHELL = runtimeEnv.shell
          console.log('[Claude SDK] Using bundled runtime:')
          console.log('[Claude SDK]   Node.js:', runtimeEnv.nodePath)
          console.log('[Claude SDK]   Git:', runtimeEnv.gitPath)
          console.log('[Claude SDK]   Shell:', runtimeEnv.shell)
        } catch (err) {
          console.warn('[Claude SDK] Failed to get runtime config, using system defaults')
        }
      }

      // SDK options（参考 SpectrAI 的 buildQueryOptions）
      const sdkOptions: Record<string, any> = {
        cwd: workingDirectory,
        env: cleanEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController,
        settingSources: ['user', 'project', 'local'],  // 加载 user 级 Skills/MCP
        // 启用所有发现的技能
        skills: 'all',
        // 直接配置 MCP 服务器（从全局配置读取）
        mcpServers: globalMcpServers,
      }

      // ★ 在打包模式下显式指定原生二进制路径
      // SDK 内部的 require.resolve 可能在 ASAR 环境下无法正确解析
      const binaryPath = resolveClaudeBinaryPath()
      if (binaryPath) {
        sdkOptions.pathToClaudeCodeExecutable = binaryPath
        console.log('[Claude SDK] Using explicit binary path:', binaryPath)
      }

      // Windows: 设置 Git Bash 路径
      if (process.platform === 'win32' && runtimeManager) {
        try {
          const runtimeEnv = runtimeManager.getEnvConfig()
          if (runtimeEnv.bashPath) {
            sdkOptions.gitBashPath = runtimeEnv.bashPath
            console.log('[Claude SDK] Git Bash path:', runtimeEnv.bashPath)
          }
        } catch {}
      }

      // ★ 使用 flag settings 层覆盖 ~/.claude/settings.json 的 env 配置
      // flag settings 层的优先级高于 user settings 层，可以覆盖 settings.json 中的 env 值
      // 这样既保留了 Skills/MCP 加载（需要 settingSources 包含 'user'），又能使用我们的 API 配置
      if (apiType === 'anthropic') {
        const flagEnv: Record<string, string> = {}
        if (apiKey) {
          flagEnv.ANTHROPIC_API_KEY = apiKey
          flagEnv.ANTHROPIC_AUTH_TOKEN = apiKey
        }
        if (baseUrl) {
          flagEnv.ANTHROPIC_BASE_URL = baseUrl
        }
        if (model) {
          flagEnv.ANTHROPIC_MODEL = model
          // 同时设置默认模型环境变量，确保所有模型选择都使用我们的配置
          flagEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
          flagEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model
          flagEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model
        }
        sdkOptions.settings = {
          env: flagEnv
        }
        console.log('[Claude SDK] Flag settings env (will override user settings):', Object.keys(flagEnv))
      }

      console.log('[Claude SDK] SDK options mcpServers:', JSON.stringify(sdkOptions.mcpServers, null, 2))

      // ★ 设置模型（通过 SDK 的 model 选项）
      if (model) {
        sdkOptions.model = model
        console.log('[Claude SDK] Model set in SDK options:', model)
      } else {
        console.log('[Claude SDK] No model specified, SDK will use default')
      }

      console.log('[Claude SDK] Final sdkOptions.model:', sdkOptions.model || 'not set')

      // 创建 SDK query
      const sdkQuery: SDKQuery = sdk.query({
        prompt: inputStream,
        options: sdkOptions,
      })

      const session: ClaudeSession = {
        id: sessionId,
        workingDirectory,
        inputStream,
        sdkQuery,
        abortController,
        status: 'idle',
        output: '',
        lastActivity: Date.now(),
        originalEnv,  // 保存原始环境变量
      }

      activeSessions.set(sessionId, session)

      // 启动流消费循环（在后台运行，不阻塞）
      consumeSessionStream(session)

      return session
    } finally {
      // 无论如何都移除锁
      sessionCreationLocks.delete(sessionId)
    }
  })()

  // 注册锁
  sessionCreationLocks.set(sessionId, creationPromise)

  return creationPromise
}

/**
 * 消费会话流（参考 SpectrAI 的 consumeStream）
 * 持续运行，处理所有 SDK 消息
 */
async function consumeSessionStream(session: ClaudeSession): Promise<void> {
  if (!session.sdkQuery) return

  console.log(`[Claude SDK] Starting stream consumer for session: ${session.id}`)

  try {
    for await (const msg of session.sdkQuery) {
      console.log(`[Claude SDK] Message type: ${msg.type}, subtype: ${msg.subtype}`)

      // 获取主窗口发送进度事件
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) continue

      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            console.log('[Claude SDK] Initialized:', msg.model)
            session.status = 'running'
            // 发送 init 数据给渲染进程（包含 tools 和 mcpServers）
            const tools = msg.tools || []
            const mcpServers = msg.mcp_servers || msg.mcpServers || []
            const slashCommands = msg.slash_commands || msg.slashCommands || []
            const skills = msg.skills || []
            const plugins = msg.plugins || []
            const agents = msg.agents || []
            const cwd = msg.cwd || ''

            console.log('[Claude SDK] Tools count:', tools.length)
            console.log('[Claude SDK] MCP Servers:', JSON.stringify(mcpServers, null, 2))
            console.log('[Claude SDK] Slash Commands:', JSON.stringify(slashCommands, null, 2))
            console.log('[Claude SDK] Skills:', JSON.stringify(skills, null, 2))
            console.log('[Claude SDK] Plugins:', JSON.stringify(plugins, null, 2))
            console.log('[Claude SDK] Agents:', JSON.stringify(agents, null, 2))
            console.log('[Claude SDK] CWD:', cwd)

            // 读取项目技能目录，获取项目技能名称列表
            let projectSkillNames: string[] = []
            if (cwd) {
              try {
                const projectSkillsDir = join(cwd, '.claude', 'skills')
                const entries = await fs.readdir(projectSkillsDir, { withFileTypes: true })
                projectSkillNames = entries
                  .filter(e => e.isDirectory())
                  .map(e => e.name)
                  .filter(name => !name.startsWith('.'))
                console.log('[Claude SDK] Project skills:', projectSkillNames)
              } catch (err) {
                // 项目目录下没有 .claude/skills/ 目录，正常情况
                console.log('[Claude SDK] No project skills directory')
              }
            }

            // Write to log file for debugging
            const logData = {
              timestamp: new Date().toISOString(),
              toolsCount: tools.length,
              tools: tools,
              mcpServers: mcpServers,
              slashCommands: slashCommands,
              skills: skills,
              plugins: plugins,
              agents: agents,
              cwd: cwd,
              projectSkillNames: projectSkillNames,
            }
            fs.writeFile(join(app.getPath('userData'), 'sdk-tools-debug.json'), JSON.stringify(logData, null, 2)).catch(() => {})

            mainWindow.webContents.send('claude:progress', {
              type: 'init',
              content: `Model: ${msg.model || 'unknown'}`,
              initData: {
                model: msg.model,
                tools: Array.isArray(tools) ? tools.map(String) : [],
                mcpServers: Array.isArray(mcpServers) ? mcpServers : [],
                slashCommands: Array.isArray(slashCommands) ? slashCommands.map(String) : [],
                skills: Array.isArray(skills) ? skills.map(String) : [],
                plugins: Array.isArray(plugins) ? plugins : [],
                agents: Array.isArray(agents) ? agents.map(String) : [],
                cwd: cwd,
                projectSkillNames: projectSkillNames,
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'api_retry') {
            // 通知前端 API 正在重试
            console.log('[Claude SDK] API retry:', msg.reason || 'unknown')
            console.log('[Claude SDK] Full api_retry message:', JSON.stringify(msg, null, 2))
            mainWindow.webContents.send('claude:progress', {
              type: 'status',
              content: 'API 请求重试中...',
              statusData: {
                status: 'retrying',
                reason: msg.reason || 'unknown',
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'status') {
            // 通知前端状态变化
            console.log('[Claude SDK] Status:', msg.status || 'unknown')
            mainWindow.webContents.send('claude:progress', {
              type: 'status',
              content: msg.message || `Status: ${msg.status || 'unknown'}`,
              statusData: {
                status: msg.status || 'unknown',
              },
            } as ProgressEvent)
          }
          break

        case 'stream_event':
          const evt = msg.event
          if (evt?.type === 'content_block_delta') {
            const delta = evt.delta
            if (delta?.type === 'text_delta' && delta.text) {
              session.output += delta.text
              session.lastActivity = Date.now()
              mainWindow.webContents.send('claude:progress', {
                type: 'text',
                content: delta.text,
              } as ProgressEvent)
            }
            // Handle input_json_delta for tool_use streaming
            if (delta?.type === 'input_json_delta' && evt.index !== undefined) {
              // Tool input is being streamed, we'll capture it in content_block_stop
              // For now, just log it
              console.log('[Claude SDK] Tool input delta:', evt.index, delta.partial_json)
            }
          } else if (evt?.type === 'content_block_start') {
            // Handle tool_use start in streaming mode
            const contentBlock = evt.content_block
            if (contentBlock?.type === 'tool_use') {
              console.log('[Claude SDK] Tool use started:', contentBlock.name, contentBlock.id)
              mainWindow.webContents.send('claude:progress', {
                type: 'tool_use',
                content: `Tool: ${contentBlock.name}`,
                toolName: contentBlock.name,
                toolInput: contentBlock.input || {},
                toolUseId: contentBlock.id,
              } as ProgressEvent)
            }
          }
          break

        case 'assistant':
          const content = msg.message?.content || []
          for (const block of content) {
            if (block.type === 'text') {
              const text = block.text || ''
              if (!session.output.includes(text)) {
                session.output += text
                mainWindow.webContents.send('claude:progress', {
                  type: 'text',
                  content: text,
                } as ProgressEvent)
              }
            } else if (block.type === 'tool_use') {
              mainWindow.webContents.send('claude:progress', {
                type: 'tool_use',
                content: `Tool: ${block.name}`,
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id,  // ✅ 添加 toolUseId 用于匹配 tool_result
              } as ProgressEvent)
            }
          }
          break

        case 'user':
          const userContent = msg.message?.content || []
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              mainWindow.webContents.send('claude:progress', {
                type: 'tool_result',
                toolUseId: block.tool_use_id,
                content: String(block.content || '').slice(0, 500),
                isError: block.is_error,
              } as ProgressEvent)
            }
          }
          break

        case 'result':
          const isSuccess = msg.subtype === 'success'
          console.log('[Claude SDK] Result:', isSuccess ? 'success' : 'failed')
          console.log('[Claude SDK] Result message keys:', Object.keys(msg))
          console.log('[Claude SDK] Result usage:', JSON.stringify(msg.usage, null, 2))
          console.log('[Claude SDK] Result totalTokens:', msg.totalTokens)
          session.status = isSuccess ? 'idle' : 'error'

          // ★ 提取 token 使用量数据
          // SDK 可能返回 usage 或 totalTokens 字段
          const usageData = msg.usage ? {
            inputTokens: msg.usage.input_tokens || 0,
            outputTokens: msg.usage.output_tokens || 0,
            contextWindow: 200000, // 默认 200K，后续可从 model info 获取
          } : msg.totalTokens ? {
            inputTokens: msg.totalTokens,
            outputTokens: 0,
            contextWindow: 200000,
          } : undefined

          console.log('[Claude SDK] Extracted usageData:', usageData)

          if (isSuccess) {
            mainWindow.webContents.send('claude:progress', {
              type: 'complete',
              content: session.output,
              usageData,
            } as ProgressEvent)
          } else {
            const errorMsg = msg.result || 'Unknown error'
            mainWindow.webContents.send('claude:progress', {
              type: 'error',
              content: errorMsg,
            } as ProgressEvent)
          }
          break
      }
    }

    console.log(`[Claude SDK] Stream ended naturally for session: ${session.id}`)

  } catch (err: any) {
    console.error(`[Claude SDK] Stream error for session ${session.id}:`, err)
    session.status = 'error'

    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (mainWindow) {
      const isAbort = err.name === 'AbortError' || /\baborted\b/i.test(err.message || '')
      mainWindow.webContents.send('claude:progress', {
        type: 'error',
        content: isAbort ? '会话已中断' : (err.message || String(err)),
      } as ProgressEvent)
    }
  }
}

/**
 * 递归读取目录
 */
async function readDirRecursive(dirPath: string, depth: number): Promise<DirEntry[]> {
  if (depth < 0) return []

  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const result: DirEntry[] = []

  for (const entry of entries) {
    const item: DirEntry = {
      name: entry.name,
      path: pathModule.join(dirPath, entry.name),
      type: entry.isDirectory() ? 'directory' : 'file'
    }

    if (entry.isDirectory() && depth > 0) {
      item.children = await readDirRecursive(item.path, depth - 1)
    }

    result.push(item)
  }

  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * 注册文件系统 IPC handlers
 */
function registerFsHandlers(): void {
  ipcMain.handle('fs:getUserDataPath', async (): Promise<string> => {
    return app.getPath('userData')
  })

  ipcMain.handle('fs:readFile', async (_, filePath: string): Promise<FsResult<string>> => {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return { success: true, content }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string): Promise<FsResult> => {
    try {
      const dir = pathModule.dirname(filePath)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(filePath, content, 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:exists', async (_, filePath: string): Promise<boolean> => {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('fs:mkdir', async (_, dirPath: string): Promise<FsResult> => {
    try {
      await fs.mkdir(dirPath, { recursive: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:delete', async (_, filePath: string): Promise<FsResult> => {
    try {
      await fs.rm(filePath, { recursive: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:rename', async (_, oldPath: string, newPath: string): Promise<FsResult> => {
    try {
      await fs.rename(oldPath, newPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:readDir', async (_, dirPath: string, depth: number = 1): Promise<FsResult<DirEntry[]>> => {
    try {
      const result = await readDirRecursive(dirPath, depth)
      return { success: true, content: result }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('fs:stat', async (_, filePath: string): Promise<FsResult<{ size: number; isFile: boolean; isDirectory: boolean }>> => {
    try {
      const stats = await fs.stat(filePath)
      return {
        success: true,
        content: {
          size: stats.size,
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
        },
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

/**
 * 注册对话框 IPC handlers
 */
function registerDialogHandlers(): void {
  ipcMain.handle('dialog:openDirectory', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择项目目录',
    })
    return result.filePaths[0] || null
  })

  ipcMain.handle('dialog:openFile', async (_, options: { filters?: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths: string[] }> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: options.filters,
    })
    return { canceled: result.canceled, filePaths: result.filePaths }
  })
}

/**
 * 注册剪贴板 IPC handlers
 */
function registerClipboardHandlers(): void {
  ipcMain.handle('clipboard:writeText', async (_, text: string): Promise<void> => {
    clipboard.writeText(text)
  })
}

/**
 * 注册 Shell IPC handlers
 */
function registerShellHandlers(): void {
  ipcMain.handle('shell:openPath', async (_, path: string): Promise<void> => {
    shell.openPath(path)
  })
}

/**
 * 注册加密 IPC handlers
 * 提供 API Key 等敏感数据的加密/解密功能
 */
function registerCryptoHandlers(): void {
  const secureStorage = SecureStorage.getInstance()

  // 检查加密是否可用
  ipcMain.handle('crypto:isAvailable', async (): Promise<{ available: boolean }> => {
    return { available: secureStorage.isEncryptionAvailable() }
  })

  // 加密数据
  ipcMain.handle('crypto:encrypt', async (_, plainText: string): Promise<{ success: boolean; encrypted?: string; error?: string }> => {
    try {
      const encrypted = secureStorage.encrypt(plainText)
      return { success: true, encrypted }
    } catch (error) {
      console.error('[Crypto] Encryption failed:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 解密数据
  ipcMain.handle('crypto:decrypt', async (_, encrypted: string): Promise<{ success: boolean; decrypted?: string; error?: string }> => {
    try {
      console.log('[Crypto] Decrypt called, encrypted (first 30 chars):', encrypted?.substring(0, 30))
      console.log('[Crypto] Encrypted length:', encrypted?.length)
      const decrypted = secureStorage.decrypt(encrypted)
      console.log('[Crypto] Decrypted (first 20 chars):', decrypted?.substring(0, 20))
      console.log('[Crypto] Decrypted length:', decrypted?.length)
      return { success: true, decrypted }
    } catch (error) {
      console.error('[Crypto] Decryption failed:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 检查字符串是否已加密
  ipcMain.handle('crypto:isEncrypted', async (_, text: string): Promise<{ isEncrypted: boolean }> => {
    return { isEncrypted: secureStorage.isEncrypted(text) }
  })

  console.log('[Crypto] Crypto handlers registered')
}

/**
 * 注册 Claude Code IPC handlers（使用会话管理 + SDK V1 API）
 * 参考 SpectrAI 的 AgentManagerV2 + ClaudeSdkAdapter 模式
 */
function registerClaudeHandlers(): void {
  // 检查 SDK 是否可用
  ipcMain.handle('claude:checkAvailable', async (): Promise<{ available: boolean }> => {
    try {
      await loadSdk()
      return { available: true }
    } catch {
      return { available: false }
    }
  })

  // 获取 SDK 版本
  ipcMain.handle('claude:getVersion', async (): Promise<{ version: string | null }> => {
    try {
      const pkgPath = require.resolve('@anthropic-ai/claude-agent-sdk/package.json')
      const pkg = require(pkgPath)
      return { version: pkg.version || null }
    } catch {
      return { version: null }
    }
  })

  // 检测 Agent CLI 安装状态（通用检测）
  ipcMain.handle('agent:checkInstalled', async (_event, agentType: string): Promise<{ installed: boolean; version: string | null }> => {
    return checkAgentInstalled(agentType)
  })

  // ★ 启动会话（参考 SpectrAI 的 startSession）
  ipcMain.handle(
    'claude:startSession',
    async (_event, options: Omit<ClaudeExecuteOptions, 'prompt'> & { sessionId: string; envOverrides?: Record<string, string> }): Promise<{ success: boolean; error?: string }> => {
      const { sessionId, workingDirectory, apiKey, baseUrl, model, apiType = 'anthropic', envOverrides } = options

      console.log('[Claude SDK] ===== claude:startSession called =====')
      console.log('[Claude SDK] Session ID:', sessionId)
      console.log('[Claude SDK] Received apiKey (first 20 chars):', apiKey?.substring(0, 20))
      console.log('[Claude SDK] Received apiKey length:', apiKey?.length)
      console.log('[Claude SDK] Received model:', model)
      console.log('[Claude SDK] Received baseUrl:', baseUrl)

      try {
        await getOrCreateSession(sessionId, workingDirectory, apiKey, apiType, baseUrl, model, envOverrides)
        console.log('[Claude SDK] Session started:', sessionId)
        return { success: true }
      } catch (err: any) {
        console.error('[Claude SDK] Failed to start session:', err)
        return { success: false, error: err.message || String(err) }
      }
    }
  )

  // ★ 发送消息（参考 SpectrAI 的 sendMessage）
  // 消息通过 inputStream.enqueue() 推入，流消费循环在后台处理
  ipcMain.handle(
    'claude:sendMessage',
    async (_event, sessionId: string, prompt: string): Promise<{ success: boolean; error?: string }> => {
      console.log('[Claude SDK] ===== claude:sendMessage called =====')
      console.log('[Claude SDK] Session:', sessionId, 'Prompt:', prompt.substring(0, 50))

      const session = activeSessions.get(sessionId)
      if (!session) {
        console.error('[Claude SDK] Session not found:', sessionId)
        return { success: false, error: `Session ${sessionId} not found. Please start session first.` }
      }

      if (session.status === 'error') {
        console.warn('[Claude SDK] Session in error state, attempting to recreate...')
        // 尝试清理并重建会话 - 这里暂不实现，返回错误
        return { success: false, error: 'Session is in error state' }
      }

      // 重置输出（每轮对话重新开始）
      session.output = ''
      session.status = 'running'
      session.lastActivity = Date.now()

      // ★ 通过 inputStream 向 SDK 推送用户消息
      session.inputStream.enqueue({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      })

      console.log('[Claude SDK] Message enqueued for session:', sessionId)
      return { success: true }
    }
  )

  // ★ 中止当前轮次（参考 SpectrAI 的 abortCurrentTurn）
  ipcMain.handle(
    'claude:abort',
    async (_event, sessionId: string): Promise<{ success: boolean }> => {
      const session = activeSessions.get(sessionId)
      if (!session) return { success: false }

      console.log('[Claude SDK] Aborting session:', sessionId)
      session.abortController.abort()

      // 重建 AbortController 和 inputStream
      session.abortController = new AbortController()
      session.status = 'idle'

      return { success: true }
    }
  )

  // ★ 关闭会话
  ipcMain.handle(
    'claude:closeSession',
    async (_event, sessionId: string): Promise<{ success: boolean }> => {
      const session = activeSessions.get(sessionId)
      if (!session) return { success: false }

      console.log('[Claude SDK] Closing session:', sessionId)

      // 恢复原始环境变量
      if (session.originalEnv) {
        for (const [key, value] of Object.entries(session.originalEnv)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
        console.log('[Claude SDK] Restored original environment variables')
      }

      session.inputStream.close()
      session.abortController.abort()

      if (session.sdkQuery) {
        try {
          session.sdkQuery.close()
        } catch (err) {
          console.warn('[Claude SDK] Error closing query:', err)
        }
      }

      activeSessions.delete(sessionId)
      return { success: true }
    }
  )

  // ★ 兼容旧接口：claude:execute（一次性执行，内部创建临时会话）
  ipcMain.handle(
    'claude:execute',
    async (event, options: ClaudeExecuteOptions): Promise<ClaudeCodeResult> => {
      console.log('[Claude SDK] ===== claude:execute called (legacy) =====')

      const startTime = Date.now()
      const { prompt, workingDirectory, apiKey, baseUrl, model, timeout = 300000, apiType = 'anthropic' } = options

      try {
        // 创建临时会话
        const tempSessionId = `temp-${Date.now()}`
        const session = await getOrCreateSession(tempSessionId, workingDirectory, apiKey, apiType, baseUrl, model)

        // 设置超时
        const timeoutId = setTimeout(() => {
          console.log('[Claude SDK] Timeout reached, aborting...')
          session.abortController.abort()
          session.inputStream.close()
        }, timeout)

        // 发送用户消息
        session.output = ''
        session.status = 'running'
        session.inputStream.enqueue({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: prompt }],
          },
        })

        // 等待完成或超时
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            const currentSession = activeSessions.get(tempSessionId)
            if (currentSession && (currentSession.status === 'idle' || currentSession.status === 'error')) {
              clearInterval(checkInterval)
              clearTimeout(timeoutId)
              resolve()
            }
          }, 100)

          timeoutId.refresh() // 重置超时计时器
        })

        clearTimeout(timeoutId)

        const finalStatus = session.status
        // 清理临时会话
        activeSessions.delete(tempSessionId)

        if (finalStatus === 'idle') {
          return { success: true, output: session.output, duration: Date.now() - startTime }
        } else {
          return { success: false, error: 'Execution failed', output: session.output, duration: Date.now() - startTime }
        }

      } catch (err: any) {
        console.error('[Claude SDK] Error:', err)
        return {
          success: false,
          error: err.message || String(err),
          duration: Date.now() - startTime,
        }
      }
    }
  )
}

// 文件监听器管理
const fileWatchers = new Map<string, FSWatcher>()

interface FileChangeEvent {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'
  path: string
}

function registerFileWatcherHandlers(): void {
  ipcMain.handle('watcher:start', async (event, dirPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      if (fileWatchers.has(dirPath)) {
        const existingWatcher = fileWatchers.get(dirPath)
        await existingWatcher?.close()
        fileWatchers.delete(dirPath)
      }

      const watcher = chokidar.watch(dirPath, {
        ignored: [
          /(^|[\/\\])\../,  // Hidden directories (cross-platform)
          /node_modules/,
          /\.git/,
          /dist/,
          /out/,
          /\.DS_Store$/,     // macOS
          /Thumbs\.db$/,     // Windows
          /desktop\.ini$/,   // Windows
          /\.lnk$/,          // Windows shortcuts
        ],
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      })

      watcher
        .on('add', (path) => event.sender.send('watcher:change', { type: 'add', path } as FileChangeEvent))
        .on('change', (path) => event.sender.send('watcher:change', { type: 'change', path } as FileChangeEvent))
        .on('unlink', (path) => event.sender.send('watcher:change', { type: 'unlink', path } as FileChangeEvent))
        .on('addDir', (path) => event.sender.send('watcher:change', { type: 'addDir', path } as FileChangeEvent))
        .on('unlinkDir', (path) => event.sender.send('watcher:change', { type: 'unlinkDir', path } as FileChangeEvent))
        .on('error', (error) => console.error('[FileWatcher] Error:', error))

      fileWatchers.set(dirPath, watcher)
      console.log(`[FileWatcher] Started watching: ${dirPath}`)
      return { success: true }
    } catch (error) {
      console.error('[FileWatcher] Failed to start:', error)
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('watcher:stop', async (_, dirPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const watcher = fileWatchers.get(dirPath)
      if (watcher) {
        await watcher.close()
        fileWatchers.delete(dirPath)
        console.log(`[FileWatcher] Stopped watching: ${dirPath}`)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('watcher:stopAll', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      for (const [, watcher] of fileWatchers) await watcher.close()
      fileWatchers.clear()
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

/**
 * Register Git IPC handlers
 */
function registerGitHandlers(): void {
  // Check if directory is a git repository
  ipcMain.handle('git:isRepo', async (_, repoPath: string): Promise<boolean> => {
    return git.isGitRepo(repoPath)
  })

  // List all branches
  ipcMain.handle('git:listBranches', async (_, repoPath: string) => {
    return git.listBranches(repoPath)
  })

  // Get current branch
  ipcMain.handle('git:getCurrentBranch', async (_, repoPath: string): Promise<string> => {
    return git.getCurrentBranch(repoPath)
  })

  // Get main branch
  ipcMain.handle('git:getMainBranch', async (_, repoPath: string): Promise<string> => {
    return git.getMainBranch(repoPath)
  })

  // Checkout branch
  ipcMain.handle('git:checkout', async (_, repoPath: string, branch: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await git.checkout(repoPath, branch)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Force checkout branch (discard local changes)
  ipcMain.handle('git:checkoutForce', async (_, repoPath: string, branch: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await git.checkoutForce(repoPath, branch)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Commit all changes and checkout branch
  ipcMain.handle('git:commitAndCheckout', async (_, repoPath: string, branch: string, message?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await git.commitAndCheckout(repoPath, branch, message)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // Get branch diff files
  ipcMain.handle('git:getBranchDiffFiles', async (_, repoPath: string, targetBranch: string, currentBranch: string) => {
    return git.getBranchDiffFiles(repoPath, targetBranch, currentBranch)
  })

  // Get worktree diff files
  ipcMain.handle('git:getWorktreeDiffFiles', async (_, repoPath: string) => {
    return git.getWorktreeDiffFiles(repoPath)
  })

  // Get branch file diff
  ipcMain.handle('git:getBranchFileDiff', async (_, repoPath: string, targetBranch: string, currentBranch: string, filePath: string) => {
    return git.getBranchFileDiff(repoPath, targetBranch, currentBranch, filePath)
  })

  // Get worktree file diff
  ipcMain.handle('git:getWorktreeFileDiff', async (_, repoPath: string, filePath: string, staged: boolean) => {
    return git.getWorktreeFileDiff(repoPath, filePath, staged)
  })

  // Get status summary
  ipcMain.handle('git:getStatusSummary', async (_, repoPath: string) => {
    return git.getStatusSummary(repoPath)
  })

  console.log('[Git] Git handlers registered')
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 18 }
    } : {}),
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../resources/icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (isDev) mainWindow.webContents.openDevTools()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  // Initialize runtime manager (bundled Node.js, Git, etc.)
  console.log('[Main] Initializing runtime manager...')
  runtimeManager = new RuntimeManager()
  try {
    const { isFirstLaunch, envConfig } = await runtimeManager.initialize()
    if (isFirstLaunch) {
      console.log('[Main] Runtime extracted on first launch')
    }

    // Configure Git module to use bundled runtime
    git.setGitConfig({
      gitPath: envConfig.gitPath,
      bashPath: envConfig.bashPath,
      env: {
        PATH: envConfig.pathEnv,
        SHELL: envConfig.shell,
      },
    })
    console.log('[Main] Git configured with bundled runtime')
  } catch (err) {
    console.error('[Main] Failed to initialize runtime manager:', err)
    // Continue without bundled runtime - fall back to system tools
    // Git will use system git from PATH
  }

  ipcMain.on('ping', () => console.log('pong'))
  registerFsHandlers()
  registerDialogHandlers()
  registerClipboardHandlers()
  registerShellHandlers()
  registerCryptoHandlers()
  registerClaudeHandlers()
  registerFileWatcherHandlers()
  registerGitHandlers()
  registerSkillLibraryHandlers()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
