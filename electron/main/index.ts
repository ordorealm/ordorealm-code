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
import { initializeMCPIPC } from './mcp-ipc'
import { getMCPConnector } from './mcp/connector'
import { getMCPManager } from './mcp/manager'
import { getRemoteControlManager, initRemoteControlManager } from '../../src/main/services/remote-control-manager'
import { createRemoteControlHandler } from '../../src/main/ipc/remote-control-handler'
import {
  setIdeApiAdapter,
  type IdeApiAdapter,
} from '../../src/main/agents/operation-executor'
import { setMasterSessionConfig } from '../../src/main/agents/session-config'
import type { ProjectInfo, MCPStatus, SkillGroup } from '../../src/main/agents/master-agent'

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
  /** 会话 ID，用于前端按会话过滤事件 */
  sessionId?: string
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'complete' | 'init' | 'status' | 'rate_limit' | 'keepalive'
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
  /** Status data for api_retry, task events, tool progress etc. */
  statusData?: {
    status: string
    reason?: string
    /** task_started / task_progress / task_updated */
    taskId?: string
    subagentType?: string
    description?: string
    /** task_progress */
    toolUseId?: string
    /** task_updated */
    taskStatus?: string
    error?: string
    /** tool_progress */
    toolName?: string
    parentToolUseId?: string
    elapsed_time_seconds?: number
    /** tool_use_summary */
    precedingToolUseIds?: string[]
    /** session_state_changed */
    sessionState?: 'idle' | 'running' | 'requires_action'
    /** permission_denied */
    permissionDenied?: {
      toolName: string
      reason: string
    }
    /** rate_limit */
    rateLimit?: {
      tier: string
      requestsRemaining?: number
      resetAt?: string
    }
    /** memory_recall */
    memories?: Array<{
      path: string
      scope: string
      content?: string
    }>
    /** notification */
    notification?: {
      level: 'info' | 'warning' | 'error'
      title?: string
    }
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
  /** 动态设置 MCP 服务器配置 */
  setMcpServers?(servers: Record<string, any>): Promise<void>
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
  /** ★ 软中断标记：表示这是用户主动中断而非错误，会话可继续使用 */
  isSoftAbort?: boolean
  /** ★ SDK 内部的会话 ID，用于 resume 恢复上下文 */
  providerSessionId?: string
  /** ★ Provider 配置，用于中断后自动恢复 */
  providerConfig?: {
    apiKey: string
    baseUrl?: string
    model?: string
    apiType?: 'anthropic' | 'openai'
    envOverrides?: Record<string, string>
  }
  /** ★ 上下文窗口大小（tokens） */
  contextWindow?: number
  /** ★ 是否有工具调用（用于判断空内容是否正常） */
  hasToolCalls?: boolean
  /** ★ 是否有 thinking 内容（用于判断空内容是否正常） */
  hasThinking?: boolean
  /** ★ MCP 配置快照，用于检测变化并动态更新 */
  mcpConfigSnapshot?: Record<string, any>
  /** ★ 最近一次发送的消息内容（用于空内容重试） */
  lastPrompt?: string
  /** ★ 空内容重试计数（每次 sendMessage 重置为 0） */
  emptyOutputRetryCount?: number
  /** ★ 上次收到前端 pong 的时间戳（用于双向心跳检测） */
  lastPongTime?: number
}

// 活跃会话映射
const activeSessions = new Map<string, ClaudeSession>()

/** Global provider config cache — updated whenever a session is created.
 *  Allows remote control to create sessions on demand without frontend involvement. */
let globalProviderConfig: {
  apiKey: string
  apiType: 'anthropic' | 'openai'
  baseUrl?: string
  model?: string
  envOverrides?: Record<string, string>
} | null = null

/**
 * 获取所有活跃会话
 * 用于 MCP Connector 在 MCP 启动/停止时更新会话配置
 */
export function getAllActiveSessions(): Map<string, ClaudeSession> {
  return activeSessions
}

// 会话创建锁（防止并发创建同一会话）
const sessionCreationLocks = new Map<string, Promise<ClaudeSession>>()

// ★ AskUserQuestion 挂起队列（参考 SpectrAI）
const pendingQuestions = new Map<string, {
  resolve: (result: any) => void
  toolInput: Record<string, unknown>
}>()

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
 * ★ 创建权限回调函数（参考 SpectrAI 的 createPermissionHandler）
 *
 * bypassPermissions 模式下，AskUserQuestion 仍需要用户交互才能继续
 * 因此通过 canUseTool 回调拦截 AskUserQuestion，弹面板等待用户回答
 *
 * @param sessionId 会话 ID
 */
