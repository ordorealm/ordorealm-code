/**
 * Remote Control Store
 * @module stores/remote-control-store
 *
 * 管理远程控制的状态、通道连接和设置
 */

import { create } from 'zustand'
import type {
  RemoteControlSettings,
  Channel,
  ChannelType,
  ChannelStatus,
  RemoteControlStatus,
  RemoteControlApi
} from '../../../shared/types/remote-control'
import { REMOTE_CONTROL_CONSTRAINTS } from '../../../shared/types/remote-control'

/**
 * 远程控制 Store 状态
 */
interface RemoteControlState {
  /** 远程控制设置 */
  settings: RemoteControlSettings
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
  /** 是否已初始化 */
  initialized: boolean
  /** 正在连接的通道 ID */
  connectingChannelId: string | null
  /** 扫码倒计时（秒） */
  scanCountdown: number
  /** 事件监听清理函数 */
  cleanupFns: Array<() => void>
}

/**
 * 远程控制 Store 操作
 */
interface RemoteControlActions {
  /** 加载设置 */
  loadSettings: () => Promise<void>
  /** 更新设置 */
  updateSettings: (partial: Partial<RemoteControlSettings>) => Promise<void>
  /** 启用远程控制 */
  enable: () => Promise<void>
  /** 禁用远程控制 */
  disable: () => Promise<void>
  /** 连接通道 */
  connectChannel: (channelType: ChannelType) => Promise<{ qrCode: string; channelId: string }>
  /** 断开通道 */
  disconnectChannel: (channelId: string) => Promise<void>
  /** 刷新状态 */
  refresh: () => Promise<void>
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
  /** 设置错误 */
  setError: (error: string | null) => void
  /** 设置扫码倒计时 */
  setScanCountdown: (seconds: number) => void
  /** 更新通道状态（内部使用） */
  updateChannel: (channelId: string, updates: Partial<Channel>) => void
  /** 初始化 */
  initialize: () => void
  /** 清理 */
  cleanup: () => void
}

/**
 * 默认远程控制设置
 */
const DEFAULT_SETTINGS: RemoteControlSettings = {
  enabled: false,
  requireConfirm: true,
  channels: []
}

/**
 * 检查远程控制 API 是否可用
 */
function isRemoteControlApiAvailable(): boolean {
  const win = window as unknown as { api?: { remoteControl?: unknown } }
  const available = typeof window !== 'undefined' &&
    win.api !== undefined &&
    win.api.remoteControl !== undefined
  if (!available) {
    console.warn('[Remote Control Store] window.api.remoteControl 不可用，使用默认值')
  }
  return available
}

/**
 * 获取远程控制 API
 */
function getRemoteControlApi(): RemoteControlApi | null {
  if (!isRemoteControlApiAvailable()) {
    return null
  }
  return (window as unknown as { api: { remoteControl: RemoteControlApi } }).api.remoteControl
}

/**
 * 远程控制 Store
 */
