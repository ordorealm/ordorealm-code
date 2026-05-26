# Product-Spec.md

> 产品需求规格说明书
> 项目：devflow-ide
> 创建日期：2026-05-24
> 更新日期：2026-05-26
> 版本：1.1.0

---

## 产品概述

### 1.1 产品名称

专家技能库管理功能（Expert Skill Library Management）

### 1.2 产品简介

为 devflow-ide 添加专家技能库管理功能，允许用户上传、管理和切换多套预配置的技能库。技能库类似于 `.claude` 目录结构，包含 CLAUDE.md、settings.json、skills 等配置文件。用户可以在不同项目中快速切换使用不同的专家技能配置，实现专家经验的复用。

### 1.3 目标用户

个人开发者或小团队开发者，希望在多个项目中复用已验证可运行的技能配置。

### 1.4 核心价值

- **复用专家经验**：将验证过的技能配置打包为技能库，在不同项目中快速激活
- **避免手动配置**：无需每次手动配置 .claude 目录内容
- **多 Agent 支持**：一套技能库可适配 Claude Code、Codex、OpenCode 等不同 Agent

---

## 应用场景

### 场景 1：切换项目类型

```yaml
who: 前端开发者
situation: 在开发 React 项目和 Node.js CLI 项目之间切换
how:
  1. 在设置中已添加两套技能库："React 专家库" 和 "CLI 专家库"
  2. 打开 React 项目，在会话输入框旁选择 "React 专家库"
  3. 系统提示"将清空当前项目技能"，确认后激活
  4. .claude/ 目录被替换为 React 专家库内容
outcome: Claude 自动获得 React 项目的专家技能和配置
```

### 场景 2：新增技能库

```yaml
who: 开发者
situation: 开发了一套新的 superspec 技能库，想在 IDE 中使用
how:
  1. 在设置界面点击"添加专家技能库"
  2. 上传 zip 文件（包含技能库内容）
  3. 填写名称："Superspec 全流程"
  4. 填写说明："自动化从需求到交付的开发全流程"
  5. 选择 Agent 类型：Claude Code
  6. 保存后可在会话中使用
outcome: 技能库已添加到列表，随时可激活使用
```

### 场景 3：管理已有技能库

```yaml
who: 开发者
situation: 查看、编辑或删除已添加的技能库
how:
  1. 在设置界面切换到"专家技能库"标签页
  2. 看到技能库列表，每个显示：名称、说明、Agent 类型、文件大小
  3. 可以编辑名称和说明
  4. 可以删除不需要的技能库
  5. 可以下载已上传的技能库
outcome: 技能库列表保持整洁
```

### 场景 4：切换技能库

```yaml
who: 开发者
situation: 当前项目需要使用不同的技能配置
how:
  1. 在会话界面的输入框上方，点击技能库选择器
  2. 当前显示"选择技能库..."
  3. 从下拉列表选择目标技能库
  4. 系统弹出确认框："切换技能库将清空当前项目的技能配置"
  5. 确认后，系统解压技能库到项目目录
  6. 自动重启会话，让 Agent 重新发现技能
outcome: 项目技能配置已更新，Agent 使用新的技能库
```

---

## 功能索引

### 3.1 功能列表

| ID | 功能名称 | 描述 | 优先级 | specPath |
|----|---------|------|--------|----------|
| F01 | 技能库管理 | 在设置界面管理技能库列表 | P0 | .superspec/features/skill-library-management.md |
| F02 | 技能库激活 | 在会话界面选择并激活技能库 | P0 | .superspec/features/skill-library-activation.md |
| F03 | 远程控制 | 通过微信等渠道远程查看项目状态、切换项目会话 | P1 | .superspec/features/remote-control.md |

### 3.2 功能详情索引

详细功能描述见 `.superspec/features/` 目录：

- [F01 技能库管理](.superspec/features/skill-library-management.md)
- [F02 技能库激活](.superspec/features/skill-library-activation.md)
- [F03 远程控制](.superspec/features/remote-control.md)

---

## 技术方向

### 4.1 产品类型

Desktop 应用（Electron + React），作为 devflow-ide 的内置功能模块。

