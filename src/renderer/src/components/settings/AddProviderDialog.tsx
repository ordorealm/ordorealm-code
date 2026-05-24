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
  DEFAULT_MODELS_BY_API,
  DEFAULT_BASE_URLS_BY_API,
  AGENT_DISPLAY_NAMES,
  API_TYPE_DISPLAY_NAMES,
  AGENT_TO_ADAPTER,
} from '@/types/provider.types';
import { validateKeyFormat, validateProviderConnection } from '@/services/provider-validator';
import type { ValidationResult, KeyFormatCheckResult } from '@/services/provider-validator';
import { checkAgentInstalled, type AgentInstallStatus } from '@/services/agent-detector';

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

  // API Key visibility state
  const [showApiKey, setShowApiKey] = useState(false);

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

  // Get available models for selected API type
  const availableModels = useMemo(() => {
    return DEFAULT_MODELS_BY_API[apiType];
  }, [apiType]);

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
      setBaseUrl(DEFAULT_BASE_URLS_BY_API[apiType]);
      setDefaultModel(DEFAULT_MODELS_BY_API[apiType][0]);
    }
  }, [apiType, isEditMode, isOpen]);

  const resetForm = (): void => {
    setName('');
    setAgentType('claude-code');
    setApiType('anthropic');
    setApiKey('');
    setBaseUrl(DEFAULT_BASE_URLS_BY_API.anthropic);
    setDefaultModel(DEFAULT_MODELS_BY_API.anthropic[0]);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center">
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
                return (
                  <button
                    key={agent}
                    type="button"
                    onClick={() => setAgentType(agent)}
                    disabled={isEditMode}
                    className={`
                      relative px-3 py-2 text-sm font-medium rounded-lg border transition-all
                      ${agentType === agent
                        ? 'border-accent-indigo bg-bg-tertiary text-accent-indigo'
                        : 'border-border bg-bg-primary text-text-secondary hover:border-border'}
                      ${isEditMode ? 'opacity-50 cursor-not-allowed' : ''}
                    `}
                  >
                    <span className="flex items-center justify-center gap-1">
                      {AGENT_DISPLAY_NAMES[agent]}
                      {status && (
                        <span className={isInstalled ? 'text-accent-green' : 'text-text-muted'} title={isInstalled ? `已安装: ${status.version}` : '未安装'}>
                          {isInstalled ? '✓' : '○'}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Agent 安装状态详情 */}
            {agentInstallStatuses[agentType] && (
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
              {agentType === 'claude-code' && 'Claude Code Agent 需要 Anthropic API'}
              {agentType === 'codex' && 'Codex 需要 OpenAI API'}
              {agentType === 'opencode' && 'OpenCode 支持 OpenAI 或 Anthropic API'}
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
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={DEFAULT_BASE_URLS_BY_API[apiType]}
              className="w-full px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none font-mono text-sm bg-bg-primary text-text-primary"
            />
          </div>

          {/* Step 6: Default Model */}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              <span className="inline-flex items-center gap-1">
                <span className="w-5 h-5 rounded-full bg-accent-indigo/10 text-accent-indigo text-xs flex items-center justify-center font-medium">
                  {compatibleApiTypes.length > 1 ? '6' : '5'}
                </span>
                默认模型
              </span>
            </label>
            <div className="flex gap-2">
              <select
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="flex-1 px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none bg-bg-primary text-text-primary"
              >
                {availableModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                placeholder="自定义模型"
                className="flex-1 px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none font-mono text-sm bg-bg-primary text-text-primary"
                title="输入自定义模型名称"
              />
            </div>
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
              <input
                type="number"
                value={contextWindow}
                onChange={(e) => setContextWindow(parseInt(e.target.value) || 200000)}
                min={1000}
                max={1000000}
                className="flex-1 px-3 py-2 border border-border rounded-lg focus:ring-2 focus:ring-accent-indigo focus:border-accent-indigo outline-none font-mono text-sm bg-bg-primary text-text-primary"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setContextWindow(200000)}
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    contextWindow === 200000
                      ? 'border-accent-indigo bg-accent-indigo/10 text-accent-indigo'
                      : 'border-border text-text-muted hover:border-accent-indigo'
                  }`}
                >
                  200K
                </button>
                <button
                  type="button"
                  onClick={() => setContextWindow(1000000)}
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    contextWindow === 1000000
                      ? 'border-accent-indigo bg-accent-indigo/10 text-accent-indigo'
                      : 'border-border text-text-muted hover:border-accent-indigo'
                  }`}
                >
                  1M
                </button>
              </div>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              模型的最大上下文窗口大小。Claude 默认 200K，DeepSeek 可配置 1M
            </p>
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
