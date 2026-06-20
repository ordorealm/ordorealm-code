/**
 * Git State Management Store
 * Handles branch selection, diff files, and file difference tracking
 * @module stores/git-store
 */

import { create } from 'zustand';
import { normalizePath, joinPath } from '@/utils/path';
import type {
  GitBranch,
  DiffFile,
  FileDiff,
  FileViewMode,
  CompareMode,
  GitStatusSummary,
} from '@/types';

interface GitState {
  // ===== Repository Info =====
  /** Current repository path */
  repoPath: string | null;
  /** Whether the repo is a git repository */
  isGitRepo: boolean;

  // ===== Branch Info =====
  /** All branches */
  branches: {
    local: GitBranch[];
    remote: GitBranch[];
  };
  /** Current branch name */
  currentBranch: string;
  /** Main branch name (main or master) */
  mainBranch: string;
  /** Target branch for comparison */
  targetBranch: string;
  /** Whether current branch is the main branch */
  isCurrentMain: boolean;

  // ===== Diff View =====
  /** File display mode: show only diff files or all files */
  fileViewMode: FileViewMode;
  /** Compare mode: branch comparison or worktree */
  compareMode: CompareMode;
  /** Diff files map (path -> DiffFile) */
  diffFiles: Map<string, DiffFile>;
  /** Current file detailed diff */
  currentFileDiff: FileDiff | null;
  /** Git status summary */
  statusSummary: GitStatusSummary | null;

  // ===== Loading States =====
  /** Loading branches */
  isLoadingBranches: boolean;
  /** Loading diff files */
  isLoadingDiff: boolean;
  /** Loading file diff */
  isLoadingFileDiff: boolean;
  /** Error message */
  error: string | null;
}

interface GitActions {
  // ===== Initialization =====
  /** Initialize git state for a repository */
  initialize: (repoPath: string) => Promise<void>;
  /** Clear git state */
  clear: () => void;

  // ===== Branch Operations =====
  /** Load branches list */
  loadBranches: () => Promise<void>;
  /** Switch to a different branch */
  checkout: (branch: string) => Promise<{ success: boolean; error?: string }>;
  /** Force switch to a different branch (discard local changes) */
  checkoutForce: (branch: string) => Promise<{ success: boolean; error?: string }>;
  /** Commit all changes and switch to a different branch */
  commitAndCheckout: (branch: string, message?: string) => Promise<{ success: boolean; error?: string }>;
  /** Set target branch for comparison */
  setTargetBranch: (branch: string) => void;
  /** Set file view mode (diff/all) */
  setFileViewMode: (mode: FileViewMode) => void;

  // ===== Diff Operations =====
  /** Load diff files list */
  loadDiffFiles: () => Promise<void>;
  /** Load detailed diff for a file */
  loadFileDiff: (filePath: string) => Promise<void>;
  /** Clear current file diff */
  clearFileDiff: () => void;

  // ===== Utility =====
  /** Get diff file info for a path */
  getDiffFile: (filePath: string) => DiffFile | undefined;
  /** Check if a file has changes */
  hasChanges: (filePath: string) => boolean;
  /** Refresh all git state */
  refresh: () => Promise<void>;
  /** Clear error */
  clearError: () => void;
}

type Store = GitState & GitActions;

