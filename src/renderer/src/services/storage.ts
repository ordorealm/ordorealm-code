/**
 * 存储服务
 * 管理配置文件的统一入口
 * @module services/storage
 */

import { getUserDataPathAsync, getUserDataPath, readJsonFile, writeJsonFile, ensureDir, initializeUserDataPath } from '@/utils/fs';
import { joinPath } from '@/utils/path';

/**
 * 配置文件路径映射
 * 注意：同步版本可能在首次调用时返回不准确的路径
 */
export const CONFIG_FILES = {
  providers: () => joinPath(getUserDataPath(), 'providers.json'),
  projects: () => joinPath(getUserDataPath(), 'projects.json'),
  config: () => joinPath(getUserDataPath(), 'config.json'),
  sessions: () => joinPath(getUserDataPath(), 'sessions'),
} as const;

/**
 * 异步版本的配置文件路径映射
 * 推荐在初始化时使用
 */
export const CONFIG_FILES_ASYNC = {
  providers: async () => joinPath(await getUserDataPathAsync(), 'providers.json'),
  projects: async () => joinPath(await getUserDataPathAsync(), 'projects.json'),
  config: async () => joinPath(await getUserDataPathAsync(), 'config.json'),
  sessions: async () => joinPath(await getUserDataPathAsync(), 'sessions'),
} as const;

/**
 * 初始化存储目录
 * 确保用户数据目录存在
 */
export async function initializeStorage(): Promise<void> {
  // 首先初始化用户数据路径（确保缓存）
  await initializeUserDataPath()
  // 然后确保目录存在
  await ensureDir(getUserDataPath())
}

/**
 * 检查存储是否已初始化
 * @returns 是否已初始化
 */
export async function isStorageInitialized(): Promise<boolean> {
  const dataPath = await getUserDataPathAsync();
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:exists', dataPath);
    return result as boolean;
  } catch {
    return false;
  }
}

// Re-export fs utilities for convenience
export { readJsonFile, writeJsonFile, getUserDataPath, getUserDataPathAsync, ensureDir };