function createPermissionHandler(sessionId: string) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    _options: any
  ): Promise<any> => {
    // ★ AskUserQuestion：弹面板等待用户回答
    // 必须返回 { behavior: 'deny', message: '用户答案' } 格式
    // Claude 会从 deny message 中提取答案继续执行
    if (toolName === 'AskUserQuestion') {
      console.log('[Claude SDK] AskUserQuestion intercepted, waiting for user answer:', JSON.stringify(input).slice(0, 200))
      return new Promise((resolve) => {
        pendingQuestions.set(sessionId, { resolve, toolInput: input })

        // 发送事件到前端，显示问题面板
        const mainWindow = BrowserWindow.getAllWindows()[0]
        if (mainWindow) {
          mainWindow.webContents.send('claude:progress', {
            sessionId,
            type: 'tool_use',
            content: 'Tool: AskUserQuestion',
            toolName: 'AskUserQuestion',
            toolInput: input,
            toolUseId: `ask-${Date.now()}`,
          } as ProgressEvent)
        }
      })
    }

    // ★ ExitPlanMode：自动批准（发出事件让 UI 展示，但不等用户点击）
    if (toolName === 'ExitPlanMode') {
      console.log('[Claude SDK] ExitPlanMode auto-approved')
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (mainWindow) {
        mainWindow.webContents.send('claude:progress', {
          sessionId,
          type: 'tool_use',
          content: 'Tool: ExitPlanMode',
          toolName: 'ExitPlanMode',
          toolInput: input,
          toolUseId: `exit-plan-${Date.now()}`,
        } as ProgressEvent)
      }
      return { behavior: 'allow' }
    }

    // 普通工具：自动放行（与 bypassPermissions 行为一致）
    // ⚠️ 普通工具的 "allow" 返回格式是 { updatedInput: Record }（将工具输入原样传回）
    // 不能用 { behavior: 'allow' }，否则 SDK Zod 校验失败
    return { updatedInput: input }
  }
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
  envOverrides?: Record<string, string>,
  /** ★ 用于恢复会话上下文的 SDK session ID */
  resumeSessionId?: string,
  /** ★ 上下文窗口大小（tokens） */
  contextWindow?: number
): Promise<ClaudeSession> {
  // 检查是否已有活跃会话
  const existing = activeSessions.get(sessionId)
  // ★ 只有当 status 不是 error 且 sdkQuery 存在时才复用
  // 如果 sdkQuery 为 null，说明之前被中断并关闭了，需要重建
  if (existing && existing.status !== 'error' && existing.sdkQuery) {
    // ★ 即使复用会话，也检查并更新 MCP 配置
    try {
      const mcpConnector = getMCPConnector()
      const builtinMcpServers = mcpConnector.getMCPServerConfigs()

      // 读取全局 MCP 配置
      let globalMcpServers: Record<string, any> = {}
      try {
        const claudeJsonPath = join(app.getPath('home'), '.claude.json')
        const claudeJsonContent = await fs.readFile(claudeJsonPath, 'utf-8')
        const claudeJson = JSON.parse(claudeJsonContent)
        globalMcpServers = claudeJson.mcpServers || {}
      } catch {}

      // 合并配置
      const mergedConfig = {
        ...globalMcpServers,
        ...builtinMcpServers
      }

      // 比较配置是否有变化
      if (JSON.stringify(existing.mcpConfigSnapshot) !== JSON.stringify(mergedConfig)) {
        console.log('[Claude SDK] MCP 配置变化，动态更新')
        console.log('[Claude SDK] 内置 MCP:', Object.keys(builtinMcpServers))

        // 使用 SDK API 更新
        if (existing.sdkQuery.setMcpServers) {
          await existing.sdkQuery.setMcpServers(mergedConfig)
          existing.mcpConfigSnapshot = mergedConfig
          console.log('[Claude SDK] MCP 配置已更新')
        } else {
          console.warn('[Claude SDK] SDK 不支持 setMcpServers，无法动态更新 MCP')
        }
      }
    } catch (err) {
      console.warn('[Claude SDK] 更新 MCP 配置失败:', err)
    }

    return existing
  }

  // 如果会话存在但 sdkQuery 为 null，需要重建
  // 保存 providerSessionId 用于恢复上下文
  let savedProviderSessionId: string | undefined = resumeSessionId
  if (existing && !existing.sdkQuery) {
    console.log(`[Claude SDK] Session ${sessionId} exists but sdkQuery is null, will recreate`)
    // 如果没有传入 resumeSessionId，尝试使用保存的
    if (!savedProviderSessionId && existing.providerSessionId) {
      savedProviderSessionId = existing.providerSessionId
      console.log(`[Claude SDK] Will resume with providerSessionId: ${savedProviderSessionId}`)
    }
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
        // ★ canUseTool 回调：拦截 AskUserQuestion 等需要用户交互的工具
        canUseTool: createPermissionHandler(sessionId),
      }

      // ★ 添加系统提示，指导 AI 使用内置 MCP 工具
      sdkOptions.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: `
## 内置 MCP 工具使用指南

当用户询问以下内容时，请自动调用相应的 MCP 工具：

### 1. 网络搜索 (mcp__open-websearch__search)
用于搜索网络信息，包括但不限于：
- 天气查询：用户问"今天天气"、"北京天气"等，调用 search 工具
- 新闻资讯：用户问"最新新闻"、"科技新闻"等
- 知识查询：用户问"什么是..."、"如何..."等需要搜索的问题
- 示例：用户问"今天北京天气怎么样"，调用 \`mcp__open-websearch__search\` 搜索"北京今天天气"

### 2. 网页内容抓取 (mcp__fetch__get_markdown)
用于获取网页内容：
- 用户需要查看某个网页的内容时
- 用户提供了 URL 并希望获取其内容时

### 3. 浏览器自动化 (mcp__playwright__*)
用于需要操作浏览器的场景：
- 截取网页截图
- 填写表单
- 点击按钮
- 页面导航

### 4. macOS 自动化 (mcp__macos-automator__*)
用于 macOS 系统自动化：
- 执行 AppleScript
- 运行快捷指令
- 系统控制

### 5. ⭐ 知识记忆系统 (mcp__memory__*) - 重要！

**Memory MCP 是跨会话持久化记忆系统，AI 必须主动使用它来存储和查询重要信息。**

#### 什么时候必须存储记忆？
- 用户说"记住..."、"别忘了..."、"记下来..."
- 用户提供了重要的个人信息（姓名、偏好、联系方式等）
- 用户提到了项目配置、API 密钥、账号信息等
- 用户明确要求下次记住某些设置

#### 什么时候必须查询记忆？
- **每次对话开始时**，先调用 \`mcp__memory__read_graph\` 或 \`mcp__memory__search_nodes\` 查询历史记忆
- 用户问"之前说的..."、"上次提到的..."、"我记得..."
- 用户询问自己的偏好、设置、历史记录

#### 记忆工具使用方法：
- \`mcp__memory__create_entities\`：创建实体（人、项目、概念等）
  - 示例：用户说"我叫张三"，创建实体 {name: "张三", type: "person", observations: ["用户的名字"]}
- \`mcp__memory__add_observations\`：为实体添加属性/观察
  - 示例：用户说"我喜欢用深色主题"，添加观察 ["喜欢深色主题"] 到用户实体
- \`mcp__memory__create_relations\`：创建实体间关系
  - 示例：用户说"我在做项目A"，创建关系 {from: "张三", to: "项目A", relationType: "正在做"}
- \`mcp__memory__search_nodes\`：搜索已存储的知识
  - 示例：用户问"我喜欢什么"，搜索 "喜欢" 或 "偏好"
- \`mcp__memory__read_graph\`：读取整个知识图谱

**重要**：
1. 当用户的问题可以通过上述工具解决时，请主动调用工具，不要询问用户是否需要使用工具。
2. 记忆系统是核心功能，必须积极使用，不要让用户反复提供相同信息。

### 6. Windows 桌面自动化 (mcp__desktop-touch__*)
用于 Windows 系统桌面自动化操作：
- 鼠标移动、点击、拖拽
- 键盘输入、快捷键
- 窗口控制（移动、调整大小、关闭）
- 屏幕截图

使用场景：
- 用户需要自动化操作 Windows 应用
- 用户需要模拟鼠标键盘操作
- 用户需要控制窗口位置和大小

### 7. 浏览器自动化 - MCPBrowser (mcp__mcpbrowser__*)
用于浏览器自动化，支持 Cookie 持久化和浏览器指纹保持：
- 网页导航、点击、输入
- 表单自动填写
- 网页截图
- Cookie 管理（保持登录状态）

使用场景：
- 需要保持登录状态的自动化操作
- 需要避免被网站检测为自动化工具
- 需要跨会话保持浏览器状态
`
      }

      // ★ 集成内置 MCP 服务
      try {
        const mcpConnector = getMCPConnector()
        const builtinMcpServers = mcpConnector.getMCPServerConfigs()
        const builtinMcpCount = Object.keys(builtinMcpServers).length

        if (builtinMcpCount > 0) {
          console.log(`[Claude SDK] 集成 ${builtinMcpCount} 个内置 MCP 服务:`, Object.keys(builtinMcpServers))
          // 合并到现有 mcpServers 配置中
          sdkOptions.mcpServers = {
            ...sdkOptions.mcpServers,
            ...builtinMcpServers
          }
        }
      } catch (err) {
        console.warn('[Claude SDK] 获取内置 MCP 服务配置失败:', err)
      }

      // ★ 如果有 resumeSessionId，添加 resume 选项恢复上下文
      if (savedProviderSessionId) {
        sdkOptions.resume = savedProviderSessionId
        console.log('[Claude SDK] Resuming session with providerSessionId:', savedProviderSessionId)
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

      // ★ 保存 MCP 配置快照，用于后续检测变化
      const mcpConfigSnapshot = { ...sdkOptions.mcpServers }

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
        providerConfig: {
          apiKey,
          baseUrl,
          model,
          apiType,
          envOverrides,
        },
        contextWindow: contextWindow || 200000,  // ★ 上下文窗口，默认 200K
        hasToolCalls: false,
        hasThinking: false,
        mcpConfigSnapshot,  // ★ 保存 MCP 配置快照
        lastPongTime: Date.now(),
      }

      // Cache provider config globally for remote-control on-demand session creation
      globalProviderConfig = { apiKey, apiType, baseUrl, model, envOverrides }

      // Also update master AI session config so it can initialize on next attempt
      try {
        setMasterSessionConfig({
          apiKey,
          apiType: apiType || 'anthropic',
          baseUrl,
          model,
          pathToClaudeCodeExecutable: resolveClaudeBinaryPath() || undefined,
        })
      } catch {}

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

  // ★ Keepalive: 每 30 秒向渲染进程发送 keepalive，前端回复 pong
  // 连续 3 次无 pong 回复（90s）则标记前端可能已断开
  let lastStreamMessageTime = Date.now()
  const keepaliveInterval = setInterval(() => {
    if (session.abortController.signal.aborted) return
    if (Date.now() - lastStreamMessageTime >= 30000) {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.webContents.send('claude:progress', {
          sessionId: session.id,
          type: 'keepalive',
          content: '',
        } as ProgressEvent)
      }
      // 检查前端 pong 回复：超过 3 个 keepalive 周期无 pong 则告警
      const lastPong = session.lastPongTime ?? session.lastActivity
      const missedPongs = Math.floor((Date.now() - lastPong) / 30000)
      if (missedPongs >= 3) {
        console.warn(`[Claude SDK] Session ${session.id}: ${missedPongs} missed pongs — frontend may be disconnected`)
      }
    }
  }, 30000)

  try {
    for await (const msg of session.sdkQuery) {
      // ★ 检查是否已被中断
      if (session.abortController.signal.aborted) {
        console.log(`[Claude SDK] Stream aborted for session: ${session.id}`)
        break
      }

      // ★ 更新最后收到消息的时间（用于 keepalive 抑制）
      lastStreamMessageTime = Date.now()

      console.log(`[Claude SDK] Message type: ${msg.type}, subtype: ${msg.subtype}`)

      // 获取主窗口发送进度事件
      const mainWindow = BrowserWindow.getAllWindows()[0]
      if (!mainWindow) continue

      switch (msg.type) {
        case 'system':
          session.lastActivity = Date.now()
          if (msg.subtype === 'init') {
            console.log('[Claude SDK] Initialized:', msg.model)
            session.status = 'running'

            // ★ 保存 SDK 内部的 session_id，用于 resume 恢复上下文
            if (msg.session_id) {
              session.providerSessionId = msg.session_id
              console.log('[Claude SDK] Provider session ID:', msg.session_id)
              // ★ 持久化到 session 文件，重启后可恢复会话上下文
              persistProviderSessionId(session.id, msg.session_id)
            }

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
              sessionId: session.id,
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
              sessionId: session.id,
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
              sessionId: session.id,
              type: 'status',
              content: msg.message || `Status: ${msg.status || 'unknown'}`,
              statusData: {
                status: msg.status || 'unknown',
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'task_started') {
            // ★ 子 Agent/任务开始
            console.log('[Claude SDK] Task started:', msg.task_id, msg.subagent_type, msg.description)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: `启动子任务: ${msg.description || msg.subagent_type || 'unknown'}`,
              statusData: {
                status: 'task_started',
                taskId: msg.task_id,
                subagentType: msg.subagent_type,
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'task_progress') {
            // ★ 子 Agent/任务进度
            console.log('[Claude SDK] Task progress:', msg.task_id, msg.description, msg.usage)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: msg.description || '子任务执行中...',
              statusData: {
                status: 'task_progress',
                taskId: msg.task_id,
                toolUseId: msg.tool_use_id,
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'task_updated') {
            // ★ 子 Agent/任务状态更新
            console.log('[Claude SDK] Task updated:', msg.task_id, msg.patch?.status)
            // 发送所有任务状态更新（不只是 completed/failed）
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: msg.patch?.status === 'completed'
                ? '子任务完成'
                : msg.patch?.status === 'failed'
                  ? `子任务失败: ${msg.patch?.error || 'unknown'}`
                  : `子任务状态: ${msg.patch?.status || 'unknown'}`,
              statusData: {
                status: 'task_updated',
                taskId: msg.task_id,
                taskStatus: msg.patch?.status,
                error: msg.patch?.error,
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'session_state_changed') {
            // ★ 会话状态变化（权威的轮次结束信号）
            console.log('[Claude SDK] Session state changed:', msg.state)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: `会话状态: ${msg.state}`,
              statusData: {
                status: 'session_state_changed',
                sessionState: msg.state,
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'permission_denied') {
            // ★ 权限被拒绝（自动拒绝，非交互式）
            console.log('[Claude SDK] Permission denied:', msg.tool_name, msg.reason)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: `工具 ${msg.tool_name} 被拒绝: ${msg.reason || 'unknown'}`,
              statusData: {
                status: 'permission_denied',
                permissionDenied: {
                  toolName: msg.tool_name,
                  reason: msg.reason || 'unknown',
                },
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'memory_recall') {
            // ★ 记忆召回
            console.log('[Claude SDK] Memory recall:', msg.mode, msg.memories?.length)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: `召回 ${msg.memories?.length || 0} 条记忆`,
              statusData: {
                status: 'memory_recall',
                memories: msg.memories,
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'task_notification') {
            // ★ 后台任务通知
            console.log('[Claude SDK] Task notification:', msg.task_id, msg.message)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: msg.message || '后台任务通知',
              statusData: {
                status: 'task_notification',
                taskId: msg.task_id,
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'notification') {
            // ★ 通用通知
            console.log('[Claude SDK] Notification:', msg.level, msg.message)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: msg.message || '通知',
              statusData: {
                status: 'notification',
                notification: {
                  level: msg.level,
                  title: msg.title,
                },
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'elicitation_complete') {
            // ★ MCP elicitation 完成
            console.log('[Claude SDK] Elicitation complete:', msg.mcp_server_name)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: `MCP elicitation 完成: ${msg.mcp_server_name}`,
              statusData: {
                status: 'elicitation_complete',
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'compact_boundary') {
            // ★ 压缩边界（上下文压缩事件）
            console.log('[Claude SDK] Compact boundary:', msg.boundary_type)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: '上下文已压缩',
              statusData: {
                status: 'compact_boundary',
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'files_persisted') {
            // ★ 文件持久化事件
            console.log('[Claude SDK] Files persisted:', msg.files?.length)
            // 不发送到前端，仅记录日志
          } else if (msg.subtype === 'auth_status') {
            // ★ 认证状态
            console.log('[Claude SDK] Auth status:', msg.status)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: `认证状态: ${msg.status}`,
              statusData: {
                status: 'auth_status',
              },
            } as ProgressEvent)
          } else if (msg.subtype === 'prompt_suggestion') {
            // ★ 提示建议
            console.log('[Claude SDK] Prompt suggestion:', msg.suggestions?.length)
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: '有可用的提示建议',
              statusData: {
                status: 'prompt_suggestion',
              },
            } as ProgressEvent)
          } else {
            // 其他 system 子类型，记录日志
            console.log('[Claude SDK] Unhandled system subtype:', msg.subtype, msg)
          }
          break

        case 'tool_progress':
          // ★ 工具执行进度（包括子 Agent）
          session.lastActivity = Date.now()
          console.log('[Claude SDK] Tool progress:', msg.tool_name, msg.tool_use_id, msg.elapsed_time_seconds)
          mainWindow.webContents.send('claude:progress', {
            sessionId: session.id,
            type: 'status',
            content: `${msg.tool_name} 执行中... (${msg.elapsed_time_seconds}s)`,
            statusData: {
              status: 'tool_progress',
              toolName: msg.tool_name,
              toolUseId: msg.tool_use_id,
              parentToolUseId: msg.parent_tool_use_id,
            },
          } as ProgressEvent)
          break

        case 'tool_use_summary':
          // ★ 工具使用摘要 - 可能包含子 Agent 的结果
          session.lastActivity = Date.now()
          console.log('[Claude SDK] Tool use summary:', msg.summary, msg.preceding_tool_use_ids)
          // 如果有摘要内容，发送给前端
          if (msg.summary) {
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'status',
              content: msg.summary,
              statusData: {
                status: 'tool_summary',
                precedingToolUseIds: msg.preceding_tool_use_ids,
              },
            } as ProgressEvent)
          }
          break

        case 'stream_event':
          session.lastActivity = Date.now()
          const evt = msg.event
          if (evt?.type === 'content_block_delta') {
            const delta = evt.delta
            if (delta?.type === 'text_delta' && delta.text) {
              session.output += delta.text
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
                type: 'text',
                content: delta.text,
              } as ProgressEvent)
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              // ★ 处理 thinking_delta，转发到前端（防止心跳超时）
              session.hasThinking = true
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
                type: 'thinking',
                content: delta.thinking,
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
              // ★ 标记有工具调用（防止空内容误判）
              session.hasToolCalls = true
              session.lastActivity = Date.now()
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
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
          session.lastActivity = Date.now()
          const content = msg.message?.content || []
          for (const block of content) {
            if (block.type === 'text') {
              const text = block.text || ''
              if (!session.output.includes(text)) {
                session.output += text
                mainWindow.webContents.send('claude:progress', {
                  sessionId: session.id,
                  type: 'text',
                  content: text,
                } as ProgressEvent)
              }
            } else if (block.type === 'thinking') {
              // ★ 处理 thinking 块
              session.hasThinking = true
              const thinkingText = block.thinking || ''
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
                type: 'thinking',
                content: thinkingText,
              } as ProgressEvent)
            } else if (block.type === 'tool_use') {
              // ★ 标记有工具调用
              session.hasToolCalls = true
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
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
          session.lastActivity = Date.now()
          const userContent = msg.message?.content || []
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
                type: 'tool_result',
                toolUseId: block.tool_use_id,
                content: String(block.content || '').slice(0, 500),
                isError: block.is_error,
              } as ProgressEvent)
            }
          }

          // ★ 处理 tool_use_result 字段 - 可能包含子 Agent 的结果
          if (msg.tool_use_result !== undefined && msg.tool_use_result !== null) {
            console.log('[Claude SDK] User message has tool_use_result:', msg.parent_tool_use_id)
            // parent_tool_use_id 关联到父 Agent 的 Agent 工具调用
            if (msg.parent_tool_use_id) {
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
                type: 'tool_result',
                toolUseId: msg.parent_tool_use_id,
                content: String(msg.tool_use_result).slice(0, 500),
                isError: false,
              } as ProgressEvent)
            }
          }
          break

        case 'result':
          session.lastActivity = Date.now()
          const isSuccess = msg.subtype === 'success'
          console.log('[Claude SDK] Result:', isSuccess ? 'success' : 'failed')
          console.log('[Claude SDK] Result message keys:', Object.keys(msg))
          console.log('[Claude SDK] Result usage:', JSON.stringify(msg.usage, null, 2))
          console.log('[Claude SDK] Result totalTokens:', msg.totalTokens)
          console.log('[Claude SDK] Session hasToolCalls:', session.hasToolCalls, 'hasThinking:', session.hasThinking)
          session.status = isSuccess ? 'idle' : 'error'

          // ★ 提取 token 使用量数据
          // SDK 可能返回 usage 或 totalTokens 字段
          const usageData = msg.usage ? {
            inputTokens: msg.usage.input_tokens || 0,
            outputTokens: msg.usage.output_tokens || 0,
            contextWindow: session.contextWindow || 200000,  // ★ 使用会话配置的上下文窗口
          } : msg.totalTokens ? {
            inputTokens: msg.totalTokens,
            outputTokens: 0,
            contextWindow: session.contextWindow || 200000,  // ★ 使用会话配置的上下文窗口
          } : undefined

          console.log('[Claude SDK] Extracted usageData:', usageData)

          if (isSuccess) {
            // ★ 检查是否是软中断后的正常结束
            if (session.isSoftAbort) {
              console.log(`[Claude SDK] Soft abort detected after result for ${session.id}`)
              handleSoftAbortCleanup(session)
              return
            }

            // ★ 检查 output 是否为空 - 但如果有工具调用或 thinking，则不算空
            const hasContent = session.output?.trim() || session.hasToolCalls || session.hasThinking
            if (!hasContent) {
              console.warn(`[Claude SDK] Empty output detected for session: ${session.id}`)
              console.warn('[Claude SDK] This may indicate SDK returned success without generating content')
              // ★ 自动重试：先尝试重建会话重新发送，重试耗尽才报错
              const retried = await retryEmptyOutput(session, mainWindow)
              if (!retried) {
                mainWindow.webContents.send('claude:progress', {
                  sessionId: session.id,
                  type: 'error',
                  content: '⚠️ Agent 返回了空内容。可能是请求被中断或发生了内部错误，请重试。',
                } as ProgressEvent)
              }
              // ★ 必须 return 退出 consumeSessionStream，避免 post-loop 代码重复触发
              return
            } else {
              mainWindow.webContents.send('claude:progress', {
                sessionId: session.id,
                type: 'complete',
                content: session.output || '',
                usageData,
              } as ProgressEvent)
            }
          } else {
            // SDK 明确返回错误 → 直接通知前端，不重试
            const errorMsg = msg.result || 'Unknown error'
            mainWindow.webContents.send('claude:progress', {
              sessionId: session.id,
              type: 'error',
              content: errorMsg,
            } as ProgressEvent)
            return
          }
          break

        case 'rate_limit_event':
          // ★ 速率限制事件
          session.lastActivity = Date.now()
          console.log('[Claude SDK] Rate limit event:', msg.tier, msg.rate_limit_info)
          mainWindow.webContents.send('claude:progress', {
            sessionId: session.id,
            type: 'rate_limit',
            content: `速率限制: ${msg.tier || 'unknown'}`,
            statusData: {
              status: 'rate_limit',
              rateLimit: {
                tier: msg.tier,
                requestsRemaining: msg.rate_limit_info?.requests_remaining,
                resetAt: msg.rate_limit_info?.reset_at,
              },
            },
          } as ProgressEvent)
          break

        default:
          // ★ 处理未知消息类型，记录日志防止遗漏
          console.log('[Claude SDK] Unhandled message type:', msg.type, msg)
          break
      }
    }

    console.log(`[Claude SDK] Stream ended naturally for session: ${session.id}`)

    // ★ 检查是否是软中断后的正常退出
    if (session.isSoftAbort) {
      console.log(`[Claude SDK] Soft abort detected after loop exit for ${session.id}`)
      handleSoftAbortCleanup(session)
      return
    }

    // 发送 complete/error 事件给前端，确保 isStreaming 被重置
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (mainWindow) {
      // ★ 检查 output 是否为空 - 但如果有工具调用或 thinking，则不算空
      const hasContent = session.output?.trim() || session.hasToolCalls || session.hasThinking
      if (!hasContent) {
        console.warn(`[Claude SDK] Stream ended with empty output for session: ${session.id}`)
        // ★ 自动重试：先尝试重建会话重新发送，重试耗尽才报错
        const retried = await retryEmptyOutput(session, mainWindow)
        if (!retried) {
          mainWindow.webContents.send('claude:progress', {
            sessionId: session.id,
            type: 'error',
            content: '⚠️ Agent 返回了空内容。可能是请求被中断或发生了内部错误，请重试。',
          } as ProgressEvent)
        }
        // retry 已处理（重建 session + enqueue），直接返回避免重复触发
        return
      } else {
        mainWindow.webContents.send('claude:progress', {
          sessionId: session.id,
          type: 'complete',
          content: session.output || '',
        } as ProgressEvent)
      }
    }

  } catch (err: any) {
    console.error(`[Claude SDK] Stream error for session ${session.id}:`, err)

    // ★ 参考 SpectrAI：扩大 abort 错误检测范围
    // SDK 可能抛出 APIUserAbortError 或 DOMException
    const isAbortError = err.name === 'AbortError' ||
      /abort/i.test(err.name || '') ||
      err.constructor?.name?.includes?.('UserAbort') ||
      err.constructor?.name?.includes?.('Abort') ||
      /\baborted\b/i.test(err.message || '')

    const mainWindow = BrowserWindow.getAllWindows()[0]

    if (isAbortError) {
      const isSoft = session.isSoftAbort
      session.isSoftAbort = false

      if (isSoft) {
        console.log(`[Claude SDK] Soft abort via exception for ${session.id}`)
        handleSoftAbortCleanup(session)
      } else {
        // 硬中断（非用户主动），当作正常中断处理
        session.status = 'idle'
        if (mainWindow) {
          mainWindow.webContents.send('claude:progress', {
            sessionId: session.id,
            type: 'error',
            content: '会话已中断',
          } as ProgressEvent)
        }
      }
      return
    }

    // 非 abort 错误：真正的错误
    session.status = 'error'
    if (mainWindow) {
      // 参考 SpectrAI：针对进程退出错误生成友好提示
      const isProcessExit = /process exited with code/i.test(err.message)
      let errorText = err.message || String(err)

      if (isProcessExit) {
        errorText = `Claude Code 进程异常退出: ${err.message}`
      } else if (/ENOENT/i.test(err.message)) {
        errorText = '启动失败：找不到 Claude Code 可执行文件。请确保已安装 @anthropic-ai/claude-code'
      }

      mainWindow.webContents.send('claude:progress', {
        sessionId: session.id,
        type: 'error',
        content: errorText,
      } as ProgressEvent)
    }
  } finally {
    clearInterval(keepaliveInterval)
  }
}

