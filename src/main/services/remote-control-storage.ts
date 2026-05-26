/**
 * 远程控制配置存储服务
 *
 * 负责远程控制配置的持久化存储，使用加密保护敏感数据。
 * 存储位置：{userData}/remote-control/
 *
 * @module remote-control-storage
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { encrypt, decrypt, generateId } from '../utils/encryption';
import type { RemoteControlSettings, Channel } from '../../shared/types/remote-control';

/**
 * 默认远程控制配置
 */
const DEFAULT_SETTINGS: RemoteControlSettings = {
  enabled: false,
  requireConfirm: true,
  channels: []
};

/**
 * 远程控制配置存储类
 *
 * 管理远程控制配置的持久化存储，包括：
 * - settings.json: 配置信息（加密存储）
 * - tokens/{channelId}.enc: 通道授权令牌（加密存储）
 *
 * @example
 * ```typescript
 * const storage = new RemoteControlStorage();
 * await storage.initialize();
 *
 * // 加载配置
 * const settings = await storage.loadSettings();
 *
 * // 保存令牌
 * await storage.saveChannelToken('wechat-123', 'my-secret-token');
 * ```
 */
export class RemoteControlStorage {
  /** 存储根目录 */
  private storageDir: string;

  /** 令牌存储目录 */
  private tokensDir: string;

  /** 配置文件路径 */
  private settingsPath: string;

  /** 是否已初始化 */
  private initialized: boolean = false;

  /**
   * 创建 RemoteControlStorage 实例
   *
   * @param customDataPath - 可选的自定义数据路径（用于测试）
   * 如果不提供，则使用 Electron 的 userData 目录。
   */
  constructor(customDataPath?: string) {
    const userDataPath = customDataPath || app.getPath('userData');
    this.storageDir = path.join(userDataPath, 'remote-control');
    this.tokensDir = path.join(this.storageDir, 'tokens');
    this.settingsPath = path.join(this.storageDir, 'settings.json');

    console.log('[RemoteControlStorage] Storage paths configured:');
    console.log('  - Storage dir:', this.storageDir);
    console.log('  - Tokens dir:', this.tokensDir);
    console.log('  - Settings path:', this.settingsPath);
  }

