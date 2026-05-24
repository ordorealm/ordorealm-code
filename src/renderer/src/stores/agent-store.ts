/**
 * Agent integration store
 * @module stores/agent-store
 */

import { create } from 'zustand';
import type { AgentState, AgentStatus, AgentConfig } from '@/types';
import { checkClaudeCodeAvailable } from '@/services/claude-code';

/** 重试配置 */
const RETRY_CONFIG = {
  maxRetries: 3,
  delays: [2000, 5000, 10000], // 重试延迟（毫秒）
};

/** 连接超时配置 */
const CONNECTION_TIMEOUT = 30000; // 30 秒

interface AgentActions {
  /** 连接到 Agent 服务 */
  connect: () => Promise<void>;
  /** 断开 Agent 连接 */
  disconnect: () => void;
  /** 设置连接状态 */
  setConnectionStatus: (status: AgentStatus) => void;
  /** 设置 Agent 配置 */
  setConfig: (config: AgentConfig) => void;
  /** 执行任务 */
  executeTask: (taskName: string, taskFn: () => Promise<void>, totalSteps?: number) => Promise<void>;
  /** 开始任务 */
  startTask: (taskName: string, totalSteps: number) => void;
  /** 更新任务进度 */
  updateProgress: (currentStep: number) => void;
  /** 完成任务 */
  completeTask: () => void;
  /** 设置错误 */
  setError: (error: string) => void;
  /** 清除错误 */
  clearError: () => void;
  /** 检查是否有可用 Provider */
  hasProvider: () => boolean;
  /** 重试连接（降级策略） */
  retryConnect: () => Promise<void>;
  /** 获取连接状态描述 */
  getStatusDescription: () => string;
}

