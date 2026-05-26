import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Progress callback type for Claude Code execution
type ProgressCallback = (data: { type: string; content: string; toolName?: string; toolInput?: Record<string, unknown> }) => void

// Claude execute options type
interface ClaudeExecuteOptions {
  prompt: string
  workingDirectory: string
  apiKey: string
  baseUrl?: string
  model?: string
  timeout?: number
  apiType?: 'anthropic' | 'openai'
}

// Claude session options type
interface ClaudeSessionOptions {
  sessionId: string
  workingDirectory: string
  apiKey: string
  baseUrl?: string
  model?: string
  apiType?: 'anthropic' | 'openai'
}

// Agent type enum (synced with src/renderer/src/types/agent.types.ts)
type AgentType = 'claude-code' | 'codex' | 'opencode'

// Skill Library add params
interface SkillLibraryAddParams {
  zipPath: string
  name: string
  description: string
  agentType: AgentType
}

// Skill Library update params
interface SkillLibraryUpdateParams {
  id: string
  name: string
  description: string
}

// Skill Library delete params
interface SkillLibraryDeleteParams {
  id: string
}

// Skill Library download params
interface SkillLibraryDownloadParams {
  id: string
}

// Skill Library validate params
interface SkillLibraryValidateParams {
  zipPath: string
}

// Skill Library activate params
interface SkillLibraryActivateParams {
  id: string
  projectPath: string
}

