/**
 * Project management store
 * @module stores/project-store
 */

import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { Project, ProjectState } from '@/types';
import { initializeStorage, readJsonFile, writeJsonFile } from '@/services/storage';
import { fileExists, ensureDir, getUserDataPathAsync } from '@/utils/fs';
import { joinPath } from '@/utils/path';

/** Store 初始化状态 */
let initialized = false;
let initPromise: Promise<void> | null = null;

/** Project switch lock to prevent rapid switching */
let switchingProject = false;

/**
 * 项目数据持久化文件结构
 */
interface ProjectsData {
  projects: Project[];
  recentProjects: string[];
  activeProjectId: string | null;
}

interface ProjectActions {
  createProject: (path: string, name: string) => Promise<{ success: boolean; error?: string; project?: Project }>;
  openProject: (projectId: string) => void;
  closeProject: (projectId: string) => void;
  deleteProject: (projectId: string) => Promise<void>;
  renameProject: (projectId: string, newName: string) => Promise<void>;
  loadProjects: () => Promise<void>;
  saveProjects: () => Promise<void>;
  initialize: () => Promise<void>;
  isInitialized: () => boolean;
  restoreLastProject: () => void;
  reorderProjects: (sourceId: string, targetId: string, dropPosition: 'before' | 'after') => void;
  updateProject: (projectId: string, updates: Partial<Project>) => void;
}

/**
 * Project Store
 * 管理项目列表、当前激活项目、最近打开项目
 */
