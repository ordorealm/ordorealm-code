/**
 * Provider management store
 * @module stores/provider-store
 *
 * Note: API Keys are stored in plaintext for simplicity.
 * This is acceptable for a local desktop application.
 */

import { create } from 'zustand';
import type { Provider, ProviderState, ApiType, AgentType } from '@/types';
import { AGENT_TO_ADAPTER } from '@/types/provider.types';
import { initializeStorage } from '@/services/storage';
import { readJsonFile, writeJsonFile, getUserDataPathAsync, ensureDir } from '@/utils/fs';
import { validateKeyFormat } from '@/services/provider-validator';
import { useAgentStore } from '@/stores/agent-store';

/** Store 初始化状态 */
let initialized = false;
let initPromise: Promise<void> | null = null;

/** 生成唯一 ID */
const generateId = () => crypto.randomUUID();

/**
 * 重新配置 Agent 使用指定的 Provider
 * @param provider Provider 配置
 */
async function reconfigureAgentWithProvider(provider: Provider): Promise<void> {
  try {
    const agentStore = useAgentStore.getState();

    // 配置 Agent
    agentStore.setConfig({
      type: provider.agentType,
      providerId: provider.id,
      permissions: [
        { name: 'read', allowed: true },
        { name: 'write', allowed: true },
        { name: 'execute', allowed: true },
      ],
    });

    // 连接 Agent
    await agentStore.connect();
  } catch (error) {
    console.error('[ProviderStore] Failed to reconfigure agent:', error);
  }
}

/**
 * 备份损坏的文件并重置
 * @param filePath 损坏的文件路径
 */
