/**
 * File Watcher Service
 * Monitors file system changes and notifies the file tree store
 * @module services/file-watcher
 */

import { useFileTreeStore } from '@/stores/filetree-store';

type FileChangeType = 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';

interface FileChangeEvent {
  type: FileChangeType;
  path: string;
}

type ChangeCallback = (event: FileChangeEvent) => void;

/**
 * File Watcher Service
 * Provides file system monitoring capabilities
 */
class FileWatcherService {
  private unsubscribe: (() => void) | null = null;
  private callbacks: Set<ChangeCallback> = new Set();
  private currentWatchPath: string | null = null;
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_DELAY = 500; // 500ms debounce delay for file refresh

  /**
   * Start watching a directory
   * @param dirPath Directory path to watch
   */
  async start(dirPath: string): Promise<boolean> {
    // Stop existing watcher if any (don't wait)
    if (this.currentWatchPath) {
      this.stop().catch(err => console.warn('[FileWatcherService] Stop error:', err));
    }

    try {
      const result = await window.api.watcher.start(dirPath);

      if (!result.success) {
        console.error('[FileWatcherService] Failed to start watcher:', result.error);
        return false;
      }

      // Set up change listener
      this.unsubscribe = window.api.watcher.onChange((data) => {
        this.handleFileChange(data as FileChangeEvent);
      });

      this.currentWatchPath = dirPath;
      console.log(`[FileWatcherService] Started watching: ${dirPath}`);
      return true;
    } catch (error) {
      console.error('[FileWatcherService] Failed to start watcher:', error);
      return false;
    }
  }

  /**
   * Stop watching the current directory
   */
  async stop(): Promise<void> {
    // Clear any pending debounce timer
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.currentWatchPath) {
      await window.api.watcher.stop(this.currentWatchPath);
      this.currentWatchPath = null;
      console.log('[FileWatcherService] Stopped watching');
    }
  }

  /**
   * Stop all watchers
   */
  async stopAll(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    await window.api.watcher.stopAll();
    this.currentWatchPath = null;
    console.log('[FileWatcherService] Stopped all watchers');
  }

  /**
   * Subscribe to file change events
   * @param callback Callback function to be called on file changes
   * @returns Unsubscribe function
   */
  subscribe(callback: ChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * Handle file system change events
   */
  private handleFileChange(event: FileChangeEvent): void {
    console.log(`[FileWatcherService] File change: ${event.type} ${event.path}`);

    // Notify all subscribers
    this.callbacks.forEach((callback) => {
      try {
        callback(event);
      } catch (error) {
        console.error('[FileWatcherService] Callback error:', error);
      }
    });

    // Debounced refresh to prevent excessive updates during rapid file changes
    // (e.g., npm install, batch file operations)
    const store = useFileTreeStore.getState();
    if (store.root && event.path.startsWith(store.root.path)) {
      // Clear any pending refresh
      if (this.refreshDebounceTimer) {
        clearTimeout(this.refreshDebounceTimer);
      }

      // Schedule a new refresh after debounce delay
      this.refreshDebounceTimer = setTimeout(() => {
        store.refresh();
        this.refreshDebounceTimer = null;
      }, this.DEBOUNCE_DELAY);
    }
  }
}

// Singleton instance
export const fileWatcherService = new FileWatcherService();