/**
 * ★ 空内容自动重试（指数退避：2s → 5s → 10s，最多 3 次）
 *
 * 当 SDK 返回 success 但没有产生任何输出内容时（可能是连接失败或 API 瞬态错误），
 * 自动重建会话并重新发送消息，避免向用户展示不必要的错误。
 *
 * @returns true 表示已发起重试，false 表示重试次数耗尽
 */
async function retryEmptyOutput(
  session: ClaudeSession,
  mainWindow: BrowserWindow
): Promise<boolean> {
  const retryCount = (session.emptyOutputRetryCount || 0) + 1
  session.emptyOutputRetryCount = retryCount

  if (retryCount > 3) {
    console.warn(`[Claude SDK] Empty output retry exhausted for session: ${session.id}`)
    return false
  }

  const backoffMs = [2000, 5000, 10000][retryCount - 1]
  console.log(`[Claude SDK] Empty output retry #${retryCount} for session: ${session.id}, waiting ${backoffMs}ms...`)

  // 通知前端正在重试
  mainWindow.webContents.send('claude:progress', {
    sessionId: session.id,
    type: 'status',
    content: `Agent 返回空内容，正在重试（第 ${retryCount}/3 次）...`,
    statusData: { status: 'retrying', retryCount, maxRetries: 3 },
  } as ProgressEvent)

  // 等待退避时间
  await new Promise((resolve) => setTimeout(resolve, backoffMs))

  // 保存重建所需的信息
  const config = session.providerConfig
  if (!config) {
    console.warn('[Claude SDK] No providerConfig for retry')
    return false
  }

  const lastPrompt = session.lastPrompt
  if (!lastPrompt) {
    console.warn('[Claude SDK] No lastPrompt for retry')
    return false
  }

  const providerSessionId = session.providerSessionId

  // ★ Abort 旧 session 的 abortController，确保旧 consumeSessionStream 尽快退出
  // 避免新旧两个 keepalive 定时器同时运行
  try { session.abortController.abort() } catch { /* ignore */ }

  // 关闭旧的 sdkQuery
  if (session.sdkQuery) {
    try { session.sdkQuery.close() } catch { /* ignore */ }
    session.sdkQuery = null
  }

  // 重置状态（getOrCreateSession 会检测到 null sdkQuery 并重建）
  session.status = 'idle'

  try {
    // ★ 最后一次重试不恢复上下文（避免上下文损坏导致反复失败）
    const resumeId = retryCount < 3 ? providerSessionId : undefined
    if (retryCount >= 3) {
      console.log('[Claude SDK] Last retry attempt, starting with fresh context (no resume)')
    }

    const newSession = await getOrCreateSession(
      session.id,
      session.workingDirectory,
      config.apiKey,
      config.apiType || 'anthropic',
      config.baseUrl,
      config.model,
      config.envOverrides,
      resumeId
    )

    // 将消息排入新的 stream
    newSession.output = ''
    newSession.hasToolCalls = false
    newSession.hasThinking = false
    newSession.status = 'running'
    newSession.lastActivity = Date.now()
    newSession.lastPrompt = lastPrompt
    newSession.emptyOutputRetryCount = retryCount

    newSession.inputStream.enqueue({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: lastPrompt }] },
    })

    console.log(`[Claude SDK] Retry #${retryCount} message enqueued for session: ${session.id}`)
    return true
  } catch (err) {
    console.error(`[Claude SDK] Retry #${retryCount} failed:`, err)
    return false
  }
}