export const useRemoteControlStore = create<RemoteControlState & RemoteControlActions>((set, get) => ({
  // 初始状态
  settings: DEFAULT_SETTINGS,
  isLoading: false,
  error: null,
  initialized: false,
  connectingChannelId: null,
  scanCountdown: 0,
  cleanupFns: [],

  // 操作
  /**
   * 加载远程控制设置
   */
  loadSettings: async () => {
    const api = getRemoteControlApi()
    if (!api) {
      set({ settings: DEFAULT_SETTINGS })
      return
    }

    try {
      const status = await api.getStatus()
      set({
        settings: {
          enabled: status.enabled,
          requireConfirm: status.requireConfirm,
          channels: status.channels.map(c => ({
            id: c.id,
            type: c.type,
            status: c.status,
            connectedAt: c.connectedAt,
            authToken: '' // authToken 不从状态获取
          }))
        }
      })
      console.log('[Remote Control Store] 设置加载成功')
    } catch (err) {
      console.error('[Remote Control Store] 加载设置失败:', err)
      set({ error: String(err), settings: DEFAULT_SETTINGS })
    }
  },

  /**
   * 更新远程控制设置
   * @param partial - 部分设置更新
   */
  updateSettings: async (partial: Partial<RemoteControlSettings>) => {
    const api = getRemoteControlApi()
    if (!api) {
      // 优雅降级：直接更新本地状态
      set(state => ({
        settings: { ...state.settings, ...partial }
      }))
      console.log('[Remote Control Store] 本地更新设置（API 不可用）')
      return
    }

    try {
      const result = await api.updateSettings(partial)
      if (result.success) {
        set(state => ({
          settings: { ...state.settings, ...partial }
        }))
        console.log('[Remote Control Store] 设置更新成功')
      } else {
        throw new Error('更新设置失败')
      }
    } catch (err) {
      console.error('[Remote Control Store] 更新设置失败:', err)
      set({ error: String(err) })
      throw err
    }
  },

  /**
   * 启用远程控制
   */
  enable: async () => {
    const { updateSettings } = get()
    await updateSettings({ enabled: true })
    console.log('[Remote Control Store] 远程控制已启用')
  },

  /**
   * 禁用远程控制
   */
  disable: async () => {
    const { updateSettings } = get()
    await updateSettings({ enabled: false })
    console.log('[Remote Control Store] 远程控制已禁用')
  },

  /**
   * 连接远程控制通道
   * @param channelType - 通道类型
   * @returns Promise resolving to QR code and channel ID
   */
  connectChannel: async (channelType: ChannelType) => {
    const api = getRemoteControlApi()
    if (!api) {
      throw new Error('远程控制 API 不可用')
    }

    // 检查通道数量限制
    const { settings } = get()
    if (settings.channels.length >= REMOTE_CONTROL_CONSTRAINTS.MAX_CHANNELS) {
      throw new Error(`已达到最大通道数量限制（${REMOTE_CONTROL_CONSTRAINTS.MAX_CHANNELS}）`)
    }

    try {
      set({ connectingChannelId: 'pending', scanCountdown: 60 })
      console.log(`[Remote Control Store] 开始连接 ${channelType} 通道`)

      const result = await api.connect(channelType)

      // 添加新通道到列表
      const newChannel: Channel = {
        id: result.channelId,
        type: channelType,
        status: 'pending',
        connectedAt: null,
        authToken: ''
      }

      set(state => ({
        connectingChannelId: result.channelId,
        settings: {
          ...state.settings,
          channels: [...state.settings.channels, newChannel]
        }
      }))

      console.log(`[Remote Control Store] 通道 ${result.channelId} 连接中，等待扫码`)
      return result
    } catch (err) {
      console.error(`[Remote Control Store] 连接 ${channelType} 通道失败:`, err)
      set({ connectingChannelId: null, scanCountdown: 0, error: String(err) })
      throw err
    }
  },

  /**
   * 断开远程控制通道
   * @param channelId - 通道 ID
   */
  disconnectChannel: async (channelId: string) => {
    const api = getRemoteControlApi()
    if (!api) {
      // 优雅降级：直接从本地状态移除
      set(state => ({
        settings: {
          ...state.settings,
          channels: state.settings.channels.filter(c => c.id !== channelId)
        }
      }))
      console.log(`[Remote Control Store] 本地移除通道 ${channelId}（API 不可用）`)
      return
    }

    try {
      const result = await api.disconnect(channelId)
      if (result.success) {
        set(state => ({
          settings: {
            ...state.settings,
            channels: state.settings.channels.filter(c => c.id !== channelId)
          }
        }))
        console.log(`[Remote Control Store] 通道 ${channelId} 已断开`)
      } else {
        throw new Error('断开通道失败')
      }
    } catch (err) {
      console.error(`[Remote Control Store] 断开通道 ${channelId} 失败:`, err)
      set({ error: String(err) })
      throw err
    }
  },

  /**
   * 刷新远程控制状态
   */
  refresh: async () => {
    const { loadSettings } = get()
    set({ isLoading: true, error: null })

    try {
      await loadSettings()
    } catch (err) {
      set({ error: String(err) })
    } finally {
      set({ isLoading: false })
    }
  },

  /**
   * 设置加载状态
   * @param loading - 是否正在加载
   */
  setLoading: (loading: boolean) => set({ isLoading: loading }),

  /**
   * 设置错误信息
   * @param error - 错误信息
   */
  setError: (error: string | null) => set({ error }),

  /**
   * 设置扫码倒计时
   * @param seconds - 倒计时秒数
   */
  setScanCountdown: (seconds: number) => set({ scanCountdown: seconds }),

  /**
   * 更新通道状态（内部使用）
   * @param channelId - 通道 ID
   * @param updates - 通道更新内容
   */
  updateChannel: (channelId: string, updates: Partial<Channel>) => {
    set(state => ({
      settings: {
        ...state.settings,
        channels: state.settings.channels.map(c =>
          c.id === channelId ? { ...c, ...updates } : c
        )
      }
    }))
  },

  /**
   * 初始化 Store（设置事件监听）
   */
  initialize: () => {
    const state = get()
    if (state.initialized) return

    const cleanupFns: Array<() => void> = []
    const api = getRemoteControlApi()

    if (api) {
      // 设置状态变更监听
      if (api.onStatusChange) {
        cleanupFns.push(
          api.onStatusChange((status: RemoteControlStatus) => {
            set(state => ({
              settings: {
                ...state.settings,
                enabled: status.enabled,
                requireConfirm: status.requireConfirm,
                channels: status.channels.map(c => ({
                  id: c.id,
                  type: c.type,
                  status: c.status,
                  connectedAt: c.connectedAt,
                  authToken: state.settings.channels.find(ch => ch.id === c.id)?.authToken || ''
                }))
              }
            }))
          })
        )
      }

      // 设置通道状态变更监听
      if (api.onChannelStatusChange) {
        cleanupFns.push(
          api.onChannelStatusChange((event: { channelId: string; status: ChannelStatus }) => {
            const { updateChannel, setScanCountdown } = get()
            updateChannel(event.channelId, { status: event.status })

            // 如果通道已连接，清除扫码倒计时
            if (event.status === 'connected') {
              setScanCountdown(0)
              console.log(`[Remote Control Store] 通道 ${event.channelId} 已连接`)
            }
          })
        )
      }
    }

    // 初始加载
    get().loadSettings()

    set({
      initialized: true,
      cleanupFns
    })

    console.log('[Remote Control Store] 已初始化')
  },

  /**
   * 清理事件监听
   */
  cleanup: () => {
    const { cleanupFns } = get()
    cleanupFns.forEach(fn => fn())
    set({
      initialized: false,
      cleanupFns: [],
      connectingChannelId: null,
      scanCountdown: 0
    })
    console.log('[Remote Control Store] 已清理')
  }
}))