### 4.2 技术栈

| 层级 | 技术选型 |
|------|---------|
| 渲染层 | React 18 + TypeScript |
| 状态管理 | Zustand |
| IPC 通信 | Electron IPC（现有 API） |
| 文件操作 | Node.js fs + adm-zip（解压） |
| 存储 | 本地文件系统（用户数据目录） |

### 4.3 Agent 类型与目录映射

| AgentType | 配置目录名 | 主文件名 | 设置文件 |
|-----------|-----------|---------|---------|
| `claude-code` | `.claude/` | `CLAUDE.md` | `settings.json` |
| `codex` | `.codex/` | `AGENTS.md` | `codex.json` |
| `opencode` | `.opencode/` | `opencode.md` | `opencode.json` |

### 4.4 数据存储结构

```
{userData}/skill-libraries/
├── {library-id}/
│   ├── library.json      # 元数据（名称、说明、AgentType、大小、时间）
│   └── archive.zip       # 原始 zip 文件
```

### 4.5 项目级激活状态

每个项目/会话独立，可激活不同技能库。当前平台是一个项目一个会话，一个会话只能激活一个技能库。

---

## 约束条件

### 5.1 文件约束

| 约束项 | 限制 |
|--------|------|
| 技能库文件大小 | ≤ 100MB |
| 技能库数量 | 暂不限制 |
| 支持的文件格式 | .zip |

### 5.2 技能库验证规则

上传时必须验证：

1. **文件大小检查**：zip 文件 ≤ 100MB
2. **目录结构检查**：zip 内必须包含主配置文件之一：
   - `CLAUDE.md`（Claude Code）
   - `AGENTS.md`（Codex）
   - `opencode.md`（OpenCode）
   - 或包含子目录，子目录内有上述文件（支持多压缩层）

验证失败时，显示具体错误信息，不允许上传。

### 5.3 主文件重命名规则

根据选择的 Agent 类型，解压后重命名主文件：

| 原文件名 | Agent Type | 目标文件名 |
|---------|------------|-----------|
| 任意 .md 文件 | `claude-code` | `CLAUDE.md` |
| 任意 .md 文件 | `codex` | `AGENTS.md` |
| 任意 .md 文件 | `opencode` | `opencode.md` |

### 5.4 错误处理

| 错误类型 | 处理方式 |
|---------|---------|
| zip 文件无法解压 | 显示错误："无法解压文件，请检查 zip 格式是否正确" |
| 目录结构不符合规范 | 显示错误："技能库结构不符合规范，缺少主配置文件" |
| 目标目录已存在 | 先清空再解压（切换流程的一部分） |
| 磁盘空间不足 | 显示错误："磁盘空间不足，无法解压技能库" |
| 文件大小超限 | 显示错误："文件大小超过 100MB 限制" |

## 不在范围内

| 功能 | 说明 |
|------|------|
| 技能库在线分享/同步 | 不支持云端存储和分享 |
| 技能库版本管理 | 不支持版本回退 |
| 技能库内容预览 | 不支持查看技能库内部内容 |
| 技能库自动更新 | 不支持自动检测和更新 |

---

## 接口设计

### 6.1 IPC 新增频道

| 频道名 | 方向 | 参数 | 返回值 | 说明 |
|--------|------|------|--------|------|
| `skill-library:list` | renderer → main | 无 | `SkillLibrary[]` | 获取技能库列表 |
| `skill-library:add` | renderer → main | `{zipPath, name, description, agentType}` | `SkillLibrary` | 添加技能库 |
| `skill-library:update` | renderer → main | `{id, name, description}` | `SkillLibrary` | 更新元数据 |
| `skill-library:delete` | renderer → main | `{id}` | `boolean` | 删除技能库 |
| `skill-library:download` | renderer → main | `{id}` | `{path: string}` | 获取 zip 文件路径 |
| `skill-library:activate` | renderer → main | `{id, projectPath}` | `{success: boolean, error?: string}` | 激活技能库 |
| `skill-library:validate` | renderer → main | `{zipPath}` | `{valid: boolean, error?: string}` | 验证 zip 文件 |