export const useProjectStore = create<ProjectState & ProjectActions>((set, get) => ({
  projects: [],
  activeProjectId: null,
  recentProjects: [],

  /**
   * 创建新项目
   * @param path 项目目录路径
   * @param name 项目名称
   * @returns 创建结果
   */
  createProject: async (path, name) => {
    const { projects, saveProjects } = get();

    // 检查路径是否存在
    const pathExists = await fileExists(path);
    if (!pathExists) {
      return { success: false, error: `路径不存在: ${path}` };
    }

    // 检查是否已有同名项目（同路径）
    const existingProject = projects.find(p => p.path === path);
    if (existingProject) {
      return { success: false, error: `该路径已被项目 "${existingProject.name}" 使用` };
    }

    // 检查是否已有同名项目（同名但不同路径）
    const sameNameProject = projects.find(p => p.name === name);
    if (sameNameProject) {
      return { success: false, error: `已存在同名项目 "${name}"` };
    }

    // 生成新项目
    const now = new Date().toISOString();
    const newProject: Project = {
      id: uuidv4(),
      name,
      path,
      createdAt: now,
      lastOpenedAt: now,
      isActive: true,
    };

    // 更新状态：保留其他项目的 isActive 状态（支持多标签页）
    // 只更新当前激活项目ID，不关闭其他已打开的项目
    const updatedProjects = [...projects, newProject];

    set({
      projects: updatedProjects,
      activeProjectId: newProject.id,
      recentProjects: [newProject.id, ...get().recentProjects.filter(id => id !== newProject.id)].slice(0, 10),
    });

    // 自动保存
    await saveProjects();

    // 通知主进程项目创建（用于 CodeGraph 初始化）
    window.api.project.created(path).catch(
      (err) => console.warn('[ProjectStore] CodeGraph 初始化通知失败:', err)
    );

    console.log(`[ProjectStore] 项目创建成功: ${name} (${path})`);
    return { success: true, project: newProject };
  },

  /**
   * 打开项目
   * @param projectId 项目 ID
   */
  openProject: (projectId) => {
    // Prevent rapid switching
    if (switchingProject) {
      console.log('[ProjectStore] Already switching project, ignoring');
      return;
    }

    const { projects, recentProjects, saveProjects, activeProjectId } = get();

    // Skip if already active
    if (activeProjectId === projectId) {
      console.log('[ProjectStore] Project already active');
      return;
    }

    const project = projects.find(p => p.id === projectId);

    if (!project) {
      console.warn(`[ProjectStore] 项目不存在: ${projectId}`);
      return;
    }

    switchingProject = true;

    // 更新项目状态
    const updatedProjects = projects.map(p => ({
      ...p,
      isActive: p.id === projectId,
      lastOpenedAt: p.id === projectId ? new Date().toISOString() : p.lastOpenedAt,
    }));

    // 更新最近打开列表
    const updatedRecent = [projectId, ...recentProjects.filter(id => id !== projectId)].slice(0, 10);

    set({
      activeProjectId: projectId,
      projects: updatedProjects,
      recentProjects: updatedRecent,
    });

    // 自动保存
    saveProjects().catch(err => console.error('[ProjectStore] 保存失败:', err));

    console.log(`[ProjectStore] 项目已打开: ${project.name}`);

    // 通知主进程项目打开（用于 CodeGraph 初始化）
    window.api.project.opened(project.path).catch(
      (err) => console.warn('[ProjectStore] CodeGraph 初始化通知失败:', err)
    );

    // Release lock after a short delay (allow effects to settle)
    setTimeout(() => {
      switchingProject = false;
    }, 100);
  },

  /**
   * 关闭项目
   * 从标签页移除（设置 isActive 为 false），但保留项目记录
   * 支持关闭任意项目，不仅是激活项目
   * @param projectId 项目 ID
   */
  closeProject: (projectId) => {
    const { projects, activeProjectId, saveProjects } = get();

    // 找到要关闭的项目
    const projectToClose = projects.find(p => p.id === projectId);
    if (!projectToClose) {
      console.warn(`[ProjectStore] 项目不存在: ${projectId}`);
      return;
    }

    // 如果关闭的不是当前激活项目，只需将目标项目设为非激活状态
    if (activeProjectId !== projectId) {
      const updatedProjects = projects.map(p =>
        p.id === projectId ? { ...p, isActive: false } : p
      );
      set({ projects: updatedProjects });
      saveProjects().catch(err => console.error('[ProjectStore] 保存失败:', err));
      console.log(`[ProjectStore] 项目已关闭: ${projectToClose.name} (${projectId})`);
      return;
    }

    // 关闭的是当前激活项目，需要切换到其他已打开的项目
    const recentProjects = get().recentProjects;

    // 从最近打开列表中找第一个仍然是 isActive 的项目作为新激活项目
    const newActiveProject = recentProjects
      .map(recentId => projects.find(p => p.id === recentId))
      .find(p => p && p.isActive && p.id !== projectId);

    // 使用 map 一次性生成最终数组，逻辑更清晰
    const updatedProjects = projects.map(p => {
      // 被关闭的项目设为非激活
      if (p.id === projectId) {
        return { ...p, isActive: false };
      }
      // 找到新激活项目
      if (newActiveProject && p.id === newActiveProject.id) {
        return { ...p, isActive: true };
      }
      // 其他项目保持原状态
      return p;
    });

    const newActiveId = newActiveProject ? newActiveProject.id : null;

    set({ activeProjectId: newActiveId, projects: updatedProjects });

    // 自动保存
    saveProjects().catch(err => console.error('[ProjectStore] 保存失败:', err));

    console.log(`[ProjectStore] 项目已关闭: ${projectToClose.name} (${projectId})`);
  },

  /**
   * 删除项目
   * 从项目列表移除，如果是当前激活项目则切换
   * @param projectId 项目 ID
   */
  deleteProject: async (projectId) => {
    const { projects, activeProjectId, recentProjects, saveProjects } = get();
    const project = projects.find(p => p.id === projectId);

    if (!project) {
      console.warn(`[ProjectStore] 项目不存在: ${projectId}`);
      return;
    }

    console.log(`[ProjectStore] 开始删除项目: ${project.name}`);

    // 先更新状态，再异步清理资源（避免阻塞 UI）
    const updatedProjects = projects.filter(p => p.id !== projectId);
    const updatedRecent = recentProjects.filter(id => id !== projectId);

    // 如果删除的是当前激活项目，切换到最近打开的其他项目
    let newActiveId: string | null = null;
    if (activeProjectId === projectId) {
      // 从最近打开列表中找第一个还存在项目的
      for (const recentId of updatedRecent) {
        if (updatedProjects.some(p => p.id === recentId)) {
          newActiveId = recentId;
          break;
        }
      }

      // 如果找到了新的激活项目，更新其状态
      if (newActiveId) {
        const finalProjects = updatedProjects.map(p =>
          p.id === newActiveId ? { ...p, isActive: true } : { ...p, isActive: false }
        );
        set({ projects: finalProjects, activeProjectId: newActiveId, recentProjects: updatedRecent });
      } else {
        set({ projects: updatedProjects, activeProjectId: null, recentProjects: updatedRecent });
      }
    } else {
      set({ projects: updatedProjects, activeProjectId, recentProjects: updatedRecent });
    }

    // 自动保存
    await saveProjects();

    // 异步清理资源（不阻塞）
    Promise.resolve().then(async () => {
      try {
        // Close session for this project
        const { useSessionStore } = await import('@/stores/session-store');
        const sessionStore = useSessionStore.getState();
        const sessionEntry = Object.entries(sessionStore.sessions).find(
          ([_, s]) => s.projectId === projectId
        );
        if (sessionEntry) {
          const [sessionId] = sessionEntry;
          await sessionStore.deleteSession(sessionId);
          console.log(`[ProjectStore] 已删除会话: ${sessionId}`);
        }

        // Clear code preview if current file belongs to this project
        const { useCodePreviewStore } = await import('@/stores/code-preview-store');
        const codePreview = useCodePreviewStore.getState();
        if (codePreview.currentFile?.path?.startsWith(project.path)) {
          codePreview.closeFile();
        }
      } catch (err) {
        console.warn('[ProjectStore] 资源清理失败:', err);
      }
    });

    console.log(`[ProjectStore] 项目已删除: ${project.name} (${project.path})`);
  },

  /**
   * 重命名项目
   * @param projectId 项目 ID
   * @param newName 新名称
   */
  renameProject: async (projectId, newName) => {
    const { projects, saveProjects } = get();
    const project = projects.find(p => p.id === projectId);

    if (!project) {
      console.warn(`[ProjectStore] 项目不存在: ${projectId}`);
      return;
    }

    // 检查是否已有同名项目
    const sameNameProject = projects.find(p => p.name === newName && p.id !== projectId);
    if (sameNameProject) {
      console.warn(`[ProjectStore] 已存在同名项目: ${newName}`);
      return;
    }

    const updatedProjects = projects.map(p =>
      p.id === projectId ? { ...p, name: newName } : p
    );

    set({ projects: updatedProjects });

    // 自动保存
    await saveProjects();

    console.log(`[ProjectStore] 项目已重命名: ${project.name} -> ${newName}`);
  },

  /**
   * 从本地加载项目列表
   */
  loadProjects: async () => {
    // 使用异步路径，确保路径正确
    const dataPath = await getUserDataPathAsync();
    const projectsPath = joinPath(dataPath, 'projects.json');

    try {
      const data = await readJsonFile<ProjectsData>(projectsPath);

      if (data) {
        // 验证 activeProjectId 是否有效
        let activeId = data.activeProjectId || null;
        if (activeId && !data.projects?.some(p => p.id === activeId)) {
          activeId = null;
        }

        set({
          projects: data.projects || [],
          recentProjects: data.recentProjects || [],
          activeProjectId: activeId,
        });
        console.log(`[ProjectStore] 已加载 ${data.projects?.length || 0} 个项目 from ${projectsPath}`);

        // 通知主进程恢复激活项目（用于 CodeGraph 初始化）
        if (activeId) {
          const activeProject = (data.projects || []).find(p => p.id === activeId);
          if (activeProject) {
            window.api.project.opened(activeProject.path).catch(
              (err) => console.warn('[ProjectStore] CodeGraph 初始化通知失败:', err)
            );
          }
        }
      } else {
        // 文件不存在，初始化空状态
        set({ projects: [], recentProjects: [], activeProjectId: null });
        console.log('[ProjectStore] 未找到项目数据，已初始化空状态');
      }
    } catch (error) {
      console.error('[ProjectStore] 加载项目失败:', error);
      set({ projects: [], recentProjects: [], activeProjectId: null });
    }
  },

  /**
   * 保存项目列表到本地
   */
  saveProjects: async () => {
    const { projects, recentProjects, activeProjectId } = get();
    // 使用异步路径，确保路径正确
    const dataPath = await getUserDataPathAsync();
    const projectsPath = joinPath(dataPath, 'projects.json');

    try {
      // 确保目录存在
      await ensureDir(dataPath);

      const data: ProjectsData = {
        projects,
        recentProjects,
        activeProjectId,
      };

      const success = await writeJsonFile(projectsPath, data);

      if (success) {
        console.log(`[ProjectStore] 已保存 ${projects.length} 个项目 to ${projectsPath}`);
      } else {
        console.error('[ProjectStore] 保存项目失败');
      }
    } catch (error) {
      console.error('[ProjectStore] 保存项目失败:', error);
    }
  },

  /**
   * 初始化 Store
   * 确保存储目录存在并加载项目列表
   * 多次调用会返回同一个 Promise
   */
  initialize: async () => {
    // 已经初始化完成
    if (initialized) return;

    // 正在初始化中，返回现有 Promise
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      try {
        // 确保存储目录存在
        await initializeStorage();
        // 加载项目列表
        await get().loadProjects();
        initialized = true;
        console.log('[ProjectStore] 初始化完成');
      } catch (error) {
        console.error('[ProjectStore] 初始化失败:', error);
        initPromise = null;
        throw error;
      }
    })();

    return initPromise;
  },

  /**
   * 检查是否已初始化
   */
  isInitialized: () => initialized,

  /**
   * 恢复上次打开的项目
   * 根据最近项目列表和激活状态恢复
   */
  restoreLastProject: () => {
    const { projects, recentProjects, activeProjectId } = get();

    // 如果已有激活项目，无需恢复
    if (activeProjectId) {
      const activeProject = projects.find(p => p.id === activeProjectId);
      if (activeProject) {
        console.log(`[ProjectStore] 已有激活项目: ${activeProject.name}`);
        return;
      }
    }

    // 尝试从最近项目列表恢复
    for (const recentId of recentProjects) {
      const project = projects.find(p => p.id === recentId);
      if (project) {
        console.log(`[ProjectStore] 恢复最近项目: ${project.name}`);
        get().openProject(recentId);
        return;
      }
    }

    // 如果项目列表中有项目但没有最近记录，打开第一个
    if (projects.length > 0) {
      console.log(`[ProjectStore] 打开第一个项目: ${projects[0].name}`);
      get().openProject(projects[0].id);
      return;
    }

    console.log('[ProjectStore] 没有可恢复的项目');
  },

  /**
   * 重新排序项目（用于标签页拖拽排序）
   * @param sourceId 被拖拽项目的 ID
   * @param targetId 目标项目的 ID
   * @param dropPosition 插入位置（before/after）
   */
  reorderProjects: (sourceId, targetId, dropPosition) => {
    const { projects, saveProjects } = get();

    const sourceIndex = projects.findIndex(p => p.id === sourceId);
    const targetIndex = projects.findIndex(p => p.id === targetId);

    if (sourceIndex === -1 || targetIndex === -1) {
      console.warn(`[ProjectStore] 无效的项目 ID: source=${sourceId}, target=${targetId}`);
      return;
    }

    // 复制数组进行操作
    const reorderedProjects = [...projects];
    const [removed] = reorderedProjects.splice(sourceIndex, 1);

    // 根据拖拽位置计算最终插入索引
    let insertIndex = targetIndex;
    if (dropPosition === 'after') {
      insertIndex = sourceIndex < targetIndex ? targetIndex : targetIndex + 1;
    } else {
      insertIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    }

    // 插入到新位置
    reorderedProjects.splice(insertIndex, 0, removed);

    set({ projects: reorderedProjects });

    // 保存到持久化存储
    saveProjects().catch(err => console.error('[ProjectStore] 保存项目顺序失败:', err));

    console.log(`[ProjectStore] 项目已重新排序: ${sourceId} -> ${targetId} (${dropPosition})`);
  },

  /**
   * 更新项目属性
   * @param projectId 项目 ID
   * @param updates 要更新的字段
   */
  updateProject: (projectId, updates) => {
    const { projects, saveProjects } = get();

    const index = projects.findIndex(p => p.id === projectId);
    if (index === -1) {
      console.warn(`[ProjectStore] 项目不存在: ${projectId}`);
      return;
    }

    const updatedProjects = [...projects];
    updatedProjects[index] = { ...updatedProjects[index], ...updates };

    set({ projects: updatedProjects });

    // 保存到持久化存储
    saveProjects().catch(err => console.error('[ProjectStore] 保存项目失败:', err));

    console.log(`[ProjectStore] 项目已更新: ${projectId}`, updates);
  },
}));
