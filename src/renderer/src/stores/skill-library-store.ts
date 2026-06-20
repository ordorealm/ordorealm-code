/**
 * Skill library store
 * Manages skill libraries for different Agent types
 * @module stores/skill-library-store
 */

import { create } from 'zustand';
import type { SkillLibrary, AgentType } from '@/types';

/** LocalStorage key for active library per project */
const ACTIVE_LIBRARY_STORAGE_KEY = 'skill-library-active';

/** Get active library ID from localStorage for a project */
function getStoredActiveLibraryId(projectPath: string): string | null {
  try {
    const stored = localStorage.getItem(ACTIVE_LIBRARY_STORAGE_KEY);
    if (stored) {
      const map = JSON.parse(stored) as Record<string, string>;
      return map[projectPath] || null;
    }
  } catch (e) {
    console.warn('[SkillLibraryStore] Failed to read stored active library:', e);
  }
  return null;
}

/** Set active library ID in localStorage for a project */
function setStoredActiveLibraryId(projectPath: string, libraryId: string | null): void {
  try {
    const stored = localStorage.getItem(ACTIVE_LIBRARY_STORAGE_KEY);
    const map: Record<string, string> = stored ? JSON.parse(stored) : {};
    if (libraryId) {
      map[projectPath] = libraryId;
    } else {
      delete map[projectPath];
    }
    localStorage.setItem(ACTIVE_LIBRARY_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[SkillLibraryStore] Failed to store active library:', e);
  }
}

interface SkillLibraryState {
  /** All skill libraries */
  libraries: SkillLibrary[];

  /** Currently active library ID (per project, persisted to localStorage) */
  activeLibraryId: string | null;

  /** Current project path (for persistence) */
  currentProjectPath: string | null;

  /** Loading state */
  isLoading: boolean;

  /** Error message */
  error: string | null;

  // Actions
  /** Load all libraries from storage */
  loadLibraries: () => Promise<void>;

  /** Set current project and restore its active library */
  setProject: (projectPath: string | null) => void;

  /** Add a new library from zip file */
  addLibrary: (zipPath: string, name: string, description: string, agentType: AgentType) => Promise<SkillLibrary | null>;

  /** Update library metadata */
  updateLibrary: (id: string, name: string, description: string) => Promise<boolean>;

  /** Delete a library */
  deleteLibrary: (id: string) => Promise<boolean>;

  /** Extract skill library from project directory */
  extractFromProject: (projectPath: string, name: string, description: string, agentType: AgentType) => Promise<SkillLibrary | null>;

  /** Activate a library for a project */
  activateLibrary: (libraryId: string | null, projectPath: string) => Promise<boolean>;

  /** Get currently active library */
  getActiveLibrary: () => SkillLibrary | null;

  /** Clear error state */
  clearError: () => void;
}

/** Store initialization state */
let initialized = false;
let initPromise: Promise<void> | null = null;

export const useSkillLibraryStore = create<SkillLibraryState>((set, get) => ({
  libraries: [],
  activeLibraryId: null,
  currentProjectPath: null,
  isLoading: false,
  error: null,

  /**
   * Load all libraries from storage via IPC
   */
  loadLibraries: async () => {
    set({ isLoading: true, error: null });

    try {
      const result = await window.api.skillLibrary.list();

      if (result.success && result.skills) {
        set({
          libraries: result.skills,
          isLoading: false,
        });
        console.log(`[SkillLibraryStore] Loaded ${result.skills.length} libraries`);
      } else {
        set({
          libraries: [],
          isLoading: false,
          error: result.error || 'Failed to load libraries',
        });
      }
    } catch (error) {
      console.error('[SkillLibraryStore] Failed to load libraries:', error);
      set({
        libraries: [],
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },

  /**
   * Set current project and restore its active library from localStorage
   */
  setProject: (projectPath: string | null) => {
    const { currentProjectPath } = get();
    if (projectPath === currentProjectPath) return;

    // Save current active library before switching
    if (currentProjectPath) {
      const { activeLibraryId } = get();
      setStoredActiveLibraryId(currentProjectPath, activeLibraryId);
    }

    // Restore active library for new project
    const storedActiveId = projectPath ? getStoredActiveLibraryId(projectPath) : null;
    set({ currentProjectPath: projectPath, activeLibraryId: storedActiveId });
    console.log(`[SkillLibraryStore] Set project: ${projectPath}, active library: ${storedActiveId}`);
  },

  /**
   * Add a new library from zip file
   * @param zipPath Path to the zip file
   * @param name Library name
   * @param description Library description
   * @param agentType Target Agent type
   * @returns The created library or null on failure
   */
  addLibrary: async (zipPath, name, description, agentType) => {
    set({ isLoading: true, error: null });

    try {
      const result = await window.api.skillLibrary.add({
        zipPath,
        name,
        description,
        agentType,
      });

      if (result.success && result.library) {
        const { libraries } = get();
        set({
          libraries: [...libraries, result.library],
          isLoading: false,
        });
        console.log(`[SkillLibraryStore] Added library: ${result.library.name}`);
        return result.library;
      } else {
        set({
          isLoading: false,
          error: result.error || 'Failed to add library',
        });
        return null;
      }
    } catch (error) {
      console.error('[SkillLibraryStore] Failed to add library:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  },

  /**
   * Update library metadata
   * @param id Library ID
   * @param name New name
   * @param description New description
   * @returns Whether update was successful
   */
  updateLibrary: async (id, name, description) => {
    set({ isLoading: true, error: null });

    try {
      const result = await window.api.skillLibrary.update({
        id,
        name,
        description,
      });

      if (result.success) {
        const { libraries } = get();
        const updatedLibraries = libraries.map(lib =>
          lib.id === id
            ? { ...lib, name, description, updatedAt: new Date().toISOString() }
            : lib
        );
        set({ libraries: updatedLibraries, isLoading: false });
        console.log(`[SkillLibraryStore] Updated library: ${name}`);
        return true;
      } else {
        set({
          isLoading: false,
          error: result.error || 'Failed to update library',
        });
        return false;
      }
    } catch (error) {
      console.error('[SkillLibraryStore] Failed to update library:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  },

  /**
   * Delete a library
   * @param id Library ID
   * @returns Whether deletion was successful
   */
  deleteLibrary: async (id) => {
    set({ isLoading: true, error: null });

    try {
      const result = await window.api.skillLibrary.delete({ id });

      if (result.success) {
        const { libraries, activeLibraryId } = get();
        set({
          libraries: libraries.filter(lib => lib.id !== id),
          activeLibraryId: activeLibraryId === id ? null : activeLibraryId,
          isLoading: false,
        });
        console.log(`[SkillLibraryStore] Deleted library: ${id}`);
        return true;
      } else {
        set({
          isLoading: false,
          error: result.error || 'Failed to delete library',
        });
        return false;
      }
    } catch (error) {
      console.error('[SkillLibraryStore] Failed to delete library:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  },

  /**
   * Extract skill library from project directory
   * @param projectPath Project path to extract from
   * @param name Library name
   * @param description Library description
   * @param agentType Agent type
   * @returns The created library or null on failure
   */
  extractFromProject: async (projectPath, name, description, agentType) => {
    set({ isLoading: true, error: null });

    try {
      const result = await window.api.skillLibrary.extract({
        projectPath,
        name,
        description,
        agentType,
      });

      if (result.success && result.library) {
        const { libraries } = get();
        set({
          libraries: [result.library, ...libraries],
          isLoading: false,
        });
        console.log(`[SkillLibraryStore] Extracted library: ${result.library.name}`);
        return result.library;
      } else {
        set({
          isLoading: false,
          error: result.error || 'Failed to extract library',
        });
        return null;
      }
    } catch (error) {
      console.error('[SkillLibraryStore] Failed to extract library:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  },

  /**
   * Activate a library for a project
   * @param libraryId Library ID to activate, or null to deactivate
   * @param projectPath Project path to activate library for
   * @returns Whether activation was successful
   */
  activateLibrary: async (libraryId, projectPath) => {
    set({ isLoading: true, error: null });

    try {
      if (libraryId === null) {
        // Deactivate current library
        setStoredActiveLibraryId(projectPath, null);
        set({ activeLibraryId: null, currentProjectPath: projectPath, isLoading: false });
        return true;
      }

      const result = await window.api.skillLibrary.activate({
        id: libraryId,
        projectPath,
      });

      if (result.success) {
        // Persist to localStorage
        setStoredActiveLibraryId(projectPath, libraryId);
        set({ activeLibraryId: libraryId, currentProjectPath: projectPath, isLoading: false });
        const { libraries } = get();
        const library = libraries.find(lib => lib.id === libraryId);
        console.log(`[SkillLibraryStore] Activated library: ${library?.name || libraryId} for project: ${projectPath}`);
        return true;
      } else {
        set({
          isLoading: false,
          error: result.error || 'Failed to activate library',
        });
        return false;
      }
    } catch (error) {
      console.error('[SkillLibraryStore] Failed to activate library:', error);
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  },

  /**
   * Get currently active library
   * @returns The active library or null
   */
  getActiveLibrary: () => {
    const { libraries, activeLibraryId } = get();
    if (!activeLibraryId) return null;
    return libraries.find(lib => lib.id === activeLibraryId) || null;
  },

  /**
   * Clear error state
   */
  clearError: () => {
    set({ error: null });
  },
}));

/**
 * Initialize the skill library store
 * Should be called when the application starts
 */
export async function initializeSkillLibraryStore(): Promise<void> {
  if (initialized) return;

  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    try {
      await useSkillLibraryStore.getState().loadLibraries();
      initialized = true;
      console.log('[SkillLibraryStore] Initialized');
    } catch (error) {
      console.error('[SkillLibraryStore] Initialization failed:', error);
      initPromise = null;
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Check if the store is initialized
 */
export function isSkillLibraryStoreInitialized(): boolean {
  return initialized;
}
