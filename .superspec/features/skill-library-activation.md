# F02: 技能库激活

> 功能详情文档
> 版本：1.0.0
> 创建日期：2026-05-24

---

## 1. 功能概述

在会话界面选择并激活技能库，将技能库内容解压到当前项目目录，并重启会话让 Agent 重新发现技能。

---

## 2. 用户故事

```
作为一名开发者，
我想要在会话中快速切换技能库，
以便让 Agent 使用不同的专家技能配置。
```

---

## 3. 功能列表

| ID | 子功能 | 描述 | 优先级 |
|----|--------|------|--------|
| F02-1 | 技能库选择器 | 在工具栏显示技能库选择器 | P0 |
| F02-2 | 切换确认 | 切换前显示确认弹窗 | P0 |
| F02-3 | 执行切换 | 解压技能库并重启会话 | P0 |
| F02-4 | 状态显示 | 显示当前激活的技能库 | P0 |

---

## 4. 详细设计

### 4.1 技能库选择器 (F02-1)

**位置**：SessionToolbar 中，MCP 按钮右边

**用户操作**：
1. 点击技能库选择器
2. 展开下拉列表
3. 选择目标技能库

**系统行为**：
- 加载技能库列表
- 按 Agent 类型分组显示
- 当前激活项高亮

**界面元素**：

```
SessionToolbar:
┌─────────┬─────────┬──────────────────┬───────────┐
│ Skills  │ 2 MCPs  │ 选择技能库... ▼   │ 12K/200K  │
└─────────┴─────────┴──────────────────┴───────────┘
                          ↓ 点击展开
┌─────────────────────────────────────┐
│ ○ 无                                 │
│ ─────────────────────────────────── │
│ Claude Code                          │
│   ○ Superspec 全流程                 │
│   ○ React 专家库                     │
│ Codex                                │
│   ○ CLI 最佳实践                     │
│ OpenCode                             │
│   ○ 通用技能库                       │
└─────────────────────────────────────┘
```

**激活后显示**：

```
┌───────────────────────────────────────────────────────────┐
│ Skills │ 2 MCPs │ 🟣 Superspec 全流程 ▼  │ 12K/200K      │
└────────┴────────┴────────────────────────────────────────┘
```

**组件结构**：

```tsx
interface SkillLibrarySelectorProps {
  projectId: string;
  sessionId: string;
}

function SkillLibrarySelector({ projectId, sessionId }: SkillLibrarySelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedLibrary, setSelectedLibrary] = useState<SkillLibrary | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingLibrary, setPendingLibrary] = useState<SkillLibrary | null>(null);
  
  const { libraries, activeLibraryId, activateLibrary } = useSkillLibraryStore();
  const { restartSession } = useSessionStore();
  
  const handleSelect = (library: SkillLibrary | null) => {
    setPendingLibrary(library);
    setShowConfirm(true);
    setIsOpen(false);
  };
  
  const handleConfirm = async () => {
    if (pendingLibrary) {
      const success = await activateLibrary(pendingLibrary.id, projectId);
      if (success) {
        await restartSession(sessionId);
        setSelectedLibrary(pendingLibrary);
      }
    }
    setShowConfirm(false);
    setPendingLibrary(null);
  };
  
  return (
    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger>
          {selectedLibrary ? (
            <span>{getAgentIcon(selectedLibrary.agentType)} {selectedLibrary.name}</span>
          ) : (
            <span>选择技能库...</span>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => handleSelect(null)}>
            无
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {groupByAgentType(libraries).map(([agentType, libs]) => (
            <div key={agentType}>
              <DropdownMenuLabel>{AGENT_DISPLAY_NAMES[agentType]}</DropdownMenuLabel>
              {libs.map(lib => (
                <DropdownMenuItem 
                  key={lib.id}
                  onClick={() => handleSelect(lib)}
                  active={lib.id === activeLibraryId}
                >
                  {lib.name}
                </DropdownMenuItem>
              ))}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      
      <ConfirmDialog
        isOpen={showConfirm}
        title="切换技能库"
        onConfirm={handleConfirm}
        onCancel={() => setShowConfirm(false)}
      >
        <p>⚠️ 切换技能库将清空当前项目的技能配置</p>
        <p>当前技能库：{selectedLibrary?.name || '无'} → 新技能库：{pendingLibrary?.name || '无'}</p>
        <p>此操作不可撤销，是否继续？</p>
      </ConfirmDialog>
    </>
  );
}
```

---

### 4.2 切换确认 (F02-2)

**触发条件**：用户选择技能库后

**确认弹窗内容**：

