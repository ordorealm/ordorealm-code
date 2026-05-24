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

/** Progress callback type for Claude Code execution (legacy) */
export type ProgressCallback = (data: {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'complete' | 'init'
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
    list: () => Promise<{ success: boolean; skills?: unknown[]; error?: string }>
    /** Add a new skill to the library from a zip file */
    add: (params: {
      zipPath: string
      name: string
      description: string
      agentType: AgentType
    }) => Promise<{ success: boolean; skill?: unknown; error?: string }>
    /** Update skill metadata */
    update: (params: {
      id: string
      name: string
      description: string
    }) => Promise<{ success: boolean; error?: string }>
    /** Delete a skill from the library */
    delete: (params: { id: string }) => Promise<{ success: boolean; error?: string }>
    /** Download a skill as a zip file */
    download: (params: { id: string }) => Promise<{ success: boolean; path?: string; error?: string }>
    /** Validate a skill zip file */
    validate: (params: { zipPath: string }) => Promise<{ success: boolean; valid?: boolean; errors?: string[]; error?: string }>
    /** Activate a skill in a project */
    activate: (params: {
      id: string
      projectPath: string
    }) => Promise<{ success: boolean; error?: string }>
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
