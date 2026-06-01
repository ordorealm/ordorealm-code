/**
 * State Manager
 * 状态管理器（控制器独占）
 * @module main/controller/state-manager
 */

import { Logger } from '../utils/logger'
import type {
  ControllerState,
  Phase,
  Task,
  TaskStatus,
  PhaseStatus,
  FlowState,
  Issue
} from './types'
import { SessionApi } from './session-api'

const logger = new Logger('StateManager')

/**
 * 状态管理器
 * 控制器独占状态管理，外部只能通过工具调用修改
 */
export class StateManager {
  private sessionApi: SessionApi
  private state: ControllerState | null = null
  private lock: Promise<void> = Promise.resolve()

  constructor(sessionApi: SessionApi) {
    this.sessionApi = sessionApi
  }

  /**
   * 初始化状态
   */
  async initialize(): Promise<void> {
    logger.info('Initializing state manager')

    // 加载现有状态
    const existingState = await this.sessionApi.getState()

    if (existingState) {
      this.state = existingState
      logger.info(`Loaded existing state, flow: ${this.state.flow}`)
    } else {
      // 创建初始状态
      this.state = this.createInitialState()
      await this.sessionApi.saveState(this.state)
      logger.info('Created initial state')
    }
  }

  /**
   * 创建初始状态
   */
  private createInitialState(): ControllerState {
    return {
      flow: 'idle',
      phases: [],
      tasks: [],
      reviewCount: 0,
      errors: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
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
   * 更新流程状态
   * @param flow 新的流程状态
   */
  async updateFlowState(flow: FlowState): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        this.state = this.createInitialState()
      }

      const previousFlow = this.state.flow
      this.state.flow = flow
      this.state.updatedAt = new Date().toISOString()

      await this.sessionApi.saveState(this.state)
      logger.info(`Flow state updated: ${previousFlow} -> ${flow}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 更新任务状态（工具调用）
   * @param taskId 任务 ID
   * @param status 新状态
   * @param summary 摘要
   * @param modifiedFiles 修改的文件
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    summary?: string,
    modifiedFiles?: string[]
  ): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      const task = this.state.tasks.find(t => t.id === taskId)
      if (!task) {
        logger.warn(`Task not found: ${taskId}`)
        return
      }

      task.status = status
      if (summary) task.summary = summary
      if (modifiedFiles) task.modifiedFiles = modifiedFiles

      if (status === 'in_progress') {
        task.startedAt = new Date().toISOString()
      } else if (status === 'done' || status === 'failed') {
        task.completedAt = new Date().toISOString()
      }

      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Task ${taskId} status updated: ${status}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 更新 Phase 状态
   * @param phaseId Phase ID
   * @param status 新状态
   */
  async updatePhaseStatus(phaseId: string, status: PhaseStatus): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      const phase = this.state.phases.find(p => p.id === phaseId)
      if (!phase) {
        logger.warn(`Phase not found: ${phaseId}`)
        return
      }

      phase.status = status

      if (status === 'in_progress') {
        phase.startedAt = new Date().toISOString()
      } else if (status === 'completed' || status === 'failed') {
        phase.completedAt = new Date().toISOString()
      }

      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Phase ${phaseId} status updated: ${status}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 增加审查轮次
   * @returns 当前轮次
   */
  async incrementReviewCount(): Promise<number> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      this.state.reviewCount++
      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Review count incremented: ${this.state.reviewCount}`)
      return this.state.reviewCount
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 记录审查问题
   * @param phaseId Phase ID
   * @param issues 问题列表
   */
  async recordReviewIssues(phaseId: string, issues: Issue[]): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      const phase = this.state.phases.find(p => p.id === phaseId)
      if (!phase) {
        logger.warn(`Phase not found: ${phaseId}`)
        return
      }

      if (!phase.review) {
        phase.review = {
          count: 0,
          maxCount: 5,
          status: 'pending'
        }
      }

      phase.review.issues = issues
      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Review issues recorded for phase ${phaseId}: ${issues.length} issues`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 设置当前 Phase
   * @param phaseId Phase ID
   */
  async setCurrentPhase(phaseId: string): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      this.state.currentPhase = phaseId
      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Current phase set: ${phaseId}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 设置当前任务
   * @param taskId 任务 ID
   */
  async setCurrentTask(taskId: string): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      this.state.currentTask = taskId
      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Current task set: ${taskId}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 添加错误记录
   * @param message 错误消息
   * @param phaseId Phase ID
   * @param taskId 任务 ID
   */
  async addError(message: string, phaseId?: string, taskId?: string): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      this.state.errors.push({
        timestamp: new Date().toISOString(),
        message,
        phaseId,
        taskId
      })

      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.error(`Error recorded: ${message}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 添加 Phase
   * @param phase Phase 定义
   */
  async addPhase(phase: Phase): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      this.state.phases.push(phase)
      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Phase added: ${phase.id}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 添加任务
   * @param task 任务定义
   */
  async addTask(task: Task): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      this.state.tasks.push(task)
      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Task added: ${task.id}`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 批量添加 Phases 和 Tasks
   * @param phases Phase 列表
   * @param tasks 任务列表
   */
  async addPhasesAndTasks(phases: Phase[], tasks: Task[]): Promise<void> {
    await this.acquireLock()

    try {
      if (!this.state) {
        throw new Error('State not initialized')
      }

      this.state.phases.push(...phases)
      this.state.tasks.push(...tasks)
      this.state.updatedAt = new Date().toISOString()
      await this.sessionApi.saveState(this.state)
      logger.info(`Added ${phases.length} phases and ${tasks.length} tasks`)
    } finally {
      this.releaseLock()
    }
  }

  /**
   * 获取下一个待执行的 Phase
   * @returns Phase 或 null
   */
  getNextPendingPhase(): Phase | null {
    if (!this.state) return null

    return this.state.phases.find(p => {
      // 状态为 pending
      if (p.status !== 'pending') return false

      // 所有依赖都已完成
      for (const depId of p.dependencies) {
        const dep = this.state!.phases.find(d => d.id === depId)
        if (!dep || dep.status !== 'completed') return false
      }

      return true
    }) || null
  }

  /**
   * 获取下一个待执行的任务（在当前 Phase 内）
   * @param phaseId Phase ID
   * @returns 任务或 null
   */
  getNextPendingTask(phaseId: string): Task | null {
    if (!this.state) return null

    const phase = this.state.phases.find(p => p.id === phaseId)
    if (!phase) return null

    for (const taskId of phase.tasks) {
      const task = this.state!.tasks.find(t => t.id === taskId)
      if (!task) continue

      // 状态为 pending
      if (task.status !== 'pending') continue

      // 所有依赖都已完成
      for (const depId of task.dependencies) {
        const dep = this.state!.tasks.find(t => t.id === depId)
        if (!dep || dep.status !== 'done') continue
      }

      return task
    }

    return null
  }

  /**
   * 检查 Phase 是否所有任务都已完成
   * @param phaseId Phase ID
   */
  isPhaseTasksAllDone(phaseId: string): boolean {
    if (!this.state) return false

    const phase = this.state.phases.find(p => p.id === phaseId)
    if (!phase) return false

    for (const taskId of phase.tasks) {
      const task = this.state.tasks.find(t => t.id === taskId)
      if (!task || task.status !== 'done') return false
    }

    return true
  }

  /**
   * 获取锁
   */
  private async acquireLock(): Promise<void> {
    const oldLock = this.lock
    let releaseLock: () => void

    this.lock = new Promise<void>(resolve => {
      releaseLock = resolve
    })

    await oldLock
    this._releaseLock = releaseLock!
  }

  /**
   * 释放锁
   */
  private releaseLock(): void {
    if (this._releaseLock) {
      this._releaseLock()
    }
  }

  private _releaseLock: () => void = () => {}
}