### 6.2 Store 新增

**skill-library-store.ts**：

```typescript
interface SkillLibraryState {
  libraries: SkillLibrary[];
  activeLibraryId: string | null;  // 当前项目激活的技能库 ID
  isLoading: boolean;
  error: string | null;
  
  // Actions
  loadLibraries: () => Promise<void>;
  addLibrary: (zipPath: string, name: string, description: string, agentType: AgentType) => Promise<SkillLibrary>;
  updateLibrary: (id: string, name: string, description: string) => Promise<void>;
  deleteLibrary: (id: string) => Promise<void>;
  activateLibrary: (libraryId: string, projectPath: string) => Promise<boolean>;
  getActiveLibrary: (projectPath: string) => SkillLibrary | null;
}
```

---

## 7. UI 设计

### 7.1 设置界面

**新增 Tab**：在 SettingsDialog 中添加"专家技能库"标签页。

```
SettingsDialog Tabs:
├── "AI Provider" → ProviderSettings（现有）
├── "外观" → AppearanceSettings（现有）
└── "专家技能库" → SkillLibrarySettings（新增）
```

**SkillLibrarySettings 结构**：

```
SkillLibrarySettings
├── Header
│   ├── 标题："专家技能库"
│   ├── 说明："管理您的专家技能库，切换后将在当前项目中激活"
│   └── "添加技能库" 按钮（主按钮样式）
│
├── 技能库列表
│   ├── 空状态："暂无技能库，点击上方按钮添加"
│   └── SkillLibraryCard[]
│       ├── Agent 类型图标
│       ├── 名称（主标题）
│       ├── 说明（副标题）
│       ├── Agent 类型徽章（不同颜色）
│       ├── 文件大小（如 "2.3 MB"）
│       ├── 创建时间（如 "2026-05-24"）
│       └── 操作按钮组
│           ├── "下载"（导出 zip）
│           ├── "编辑"（修改名称/说明）
│           └── "删除"（红色，需确认）
│
└── AddSkillLibraryDialog（Modal）
    ├── Step 1: 上传文件
    │   ├── 拖拽区域："拖拽 zip 文件到这里，或点击上传"
    │   ├── 上传进度（如需要）
    │   └── 文件信息预览（大小、名称）
    │
    ├── Step 2: 基本信息
    │   ├── 技能库名称（必填，单行输入）
    │   ├── 技能库说明（必填，多行输入）
    │   └── Agent 类型选择（单选按钮组）
    │       ├── ○ Claude Code（紫色徽章）
    │       ├── ○ Codex（蓝色徽章）
    │       └── ○ OpenCode（绿色徽章）
    │
    ├── 验证状态显示
    │   ├── 验证中..."正在验证技能库结构..."
    │   ├── 验证成功 ✓ "技能库结构符合规范"
    │   └── 验证失败 ✗ "错误：缺少主配置文件"
    │
    └── 底部按钮
        ├── "保存"（验证成功后可点击）
        └── "取消"
```

### 7.2 会话界面

**SessionToolbar 扩展**：在 MCP 按钮右边添加技能库选择器。

```
SessionToolbar
├── Skill 按钮（显示可用 Skill 数量）
├── MCP 按钮（显示已连接 MCP 数量）
├── 技能库选择器（新增）← 位于 MCP 右边
│   ├── 下拉按钮样式
│   ├── 默认显示："选择技能库..."
│   ├── 激活后显示：技能库名称 + Agent 类型图标
│   └── 点击展开下拉菜单
│       ├── "无"（不激活任何技能库）
│       ├── 分隔线
│       └── 技能库列表
│           ├── 按 Agent 类型分组
│           ├── Claude Code 分组
│           │   └── 技能库项（显示名称）
│           ├── Codex 分组
│           ├── OpenCode 分组
│           └── 当前激活项高亮
│
└── ContextUsage（Token 使用量）
```

**切换确认弹窗**：

```
ConfirmDialog
├── 标题："切换技能库"
├── 图标：⚠️（警告色）
├── 内容：
│   ├── "切换技能库将清空当前项目的技能配置"
│   ├── "当前技能库：[无/原名称] → 新技能库：[新名称]"
│   ├── "此操作不可撤销，是否继续？"
│
├── "确认切换" 按钮（主按钮，警告色）
└── "取消" 按钮
```

