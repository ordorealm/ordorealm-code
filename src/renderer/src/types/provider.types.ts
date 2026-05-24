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