  /**
   * 初始化存储目录
   *
   * 创建必要的存储目录结构，如果目录已存在则不执行任何操作。
   * 必须在使用其他方法前调用此方法。
   *
   * @throws Error 如果目录创建失败
   */
  async initialize(): Promise<void> {
    console.log('[RemoteControlStorage] Initializing storage...');

    try {
      // 创建存储根目录
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
        console.log('[RemoteControlStorage] Created storage directory:', this.storageDir);
      }

      // 创建令牌存储目录
      if (!fs.existsSync(this.tokensDir)) {
        fs.mkdirSync(this.tokensDir, { recursive: true });
        console.log('[RemoteControlStorage] Created tokens directory:', this.tokensDir);
      }

      this.initialized = true;
      console.log('[RemoteControlStorage] Storage initialized successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to initialize storage:', errorMessage);
      throw new Error(`Failed to initialize storage: ${errorMessage}`);
    }
  }

  /**
   * 确保存储已初始化
   *
   * @throws Error 如果存储未初始化
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('RemoteControlStorage not initialized. Call initialize() first.');
    }
  }

  /**
   * 读取远程控制设置
   *
   * 从 settings.json 加载配置，如果文件不存在则返回默认配置。
   * 配置文件使用加密存储，加载时会自动解密。
   *
   * @returns 配置对象，如果文件不存在或解密失败则返回默认配置
   */
  async getSettings(): Promise<RemoteControlSettings> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Loading settings...');

    try {
      // 文件不存在，返回默认配置
      if (!fs.existsSync(this.settingsPath)) {
        console.log('[RemoteControlStorage] Settings file not found, returning default settings');
        return { ...DEFAULT_SETTINGS, channels: [] };
      }

      // 读取并解密配置
      const encryptedContent = fs.readFileSync(this.settingsPath, 'utf8');
      const decryptedContent = decrypt(encryptedContent);
      const settings = JSON.parse(decryptedContent) as RemoteControlSettings;

      console.log('[RemoteControlStorage] Settings loaded successfully');
      console.log('  - Enabled:', settings.enabled);
      console.log('  - Require confirm:', settings.requireConfirm);
      console.log('  - Channels count:', settings.channels.length);

      return settings;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to load settings:', errorMessage);
      console.log('[RemoteControlStorage] Returning default settings due to error');
      return { ...DEFAULT_SETTINGS, channels: [] };
    }
  }

  /**
   * 加载配置（别名，保持向后兼容）
   *
   * @deprecated 请使用 getSettings() 方法
   * @returns 配置对象
   */
  async loadSettings(): Promise<RemoteControlSettings> {
    return this.getSettings();
  }

  /**
   * 保存配置
   *
   * 将配置加密后保存到 settings.json。
   *
   * @param settings - 要保存的配置对象
   * @throws Error 如果保存失败
   */
  async saveSettings(settings: RemoteControlSettings): Promise<void> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Saving settings...');
    console.log('  - Enabled:', settings.enabled);
    console.log('  - Require confirm:', settings.requireConfirm);
    console.log('  - Channels count:', settings.channels.length);

    try {
      const content = JSON.stringify(settings, null, 2);
      const encryptedContent = encrypt(content);

      fs.writeFileSync(this.settingsPath, encryptedContent, 'utf8');
      console.log('[RemoteControlStorage] Settings saved successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to save settings:', errorMessage);
      throw new Error(`Failed to save settings: ${errorMessage}`);
    }
  }

  /**
   * 更新设置（部分更新）
   *
   * 合并部分设置到现有配置中，并保存。
   *
   * @param partial - 要更新的部分配置
   * @returns 更新后的完整配置
   * @throws Error 如果更新或保存失败
   */
  async updateSettings(partial: Partial<RemoteControlSettings>): Promise<RemoteControlSettings> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Updating settings...');
    console.log('  - Partial keys:', Object.keys(partial).join(', '));

    try {
      const currentSettings = await this.getSettings();
      const updatedSettings: RemoteControlSettings = {
        ...currentSettings,
        ...partial
      };

      await this.saveSettings(updatedSettings);
      console.log('[RemoteControlStorage] Settings updated successfully');

      return updatedSettings;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to update settings:', errorMessage);
      throw new Error(`Failed to update settings: ${errorMessage}`);
    }
  }

  /**
   * 添加通道
   *
   * 向配置中添加新的通道，如果通道没有 ID 则自动生成。
   *
   * @param channel - 要添加的通道（id 可选，会自动生成）
   * @throws Error 如果添加或保存失败
   */
  async addChannel(channel: Omit<Channel, 'id'> & { id?: string }): Promise<void> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Adding channel...');
    console.log('  - Type:', channel.type);
    console.log('  - Status:', channel.status);

    try {
      const settings = await this.getSettings();
      const newChannel: Channel = {
        ...channel,
        id: channel.id || generateId()
      };

      settings.channels.push(newChannel);
      await this.saveSettings(settings);

      console.log('[RemoteControlStorage] Channel added successfully');
      console.log('  - Channel ID:', newChannel.id);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to add channel:', errorMessage);
      throw new Error(`Failed to add channel: ${errorMessage}`);
    }
  }

  /**
   * 移除通道
   *
   * 从配置中移除指定通道，同时删除对应的令牌文件。
   *
   * @param channelId - 要移除的通道 ID
   * @throws Error 如果移除失败
   */
  async removeChannel(channelId: string): Promise<void> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Removing channel...');
    console.log('  - Channel ID:', channelId);

    try {
      const settings = await this.getSettings();
      const channelIndex = settings.channels.findIndex(c => c.id === channelId);

      if (channelIndex === -1) {
        console.log('[RemoteControlStorage] Channel not found, nothing to remove');
        return;
      }

      // 移除通道
      settings.channels.splice(channelIndex, 1);
      await this.saveSettings(settings);

      // 删除对应的令牌文件
      await this.deleteChannelToken(channelId);

      console.log('[RemoteControlStorage] Channel removed successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to remove channel:', errorMessage);
      throw new Error(`Failed to remove channel: ${errorMessage}`);
    }
  }

  /**
   * 更新通道状态
   *
   * 更新指定通道的连接状态和连接时间。
   *
   * @param channelId - 通道 ID
   * @param status - 新的状态
   * @throws Error 如果更新失败
   */
  async updateChannelStatus(channelId: string, status: Channel['status']): Promise<void> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Updating channel status...');
    console.log('  - Channel ID:', channelId);
    console.log('  - New status:', status);

    try {
      const settings = await this.getSettings();
      const channel = settings.channels.find(c => c.id === channelId);

      if (!channel) {
        console.error('[RemoteControlStorage] Channel not found:', channelId);
        throw new Error(`Channel not found: ${channelId}`);
      }

      channel.status = status;
      channel.connectedAt = status === 'connected' ? new Date().toISOString() : null;

      await this.saveSettings(settings);
      console.log('[RemoteControlStorage] Channel status updated successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to update channel status:', errorMessage);
      throw new Error(`Failed to update channel status: ${errorMessage}`);
    }
  }

  /**
   * 保存通道令牌
   *
   * 将通道的授权令牌加密后保存到 tokens/{channelId}.enc。
   * 令牌以明文形式传入，会被自动加密存储。
   *
   * @param channelId - 通道唯一标识
   * @param token - 明文令牌，将被加密存储
   * @throws Error 如果保存失败
   */
  async saveChannelToken(channelId: string, token: string): Promise<void> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Saving channel token...');
    console.log('  - Channel ID:', channelId);

    try {
      const tokenPath = path.join(this.tokensDir, `${channelId}.enc`);
      const encryptedToken = encrypt(token);

      fs.writeFileSync(tokenPath, encryptedToken, 'utf8');
      console.log('[RemoteControlStorage] Channel token saved successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to save channel token:', errorMessage);
      throw new Error(`Failed to save channel token: ${errorMessage}`);
    }
  }

  /**
   * 读取通道令牌
   *
   * 从 tokens/{channelId}.enc 加载并解密通道令牌。
   *
   * @param channelId - 通道唯一标识
   * @returns 解密后的令牌，如果文件不存在或解密失败则返回 null
   */
  async getChannelToken(channelId: string): Promise<string | null> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Loading channel token...');
    console.log('  - Channel ID:', channelId);

    const tokenPath = path.join(this.tokensDir, `${channelId}.enc`);

    try {
      // 文件不存在
      if (!fs.existsSync(tokenPath)) {
        console.log('[RemoteControlStorage] Token file not found, returning null');
        return null;
      }

      const encryptedToken = fs.readFileSync(tokenPath, 'utf8');
      const token = decrypt(encryptedToken);

      console.log('[RemoteControlStorage] Channel token loaded successfully');
      return token;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to load channel token:', errorMessage);
      console.log('[RemoteControlStorage] Returning null due to error');
      return null;
    }
  }

  /**
   * 加载通道令牌（别名，保持向后兼容）
   *
   * @deprecated 请使用 getChannelToken() 方法
   * @param channelId - 通道唯一标识
   * @returns 解密后的令牌
   */
  async loadChannelToken(channelId: string): Promise<string | null> {
    return this.getChannelToken(channelId);
  }

  /**
   * 删除通道令牌
   *
   * 删除 tokens/{channelId}.enc 文件。
   * 如果文件不存在则不执行任何操作。
   *
   * @param channelId - 通道唯一标识
   * @throws Error 如果删除失败（非文件不存在的情况）
   */
  async deleteChannelToken(channelId: string): Promise<void> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Deleting channel token...');
    console.log('  - Channel ID:', channelId);

    const tokenPath = path.join(this.tokensDir, `${channelId}.enc`);

    try {
      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
        console.log('[RemoteControlStorage] Channel token deleted successfully');
      } else {
        console.log('[RemoteControlStorage] Token file not found, nothing to delete');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to delete channel token:', errorMessage);
      throw new Error(`Failed to delete channel token: ${errorMessage}`);
    }
  }

  /**
   * 清除所有数据
   *
   * 删除所有存储的配置和令牌文件。
   * 用于重置远程控制功能或清除敏感数据。
   *
   * @throws Error 如果清除失败
   */
  async clearAll(): Promise<void> {
    this.ensureInitialized();
    console.log('[RemoteControlStorage] Clearing all data...');

    try {
      // 删除配置文件
      if (fs.existsSync(this.settingsPath)) {
        fs.unlinkSync(this.settingsPath);
        console.log('[RemoteControlStorage] Settings file deleted');
      }

      // 删除所有令牌文件
      if (fs.existsSync(this.tokensDir)) {
        const tokenFiles = fs.readdirSync(this.tokensDir);
        for (const file of tokenFiles) {
          const filePath = path.join(this.tokensDir, file);
          fs.unlinkSync(filePath);
          console.log('[RemoteControlStorage] Token file deleted:', file);
        }
      }

      console.log('[RemoteControlStorage] All data cleared successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[RemoteControlStorage] Failed to clear all data:', errorMessage);
      throw new Error(`Failed to clear all data: ${errorMessage}`);
    }
  }

  /**
   * 获取存储目录路径
   *
   * 返回存储根目录的绝对路径，用于调试或外部访问。
   *
   * @returns 存储目录的绝对路径
   */
  getDataDir(): string {
    return this.storageDir;
  }

  /**
   * 获取存储目录路径（别名）
   *
   * 返回存储根目录的绝对路径，用于调试或外部访问。
   *
   * @returns 存储目录的绝对路径
   */
  getStorageDir(): string {
    return this.storageDir;
  }

  /**
   * 获取令牌目录路径
   *
   * 返回令牌存储目录的绝对路径。
   *
   * @returns 令牌目录的绝对路径
   */
  getTokensDir(): string {
    return this.tokensDir;
  }

  /**
   * 检查是否已初始化
   *
   * @returns 是否已调用 initialize() 方法
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * 创建默认的 RemoteControlStorage 实例
 *
 * 工厂函数，用于创建并初始化存储实例。
 *
 * @returns 已初始化的 RemoteControlStorage 实例
 * @example
 * ```typescript
 * const storage = await createRemoteControlStorage();
 * const settings = await storage.loadSettings();
 * ```
 */
export async function createRemoteControlStorage(): Promise<RemoteControlStorage> {
  const storage = new RemoteControlStorage();
  await storage.initialize();
  return storage;
}