/**
 * ★ 软中断清理处理（参考 SpectrAI）
 * 发送友好提示，重置状态，保持会话可用
 */
function handleSoftAbortCleanup(session: ClaudeSession): void {
  session.isSoftAbort = false
  console.log(`[Claude SDK] Soft abort cleanup for ${session.id}`)

  // 重建 AbortController（为下一轮准备）
  session.abortController = new AbortController()
  session.status = 'idle'

  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    // 发送 complete 事件让前端切换回可输入状态
    mainWindow.webContents.send('claude:progress', {
      sessionId: session.id,
      type: 'complete',
      content: session.output,
    } as ProgressEvent)
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
    async (_event, options: Omit<ClaudeExecuteOptions, 'prompt'> & { sessionId: string; envOverrides?: Record<string, string>; contextWindow?: number }): Promise<{ success: boolean; error?: string }> => {
      const { sessionId, workingDirectory, apiKey, baseUrl, model, apiType = 'anthropic', envOverrides, contextWindow } = options

      console.log('[Claude SDK] ===== claude:startSession called =====')
      console.log('[Claude SDK] Session ID:', sessionId)
      console.log('[Claude SDK] Received apiKey (first 20 chars):', apiKey?.substring(0, 20))
      console.log('[Claude SDK] Received apiKey length:', apiKey?.length)
      console.log('[Claude SDK] Received model:', model)
      console.log('[Claude SDK] Received baseUrl:', baseUrl)
      console.log('[Claude SDK] Received contextWindow:', contextWindow)

      // ★ 如果已有会话，获取保存的 providerSessionId 用于恢复上下文
      const existingSession = activeSessions.get(sessionId)
      let resumeSessionId: string | undefined = existingSession?.providerSessionId
      if (!resumeSessionId) {
        // ★ 从持久化 session 文件读取 providerSessionId（重启后 activeSessions 为空）
        resumeSessionId = await loadProviderSessionIdFromFile(sessionId)
        if (resumeSessionId) {
          console.log('[Claude SDK] Will resume from persisted providerSessionId:', resumeSessionId)
        }
      } else {
        console.log('[Claude SDK] Will resume with memory providerSessionId:', resumeSessionId)
      }

      try {
        await getOrCreateSession(sessionId, workingDirectory, apiKey, apiType, baseUrl, model, envOverrides, resumeSessionId, contextWindow)
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

      let session = activeSessions.get(sessionId)
      if (!session) {
        console.error('[Claude SDK] Session not found:', sessionId)
        return { success: false, error: `Session ${sessionId} not found. Please start session first.` }
      }

      if (session.status === 'error') {
        console.warn('[Claude SDK] Session in error state, attempting to recreate...')
        // 尝试清理并重建会话 - 这里暂不实现，返回错误
        return { success: false, error: 'Session is in error state' }
      }

      // ★ 检查 sdkQuery 是否可用，如果不可用需要重建会话
      if (!session.sdkQuery) {
        console.log('[Claude SDK] sdkQuery is null, need to recreate session')

        // 使用保存的 providerConfig 重建会话
        const config = session.providerConfig
        if (!config) {
          console.error('[Claude SDK] No providerConfig saved, cannot recreate session')
          return { success: false, error: 'Session was interrupted and cannot be restored. Please restart the session.' }
        }

        // ★ 获取保存的 providerSessionId 用于恢复上下文
        let resumeSessionId: string | undefined = session.providerSessionId
        if (!resumeSessionId) {
          resumeSessionId = await loadProviderSessionIdFromFile(sessionId)
        }
        if (resumeSessionId) {
          console.log('[Claude SDK] Will resume with providerSessionId:', resumeSessionId)
        }

        try {
          // 调用 getOrCreateSession 重建会话，传入 resumeSessionId
          session = await getOrCreateSession(
            sessionId,
            session.workingDirectory,
            config.apiKey,
            config.apiType || 'anthropic',
            config.baseUrl,
            config.model,
            config.envOverrides,
            resumeSessionId  // ★ 传入用于恢复上下文的 session ID
          )
          console.log('[Claude SDK] Session recreated successfully')
        } catch (err: any) {
          console.error('[Claude SDK] Failed to recreate session:', err)
          return { success: false, error: `Failed to recreate session: ${err.message}` }
        }
      }

      // 重置输出（每轮对话重新开始）
      session.output = ''
      session.hasToolCalls = false
      session.hasThinking = false
      session.status = 'running'
      session.lastActivity = Date.now()
      session.lastPrompt = prompt
      session.emptyOutputRetryCount = 0

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

  // ★ 软中断当前轮次（参考 SpectrAI 的 abortCurrentTurn）
  // 软中断：中止当前思考，会话保持活跃，可继续发送消息
  ipcMain.handle(
    'claude:abort',
    async (_event, sessionId: string): Promise<{ success: boolean }> => {
      const session = activeSessions.get(sessionId)
      if (!session) return { success: false }

      console.log('[Claude SDK] Soft abort for session:', sessionId)

      const mainWindow = BrowserWindow.getAllWindows()[0]

      // 检查会话状态
      if (session.status !== 'running') {
        console.log(`[Claude SDK] Session ${sessionId} not running (status=${session.status}), skip abort but notify frontend`)
        // ★ 即使会话不是 running，也要通知前端重置状态（防止前端卡在 streaming）
        if (mainWindow) {
          mainWindow.webContents.send('claude:progress', {
            sessionId,
            type: 'complete',
            content: session.output || '',
          } as ProgressEvent)
        }
        return { success: true }
      }

      // ★ 标记为软中断（会话可继续使用）
      session.isSoftAbort = true

      // 设置 abort 标志，让 consumeSessionStream 可以检测到
      session.abortController.abort()

      // 调用 SDK 的 interrupt 方法
      if (session.sdkQuery) {
        try {
          // 使用 Promise.race 添加超时保护
          await Promise.race([
            session.sdkQuery.interrupt(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('interrupt timeout')), 5000)
            ),
          ])
          console.log('[Claude SDK] SDK interrupt called successfully')

          // ★ interrupt 成功后，主动发送 complete 事件
          // 不依赖 consumeSessionStream 的处理，确保前端状态被重置
          // 注意：consumeSessionStream 可能会在 interrupt 后继续处理一些消息
          // 所以这里不立即发送 complete，让 consumeSessionStream 的 handleSoftAbortCleanup 处理
        } catch (err) {
          console.warn('[Claude SDK] Error calling interrupt:', err)
          // interrupt 失败时，强制关闭 SDK query
          try {
            session.sdkQuery.close()
            console.log('[Claude SDK] SDK query force closed')
          } catch (closeErr) {
            console.warn('[Claude SDK] Error force closing SDK query:', closeErr)
          }
          // 清空 sdkQuery 引用，下次发送消息时会重新创建
          session.sdkQuery = null

          // ★ 重要：interrupt 失败时，必须主动通知前端重置状态
          // 否则前端会一直卡在 streaming 状态
          console.log('[Claude SDK] Notifying frontend of forced abort')
          session.status = 'idle'
          session.isSoftAbort = false
          if (mainWindow) {
            mainWindow.webContents.send('claude:progress', {
              sessionId,
              type: 'complete',
              content: session.output || '',
            } as ProgressEvent)
          }
        }
      } else {
        // ★ 没有 sdkQuery 时，也要通知前端重置状态
        console.log('[Claude SDK] No sdkQuery, notifying frontend to reset state')
        session.status = 'idle'
        session.isSoftAbort = false
        if (mainWindow) {
          mainWindow.webContents.send('claude:progress', {
            sessionId,
            type: 'complete',
            content: session.output || '',
          } as ProgressEvent)
        }
      }

      return { success: true }
    }
  )

  // ★ 前端 pong 回执（双向心跳，响应 keepalive）
  ipcMain.handle(
    'claude:pong',
    async (_event, sessionId: string) => {
      const session = activeSessions.get(sessionId)
      if (session) {
        session.lastPongTime = Date.now()
      }
    }
  )

  // ★ 检查会话流是否存活（前端心跳超时时调用）
  ipcMain.handle(
    'claude:pingSession',
    async (_event, sessionId: string): Promise<{ alive: boolean; status: string; lastActivity: number }> => {
      const session = activeSessions.get(sessionId)
      if (!session) {
        return { alive: false, status: 'not_found', lastActivity: 0 }
      }
      return {
        alive: session.sdkQuery !== null && session.status === 'running',
        status: session.status,
        lastActivity: session.lastActivity || 0,
      }
    }
  )

  // ★ 关闭会话
  ipcMain.handle(
    'claude:closeSession',
    async (_event, sessionId: string): Promise<{ success: boolean }> => {
      const session = activeSessions.get(sessionId)
      if (!session) return { success: false }

      console.log('[Claude SDK] Closing session:', sessionId)

      const mainWindow = BrowserWindow.getAllWindows()[0]

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

      // ★ 通知前端重置状态（防止前端卡在 streaming）
      if (mainWindow && session.status === 'running') {
        mainWindow.webContents.send('claude:progress', {
          sessionId,
          type: 'complete',
          content: session.output || '',
        } as ProgressEvent)
      }

      activeSessions.delete(sessionId)
      return { success: true }
    }
  )

  // ★ 回答 AskUserQuestion（参考 SpectrAI 的 sendQuestionAnswer）
  // 用户在 UI 中回答问题后，调用此接口将答案传回 SDK
  ipcMain.handle(
    'claude:answerQuestion',
    async (_event, sessionId: string, answers: Record<string, string>): Promise<{ success: boolean; error?: string }> => {
      console.log('[Claude SDK] answerQuestion called for session:', sessionId)
      console.log('[Claude SDK] Answers:', JSON.stringify(answers))

      const pending = pendingQuestions.get(sessionId)
      if (!pending) {
        console.warn('[Claude SDK] No pending question for session:', sessionId)
        return { success: false, error: 'No pending question' }
      }

      // 格式化答案为 Claude 可理解的格式
      // 必须返回 { behavior: 'deny', message: '答案内容' }
      // Claude 会从 deny message 中提取答案继续执行
      const questions = pending.toolInput.questions as Array<{ question: string; header?: string }> | undefined
      let answersText = '用户已回答了您的问题：\n'
      if (Array.isArray(questions)) {
        questions.forEach((q, i) => {
          const key = String(i)
          const answer = answers[key] || answers[q.header || ''] || answers[q.question] || '（未填写）'
          answersText += `• ${q.header || q.question}：${answer}\n`
        })
      } else {
        answersText += JSON.stringify(answers)
      }

      console.log('[Claude SDK] Formatted answers:', answersText)

      // 调用 resolve 函数，将答案传回 SDK
      pending.resolve({ behavior: 'deny', message: answersText })
      pendingQuestions.delete(sessionId)

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
        session.hasToolCalls = false
        session.hasThinking = false
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

/**
 * Persist providerSessionId to the session JSON file so it survives restarts.
 * Called from consumeSessionStream when the SDK returns a session_id.
 */
async function persistProviderSessionId(sessionId: string, providerSessionId: string): Promise<void> {
  try {
    const sessionsDir = join(app.getPath('userData'), 'sessions')
    const filePath = join(sessionsDir, `${sessionId}.json`)
    let data: any = { version: '1.0.0', session: { id: sessionId }, updatedAt: new Date().toISOString() }
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      data = JSON.parse(content)
    } catch { /* file doesn't exist yet, use default */ }
    if (!data.session) data.session = { id: sessionId }
    data.session.providerSessionId = providerSessionId
    data.updatedAt = new Date().toISOString()
    await fs.mkdir(sessionsDir, { recursive: true })
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
    console.log(`[Session Persist] Saved providerSessionId to ${sessionId}.json`)
  } catch (err) {
    console.warn('[Session Persist] Failed to save providerSessionId:', err)
  }
}

/** Load providerSessionId from a specific persisted session file. */
async function loadProviderSessionIdFromFile(sessionId: string): Promise<string | undefined> {
  try {
    const filePath = join(app.getPath('userData'), 'sessions', `${sessionId}.json`)
    const content = await fs.readFile(filePath, 'utf-8')
    const data = JSON.parse(content)
    return data.session?.providerSessionId as string | undefined
  } catch {
    return undefined
  }
}

/** Find persisted providerSessionId for a project by scanning session files. */
async function loadProviderSessionIdForProject(projectId: string): Promise<string | undefined> {
  try {
    const sessionsDir = join(app.getPath('userData'), 'sessions')
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const filePath = join(sessionsDir, entry.name)
        const content = await fs.readFile(filePath, 'utf-8')
        const data = JSON.parse(content)
        // Match by projectId (frontend sessions) or by session.id (auto-created sessions)
        if (data.session?.providerSessionId &&
            (data.session.projectId === projectId || data.session.id === projectId)) {
          console.log(`[Session Persist] Found providerSessionId for project ${projectId}: ${data.session.providerSessionId}`)
          return data.session.providerSessionId as string
        }
      } catch { /* skip corrupted files */ }
    }
  } catch { /* sessions dir doesn't exist */ }
  return undefined
}

