/**
 * Remote Control Store
 *
 * 简化为单账号模式的状态管理。
 *
 * @module stores/remote-control-store
 */

import { create } from 'zustand'
import type {
  RemoteControlSettings,
  ConnectionStatus,
  ConnectionInfo,
  RemoteControlStatus,
  ConnectionChangeEvent,
  MessageReceivedEvent,
  ConfirmRequestEvent,
  ConfirmResponseEvent,
  SwitchProjectEvent,
} from '../../../shared/types/remote-control'

// ============ Types ============

interface RemoteControlState {
  /** Settings */
  settings: RemoteControlSettings
  /** Loading state */
  isLoading: boolean
  /** Error message */
  error: string | null
  /** Initialized */
  initialized: boolean
  /** Connecting state */
  isConnecting: boolean
  /** Event cleanup functions */
  cleanupFns: Array<() => void>
}

interface RemoteControlActions {
  /** Load settings */
  loadSettings: () => Promise<void>
  /** Update settings */
  updateSettings: (partial: Partial<RemoteControlSettings>) => Promise<void>
  /** Enable remote control */
  enable: () => Promise<void>
  /** Disable remote control */
  disable: () => Promise<void>
  /** Connect */
  connect: () => Promise<{ qrCode: string; alreadyLoggedIn: boolean; userId?: string }>
  /** Disconnect */
  disconnect: () => Promise<void>
  /** Refresh */
  refresh: () => Promise<void>
  /** Set loading */
  setLoading: (loading: boolean) => void
  /** Set error */
  setError: (error: string | null) => void
  /** Initialize */
  initialize: () => void
  /** Cleanup */
  cleanup: () => void
}

// ============ Defaults ============

const DEFAULT_SETTINGS: RemoteControlSettings = {
  enabled: false,
  requireConfirm: true,
  connection: null,
}

// ============ API Helpers ============

function isApiAvailable(): boolean {
  const win = window as unknown as { api?: { remoteControl?: unknown } }
  return typeof window !== 'undefined' && win.api?.remoteControl !== undefined
}

function getApi() {
  if (!isApiAvailable()) return null
  return (window as unknown as { api: { remoteControl: RemoteControlApi } }).api.remoteControl
}

interface RemoteControlApi {
  getStatus(): Promise<{
    success: boolean
    data?: RemoteControlStatus
    error?: { code: string; message: string }
  }>
  connect(): Promise<{
    success: boolean
    data?: { qrCode: string; alreadyLoggedIn: boolean; userId?: string }
    error?: { code: string; message: string }
  }>
  disconnect(): Promise<{
    success: boolean
    data?: { success: boolean }
    error?: { code: string; message: string }
  }>
  updateSettings(request: { enabled?: boolean; requireConfirm?: boolean }): Promise<{
    success: boolean
    data?: { success: boolean }
    error?: { code: string; message: string }
  }>
  onConnectionChange?(callback: (event: ConnectionChangeEvent) => void): () => void
  onMessage?(callback: (event: MessageReceivedEvent) => void): () => void
  onConfirmRequest?(callback: (event: ConfirmRequestEvent) => void): () => void
  onConfirmResponse?(callback: (event: ConfirmResponseEvent) => void): () => void
  onSwitchProject?(callback: (event: SwitchProjectEvent) => void): () => void
}

// ============ Store ============

