/**
 * State Manager
 * 状态管理器（控制器独占）
 * 通用设计，不包含业务相关字段
 * @module main/controller/state-manager
 */

import { Logger } from '../utils/logger'
import { SessionApi } from './session-api'
import type { Checkpoint, ErrorRecord, ControllerConfig, ControllerMeta, ControllerState } from './types'

const logger = new Logger('StateManager')

/**
 * 状态管理器
 * 控制器独占状态管理，外部只能通过工具调用修改
 */
export class StateManager {
  private sessionApi: SessionApi
  private state: ControllerState | null = null
  private lock: Promise<void> = Promise.resolve()
  private lockAcquired: boolean = true
  private _releaseLock: () => void = () => {}

  constructor(sessionApi: SessionApi) {
    this.sessionApi = sessionApi
  }

  /**
   * 初始化状态
   */
  async initialize(): Promise<void> {
    logger.info('Initializing state manager')

    const existingState = await this.sessionApi.getState()

    if (existingState) {
      // 检查是否需要迁移旧版结构
      if (!existingState.config) {
        logger.info('Migrating old state structure to new format')
        this.state = this.migrateState(existingState as unknown as Record<string, unknown>)
        await this.sessionApi.saveState(this.state)
      } else {
        this.state = existingState
        logger.info('Loaded existing state')
      }
    } else {
      this.state = this.createInitialState()
      await this.sessionApi.saveState(this.state)
      logger.info('Created initial state')
    }
  }

  /**
   * 创建初始状态
   */
  createInitialState(): ControllerState {
    return {
      config: {
        max_iterations: 100,
        default_agent_timeout_minutes: 30,
        default_input_timeout_minutes: 5
      },
      data: {},
      meta: {
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        errors: []
      }
    }
  }

  /**
   * 迁移旧版 state.json 到新结构
   * 兼容旧版无 config/meta 分层的 state.json
   */
  migrateState(oldState: Record<string, unknown>): ControllerState {
    return {
      config: {
        max_iterations: 100,
        default_agent_timeout_minutes: 30,
        default_input_timeout_minutes: 5
      },
      data: (oldState.data as Record<string, unknown>) || {},
      meta: {
        startedAt: (oldState.startedAt as string) || new Date().toISOString(),
        updatedAt: (oldState.updatedAt as string) || new Date().toISOString(),
        checkpoint: oldState.checkpoint as Checkpoint | undefined,
        errors: (oldState.errors as ErrorRecord[]) || []
      }
    }
  }

  /**
   * 获取当前状态（只读）
   */
  getState(): Readonly<ControllerState> {
    if (!this.state) {
      throw new Error('State not initialized')
    }
    return this.state
  }

  /**
   * 更新整个状态
   * @param newState 新状态
   */
  async updateState(newState: ControllerState): Promise<void> {
    return this.withLock(async () => {
      this.state = {
        ...newState,
        meta: {
          ...newState.meta,
          updatedAt: new Date().toISOString()
        }
      }
      await this.sessionApi.saveState(this.state)
      logger.info('State updated')
    })
  }

  /**
   * 添加错误记录
   * @param message 错误消息
   * @param context 可选的上下文信息
   */
  async addError(message: string, context?: Record<string, unknown>): Promise<void> {
    return this.withLock(async () => {
      if (!this.state) {
        throw new Error('State not initialized')
      }
      if (!this.state.meta.errors) {
        this.state.meta.errors = []
      }
      this.state.meta.errors.push({
        timestamp: new Date().toISOString(),
        message,
        context
      })
      this.state.meta.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.error(`Error recorded: ${message}`)
    })
  }

