/**
 * Environment type definitions for renderer process
 * Updated with multi-channel event system following SpectrAI architecture
 */

import type {
  ConversationMessagePayload,
  ActivityPayload,
  StateChangePayload,
  ErrorPayload,
  SessionEventPayload,
} from '@shared/index'
import type {
  GitBranch,
  DiffFile,
  FileDiff,
  GitStatusSummary,
} from '@/types'
import type { AgentType } from '@/types/agent.types'
import type { SkillLibrary } from '@/types/skill-library.types'
import type {
  ConnectionStatus,
  ConnectionInfo,
  RemoteControlStatus,
} from '@shared/types/remote-control'

/** Progress callback type for Claude Code execution (legacy) */
export type ProgressCallback = (data: {
  /** 会话 ID，用于前端按会话过滤事件（修复会话内容串扰问题） */
  sessionId?: string
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'complete' | 'init' | 'status' | 'rate_limit'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolUseId?: string
  isError?: boolean
  initData?: {
    model?: string
    tools?: string[]
    mcpServers?: { name: string; status: string }[]
    slashCommands?: string[]
    skills?: string[]
    plugins?: { name: string; path: string }[]
    agents?: string[]
    cwd?: string
    projectSkillNames?: string[]
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
    /** retrying (api_retry) */
    retryCount?: number
    maxRetries?: number
  }
  /** Token usage data from SDK result */
  usageData?: {
    inputTokens: number
    outputTokens: number
    contextWindow: number
  }
}) => void

/** Claude execute options */
export interface ClaudeExecuteOptions {
  prompt: string
  workingDirectory: string
  apiKey: string
  baseUrl?: string
  model?: string
  timeout?: number
  apiType?: 'anthropic' | 'openai'
}

/** Claude session options */
export interface ClaudeSessionOptions {
  sessionId: string
  workingDirectory: string
  apiKey: string
  baseUrl?: string
  model?: string
  apiType?: 'anthropic' | 'openai'
  envOverrides?: Record<string, string>
  contextWindow?: number  // ★ 上下文窗口大小（tokens）
}

/** Claude Code execution result */
export interface ClaudeCodeResult {
  success: boolean
  output?: string
  error?: string
  duration?: number
}

export interface ElectronAPI {
  ipcRenderer: import('electron').IpcRenderer
  process: {
    platform: NodeJS.Platform
    versions: {
      chrome: string
      electron: string
      node: string
    }
  }
}

