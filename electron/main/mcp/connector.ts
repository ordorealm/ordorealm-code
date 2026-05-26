/**
 * MCP Connector - MCP 连接器
 *
 * 连接到运行中的 MCP 进程，发现工具并转换为 Claude SDK 格式
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { ChildProcess } from 'child_process'
import type { MCPInstance, MCPDefinition } from './types'
import { getMCPManager } from './manager'
import { getMCPDownloader } from './downloader'

/**
 * MCP 工具定义（从 MCP 协议获取）
 */
export interface MCPTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description?: string
      enum?: string[]
      default?: any
    }>
    required?: string[]
  }
}

/**
 * Claude SDK 工具格式
 */
export interface ClaudeTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

/**
 * MCP 服务器配置（用于 Claude SDK）
 */
export interface MCPServerConfig {
  type: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  /** 确保工具总是被加载到提示中，不被延迟加载 */
  alwaysLoad?: boolean
}

/**
 * 获取活跃会话的回调类型
 */
type GetActiveSessionsCallback = () => Map<string, any>

/**
 * MCP 连接器
 * 负责将运行中的 MCP 暴露给 Claude SDK
 */
export class MCPConnector {
  private toolCache: Map<string, MCPTool[]> = new Map()
  private lastDiscoveryTime: Map<string, number> = new Map()
  private discoveryInterval: number = 60000 // 1分钟缓存
  /** 获取活跃会话的回调（由 index.ts 设置） */
  private getActiveSessionsCallback: GetActiveSessionsCallback | null = null

  /**
   * 设置获取活跃会话的回调
   */
  setGetActiveSessionsCallback(callback: GetActiveSessionsCallback): void {
    this.getActiveSessionsCallback = callback
  }

  /**
   * 获取所有运行中 MCP 的服务器配置
   * 用于传递给 Claude SDK 的 mcpServers 选项
   */
  getMCPServerConfigs(): Record<string, MCPServerConfig> {
    const manager = getMCPManager()
    const downloader = getMCPDownloader()
    const runningMCPs = manager.getRunningMCPs()
    const configs: Record<string, MCPServerConfig> = {}

    console.log('[MCP Connector] getMCPServerConfigs called')
    console.log('[MCP Connector] runningMCPs count:', runningMCPs.length)
    console.log('[MCP Connector] runningMCPs ids:', runningMCPs.map((m: any) => m.id))

    for (const { id } of runningMCPs) {
      const instance = manager.getInstance(id)
      const definition = manager.getDefinitions().find((d: MCPDefinition) => d.id === id)

      console.log(`[MCP Connector] Processing ${id}:`, {
        hasInstance: !!instance,
        hasDefinition: !!definition,
        instanceInstallPath: instance?.installPath,
        instanceStatus: instance?.status
      })

      if (!instance || !definition) continue

      // 获取安装路径：优先使用 instance.installPath，否则从 downloader 获取
      const installPath = instance.installPath || downloader.getInstallPath(definition)
      console.log(`[MCP Connector] ${id} installPath:`, installPath)

      if (!installPath) continue

      // 获取 MCP 的命令和参数
      const config = this.buildServerConfig(definition, installPath)
      console.log(`[MCP Connector] ${id} config:`, config ? 'built' : 'null')
      if (config) {
        configs[id] = config
      }
    }

    console.log('[MCP Connector] Final configs count:', Object.keys(configs).length)
    console.log('[MCP Connector] Final configs keys:', Object.keys(configs))
    return configs
  }

