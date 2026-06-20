/**
 * Add/Edit Provider Dialog Component
 * Modal dialog for adding or editing provider configuration
 *
 * Flow: Agent Type → API Type → API Configuration
 * @module components/settings/AddProviderDialog
 */

import { useState, useEffect, useMemo } from 'react';
import type { Provider, AgentType, ApiType } from '@/types';
import {
  AGENT_API_COMPATIBILITY,
  DEFAULT_BASE_URLS_BY_API,
  PRESET_BASE_URLS,
  AGENT_DISPLAY_NAMES,
  API_TYPE_DISPLAY_NAMES,
  AGENT_TO_ADAPTER,
  VENDOR_CONFIGS,
  getVendorConfigByUrl,
  DEEPSEEK_MODELS,
  XFYUN_MODELS,
  JDCLOUD_MODELS,
  ALIYUN_MODELS,
} from '@/types/provider.types';
import { validateKeyFormat, validateProviderConnection } from '@/services/provider-validator';
import type { ValidationResult, KeyFormatCheckResult } from '@/services/provider-validator';
import { checkAgentInstalled, type AgentInstallStatus } from '@/services/agent-detector';

/** 上下文窗口选项 */
const CONTEXT_WINDOW_OPTIONS = [
  { value: 200000, label: '200K' },
  { value: 1000000, label: '1M' },
];

interface AddProviderDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  editProvider?: Provider | null;
}