---

## 8. 数据模型

### 8.1 SkillLibrary 类型

```typescript
interface SkillLibrary {
  /** 技能库唯一 ID（UUID） */
  id: string;
  
  /** 技能库名称 */
  name: string;
  
  /** 技能库说明 */
  description: string;
  
  /** 适用的 Agent 类型 */
  agentType: AgentType;
  
  /** 原始 zip 文件大小（字节） */
  fileSize: number;
  
  /** 创建时间（ISO 格式） */
  createdAt: string;
  
  /** 最后更新时间（ISO 格式） */
  updatedAt: string;
}
```

### 8.2 library.json 结构

存储在 `{userData}/skill-libraries/{id}/library.json`：

```json
{
  "id": "uuid-xxx",
  "name": "Superspec 全流程",
  "description": "自动化从需求到交付的开发全流程技能库",
  "agentType": "claude-code",
  "fileSize": 2345678,
  "createdAt": "2026-05-24T05:00:00Z",
  "updatedAt": "2026-05-24T05:00:00Z"
}
```

---

## 9. 激活流程

### 9.1 流程图

```
用户点击技能库选择器
    ↓
选择目标技能库
    ↓
弹出确认弹窗
    ├── 用户取消 → 流程结束
    └── 用户确认 → 继续
    ↓
调用 skill-library:activate IPC
    ↓
主进程执行：
    ├── 1. 获取技能库 zip 文件路径
    ├── 2. 解析 zip 内容，检测目录结构
    ├── 3. 确定目标目录名（根据 agentType）
    ├── 4. 清空目标目录（如果存在）
    ├── 5. 解压 zip 到目标目录
    ├── 6. 重命名主配置文件
    ├── 7. 返回结果
    ↓
渲染进程处理：
    ├── 成功 → 调用 restartSession()
    ├── 失败 → 显示错误信息
    ↓
会话重启完成
    ↓
显示成功提示："技能库已激活，会话已重启"
```

### 9.2 解压细节

```javascript
async function activateSkillLibrary(libraryId, projectPath) {
  // 1. 获取技能库信息
  const library = await getLibrary(libraryId);
  const zipPath = getZipPath(libraryId);
  
  // 2. 确定目标目录
  const targetDirName = {
    'claude-code': '.claude',
    'codex': '.codex',
    'opencode': '.opencode'
  }[library.agentType];
  const targetPath = path.join(projectPath, targetDirName);
  
  // 3. 清空目标目录
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true });
  }
  
  // 4. 解压 zip
  const zip = new AdmZip(zipPath);
  
  // 5. 检测 zip 内结构（支持多层压缩）
  const entries = zip.getEntries();
  const rootEntry = findRootDirectory(entries);
  
  // 6. 解压到目标目录
  zip.extractAllTo(targetPath, true);
  
  // 7. 重命名主配置文件
  const targetMainFile = {
    'claude-code': 'CLAUDE.md',
    'codex': 'AGENTS.md',
    'opencode': 'opencode.md'
  }[library.agentType];
  
  const existingMd = findMdFile(targetPath);
  if (existingMd && existingMd !== targetMainFile) {
    fs.renameSync(
      path.join(targetPath, existingMd),
      path.join(targetPath, targetMainFile)
    );
  }
  
  return { success: true };
}
```

---

## 10. 远程控制功能（F03）

### 10.1 功能概述

为 devflow-ide 添加远程控制功能，允许用户通过微信 ClawBot 等渠道远程查看项目会话状态、切换项目会话、管理 MCP 和技能组。主控 Agent 在 IDE 内部运行，复用现有 AI Provider 能力。

### 10.2 应用场景

#### 场景 5：外出时查看项目状态

```yaml
who: 开发者
situation: 外出开会，想通过手机微信查看 devflow-ide 各项目会话的运行状态
how:
  1. 在手机微信中打开已连接的 ClawBot
  2. 发送 "/status" 指令
  3. 主控 Agent 返回所有项目会话的状态列表
  4. 查看各项目是否在运行、当前任务进度等
outcome: 无需回到电脑前即可掌握项目状态
```

