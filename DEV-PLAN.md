# Development Plan — devflow-ide 专家技能库管理功能

> 开发计划
> 项目：devflow-ide 专家技能库管理功能
> 创建日期：2026-05-24
> 版本：1.0.0

---

## 项目信息

| 属性 | 值 |
|------|-----|
| 项目名称 | devflow-ide 专家技能库管理功能 |
| 技术栈 | Electron + React + TypeScript + Zustand |
| 总 Phase 数 | 5 |
| 总 Task 数 | 20 |
| 预计工时 | ~30 小时 |

---

## Phase 索引

| Phase | 名称 | Task 数量 | 依赖 | 状态 |
|-------|------|-----------|------|------|
| Phase 1 | 类型定义与接口设计 | 3 | 无 | ⬜ |
| Phase 2 | 主进程 IPC 实现 | 5 | Phase 1 | ⬜ |
| Phase 3 | 渲染进程基础设施 | 4 | Phase 1 | ⬜ |
| Phase 4 | 技能库管理界面（F01） | 5 | Phase 2, Phase 3 | ⬜ |
| Phase 5 | 技能库激活界面（F02） | 3 | Phase 4 | ⬜ |

---

## 功能依赖图

```
Phase 1: 类型定义与接口设计
    ├── SkillLibrary 类型
    ├── IPC 频道定义
    └── Preload API 扩展
         ↓
    ┌────┴────┐
    ↓         ↓
Phase 2:    Phase 3:
主进程 IPC   渲染进程基础
    │         │
    │    ┌────┴────┐
    │    │         │
    │    ↓         │
    │  Store 实现   │
    │    │         │
    └────┼─────────┘
         ↓
    Phase 4: 技能库管理界面（F01）
         │
         ↓
    Phase 5: 技能库激活界面（F02）
```

---

## 执行策略

### 并行策略

Phase 2 和 Phase 3 可并行执行（都只依赖 Phase 1）：
```
Phase 1 → [Phase 2, Phase 3] → Phase 4 → Phase 5
```

### 恢复策略

- **Phase 级恢复**：中断后从当前 Phase 的第一个 pending Task 继续
- **Task 级恢复**：失败后使用 `/superspec-fix {task-id}` 重试

---

## Phase 详情

### Phase 1: 类型定义与接口设计

**目标**：定义共享类型和 IPC 接口

**Task 列表**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|---------|------|--------|
| 1-1 | 定义 SkillLibrary 类型 | 0.5h | 无 | `src/renderer/src/types/skill-library.types.ts` |
| 1-2 | 扩展 Preload API | 1h | 1-1 | `electron/preload/index.ts` |
| 1-3 | 安装 adm-zip 依赖 | 0.5h | 无 | `package.json` |

**验收标准**：
- [ ] SkillLibrary 类型定义完整
- [ ] Preload 暴露 skillLibrary API
- [ ] TypeScript 编译通过

---

### Phase 2: 主进程 IPC 实现

**目标**：实现所有 IPC handlers 和文件操作

**Task 列表**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|---------|------|--------|
| 2-1 | 创建 skill-library-handlers.ts | 1h | 1-1 | `electron/main/skill-library-handlers.ts` |
| 2-2 | 实现技能库列表管理 | 1h | 2-1 | list/add/update/delete handlers |
| 2-3 | 实现技能库验证 | 1h | 2-1 | validate handler |
| 2-4 | 实现技能库激活 | 2h | 2-1 | activate handler |
| 2-5 | 注册 IPC handlers | 0.5h | 2-2, 2-3, 2-4 | `electron/main/index.ts` |

**验收标准**：
- [ ] 所有 IPC handlers 实现完成
- [ ] 文件操作正确（存储在 userData 目录）
- [ ] zip 解压和验证逻辑正确
- [ ] 主进程编译通过

---

### Phase 3: 渲染进程基础设施

**目标**：实现 Store 和工具函数

**Task 列表**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|---------|------|--------|
| 3-1 | 创建 skill-library-store | 2h | 1-1 | `src/renderer/src/stores/skill-library-store.ts` |
| 3-2 | 创建文件大小格式化工具 | 0.5h | 无 | `src/renderer/src/utils/format.ts` |
| 3-3 | 创建 Agent 图标组件 | 0.5h | 无 | `src/renderer/src/components/common/AgentIcon.tsx` |
| 3-4 | 扩展 window.api 类型 | 0.5h | 1-2 | `src/renderer/src/env.d.ts` |

**验收标准**：
- [ ] Store 实现所有 actions
- [ ] 工具函数正确
- [ ] TypeScript 编译通过

---

### Phase 4: 技能库管理界面（F01）

**目标**：实现设置界面的技能库管理功能

**Task 列表**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|---------|------|--------|
| 4-1 | 创建 SkillLibrarySettings 组件 | 2h | 2-5, 3-1 | `src/renderer/src/components/settings/SkillLibrarySettings.tsx` |
| 4-2 | 创建 SkillLibraryCard 组件 | 1h | 4-1 | `src/renderer/src/components/settings/SkillLibraryCard.tsx` |
| 4-3 | 创建 AddSkillLibraryDialog 组件 | 2h | 4-1 | `src/renderer/src/components/settings/AddSkillLibraryDialog.tsx` |
| 4-4 | 集成到 SettingsDialog | 0.5h | 4-1, 4-2, 4-3 | `src/renderer/src/components/settings/SettingsDialog.tsx` |
| 4-5 | 添加国际化支持 | 1h | 4-4 | i18n 文件 |

**验收标准**：
- [ ] 技能库列表显示正确
- [ ] 添加/编辑/删除功能正常
- [ ] 上传验证正常
- [ ] UI 符合设计规范

---

### Phase 5: 技能库激活界面（F02）

**目标**：实现会话界面的技能库激活功能

**Task 列表**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|---------|------|--------|
| 5-1 | 创建 SkillLibrarySelector 组件 | 2h | 4-4 | `src/renderer/src/components/chat/SkillLibrarySelector.tsx` |
| 5-2 | 集成到 SessionToolbar | 1h | 5-1 | `src/renderer/src/components/chat/SessionToolbar.tsx` |
| 5-3 | 实现会话重启联动 | 1h | 5-2 | 修改 session-store.ts |

**验收标准**：
- [ ] 技能库选择器显示正确
- [ ] 切换确认弹窗正常
- [ ] 激活后会话重启
- [ ] 状态显示正确

---

## 验收标准

### 功能验收

| 功能 | 验收标准 |
|------|---------|
| F01-1 查看技能库列表 | 显示所有技能库，信息正确 |
| F01-2 添加技能库 | 上传、验证、保存成功 |
| F01-3 编辑技能库 | 名称和说明可修改 |
| F01-4 删除技能库 | 确认后删除成功 |
| F01-5 导出技能库 | 可下载 zip 文件 |
| F02-1 技能库选择器 | 下拉列表显示正确 |
| F02-2 切换确认 | 弹窗文案正确 |
| F02-3 执行切换 | 解压成功，会话重启 |
| F02-4 状态显示 | 当前激活状态正确 |

### 技术验收

| 项目 | 标准 |
|------|------|
| TypeScript 编译 | 无错误 |
| 主进程 | 无运行时错误 |
| 渲染进程 | 无控制台错误 |
| 文件操作 | 正确读写 userData 目录 |

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| adm-zip 兼容性 | 解压失败 | 测试多种 zip 格式 |
| 大文件上传 | UI 卡顿 | 添加进度提示 |
| 会话重启失败 | 功能不可用 | 添加错误处理和重试 |

---

## 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-05-24 | 初始版本 |