/** Load provider config from persisted providers.json, falling back to global cache. */
async function loadProviderConfig(): Promise<{
  apiKey: string
  apiType: 'anthropic' | 'openai'
  baseUrl?: string
  model?: string
  envOverrides?: Record<string, string>
} | null> {
  if (globalProviderConfig) return globalProviderConfig
  try {
    const providersPath = join(app.getPath('userData'), 'providers.json')
    const content = await fs.readFile(providersPath, 'utf-8')
    const data = JSON.parse(content) as {
      providers: Array<{
        id: string
        name: string
        apiKey: string
        apiType?: string
        baseUrl?: string
        defaultModel?: string
        envOverrides?: Record<string, string>
      }>
      activeProviderId: string | null
    }
    const active = data.providers.find((p) => p.id === data.activeProviderId) || data.providers[0]
    if (active?.apiKey) {
      return {
        apiKey: active.apiKey,
        apiType: (active.apiType as 'anthropic' | 'openai') || 'anthropic',
        baseUrl: active.baseUrl,
        model: active.defaultModel,
        envOverrides: active.envOverrides,
      }
    }
  } catch { /* providers.json not available yet */ }
  return null
}

/**
 * Create IDE API Adapter for remote control operations
 *
 * This adapter provides real IDE operations by connecting to the actual
 * session management, MCP connector, and other IDE functionality.
 */
