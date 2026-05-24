/**
 * Main Application Entry Point
 * @module App
 */

import { useEffect, useState } from 'react';
import { MainLayout } from '@/components/layout';
import { useSessionStore } from '@/stores/session-store';
import { useProviderStore } from '@/stores/provider-store';
import { useProjectStore } from '@/stores/project-store';
import { useAgentStore } from '@/stores/agent-store';
import { useAppearanceStore } from '@/stores/appearance-store';
import { initializeCrypto } from '@/utils/crypto';

/**
 * Initialize application stores
 */
function useAppInitialization() {
  const [isInitialized, setIsInitialized] = useState(false);
  const initializeSessions = useSessionStore((state) => state.initialize);
  const initializeProviders = useProviderStore((state) => state.initialize);
  const initializeProjects = useProjectStore((state) => state.initialize);
  const restoreLastProject = useProjectStore((state) => state.restoreLastProject);
  const initializeTheme = useAppearanceStore((state) => state.initialize);

  useEffect(() => {
    const init = async () => {
      try {
        // Initialize theme first (for visual consistency)
        await initializeTheme();

        // Initialize crypto module first (salt must be loaded before any encryption)
        await initializeCrypto();

        // Initialize providers first (needed for agent connection)
        await initializeProviders();

        // Initialize projects (load from disk)
        await initializeProjects();

        // Restore last active project
        restoreLastProject();

        // Initialize sessions (load from disk)
        await initializeSessions();

        // Configure and connect agent
        await initializeAgent();

        console.log('[App] Initialization complete');
        setIsInitialized(true);
      } catch (error) {
        console.error('[App] Initialization failed:', error);
        // Still mark as initialized to show the app (with empty state)
        setIsInitialized(true);
      }
    };

    init();
  }, [initializeSessions, initializeProviders, initializeProjects, restoreLastProject, initializeTheme]);

  return isInitialized;
}

/**
 * Initialize agent with default provider
 */
async function initializeAgent(): Promise<void> {
  const providerStore = useProviderStore.getState();
  const agentStore = useAgentStore.getState();

  // Find default provider (prefer isDefault=true, otherwise first provider)
  const defaultProvider = providerStore.providers.find(p => p.isDefault) ||
                          providerStore.providers[0];

  if (!defaultProvider) {
    console.log('[App] No provider configured, agent will not connect');
    return;
  }

  // Configure agent to use this provider
  agentStore.setConfig({
    type: defaultProvider.agentType,
    providerId: defaultProvider.id,
    permissions: [
      { name: 'read', allowed: true },
      { name: 'write', allowed: true },
      { name: 'execute', allowed: true },
    ],
  });

  // Connect to agent service
  console.log(`[App] Connecting agent with provider: ${defaultProvider.name}`);
  await agentStore.connect();

  if (agentStore.status === 'connected') {
    console.log('[App] Agent connected successfully');
  } else {
    console.warn('[App] Agent connection failed:', agentStore.lastError);
  }
}

/**
 * Main App component
 */
function App(): JSX.Element {
  // Initialize stores on mount and wait for completion
  const isInitialized = useAppInitialization();

  // Show loading screen while initializing
  if (!isInitialized) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg-secondary">
        <div className="text-center">
          <div className="w-10 h-10 mx-auto mb-3 border-2 border-accent-indigo border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-text-muted">Loading...</p>
        </div>
      </div>
    );
  }

  return <MainLayout />;
}

export default App;
