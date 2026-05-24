/**
 * File tree management store
 * @module stores/filetree-store
 */

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { FileNode, FileTreeState } from '@/types';
import { joinPath, getBasename, getDirname } from '@/utils/path';

/** Directory entry from IPC */
interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DirEntry[];
}

interface FileTreeActions {
  loadDirectory: (projectPath: string, depth?: number) => Promise<void>;
  loadDirectoryChain: (startPath: string, maxDepth?: number) => Promise<string[]>;
  toggleExpand: (path: string) => Promise<void>;
  setExpandedPaths: (paths: Set<string>) => void;
  selectFile: (path: string) => void;
  createFile: (parentPath: string, name: string) => Promise<{ success: boolean; error?: string }>;
  createDirectory: (parentPath: string, name: string) => Promise<{ success: boolean; error?: string }>;
  delete: (path: string) => Promise<{ success: boolean; error?: string }>;
  rename: (path: string, newName: string) => Promise<{ success: boolean; error?: string }>;
  refresh: () => Promise<void>;
  clearSelection: () => void;
}

/**
 * Convert DirEntry to FileNode
 */
function dirEntryToFileNode(entry: DirNode, depth: number = 0): FileNode {
  const node: FileNode = {
    id: uuidv4(),
    name: entry.name,
    path: entry.path,
    type: entry.type,
    isExpanded: false,
    isSelected: false,
  };

  if (entry.children && entry.children.length > 0) {
    node.children = entry.children.map(child => dirEntryToFileNode(child, depth + 1));
  }

  return node;
}

/** Type alias for DirEntry to avoid confusion */
type DirNode = DirEntry;

/**
 * Find a node by path in the tree
 */