function createIdeApiAdapter(): IdeApiAdapter {
  /** Per-session serialization locks to prevent concurrent sendMessage calls */
  const sessionLocks = new Map<string, Promise<void>>()

  // ── IDE project helpers ──────────────────────────────────────────────────

  interface IdeProject {
    id: string
    name: string
    path: string
    createdAt: string
    lastOpenedAt: string
    isActive: boolean
  }

  interface ProjectsData {
    projects: IdeProject[]
    recentProjects: string[]
    activeProjectId: string | null
  }

  function getProjectsPath(): string {
    return join(app.getPath('userData'), 'projects.json')
  }

  async function loadIdeProjects(): Promise<ProjectsData> {
    try {
      const content = await fs.readFile(getProjectsPath(), 'utf-8')
      return JSON.parse(content) as ProjectsData
    } catch {
      return { projects: [], recentProjects: [], activeProjectId: null }
    }
  }

  /** Find active session(s) matching a project path */
  function findSessionsByPath(projectPath: string): ClaudeSession[] {
    const results: ClaudeSession[] = []
    for (const session of activeSessions.values()) {
      if (session.workingDirectory === projectPath) {
        results.push(session)
      }
    }
    return results
  }

  /** Resolve a project/session ID to a project entry and its sessions */
  async function resolveProject(projectId: string): Promise<{
    project: IdeProject | null
    sessions: ClaudeSession[]
  }> {
    // Try IDE projects first (by ID)
    const ideData = await loadIdeProjects()
    const ideProject = ideData.projects.find((p) => p.id === projectId)
    if (ideProject) {
      return { project: ideProject, sessions: findSessionsByPath(ideProject.path) }
    }
    // Fallback: treat projectId as a session ID for backward compatibility
    const session = activeSessions.get(projectId)
    if (session) {
      // Look up IDE project by working directory
      const matchedProject = ideData.projects.find((p) => p.path === session.workingDirectory)
      return { project: matchedProject || null, sessions: [session] }
    }
    // Check if projectId matches a project name
    const namedProject = ideData.projects.find((p) => p.name === projectId)
    if (namedProject) {
      return { project: namedProject, sessions: findSessionsByPath(namedProject.path) }
    }
    return { project: null, sessions: [] }
  }

  return {
    /**
     * Get all IDE projects merged with active session status.
     * Shows every project from the IDE, not just those with active SDK sessions.
     */
    async getProjects(): Promise<ProjectInfo[]> {
      const ideData = await loadIdeProjects()
      const seenPaths = new Set<string>()
      const projects: ProjectInfo[] = []

      for (const p of ideData.projects) {
        seenPaths.add(p.path)
        const sessions = findSessionsByPath(p.path)
        const activeSession = sessions.length > 0 ? sessions[sessions.length - 1] : null
        projects.push({
          id: p.id,
          name: p.name,
          status: activeSession?.status as 'running' | 'idle' | 'error' ?? 'idle',
          currentTask: activeSession?.status === 'running' ? '执行中...' : undefined,
          progress: activeSession?.status === 'running' ? 50 : undefined,
          lastActivity: activeSession
            ? new Date(activeSession.lastActivity).toISOString()
            : p.lastOpenedAt,
        })
      }

      // Include orphan sessions not matching any IDE project
      for (const [sessionId, session] of activeSessions) {
        if (!seenPaths.has(session.workingDirectory)) {
          const projectName = session.workingDirectory.split('/').pop() || session.workingDirectory
          projects.push({
            id: sessionId,
            name: projectName,
            status: session.status as 'running' | 'idle' | 'error',
            currentTask: session.status === 'running' ? '执行中...' : undefined,
            progress: session.status === 'running' ? 50 : undefined,
            lastActivity: new Date(session.lastActivity).toISOString(),
          })
        }
      }

      return projects
    },

    /**
     * Get current active project ID from IDE state.
     */
    async getCurrentProject(): Promise<string | undefined> {
      const ideData = await loadIdeProjects()
      if (ideData.activeProjectId) return ideData.activeProjectId

      // Fallback: most recently active session
      let mostRecentSession: string | undefined
      let mostRecentActivity = 0
      for (const [sessionId, session] of activeSessions) {
        if (session.lastActivity > mostRecentActivity) {
          mostRecentActivity = session.lastActivity
          mostRecentSession = sessionId
        }
      }
      return mostRecentSession
    },

    /**
     * Switch to a specific project.
     * Resolves project by ID, name, or session ID.
     */
    async switchProject(projectId: string): Promise<{ success: boolean; message: string }> {
      const { project, sessions } = await resolveProject(projectId)
      if (!project && sessions.length === 0) {
        return { success: false, message: `项目 "${projectId}" 不存在` }
      }

      const projectName = project?.name
        || sessions[0]?.workingDirectory.split('/').pop()
        || projectId

      // Notify the frontend to switch to this project
      const windows = BrowserWindow.getAllWindows()
      for (const win of windows) {
        win.webContents.send('remote-control:switch-project', {
          projectId: project?.id || projectId,
          projectName,
        })
      }

      return { success: true, message: `已切换到项目: ${projectName}` }
    },

    /**
     * Restart a project session.
     * Resolves project by ID, name, or session ID.
     */
    async restartProject(projectId: string): Promise<{ success: boolean; message: string }> {
      const { project, sessions } = await resolveProject(projectId)
      const activeSession = sessions.length > 0 ? sessions[sessions.length - 1] : null

      if (!activeSession) {
        if (project) {
          return { success: true, message: `项目 "${project.name}" 当前没有活跃会话，无需重启` }
        }
        return { success: false, message: `项目 "${projectId}" 不存在` }
      }

      try {
        activeSession.output = ''
        activeSession.hasToolCalls = false
        activeSession.hasThinking = false
        activeSession.status = 'idle'
        activeSession.lastActivity = Date.now()

        const displayName = project?.name
          || activeSession.workingDirectory.split('/').pop()
          || projectId

        return { success: true, message: `项目会话已重启: ${displayName}` }
      } catch (err) {
        return {
          success: false,
          message: `重启失败: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },

    /**
     * Get MCP tools status
     */
    async getMcpStatus(): Promise<MCPStatus[]> {
      // Map MCP internal status to API status type
      const mapMcpStatus = (status: string): 'running' | 'stopped' | 'error' => {
        switch (status) {
          case 'running':
          case 'starting':
            return 'running'
          case 'stopped':
          case 'stopping':
            return 'stopped'
          case 'error':
          default:
            return 'error'
        }
      }

      try {
        const mcpManager = getMCPManager()
        const instances = mcpManager.getInstances()
        const definitions = mcpManager.getDefinitions()

        const statusList: MCPStatus[] = []

        for (const def of definitions) {
          const instance = instances.get(def.id)
          statusList.push({
            id: def.id,
            name: def.name,
            status: instance ? mapMcpStatus(instance.status) : 'stopped',
            connectionInfo: instance?.status === 'running' ? '已连接' : undefined,
          })
        }

        return statusList
      } catch (err) {
        console.error('[IdeApiAdapter] Failed to get MCP status:', err)
        return []
      }
    },

    /**
     * Start an MCP tool
     */
    async startMcp(mcpId: string): Promise<{ success: boolean; message: string }> {
      try {
        const mcpManager = getMCPManager()
        await mcpManager.start(mcpId)

        return {
          success: true,
          message: `MCP ${mcpId} 已启动`,
        }
      } catch (err) {
        return {
          success: false,
          message: `启动 MCP 失败: ${err}`,
        }
      }
    },

    /**
     * Stop an MCP tool
     */
    async stopMcp(mcpId: string): Promise<{ success: boolean; message: string }> {
      try {
        const mcpManager = getMCPManager()
        await mcpManager.stop(mcpId)

        return {
          success: true,
          message: `MCP ${mcpId} 已停止`,
        }
      } catch (err) {
        return {
          success: false,
          message: `停止 MCP 失败: ${err}`,
        }
      }
    },

    /**
     * Get available skill groups
     * Currently returns a default set since skill groups are not fully implemented
     */
    async getSkillGroups(): Promise<SkillGroup[]> {
      // TODO: Implement skill group retrieval when the feature is ready
      // For now, return a default skill group
      return [
        {
          id: 'default',
          name: '默认技能组',
          description: '所有可用技能',
          skillCount: 0,
          isActive: true,
        },
      ]
    },

    /**
     * Switch to a skill group
     * Currently a no-op since skill groups are not fully implemented
     */
    async switchSkillGroup(skillGroupId: string): Promise<{ success: boolean; message: string }> {
      // TODO: Implement skill group switching when the feature is ready
      return {
        success: true,
        message: `已切换到技能组: ${skillGroupId}`,
      }
    },

    /**
     * Send a message to a project's AI agent and wait for the response.
     *
     * Enqueues the user message into the session's input stream and
     * polls until the session returns to idle (or error), then returns
     * the collected output.
     */
    async sendMessage(projectId: string, message: string): Promise<{ success: boolean; message: string }> {
      // Resolve project ID (could be IDE project UUID, session UUID, or project name)
      let session = activeSessions.get(projectId) ?? null
      let resolvedProjectId = projectId

      if (!session) {
        const resolved = await resolveProject(projectId)
        if (resolved.sessions.length > 0) {
          session = resolved.sessions[resolved.sessions.length - 1]
          resolvedProjectId = session.id
        } else if (resolved.project) {
          // Try to create a new session for this project using provider config
          // from any existing active session, global cache, or persisted providers.json
          const donorConfig = activeSessions.values().next().value
            ? (activeSessions.values().next().value as ClaudeSession).providerConfig
            : null
          const cfg = donorConfig || globalProviderConfig || await loadProviderConfig()
          if (cfg) {
            try {
              // ★ 从持久化文件读取 providerSessionId 以恢复会话上下文
              const persistedSessionId = resolved.project
                ? (await loadProviderSessionIdForProject(resolved.project.id))
                : undefined
              if (persistedSessionId) {
                console.log('[sendMessage] Resuming persisted session for project:', resolved.project?.name)
              }
              session = await getOrCreateSession(
                projectId,
                resolved.project.path,
                cfg.apiKey,
                cfg.apiType || 'anthropic',
                cfg.baseUrl,
                cfg.model,
                cfg.envOverrides,
                persistedSessionId,  // ★ 传入持久化的 providerSessionId 以恢复上下文
              )
              resolvedProjectId = session.id
            } catch (err) {
              return {
                success: false,
                message: `无法为项目 "${resolved.project.name}" 创建 AI 会话: ${(err as Error).message}`,
              }
            }
          } else {
            return {
              success: false,
              message: `项目 "${resolved.project.name}" 还没有活跃的 AI 会话。请先在 IDE 中点击该项目开始对话。`,
            }
          }
        } else {
          return { success: false, message: `项目 "${projectId}" 不存在` }
        }
      }

      // Serialize per-session
      const previous = sessionLocks.get(resolvedProjectId) ?? Promise.resolve()
      let resolveLock: () => void
      const next = new Promise<void>((r) => { resolveLock = r })
      sessionLocks.set(resolvedProjectId, next)

      await previous

      // Capture non-null session for closure use
      const s = session

      try {
        // If sdkQuery is null and we have provider config, try to recreate
        if (!s.sdkQuery) {
          const config = s.providerConfig
          if (!config) {
            return { success: false, message: '无法恢复会话连接，请重启项目' }
          }
          try {
            const recreated = await getOrCreateSession(
              resolvedProjectId,
              s.workingDirectory,
              config.apiKey,
              config.apiType || 'anthropic',
              config.baseUrl,
              config.model,
              config.envOverrides,
              s.providerSessionId,
            )
            // Update the outer reference if recreation succeeds
            session = recreated
          } catch (err) {
            return { success: false, message: `恢复会话失败: ${(err as Error).message}` }
          }
        }

        // Use the potentially recreated session
        const activeSession = session || s

        // Reset output for this turn
        activeSession.output = ''
        activeSession.hasToolCalls = false
        activeSession.hasThinking = false
        activeSession.status = 'running'
        activeSession.lastActivity = Date.now()

        // Enqueue the user message
        activeSession.inputStream.enqueue({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: message }],
          },
        })

        // Wait for the session to complete (max 5 minutes)
        const chatTimeout = 300000
        return new Promise((resolve) => {
          const startTime = Date.now()

          const check = setInterval(() => {
            const elapsed = Date.now() - startTime

            if (activeSession.status === 'idle') {
              clearInterval(check)
              resolve({
                success: true,
                message: activeSession.output || '(AI 未返回内容)',
              })
            } else if (activeSession.status === 'error') {
              clearInterval(check)
              resolve({
                success: false,
                message: 'AI Agent 处理出错',
              })
            } else if (elapsed > chatTimeout) {
              clearInterval(check)
              resolve({
                success: false,
                message: 'AI Agent 响应超时（5分钟）',
              })
            }
          }, 1000)
        })
      } finally {
        resolveLock!()
      }
    },
  }
}

/**
 * Initialize Remote Control
 *
 * Initializes the simplified single-account remote control manager.
 */
async function initializeRemoteControl(): Promise<void> {
  console.log('[RemoteControl] Initializing...')

  // Always register IPC handlers first so the renderer never gets
  // "No handler registered", even if manager init fails later.
  const handler = createRemoteControlHandler()
  handler.register()
  console.log('[RemoteControl] IPC handlers registered')

  try {
    // Load provider config for the master AI session (before manager init,
    // since restoreConnection() may try to create the AI session).
    try {
      const config = await loadProviderConfig()
      if (config) {
        setMasterSessionConfig({
          apiKey: config.apiKey,
          apiType: config.apiType || 'anthropic',
          baseUrl: config.baseUrl,
          model: config.model,
          pathToClaudeCodeExecutable: resolveClaudeBinaryPath() || undefined,
        })
        console.log('[RemoteControl] Master session config set')
      } else {
        console.warn('[RemoteControl] No provider config available yet, master AI session deferred')
      }
    } catch (err) {
      console.warn('[RemoteControl] Failed to load provider config for master session:', err)
    }

    const manager = await initRemoteControlManager()
    console.log('[RemoteControl] Manager initialized')

    handler.setManager(manager)
    handler.setupManagerEvents()
    console.log('[RemoteControl] Manager events wired')

    setIdeApiAdapter(createIdeApiAdapter())
    console.log('[RemoteControl] IDE API adapter injected')

    console.log('[RemoteControl] Initialization complete')
  } catch (err) {
    console.error('[RemoteControl] Manager init failed:', err)
    // Handlers are already registered — they'll return NOT_INITIALIZED
    // to the renderer instead of "No handler registered"
  }
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

  // Initialize MCP Manager (built-in MCP tools)
  console.log('[Main] Initializing MCP Manager...')
  try {
    // ★ 先设置 Connector 的活跃会话回调（在 MCP 启动之前）
    getMCPConnector().setGetActiveSessionsCallback(() => activeSessions)

    // 然后初始化 MCP（会自动恢复运行中的 MCP）
    await initializeMCPIPC()

    console.log('[Main] MCP Manager initialized')
  } catch (err) {
    console.error('[Main] Failed to initialize MCP Manager:', err)
    // Continue without MCP - not critical for basic functionality
  }

  // Initialize Remote Control IPC handlers
  await initializeRemoteControl()

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
