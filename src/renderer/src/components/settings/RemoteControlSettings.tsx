/**
 * Remote Control Settings Component
 * Settings panel for managing remote control channels
 * @module components/settings/RemoteControlSettings
 *
 * UI Structure:
 * - Header with title, description, and enable toggle
 * - Connected channels list with ChannelCard components
 * - Add new channel button
 * - Security settings section
 */

import { useState, useEffect, useCallback } from 'react';
import {
  useRemoteControlStore,
  getChannelStatusName,
  getChannelTypeName,
  canAddMoreChannels,
} from '@/stores/remote-control-store';
import { getRemoteControlClient } from '@/services/remote-control-client';
import type { Channel, ChannelType } from '../../../../shared/types/remote-control';
import { REMOTE_CONTROL_CONSTRAINTS } from '../../../../shared/types/remote-control';
import QRCode from 'qrcode';

/**
 * RemoteControlSettings component props
 */
interface RemoteControlSettingsProps {
  /** Whether the component is visible */
  visible?: boolean;
}

/**
 * Channel Card Component Props
 */
interface ChannelCardProps {
  channel: Channel;
  onDisconnect: (channelId: string) => void;
  onShowDetails: (channel: Channel) => void;
}

/**
 * Channel Card Component
 * Displays a single connected channel with status and actions
 */
function ChannelCard({ channel, onDisconnect, onShowDetails }: ChannelCardProps): JSX.Element {
  const statusIcon = channel.status === 'connected' ? '🟢' :
                     channel.status === 'pending' ? '🟡' : '⚪';

  const formattedTime = channel.connectedAt
    ? new Date(channel.connectedAt).toLocaleString('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '未连接';

  return (
    <div className="flex items-center justify-between p-3 bg-bg-secondary border border-border rounded-lg">
      <div className="flex items-center gap-3">
        {/* Status Icon */}
        <span className="text-lg" title={getChannelStatusName(channel.status)}>
          {statusIcon}
        </span>

        {/* Channel Info */}
        <div>
          <div className="text-sm font-medium text-text-primary">
            {getChannelTypeName(channel.type)}
          </div>
          <div className="text-xs text-text-muted">
            {formattedTime}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => onShowDetails(channel)}
          className="px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
        >
          详情
        </button>
        <button
          onClick={() => onDisconnect(channel.id)}
          className="px-2 py-1 text-xs text-text-secondary hover:text-red-500 hover:bg-bg-hover rounded transition-colors"
        >
          断开
        </button>
      </div>
    </div>
  );
}

/**
 * Add Channel Dialog Props
 */
interface AddChannelDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (channelId: string) => void;
}

/**
 * Add Channel Dialog Component
 * Dialog for connecting a new channel via QR code
 */