#### 场景 6：远程切换项目会话

```yaml
who: 开发者
situation: 外出时需要切换到另一个项目进行对话
how:
  1. 在手机微信 ClawBot 中发送 "切换到 react-demo 项目"
  2. 主控 Agent 理解自然语言意图
  3. 手机端弹出确认提示："确认切换到 react-demo 项目？"
  4. 用户确认后，主控 Agent 切换到目标项目会话
  5. 后续消息直接与目标项目会话交互
outcome: 远程完成项目切换，无需操作电脑
```

#### 场景 7：远程管理 MCP 和技能组

```yaml
who: 开发者
situation: 需要检查 MCP 工具状态或切换项目技能组
how:
  1. 发送 "/mcp status" 查看 MCP 工具状态
  2. 发送 "/mcp start github" 启动指定 MCP
  3. 发送 "/skillgroup list" 列出可用技能组
  4. 发送 "/skillgroup switch superspec" 切换技能组
outcome: 远程管理 IDE 配置
```

### 10.3 技术架构

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Main Process                                       │
│  ├── WeClaw SDK (npm 依赖)                                   │
│  │   └── 消息推送由 SDK 内部处理                              │
│  ├── 主控 Agent                                              │
│  │   ├── 复用现有 AI Provider                                │
│  │   ├── 自然语言理解                                        │
│  │   └── 权限控制（禁止删除项目、重置会话）                     │
│  └── 通道适配器层                                             │
│       ├── WeChatChannelAdapter (首期)                        │
│       ├── WeComChannelAdapter (二期)                         │
│       └── FeishuChannelAdapter (三期)                        │
└─────────────────────────────────────────────────────────────┘
```

### 10.4 会话切换流程

```
项目会话 ──"切换项目"──→ 主控 Agent 会话 ──询问切换──→ 目标项目会话
                           ↓
                    只有在此处可询问状态
```

**关键规则**：
- 用户在项目会话中输入"切换项目"，自动回到主控 Agent 会话
- 只有在主控 Agent 会话中才能询问状态
- 主控 Agent 不能删除项目、不能重置项目会话

### 10.5 主控 Agent 指令

| 指令 | 说明 | 需要确认 |
|------|------|---------|
| `/status` | 查看所有项目会话状态 | ❌ 无需确认 |
| `/switch <项目名>` | 切换到指定项目会话 | ✅ 需确认 |
| `/restart <项目名>` | 重启指定项目会话 | ✅ 需确认 |
| `/mcp status` | 查看 MCP 工具状态 | ❌ 无需确认 |
| `/mcp start <名称>` | 启动指定 MCP | ✅ 需确认 |
| `/mcp stop <名称>` | 停止指定 MCP | ✅ 需确认 |
| `/skillgroup list` | 列出可用技能组 | ❌ 无需确认 |
| `/skillgroup switch <名称>` | 切换技能组 | ✅ 需确认 |
| `/help` | 显示帮助信息 | ❌ 无需确认 |

### 10.6 界面设计

**设置界面新增 Tab**：

```
SettingsDialog Tabs:
├── "AI Provider" → ProviderSettings
├── "外观" → AppearanceSettings
├── "专家技能库" → SkillLibrarySettings
├── "MCP 工具" → MCPSettings
└── "远程控制" → RemoteControlSettings（新增）
```

**RemoteControlSettings 结构**：

```
RemoteControlSettings
├── Header
│   ├── 标题："远程控制"
│   ├── 说明："通过微信等渠道远程管理 devflow-ide"
│   └── 启用开关
│
├── 已连接通道列表
│   ├── 空状态："暂无已连接的通道"
│   └── ChannelCard[]
│       ├── 微信 ClawBot
│       │   ├── 状态图标（🟢 已连接 / ⚪ 未连接）
│       │   ├── 通道名称
│       │   ├── 连接时间
│       │   └── 操作按钮
│       │       ├── [断开]
│       │       └── [详情]
│       ├── 企业微信（未接入，显示"即将推出"）
│       └── 飞书（未接入，显示"即将推出"）
│
├── 添加通道按钮
│   └── [ + 添加新通道 ]
│
└── 安全设置
    ├── [✓] 重要操作需手机端确认
    └── 说明："切换项目、重启会话等操作需要手机端二次确认"