async function backupAndResetProviders(filePath: string): Promise<void> {
  try {
    // 创建带时间戳的备份文件名
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${filePath}.corrupted.${timestamp}.bak`;

    // 尝试读取损坏的文件内容用于备份
    const result = await window.electron.ipcRenderer.invoke('fs:readFile', filePath);
    if (result?.success && result?.content) {
      // 备份损坏的文件
      await window.electron.ipcRenderer.invoke('fs:writeFile', backupPath, result.content);
    }

    // 重置 providers 文件
    await writeJsonFile(filePath, { providers: [], activeProviderId: null });
  } catch (backupError) {
    console.error('Failed to backup corrupted file:', backupError);
    // 即使备份失败，也尝试重置
    try {
      await writeJsonFile(filePath, { providers: [], activeProviderId: null });
    } catch (resetError) {
      console.error('Failed to reset providers file:', resetError);
    }
  }
}

interface ProviderActions {
  addProvider: (provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateProvider: (id: string, updates: Partial<Provider>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  setDefault: (id: string) => Promise<void>;
  getDecryptedKey: (id: string) => Promise<string>;
  loadProviders: () => Promise<void>;
  saveProviders: () => Promise<void>;
  initialize: () => Promise<void>;
  isInitialized: () => boolean;
}

export const useProviderStore = create<ProviderState & ProviderActions>((set, get) => ({
  providers: [],
  activeProviderId: null,

  /**
   * 初始化 Store
   * 确保存储目录存在并加载 providers
   * 多次调用会返回同一个 Promise
   */
  initialize: async () => {
    // 已经初始化完成
    if (initialized) return;

    // 正在初始化中，返回现有 Promise
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      try {
        await initializeStorage();
        await get().loadProviders();
        initialized = true;
      } catch (error) {
        console.error('Failed to initialize provider store:', error);
        initPromise = null;
        throw error;
      }
    })();

    return initPromise;
  },

  /**
   * 检查是否已初始化
   */
  isInitialized: () => initialized,

  addProvider: async (provider) => {
    const { name, agentType, apiType, apiKey, baseUrl, defaultModel, isDefault } = provider;

    // 验证 API Key 格式（支持第三方）
    const formatCheck = validateKeyFormat(apiType, apiKey, baseUrl);
    if (!formatCheck.valid) {
      console.error('[ProviderStore] API Key format invalid:', formatCheck.message);
      throw new Error(formatCheck.message);
    }

    // 生成新 Provider（明文存储 API Key）
    const now = new Date().toISOString();
    const adapterType = AGENT_TO_ADAPTER[agentType];

    const newProvider: Provider = {
      id: generateId(),
      name,
      agentType,
      adapterType,
      apiType,
      apiKey,  // 明文存储
      baseUrl,
      defaultModel,
      isDefault,
      createdAt: now,
      updatedAt: now,
    };

    // 如果设置为默认，更新同 agentType 的其他 Provider
    let updatedProviders = [...get().providers];
    if (isDefault) {
      updatedProviders = updatedProviders.map(p =>
        p.agentType === agentType ? { ...p, isDefault: false } : p
      );
    }

    updatedProviders.push(newProvider);

    // 更新状态并保存
    set({
      providers: updatedProviders,
      activeProviderId: isDefault ? newProvider.id : get().activeProviderId,
    });

    await get().saveProviders();

    // 如果设置为默认，重新配置 Agent
    if (isDefault) {
      await reconfigureAgentWithProvider(newProvider);
    }
  },

  updateProvider: async (id, updates) => {
    const { providers } = get();

    // 如果更新 API Key，验证格式
    if (updates.apiKey) {
      const provider = providers.find(p => p.id === id);
      if (provider) {
        const formatCheck = validateKeyFormat(provider.apiType, updates.apiKey, updates.baseUrl || provider.baseUrl);
        if (!formatCheck.valid) {
          throw new Error(formatCheck.message);
        }
      }
    }

    // 获取更新后的 provider 用于判断 agentType
    const existingProvider = providers.find(p => p.id === id);
    const targetAgentType = updates.agentType ?? existingProvider?.agentType;

    // 如果设置为默认，更新同 agentType 的其他 Provider
    let updatedProviders = providers.map(p => {
      if (p.id === id) {
        return { ...p, ...updates, updatedAt: new Date().toISOString() };
      }
      if (updates.isDefault && p.agentType === targetAgentType) {
        return { ...p, isDefault: false };
      }
      return p;
    });

    set({
      providers: updatedProviders,
      activeProviderId: updates.isDefault ? id : get().activeProviderId,
    });

    await get().saveProviders();
  },

  deleteProvider: async (id) => {
    const { providers, activeProviderId } = get();
    const updatedProviders = providers.filter(p => p.id !== id);

    set({
      providers: updatedProviders,
      activeProviderId: activeProviderId === id ? null : activeProviderId,
    });

    await get().saveProviders();
  },

  setDefault: async (id) => {
    const { providers } = get();
    const updatedProviders = providers.map(p => ({
      ...p,
      isDefault: p.id === id,
    }));

    set({ providers: updatedProviders, activeProviderId: id });
    await get().saveProviders();

    // 重新配置 Agent 使用新的默认 Provider
    const defaultProvider = updatedProviders.find(p => p.id === id);
    if (defaultProvider) {
      await reconfigureAgentWithProvider(defaultProvider);
    }
  },

  getDecryptedKey: async (id) => {
    const { providers } = get();
    const provider = providers.find(p => p.id === id);
    if (!provider) {
      console.error(`Provider not found: ${id}`);
      return '';
    }
    // 明文存储，直接返回
    return provider.apiKey;
  },

  loadProviders: async () => {
    try {
      // 使用异步路径，确保路径正确
      const dataPath = await getUserDataPathAsync();
      const filePath = `${dataPath}/providers.json`;
      const data = await readJsonFile<ProviderState>(filePath);
      if (data && Array.isArray(data.providers)) {
        set({
          providers: data.providers,
          activeProviderId: data.activeProviderId || null,
        });
      } else if (data) {
        // 文件存在但数据格式不正确，可能是损坏
        console.warn('[ProviderStore] Providers data format invalid, resetting to empty state');
        set({ providers: [], activeProviderId: null });
        // 尝试备份损坏的文件
        await backupAndResetProviders(filePath);
      }
    } catch (error) {
      console.error('[ProviderStore] Failed to load providers:', error);
      // 检查是否是 JSON 解析错误（文件损坏）
      if (error instanceof SyntaxError) {
        console.warn('[ProviderStore] Providers file may be corrupted, resetting');
        const dataPath = await getUserDataPathAsync();
        const filePath = `${dataPath}/providers.json`;
        await backupAndResetProviders(filePath);
      }
      // 加载失败时保持空状态
    }
  },

  saveProviders: async () => {
    try {
      const { providers, activeProviderId } = get();
      // 使用异步路径，确保路径正确
      const dataPath = await getUserDataPathAsync();
      const filePath = `${dataPath}/providers.json`;

      // 确保目录存在
      await ensureDir(dataPath);

      // 构建保存数据
      const data = {
        providers,
        activeProviderId,
      };

      const success = await writeJsonFile(filePath, data);

      if (!success) {
        console.error('[ProviderStore] Failed to save providers');
      }
    } catch (error) {
      console.error('[ProviderStore] Failed to save providers:', error);
    }
  },
}));