```
┌─────────────────────────────────────────────────────────────┐
│  ⚠️ 切换技能库                                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  切换技能库将清空当前项目的技能配置                           │
│                                                             │
│  当前技能库：无                                              │
│  新技能库：Superspec 全流程                                  │
│                                                             │
│  此操作不可撤销，是否继续？                                   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                      [取消]  [确认切换]                      │
└─────────────────────────────────────────────────────────────┘
```

**文案规则**：

| 场景 | 当前显示 |
|------|---------|
| 首次激活（无原技能库） | "当前技能库：无" |
| 切换激活 | "当前技能库：[原名] → 新技能库：[新名]" |
| 取消激活 | "当前技能库：[原名] → 新技能库：无" |

---

### 4.3 执行切换 (F02-3)

**切换流程**：

```
用户确认切换
    ↓
显示加载状态："正在激活技能库..."
    ↓
调用 skill-library:activate IPC
    ↓
主进程执行：
    ├── 1. 读取技能库 zip 文件
    ├── 2. 确定目标目录（根据 agentType）
    ├── 3. 清空目标目录
    ├── 4. 解压 zip 到目标目录
    ├── 5. 重命名主配置文件
    └── 6. 返回结果
    ↓
渲染进程处理：
    ├── 成功 → 调用 restartSession(sessionId)
    ├── 失败 → 显示错误信息
    ↓
重启会话完成
    ↓
显示成功提示："技能库已激活，会话已重启"
```

**主进程实现**：

```typescript
// electron/main/skill-library-handlers.ts

async function handleActivate(
  _event: IpcMainInvokeEvent,
  { id, projectPath }: { id: string; projectPath: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    // 1. 获取技能库信息
    const libraryPath = path.join(skillLibrariesDir, id);
    const libraryJson = JSON.parse(
      fs.readFileSync(path.join(libraryPath, 'library.json'), 'utf-8')
    );
    const zipPath = path.join(libraryPath, 'archive.zip');
    
    // 2. 确定目标目录
    const targetDirMap: Record<AgentType, string> = {
      'claude-code': '.claude',
      'codex': '.codex',
      'opencode': '.opencode'
    };
    const targetDirName = targetDirMap[libraryJson.agentType];
    const targetPath = path.join(projectPath, targetDirName);
    
    // 3. 清空目标目录
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    
    // 4. 创建目标目录
    fs.mkdirSync(targetPath, { recursive: true });
    
    // 5. 解压 zip
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    
    // 检测是否有嵌套目录
    const rootDir = findRootDirectory(entries);
    
    // 解压
    entries.forEach(entry => {
      if (entry.isDirectory) return;
      
      // 去掉根目录层级（如果有）
      let entryName = entry.entryName;
      if (rootDir && entryName.startsWith(rootDir)) {
        entryName = entryName.slice(rootDir.length);
      }
      
      const destPath = path.join(targetPath, entryName);
      const destDir = path.dirname(destPath);
      
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      
      fs.writeFileSync(destPath, entry.getData());
    });
    
    // 6. 重命名主配置文件
    const targetMainFileMap: Record<AgentType, string> = {
      'claude-code': 'CLAUDE.md',
      'codex': 'AGENTS.md',
      'opencode': 'opencode.md'
    };
    const targetMainFile = targetMainFileMap[libraryJson.agentType];
    
    // 查找现有的 .md 文件
    const mdFiles = fs.readdirSync(targetPath)
      .filter(f => f.endsWith('.md'));
    
    if (mdFiles.length > 0 && !mdFiles.includes(targetMainFile)) {
      // 重命名第一个 .md 文件为目标文件
      fs.renameSync(
        path.join(targetPath, mdFiles[0]),
        path.join(targetPath, targetMainFile)
      );
    }
    
    return { success: true };
    
  } catch (error) {
    console.error('[SkillLibrary] Activate failed:', error);
    return { success: false, error: error.message };
  }
}

// 辅助函数：查找 zip 根目录
function findRootDirectory(entries: AdmZip.IZipEntry[]): string | null {
  const topLevelDirs = entries
    .filter(e => e.isDirectory)
    .filter(e => e.entryName.split('/').length === 2)
    .map(e => e.entryName);
  
  // 如果只有一个顶级目录，且包含主配置文件，则返回该目录
  if (topLevelDirs.length === 1) {
    const dir = topLevelDirs[0];
    const mainFiles = ['CLAUDE.md', 'AGENTS.md', 'opencode.md'];
    const hasMainFile = entries.some(e => 
      e.entryName.startsWith(dir) && 
      mainFiles.some(mf => e.entryName.endsWith(mf))
    );
    if (hasMainFile) {
      return dir;
    }
  }
  
  return null;
}
```

