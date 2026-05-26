/**
 * MCP Manager Store
 * @module stores/mcp-store
 *
 * 管理 MCP 的状态、下载、启动和停止
 */

import { create } from 'zustand'

/**
 * MCP 分类
 */
export type MCPCategory = 'query' | 'browser' | 'desktop' | 'memory' | 'debug'

/**
 * MCP 下载状态
 */
export type DownloadStatus =
  | 'not_downloaded'
  | 'downloading'
  | 'downloaded'
  | 'download_failed'
  | 'extracting'
  | 'ready'

/**
 * MCP 运行状态
 */
export type MCPStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * MCP 定义（从主进程获取）
 */
export interface MCPDefinition {
  id: string
  name: string
  description: string
  category: MCPCategory
  packageName: string
  version: string
  platforms: string[]
  builtin: boolean
  defaultEnabled: boolean
  downloadSize: number
  runtimeSize: number
  mirrors?: MCPMirror[]
  dependencies?: string[]
  permissions?: PermissionInstructions
  argsTemplate?: string[]
  envTemplate?: Record<string, string>
  runtimeDependencies?: RuntimeDependency[]
}

/**
 * 镜像源配置
 */
export interface MCPMirror {
  name: string
  url: string
  region: 'cn' | 'global'
  priority: number
}

/**
 * 运行时依赖
 */
export interface RuntimeDependency {
  id: string
  name: string
  downloadSize: number
  downloadUrl: string
  mirrors?: MCPMirror[]
}

/**
 * 权限要求说明
 */
export interface PermissionInstructions {
  macos?: {
    type: 'accessibility' | 'screen_recording' | 'full_disk_access' | 'automation'
    instruction: string
    settingsPath: string
  }
  windows?: {
    type: 'admin' | 'ui_access'
    instruction: string
  }
}

/**
 * MCP 实例状态
 */
export interface MCPInstance {
  id: string
  status: MCPStatus
  downloadStatus: DownloadStatus
  installPath?: string
  pid?: number
  startTime?: number
  error?: string
  downloadProgress?: number
  downloadingFile?: string
  toolsUsed?: string[]
  lastActivity?: number
}

/**
 * MCP 统计信息
 */
export interface MCPStats {
  total: number
  enabled: number
  running: number
  totalDownloadSize: number
  downloadedSize: number
}

/**
 * MCP Store 状态
 */
interface MCPState {
  /** 所有 MCP 定义 */
  definitions: MCPDefinition[]
  /** MCP 实例状态 */
  instances: Record<string, MCPInstance>
  /** 统计信息 */
  stats: MCPStats
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
  /** 是否已初始化 */
  initialized: boolean
  /** 事件监听清理函数 */
  cleanupFns: Array<() => void>
}

/**
 * MCP Store 操作
 */
interface MCPActions {
  /** 加载 MCP 列表 */
  loadDefinitions: () => Promise<void>
  /** 加载实例状态 */
  loadInstances: () => Promise<void>
  /** 加载统计信息 */
  loadStats: () => Promise<void>
  /** 刷新所有数据 */
  refresh: () => Promise<void>
  /** 启用 MCP */
  enable: (id: string) => Promise<void>
  /** 禁用 MCP */
  disable: (id: string) => Promise<void>
  /** 启动 MCP */
  start: (id: string) => Promise<void>
  /** 停止 MCP */
  stop: (id: string) => Promise<void>
  /** 重启 MCP */
  restart: (id: string) => Promise<void>
  /** 下载 MCP */
  download: (id: string) => Promise<void>
  /** 更新实例状态（内部使用） */
  updateInstance: (id: string, updates: Partial<MCPInstance>) => void
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
  /** 设置错误 */
  setError: (error: string | null) => void
  /** 初始化（设置事件监听） */
  initialize: () => void
  /** 清理事件监听 */
  cleanup: () => void
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
}

/**
 * 获取分类显示名称
 */
export function getCategoryName(category: MCPCategory): string {
  const names: Record<MCPCategory, string> = {
    query: '查询',
    browser: '浏览器',
    desktop: '桌面',
    memory: '记忆',
    debug: '调试'
  }
  return names[category]
}

/**
 * 获取状态显示名称
 */
export function getStatusName(status: MCPStatus): string {
  const names: Record<MCPStatus, string> = {
    stopped: '已停止',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    error: '错误'
  }
  return names[status]
}

/**
 * 获取下载状态显示名称
 */
export function getDownloadStatusName(status: DownloadStatus): string {
  const names: Record<DownloadStatus, string> = {
    not_downloaded: '未下载',
    downloading: '下载中',
    downloaded: '已下载',
    download_failed: '下载失败',
    extracting: '解压中',
    ready: '就绪'
  }
  return names[status]
}

/**
 * MCP Store
 */