// ============ 辅助函数 ============

/**
 * 获取通道状态显示名称
 * @param status - 通道状态
 * @returns 状态显示名称
 */
export function getChannelStatusName(status: ChannelStatus): string {
  const names: Record<ChannelStatus, string> = {
    connected: '已连接',
    disconnected: '已断开',
    pending: '等待连接'
  }
  return names[status]
}

/**
 * 获取通道类型显示名称
 * @param type - 通道类型
 * @returns 类型显示名称
 */
export function getChannelTypeName(type: ChannelType): string {
  const names: Record<ChannelType, string> = {
    wechat: '微信 ClawBot',
    wecom: '企业微信',
    feishu: '飞书'
  }
  return names[type]
}

/**
 * 获取已连接通道数量
 * @returns 已连接通道数量
 */
export function getConnectedChannelCount(): number {
  const { settings } = useRemoteControlStore.getState()
  return settings.channels.filter(c => c.status === 'connected').length
}

/**
 * 检查是否可以添加更多通道
 * @returns 是否可以添加更多通道
 */
export function canAddMoreChannels(): boolean {
  const { settings } = useRemoteControlStore.getState()
  return settings.channels.length < REMOTE_CONTROL_CONSTRAINTS.MAX_CHANNELS
}

/**
 * 获取远程控制设置
 * @returns 远程控制设置
 */
export function getRemoteControlSettings(): RemoteControlSettings {
  return useRemoteControlStore.getState().settings
}

/**
 * 检查远程控制是否已启用
 * @returns 是否已启用
 */
export function isRemoteControlEnabled(): boolean {
  return useRemoteControlStore.getState().settings.enabled
}

/**
 * 获取指定通道
 * @param channelId - 通道 ID
 * @returns 通道信息或 undefined
 */
export function getChannel(channelId: string): Channel | undefined {
  return useRemoteControlStore.getState().settings.channels.find(c => c.id === channelId)
}

/**
 * 检查通道是否已连接
 * @param channelId - 通道 ID
 * @returns 是否已连接
 */
export function isChannelConnected(channelId: string): boolean {
  const channel = getChannel(channelId)
  return channel?.status === 'connected'
}

/**
 * 获取所有已连接的通道
 * @returns 已连接通道列表
 */
export function getConnectedChannels(): Channel[] {
  const { settings } = useRemoteControlStore.getState()
  return settings.channels.filter(c => c.status === 'connected')
}
