/**
 * MCP Manager - MCP 管理器
 *
 * 协调 Registry、Downloader、Launcher，提供统一的 MCP 管理接口
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { ChildProcess } from 'child_process'

import type {
  MCPDefinition,
  MCPInstance,
  MCPManagerInterface,
  MCPStats,
  MCPStatus,
  DownloadStatus,
  MCPConfig
} from './types'
import { getMCPRegistry, MCPRegistry } from './registry'
import { getMCPDownloader, MCPDownloader, type ProgressCallback } from './downloader'
import { getMCPLauncher, MCPLauncher } from './launcher'
import { getMCPConnector } from './connector'

/**
 * MCP Manager 配置
 */
export interface MCPManagerConfig {
  /** 配置文件路径 */
  configPath?: string
  /** 是否自动启动默认 MCP */
  autoStartDefaults?: boolean
  /** 是否启用详细日志 */
  verbose?: boolean
}

/**
 * 状态变更回调
 */
export type StatusChangeCallback = (id: string, status: MCPStatus) => void

/**
 * 下载进度回调
 */
export type DownloadProgressCallback = (id: string, progress: number, file: string) => void

/**
 * MCP Manager 实现
 */
export class MCPManager implements MCPManagerInterface {
  private registry: MCPRegistry
  private downloader: MCPDownloader
  private launcher: MCPLauncher
  private instances: Map<string, MCPInstance> = new Map()
  private config: MCPConfig
  private configPath: string
  private verbose: boolean
  private autoStartDefaults: boolean

  /** 操作锁：防止并发操作同一个 MCP */
  private operationLocks: Map<string, Promise<void>> = new Map()

  /** 退出标志：防止 before-quit 循环 */
  private isShuttingDown: boolean = false

  // 回调
  private onStatusChange?: StatusChangeCallback
  private onDownloadProgress?: DownloadProgressCallback

  constructor(config: MCPManagerConfig = {}) {
    this.registry = getMCPRegistry()
    this.downloader = getMCPDownloader()
    this.launcher = getMCPLauncher()

    this.configPath = config.configPath || path.join(
      app.getPath('userData'),
      'mcp-config.json'
    )
    this.verbose = config.verbose ?? false
    this.autoStartDefaults = config.autoStartDefaults ?? false

    // 加载配置
    this.config = this.loadConfig()

    // 初始化实例状态
    this.initializeInstances()

    // 注册应用退出时的清理
    // 注意：will-quit 不支持异步，使用 before-quit 并阻止默认退出
    app.on('before-quit', (event) => {
      // 防止循环：如果已经在关闭中，直接返回
      if (this.isShuttingDown) {
        return
      }

      const hasRunning = Array.from(this.instances.values())
        .some(i => i.status === 'running')
      if (hasRunning) {
        event.preventDefault()
        this.isShuttingDown = true
        this.shutdown().then(() => {
          app.quit()
        }).catch(() => {
          app.quit()
        })
      }
    })
  }

  /**
   * 加载配置（带损坏文件备份，异步安全）
   */
  private loadConfig(): MCPConfig {
    try {
      const content = fs.readFileSync(this.configPath, 'utf-8')
      const parsed = JSON.parse(content)

      // 基本校验配置结构
      if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.enabledMCPs)) {
        return parsed as MCPConfig
      }