function findNodeByPath(root: FileNode | null, path: string): FileNode | null {
  if (!root) return null;

  if (root.path === path) return root;

  if (root.children) {
    for (const child of root.children) {
      const found = findNodeByPath(child, path);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Update a node in the tree (immutably)
 */
function updateNodeInTree(
  root: FileNode | null,
  path: string,
  updater: (node: FileNode) => FileNode
): FileNode | null {
  if (!root) return null;

  if (root.path === path) {
    return updater({ ...root });
  }

  if (root.children) {
    return {
      ...root,
      children: root.children.map(child => updateNodeInTree(child, path, updater)!),
    };
  }

  return root;
}

/**
 * Remove a node from the tree (immutably)
 */
function removeNodeFromTree(root: FileNode | null, path: string): FileNode | null {
  if (!root) return null;

  if (root.path === path) {
    return null;
  }

  if (root.children) {
    const newChildren = root.children
      .map(child => removeNodeFromTree(child, path))
      .filter((child): child is FileNode => child !== null);

    return {
      ...root,
      children: newChildren,
    };
  }

  return root;
}

/**
 * Recursively update paths of a node and all its descendants
 * by replacing old path prefix with new path prefix.
 * Used when renaming a directory to keep child paths in sync.
 */
function updateDescendantPaths(node: FileNode, oldPrefix: string, newPrefix: string): FileNode {
  const updatedPath = node.path.replace(oldPrefix, newPrefix);

  return {
    ...node,
    path: updatedPath,
    children: node.children
      ? node.children.map(child => updateDescendantPaths(child, oldPrefix, newPrefix))
      : undefined,
  };
}

/**
 * Add a child node to a parent (immutably)
 */
function addChildToNode(
  root: FileNode | null,
  parentPath: string,
  newChild: FileNode
): FileNode | null {
  if (!root) return null;

  if (root.path === parentPath && root.type === 'directory') {
    const children = root.children || [];
    return {
      ...root,
      children: [...children, newChild],
    };
  }

  if (root.children) {
    return {
      ...root,
      children: root.children.map(child => addChildToNode(child, parentPath, newChild)!),
    };
  }

  return root;
}

export const useFileTreeStore = create<FileTreeState & FileTreeActions>((set, get) => ({
  root: null,
  selectedPath: null,
  expandedPaths: new Set<string>(),

  /**
   * Load directory structure from file system
   * @param projectPath Project root directory path
   * @param depth Directory depth to load (default: 2)
   */
  loadDirectory: async (projectPath, depth = 3) => {
    console.log(`[FileTreeStore] Loading directory: ${projectPath} (depth: ${depth})`);

    try {
      const result = await window.api.fs.readDir(projectPath, depth);

      if (!result.success) {
        console.error('[FileTreeStore] Failed to read directory:', result.error);
        set({ root: null });
        return;
      }

      if (result.content) {
        // Find the root entry (should be the first one with the matching path)
        // readDir returns children of the directory, not the directory itself
        // So we create a root node manually
        const rootName = getBasename(projectPath) || projectPath;
        const rootNode: FileNode = {
          id: uuidv4(),
          name: rootName,
          path: projectPath,
          type: 'directory',
          children: result.content.map(entry => dirEntryToFileNode(entry)),
          isExpanded: true,
          isSelected: false,
        };

        set({
          root: rootNode,
          expandedPaths: new Set([projectPath]), // Expand root by default
        });

        console.log(`[FileTreeStore] Loaded ${result.content.length} entries`);
      }
    } catch (error) {
      console.error('[FileTreeStore] Failed to load directory:', error);
      set({ root: null });
    }
  },

  /**
   * Load a directory chain recursively until we find a directory with files or multiple children
   * This is used for IDEA-style directory compression
   * Returns the list of paths that should be expanded
   *
   * 🔧 修复：递归加载分支点子目录的链，确保一次性完成所有压缩
   */
  loadDirectoryChain: async (startPath: string, maxDepth = 10): Promise<string[]> => {
    console.log('[FileTreeStore] loadDirectoryChain start:', startPath);
    let currentPath = startPath;
    let depth = 0;
    const pathsToExpand: string[] = [];

    while (depth < maxDepth) {
      // Always get fresh root from store
      const { root } = get();
      const node = findNodeByPath(root, currentPath);
      console.log(`[FileTreeStore] loadDirectoryChain depth=${depth}, path=${currentPath}, nodeFound=${!!node}`);

      if (!node || node.type !== 'directory') {
        console.log('[FileTreeStore] loadDirectoryChain: no node or not directory, stop');
        break;
      }

      // Add this path to expand list
      pathsToExpand.push(currentPath);

      // If children not loaded, load them
      if (!node.children || node.children.length === 0) {
        console.log(`[FileTreeStore] loadDirectoryChain: loading children for ${currentPath}`);
        try {
          const result = await window.api.fs.readDir(currentPath, 1);
          if (result.success && result.content) {
            const newChildren = result.content.map(entry => dirEntryToFileNode(entry));
            console.log(`[FileTreeStore] loadDirectoryChain: loaded ${newChildren.length} children`);
            set(state => ({
              root: updateNodeInTree(state.root, currentPath, n => ({
                ...n,
                children: newChildren,
              })),
            }));
          } else {
            console.log('[FileTreeStore] loadDirectoryChain: no content, stop');
            break;
          }
        } catch (err) {
          console.log('[FileTreeStore] loadDirectoryChain: error', err);
          break;
        }
      } else {
        console.log(`[FileTreeStore] loadDirectoryChain: children already loaded (${node.children.length})`);
      }

      // Re-fetch node after update
      const updatedNode = findNodeByPath(get().root, currentPath);
      if (!updatedNode?.children || updatedNode.children.length === 0) {
        console.log('[FileTreeStore] loadDirectoryChain: no children after update, stop');
        break;
      }

      // Check if this is a compressible chain (single directory, no files)
      const childDirs = updatedNode.children.filter(c => c.type === 'directory');
      const childFiles = updatedNode.children.filter(c => c.type === 'file');
      console.log(`[FileTreeStore] loadDirectoryChain: childDirs=${childDirs.length}, childFiles=${childFiles.length}`);

      if (childDirs.length === 1 && childFiles.length === 0) {
        // Continue loading down the chain
        currentPath = childDirs[0].path;
        depth++;
        console.log(`[FileTreeStore] loadDirectoryChain: continue to next dir: ${currentPath}`);
      } else {
        // Found a branch point (multiple dirs or files)
        // 🔧 关键修复：递归加载每个子目录的链，确保它们也被正确压缩
        console.log('[FileTreeStore] loadDirectoryChain: branch point found, recursively loading child chains');

        const remainingDepth = maxDepth - depth - 1;
        if (remainingDepth > 0) {
          for (const dir of childDirs) {
            // 检查是否需要加载
            const dirNode = findNodeByPath(get().root, dir.path);
            if (!dirNode?.children || dirNode.children.length === 0) {
              console.log(`[FileTreeStore] loadDirectoryChain: loading chain for child dir: ${dir.path}`);
              // 递归加载子目录的链
              await get().loadDirectoryChain(dir.path, remainingDepth);
            }
          }
        }
        break;
      }
    }
    console.log(`[FileTreeStore] loadDirectoryChain done: ${depth} levels loaded, paths to expand:`, pathsToExpand);
    return pathsToExpand;
  },

  /**
   * Set expanded paths directly
   * @param paths Set of paths to expand
   */
  setExpandedPaths: (paths: Set<string>) => {
    set({ expandedPaths: paths });
  },

  /**
   * Toggle expand/collapse state of a directory
   * @param path Directory path to toggle
   */
  toggleExpand: async (path) => {
    const { expandedPaths, root } = get();
    const newExpanded = new Set(expandedPaths);

    if (newExpanded.has(path)) {
      newExpanded.delete(path);
      console.log(`[FileTreeStore] Collapsed: ${path}`);
    } else {
      newExpanded.add(path);

      // Check if we need to load children
      const node = findNodeByPath(root, path);
      if (node && node.type === 'directory' && (!node.children || node.children.length === 0)) {
        // Load the entire directory chain for compressed directories
        await get().loadDirectoryChain(path);

        // Reload the node after chain loading
        const updatedNode = findNodeByPath(get().root, path);
        if (updatedNode?.children && updatedNode.children.length > 0) {
          console.log(`[FileTreeStore] Loaded directory chain for: ${path}`);
        }
      } else if (node && node.type === 'directory' && node.children && node.children.length > 0) {
        // Pre-load grandchildren in background (non-blocking)
        const childDirs = node.children.filter(c => c.type === 'directory' && (!c.children || c.children.length === 0));
        if (childDirs.length > 0 && childDirs.length <= 5) {
          // Only pre-load up to 5 directories to avoid heavy load
          Promise.all(
            childDirs.slice(0, 5).map(async (childDir) => {
              try {
                const result = await window.api.fs.readDir(childDir.path, 1);
                if (result.success && result.content) {
                  const grandChildren = result.content.map(entry => dirEntryToFileNode(entry));
                  set(state => ({
                    root: updateNodeInTree(state.root, childDir.path, n => ({
                      ...n,
                      children: grandChildren,
                    })),
                  }));
                }
              } catch {
                // Ignore errors in background loading
              }
            })
          );
        }
      }

      console.log(`[FileTreeStore] Expanded: ${path}`);
    }

    set({ expandedPaths: newExpanded });
  },

  /**
   * Select a file in the tree
   * @param path File path to select
   */
  selectFile: (path) => {
    const { root, selectedPath } = get();

    if (root) {
      let newRoot = root;

      // Clear previous selection first
      if (selectedPath) {
        newRoot = updateNodeInTree(newRoot, selectedPath, n => ({
          ...n,
          isSelected: false,
        }))!;
      }

      // Set new selection
      newRoot = updateNodeInTree(newRoot, path, n => ({
        ...n,
        isSelected: true,
      }))!;

      set({ root: newRoot, selectedPath: path });
    } else {
      set({ selectedPath: path });
    }

    console.log(`[FileTreeStore] Selected: ${path}`);
  },

  /**
   * Create a new file
   * @param parentPath Parent directory path
   * @param name File name
   */
  createFile: async (parentPath, name) => {
    const filePath = joinPath(parentPath, name);

    console.log(`[FileTreeStore] Creating file: ${filePath}`);

    try {
      // Create empty file
      const result = await window.api.fs.writeFile(filePath, '');

      if (!result.success) {
        console.error('[FileTreeStore] Failed to create file:', result.error);
        return { success: false, error: result.error };
      }

      // Add to tree
      const newNode: FileNode = {
        id: uuidv4(),
        name,
        path: filePath,
        type: 'file',
        isSelected: false,
      };

      set(state => ({
        root: addChildToNode(state.root, parentPath, newNode),
      }));

      console.log(`[FileTreeStore] File created: ${filePath}`);
      return { success: true };
    } catch (error) {
      console.error('[FileTreeStore] Failed to create file:', error);
      return { success: false, error: String(error) };
    }
  },

  /**
   * Create a new directory
   * @param parentPath Parent directory path
   * @param name Directory name
   */
  createDirectory: async (parentPath, name) => {
    const dirPath = joinPath(parentPath, name);

    console.log(`[FileTreeStore] Creating directory: ${dirPath}`);

    try {
      const result = await window.api.fs.mkdir(dirPath);

      if (!result.success) {
        console.error('[FileTreeStore] Failed to create directory:', result.error);
        return { success: false, error: result.error };
      }

      // Add to tree
      const newNode: FileNode = {
        id: uuidv4(),
        name,
        path: dirPath,
        type: 'directory',
        children: [],
        isExpanded: false,
        isSelected: false,
      };

      set(state => ({
        root: addChildToNode(state.root, parentPath, newNode),
      }));

      console.log(`[FileTreeStore] Directory created: ${dirPath}`);
      return { success: true };
    } catch (error) {
      console.error('[FileTreeStore] Failed to create directory:', error);
      return { success: false, error: String(error) };
    }
  },

  /**
   * Delete a file or directory
   * @param path Path to delete
   */
  delete: async (path) => {
    console.log(`[FileTreeStore] Deleting: ${path}`);

    try {
      const result = await window.api.fs.delete(path);

      if (!result.success) {
        console.error('[FileTreeStore] Failed to delete:', result.error);
        return { success: false, error: result.error };
      }

      // Remove from tree
      set(state => {
        const newExpanded = new Set(state.expandedPaths);
        newExpanded.delete(path);

        return {
          root: removeNodeFromTree(state.root, path),
          selectedPath: state.selectedPath === path ? null : state.selectedPath,
          expandedPaths: newExpanded,
        };
      });

      console.log(`[FileTreeStore] Deleted: ${path}`);
      return { success: true };
    } catch (error) {
      console.error('[FileTreeStore] Failed to delete:', error);
      return { success: false, error: String(error) };
    }
  },

  /**
   * Rename a file or directory
   * @param path Original path
   * @param newName New name
   */
  rename: async (path, newName) => {
    const parentPath = getDirname(path);
    const newPath = joinPath(parentPath, newName);

    console.log(`[FileTreeStore] Renaming: ${path} -> ${newPath}`);

    try {
      const result = await window.api.fs.rename(path, newPath);

      if (!result.success) {
        console.error('[FileTreeStore] Failed to rename:', result.error);
        return { success: false, error: result.error };
      }

      // Update in tree
      set(state => {
        // Update expanded paths: replace old path prefix with new prefix for all matching paths
        const newExpanded = new Set<string>();
        for (const expandedPath of state.expandedPaths) {
          // Use normalized path comparison for cross-platform compatibility
          const normalizedExpanded = expandedPath.replace(/\\/g, '/');
          const normalizedPath = path.replace(/\\/g, '/');
          if (normalizedExpanded.startsWith(normalizedPath + '/') || normalizedExpanded === normalizedPath) {
            // Replace old path prefix with new path prefix
            newExpanded.add(expandedPath.replace(path, newPath));
          } else {
            newExpanded.add(expandedPath);
          }
        }

        return {
          root: updateNodeInTree(state.root, path, n => {
            const updated: FileNode = {
              ...n,
              name: newName,
              path: newPath,
            };

            // If renaming a directory, update all descendant paths
            if (n.type === 'directory' && n.children) {
              updated.children = n.children.map(child =>
                updateDescendantPaths(child, path, newPath)
              );
            }

            return updated;
          }),
          selectedPath: state.selectedPath?.startsWith(path)
            ? state.selectedPath.replace(path, newPath)
            : state.selectedPath,
          expandedPaths: newExpanded,
        };
      });

      console.log(`[FileTreeStore] Renamed: ${path} -> ${newPath}`);
      return { success: true };
    } catch (error) {
      console.error('[FileTreeStore] Failed to rename:', error);
      return { success: false, error: String(error) };
    }
  },

  /**
   * Refresh the file tree
   */
  refresh: async () => {
    const { root } = get();
    if (root) {
      console.log(`[FileTreeStore] Refreshing: ${root.path}`);
      await get().loadDirectory(root.path);
    }
  },

  /**
   * Clear selection
   */
  clearSelection: () => {
    const { root } = get();

    if (root) {
      set(state => ({
        root: updateNodeInTree(state.root, state.selectedPath || '', n => ({
          ...n,
          isSelected: false,
        })),
        selectedPath: null,
      }));
    } else {
      set({ selectedPath: null });
    }

    console.log('[FileTreeStore] Selection cleared');
  },
}));