export const useGitStore = create<Store>((set, get) => ({
  // ===== Initial State =====
  repoPath: null,
  isGitRepo: false,
  branches: { local: [], remote: [] },
  currentBranch: '',
  mainBranch: 'main',
  targetBranch: 'main',
  isCurrentMain: true,
  fileViewMode: 'all',
  compareMode: 'branch',
  diffFiles: new Map(),
  currentFileDiff: null,
  statusSummary: null,
  isLoadingBranches: false,
  isLoadingDiff: false,
  isLoadingFileDiff: false,
  error: null,

  // ===== Initialization =====
  initialize: async (repoPath) => {
    set({ repoPath, isLoadingBranches: true, error: null });

    try {
      // Check if it's a git repo
      const isRepo = await window.api.git.isRepo(repoPath);

      if (!isRepo) {
        set({
          isGitRepo: false,
          isLoadingBranches: false,
          branches: { local: [], remote: [] },
          currentBranch: '',
          diffFiles: new Map(),
        });
        return;
      }

      set({ isGitRepo: true });

      // Load branches
      await get().loadBranches();

      // Load diff files
      await get().loadDiffFiles();

      // Load status summary
      const statusSummary = await window.api.git.getStatusSummary(repoPath);
      set({ statusSummary });

    } catch (error) {
      console.error('[GitStore] Initialization failed:', error);
      set({
        isGitRepo: false,
        isLoadingBranches: false,
        error: String(error),
      });
    }
  },

  clear: () => {
    set({
      repoPath: null,
      isGitRepo: false,
      branches: { local: [], remote: [] },
      currentBranch: '',
      mainBranch: 'main',
      targetBranch: 'main',
      isCurrentMain: true,
      diffFiles: new Map(),
      currentFileDiff: null,
      statusSummary: null,
      error: null,
    });
  },

  // ===== Branch Operations =====
  loadBranches: async () => {
    const { repoPath } = get();
    if (!repoPath) return;

    set({ isLoadingBranches: true });

    try {
      const [branches, currentBranch, mainBranch] = await Promise.all([
        window.api.git.listBranches(repoPath),
        window.api.git.getCurrentBranch(repoPath),
        window.api.git.getMainBranch(repoPath),
      ]);

      const isCurrentMain = currentBranch === mainBranch;

      set({
        branches,
        currentBranch,
        mainBranch,
        targetBranch: mainBranch,
        isCurrentMain,
        isLoadingBranches: false,
      });

    } catch (error) {
      console.error('[GitStore] Failed to load branches:', error);
      set({ isLoadingBranches: false, error: String(error) });
    }
  },

  checkout: async (branch) => {
    const { repoPath } = get();
    if (!repoPath) return { success: false, error: 'No repository' };

    set({ isLoadingBranches: true });

    try {
      const result = await window.api.git.checkout(repoPath, branch);

      if (!result.success) {
        set({ isLoadingBranches: false, error: result.error });
        return result;
      }

      // Update current branch and reload branches to refresh tracking info
      set({ currentBranch: branch, isCurrentMain: branch === get().mainBranch });

      // Reload branches to update current marker
      await get().loadBranches();

      // Reload diff files
      await get().loadDiffFiles();

      // Reload status
      const statusSummary = await window.api.git.getStatusSummary(repoPath);
      set({ statusSummary, isLoadingBranches: false });

      return { success: true };
    } catch (error) {
      console.error('[GitStore] Checkout failed:', error);
      set({ isLoadingBranches: false, error: String(error) });
      return { success: false, error: String(error) };
    }
  },

  checkoutForce: async (branch) => {
    const { repoPath } = get();
    if (!repoPath) return { success: false, error: 'No repository' };

    set({ isLoadingBranches: true });

    try {
      const result = await window.api.git.checkoutForce(repoPath, branch);

      if (!result.success) {
        set({ isLoadingBranches: false, error: result.error });
        return result;
      }

      // Update current branch and reload branches
      set({ currentBranch: branch, isCurrentMain: branch === get().mainBranch });

      // Reload branches to update current marker
      await get().loadBranches();

      // Reload diff files
      await get().loadDiffFiles();

      // Reload status
      const statusSummary = await window.api.git.getStatusSummary(repoPath);
      set({ statusSummary, isLoadingBranches: false });

      return { success: true };
    } catch (error) {
      console.error('[GitStore] Force checkout failed:', error);
      set({ isLoadingBranches: false, error: String(error) });
      return { success: false, error: String(error) };
    }
  },

  commitAndCheckout: async (branch, message) => {
    const { repoPath } = get();
    if (!repoPath) return { success: false, error: 'No repository' };

    set({ isLoadingBranches: true });

    try {
      const result = await window.api.git.commitAndCheckout(repoPath, branch, message);

      if (!result.success) {
        set({ isLoadingBranches: false, error: result.error });
        return result;
      }

      // Update current branch and reload branches
      set({ currentBranch: branch, isCurrentMain: branch === get().mainBranch });

      // Reload branches to update current marker
      await get().loadBranches();

      // Reload diff files
      await get().loadDiffFiles();

      // Reload status
      const statusSummary = await window.api.git.getStatusSummary(repoPath);
      set({ statusSummary, isLoadingBranches: false });

      return { success: true };
    } catch (error) {
      console.error('[GitStore] Commit and checkout failed:', error);
      set({ isLoadingBranches: false, error: String(error) });
      return { success: false, error: String(error) };
    }
  },

  setTargetBranch: (branch) => {
    set({ targetBranch: branch });

    // Reload diff files when target branch changes
    get().loadDiffFiles();
  },

  setFileViewMode: (mode) => {
    const { fileViewMode, diffFiles } = get();

    set({ fileViewMode: mode });

    // When switching to diff mode, ensure diff files are loaded
    if (mode === 'diff' && fileViewMode !== 'diff' && diffFiles.size === 0) {
      get().loadDiffFiles();
    }
  },

  // ===== Diff Operations =====
  loadDiffFiles: async () => {
    const { repoPath, currentBranch, targetBranch, mainBranch, isCurrentMain } = get();
    if (!repoPath) return;

    set({ isLoadingDiff: true });

    try {
      let diffFiles: DiffFile[];

      if (isCurrentMain) {
        // Main branch: get worktree changes
        diffFiles = await window.api.git.getWorktreeDiffFiles(repoPath);
      } else {
        // Other branch: compare with target
        diffFiles = await window.api.git.getBranchDiffFiles(repoPath, targetBranch, currentBranch);
      }

      // Convert relative paths to absolute paths for matching with FileTree
      // IMPORTANT: Normalize paths to use forward slashes for consistent Map key matching
      // FileTree paths use system separator (e.g., \ on Windows), Git returns / separator
      const normalizedRepoPath = normalizePath(repoPath);
      const diffMap = new Map<string, DiffFile>();
      diffFiles.forEach(f => {
        // Git returns relative paths with / separator, normalize and join with repo path
        const absolutePath = f.path.startsWith('/')
          ? normalizePath(f.path)
          : joinPath(normalizedRepoPath, f.path);
        diffMap.set(absolutePath, {
          ...f,
          path: absolutePath,
          // Keep original relative path for API calls
          oldPath: f.oldPath
            ? (f.oldPath.startsWith('/') ? normalizePath(f.oldPath) : joinPath(normalizedRepoPath, f.oldPath))
            : undefined,
        });
      });

      set({
        diffFiles: diffMap,
        isLoadingDiff: false,
      });
    } catch (error) {
      console.error('[GitStore] Failed to load diff files:', error);
      set({ isLoadingDiff: false, error: String(error) });
    }
  },

  loadFileDiff: async (filePath) => {
    const { repoPath, currentBranch, targetBranch, mainBranch, isCurrentMain, diffFiles } = get();
    if (!repoPath) return;

    // Normalize path for cross-platform compatibility with diffFiles keys
    const normalizedFilePath = normalizePath(filePath);
    const diffFile = diffFiles.get(normalizedFilePath);
    if (!diffFile) {
      set({ currentFileDiff: null });
      return;
    }

    set({ isLoadingFileDiff: true });

    try {
      let fileDiff: FileDiff | null;

      // Convert absolute path to relative path for backend API
      const normalizedRepoPath = normalizePath(repoPath);
      const relativePath = normalizedFilePath.startsWith(normalizedRepoPath + '/')
        ? normalizedFilePath.slice(normalizedRepoPath.length + 1)
        : filePath;

      if (isCurrentMain) {
        // Worktree diff
        const staged = diffFile.worktreeStatus === 'staged';
        fileDiff = await window.api.git.getWorktreeFileDiff(repoPath, relativePath, staged);
      } else {
        // Branch diff
        fileDiff = await window.api.git.getBranchFileDiff(repoPath, targetBranch, currentBranch, relativePath);
      }

      // Update file path in diff to absolute path for consistency
      if (fileDiff) {
        fileDiff.path = filePath;
      }

      set({ currentFileDiff: fileDiff, isLoadingFileDiff: false });
    } catch (error) {
      console.error('[GitStore] Failed to load file diff:', error);
      set({ isLoadingFileDiff: false, error: String(error) });
    }
  },

  clearFileDiff: () => {
    set({ currentFileDiff: null });
  },

  // ===== Utility =====
  getDiffFile: (filePath) => {
    // Normalize path for cross-platform compatibility
    return get().diffFiles.get(normalizePath(filePath));
  },

  hasChanges: (filePath) => {
    // Normalize path for cross-platform compatibility
    return get().diffFiles.has(normalizePath(filePath));
  },

  refresh: async () => {
    const { repoPath } = get();
    if (!repoPath) return;

    await get().initialize(repoPath);
  },

  clearError: () => {
    set({ error: null });
  },
}));