export interface Api {
  ping: () => void
  dialog: {
    openDirectory: () => Promise<string | null>
    openFile: (options?: { filters?: { name: string; extensions: string[] }[] }) => Promise<{ canceled: boolean; filePaths: string[] }>
  }
  clipboard: {
    /** Write text to clipboard */
    writeText: (text: string) => Promise<void>
  }
  shell: {
    /** Open path in file manager */
    openPath: (path: string) => Promise<void>
  }
  fs: {
    getUserDataPath: () => Promise<string>
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>
    writeFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
    exists: (filePath: string) => Promise<boolean>
    mkdir: (dirPath: string) => Promise<{ success: boolean; error?: string }>
    delete: (filePath: string) => Promise<{ success: boolean; error?: string }>
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean; error?: string }>
    readDir: (dirPath: string, depth?: number) => Promise<{ success: boolean; content?: DirEntry[]; error?: string }>
    stat: (filePath: string) => Promise<{ success: boolean; content?: { size: number; isFile: boolean; isDirectory: boolean }; error?: string }>
  }
  crypto: {
    /** Check if encryption is available on this system */
    isAvailable: () => Promise<{ available: boolean }>
    /** Encrypt sensitive data */
    encrypt: (plainText: string) => Promise<{ success: boolean; encrypted?: string; error?: string }>
    /** Decrypt sensitive data */
    decrypt: (encrypted: string) => Promise<{ success: boolean; decrypted?: string; error?: string }>
    /** Check if a string appears to be encrypted */
    isEncrypted: (text: string) => Promise<{ isEncrypted: boolean }>
  }
  claude: {
    /** Check if claude CLI is available */
    checkAvailable: () => Promise<{ available: boolean }>
    /** Get claude CLI version */
    getVersion: () => Promise<{ version: string | null }>
    /** Check if any agent CLI is installed */
    checkAgentInstalled: (agentType: string) => Promise<{ installed: boolean; version: string | null }>
    /** Start a session (creates persistent SDK query) */
    startSession: (options: ClaudeSessionOptions) => Promise<{ success: boolean; error?: string }>
    /** Send a message to an active session */
    sendMessage: (sessionId: string, prompt: string) => Promise<{ success: boolean; error?: string }>
    /** Abort current turn in session */
    abort: (sessionId: string) => Promise<{ success: boolean }>
    /** Close a session */
    closeSession: (sessionId: string) => Promise<{ success: boolean }>
    /** Answer AskUserQuestion tool (submit user's answers) */
    answerQuestion: (sessionId: string, answers: Record<string, string>) => Promise<{ success: boolean; error?: string }>
    /** Ping session to check if backend stream is alive */
    pingSession: (sessionId: string) => Promise<{ alive: boolean; status: string; lastActivity: number }>
    /** Heartbeat timeout recovery - rebuild session and resend message */
    retryHeartbeat: (sessionId: string) => Promise<{ success: boolean; error?: string; retryCount?: number }>
    /** Respond to keepalive ping */
    pong: (sessionId: string) => Promise<void>
    /** Get real-time context usage (accumulated tokens + accurate contextWindow) */
    getContextUsage: (sessionId: string) => Promise<{
      success: boolean
      data?: {
        totalTokens: number
        maxTokens: number
        rawMaxTokens: number
        percentage: number
        model: string
        categories: { name: string; tokens: number; color: string }[]
      }
      error?: string
    }>
    /** Execute claude command with progress events (legacy one-shot mode) */
    execute: (options: ClaudeExecuteOptions, onProgress?: ProgressCallback) => Promise<ClaudeCodeResult>
    /** Listen for progress events (legacy, for backward compatibility) */
    onProgress: (callback: ProgressCallback) => () => void
    /** Listen for conversation message events */
    onConversationMessage: (callback: (payload: ConversationMessagePayload) => void) => () => void
    /** Listen for activity events */
    onActivity: (callback: (payload: ActivityPayload) => void) => () => void
    /** Listen for state change events */
    onStateChange: (callback: (payload: StateChangePayload) => void) => () => void
    /** Listen for error events */
    onError: (callback: (payload: ErrorPayload) => void) => () => void
    /** Listen for session events */
    onSessionEvent: (callback: (payload: SessionEventPayload) => void) => () => void
  }
  watcher: {
    /** Start watching a directory for file changes */
    start: (dirPath: string) => Promise<{ success: boolean; error?: string }>
    /** Stop watching a directory */
    stop: (dirPath: string) => Promise<{ success: boolean; error?: string }>
    /** Stop all watchers */
    stopAll: () => Promise<{ success: boolean; error?: string }>
    /** Listen for file change events, returns unsubscribe function */
    onChange: (callback: (data: { type: string; path: string }) => void) => () => void
  }
  git: {
    /** Check if directory is a git repository */
    isRepo: (repoPath: string) => Promise<boolean>
    /** List all branches (local and remote) */
    listBranches: (repoPath: string) => Promise<{ local: GitBranch[]; remote: GitBranch[] }>
    /** Get current branch name */
    getCurrentBranch: (repoPath: string) => Promise<string>
    /** Get main branch name (main or master) */
    getMainBranch: (repoPath: string) => Promise<string>
    /** Checkout a branch */
    checkout: (repoPath: string, branch: string) => Promise<{ success: boolean; error?: string }>
    /** Force checkout a branch (discard local changes) */
    checkoutForce: (repoPath: string, branch: string) => Promise<{ success: boolean; error?: string }>
    /** Commit all changes and checkout branch */
    commitAndCheckout: (repoPath: string, branch: string, message?: string) => Promise<{ success: boolean; error?: string }>
    /** Get diff files between two branches */
    getBranchDiffFiles: (repoPath: string, targetBranch: string, currentBranch: string) => Promise<DiffFile[]>
    /** Get working tree changes (unstaged + staged + untracked) */
    getWorktreeDiffFiles: (repoPath: string) => Promise<DiffFile[]>
    /** Get detailed diff for a file between branches */
    getBranchFileDiff: (repoPath: string, targetBranch: string, currentBranch: string, filePath: string) => Promise<FileDiff | null>
    /** Get detailed diff for a working tree file */
    getWorktreeFileDiff: (repoPath: string, filePath: string, staged: boolean) => Promise<FileDiff | null>
    /** Get git status summary */
    getStatusSummary: (repoPath: string) => Promise<GitStatusSummary>
  }
  skillLibrary: {
    /** List all skills in the library */
    list: () => Promise<{ success: boolean; skills?: SkillLibrary[]; error?: string }>
    /** Add a new skill to the library from a zip file */
    add: (params: {
      zipPath: string
      name: string
      description: string
      agentType: AgentType
    }) => Promise<{ success: boolean; library?: SkillLibrary; error?: string }>
    /** Update skill metadata */
    update: (params: {
      id: string
      name: string
      description: string
    }) => Promise<{ success: boolean; library?: SkillLibrary; error?: string }>
    /** Delete a skill from the library */
    delete: (params: { id: string }) => Promise<{ success: boolean; error?: string }>
    /** Download a skill as a zip file */
    download: (params: { id: string }) => Promise<{ success: boolean; path?: string; error?: string }>
    /** Validate a skill zip file */
    validate: (params: { zipPath: string }) => Promise<{ success: boolean; valid?: boolean; error?: string }>
    /** Activate a skill in a project */
    activate: (params: {
      id: string
      projectPath: string
    }) => Promise<{ success: boolean; error?: string }>
  }
  mcp: {
    /** Get all MCP definitions */
    list: () => Promise<{
      definitions: Array<{
        id: string
        name: string
        description: string
        category: 'query' | 'browser' | 'desktop' | 'memory' | 'debug'
        packageName: string
        version: string
        platforms: string[]
        builtin: boolean
        defaultEnabled: boolean
        downloadSize: number
        runtimeSize: number
      }>
    }>
    /** Get all MCP instances */
    instances: () => Promise<{
      instances: Record<string, {
        id: string
        status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
        downloadStatus: 'not_downloaded' | 'downloading' | 'downloaded' | 'download_failed' | 'extracting' | 'ready'
        installPath?: string
        pid?: number
        startTime?: number
        error?: string
        downloadProgress?: number
        downloadingFile?: string
        toolsUsed?: string[]
        lastActivity?: number
      }>
    }>
    /** Enable an MCP */
    enable: (id: string) => Promise<void>
    /** Disable an MCP */
    disable: (id: string) => Promise<void>
    /** Start an MCP */
    start: (id: string) => Promise<void>
    /** Stop an MCP */
    stop: (id: string) => Promise<void>
    /** Restart an MCP */
    restart: (id: string) => Promise<void>
    /** Get MCP stats */
    stats: () => Promise<{
      stats: {
        total: number
        enabled: number
        running: number
        downloaded: number
        totalDownloadSize: number
        downloadedSize: number
      }
    }>
    /** Download an MCP */
    download: (id: string) => Promise<void>
    /** Listen for download progress events */
    onDownloadProgress: (callback: (event: { id: string; progress: number; file: string }) => void) => () => void
    /** Listen for status change events */
    onStatusChange: (callback: (event: { id: string; status: string }) => void) => () => void
  }
  remoteControl: {
    /** Get remote control status */
    getStatus: () => Promise<{
      success: boolean
      data?: RemoteControlStatus
      error?: { code: string; message: string }
    }>
    /** Connect and get QR code (or restore connection) */
    connect: () => Promise<{
      success: boolean
      data?: { qrCode: string; alreadyLoggedIn: boolean; userId?: string }
      error?: { code: string; message: string }
    }>
    /** Disconnect */
    disconnect: () => Promise<{
      success: boolean
      data?: { success: boolean }
      error?: { code: string; message: string }
    }>
    /** Update remote control settings */
    updateSettings: (settings: { enabled?: boolean; requireConfirm?: boolean }) => Promise<{
      success: boolean
      data?: { success: boolean }
      error?: { code: string; message: string }
    }>
    /** Listen for connection status changes */
    onConnectionChange: (callback: (event: { status: ConnectionStatus; userId?: string; error?: string }) => void) => () => void
    /** Listen for messages received from remote */
    onMessage: (callback: (event: { userId: string; content: string; timestamp: string }) => void) => () => void
    /** Listen for confirmation requests */
    onConfirmRequest: (callback: (event: { confirmId: string; message: string; timestamp: string }) => void) => () => void
    /** Listen for confirmation responses */
    onConfirmResponse: (callback: (event: { confirmId: string; confirmed: boolean }) => void) => () => void
    /** Listen for project switch requests from remote */
    onSwitchProject: (callback: (event: { projectId: string; projectName: string }) => void) => () => void
  }
}

interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: DirEntry[]
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}
