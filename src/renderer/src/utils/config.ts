import { getUserDataPath, readJsonFile, writeJsonFile, ensureDir } from './fs';
import { joinPath } from './path';

/**
 * 应用配置接口
 */
export interface AppConfig {
  version: string;
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  recentProjects: string[];
  lastOpenedProject: string | null;
  autoSave: boolean;
  autoSaveInterval: number; // 秒
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: AppConfig = {
  version: '1.0.0',
  theme: 'system',
  fontSize: 14,
  recentProjects: [],
  lastOpenedProject: null,
  autoSave: true,
  autoSaveInterval: 30,
};

/**
 * 配置文件路径
 */
async function getConfigPath(): Promise<string> {
  return joinPath(await getUserDataPath(), 'config.json');
}

/**
 * 加载应用配置
 */
export async function loadConfig(): Promise<AppConfig> {
  const configPath = await getConfigPath();
  const config = await readJsonFile<AppConfig>(configPath);

  if (!config) {
    // 配置不存在，创建默认配置
    const userDataPath = await getUserDataPath();
    await ensureDir(userDataPath);
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  // 合并默认配置（处理新版本新增的配置项）
  return { ...DEFAULT_CONFIG, ...config };
}

/**
 * 保存应用配置
 */
export async function saveConfig(config: AppConfig): Promise<boolean> {
  const configPath = await getConfigPath();
  await ensureDir(await getUserDataPath());
  return writeJsonFile(configPath, config);
}

/**
 * 更新部分配置
 */
export async function updateConfig(updates: Partial<AppConfig>): Promise<boolean> {
  const config = await loadConfig();
  const newConfig = { ...config, ...updates };
  return saveConfig(newConfig);
}

/**
 * 重置配置为默认值
 */
export async function resetConfig(): Promise<boolean> {
  return saveConfig(DEFAULT_CONFIG);
}