export const useMCPStore = create<MCPState & MCPActions>((set, get) => ({
  // 初始状态
  definitions: [],
  instances: {},
  stats: {
    total: 0,
    enabled: 0,
    running: 0,
    totalDownloadSize: 0,
    downloadedSize: 0
  },
  isLoading: false,
  error: null,
  initialized: false,
  cleanupFns: [],

  // 操作
  loadDefinitions: async () => {
    try {
      const result = await window.api.mcp.list()
      set({ definitions: result.definitions })
    } catch (err) {
      console.error('[MCP Store] 加载定义失败:', err)
      set({ error: String(err) })
    }
  },

  loadInstances: async () => {
    try {
      const result = await window.api.mcp.instances()
      set({ instances: result.instances })
    } catch (err) {
      console.error('[MCP Store] 加载实例失败:', err)
      set({ error: String(err) })
    }
  },

  loadStats: async () => {
    try {
      const result = await window.api.mcp.stats()
      set({ stats: result.stats })
    } catch (err) {
      console.error('[MCP Store] 加载统计失败:', err)
    }
  },

  refresh: async () => {
    const { loadDefinitions, loadInstances, loadStats } = get()
    set({ isLoading: true, error: null })

    try {
      await Promise.all([
        loadDefinitions(),
        loadInstances(),
        loadStats()
      ])
    } catch (err) {
      set({ error: String(err) })
    } finally {
      set({ isLoading: false })
    }
  },

  enable: async (id: string) => {
    try {
      await window.api.mcp.enable(id)
      await get().loadInstances()
      await get().loadStats()
    } catch (err) {
      console.error(`[MCP Store] 启用 ${id} 失败:`, err)
      set({ error: String(err) })
      throw err
    }
  },

  disable: async (id: string) => {
    try {
      await window.api.mcp.disable(id)
      await get().loadInstances()
      await get().loadStats()
    } catch (err) {
      console.error(`[MCP Store] 禁用 ${id} 失败:`, err)
      set({ error: String(err) })
      throw err
    }
  },

  start: async (id: string) => {
    const { updateInstance } = get()
    updateInstance(id, { status: 'starting' })

    try {
      await window.api.mcp.start(id)
      updateInstance(id, { status: 'running' })
    } catch (err) {
      console.error(`[MCP Store] 启动 ${id} 失败:`, err)
      updateInstance(id, { status: 'error', error: String(err) })
      throw err
    }
  },

  stop: async (id: string) => {
    const { updateInstance } = get()
    updateInstance(id, { status: 'stopping' })

    try {
      await window.api.mcp.stop(id)
      updateInstance(id, { status: 'stopped' })
    } catch (err) {
      console.error(`[MCP Store] 停止 ${id} 失败:`, err)
      updateInstance(id, { status: 'error', error: String(err) })
      throw err
    }
  },

  restart: async (id: string) => {
    try {
      await window.api.mcp.restart(id)
      await get().loadInstances()
    } catch (err) {
      console.error(`[MCP Store] 重启 ${id} 失败:`, err)
      set({ error: String(err) })
      throw err
    }
  },

  download: async (id: string) => {
    const { updateInstance } = get()
    updateInstance(id, { downloadStatus: 'downloading', downloadProgress: 0 })

    try {
      await window.api.mcp.download(id)
      updateInstance(id, { downloadStatus: 'ready', downloadProgress: 100 })
    } catch (err) {
      console.error(`[MCP Store] 下载 ${id} 失败:`, err)
      updateInstance(id, { downloadStatus: 'download_failed', error: String(err) })
      throw err
    }
  },

  updateInstance: (id: string, updates: Partial<MCPInstance>) => {
    set((state) => ({
      instances: {
        ...state.instances,
        [id]: {
          ...state.instances[id],
          ...updates
        }
      }
    }))
  },

  setLoading: (loading: boolean) => set({ isLoading: loading }),

  setError: (error: string | null) => set({ error }),

  initialize: () => {
    const state = get()
    if (state.initialized) return

    const cleanupFns: Array<() => void> = []

    // 设置下载进度监听
    cleanupFns.push(
      window.api.mcp.onDownloadProgress(
        (event: { id: string; progress: number; file: string }) => {
          const { updateInstance } = get()
          updateInstance(event.id, {
            downloadProgress: event.progress,
            downloadingFile: event.file
          })
        }
      )
    )

    // 设置状态变更监听
    cleanupFns.push(
      window.api.mcp.onStatusChange(
        (event: { id: string; status: string }) => {
          const { updateInstance } = get()
          updateInstance(event.id, { status: event.status as MCPStatus })
        }
      )
    )

    // 初始加载
    get().refresh()

    set({
      initialized: true,
      cleanupFns
    })

    console.log('[MCP Store] 已初始化')
  },

  cleanup: () => {
    const { cleanupFns } = get()
    cleanupFns.forEach(fn => fn())
    set({ initialized: false, cleanupFns: [] })
    console.log('[MCP Store] 已清理')
  }
}))

/**
 * 获取 MCP 定义
 */
export function getMCPDefinition(id: string): MCPDefinition | undefined {
  return useMCPStore.getState().definitions.find(d => d.id === id)
}

/**
 * 获取 MCP 实例
 */
export function getMCPInstance(id: string): MCPInstance | undefined {
  return useMCPStore.getState().instances[id]
}

/**
 * 检查 MCP 是否正在运行
 */
export function isMCPRunning(id: string): boolean {
  const instance = useMCPStore.getState().instances[id]
  return instance?.status === 'running'
}

/**
 * 检查 MCP 是否已下载
 */
export function isMCPDownloaded(id: string): boolean {
  const instance = useMCPStore.getState().instances[id]
  return instance?.downloadStatus === 'ready'
}