/**
 * 延迟函数
 * @param ms 毫秒数
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const useAgentStore = create<AgentState & AgentActions>((set, get) => ({
  status: 'disconnected',
  currentTask: null,
  taskProgress: null,
  lastError: null,
  config: null,

  /**
   * 检查是否有可用 Provider
   */
  hasProvider: () => {
    const { config } = get();
    return config?.providerId != null && config.providerId.length > 0;
  },

  /**
   * 设置 Agent 配置
   */
  setConfig: (config) => {
    set({ config });
  },

  /**
   * 连接到 Agent 服务
   * - 检查是否有 Provider 配置
   * - 设置连接状态
   * - 实现超时机制
   */
  connect: async () => {
    const { hasProvider, clearError } = get();

    // 清除之前的错误
    clearError();

    // 检查是否有 Provider 配置
    if (!hasProvider()) {
      set({
        status: 'error',
        lastError: '未配置 API Provider，请先在设置中添加 Provider',
      });
      return;
    }

    set({ status: 'connecting' });
    console.log('[Agent] Connecting to agent service...');

    try {
      // 检查 Claude Code CLI 是否可用
      const isAvailable = await checkClaudeCodeAvailable();
      if (!isAvailable) {
        set({
          status: 'error',
          lastError: 'Claude Code CLI 不可用，请确保已安装 claude 命令行工具',
        });
        return;
      }

      // 添加超时机制
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('连接超时')), CONNECTION_TIMEOUT);
      });

      // 等待连接完成（实际连接已在 checkClaudeCodeAvailable 中验证）
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(() => resolve(), 500)),
        timeoutPromise,
      ]);

      set({ status: 'connected' });
      console.log('[Agent] Connected successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[Agent] Connection failed:', errorMessage);
      set({
        status: 'error',
        lastError: `连接失败: ${errorMessage}`,
      });
    }
  },

  /**
   * 断开 Agent 连接
   * - 清理所有状态
   * - 设置为空闲状态，等待下次连接
   */
  disconnect: () => {
    const { status } = get();

    // 如果正在执行任务，记录警告
    if (status === 'working') {
      console.warn('[Agent] Disconnecting while task is in progress');
    }

    set({
      status: 'idle',
      currentTask: null,
      taskProgress: null,
      lastError: null,
    });

    console.log('[Agent] Disconnected from agent service, now idle');
  },

  /**
   * 设置连接状态
   */
  setConnectionStatus: (status) => {
    set({ status });
  },

  /**
   * 执行任务
   * - 设置当前任务
   * - 更新进度
   * - 处理错误
   */
  executeTask: async (taskName, taskFn, totalSteps = 1) => {
    const { status, setError, startTask, updateProgress, completeTask } = get();

    // 检查连接状态（只允许 connected 状态执行任务）
    if (status !== 'connected') {
      setError('Agent 未连接，请先连接');
      return;
    }

    // 开始任务
    startTask(taskName, totalSteps);

    try {
      // 执行任务函数
      await taskFn();

      // 更新到最后一步
      updateProgress(totalSteps);

      // 完成任务
      completeTask();

      console.log(`[Agent] Task completed: ${taskName}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError(`任务执行失败: ${errorMessage}`);
      console.error(`[Agent] Task failed: ${taskName}`, error);
    }
  },

  /**
   * 开始任务
   */
  startTask: (taskName, totalSteps) => {
    set({
      status: 'working',
      currentTask: taskName,
      taskProgress: { current: 0, total: totalSteps },
    });
    console.log(`[Agent] Task started: ${taskName} (${totalSteps} steps)`);
  },

  /**
   * 更新任务进度
   */
  updateProgress: (currentStep) => {
    const { taskProgress, currentTask } = get();
    if (taskProgress) {
      const newProgress = { ...taskProgress, current: currentStep };
      set({ taskProgress: newProgress });
      console.log(`[Agent] Progress: ${currentStep}/${taskProgress.total} - ${currentTask}`);
    }
  },

  /**
   * 完成任务
   */
  completeTask: () => {
    const { currentTask } = get();
    set({
      status: 'connected',
      currentTask: null,
      taskProgress: null,
    });
    console.log(`[Agent] Task completed: ${currentTask}`);
  },

  /**
   * 设置错误
   */
  setError: (error) => {
    set({ lastError: error, status: 'error' });
    console.error(`[Agent] Error: ${error}`);
  },

  /**
   * 清除错误
   */
  clearError: () => {
    set({ lastError: null });
  },

  /**
   * 重试连接（降级策略）
   * - 重试 1: 等待 2 秒后重试
   * - 重试 2: 等待 5 秒后重试
   * - 重试 3: 等待 10 秒后重试
   * - 最终失败 → 显示错误，提示用户
   */
  retryConnect: async () => {
    const { connect, setError, clearError } = get();
    clearError();

    for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
      console.log(`[Agent] Retry attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}`);

      // 等待指定延迟
      if (attempt > 0) {
        const delayMs = RETRY_CONFIG.delays[attempt - 1];
        console.log(`[Agent] Waiting ${delayMs}ms before retry...`);
        await delay(delayMs);
      }

      try {
        await connect();

        const { status } = get();
        if (status === 'connected') {
          console.log('[Agent] Retry successful');
          return;
        }
      } catch (error) {
        console.error(`[Agent] Retry attempt ${attempt + 1} failed:`, error);
      }
    }

    // 所有重试都失败
    setError('连接失败，已达到最大重试次数。请检查网络配置或 API Key 是否有效。');
    console.error('[Agent] All retry attempts failed');
  },

  /**
   * 获取连接状态描述
   */
  getStatusDescription: () => {
    const { status, currentTask, taskProgress } = get();

    const statusMap: Record<AgentStatus, string> = {
      idle: '空闲',
      connecting: '连接中...',
      connected: '已连接',
      working: currentTask ? `工作中: ${currentTask}` : '工作中',
      error: '错误',
      disconnected: '未连接',
    };

    let description = statusMap[status];

    if (status === 'working' && taskProgress) {
      description += ` (${taskProgress.current}/${taskProgress.total})`;
    }

    return description;
  },
}));
