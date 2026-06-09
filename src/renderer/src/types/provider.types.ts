/**
 * API Provider related type definitions
 * @module types/provider
 */

import type { AgentType } from './agent.types';
import type { AdapterType } from '@shared/types';

// Re-export AgentType for convenience
export type { AgentType } from './agent.types';
export type { AdapterType } from '@shared/types';

/**
 * Mapping of Agent types to their Adapter types
 * AgentType is the UI-facing type, AdapterType is the SDK-facing type
 */
export const AGENT_TO_ADAPTER: Record<AgentType, AdapterType> = {
  'claude-code': 'claude-sdk',
  'codex': 'codex-appserver',
  'opencode': 'opencode-sdk',
};

/**
 * Mapping of Adapter types back to Agent types
 */
export const ADAPTER_TO_AGENT: Record<AdapterType, AgentType> = {
  'claude-sdk': 'claude-code',
  'codex-appserver': 'codex',
  'opencode-sdk': 'opencode',
};

/**
 * API type enum (what kind of API the provider uses)
 */
export type ApiType = 'anthropic' | 'openai';

/**
 * Mapping of Agent types to their compatible API types
 */
export const AGENT_API_COMPATIBILITY: Record<AgentType, ApiType[]> = {
  'claude-code': ['anthropic'],
  'codex': ['openai'],
  'opencode': ['openai', 'anthropic'], // OpenCode supports multiple providers
};

/**
 * Default models for each API type
 */
export const DEFAULT_MODELS_BY_API: Record<ApiType, string[]> = {
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-latest',
  ],
  openai: [
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o3-mini',
    'o4-mini',
  ],
};

/**
 * Default base URLs for each API type
 */
export const DEFAULT_BASE_URLS_BY_API: Record<ApiType, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

/**
 * Preset base URLs with labels for UI selection
 */
export const PRESET_BASE_URLS: Record<ApiType, { url: string; label: string; rechargeUrl?: string }[]> = {
  anthropic: [
    { url: 'https://api.deepseek.com/anthropic', label: 'DeepSeek 官方', rechargeUrl: 'https://platform.deepseek.com/' },
    { url: 'https://maas-coding-api.cn-huabei-1.xf-yun.com/anthropic', label: '讯飞星辰 Coding Plan', rechargeUrl: 'https://maas.xfyun.cn/packageSubscription' },
    { url: 'https://modelservice.jdcloud.com/coding/anthropic', label: '京东云 Coding Plan', rechargeUrl: 'https://www.jdcloud.com/cn/pages/codingplan' },
    { url: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', label: '阿里云百炼 Coding Plan', rechargeUrl: 'https://www.aliyun.com/benefit/scene/codingplan' },
  ],
  openai: [
    { url: 'https://api.openai.com/v1', label: 'OpenAI 官方' },
  ],
};

/**
 * Agent display names
 */
export const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
};

/**
 * API type display names
 */
export const API_TYPE_DISPLAY_NAMES: Record<ApiType, string> = {
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
};

/**
 * DeepSeek models configuration
 */
export const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', contextWindow: 1000000 },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 1000000 },
] as const;

/**
 * XFYun (讯飞星辰) models configuration
 */
export const XFYUN_MODELS = [
  { id: 'astron-code-latest', label: 'Astron Code (自动切换)', contextWindow: 200000 },
] as const;

/**
 * JDCloud (京东云) models configuration
 */
export const JDCLOUD_MODELS = [
  { id: 'DeepSeek-V3.2', label: 'DeepSeek V3.2', contextWindow: 200000 },
  { id: 'GLM-5', label: 'GLM-5', contextWindow: 200000 },
  { id: 'GLM-4.7', label: 'GLM-4.7', contextWindow: 200000 },
  { id: 'MiniMax-M2.5', label: 'MiniMax M2.5', contextWindow: 200000 },
  { id: 'Kimi-K2.5', label: 'Kimi K2.5', contextWindow: 200000 },
  { id: 'Kimi-K2', label: 'Kimi K2', contextWindow: 200000 },
  { id: 'Qwen3-Coder', label: 'Qwen3 Coder', contextWindow: 200000 },
] as const;