  /**
   * 创建检查点（用于错误恢复）
   * @param stepId 当前步骤 ID
   * @param data 可选的检查点数据
   */
  async createCheckpoint(stepId: string, data?: unknown): Promise<void> {
    return this.withLock(async () => {
      if (!this.state) {
        throw new Error('State not initialized')
      }
      this.state.meta.checkpoint = {
        stepId,
        timestamp: new Date().toISOString(),
        data
      }
      this.state.meta.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Checkpoint created at step: ${stepId}`)
    })
  }

  /**
   * 获取检查点
   * @returns 检查点数据或 null
   */
  getCheckpoint(): Checkpoint | null {
    if (!this.state || !this.state.meta.checkpoint) return null
    return this.state.meta.checkpoint
  }

  /**
   * 清除检查点
   */
  async clearCheckpoint(): Promise<void> {
    return this.withLock(async () => {
      if (!this.state) return
      this.state.meta.checkpoint = undefined
      this.state.meta.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info('Checkpoint cleared')
    })
  }

  /**
   * 从错误恢复（回滚到检查点）
   * @returns 检查点步骤 ID 或 null
   */
  async recoverFromError(): Promise<string | null> {
    return this.withLock(async () => {
      if (!this.state || !this.state.meta.checkpoint) {
        logger.warn('No checkpoint available for recovery')
        return null
      }
      const checkpointStepId = this.state.meta.checkpoint.stepId
      logger.info(`Recovering from error, returning to step: ${checkpointStepId}`)
      this.state.meta.checkpoint = undefined
      this.state.meta.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info('Recovered from error, checkpoint cleared')
      return checkpointStepId
    })
  }

  /**
   * 获取锁
   * 使用 Promise 链实现简单的异步锁
   */
  private async acquireLock(): Promise<void> {
    const oldLock = this.lock
    let releaseLock: () => void

    this.lock = new Promise<void>(resolve => {
      releaseLock = resolve
    })

    await oldLock
    this.lockAcquired = false
    this._releaseLock = releaseLock!
  }

  /**
   * 释放锁
   */
  private releaseLock(): void {
    if (this._releaseLock) {
      try {
        this._releaseLock()
      } catch (error) {
        logger.error(`Failed to release lock: ${error}`)
      }
      this._releaseLock = () => {}
      this.lockAcquired = true
    }
  }

  /**
   * 带锁执行操作（公共方法）
   * 确保无论成功或失败都会释放锁
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireLock()
    try {
      return await fn()
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 按路径更新状态字段
   * 支持嵌套路径如 "data.field.status" 或 "data.items[0].status"
   * @param path 状态路径
   * @param value 新值
   */
  async updateStateByPath(path: string, value: unknown): Promise<void> {
    return this.withLock(async () => {
      if (!this.state) {
        throw new Error('State not initialized')
      }
      const keys = this.parsePath(path)
      // 使用类型断言处理状态对象
      let current: Record<string, unknown> = this.state as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i] as string
        if (current[key] === undefined) {
          const nextKey = keys[i + 1]
          current[key] = typeof nextKey === 'number' ? [] : {}
        }
        current = current[key] as Record<string, unknown>
      }
      const lastKey = keys[keys.length - 1] as string
      current[lastKey] = value
      this.state.meta.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`State updated: ${path} = ${JSON.stringify(value)?.slice(0, 100)}`)
    })
  }

  /**
   * 解析路径字符串
   * 支持 "a.b.c" 和 "a[0].b" 格式
   */
  parsePath(path: string): (string | number)[] {
    const result: (string | number)[] = []
    const parts = path.split('.')

    for (const part of parts) {
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/)
      if (arrayMatch) {
        result.push(arrayMatch[1])
        result.push(parseInt(arrayMatch[2], 10))
      } else {
        result.push(part)
      }
    }
    return result
  }

  /**
   * 增加指定路径的计数器
   * @param counterPath 计数器路径
   */
  async incrementCounter(counterPath: string): Promise<number> {
    return this.withLock(async () => {
      if (!this.state) {
        throw new Error('State not initialized')
      }
      const keys = this.parsePath(counterPath)
      // 使用类型断言处理状态对象
      let current: Record<string, unknown> = this.state as unknown as Record<string, unknown>
      for (const key of keys.slice(0, -1)) {
        const keyStr = key as string
        if (current[keyStr] === undefined) {
          current[keyStr] = {}
        }
        current = current[keyStr] as Record<string, unknown>
      }
      const lastKey = keys[keys.length - 1] as string
      const currentValue = typeof current[lastKey] === 'number'
        ? current[lastKey] as number
        : 0
      const newValue = currentValue + 1
      current[lastKey] = newValue
      this.state.meta.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Counter incremented: ${counterPath} = ${newValue}`)
      return newValue
    })
  }

  /**
   * 尝试获取锁（带超时）
   * @param timeoutMs 超时时间（毫秒）
   * @returns 是否成功获取锁
   */
  async tryAcquireLock(timeoutMs: number = 5000): Promise<boolean> {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      if (this.lockAcquired) {
        await this.acquireLock()
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return false
  }
}
