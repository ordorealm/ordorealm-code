/**
 * Adapter module entry point
 * Exports all adapter-related classes and utilities
 * @module adapters
 */

export { BaseProviderAdapter } from './BaseProviderAdapter'
export { ClaudeSdkAdapter } from './ClaudeSdkAdapter'
export { CodexAppServerAdapter } from './CodexAppServerAdapter'
export { OpenCodeSdkAdapter } from './OpenCodeSdkAdapter'
export { AdapterRegistry, registerDefaultAdapters, configureAdaptersWithRuntime } from './AdapterRegistry'

// Re-export types from shared
export type {
  AgentAdapter,
  AdapterType,
  AdapterConfig,
  AdapterEvent,
  AdapterEventType,
  AdapterSessionConfig,
  AdapterSession,
  ProviderEvent,
  ProviderEventType,
  AdapterMetadata,
  AdapterFactory,
  SessionOptions,
  SessionState,
  ActivityState,
  ErrorInfo
} from '@shared/index'