function AddChannelDialog({ isOpen, onClose, onSuccess }: AddChannelDialogProps): JSX.Element | null {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrCodeSvg, setQrCodeSvg] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS / 1000);
  const [error, setError] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isGeneratingQR, setIsGeneratingQR] = useState(false);

  const { connectChannel } = useRemoteControlStore();

  // Handle QR code generation
  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    setQrCodeSvg(null);

    try {
      const result = await connectChannel('wechat');
      setQrCode(result.qrCode);
      setChannelId(result.channelId);
      setCountdown(REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS / 1000);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsConnecting(false);
    }
  }, [connectChannel]);

  // Generate QR code SVG when qrCode data changes
  useEffect(() => {
    if (!qrCode) {
      setQrCodeSvg(null);
      return;
    }

    let cancelled = false;
    setIsGeneratingQR(true);

    generateQRCodeSVG(qrCode)
      .then((svg) => {
        if (!cancelled) {
          setQrCodeSvg(svg);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to generate QR code SVG:', err);
          setError('二维码生成失败');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsGeneratingQR(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [qrCode]);

  // Countdown timer
  useEffect(() => {
    if (!isOpen || !qrCode || countdown <= 0) return;

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [isOpen, qrCode, countdown]);

  // Start connection when dialog opens
  useEffect(() => {
    if (isOpen) {
      handleConnect();
    } else {
      // Reset state when dialog closes
      setQrCode(null);
      setQrCodeSvg(null);
      setChannelId(null);
      setError(null);
      setCountdown(REMOTE_CONTROL_CONSTRAINTS.SCAN_TIMEOUT_MS / 1000);
    }
  }, [isOpen, handleConnect]);

  // Check for successful connection
  useEffect(() => {
    if (!channelId) return;

    const { settings } = useRemoteControlStore.getState();
    const channels = settings?.channels ?? [];
    const channel = channels.find(c => c.id === channelId);

    if (channel?.status === 'connected') {
      onSuccess(channelId);
      onClose();
    }
  }, [channelId, onSuccess, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-[400px] max-w-[90vw] bg-bg-primary rounded-lg shadow-xl p-6">
        {/* Header */}
        <div className="text-center mb-4">
          <h3 className="text-lg font-medium text-text-primary">接入微信 ClawBot</h3>
        </div>

        {/* QR Code Area */}
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
              {/* QR Code Display */}
              <div className="w-48 h-48 flex items-center justify-center bg-white rounded-lg border border-border p-2">
                <img
                  src={`data:image/svg+xml,${encodeURIComponent(qrCodeSvg)}`}
                  alt="QR Code"
                  className="w-full h-full"
                />
              </div>

              {/* Countdown */}
              <div className="mt-2 text-sm text-text-muted">
                请在 <span className="text-accent-indigo font-medium">{countdown}</span> 秒内扫码
              </div>
            </>
          ) : null}
        </div>

        {/* Steps */}
        <div className="space-y-2 mb-6">
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-5 h-5 flex items-center justify-center bg-bg-tertiary rounded-full text-xs text-text-muted">1</span>
            <span>使用手机微信扫描二维码</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-5 h-5 flex items-center justify-center bg-bg-tertiary rounded-full text-xs text-text-muted">2</span>
            <span>在手机端确认授权</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-text-secondary">
            <span className="w-5 h-5 flex items-center justify-center bg-bg-tertiary rounded-full text-xs text-text-muted">3</span>
            <span>连接成功</span>
          </div>
        </div>

        {/* Cancel Button */}
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
  );
}

/**
 * Generate a QR code SVG string from data
 * Uses the qrcode library to generate a proper scannable QR code
 */
async function generateQRCodeSVG(data: string): Promise<string> {
  try {
    // Generate QR code as SVG string with optimal settings for scanning
    const svgString = await QRCode.toString(data, {
      type: 'svg',
      width: 200,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
      errorCorrectionLevel: 'M', // Medium error correction for better scanning
    });
    return svgString;
  } catch (error) {
    console.error('Failed to generate QR code:', error);
    // Return a fallback error indicator SVG
    return `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
        <rect width="200" height="200" fill="white"/>
        <text x="100" y="100" text-anchor="middle" font-size="12" fill="red">QR生成失败</text>
      </svg>
    `;
  }
}

/**
 * Channel Details Dialog Props
 */
interface ChannelDetailsDialogProps {
  isOpen: boolean;
  channel: Channel | null;
  onClose: () => void;
}

/**
 * Channel Details Dialog Component
 */
function ChannelDetailsDialog({ isOpen, channel, onClose }: ChannelDetailsDialogProps): JSX.Element | null {
  if (!isOpen || !channel) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-[400px] max-w-[90vw] bg-bg-primary rounded-lg shadow-xl p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-text-primary">
            {getChannelTypeName(channel.type)} 详情
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Channel Info */}
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-sm text-text-muted">通道 ID</span>
            <span className="text-sm text-text-secondary font-mono">{channel.id.slice(0, 8)}...</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-muted">类型</span>
            <span className="text-sm text-text-secondary">{getChannelTypeName(channel.type)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-muted">状态</span>
            <span className="text-sm text-text-secondary">
              {channel.status === 'connected' ? '🟢 ' : channel.status === 'pending' ? '🟡 ' : '⚪ '}
              {getChannelStatusName(channel.status)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-muted">连接时间</span>
            <span className="text-sm text-text-secondary">
              {channel.connectedAt
                ? new Date(channel.connectedAt).toLocaleString('zh-CN')
                : '未连接'}
            </span>
          </div>
        </div>

        {/* Close Button */}
        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-primary bg-bg-secondary hover:bg-bg-hover rounded-lg transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * RemoteControlSettings Component
 * Main settings panel for remote control configuration
 */
export function RemoteControlSettings({ visible = true }: RemoteControlSettingsProps): JSX.Element | null {
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [detailsChannel, setDetailsChannel] = useState<Channel | null>(null);

  const {
    settings,
    isLoading,
    error,
    initialize,
    cleanup,
    enable,
    disable,
    disconnectChannel,
    updateSettings,
    refresh,
  } = useRemoteControlStore();

  // Initialize store on mount
  useEffect(() => {
    initialize();
    return () => cleanup();
  }, [initialize, cleanup]);

  // Handle enable toggle
  const handleEnableToggle = async (): Promise<void> => {
    try {
      if (settings.enabled) {
        await disable();
      } else {
        await enable();
      }
    } catch (err) {
      console.error('Failed to toggle remote control:', err);
    }
  };

  // Handle disconnect channel
  const handleDisconnect = async (channelId: string): Promise<void> => {
    try {
      await disconnectChannel(channelId);
    } catch (err) {
      console.error('Failed to disconnect channel:', err);
    }
  };

  // Handle show details
  const handleShowDetails = (channel: Channel): void => {
    setDetailsChannel(channel);
  };

  // Handle require confirm toggle
  const handleRequireConfirmToggle = async (): Promise<void> => {
    try {
      await updateSettings({ requireConfirm: !settings.requireConfirm });
    } catch (err) {
      console.error('Failed to update settings:', err);
    }
  };

  // Handle add channel success
  const handleAddChannelSuccess = (channelId: string): void => {
    console.log(`Channel ${channelId} connected successfully`);
  };

  if (!visible) return null;

  // Connected channels - use optional chaining and nullish coalescing for safety
  const channels = settings?.channels ?? [];
  const connectedChannels = channels.filter(c => c.status === 'connected');
  const canAddChannel = canAddMoreChannels();

  return (
    <div className="space-y-6">
      {/* Header Section */}
      <div>
        <div className="flex items-start justify-between mb-2">
          <div>
            <h3 className="text-sm font-medium text-text-primary">远程控制</h3>
            <p className="text-xs text-text-muted mt-1">
              通过微信等渠道远程管理 devflow-ide
            </p>
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

      {/* Loading State */}
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

      {/* Error State */}
      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
          <p className="text-xs text-red-500">{error}</p>
        </div>
      )}

      {/* Connected Channels Section */}
      {!isLoading && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              已连接通道
            </h4>
            <span className="text-xs text-text-muted">
              {connectedChannels.length} / {REMOTE_CONTROL_CONSTRAINTS.MAX_CHANNELS}
            </span>
          </div>

          {/* Channel List */}
          {channels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 px-4 bg-bg-secondary border border-border rounded-lg">
              <div className="w-10 h-10 mb-2 flex items-center justify-center bg-bg-tertiary rounded-full">
                <span className="text-xl">📱</span>
              </div>
              <p className="text-sm text-text-secondary">暂无已连接的通道</p>
            </div>
          ) : (
            <div className="space-y-2">
              {channels.map((channel) => (
                <ChannelCard
                  key={channel.id}
                  channel={channel}
                  onDisconnect={handleDisconnect}
                  onShowDetails={handleShowDetails}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Add Channel Button */}
      {!isLoading && (
        <div>
          <button
            onClick={() => setIsAddDialogOpen(true)}
            disabled={!canAddChannel || !settings.enabled}
            className={`
              w-full py-2 text-sm font-medium rounded-lg border border-border transition-colors
              ${canAddChannel && settings.enabled
                ? 'text-accent-indigo border-accent-indigo/30 hover:bg-accent-indigo/10'
                : 'text-text-muted cursor-not-allowed'}
            `}
          >
            + 添加新通道
          </button>
          {!settings.enabled && (
            <p className="text-xs text-text-muted mt-1 text-center">
              请先启用远程控制
            </p>
          )}
          {!canAddChannel && settings.enabled && (
            <p className="text-xs text-text-muted mt-1 text-center">
              已达到最大通道数量限制
            </p>
          )}
        </div>
      )}

      {/* Security Settings Section */}
      {!isLoading && (
        <div className="pt-4 border-t border-border">
          <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">
            安全设置
          </h4>

          <div className="flex items-start gap-3">
            {/* Checkbox */}
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

            {/* Label and Description */}
            <div>
              <span className="text-sm text-text-primary">重要操作需手机端确认</span>
              <p className="text-xs text-text-muted mt-1">
                切换项目、重启会话等操作需要手机端二次确认
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Add Channel Dialog */}
      <AddChannelDialog
        isOpen={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        onSuccess={handleAddChannelSuccess}
      />

      {/* Channel Details Dialog */}
      <ChannelDetailsDialog
        isOpen={detailsChannel !== null}
        channel={detailsChannel}
        onClose={() => setDetailsChannel(null)}
      />
    </div>
  );
}

export default RemoteControlSettings;
