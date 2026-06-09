/**
 * Remote Control Settings Component
 *
 * 简化为单账号模式的设置面板。
 *
 * @module components/settings/RemoteControlSettings
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  useRemoteControlStore,
  getConnectionStatusName,
  isConnected,
} from '@/stores/remote-control-store'
import { REMOTE_CONTROL_CONSTRAINTS } from '../../../../shared/types/remote-control'
import QRCode from 'qrcode'

interface RemoteControlSettingsProps {
  visible?: boolean
}

/**
 * Generate QR code SVG
 */
async function generateQRCodeSVG(data: string): Promise<string> {
  try {
    return await QRCode.toString(data, {
      type: 'svg',
      width: 200,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
  } catch (error) {
    console.error('Failed to generate QR code:', error)
    return `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <rect width="200" height="200" fill="white"/>
        <text x="100" y="100" text-anchor="middle" font-size="12" fill="red">QR生成失败</text>
      </svg>
    `
  }
}

/**
 * Connect Dialog Component
 */
function ConnectDialog({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}): JSX.Element | null {
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [qrCodeSvg, setQrCodeSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isGeneratingQR, setIsGeneratingQR] = useState(false)
  const [countdown, setCountdown] = useState(REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS / 1000)
  const [alreadyLoggedIn, setAlreadyLoggedIn] = useState(false)

  const { connect } = useRemoteControlStore()
  const connectionStatus = useRemoteControlStore((s) => s.settings.connection?.status)
  const connectStartedRef = useRef(false)

  // Handle connect
  const handleConnect = useCallback(async () => {
    // Guard against duplicate calls caused by parent re-renders
    if (connectStartedRef.current) return
    connectStartedRef.current = true

    setIsConnecting(true)
    setError(null)
    setQrCodeSvg(null)
    setAlreadyLoggedIn(false)

    try {
      const result = await connect()

      if (result.alreadyLoggedIn) {
        // Already logged in - no QR needed
        setAlreadyLoggedIn(true)
        onSuccess()
        onClose()
      } else if (result.qrCode) {
        setQrCode(result.qrCode)
        setCountdown(REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS / 1000)
      } else {
        setError('未能获取登录二维码')
        connectStartedRef.current = false
      }
    } catch (err) {
      setError(String(err))
      connectStartedRef.current = false
    } finally {
      setIsConnecting(false)
    }
  }, [connect, onSuccess, onClose])

  // Generate QR SVG
  useEffect(() => {
    if (!qrCode) {
      setQrCodeSvg(null)
      return
    }

    let cancelled = false
    setIsGeneratingQR(true)

    generateQRCodeSVG(qrCode)
      .then((svg) => {
        if (!cancelled) setQrCodeSvg(svg)
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('QR generation failed:', err)
          setError('二维码生成失败')
        }
      })
      .finally(() => {
        if (!cancelled) setIsGeneratingQR(false)
      })

    return () => {
      cancelled = true
    }
  }, [qrCode])

  // Countdown with timeout handling
  useEffect(() => {
    if (!isOpen || !qrCode) return

    if (countdown <= 0) {
      setError('扫码超时，请重试')
      setQrCode(null)
      setQrCodeSvg(null)
      return
    }

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1)
    }, 1000)

    return () => clearInterval(timer)
  }, [isOpen, qrCode, countdown])

  // Auto-close dialog when connection is established (async QR scan flow)
  useEffect(() => {
    if (isOpen && qrCode && connectionStatus === 'connected') {
      onSuccess()
      onClose()
    }
  }, [isOpen, qrCode, connectionStatus, onSuccess, onClose])

  // Start connection on open
  useEffect(() => {
    if (isOpen) {
      handleConnect()
    } else {
      // Reset on close
      connectStartedRef.current = false
      setQrCode(null)
      setQrCodeSvg(null)
      setError(null)
      setCountdown(REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS / 1000)
      setAlreadyLoggedIn(false)
    }
  }, [isOpen, handleConnect])

  if (!isOpen) return null

  return (
    <div className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center" style={{ top: 'var(--title-bar-height, 0)' }}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-[400px] max-w-[90vw] bg-bg-primary rounded-lg shadow-xl p-6">
        <div className="text-center mb-4">
          <h3 className="text-lg font-medium text-text-primary">接入微信 ClawBot</h3>
        </div>

        <div className="flex flex-col items-center mb-4">
          {isConnecting || isGeneratingQR ? (
            <div className="w-48 h-48 flex items-center justify-center bg-bg-secondary rounded-lg border border-border">
              <div className="flex items-center gap-2 text-text-muted">
                <svg
                  className="animate-spin h-5 w-5 text-accent-indigo"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span className="text-sm">生成二维码...</span>
              </div>
            </div>
          ) : error ? (
            <div className="w-48 h-48 flex flex-col items-center justify-center bg-bg-secondary rounded-lg border border-border p-4">
              <span className="text-2xl mb-2">⚠️</span>
              <p className="text-xs text-text-secondary text-center mb-3">{error}</p>
              {error.includes('WeClaw') && (
                <a
                  href="https://github.com/fastclaw-ai/weclaw"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent-indigo hover:underline"
                >
                  查看 WeClaw 安装指南 →
                </a>
              )}
              <button
                onClick={handleConnect}
                className="mt-3 text-xs text-text-secondary hover:text-text-primary"
              >
                重试
              </button>
            </div>
          ) : qrCodeSvg ? (
            <>
              <div className="w-48 h-48 flex items-center justify-center bg-white rounded-lg border border-border p-2">
                <img
                  src={`data:image/svg+xml,${encodeURIComponent(qrCodeSvg)}`}
                  alt="QR Code"
                  className="w-full h-full"
                />
              </div>
              <div className="mt-2 text-sm text-text-muted">
                请在 <span className="text-accent-indigo font-medium">{countdown}</span> 秒内扫码
              </div>
            </>
          ) : null}
        </div>

        <div className="space-y-2 mb-6">
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-5 h-5 flex items-center justify-center bg-bg-tertiary rounded-full text-xs text-text-muted">
              1
            </span>
            <span>使用手机微信扫描二维码</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-5 h-5 flex items-center justify-center bg-bg-tertiary rounded-full text-xs text-text-muted">
              2
            </span>
            <span>在手机端确认授权</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-5 h-5 flex items-center justify-center bg-bg-tertiary rounded-full text-xs text-text-muted">
              3
            </span>
            <span>连接成功</span>
          </div>
        </div>

        <div className="flex justify-center">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary bg-bg-secondary hover:bg-bg-hover rounded-lg transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * RemoteControlSettings Component
 */
export function RemoteControlSettings({ visible = true }: RemoteControlSettingsProps): JSX.Element | null {
  const [isConnectDialogOpen, setIsConnectDialogOpen] = useState(false)

  const {
    settings,
    isLoading,
    error,
    initialize,
    cleanup,
    enable,
    disable,
    disconnect,
    updateSettings,
  } = useRemoteControlStore()

  // Initialize on mount
  useEffect(() => {
    initialize()
    return () => cleanup()
  }, [initialize, cleanup])

  // Handle enable toggle
  const handleEnableToggle = async () => {
    try {
      if (settings.enabled) {
        await disable()
      } else {
        await enable()
      }
    } catch (err) {
      console.error('Failed to toggle:', err)
    }
  }

  // Handle require confirm toggle
  const handleRequireConfirmToggle = async () => {
    try {
      await updateSettings({ requireConfirm: !settings.requireConfirm })
    } catch (err) {
      console.error('Failed to update:', err)
    }
  }

  // Handle disconnect
  const handleDisconnect = async () => {
    try {
      await disconnect()
    } catch (err) {
      console.error('Failed to disconnect:', err)
    }
  }

  if (!visible) return null

  const connection = settings.connection
  const isPending = connection?.status === 'pending'
  const connected = connection?.status === 'connected'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between mb-2">
          <div>
            <h3 className="text-sm font-medium text-text-primary">远程控制</h3>
            <p className="text-xs text-text-muted mt-1">通过微信远程管理 DevFlow IDE</p>
          </div>

          {/* Enable Toggle */}
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={handleEnableToggle}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-bg-tertiary peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent-indigo"></div>
          </label>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-4">
          <div className="flex items-center gap-2 text-text-muted">
            <svg
              className="animate-spin h-4 w-4 text-accent-indigo"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span className="text-xs">加载中...</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-xs text-red-500">{error}</p>
        </div>
      )}

      {/* Connection Status */}
      {!isLoading && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">连接状态</h4>
          </div>

          {connection ? (
            <div className="flex items-center justify-between p-3 bg-bg-secondary border border-border rounded-lg">
              <div className="flex items-center gap-3">
                <span
                  className="text-lg"
                  title={getConnectionStatusName(connection.status)}
                >
                  {connection.status === 'connected'
                    ? '🟢'
                    : connection.status === 'pending'
                      ? '🟡'
                      : connection.status === 'error'
                        ? '🔴'
                        : '⚪'}
                </span>

                <div>
                  <div className="text-sm font-medium text-text-primary">微信 ClawBot</div>
                  <div className="text-xs text-text-muted">
                    {connection.status === 'connected'
                      ? connection.connectedAt
                        ? new Date(connection.connectedAt).toLocaleString('zh-CN')
                        : '已连接'
                      : getConnectionStatusName(connection.status)}
                  </div>
                </div>
              </div>

              {connected && (
                <button
                  onClick={handleDisconnect}
                  className="px-2 py-1 text-xs text-text-secondary hover:text-red-500 hover:bg-bg-hover rounded transition-colors"
                >
                  断开
                </button>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-6 px-4 bg-bg-secondary border border-border rounded-lg">
              <div className="w-10 h-10 mb-2 flex items-center justify-center bg-bg-tertiary rounded-full">
                <span className="text-xl">📱</span>
              </div>
              <p className="text-sm text-text-secondary">尚未连接</p>
            </div>
          )}
        </div>
      )}

      {/* Connect Button */}
      {!isLoading && !connected && (
        <div>
          <button
            onClick={() => setIsConnectDialogOpen(true)}
            disabled={!settings.enabled || isPending}
            className={`
              w-full py-2 text-sm font-medium rounded-lg border border-border transition-colors
              ${settings.enabled && !isPending
                ? 'text-accent-indigo border-accent-indigo/30 hover:bg-accent-indigo/10'
                : 'text-text-muted cursor-not-allowed'}
            `}
          >
            {isPending ? '连接中...' : '连接微信'}
          </button>
          {!settings.enabled && (
            <p className="text-xs text-text-muted mt-1 text-center">请先启用远程控制</p>
          )}
        </div>
      )}

      {/* Security Settings */}
      {!isLoading && (
        <div className="pt-4 border-t border-border">
          <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
            安全设置
          </h4>

          <div className="flex items-start gap-3">
            <label className="relative flex items-center cursor-pointer mt-0.5">
              <input
                type="checkbox"
                checked={settings.requireConfirm}
                onChange={handleRequireConfirmToggle}
                className="sr-only peer"
              />
              <div className="w-4 h-4 bg-bg-secondary border border-border rounded peer-focus:outline-none peer-checked:bg-accent-indigo peer-checked:border-accent-indigo flex items-center justify-center">
                <svg
                  className={`w-3 h-3 text-white ${settings.requireConfirm ? 'block' : 'hidden'}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </label>

            <div>
              <span className="text-sm text-text-primary">重要操作需手机端确认</span>
              <p className="text-xs text-text-muted mt-1">
                切换项目、重启会话等操作需要手机端二次确认
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Connect Dialog */}
      <ConnectDialog
        isOpen={isConnectDialogOpen}
        onClose={() => setIsConnectDialogOpen(false)}
        onSuccess={() => console.log('Connected successfully')}
      />
    </div>
  )
}

export default RemoteControlSettings