  /**
   * 构建 MCP 服务器配置
   */
  private buildServerConfig(
    definition: MCPDefinition,
    installPath: string
  ): MCPServerConfig | null {
    // 获取入口文件
    const entryPoint = this.getEntryPoint(definition, installPath)
    if (!entryPoint) return null

    // 使用 Node.js 运行 MCP
    const nodePath = this.getNodePath()

    // 构建环境变量
    const env: Record<string, string> = {
      ...definition.envTemplate,
      NODE_ENV: 'production'
    }

    // ★ open-websearch 默认启动 HTTP 服务器（端口 3000），
    // 容易与本地开发服务器冲突导致进程崩溃。
    // 强制使用 STDIO 模式，避免端口冲突。
    if (definition.id === 'open-websearch') {
      env.MODE = 'stdio'
    }

    return {
      type: 'stdio',
      command: nodePath,
      args: [entryPoint, ...(definition.argsTemplate || [])],
      env,
      // ★ 确保工具总是被加载到提示中，不被延迟加载
      // 这样 AI 在第一轮对话时就能看到所有 MCP 工具
      alwaysLoad: true
    }
  }

  /**
   * 获取 MCP 入口文件路径
   */
  private getEntryPoint(definition: MCPDefinition, installPath: string): string | null {
    // 尝试读取 package.json 获取入口
    const packageJsonPath = path.join(installPath, 'package.json')

    try {
      const content = fs.readFileSync(packageJsonPath, 'utf-8')
      const pkg = JSON.parse(content)

      // 检查 bin 字段
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') {
          return path.join(installPath, pkg.bin)
        } else if (typeof pkg.bin === 'object') {
          const binName = Object.keys(pkg.bin)[0]
          return path.join(installPath, pkg.bin[binName])
        }
      }

