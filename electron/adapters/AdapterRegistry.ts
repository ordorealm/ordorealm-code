/**
 * Adapter Registry
 * Manages adapter instances and provides lookup functionality
 * Following SpectrAI's adapter pattern for multi-agent support
 * @module adapters/AdapterRegistry
 */

import type { AgentAdapter, AdapterType } from '@shared/index'
import { BaseProviderAdapter } from './BaseProviderAdapter'

/**
 * Adapter Registry
 * Singleton registry for managing adapter instances
 */
export class AdapterRegistry {
  private static instance: AdapterRegistry | null = null

  private adapters: Map<string, AgentAdapter> = new Map()

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): AdapterRegistry {
    if (!AdapterRegistry.instance) {
      AdapterRegistry.instance = new AdapterRegistry()
    }
    return AdapterRegistry.instance
  }

  /**
   * Register an adapter instance
   * @param adapter - Adapter instance (providerId as key)
   */
  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.providerId)) {
      console.warn(`[AdapterRegistry] Adapter already registered for provider: ${adapter.providerId}`)
      return
    }
    this.adapters.set(adapter.providerId, adapter)
  }

  /**
   * Get adapter by Provider ID
   * @param providerId - Provider identifier
   */
  get(providerId: string): AgentAdapter {
    const adapter = this.adapters.get(providerId)
    if (!adapter) {
      throw new Error(
        `No adapter registered for provider: ${providerId}. Available: ${[...this.adapters.keys()].join(', ')}`
      )
    }
    return adapter
  }

  /**
   * Get adapter by AdapterType
   * Used for routing via configured adapterType field
   * @param adapterType - Adapter type identifier
   */
  getByType(adapterType: AdapterType): AgentAdapter {
    for (const adapter of this.adapters.values()) {
      if (this.matchType(adapter.providerId, adapterType)) {
        return adapter
      }
    }
    throw new Error(`No adapter registered for type: ${adapterType}`)
  }

  /**
   * Check if adapter is registered
   * @param providerId - Provider identifier
   */
  has(providerId: string): boolean {
    return this.adapters.has(providerId)
  }

  /**
   * Get all registered provider IDs
   */
  getRegisteredIds(): string[] {
    return [...this.adapters.keys()]
  }

  /**
   * Cleanup all adapter resources
   */
  cleanup(): void {
    for (const adapter of this.adapters.values()) {
      try {
        adapter.cleanup()
      } catch (err) {
        console.error(`[AdapterRegistry] Error cleaning up ${adapter.providerId}:`, err)
      }
    }
    this.adapters.clear()
  }

  /**
   * Provider ID → AdapterType matching
   */
  private matchType(providerId: string, adapterType: AdapterType): boolean {
    switch (adapterType) {
      case 'claude-sdk':
        return providerId === 'claude-code'
      case 'codex-appserver':
        return providerId === 'codex'
      case 'opencode-sdk':
        return providerId === 'opencode'
      default:
        return false
    }
  }

  /**
   * Reset the registry (for testing)
   */
  static reset(): void {
    if (AdapterRegistry.instance) {
      AdapterRegistry.instance.cleanup()
      AdapterRegistry.instance = null
    }
  }
}

/**
 * Helper function to register default adapters
 */
export async function registerDefaultAdapters(): Promise<void> {
  const registry = AdapterRegistry.getInstance()

  // Register Claude SDK adapter using async import
  const { ClaudeSdkAdapter } = await import('./ClaudeSdkAdapter')
  registry.register(new ClaudeSdkAdapter())

  // Register Codex adapter using async import
  const { CodexAppServerAdapter } = await import('./CodexAppServerAdapter')
  registry.register(new CodexAppServerAdapter())

  // Register OpenCode adapter using async import
  const { OpenCodeSdkAdapter } = await import('./OpenCodeSdkAdapter')
  registry.register(new OpenCodeSdkAdapter())

}

/**
 * Configure all adapters with runtime manager
 * This should be called after RuntimeManager is initialized
 */
export async function configureAdaptersWithRuntime(runtimeManager: {
  getEnvConfig: () => {
    nodePath: string;
    gitPath: string;
    bashPath?: string;
    shell: string;
    pathEnv: string;
  };
}): Promise<void> {
  const registry = AdapterRegistry.getInstance()

  // Import adapter types to access setRuntimeManager method
  const { ClaudeSdkAdapter } = await import('./ClaudeSdkAdapter')

  // Configure Claude SDK adapter with bundled runtime
  const claudeAdapter = registry.get('claude-code')
  if (claudeAdapter instanceof ClaudeSdkAdapter) {
    claudeAdapter.setRuntimeManager(runtimeManager as any)
  }

}