/**
 * Aliyun (阿里云百炼) models configuration
 */
export const ALIYUN_MODELS = [
  { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus', contextWindow: 200000 },
  { id: 'qwen3-max', label: 'Qwen3 Max', contextWindow: 200000 },
  { id: 'qwen3-coder-next', label: 'Qwen3 Coder Next', contextWindow: 200000 },
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', contextWindow: 200000 },
  { id: 'MiniMax-M2.5', label: 'MiniMax M2.5', contextWindow: 200000 },
  { id: 'GLM-5', label: 'GLM-5', contextWindow: 200000 },
  { id: 'kimi-k2.5', label: 'Kimi K2.5', contextWindow: 200000 },
  { id: 'GLM-4.7', label: 'GLM-4.7', contextWindow: 200000 },
] as const;

/**
 * Vendor configuration type
 */
export interface VendorConfig {
  baseUrlPattern: string;
  models: readonly { id: string; label: string; contextWindow: number }[];
  rechargeUrl: string;
}

/**
 * Vendor configurations for known providers
 */
export const VENDOR_CONFIGS: Record<string, VendorConfig> = {
  deepseek: {
    baseUrlPattern: 'deepseek.com',
    models: DEEPSEEK_MODELS,
    rechargeUrl: 'https://platform.deepseek.com/',
  },
  xfyun: {
    baseUrlPattern: 'xf-yun.com',
    models: XFYUN_MODELS,
    rechargeUrl: 'https://maas.xfyun.cn/packageSubscription',
  },
  jdcloud: {
    baseUrlPattern: 'jdcloud.com',
    models: JDCLOUD_MODELS,
    rechargeUrl: 'https://www.jdcloud.com/cn/pages/codingplan',
  },
  aliyun: {
    baseUrlPattern: 'aliyuncs.com',
    models: ALIYUN_MODELS,
    rechargeUrl: 'https://www.aliyun.com/benefit/scene/codingplan',
  },
};

/**
 * Get vendor configuration by base URL
 * @param baseUrl The base URL to check
 * @returns The vendor configuration if found, undefined otherwise
 */
export function getVendorConfigByUrl(baseUrl: string): VendorConfig | undefined {
  for (const config of Object.values(VENDOR_CONFIGS)) {
    if (baseUrl.includes(config.baseUrlPattern)) {
      return config;
    }
  }
  return undefined;
}

/**
 * Provider entity representing an API provider configuration
 * Now includes agentType to indicate which agent this provider is for
 */
export interface Provider {
  /** Unique identifier */
  id: string;
  /** Provider display name */
  name: string;
  /** Agent type this provider is configured for */
  agentType: AgentType;
  /** Adapter type (SDK routing, derived from agentType) */
  adapterType: AdapterType;
  /** API type (anthropic/openai) */
  apiType: ApiType;
  /** API key (stored in plaintext for simplicity) */
  apiKey: string;
  /** API base URL */
  baseUrl: string;
  /** Default model to use */
  defaultModel: string;
  /** Whether this is the default provider for this agent type */
  isDefault: boolean;
  /** Creation timestamp (ISO8601) */
  createdAt: string;
  /** Last update timestamp (ISO8601) */
  updatedAt: string;
  /** CLI command (for custom providers) */
  command?: string;
  /** CLI executable path override */
  executablePath?: string;
  /** Node.js version requirement */
  nodeVersion?: string;
  /** Environment variable overrides */
  envOverrides?: Record<string, string>;
  /** Context window size in tokens (e.g., 200000 for 200K, 1000000 for 1M) */
  contextWindow?: number;
}

/**
 * Provider state managed by Zustand store
 */
export interface ProviderState {
  /** List of all providers */
  providers: Provider[];
  /** Currently active provider ID */
  activeProviderId: string | null;
}