```

**扫码接入弹窗**：

```
AddChannelDialog
├── 标题："接入微信 ClawBot"
├── 二维码区域
│   ├── QR Code（由 WeClaw SDK 生成）
│   └── 倒计时："请在 60 秒内扫码"
├── 步骤提示
│   ├── 1. 使用手机微信扫描二维码
│   ├── 2. 在手机端确认授权
│   └── 3. 连接成功
└── [取消] 按钮
```

### 10.7 IPC 新增频道

| 频道名 | 方向 | 参数 | 返回值 | 说明 |
|--------|------|------|--------|------|
| `remote-control:get-status` | renderer → main | 无 | `RemoteControlStatus` | 获取远程控制状态 |
| `remote-control:connect` | renderer → main | `{channelType: 'wechat'}` | `{qrCode: string}` | 发起连接，返回二维码 |
| `remote-control:disconnect` | renderer → main | `{channelId: string}` | `boolean` | 断开通道 |
| `remote-control:list-channels` | renderer → main | 无 | `Channel[]` | 获取已连接通道列表 |
| `remote-control:update-settings` | renderer → main | `{requireConfirm: boolean}` | `boolean` | 更新安全设置 |

### 10.8 数据模型

```typescript
interface Channel {
  /** 通道唯一 ID */
  id: string;
  
  /** 通道类型 */
  type: 'wechat' | 'wecom' | 'feishu';
  
  /** 连接状态 */
  status: 'connected' | 'disconnected' | 'pending';
  
  /** 连接时间 */
  connectedAt: string | null;
  
  /** 用户授权令牌（加密存储） */
  authToken: string;
}

interface RemoteControlSettings {
  /** 是否启用远程控制 */
  enabled: boolean;
  
  /** 重要操作是否需要确认 */
  requireConfirm: boolean;
  
  /** 已连接通道 */
  channels: Channel[];
}
```

### 10.9 数据存储

**文件持久化**：

```
{userData}/remote-control/
├── settings.json           # 配置信息（加密）
└── tokens/
    └── wechat.enc          # 授权令牌（加密）
```

**加密方式**：使用 Node.js crypto 模块，基于机器唯一标识生成密钥。

### 10.10 约束条件

| 约束项 | 限制 |
|--------|------|
| 同时连接通道数 | ≤ 3 个 |
| 消息响应延迟 | < 3 秒 |
| 扫码超时时间 | 60 秒 |

### 10.11 主控 Agent 权限控制

| 操作 | 允许 |
|------|------|
| 理解自然语言 | ✅ |
| 查看项目状态 | ✅ |
| 切换项目会话 | ✅ |
| 重启项目会话 | ✅ |
| 管理 MCP 工具 | ✅ |
| 切换技能组 | ✅ |
| 删除项目 | ❌ |
| 重置项目会话 | ❌ |

### 10.12 本期不做

| 功能 | 说明 |
|------|------|
| 语音消息支持 | 仅支持文本消息 |
| 多人协作 | 不支持多人同时远程控制 |
| 操作日志审计 | 后续版本考虑 |
| 图片/文件传输 | 后续版本考虑 |

---

## 11. 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.1.0 | 2026-05-26 | 新增远程控制功能（F03）需求 |
| 1.0.0 | 2026-05-24 | 初始版本，定义专家技能库管理功能需求 |

---

## 12. 附录

### 12.1 相关文件

- `.superspec/features/skill-library-management.md` - 技能库管理功能详情
- `.superspec/features/skill-library-activation.md` - 技能库激活功能详情
- `.superspec/features/remote-control.md` - 远程控制功能详情

### 12.2 参考资料

- Claude Code 文档：https://docs.anthropic.com/claude-code
- Codex CLI：https://github.com/openai/codex
- OpenCode：https://github.com/sst/opencode
- WeClaw SDK 文档：待补充