export function AddProviderDialog({
  isOpen,
  onClose,
  onSave,
  editProvider,
}: AddProviderDialogProps): JSX.Element | null {
  // Form state
  const [name, setName] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [apiType, setApiType] = useState<ApiType>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [contextWindow, setContextWindow] = useState<number>(200000);
  const [isDefault, setIsDefault] = useState(false);

  // Validation state
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyFormatWarning, setKeyFormatWarning] = useState<string | null>(null);

  // Disabled agent tooltip state
  const [disabledAgentTooltip, setDisabledAgentTooltip] = useState<AgentType | null>(null);

  // API Key visibility state
  const [showApiKey, setShowApiKey] = useState(false);

  // Custom input state for Base URL and Model
  const [isCustomBaseUrl, setIsCustomBaseUrl] = useState(false);
  const [isCustomModel, setIsCustomModel] = useState(false);

  // Agent installation state
  const [agentInstallStatuses, setAgentInstallStatuses] = useState<Record<AgentType, AgentInstallStatus | null>>({
    'claude-code': null,
    'codex': null,
    'opencode': null,
  });

  const isEditMode = !!editProvider;

  // Get compatible API types for selected agent
  const compatibleApiTypes = useMemo(() => {
    return AGENT_API_COMPATIBILITY[agentType];
  }, [agentType]);

  // Initialize form when editing
  useEffect(() => {
    if (editProvider) {
      setName(editProvider.name);
      setAgentType(editProvider.agentType);
      setApiType(editProvider.apiType);
      setBaseUrl(editProvider.baseUrl);
      setDefaultModel(editProvider.defaultModel);
      setContextWindow(editProvider.contextWindow || 200000);
      setIsDefault(editProvider.isDefault);
      setApiKey(editProvider.apiKey || ''); // 编辑模式下显示现有 API Key

      // ★ 判断 baseUrl 是否为自定义 URL
      const presets = PRESET_BASE_URLS[editProvider.apiType];
      const isPresetUrl = presets.some((p) => p.url === editProvider.baseUrl);
      setIsCustomBaseUrl(!isPresetUrl);

      // ★ 判断 model 是否为自定义模型
      const vendorConfig = getVendorConfigByUrl(editProvider.baseUrl);
      if (vendorConfig) {
        const isPresetModel = vendorConfig.models.some((m) => m.id === editProvider.defaultModel);
        setIsCustomModel(!isPresetModel);
      } else {
        setIsCustomModel(!!editProvider.defaultModel); // 有值但未匹配到预设，视为自定义
      }
    } else {
      resetForm();
    }
    setValidationResult(null);
    setError(null);
    setShowApiKey(false); // 重置显示状态
  }, [editProvider, isOpen]);

  // Check agent installation status on mount
  useEffect(() => {
    const checkInstallations = async (): Promise<void> => {
      const types: AgentType[] = ['claude-code', 'codex', 'opencode'];
      const statuses: Record<AgentType, AgentInstallStatus | null> = {
        'claude-code': null,
        'codex': null,
        'opencode': null,
      };

      for (const type of types) {
        try {
          statuses[type] = await checkAgentInstalled(type);
        } catch (err) {
          console.error(`Failed to check ${type} installation:`, err);
        }
      }

      setAgentInstallStatuses(statuses);
    };

    if (isOpen) {
      checkInstallations();
    }
  }, [isOpen]);

  // Update API type and defaults when agent type changes
  useEffect(() => {
    if (!isEditMode && isOpen) {
      // Select first compatible API type for this agent
      const firstCompatibleApi = AGENT_API_COMPATIBILITY[agentType][0];
      setApiType(firstCompatibleApi);
    }
  }, [agentType, isEditMode, isOpen]);

  // Update defaults when API type changes
  useEffect(() => {
    if (!isEditMode && isOpen) {
      // 使用预设 URL 的第一个选项
      const presets = PRESET_BASE_URLS[apiType];
      setBaseUrl(presets[0]?.url || DEFAULT_BASE_URLS_BY_API[apiType]);
      setIsCustomBaseUrl(false);
      // 默认模型留空，让用户自行选择
      setDefaultModel('');
      setIsCustomModel(false);
    }
  }, [apiType, isEditMode, isOpen]);

  const resetForm = (): void => {
    setName('');
    setAgentType('claude-code');
    setApiType('anthropic');
    setApiKey('');
    const presets = PRESET_BASE_URLS.anthropic;
    setBaseUrl(presets[0]?.url || DEFAULT_BASE_URLS_BY_API.anthropic);
    setIsCustomBaseUrl(false);
    setDefaultModel('');
    setIsCustomModel(false);
    setContextWindow(200000);
    setIsDefault(false);
    setValidationResult(null);
    setError(null);
  };

  const handleClose = (): void => {
    resetForm();
    setKeyFormatWarning(null);
    onClose();
  };

  const handleValidateAndSave = async (): Promise<void> => {
    setError(null);
    setValidationResult(null);
    setKeyFormatWarning(null);

    // Basic validation
    if (!name.trim()) {
      setError('请输入 Provider 名称');
      return;
    }

    // 必须输入 API Key
    if (!apiKey.trim()) {
      setError('请输入 API Key');
      return;
    }

    // 如果输入了新的 API Key，检查格式（支持第三方）
    if (apiKey.trim()) {
      const formatCheck = validateKeyFormat(apiType, apiKey.trim(), baseUrl.trim());
      if (!formatCheck.valid) {
        setError(formatCheck.message);
        return;
      }
      // 非官方格式显示警告，但仍允许继续
      if (!formatCheck.isOfficialKey && formatCheck.level !== 'strict') {
        setKeyFormatWarning(formatCheck.message);
        // 不 return，继续验证连接
      }
    }

    setIsValidating(true);

    // Derive adapterType from agentType
    const adapterType = AGENT_TO_ADAPTER[agentType];

    try {
      // 验证连接
      const tempProvider: Provider = {
        id: 'temp',
        name: name.trim(),
        agentType,
        adapterType,
        apiType,
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim(),
        defaultModel: defaultModel.trim(),
        contextWindow,
        isDefault,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await validateProviderConnection(tempProvider);
      setValidationResult(result);

      if (result.valid) {
        await onSave({
          name: name.trim(),
          agentType,
          adapterType,
          apiType,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          defaultModel: defaultModel.trim(),
          contextWindow,
          isDefault,
        });
        handleClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setIsValidating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center" style={{ top: 'var(--title-bar-height, 0)' }}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Dialog */}
      <div className="relative bg-bg-primary rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <h2 className="text-xl font-semibold text-text-primary mb-6">
          {isEditMode ? '编辑 Provider' : '添加 Provider'}
        </h2>

        {/* Form */}
        <div className="space-y-5">
          {/* Step 1: Agent Type */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              <span className="inline-flex items-center gap-1">
                <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">1</span>
                选择 Agent 类型
              </span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(Object.keys(AGENT_DISPLAY_NAMES) as AgentType[]).map((agent) => {
                const status = agentInstallStatuses[agent];
                const isInstalled = status?.installed ?? false;
                // 目前只支持 claude-code，其他类型禁用
                const isDisabled = agent !== 'claude-code' || isEditMode;
                const isFeatureDisabled = agent !== 'claude-code';

                return (
                  <button
                    key={agent}
                    type="button"
                    onClick={() => {
                      if (isFeatureDisabled) {
                        setDisabledAgentTooltip(agent);
                        setTimeout(() => setDisabledAgentTooltip(null), 2000);
                        return;
                      }
                      setAgentType(agent);
                    }}
                    disabled={isDisabled && !isFeatureDisabled}
                    className={`
                      relative px-3 py-2 text-sm font-medium rounded-lg border transition-all
                      ${agentType === agent && !isFeatureDisabled
                        ? 'border-accent-indigo bg-bg-tertiary text-accent-indigo'
                        : 'border-border bg-bg-primary text-text-secondary hover:border-border'}
                      ${isFeatureDisabled ? 'opacity-50 cursor-pointer' : ''}
                      ${isDisabled && !isFeatureDisabled ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                  >
                    <span className="flex items-center justify-center gap-1">
                      {AGENT_DISPLAY_NAMES[agent]}
                      {isFeatureDisabled && (
                        <span className="text-text-muted text-xs" title="暂未开发">
                          🔒
                        </span>
                      )}
                      {!isFeatureDisabled && status && (
                        <span className={isInstalled ? 'text-accent-green' : 'text-text-muted'} title={isInstalled ? `已安装: ${status.version}` : '未安装'}>
                          {isInstalled ? '✓' : '○'}
                        </span>
                      )}
                    </span>
                    {/* 禁用提示气泡 */}
                    {disabledAgentTooltip === agent && (
                      <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-20 px-3 py-1.5 bg-bg-primary border border-border rounded-lg shadow-lg text-xs text-text-primary whitespace-nowrap">
                        暂未开发，敬请期待
                        <div className="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-border" />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
            {/* Agent 安装状态详情 - 仅显示已启用的 Agent */}
            {agentType === 'claude-code' && agentInstallStatuses[agentType] && (
              <div className={`mt-2 p-2 rounded text-xs ${agentInstallStatuses[agentType]!.installed ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-yellow/10 text-accent-yellow'}`}>
                {agentInstallStatuses[agentType]!.installed ? (
                  <span>✓ {agentInstallStatuses[agentType]!.displayName} 已安装 {agentInstallStatuses[agentType]!.version && `(${agentInstallStatuses[agentType]!.version})`}</span>
                ) : (
                  <span>
                    ⚠ {agentInstallStatuses[agentType]!.displayName} 未安装
                    <a
                      href={agentInstallStatuses[agentType]!.installUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-2 text-accent-indigo hover:underline"
                    >
                      安装指南
                    </a>
                  </span>
                )}
              </div>
            )}
            <p className="mt-1 text-xs text-text-muted">
              目前仅支持 Claude Code，其他 Agent 敬请期待
            </p>
          </div>

          {/* Step 2: API Type (only show if multiple options) */}
          {compatibleApiTypes.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                <span className="inline-flex items-center gap-1">
                  <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">2</span>
                  选择 API 类型
                </span>
              </label>
              <div className="grid grid-cols-2 gap-2">
                {compatibleApiTypes.map((api) => (
                  <button
                    key={api}
                    type="button"
                    onClick={() => setApiType(api)}
                    disabled={isEditMode}
                    className={`
                      px-3 py-2 text-sm font-medium rounded-lg border transition-all
                      ${apiType === api
                        ? 'border-accent-indigo bg-bg-tertiary text-accent-indigo'
                        : 'border-border bg-bg-primary text-text-secondary hover:border-border'}
                      ${isEditMode ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                  >
                    {API_TYPE_DISPLAY_NAMES[api]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Step 3: Provider Name */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <span className="inline-flex items-center gap-1">
                <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">
                  {compatibleApiTypes.length > 1 ? '3' : '2'}
                </span>
                Provider 名称
              </span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`例如: ${AGENT_DISPLAY_NAMES[agentType]} 生产环境`}
              className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none transition-shadow bg-bg-primary text-text-primary"
            />
          </div>

          {/* Step 4: API Key */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <span className="inline-flex items-center gap-1">
                <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">
                  {compatibleApiTypes.length > 1 ? '4' : '3'}
                </span>
                API Key
              </span>
            </label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiType === 'openai' ? 'sk-...' : 'sk-ant-...'}
                className="w-full px-3 py-2 pr-10 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none font-mono text-sm bg-bg-primary text-text-primary"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                title={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              >
                {showApiKey ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Step 5: Base URL */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <span className="inline-flex items-center gap-1">
                <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">
                  {compatibleApiTypes.length > 1 ? '5' : '4'}
                </span>
                Base URL
              </span>
            </label>
            {isCustomBaseUrl ? (
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={DEFAULT_BASE_URLS_BY_API[apiType]}
                className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none font-mono text-sm bg-bg-primary text-text-primary"
              />
            ) : (
              <select
                value={baseUrl}
                onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setIsCustomBaseUrl(true);
                    setBaseUrl('');
                  } else {
                    setBaseUrl(e.target.value);
                  }
                }}
                className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none text-sm bg-bg-primary text-text-primary"
              >
                {PRESET_BASE_URLS[apiType].map((preset) => (
                  <option key={preset.url} value={preset.url}>{preset.label}</option>
                ))}
                <option value="__custom__">自定义...</option>
              </select>
            )}
            {/* 充值链接 */}
            {!isCustomBaseUrl && (() => {
              const preset = PRESET_BASE_URLS[apiType].find((p) => p.url === baseUrl);
              if (preset?.rechargeUrl) {
                return (
                  <a
                    href={preset.rechargeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 text-xs text-accent-indigo hover:underline"
                  >
                    <span>💳</span>
                    <span>官方充值 API 额度</span>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                );
              }
              return null;
            })()}
            {/* 切换回预设选项按钮 */}
            {isCustomBaseUrl && (
              <button
                type="button"
                onClick={() => {
                  setIsCustomBaseUrl(false);
                  const presets = PRESET_BASE_URLS[apiType];
                  setBaseUrl(presets[0]?.url || DEFAULT_BASE_URLS_BY_API[apiType]);
                }}
                className="mt-1 text-xs text-accent-indigo hover:underline"
              >
                切换回预设选项
              </button>
            )}
          </div>

          {/* Step 6: Default Model */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <span className="inline-flex items-center gap-1">
                <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">
                  {compatibleApiTypes.length > 1 ? '6' : '5'}
                </span>
                默认模型
                <span className="text-text-muted font-normal">(可选)</span>
              </span>
            </label>
            {isCustomModel ? (
              <input
                type="text"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder="输入模型名称"
                className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none font-mono text-sm bg-bg-primary text-text-primary"
              />
            ) : (
              <select
                value={defaultModel}
                onChange={(e) => {
                  const selectedModel = e.target.value;
                  if (selectedModel === '__custom__') {
                    setIsCustomModel(true);
                    setDefaultModel('');
                  } else {
                    setDefaultModel(selectedModel);
                    // 根据模型自动设置上下文窗口
                    const vendorConfig = getVendorConfigByUrl(baseUrl);
                    if (vendorConfig) {
                      const model = vendorConfig.models.find((m) => m.id === selectedModel);
                      if (model) {
                        setContextWindow(model.contextWindow);
                      }
                    }
                  }
                }}
                className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none text-sm bg-bg-primary text-text-primary"
              >
                <option value="">选择模型...</option>
                {(() => {
                  const vendorConfig = getVendorConfigByUrl(baseUrl);
                  if (vendorConfig) {
                    // 根据 baseUrl 匹配的厂商显示对应模型
                    const vendorName = Object.entries(VENDOR_CONFIGS).find(
                      ([, config]) => config.baseUrlPattern === vendorConfig.baseUrlPattern
                    )?.[0];
                    const vendorLabels: Record<string, string> = {
                      deepseek: 'DeepSeek V4',
                      xfyun: '讯飞星辰',
                      jdcloud: '京东云',
                      aliyun: '阿里云百炼',
                    };
                    return (
                      <optgroup label={vendorLabels[vendorName || ''] || '模型列表'}>
                        {vendorConfig.models.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </optgroup>
                    );
                  }
                  // 未匹配时显示所有厂商模型
                  return (
                    <>
                      <optgroup label="DeepSeek V4">
                        {DEEPSEEK_MODELS.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </optgroup>
                      <optgroup label="讯飞星辰">
                        {XFYUN_MODELS.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </optgroup>
                      <optgroup label="京东云">
                        {JDCLOUD_MODELS.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </optgroup>
                      <optgroup label="阿里云百炼">
                        {ALIYUN_MODELS.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                      </optgroup>
                    </>
                  );
                })()}
                <option value="__custom__">自定义...</option>
              </select>
            )}
            {/* 切换回预设选项按钮 */}
            {isCustomModel && (
              <button
                type="button"
                onClick={() => {
                  setIsCustomModel(false);
                  setDefaultModel('');
                }}
                className="mt-1 text-xs text-accent-indigo hover:underline"
              >
                切换回预设选项
              </button>
            )}
            <p className="mt-1 text-xs text-text-muted">
              {defaultModel === 'deepseek-v4-pro'
                ? 'DeepSeek V4 Pro 默认 1M 上下文'
                : defaultModel === 'deepseek-v4-flash'
                ? 'DeepSeek V4 Flash 默认 1M 上下文'
                : '选择模型后自动设置推荐值'}
            </p>
          </div>

          {/* Step 7: Context Window */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <span className="inline-flex items-center gap-1">
                <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">
                  {compatibleApiTypes.length > 1 ? '7' : '6'}
                </span>
                上下文窗口 (tokens)
              </span>
            </label>
            <div className="flex gap-2 items-center">
              <select
                value={contextWindow}
                onChange={(e) => setContextWindow(parseInt(e.target.value))}
                className="flex-1 px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none text-sm bg-bg-primary text-text-primary"
              >
                {CONTEXT_WINDOW_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Set as Default */}
          <div className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              id="isDefault"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="w-4 h-4 text-accent-indigo border-border rounded focus:ring-accent-indigo"
            />
            <label htmlFor="isDefault" className="text-sm text-text-secondary">
              设为 {AGENT_DISPLAY_NAMES[agentType]} 的默认 Provider
            </label>
          </div>

          {/* Key Format Warning (第三方 API) */}
          {keyFormatWarning && (
            <div className="p-3 rounded-lg text-sm bg-accent-yellow/10 text-accent-yellow border border-accent-yellow/30 overflow-hidden">
              <span className="font-medium">⚠ </span>
              <span className="break-words">{keyFormatWarning}</span>
            </div>
          )}

          {/* Validation Result */}
          {validationResult && (
            <div
              className={`p-3 rounded-lg text-sm overflow-hidden ${
                validationResult.valid
                  ? 'bg-accent-green/10 text-accent-green border border-accent-green/30'
                  : 'bg-accent-red/10 text-accent-red border border-accent-red/30'
              }`}
            >
              {validationResult.valid ? (
                <div>
                  <span className="font-medium">✓ 验证成功</span>
                  {validationResult.models && validationResult.models.length > 0 && (
                    <div className="mt-1 text-xs text-accent-green">
                      <span className="font-medium">可用模型:</span>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {validationResult.models.slice(0, 5).map((model, idx) => (
                          <span key={idx} className="px-1.5 py-0.5 bg-accent-green/20 rounded text-xs font-mono truncate max-w-[150px]" title={model}>
                            {model}
                          </span>
                        ))}
                        {validationResult.models.length > 5 && (
                          <span className="text-accent-green">+{validationResult.models.length - 5} 更多</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <span className="font-medium">✗ </span>
                  <span className="break-words">{validationResult.error}</span>
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="p-3 rounded-lg text-sm bg-accent-red/10 text-accent-red border border-accent-red/30 overflow-hidden">
              <span className="font-medium">✗ </span>
              <span className="break-words">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-sm font-medium text-text-secondary hover:bg-bg-hover rounded-lg transition-colors"
            disabled={isValidating}
          >
            取消
          </button>
          <button
            onClick={handleValidateAndSave}
            disabled={isValidating}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-indigo hover:bg-accent-indigo/80 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isValidating ? '验证中...' : '验证并保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