export const useRemoteControlStore = create<RemoteControlState & RemoteControlActions>((set, get) => ({
  // Initial state
  settings: DEFAULT_SETTINGS,
  isLoading: false,
  error: null,
  initialized: false,
  isConnecting: false,
  cleanupFns: [],

  // Actions

  loadSettings: async () => {
    if (!isApiAvailable()) {
      set({ settings: DEFAULT_SETTINGS })
      return
    }

    try {
      const api = getApi()!
      const response = await api.getStatus()

      // IPC returns { success: true, data: <RemoteControlStatus> }
      const status = response?.data
      if (!status) {
        console.warn('[RemoteControlStore] Empty status response')
        set({ settings: DEFAULT_SETTINGS })
        return
      }
      set({
        settings: {
          enabled: status.enabled ?? false,
          requireConfirm: status.requireConfirm ?? true,
          connection: status.connection ?? null,
        },
      })

      console.log('[RemoteControlStore] Settings loaded:', {
        enabled: status.enabled,
        connected: status.connected,
      })
    } catch (err) {
      console.error('[RemoteControlStore] Failed to load settings:', err)
      set({ error: String(err), settings: DEFAULT_SETTINGS })
    }
  },

  updateSettings: async (partial) => {
    if (!isApiAvailable()) {
      set((state) => ({
        settings: { ...state.settings, ...partial },
      }))
      return
    }

    try {
      const api = getApi()!
      const response = await api.updateSettings({
        enabled: partial.enabled,
        requireConfirm: partial.requireConfirm,
      })

      // Handler returns IpcResult<{success: boolean}> — check the wrapper
      if (response && (response as any).success === false) {
        const errMsg = (response as any).error?.message || 'Update settings failed'
        console.error('[RemoteControlStore] Update settings rejected:', errMsg)
        set({ error: errMsg })
        return
      }

      set((state) => ({
        settings: { ...state.settings, ...partial },
      }))

      console.log('[RemoteControlStore] Settings updated')
    } catch (err) {
      console.error('[RemoteControlStore] Failed to update settings:', err)
      set({ error: String(err) })
      throw err
    }
  },

  enable: async () => {
    const { updateSettings } = get()
    await updateSettings({ enabled: true })
    console.log('[RemoteControlStore] Enabled')
  },

  disable: async () => {
    const { updateSettings } = get()
    await updateSettings({ enabled: false })
    console.log('[RemoteControlStore] Disabled')
  },

  connect: async () => {
    if (!isApiAvailable()) {
      throw new Error('API not available')
    }

    try {
      set({ isConnecting: true })
      console.log('[RemoteControlStore] Connecting...')

      const api = getApi()!
      const response = await api.connect()

      // Check for error response
      if (!response.success || !response.data) {
        const errorMsg = response.error?.message || 'Connection failed'
        console.error('[RemoteControlStore] Connection failed:', errorMsg)
        set({ isConnecting: false, error: errorMsg })
        throw new Error(errorMsg)
      }

      const result = response.data

      if (result.alreadyLoggedIn) {
        console.log('[RemoteControlStore] Already logged in:', result.userId)
        // Update connection state
        set((state) => ({
          isConnecting: false,
          settings: {
            ...state.settings,
            connection: {
              status: 'connected',
              userId: result.userId ?? null,
              nickname: null,
              connectedAt: new Date().toISOString(),
              error: null,
            },
          },
        }))
      } else {
        console.log('[RemoteControlStore] QR code generated — connection pending')
        set({ isConnecting: false })
      }

      return result
    } catch (err) {
      console.error('[RemoteControlStore] Connection failed:', err)
      set({ isConnecting: false, error: String(err) })
      throw err
    }
  },

  disconnect: async () => {
    if (!isApiAvailable()) {
      set((state) => ({
        settings: {
          ...state.settings,
          connection: null,
        },
      }))
      return
    }

    try {
      const api = getApi()!
      const response = await api.disconnect()

      // Handler returns IpcResult<{success: boolean}> — check the wrapper
      if (response && (response as any).success === false) {
        const errMsg = (response as any).error?.message || 'Disconnect failed'
        console.error('[RemoteControlStore] Disconnect rejected:', errMsg)
        set({ error: errMsg })
        return
      }

      set((state) => ({
        settings: {
          ...state.settings,
          connection: {
            status: 'disconnected',
            userId: state.settings.connection?.userId ?? null,
            nickname: state.settings.connection?.nickname ?? null,
            connectedAt: null,
            error: null,
          },
        },
      }))

      console.log('[RemoteControlStore] Disconnected')
    } catch (err) {
      console.error('[RemoteControlStore] Disconnect failed:', err)
      set({ error: String(err) })
      throw err
    }
  },

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

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  initialize: async () => {
    const state = get()
    if (state.initialized) return

    const cleanupFns: Array<() => void> = []
    const api = getApi()

    if (api?.onConnectionChange) {
      cleanupFns.push(
        api.onConnectionChange((event) => {
          console.log('[RemoteControlStore] Connection changed:', event.status)

          set((state) => ({
            settings: {
              ...state.settings,
              connection: {
                status: event.status,
                userId: event.userId ?? state.settings.connection?.userId ?? null,
                nickname: event.nickname ?? state.settings.connection?.nickname ?? null,
                connectedAt: event.status === 'connected' ? new Date().toISOString() : null,
                error: event.error ?? null,
              },
            },
            isConnecting: event.status === 'pending',
          }))
        })
      )
    }

    if (api?.onMessage) {
      cleanupFns.push(
        api.onMessage((event) => {
          console.log('[RemoteControlStore] Message received:', event.content?.substring(0, 50))
          // Messages are handled by the store consumer (e.g., chat UI)
        })
      )
    }

    if (api?.onConfirmRequest) {
      cleanupFns.push(
        api.onConfirmRequest((event) => {
          console.log('[RemoteControlStore] Confirm request:', event.confirmId)
        })
      )
    }

    if (api?.onConfirmResponse) {
      cleanupFns.push(
        api.onConfirmResponse((event) => {
          console.log('[RemoteControlStore] Confirm response:', event.confirmId, event.confirmed)
        })
      )
    }

    if (api?.onSwitchProject) {
      cleanupFns.push(
        api.onSwitchProject((event) => {
          console.log('[RemoteControlStore] Switch project requested:', event.projectName)
          // The actual switch is handled by the UI layer listening to store changes
        })
      )
    }

    // Initial load — await so settings are ready before initialized flag is set
    try {
      await get().loadSettings()
    } catch (err) {
      console.error('[RemoteControlStore] Initial load failed:', err)
    }

    set({ initialized: true, cleanupFns })
    console.log('[RemoteControlStore] Initialized')
  },

  cleanup: () => {
    const { cleanupFns } = get()
    cleanupFns.forEach((fn) => fn())
    set({
      initialized: false,
      cleanupFns: [],
      isConnecting: false,
          })
    console.log('[RemoteControlStore] Cleaned up')
  },
}))

// ============ Helpers ============

/**
 * Get connection status display name
 */
export function getConnectionStatusName(status: ConnectionStatus): string {
  const names: Record<ConnectionStatus, string> = {
    connected: '已连接',
    disconnected: '未连接',
    pending: '连接中',
    error: '连接错误',
  }
  return names[status]
}

/**
 * Check if connected
 */
export function isConnected(): boolean {
  const { settings } = useRemoteControlStore.getState()
  return settings.connection?.status === 'connected'
}

/**
 * Check if remote control is enabled
 */
export function isRemoteControlEnabled(): boolean {
  return useRemoteControlStore.getState().settings.enabled
}

/**
 * Get current connection info
 */
export function getConnection(): ConnectionInfo | null {
  return useRemoteControlStore.getState().settings.connection
}

/**
 * Get settings
 */
export function getRemoteControlSettings(): RemoteControlSettings {
  return useRemoteControlStore.getState().settings
}