      // 结构不合法，视为损坏
      throw new Error('Invalid config structure')
    } catch (err) {
      const errorCode = (err as NodeJS.ErrnoException).code

      if (errorCode === 'ENOENT') {
        // 文件不存在 - 创建默认配置
        const defaults = this.registry.getDefaults()
        return {
          enabledMCPs: defaults.map(d => d.id),
          preferredMirror: 'auto'
        }
      }

      // 配置文件损坏 - 备份并创建新配置
      console.warn('[MCP Manager] 配置文件损坏，创建备份:', err)
      const backupPath = `${this.configPath}.backup-${Date.now()}`
      try {
        fs.renameSync(this.configPath, backupPath)
        console.log(`[MCP Manager] 损坏配置已备份到: ${backupPath}`)
      } catch {
        // 重命名失败，直接删除
        try {
          fs.unlinkSync(this.configPath)
        } catch {
          // ignore
        }
      }

      const defaults = this.registry.getDefaults()
      return {
        enabledMCPs: defaults.map(d => d.id),
        preferredMirror: 'auto'
      }
    }
  }

  /**
   * 保存配置（原子写入：先写临时文件再重命名，防止写入中断导致损坏）
   */
  private saveConfig(): void {
    try {
      const tempPath = `${this.configPath}.tmp`
      const data = JSON.stringify(this.config, null, 2)

      // 写入临时文件
      fs.writeFileSync(tempPath, data, 'utf-8')

      // 原子重命名（在大多数文件系统上是原子操作）
      fs.renameSync(tempPath, this.configPath)
    } catch (err) {
      console.error('[MCP Manager] 保存配置失败:', err)

      // 清理临时文件
      try {
        fs.unlinkSync(`${this.configPath}.tmp`)
      } catch {
        // ignore
      }
    }
  }

  /**
   * 初始化实例状态
   */
  private initializeInstances(): void {
    const definitions = this.registry.getForCurrentPlatform()

    for (const def of definitions) {
      const instance: MCPInstance = {
        id: def.id,
        status: 'stopped',
        downloadStatus: 'not_downloaded',
        toolsUsed: [],
        lastActivity: Date.now()
      }
      this.instances.set(def.id, instance)
    }
  }

  /**
   * 设置回调
   */
  setCallbacks(callbacks: {
    onStatusChange?: StatusChangeCallback
    onDownloadProgress?: DownloadProgressCallback
  }): void {
    this.onStatusChange = callbacks.onStatusChange
    this.onDownloadProgress = callbacks.onDownloadProgress
  }

  /**
   * 更新实例状态
   */
  private updateStatus(id: string, status: MCPStatus): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.status = status
      instance.lastActivity = Date.now()
      this.onStatusChange?.(id, status)
    }
  }

  /**
   * 更新下载状态
   */
  private updateDownloadStatus(id: string, status: DownloadStatus): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.downloadStatus = status
    }
  }

  /**
   * 等待当前操作完成
   */
  private async waitForOperation(id: string): Promise<void> {
    const pending = this.operationLocks.get(id)
    if (pending) {
      await pending
    }
  }

  /**
   * 初始化 MCP 系统
   */
  async initialize(): Promise<void> {
    console.log('[MCP Manager] 初始化...')

    // 检查已下载的 MCP
    for (const [id, instance] of this.instances) {
      const definition = this.registry.getById(id)
      if (definition) {
        const isDownloaded = await this.downloader.isDownloaded(definition)
        instance.downloadStatus = isDownloaded ? 'ready' : 'not_downloaded'
      }
    }

    // 自动恢复上次运行中的 MCP
    const runningMCPs = this.config.runningMCPs || []
    if (runningMCPs.length > 0) {
      console.log(`[MCP Manager] 自动恢复 ${runningMCPs.length} 个 MCP...`)
      for (const id of runningMCPs) {
        // 只恢复已下载且已启用的 MCP
        const instance = this.instances.get(id)
        if (instance && instance.downloadStatus === 'ready' && this.isEnabled(id)) {
          try {
            await this.start(id)
            console.log(`[MCP Manager] 已恢复 ${id}`)
          } catch (err) {
            console.error(`[MCP Manager] 恢复 ${id} 失败:`, err)
          }
        }
      }
    } else if (this.autoStartDefaults) {
      // 如果没有保存的运行状态，则自动启动默认 MCP
      for (const id of this.config.enabledMCPs) {
        try {
          await this.start(id)
        } catch (err) {
          console.error(`[MCP Manager] 自动启动 ${id} 失败:`, err)
        }
      }
    }

    console.log('[MCP Manager] 初始化完成')
  }

  /**
   * 保存当前运行状态
   */
  private saveRunningState(): void {
    const runningMCPs: string[] = []
    for (const [id, instance] of this.instances) {
      if (instance.status === 'running') {
        runningMCPs.push(id)
      }
    }
    this.config.runningMCPs = runningMCPs
    this.saveConfig()
  }

  /**
   * 获取所有 MCP 定义
   */
  getDefinitions(): MCPDefinition[] {
    return this.registry.getForCurrentPlatform()
  }

  /**
   * 获取所有实例
   */
  getInstances(): Map<string, MCPInstance> {
    return this.instances
  }

  /**
   * 获取单个实例
   */
  getInstance(id: string): MCPInstance | undefined {
    return this.instances.get(id)
  }

  /**
   * 检查 MCP 是否启用
   */
  isEnabled(id: string): boolean {
    return this.config.enabledMCPs.includes(id)
  }

  /**
   * 启用 MCP
   */
  async enable(id: string): Promise<void> {
    const definition = this.registry.getById(id)
    if (!definition) {
      throw new Error(`MCP ${id} 不存在`)
    }

    // 添加到启用列表
    if (!this.config.enabledMCPs.includes(id)) {
      this.config.enabledMCPs.push(id)
      this.saveConfig()
    }

    if (this.verbose) {
      console.log(`[MCP Manager] 启用 ${id}`)
    }
  }

  /**
   * 禁用 MCP
   */
  async disable(id: string): Promise<void> {
    // 先停止
    const instance = this.instances.get(id)
    if (instance && instance.status === 'running') {
      await this.stop(id)
    }

    // 从启用列表移除
    const index = this.config.enabledMCPs.indexOf(id)
    if (index >= 0) {
      this.config.enabledMCPs.splice(index, 1)
      this.saveConfig()
    }

    if (this.verbose) {
      console.log(`[MCP Manager] 禁用 ${id}`)
    }
  }

  /**
   * 下载 MCP（带操作锁）
   */
  async download(id: string): Promise<void> {
    // 等待当前操作
    await this.waitForOperation(id)

    const definition = this.registry.getById(id)
    if (!definition) {
      throw new Error(`MCP ${id} 不存在`)
    }

    const instance = this.instances.get(id)
    if (!instance) {
      throw new Error(`实例 ${id} 不存在`)
    }

    // 检查是否已下载
    if (instance.downloadStatus === 'ready') {
      return
    }

    // 创建操作锁
    const operation = this._doDownload(id, definition, instance)
    this.operationLocks.set(id, operation)

    try {
      await operation
    } finally {
      this.operationLocks.delete(id)
    }
  }

  private async _doDownload(
    id: string,
    definition: MCPDefinition,
    instance: MCPInstance
  ): Promise<void> {
    this.updateDownloadStatus(id, 'downloading')

    try {
      // 下载进度回调 - 将各阶段映射到整体进度
      // 阶段划分：
      //   0-40%: 下载 tarball
      //  40-70%: 安装 npm 依赖
      //  70-100%: 下载运行时依赖（如 Chromium）
      const hasRuntimeDeps = definition.runtimeDependencies && definition.runtimeDependencies.length > 0

      const onDownloadProgress: ProgressCallback = (progress, file, status) => {
        // 下载阶段: 0-40%
        const mappedProgress = Math.round(progress * 0.4)
        instance.downloadProgress = mappedProgress
        instance.downloadingFile = file
        this.onDownloadProgress?.(id, mappedProgress, file)
      }

      const onInstallProgress: ProgressCallback = (progress, file, status) => {
        // 安装依赖阶段: 40-70%
        const mappedProgress = 40 + Math.round(progress * 0.3)
        instance.downloadProgress = Math.min(mappedProgress, 69)
        instance.downloadingFile = file
        this.onDownloadProgress?.(id, Math.min(mappedProgress, 69), file)
      }

      const onRuntimeProgress: ProgressCallback = (progress, file, status) => {
        // 运行时依赖阶段: 70-100%
        const mappedProgress = 70 + Math.round(progress * 0.3)
        instance.downloadProgress = Math.min(mappedProgress, 99)
        instance.downloadingFile = file
        this.onDownloadProgress?.(id, Math.min(mappedProgress, 99), file)
      }

      // 1. 下载包
      const installPath = await this.downloader.download(definition, onDownloadProgress)

      // 2. 安装依赖
      await this.downloader.installDependencies(definition, onInstallProgress)

      // 3. 下载运行时依赖
      if (hasRuntimeDeps) {
        await this.downloader.downloadRuntimeDependency(definition, onRuntimeProgress)
      }

      instance.installPath = installPath
      instance.downloadStatus = 'ready'
      instance.downloadProgress = 100
      this.onDownloadProgress?.(id, 100, definition.name)

      if (this.verbose) {
        console.log(`[MCP Manager] 下载 ${id} 完成`)
      }
    } catch (err) {
      instance.downloadStatus = 'download_failed'
      instance.error = String(err)
      throw err
    }
  }

  /**
   * 启动 MCP（带操作锁）
   */
  async start(id: string): Promise<void> {
    // 等待当前操作
    await this.waitForOperation(id)

    const definition = this.registry.getById(id)
    if (!definition) {
      throw new Error(`MCP ${id} 不存在`)
    }

    const instance = this.instances.get(id)
    if (!instance) {
      throw new Error(`实例 ${id} 不存在`)
    }

    // 检查是否已在运行
    if (instance.status === 'running') {
      return
    }

    // 创建操作锁
    const operation = this._doStart(id, definition, instance)
    this.operationLocks.set(id, operation)

    try {
      await operation
    } finally {
      this.operationLocks.delete(id)
    }
  }

  private async _doStart(
    id: string,
    definition: MCPDefinition,
    instance: MCPInstance
  ): Promise<void> {
    // 检查是否已下载
    if (instance.downloadStatus !== 'ready') {
      await this.download(id)
    }

    this.updateStatus(id, 'starting')

    try {
      const installPath =
        instance.installPath || this.downloader.getInstallPath(definition)

      console.log(`[MCP Manager] 启动 ${id}: installPath=${installPath}`)

      const proc = await this.launcher.launch(definition, installPath)

      instance.process = proc
      instance.pid = proc.pid
      instance.startTime = Date.now()
      instance.status = 'running'
      instance.error = undefined

      this.updateStatus(id, 'running')
      this.saveRunningState()

      // 清除 Connector 缓存，触发工具重新发现
      try {
        getMCPConnector().invalidateCache(id)
      } catch {
        // Connector 可能未初始化
      }

      // ★ 通知所有活跃会话更新 MCP 配置
      try {
        getMCPConnector().updateAllSessionsMcpConfig().catch((err: Error) => {
          console.warn('[MCP Manager] 更新活跃会话 MCP 配置失败:', err)
        })
      } catch {
        // Connector 可能未初始化
      }

      console.log(`[MCP Manager] 启动 ${id} 成功 (PID: ${proc.pid})`)
    } catch (err) {
      console.error(`[MCP Manager] 启动 ${id} 失败:`, err)
      instance.status = 'error'
      instance.error = String(err)
      this.updateStatus(id, 'error')
      throw err
    }
  }

  /**
   * 停止 MCP（带操作锁）
   */
  async stop(id: string, options?: { saveState?: boolean }): Promise<void> {
    // 等待当前操作
    await this.waitForOperation(id)

    const instance = this.instances.get(id)
    if (!instance) {
      return
    }

    if (instance.status !== 'running') {
      return
    }

    // 创建操作锁
    const operation = this._doStop(id, instance, options?.saveState !== false)
    this.operationLocks.set(id, operation)

    try {
      await operation
    } finally {
      this.operationLocks.delete(id)
    }
  }

  private async _doStop(id: string, instance: MCPInstance, saveState: boolean = true): Promise<void> {
    this.updateStatus(id, 'stopping')

    try {
      await this.launcher.stop(instance)

      instance.status = 'stopped'
      instance.process = undefined
      instance.pid = undefined
      instance.startTime = undefined

      this.updateStatus(id, 'stopped')

      // 清除 Connector 缓存
      try {
        getMCPConnector().invalidateCache(id)
      } catch {
        // Connector 可能未初始化
      }

      // ★ 通知所有活跃会话更新 MCP 配置
      try {
        getMCPConnector().updateAllSessionsMcpConfig().catch((err: Error) => {
          console.warn('[MCP Manager] 更新活跃会话 MCP 配置失败:', err)
        })
      } catch {
        // Connector 可能未初始化
      }

      // 只在用户手动停止时保存状态，shutdown 时不保存
      if (saveState) {
        this.saveRunningState()
      }

      console.log(`[MCP Manager] 停止 ${id} 成功`)
    } catch (err) {
      instance.status = 'error'
      instance.error = String(err)
      this.updateStatus(id, 'error')
      throw err
    }
  }

  /**
   * 重启 MCP
   */
  async restart(id: string): Promise<void> {
    await this.stop(id)
    await this.start(id)
  }

  /**
   * 获取统计信息
   */
  getStats(): MCPStats {
    const definitions = this.getDefinitions()
    const runningCount = Array.from(this.instances.values())
      .filter(i => i.status === 'running').length

    const totalDownloadSize = definitions.reduce(
      (sum, d) => sum + d.downloadSize,
      0
    )

    const downloadedSize = Array.from(this.instances.values())
      .filter(i => i.downloadStatus === 'ready')
      .reduce((sum, i) => {
        const def = this.registry.getById(i.id)
        return sum + (def?.downloadSize || 0)
      }, 0)

    return {
      total: definitions.length,
      enabled: this.config.enabledMCPs.length,
      running: runningCount,
      totalDownloadSize,
      downloadedSize
    }
  }

  /**
   * 关闭所有 MCP
   * 注意：不清空 runningMCPs，保留状态以便下次启动时自动恢复
   */
  async shutdown(): Promise<void> {
    console.log('[MCP Manager] 关闭所有 MCP...')

    const stopPromises: Promise<void>[] = []

    for (const [id, instance] of this.instances) {
      if (instance.status === 'running') {
        // saveState: false - 保留运行状态以便下次启动时恢复
        stopPromises.push(this.stop(id, { saveState: false }))
      }
    }

    await Promise.all(stopPromises)

    // 清理 launcher 资源
    await this.launcher.cleanup()

    console.log('[MCP Manager] 关闭完成')
  }

  /**
   * 获取 MCP 输出日志
   */
  getOutput(id: string): { stdout: string; stderr: string } | undefined {
    return this.launcher.getOutput(id)
  }

  /**
   * 设置镜像偏好
   */
  setMirrorPreference(preference: 'cn' | 'global' | 'auto'): void {
    this.config.preferredMirror = preference
    this.saveConfig()
    this.downloader.setMirrorPreference(preference)
  }

  /**
   * 获取配置
   */
  getConfig(): MCPConfig {
    return { ...this.config }
  }

  /**
   * 获取运行中的 MCP 列表（用于 Claude SDK）
   */
  getRunningMCPs(): { id: string; pid: number; process: ChildProcess }[] {
    const running: { id: string; pid: number; process: ChildProcess }[] = []

    for (const [id, instance] of this.instances) {
      if (instance.status === 'running' && instance.pid && instance.process) {
        running.push({
          id,
          pid: instance.pid,
          process: instance.process
        })
      }
    }

    return running
  }
}

// 单例实例
let managerInstance: MCPManager | null = null

/**
 * 获取 Manager 单例
 */
export function getMCPManager(config?: MCPManagerConfig): MCPManager {
  if (!managerInstance) {
    managerInstance = new MCPManager(config)
  }
  return managerInstance
}

/**
 * 初始化 MCP 系统
 */
export async function initializeMCP(config?: MCPManagerConfig): Promise<MCPManager> {
  const manager = getMCPManager(config)
  await manager.initialize()
  return manager
}

/**
 * 重置单例（用于测试）
 */
export function resetMCPManager(): void {
  if (managerInstance) {
    managerInstance.shutdown().catch(() => {})
  }
  managerInstance = null
}
