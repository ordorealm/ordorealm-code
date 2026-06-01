/**
 * Controller IPC Handler
 * 控制器 IPC 处理
 * @module main/ipc/controller-handler
 */

import { ipcMain, BrowserWindow } from 'electron'
import { Logger } from '../utils/logger'
import { runController, ControllerEngine } from '../controller'

const logger = new Logger('ControllerHandler')

// 正在运行的控制器实例
const runningControllers = new Map<string, ControllerEngine>()

/**
 * 注册控制器 IPC 处理器
 */
export function registerControllerHandlers(): void {
  // 运行控制器
  ipcMain.handle(
    'controller:run',
    async (
      _event,
      options: {
        sessionId: string
        projectRoot: string
        skillName: string
      }
    ): Promise<{ success: boolean; error?: string }> => {
      const { sessionId, projectRoot, skillName } = options

      logger.info(`Running controller: ${skillName}`)
      logger.info(`Session: ${sessionId}`)
      logger.info(`Project: ${projectRoot}`)

      try {
        // 检查是否已有控制器在运行
        if (runningControllers.has(sessionId)) {
          return {
            success: false,
            error: 'A controller is already running for this session'
          }
        }

        // 创建并运行控制器
        const engine = new ControllerEngine({
          sessionId,
          projectRoot,
          skillName
        })

        runningControllers.set(sessionId, engine)

        const result = await engine.run()

        runningControllers.delete(sessionId)

        return result

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(`Controller run failed: ${errorMessage}`)
        runningControllers.delete(sessionId)
        return { success: false, error: errorMessage }
      }
    }
  )

  // 中止控制器
  ipcMain.handle(
    'controller:abort',
    async (_event, sessionId: string): Promise<{ success: boolean }> => {
      logger.info(`Aborting controller for session: ${sessionId}`)

      const engine = runningControllers.get(sessionId)
      if (!engine) {
        return { success: false }
      }

      engine.abort()
      runningControllers.delete(sessionId)

      return { success: true }
    }
  )

  // 获取控制器状态
  ipcMain.handle(
    'controller:status',
    async (_event, sessionId: string): Promise<{
      running: boolean
      skillName?: string
    }> => {
      const engine = runningControllers.get(sessionId)

      return {
        running: !!engine,
        skillName: engine?.getSkillName()
      }
    }
  )

  logger.info('Controller IPC handlers registered')
}

/**
 * 获取正在运行的控制器数量
 */
export function getRunningControllerCount(): number {
  return runningControllers.size
}

/**
 * 中止所有控制器
 */
export function abortAllControllers(): void {
  for (const [sessionId, engine] of runningControllers) {
    logger.info(`Aborting controller for session: ${sessionId}`)
    engine.abort()
  }
  runningControllers.clear()
}