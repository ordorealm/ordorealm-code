/**
 * MCP IPC Handlers - MCP IPC 处理器
 *
 * 处理渲染进程与主进程之间的 MCP 相关通信
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '@shared/index'
import type {
  MCPDefinition,
  MCPInstance,
  MCPStats,
  MCPStatus
} from './mcp/types'
import { getMCPManager, MCPManager } from './mcp/manager'

/**
 * MCP IPC 响应类型
 */
export interface MCPListResponse {
  definitions: MCPDefinition[]
}

export interface MCPInstancesResponse {
  instances: Record<string, MCPInstance>
}

export interface MCPStatsResponse {
  stats: MCPStats
}

export interface MCPDownloadProgressEvent {
  id: string
  progress: number
  file: string
}

export interface MCPStatusChangeEvent {
  id: string
  status: MCPStatus
}

export interface MCPOutputEvent {
  id: string
  stdout: string
  stderr: string
}

/**
 * 校验 MCP ID 格式（防止注入攻击）
 */
function validateMCPId(id: unknown): string {
  if (typeof id !== 'string') {
    throw new Error('Invalid MCP ID: must be string')
  }
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid MCP ID: invalid characters in "${id}"`)
  }
  if (id.length > 64) {
    throw new Error('Invalid MCP ID: too long')
  }
  return id
}

/**
 * 安全发送事件到主窗口
 */
function safeSendToMainWindow(
  channel: string,
  data: unknown
): void {
  const windows = BrowserWindow.getAllWindows()
  if (windows.length === 0) return

  const mainWindow = windows[0]
  if (mainWindow.isDestroyed()) return

  try {
    mainWindow.webContents.send(channel, data)
  } catch (err) {
    console.error('[MCP IPC] Failed to send event:', err)
  }
}

/**
 * 注册 MCP IPC 处理器
 */
export function registerMCPIPCHandlers(): void {
  const manager = getMCPManager()

  // 获取 MCP 列表
  ipcMain.handle(IPC_CHANNELS.MCP_LIST, async (): Promise<MCPListResponse> => {
    const definitions = manager.getDefinitions()
    return { definitions }
  })

  // 获取 MCP 实例
  ipcMain.handle(IPC_CHANNELS.MCP_INSTANCES, async (): Promise<MCPInstancesResponse> => {
    const instancesMap = manager.getInstances()
    const instances: Record<string, MCPInstance> = {}

    for (const [id, instance] of instancesMap) {
      instances[id] = {
        ...instance,
        // 不传递进程句柄到渲染进程
        process: undefined
      }
    }

    return { instances }
  })

  // 启用 MCP
  ipcMain.handle(IPC_CHANNELS.MCP_ENABLE, async (_, id: unknown): Promise<void> => {
    const validId = validateMCPId(id)
    await manager.enable(validId)
  })

  // 禁用 MCP
  ipcMain.handle(IPC_CHANNELS.MCP_DISABLE, async (_, id: unknown): Promise<void> => {
    const validId = validateMCPId(id)
    await manager.disable(validId)
  })

  // 启动 MCP
  ipcMain.handle(IPC_CHANNELS.MCP_START, async (_, id: unknown): Promise<void> => {
    const validId = validateMCPId(id)
    await manager.start(validId)
  })

  // 停止 MCP
  ipcMain.handle(IPC_CHANNELS.MCP_STOP, async (_, id: unknown): Promise<void> => {
    const validId = validateMCPId(id)
    await manager.stop(validId)
  })

  // 重启 MCP
  ipcMain.handle(IPC_CHANNELS.MCP_RESTART, async (_, id: unknown): Promise<void> => {
    const validId = validateMCPId(id)
    await manager.restart(validId)
  })

  // 获取统计信息
  ipcMain.handle(IPC_CHANNELS.MCP_STATS, async (): Promise<MCPStatsResponse> => {
    const stats = manager.getStats()
    return { stats }
  })

  // 下载 MCP
  ipcMain.handle(IPC_CHANNELS.MCP_DOWNLOAD, async (_, id: unknown): Promise<void> => {
    const validId = validateMCPId(id)
    await manager.download(validId)
  })

  console.log('[MCP IPC] 处理器已注册')
}

/**
 * 设置 MCP 事件回调
 * 将 MCP 事件推送到渲染进程
 */
export function setupMCPEventForwarding(): void {
  const manager = getMCPManager()

  manager.setCallbacks({
    // 状态变更回调
    onStatusChange: (id: string, status: MCPStatus) => {
      const event: MCPStatusChangeEvent = { id, status }
      safeSendToMainWindow(IPC_CHANNELS.MCP_STATUS_CHANGE, event)
    },

    // 下载进度回调
    onDownloadProgress: (id: string, progress: number, file: string) => {
      const event: MCPDownloadProgressEvent = { id, progress, file }
      safeSendToMainWindow(IPC_CHANNELS.MCP_DOWNLOAD_PROGRESS, event)
    }
  })

  console.log('[MCP IPC] 事件转发已设置')
}

/**
 * 取消注册 MCP IPC 处理器
 */
export function unregisterMCPIPCHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.MCP_LIST)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_INSTANCES)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_ENABLE)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_DISABLE)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_START)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_STOP)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_RESTART)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_STATS)
  ipcMain.removeHandler(IPC_CHANNELS.MCP_DOWNLOAD)

  console.log('[MCP IPC] 处理器已取消注册')
}

/**
 * 初始化 MCP IPC 系统
 */
export async function initializeMCPIPC(): Promise<MCPManager> {
  // 注册 IPC 处理器
  registerMCPIPCHandlers()

  // 设置事件转发
  setupMCPEventForwarding()

  // 初始化 MCP Manager
  const manager = getMCPManager()
  await manager.initialize()

  return manager
}
