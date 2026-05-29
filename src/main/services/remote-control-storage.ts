/**
 * Remote Control Storage
 *
 * 简化为单账号模式的持久化存储。
 *
 * 存储结构：
 * - settings.json: 配置 + 连接信息（加密）
 *
 * @module main/services/remote-control-storage
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { encrypt, decrypt } from '../utils/encryption'
import { Logger } from '../utils/logger'
import type { RemoteControlSettings, ConnectionInfo } from '../../shared/types/remote-control'

// ============ Defaults ============

const DEFAULT_SETTINGS: RemoteControlSettings = {
  enabled: false,
  requireConfirm: true,
  connection: null,
}

// ============ Storage Class ============

export class RemoteControlStorage {
  private storageDir: string
  private settingsPath: string
  private initialized: boolean = false
  private logger: Logger

  constructor(customDataPath?: string) {
    const userDataPath = customDataPath || app.getPath('userData')
    this.storageDir = path.join(userDataPath, 'remote-control')
    this.settingsPath = path.join(this.storageDir, 'settings.json')
    this.logger = new Logger('RemoteControlStorage')
  }

  /**
   * Initialize storage directories
   */
  async initialize(): Promise<void> {
    this.logger.info('Initializing...')

    try {
      if (!fs.existsSync(this.storageDir)) {
        await fs.promises.mkdir(this.storageDir, { recursive: true })
        this.logger.info('Created storage directory')
      }

      this.initialized = true
      this.logger.info('Initialized successfully')
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      this.logger.error('Failed to initialize:', msg)
      throw new Error(`Failed to initialize storage: ${msg}`)
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('RemoteControlStorage not initialized. Call initialize() first.')
    }
  }

  /**
   * Get settings
   */
  async getSettings(): Promise<RemoteControlSettings> {
    this.ensureInitialized()

    try {
      if (!fs.existsSync(this.settingsPath)) {
        return { ...DEFAULT_SETTINGS }
      }

      const encrypted = await fs.promises.readFile(this.settingsPath, 'utf8')
      const decrypted = decrypt(encrypted)
      const settings = JSON.parse(decrypted) as RemoteControlSettings

      this.logger.debug('Settings loaded:', {
        enabled: settings.enabled,
        requireConfirm: settings.requireConfirm,
        hasConnection: !!settings.connection,
      })

      return settings
    } catch (error) {
      this.logger.error('Failed to load settings, using defaults:', error)
      return { ...DEFAULT_SETTINGS }
    }
  }

  /**
   * Save settings
   */
  async saveSettings(settings: RemoteControlSettings): Promise<void> {
    this.ensureInitialized()

    this.logger.debug('Saving settings:', {
      enabled: settings.enabled,
      requireConfirm: settings.requireConfirm,
    })

    try {
      const content = JSON.stringify(settings, null, 2)
      const encrypted = encrypt(content)
      await fs.promises.writeFile(this.settingsPath, encrypted, 'utf8')
      this.logger.debug('Settings saved')
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to save settings: ${msg}`)
    }
  }

  /**
   * Update settings (partial)
   */
  async updateSettings(partial: Partial<RemoteControlSettings>): Promise<RemoteControlSettings> {
    this.ensureInitialized()

    const current = await this.getSettings()
    const updated: RemoteControlSettings = {
      ...current,
      ...partial,
    }

    await this.saveSettings(updated)
    return updated
  }

  /**
   * Update connection info
   */
  async updateConnection(connection: ConnectionInfo | null): Promise<void> {
    this.ensureInitialized()

    const settings = await this.getSettings()
    settings.connection = connection
    await this.saveSettings(settings)

    this.logger.debug('Connection updated:', connection?.status)
  }

  /**
   * Clear all data
   */
  async clearAll(): Promise<void> {
    this.ensureInitialized()

    this.logger.info('Clearing all data...')

    try {
      if (fs.existsSync(this.settingsPath)) {
        await fs.promises.unlink(this.settingsPath)
      }
      this.logger.info('All data cleared')
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to clear data: ${msg}`)
    }
  }

  /**
   * Get storage directory
   */
  getStorageDir(): string {
    return this.storageDir
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }
}

// ============ Factory ============

export async function createRemoteControlStorage(): Promise<RemoteControlStorage> {
  const storage = new RemoteControlStorage()
  await storage.initialize()
  return storage
}