// Custom APIs for renderer
const api = {
  ping: () => ipcRenderer.send('ping'),

  // Dialog APIs
  dialog: {
    openDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),
    openFile: (options?: { filters?: { name: string; extensions: string[] }[] }): Promise<{ canceled: boolean; filePaths: string[] }> =>
      ipcRenderer.invoke('dialog:openFile', options),
  },

  // Clipboard APIs
  clipboard: {
    /** Write text to clipboard */
    writeText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:writeText', text),
  },

  // Shell APIs
  shell: {
    /** Open path in file manager */
    openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),
  },

  // File system APIs
  fs: {
    getUserDataPath: (): Promise<string> => ipcRenderer.invoke('fs:getUserDataPath'),
    readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
    writeFile: (filePath: string, content: string) => ipcRenderer.invoke('fs:writeFile', filePath, content),
    exists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
    mkdir: (dirPath: string) => ipcRenderer.invoke('fs:mkdir', dirPath),
    delete: (filePath: string) => ipcRenderer.invoke('fs:delete', filePath),
    rename: (oldPath: string, newPath: string) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    readDir: (dirPath: string, depth?: number) => ipcRenderer.invoke('fs:readDir', dirPath, depth),
    stat: (filePath: string) => ipcRenderer.invoke('fs:stat', filePath),
  },

  // Crypto APIs for secure storage
  crypto: {
    /** Check if encryption is available on this system */
    isAvailable: (): Promise<{ available: boolean }> =>
      ipcRenderer.invoke('crypto:isAvailable'),

    /** Encrypt sensitive data (e.g., API Keys) */
    encrypt: (plainText: string): Promise<{ success: boolean; encrypted?: string; error?: string }> =>
      ipcRenderer.invoke('crypto:encrypt', plainText),

    /** Decrypt sensitive data */
    decrypt: (encrypted: string): Promise<{ success: boolean; decrypted?: string; error?: string }> =>
      ipcRenderer.invoke('crypto:decrypt', encrypted),

    /** Check if a string appears to be encrypted */
    isEncrypted: (text: string): Promise<{ isEncrypted: boolean }> =>
      ipcRenderer.invoke('crypto:isEncrypted', text),
  },

  // Claude Code APIs
  claude: {
    /** Check if claude CLI is available */
    checkAvailable: (): Promise<{ available: boolean }> =>
      ipcRenderer.invoke('claude:checkAvailable'),

    /** Get claude CLI version */
    getVersion: (): Promise<{ version: string | null }> =>
      ipcRenderer.invoke('claude:getVersion'),

    /** Check if any agent CLI is installed */
    checkAgentInstalled: (agentType: string): Promise<{ installed: boolean; version: string | null }> =>
      ipcRenderer.invoke('agent:checkInstalled', agentType),

    /** Start a session (creates persistent SDK query) */
    startSession: (
      options: ClaudeSessionOptions
    ): Promise<{ success: boolean; error?: string }> => {
      console.log('[Preload] startSession called');
      console.log('[Preload] options.apiKey (first 20 chars):', options.apiKey?.substring(0, 20));
      console.log('[Preload] options.apiKey length:', options.apiKey?.length);
      console.log('[Preload] options.model:', options.model);
      console.log('[Preload] options.baseUrl:', options.baseUrl);
      return ipcRenderer.invoke('claude:startSession', options);
    },

    /** Send a message to an active session */
    sendMessage: (
      sessionId: string,
      prompt: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('claude:sendMessage', sessionId, prompt),

    /** Abort current turn in session */
    abort: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('claude:abort', sessionId),

    /** Close a session */
    closeSession: (sessionId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('claude:closeSession', sessionId),

    /** Answer AskUserQuestion tool (submit user's answers) */
    answerQuestion: (sessionId: string, answers: Record<string, string>): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('claude:answerQuestion', sessionId, answers),

    /** Execute claude command with progress events (legacy one-shot mode) */
    execute: (
      options: ClaudeExecuteOptions,
      onProgress?: ProgressCallback
    ): Promise<{
      success: boolean
      output?: string
      error?: string
      toolCalls?: { name: string; input: Record<string, unknown>; output?: string; status: 'success' | 'error'; duration: number }[]
      duration?: number
    }> => {
      // Set up progress listener if callback provided
      let listener: ((_: unknown, data: unknown) => void) | null = null

      if (onProgress) {
        listener = (_: unknown, data: unknown) => {
          console.log('[Preload] Progress event received:', data)
          onProgress(data as Parameters<ProgressCallback>[0])
        }
        ipcRenderer.on('claude:progress', listener)
      }

      console.log('[Preload] Invoking claude:execute with options:', { model: options.model, baseUrl: options.baseUrl })

      return ipcRenderer.invoke('claude:execute', options).then((result) => {
        console.log('[Preload] claude:execute returned:', result?.success, result?.error)
        return result
      }).catch((error) => {
        console.error('[Preload] claude:execute error:', error)
        throw error
      }).finally(() => {
        if (listener) {
          ipcRenderer.removeListener('claude:progress', listener)
        }
      })
    },

    /** Listen for progress events (for session-based messaging) */
    onProgress: (callback: ProgressCallback): (() => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data as Parameters<ProgressCallback>[0])
      }
      ipcRenderer.on('claude:progress', listener)
      return () => ipcRenderer.removeListener('claude:progress', listener)
    },

    /** Listen for conversation message events (multi-channel) */
    onConversationMessage: (callback: (payload: any) => void): (() => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data)
      }
      ipcRenderer.on('conversation:message', listener)
      return () => ipcRenderer.removeListener('conversation:message', listener)
    },

    /** Listen for activity events (multi-channel) */
    onActivity: (callback: (payload: any) => void): (() => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data)
      }
      ipcRenderer.on('activity:update', listener)
      return () => ipcRenderer.removeListener('activity:update', listener)
    },

    /** Listen for state change events (multi-channel) */
    onStateChange: (callback: (payload: any) => void): (() => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data)
      }
      ipcRenderer.on('state:change', listener)
      return () => ipcRenderer.removeListener('state:change', listener)
    },

    /** Listen for error events (multi-channel) */
    onError: (callback: (payload: any) => void): (() => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data)
      }
      ipcRenderer.on('error:occurred', listener)
      return () => ipcRenderer.removeListener('error:occurred', listener)
    },

    /** Listen for session events (multi-channel) */
    onSessionEvent: (callback: (payload: any) => void): (() => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data)
      }
      ipcRenderer.on('session:event', listener)
      return () => ipcRenderer.removeListener('session:event', listener)
    },
  },

  // File Watcher APIs
  watcher: {
    /** Start watching a directory for file changes */
    start: (dirPath: string) => ipcRenderer.invoke('watcher:start', dirPath),
    /** Stop watching a directory */
    stop: (dirPath: string) => ipcRenderer.invoke('watcher:stop', dirPath),
    /** Stop all watchers */
    stopAll: () => ipcRenderer.invoke('watcher:stopAll'),
    /** Listen for file change events */
    onChange: (callback: (data: { type: string; path: string }) => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data as { type: string; path: string })
      }
      ipcRenderer.on('watcher:change', listener)
      return () => ipcRenderer.removeListener('watcher:change', listener)
    },
  },

  // Git APIs
  git: {
    /** Check if directory is a git repository */
    isRepo: (repoPath: string): Promise<boolean> =>
      ipcRenderer.invoke('git:isRepo', repoPath),

    /** List all branches (local and remote) */
    listBranches: (repoPath: string) =>
      ipcRenderer.invoke('git:listBranches', repoPath),

    /** Get current branch name */
    getCurrentBranch: (repoPath: string): Promise<string> =>
      ipcRenderer.invoke('git:getCurrentBranch', repoPath),

    /** Get main branch name (main or master) */
    getMainBranch: (repoPath: string): Promise<string> =>
      ipcRenderer.invoke('git:getMainBranch', repoPath),

    /** Checkout a branch */
    checkout: (repoPath: string, branch: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('git:checkout', repoPath, branch),

    /** Force checkout a branch (discard local changes) */
    checkoutForce: (repoPath: string, branch: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('git:checkoutForce', repoPath, branch),

    /** Commit all changes and checkout branch */
    commitAndCheckout: (repoPath: string, branch: string, message?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('git:commitAndCheckout', repoPath, branch, message),

    /** Get diff files between two branches */
    getBranchDiffFiles: (repoPath: string, targetBranch: string, currentBranch: string) =>
      ipcRenderer.invoke('git:getBranchDiffFiles', repoPath, targetBranch, currentBranch),

    /** Get working tree changes (unstaged + staged + untracked) */
    getWorktreeDiffFiles: (repoPath: string) =>
      ipcRenderer.invoke('git:getWorktreeDiffFiles', repoPath),

    /** Get detailed diff for a file between branches */
    getBranchFileDiff: (repoPath: string, targetBranch: string, currentBranch: string, filePath: string) =>
      ipcRenderer.invoke('git:getBranchFileDiff', repoPath, targetBranch, currentBranch, filePath),

    /** Get detailed diff for a working tree file */
    getWorktreeFileDiff: (repoPath: string, filePath: string, staged: boolean) =>
      ipcRenderer.invoke('git:getWorktreeFileDiff', repoPath, filePath, staged),

    /** Get git status summary */
    getStatusSummary: (repoPath: string) =>
      ipcRenderer.invoke('git:getStatusSummary', repoPath),
  },

  // Skill Library APIs
  skillLibrary: {
    /** List all skills in the library */
    list: () => ipcRenderer.invoke('skill-library:list'),

    /** Add a new skill to the library from a zip file */
    add: (params: SkillLibraryAddParams) =>
      ipcRenderer.invoke('skill-library:add', params),

    /** Update skill metadata */
    update: (params: SkillLibraryUpdateParams) =>
      ipcRenderer.invoke('skill-library:update', params),

    /** Delete a skill from the library */
    delete: (params: SkillLibraryDeleteParams) =>
      ipcRenderer.invoke('skill-library:delete', params),

    /** Download a skill as a zip file */
    download: (params: SkillLibraryDownloadParams) =>
      ipcRenderer.invoke('skill-library:download', params),

    /** Validate a skill zip file */
    validate: (params: SkillLibraryValidateParams) =>
      ipcRenderer.invoke('skill-library:validate', params),

    /** Activate a skill in a project */
    activate: (params: SkillLibraryActivateParams) =>
      ipcRenderer.invoke('skill-library:activate', params),
  },

  // MCP Manager APIs
  mcp: {
    /** Get all MCP definitions */
    list: () => ipcRenderer.invoke('mcp:list'),

    /** Get all MCP instances */
    instances: () => ipcRenderer.invoke('mcp:instances'),

    /** Enable an MCP */
    enable: (id: string) => ipcRenderer.invoke('mcp:enable', id),

    /** Disable an MCP */
    disable: (id: string) => ipcRenderer.invoke('mcp:disable', id),

    /** Start an MCP */
    start: (id: string) => ipcRenderer.invoke('mcp:start', id),

    /** Stop an MCP */
    stop: (id: string) => ipcRenderer.invoke('mcp:stop', id),

    /** Restart an MCP */
    restart: (id: string) => ipcRenderer.invoke('mcp:restart', id),

    /** Get MCP stats */
    stats: () => ipcRenderer.invoke('mcp:stats'),

    /** Download an MCP */
    download: (id: string) => ipcRenderer.invoke('mcp:download', id),

    /** Listen for download progress events */
    onDownloadProgress: (callback: (event: { id: string; progress: number; file: string }) => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data as { id: string; progress: number; file: string })
      }
      ipcRenderer.on('mcp:download-progress', listener)
      return () => ipcRenderer.removeListener('mcp:download-progress', listener)
    },

    /** Listen for status change events */
    onStatusChange: (callback: (event: { id: string; status: string }) => void) => {
      const listener = (_: unknown, data: unknown) => {
        callback(data as { id: string; status: string })
      }
      ipcRenderer.on('mcp:status-change', listener)
      return () => ipcRenderer.removeListener('mcp:status-change', listener)
    },
  },

  // Remote Control APIs
  remoteControl: {
    /** Get remote control status */
    getStatus: () => ipcRenderer.invoke('remote-control:get-status'),

    /** Connect a new channel and get QR code */
    connect: (channelType: 'wechat' | 'wecom' | 'feishu') =>
      ipcRenderer.invoke('remote-control:connect', { channelType }),

    /** Disconnect a channel */
    disconnect: (channelId: string) =>
      ipcRenderer.invoke('remote-control:disconnect', { channelId }),

    /** List all connected channels */
    listChannels: () => ipcRenderer.invoke('remote-control:list-channels'),

    /** Update remote control settings */
    updateSettings: (requireConfirm: boolean) =>
      ipcRenderer.invoke('remote-control:update-settings', { requireConfirm }),
  },
}

// Use `contextBridge` APIs to expose Electron APIs to renderer
// contextIsolation is always enabled in this project
contextBridge.exposeInMainWorld('electron', electronAPI)
contextBridge.exposeInMainWorld('api', api)