---

### 4.4 状态显示 (F02-4)

**显示规则**：

| 状态 | 显示内容 |
|------|---------|
| 未激活 | "选择技能库..." |
| 激活中 | 加载动画 + "激活中..." |
| 已激活 | Agent 图标 + 技能库名称 |
| 激活失败 | 红色错误提示 |

**Agent 图标**：

| AgentType | 图标 | 颜色 |
|-----------|------|------|
| `claude-code` | 🟣 | 紫色 |
| `codex` | 🔵 | 蓝色 |
| `opencode` | 🟢 | 绿色 |

---

## 5. IPC 接口

### 5.1 skill-library:activate

```typescript
// 渲染进程调用
const result = await window.api.skillLibrary.activate({
  id: 'uuid-xxx',
  projectPath: '/path/to/project'
});
// 返回: { success: boolean; error?: string }
```

### 5.2 Preload 扩展

```typescript
// electron/preload/index.ts

skillLibrary: {
  list: () => ipcRenderer.invoke('skill-library:list'),
  add: (params) => ipcRenderer.invoke('skill-library:add', params),
  update: (params) => ipcRenderer.invoke('skill-library:update', params),
  delete: (params) => ipcRenderer.invoke('skill-library:delete', params),
  download: (params) => ipcRenderer.invoke('skill-library:download', params),
  validate: (params) => ipcRenderer.invoke('skill-library:validate', params),
  activate: (params) => ipcRenderer.invoke('skill-library:activate', params),
}
```

---

## 6. Store 设计

### 6.1 skill-library-store.ts

```typescript
import { create } from 'zustand';
import type { SkillLibrary, AgentType } from '@/types';

interface SkillLibraryState {
  libraries: SkillLibrary[];
  activeLibraryId: string | null;
  isLoading: boolean;
  error: string | null;
  
  // Actions
  loadLibraries: () => Promise<void>;
  addLibrary: (
    zipPath: string, 
    name: string, 
    description: string, 
    agentType: AgentType
  ) => Promise<SkillLibrary | null>;
  updateLibrary: (
    id: string, 
    name: string, 
    description: string
  ) => Promise<boolean>;
  deleteLibrary: (id: string) => Promise<boolean>;
  activateLibrary: (libraryId: string | null, projectPath: string) => Promise<boolean>;
  getActiveLibrary: () => SkillLibrary | null;
}

export const useSkillLibraryStore = create<SkillLibraryState>((set, get) => ({
  libraries: [],
  activeLibraryId: null,
  isLoading: false,
  error: null,
  
  loadLibraries: async () => {
    set({ isLoading: true, error: null });
    try {
      const libraries = await window.api.skillLibrary.list();
      set({ libraries, isLoading: false });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  },
  
  activateLibrary: async (libraryId, projectPath) => {
    if (!libraryId) {
      // 取消激活，清空目标目录
      // 需要知道当前 Agent 类型才能确定目标目录
      return false;
    }
    
    set({ isLoading: true, error: null });
    try {
      const result = await window.api.skillLibrary.activate({
        id: libraryId,
        projectPath
      });
      
      if (result.success) {
        set({ activeLibraryId: libraryId, isLoading: false });
        return true;
      } else {
        set({ error: result.error, isLoading: false });
        return false;
      }
    } catch (error) {
      set({ error: error.message, isLoading: false });
      return false;
    }
  },
  
  getActiveLibrary: () => {
    const { libraries, activeLibraryId } = get();
    return libraries.find(l => l.id === activeLibraryId) || null;
  },
  
  // ... 其他方法
}));
```

---

## 7. 错误处理

| 错误场景 | 错误信息 | 用户操作 |
|---------|---------|---------|
| 技能库文件不存在 | 技能库文件已损坏，请重新添加 | 删除并重新添加 |
| 目标目录清空失败 | 无法清空目标目录，请检查权限 | 检查文件权限 |
| 解压失败 | 解压失败：[具体错误] | 重新上传技能库 |
| 重命名失败 | 无法重命名配置文件 | 手动检查目录 |
| 会话重启失败 | 技能库已激活，但会话重启失败 | 手动重启会话 |

---

## 8. 测试要点

| 测试场景 | 预期结果 |
|---------|---------|
| 选择技能库 | 显示确认弹窗 |
| 确认切换 | 技能库解压成功，会话重启 |
| 取消切换 | 无变化，弹窗关闭 |
| 切换到不同 Agent 类型的技能库 | 目录名和主文件名正确 |
| 切换时项目目录不存在 | 创建目录并解压 |
| 切换时网络断开 | 显示错误信息 |

---

## 9. 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-05-24 | 初始版本 |