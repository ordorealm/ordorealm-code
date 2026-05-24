/**
 * Status display store
 * @module stores/status-store
 *
 * Note: This store provides UI-facing status state. Task execution methods
 * (startTask, updateProgress, completeTask) are delegated to agent-store
 * to maintain consistency with the architecture specification.
 */

import { create } from 'zustand';
import type { StatusState, ConnectionStatus } from '@/types';
import { useAgentStore } from './agent-store';

interface StatusActions {
  setConnectionStatus: (status: ConnectionStatus) => void;
  setCurrentTask: (task: string | null) => void;
  setTaskProgress: (progress: { current: number; total: number } | null) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
  /** 开始任务 - 委托给 agent-store */
  startTask: (taskName: string, totalSteps: number) => void;
  /** 更新任务进度 - 委托给 agent-store */
  updateProgress: (currentStep: number) => void;
  /** 完成任务 - 委托给 agent-store */
  completeTask: () => void;
}

export const useStatusStore = create<StatusState & StatusActions>((set) => ({
  connectionStatus: 'disconnected',
  currentTask: null,
  taskProgress: null,
  lastError: null,

  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setCurrentTask: (task) => set({ currentTask: task }),
  setTaskProgress: (progress) => set({ taskProgress: progress }),
  setError: (error) => set({ lastError: error }),
  clearError: () => set({ lastError: null }),

  /**
   * 开始任务 - 委托给 agent-store
   * 保持与 Spec 定义一致
   */
  startTask: (taskName, totalSteps) => {
    set({ currentTask: taskName, taskProgress: { current: 0, total: totalSteps } });
    // 同时更新 agent-store 状态以保持同步
    useAgentStore.getState().startTask(taskName, totalSteps);
  },

  /**
   * 更新任务进度 - 委托给 agent-store
   * 保持与 Spec 定义一致
   */
  updateProgress: (currentStep) => {
    set((state) => ({
      taskProgress: state.taskProgress ? { ...state.taskProgress, current: currentStep } : null,
    }));
    // 同时更新 agent-store 状态以保持同步
    useAgentStore.getState().updateProgress(currentStep);
  },

  /**
   * 完成任务 - 委托给 agent-store
   * 保持与 Spec 定义一致
   */
  completeTask: () => {
    set({ currentTask: null, taskProgress: null });
    // 同时更新 agent-store 状态以保持同步
    useAgentStore.getState().completeTask();
  },
}));
