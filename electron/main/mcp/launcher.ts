/**
 * MCP Launcher - MCP 启动器
 *
 * 负责启动和停止 MCP 进程
 */

import { app } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'
import fs from 'fs'
import type { MCPDefinition, MCPInstance, MCPLauncherInterface, MCPStatus } from './types'

/**
 * 校验 MCP ID 格式
 */
function validateMCPId(id: string): void {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid MCP ID: ${id}`)
  }
  if (id.length > 64) {
    throw new Error(`MCP ID too long: ${id}`)
  }
}

/**
 * 获取运行时目标目录名
 * 映射 process.platform 到目录命名约定：
 * - win32 -> win (Node.js 使用 'win-x64'，不是 'win32-x64')
 * - darwin -> darwin (不变)
 */
function getRuntimeTargetName(): string {
  const platform = process.platform
  const arch = process.arch
  const platformName = platform === 'win32' ? 'win' : platform
  return `${platformName}-${arch}`
}

/**
 * 获取 Node.js 运行时路径
 * 优先使用 RuntimeManager 提取的运行时，回退到系统 Node.js
 */
function getBundledNodePath(): string {
  const platform = process.platform
  const targetName = getRuntimeTargetName()
  const userDataDir = app.getPath('userData')

  // 1. 检查用户数据目录中的运行时（RuntimeManager 提取的位置）
  if (platform === 'win32') {
    // Windows: node.exe 在根目录
    const nodeExe = path.join(userDataDir, 'runtime', 'node', targetName, 'node.exe')
    if (fs.existsSync(nodeExe)) {
      return nodeExe
    }
  } else {
    // macOS/Linux: node 在 bin 目录
    const nodeBin = path.join(userDataDir, 'runtime', 'node', targetName, 'bin', 'node')
    if (fs.existsSync(nodeBin)) {
      return nodeBin
    }
  }

  // 2. 检查应用资源目录中的运行时（打包后的位置）
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'electron')

  if (platform === 'win32') {
    const nodeExe = path.join(resourcesDir, 'runtime', 'node', targetName, 'node.exe')
    if (fs.existsSync(nodeExe)) {
      return nodeExe
    }
  } else {
    const nodeBin = path.join(resourcesDir, 'runtime', 'node', targetName, 'bin', 'node')
    if (fs.existsSync(nodeBin)) {
      return nodeBin
    }
  }

  // 3. 回退到系统 Node.js
  console.warn('[MCP Launcher] 未找到内置 Node.js，尝试使用系统 Node.js')
  return 'node'
}

/**
 * 启动配置
 */
export interface LaunchConfig {
  /** MCP 根目录 */
  mcpRoot: string
  /** Node.js 可执行文件路径 */
  nodePath?: string
  /** 环境变量 */
  env?: Record<string, string>
  /** 启动超时（毫秒） */
  startupTimeout: number
  /** 是否启用详细日志 */
  verbose: boolean
}

/**
 * 默认启动配置
 */
const DEFAULT_CONFIG: LaunchConfig = {
  mcpRoot: '',
  startupTimeout: 30000,
  verbose: false
}

/**
 * MCP 进程输出
 */
export interface MCPProcessOutput {
  stdout: string
  stderr: string
}

/**
 * MCP Launcher 实现
 */
export class MCPLauncher implements MCPLauncherInterface {
  private config: LaunchConfig
  private processOutputs: Map<string, MCPProcessOutput> = new Map()
  /** 跟踪所有运行的进程 */
  private runningProcesses: Map<string, ChildProcess> = new Map()
  /** Node.js 可执行文件路径（延迟初始化） */
  private _nodePath: string | null = null

  constructor(config: Partial<LaunchConfig> = {}) {
    // 设置默认 MCP 根目录
    const defaultRoot = path.join(
      app.getPath('userData'),
      'mcp-packages'
    )

    this.config = {
      ...DEFAULT_CONFIG,
      mcpRoot: defaultRoot,
      ...config
    }
  }

  /**
   * 获取 Node.js 可执行文件路径
   */
  private getNodePath(): string {
    if (this._nodePath) {
      return this._nodePath
    }

    // 如果配置了自定义 Node.js 路径，使用它
    if (this.config.nodePath) {
      this._nodePath = this.config.nodePath
      return this._nodePath
    }

    // 使用内置 Node.js 运行时
    this._nodePath = getBundledNodePath()
    return this._nodePath
  }

  /**
   * 获取 MCP 入口文件路径
   */
  private async getEntryPoint(definition: MCPDefinition, installPath: string): Promise<string> {
    // 尝试读取 package.json 获取入口
    const packageJsonPath = path.join(installPath, 'package.json')

    try {
      const content = await fs.promises.readFile(packageJsonPath, 'utf-8')
      const pkg = JSON.parse(content)

      // 检查是否有 bin 字段
      if (pkg.bin) {
        if (typeof pkg.bin === 'string') {
          return path.join(installPath, pkg.bin)
        } else if (typeof pkg.bin === 'object') {
          // 取第一个 bin
          const binName = Object.keys(pkg.bin)[0]
          return path.join(installPath, pkg.bin[binName])
        }
      }

      // 检查 main 字段
      if (pkg.main) {
        return path.join(installPath, pkg.main)
      }
    } catch (err) {
      console.error(`[MCP Launcher] 读取 package.json 失败:`, err)
    }

    // 默认入口
    return path.join(installPath, 'index.js')
  }

  /**
   * 构建启动参数
   * 支持占位符替换：
   * - {homePath} -> 用户主目录
   * - {userDataPath} -> 应用用户数据目录
   */
  private buildArgs(definition: MCPDefinition, entryPoint: string): string[] {
    const args: string[] = [entryPoint]

    // 添加 MCP 特定参数
    if (definition.argsTemplate) {
      const homePath = app.getPath('home')
      const userDataPath = app.getPath('userData')

      // 替换占位符
      const processedArgs = definition.argsTemplate.map(arg =>
        arg.replace(/{homePath}/g, homePath)
           .replace(/{userDataPath}/g, userDataPath)
      )
      args.push(...processedArgs)
    }

    return args
  }

  /**
   * 构建环境变量
   * 支持占位符替换：
   * - {homePath} -> 用户主目录
   * - {userDataPath} -> 应用用户数据目录
   */
  private buildEnv(definition: MCPDefinition): Record<string, string> {
    const env: Record<string, string> = {
      ...process.env,
      NODE_ENV: 'production',
      ...this.config.env
    } as Record<string, string>

    // 添加 MCP 特定环境变量
    if (definition.envTemplate) {
      const homePath = app.getPath('home')
      const userDataPath = app.getPath('userData')

      // 替换占位符
      for (const [key, value] of Object.entries(definition.envTemplate)) {
        const processedValue = value
          .replace(/{homePath}/g, homePath)
          .replace(/{userDataPath}/g, userDataPath)
        env[key] = processedValue
      }
    }

    return env
  }

  /**
   * 启动 MCP
   */
  async launch(definition: MCPDefinition, installPath: string): Promise<ChildProcess> {
    validateMCPId(definition.id)

    // 检查是否已有进程在运行
    const existing = this.runningProcesses.get(definition.id)
    if (existing && !existing.killed) {
      return existing
    }

    const entryPoint = await this.getEntryPoint(definition, installPath)
    const args = this.buildArgs(definition, entryPoint)
    const env = this.buildEnv(definition)

    // 使用 Node.js 运行 MCP
    const nodePath = this.getNodePath()

    console.log(`[MCP Launcher] 启动 ${definition.name}:`)
    console.log(`  Node: ${nodePath}`)
    console.log(`  Entry: ${entryPoint}`)
    console.log(`  Args: ${args.join(' ')}`)

    const childProcess = spawn(nodePath, args, {
      env,
      cwd: installPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    })

    // 跟踪进程
    this.runningProcesses.set(definition.id, childProcess)

    // 初始化输出记录
    this.processOutputs.set(definition.id, {
      stdout: '',
      stderr: ''
    })

    // 创建启动检测 Promise（必须在添加其他监听器之前创建）
    const startupPromise = this.waitForStartup(childProcess, definition.id, this.config.startupTimeout)

    // 收集输出
    childProcess.stdout?.on('data', (data: Buffer) => {
      const output = this.processOutputs.get(definition.id)
      if (output) {
        output.stdout += data.toString()
        // 限制输出长度
        if (output.stdout.length > 100000) {
          output.stdout = output.stdout.slice(-50000)
        }
      }
      if (this.config.verbose) {
        console.log(`[MCP ${definition.id}] stdout:`, data.toString())
      }
    })

    childProcess.stderr?.on('data', (data: Buffer) => {
      const output = this.processOutputs.get(definition.id)
      if (output) {
        output.stderr += data.toString()
        // 限制输出长度
        if (output.stderr.length > 100000) {
          output.stderr = output.stderr.slice(-50000)
        }
      }
      if (this.config.verbose) {
        console.log(`[MCP ${definition.id}] stderr:`, data.toString())
      }
    })

    // 处理进程退出 - 清理跟踪
    childProcess.on('exit', (code, signal) => {
      this.runningProcesses.delete(definition.id)

      // 延迟清理输出（保留用于调试）
      setTimeout(() => {
        this.processOutputs.delete(definition.id)
      }, 60000) // 保留 1 分钟

      if (this.config.verbose) {
        console.log(`[MCP ${definition.id}] 退出: code=${code}, signal=${signal}`)
      }
    })

    childProcess.on('error', (err) => {
      console.error(`[MCP ${definition.id}] 错误:`, err)
      this.runningProcesses.delete(definition.id)
    })

    // 等待进程启动
    await startupPromise

    return childProcess
  }

  /**
   * 等待进程启动（修复 Promise 泄漏和竞态条件）
   * 某些 MCP 使用 stdio 通信，不立即输出内容，所以增加一个最小等待时间
   */
  private waitForStartup(
    childProcess: ChildProcess,
    id: string,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false

      const cleanup = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          clearTimeout(minTimer)
          childProcess.stdout?.removeListener('data', onData)
          childProcess.stderr?.removeListener('data', onData)
          childProcess.removeListener('exit', onExit)
          childProcess.removeListener('error', onError)
        }
      }

      const timer = setTimeout(() => {
        cleanup()
        // 超时时，如果进程仍在运行，视为启动成功
        if (!childProcess.killed && childProcess.exitCode === null) {
          console.log(`[MCP Launcher] ${id} 启动超时但进程仍在运行，视为成功`)
          resolve()
        } else {
          console.log(`[MCP Launcher] ${id} 启动超时，进程已退出: killed=${childProcess.killed}, exitCode=${childProcess.exitCode}`)
          reject(new Error('启动超时'))
        }
      }, timeout)

      // 最小等待时间：如果进程在 1000ms 内没有退出，视为启动成功
      // 这对于 stdio 模式的 MCP 很重要
      const minTimer = setTimeout(() => {
        if (!settled && !childProcess.killed && childProcess.exitCode === null) {
          cleanup()
          console.log(`[MCP Launcher] ${id} 最小等待时间已过，进程仍在运行 (PID: ${childProcess.pid})，视为启动成功`)
          resolve()
        }
      }, 1000) // 增加到 1000ms

      const onData = () => {
        cleanup()
        console.log(`[MCP Launcher] ${id} 收到输出数据，启动成功`)
        resolve()
      }

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup()
        console.log(`[MCP Launcher] ${id} 进程意外退出: code=${code}, signal=${signal}`)
        reject(new Error(`进程意外退出: code=${code}, signal=${signal}`))
      }

      const onError = (err: Error) => {
        cleanup()
        console.log(`[MCP Launcher] ${id} 进程错误:`, err)
        reject(new Error(`进程错误: ${err.message}`))
      }

      // 添加监听器
      if (childProcess.stdout) {
        childProcess.stdout.once('data', onData)
      } else {
        console.warn(`[MCP Launcher] ${id} stdout is null`)
      }

      if (childProcess.stderr) {
        childProcess.stderr.once('data', onData)
      } else {
        console.warn(`[MCP Launcher] ${id} stderr is null`)
      }

      childProcess.once('exit', onExit)
      childProcess.once('error', onError)

      console.log(`[MCP Launcher] ${id} 等待启动中... (PID: ${childProcess.pid})`)
    })
  }

  /**
   * 停止 MCP
   */
  async stop(instance: MCPInstance): Promise<void> {
    const { process: proc, id } = instance

    if (!proc || proc.killed) {
      this.runningProcesses.delete(id)
      return
    }

    if (this.config.verbose) {
      console.log(`[MCP Launcher] 停止 ${id} (PID: ${proc.pid})`)
    }

    // 发送 SIGTERM
    try {
      proc.kill('SIGTERM')
    } catch (err) {
      // 进程可能已经退出
      this.runningProcesses.delete(id)
      return
    }

    // 等待进程退出
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // 强制终止
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, 5000)

      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.runningProcesses.delete(id)
  }

  /**
   * 健康检查
   */
  async healthCheck(instance: MCPInstance): Promise<boolean> {
    const { process: proc } = instance

    if (!proc || proc.killed) {
      return false
    }

    // 检查进程是否存活
    try {
      process.kill(proc.pid!, 0) // 发送信号 0，不会真正杀死进程
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取进程输出
   */
  getOutput(id: string): MCPProcessOutput | undefined {
    return this.processOutputs.get(id)
  }

  /**
   * 清理所有输出
   */
  clearOutputs(): void {
    this.processOutputs.clear()
  }

  /**
   * 清理所有进程（应用退出时调用）
   */
  async cleanup(): Promise<void> {
    if (this.config.verbose) {
      console.log('[MCP Launcher] 清理所有进程...')
    }

    const killPromises = Array.from(this.runningProcesses.entries()).map(
      async ([id, proc]) => {
        try {
          if (!proc.killed) {
            proc.kill('SIGTERM')

            // 等待退出
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(() => {
                try {
                  proc.kill('SIGKILL')
                } catch {
                  // ignore
                }
                resolve()
              }, 5000)

              proc.once('exit', () => {
                clearTimeout(timeout)
                resolve()
              })
            })
          }
        } catch (err) {
          console.error(`[MCP Launcher] 清理进程 ${id} 失败:`, err)
        }
      }
    )

    await Promise.all(killPromises)

    this.runningProcesses.clear()
    this.processOutputs.clear()

    if (this.config.verbose) {
      console.log('[MCP Launcher] 清理完成')
    }
  }

  /**
   * 检查 MCP 是否可用
   */
  async checkAvailability(
    definition: MCPDefinition,
    installPath: string
  ): Promise<{
    available: boolean
    reason?: string
  }> {
    // 检查安装路径是否存在
    try {
      await fs.promises.access(installPath)
    } catch {
      return {
        available: false,
        reason: 'MCP 未安装'
      }
    }

    // 检查入口文件是否存在
    const entryPoint = await this.getEntryPoint(definition, installPath)
    try {
      await fs.promises.access(entryPoint)
    } catch {
      return {
        available: false,
        reason: '入口文件不存在'
      }
    }

    return { available: true }
  }
}

// 单例实例
let launcherInstance: MCPLauncher | null = null

/**
 * 获取 Launcher 单例
 */
export function getMCPLauncher(config?: Partial<LaunchConfig>): MCPLauncher {
  if (!launcherInstance) {
    launcherInstance = new MCPLauncher(config)
  }
  return launcherInstance
}

/**
 * 重置单例（用于测试）
 */
export function resetMCPLauncher(): void {
  if (launcherInstance) {
    launcherInstance.cleanup().catch(() => {})
  }
  launcherInstance = null
}