      // 检查 main 字段
      if (pkg.main) {
        return path.join(installPath, pkg.main)
      }
    } catch {
      // ignore
    }

    // 默认入口
    const defaultEntry = path.join(installPath, 'index.js')
    if (fs.existsSync(defaultEntry)) {
      return defaultEntry
    }

    return null
  }

  /**
   * 获取 Node.js 可执行文件路径
   */
  private getNodePath(): string {
    // 优先使用用户数据目录中的运行时
    const userDataNode = path.join(
      app.getPath('userData'),
      'runtime',
      'node',
      `${process.platform}-${process.arch}`,
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node'
    )

    if (fs.existsSync(userDataNode)) {
      return userDataNode
    }

    // 回退到系统 Node.js
    return 'node'
  }

  /**
   * 通过 MCP 协议发现工具
   * 注意：这需要与 MCP 进程通信，可能较慢
   */
  async discoverTools(mcpId: string): Promise<MCPTool[]> {
    // 检查缓存
    const lastTime = this.lastDiscoveryTime.get(mcpId) || 0
    if (Date.now() - lastTime < this.discoveryInterval) {
      return this.toolCache.get(mcpId) || []
    }

    // 延迟导入避免循环依赖
    const { getMCPManager } = require('./manager')
    const manager = getMCPManager()
    const instance = manager.getInstance(mcpId)

    if (!instance || instance.status !== 'running' || !instance.process) {
      return []
    }

    try {
      const tools = await this.requestToolsList(instance.process)
      this.toolCache.set(mcpId, tools)
      this.lastDiscoveryTime.set(mcpId, Date.now())
      return tools
    } catch (err) {
      console.error(`[MCP Connector] 发现工具失败 (${mcpId}):`, err)
      return this.toolCache.get(mcpId) || []
    }
  }

  /**
   * 向 MCP 进程请求工具列表
   * 注意：由于 launcher 已监听 stdout，这里使用独立的数据收集方式
   */
  private async requestToolsList(proc: ChildProcess): Promise<MCPTool[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('工具发现超时'))
      }, 5000)

      let buffer = ''

      const onData = (data: Buffer) => {
        buffer += data.toString()
        // 尝试解析完整的 JSON 响应
        try {
          // MCP 可能返回多行，找包含 tools/list 响应的那行
          const lines = buffer.split('\n')
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const response = JSON.parse(line)
              if (response.result?.tools) {
                cleanup()
                resolve(response.result.tools)
                return
              }
            } catch {
              // 继续尝试下一行
            }
          }
        } catch {
          // 继续等待更多数据
        }
      }

      const cleanup = () => {
        clearTimeout(timeout)
        proc.stdout?.off('data', onData)
      }

      proc.stdout?.on('data', onData)

      // MCP 协议: tools/list 请求
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(), // 使用时间戳作为唯一 ID
        method: 'tools/list',
        params: {}
      }) + '\n'

      proc.stdin?.write(request)
    })
  }

  /**
   * 获取所有运行中 MCP 的工具（Claude SDK 格式）
   */
  async getAllTools(): Promise<ClaudeTool[]> {
    // 延迟导入避免循环依赖
    const { getMCPManager } = require('./manager')
    const manager = getMCPManager()
    const runningMCPs = manager.getRunningMCPs()
    const allTools: ClaudeTool[] = []

    for (const { id } of runningMCPs) {
      const mcpTools = await this.discoverTools(id)
      for (const tool of mcpTools) {
        allTools.push(this.convertToClaudeTool(tool))
      }
    }

    return allTools
  }

  /**
   * 转换 MCP 工具为 Claude SDK 格式
   */
  convertToClaudeTool(mcpTool: MCPTool): ClaudeTool {
    return {
      name: mcpTool.name,
      description: mcpTool.description,
      input_schema: mcpTool.inputSchema
    }
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.toolCache.clear()
    this.lastDiscoveryTime.clear()
  }

  /**
   * 清除指定 MCP 的缓存
   */
  invalidateCache(mcpId: string): void {
    this.toolCache.delete(mcpId)
    this.lastDiscoveryTime.delete(mcpId)
  }

  /**
   * 更新所有活跃会话的 MCP 配置
   * 当 MCP 启动/停止时调用，使用 SDK 的 setMcpServers API 动态更新
   */
  async updateAllSessionsMcpConfig(): Promise<void> {
    if (!this.getActiveSessionsCallback) {
      console.log('[MCP Connector] getActiveSessionsCallback 未设置，跳过 MCP 配置更新')
      return
    }

    const activeSessions = this.getActiveSessionsCallback()
    if (!activeSessions || activeSessions.size === 0) {
      console.log('[MCP Connector] 没有活跃会话，跳过 MCP 配置更新')
      return
    }

    // 获取当前内置 MCP 配置
    const builtinMcpServers = this.getMCPServerConfigs()
    console.log('[MCP Connector] 更新活跃会话的 MCP 配置:', Object.keys(builtinMcpServers))

    // 读取全局 MCP 配置
    let globalMcpServers: Record<string, any> = {}
    try {
      const claudeJsonPath = path.join(app.getPath('home'), '.claude.json')
      const claudeJsonContent = fs.readFileSync(claudeJsonPath, 'utf-8')
      const claudeJson = JSON.parse(claudeJsonContent)
      globalMcpServers = claudeJson.mcpServers || {}
    } catch {}

    // 合并配置
    const mergedConfig = {
      ...globalMcpServers,
      ...builtinMcpServers
    }

    // 更新每个活跃会话
    let updatedCount = 0
    for (const [sessionId, session] of activeSessions) {
      try {
        const sdkQuery = session.sdkQuery
        if (sdkQuery && typeof sdkQuery.setMcpServers === 'function') {
          await sdkQuery.setMcpServers(mergedConfig)
          session.mcpConfigSnapshot = mergedConfig
          updatedCount++
          console.log(`[MCP Connector] 已更新会话 ${sessionId} 的 MCP 配置`)
        } else {
          console.log(`[MCP Connector] 会话 ${sessionId} 不支持 setMcpServers`)
        }
      } catch (err) {
        console.warn(`[MCP Connector] 更新会话 ${sessionId} 失败:`, err)
      }
    }

    console.log(`[MCP Connector] 共更新 ${updatedCount} 个会话的 MCP 配置`)
  }
}

// 单例实例
let connectorInstance: MCPConnector | null = null

/**
 * 获取 Connector 单例
 */
export function getMCPConnector(): MCPConnector {
  if (!connectorInstance) {
    connectorInstance = new MCPConnector()
  }
  return connectorInstance
}

/**
 * 重置单例（用于测试）
 */
export function resetMCPConnector(): void {
  connectorInstance = null
}
