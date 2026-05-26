# 远程控制功能（F03）

> 功能详情文档
> 创建日期：2026-05-26
> 版本：1.0.0

---

## 1. 功能概述

### 1.1 功能名称

远程控制（Remote Control）

### 1.2 功能描述

为 devflow-ide 添加远程控制功能，允许用户通过微信 ClawBot 等渠道远程查看项目会话状态、切换项目会话、管理 MCP 和技能组。

### 1.3 用户价值

- **随时随地掌控**：外出时也能通过手机查看项目状态
- **远程操作**：无需回到电脑前即可切换项目、管理配置
- **安全可控**：重要操作需手机端二次确认

---

## 2. 用户故事

### US-01：查看项目状态

```
作为 开发者
我想要 通过手机微信查看所有项目会话的状态
以便于 外出时掌握项目运行情况
```

**验收标准**：
- 发送 `/status` 指令返回所有项目会话状态
- 状态包含：项目名称、运行状态、当前任务进度
- 响应时间 < 3 秒

### US-02：切换项目会话

```
作为 开发者
我想要 通过手机微信切换到指定项目会话
以便于 远程开始与另一个项目的对话
```

**验收标准**：
- 发送 "切换到 xxx 项目" 被正确理解
- 手机端弹出确认提示
- 确认后成功切换到目标项目会话
- 后续消息直接与目标项目会话交互

### US-03：管理 MCP 工具

```
作为 开发者
我想要 通过手机微信查看和控制 MCP 工具
以便于 远程管理 IDE 的工具配置
```

**验收标准**：
- `/mcp status` 返回所有 MCP 工具状态
- `/mcp start <名称>` 启动指定 MCP（需确认）
- `/mcp stop <名称>` 停止指定 MCP（需确认）

### US-04：切换技能组

```
作为 开发者
我想要 通过手机微信切换项目会话的技能组
以便于 远程调整项目的技能配置
```

**验收标准**：
- `/skillgroup list` 列出所有可用技能组
- `/skillgroup switch <名称>` 切换技能组（需确认）

### US-05：扫码接入

```
作为 开发者
我想要 在设置界面扫码接入微信 ClawBot
以便于 启用远程控制功能
```

**验收标准**：
- 点击"添加通道"显示二维码
- 手机扫码后在手机端确认授权
- 连接成功后显示"已连接"状态
- 扫码超时时间 60 秒

---

## 3. 技术设计

### 3.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Main Process                                       │
│  ├── WeClaw SDK (npm 依赖)                                   │
│  │   └── 消息推送由 SDK 内部处理                              │
│  ├── 主控 Agent                                              │
│  │   ├── 复用现有 AI Provider                                │
│  │   ├── 自然语言理解                                        │
│  │   └── 权限控制                                            │
│  └── 通道适配器层                                             │
│       ├── WeChatChannelAdapter (首期)                        │
│       ├── WeComChannelAdapter (二期)                         │
│       └── FeishuChannelAdapter (三期)                        │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 会话切换流程

```
项目会话 ──"切换项目"──→ 主控 Agent 会话 ──询问切换──→ 目标项目会话
                           ↓
                    只有在此处可询问状态
```

### 3.3 通道适配器接口

```typescript
interface ChannelAdapter {
  /** 通道类型 */
  type: 'wechat' | 'wecom' | 'feishu';
  
  /** 初始化连接 */
  connect(): Promise<{ qrCode: string }>;
  
  /** 断开连接 */
  disconnect(): Promise<void>;
  
  /** 发送消息 */
  sendMessage(message: string): Promise<void>;
  
  /** 接收消息回调 */
  onMessage(callback: (message: string) => void): void;
  
  /** 请求确认 */
  requestConfirm(message: string): Promise<boolean>;
}
```

### 3.4 主控 Agent 设计

```typescript
interface MasterAgent {
  /** 处理用户消息 */
  handleMessage(message: string, context: AgentContext): Promise<string>;
  
  /** 检查权限 */
  checkPermission(operation: string): boolean;
  
  /** 执行操作 */
  executeOperation(operation: string, params: any): Promise<OperationResult>;
}

// 权限配置
const PERMISSIONS = {
  allow: [
    'view_status',
    'switch_project',
    'restart_session',
    'mcp_status',
    'mcp_start',
    'mcp_stop',
    'skillgroup_list',
    'skillgroup_switch',
  ],
  deny: [
    'delete_project',
    'reset_session',
  ]
};
```

---

## 4. IPC 接口设计

| 频道名 | 方向 | 参数 | 返回值 | 说明 |
|--------|------|------|--------|------|
| `remote-control:get-status` | renderer → main | 无 | `RemoteControlStatus` | 获取远程控制状态 |
| `remote-control:connect` | renderer → main | `{channelType: 'wechat'}` | `{qrCode: string}` | 发起连接，返回二维码 |
| `remote-control:disconnect` | renderer → main | `{channelId: string}` | `boolean` | 断开通道 |
| `remote-control:list-channels` | renderer → main | 无 | `Channel[]` | 获取已连接通道列表 |
| `remote-control:update-settings` | renderer → main | `{requireConfirm: boolean}` | `boolean` | 更新安全设置 |

---

## 5. 数据模型

### 5.1 Channel

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
```

### 5.2 RemoteControlSettings

```typescript
interface RemoteControlSettings {
  /** 是否启用远程控制 */
  enabled: boolean;
  
  /** 重要操作是否需要确认 */
  requireConfirm: boolean;
  
  /** 已连接通道 */
  channels: Channel[];
}
```

---

## 6. 数据存储

### 6.1 文件结构

```
{userData}/remote-control/
├── settings.json           # 配置信息（加密）
└── tokens/
    └── wechat.enc          # 授权令牌（加密）
```

### 6.2 加密方案

使用 Node.js crypto 模块：

```typescript
import crypto from 'crypto';
import os from 'os';

// 基于机器唯一标识生成密钥
function getEncryptionKey(): Buffer {
  const machineId = os.hostname() + os.platform() + os.cpus()[0].model;
  return crypto.createHash('sha256').update(machineId).digest();
}

// 加密
function encrypt(data: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

// 解密
function decrypt(encryptedData: string): string {
  const key = getEncryptionKey();
  const [ivHex, encrypted] = encryptedData.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

---

## 7. 约束条件

| 约束项 | 限制 |
|--------|------|
| 同时连接通道数 | ≤ 3 个 |
| 消息响应延迟 | < 3 秒 |
| 扫码超时时间 | 60 秒 |
| 文件存储位置 | `{userData}/remote-control/` |

---

## 8. 主控 Agent 指令

| 指令 | 说明 | 需要确认 |
|------|------|---------|
| `/status` | 查看所有项目会话状态 | ❌ |
| `/switch <项目名>` | 切换到指定项目会话 | ✅ |
| `/restart <项目名>` | 重启指定项目会话 | ✅ |
| `/mcp status` | 查看 MCP 工具状态 | ❌ |
| `/mcp start <名称>` | 启动指定 MCP | ✅ |
| `/mcp stop <名称>` | 停止指定 MCP | ✅ |
| `/skillgroup list` | 列出可用技能组 | ❌ |
| `/skillgroup switch <名称>` | 切换技能组 | ✅ |
| `/help` | 显示帮助信息 | ❌ |

---

## 9. 权限控制

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

---

## 10. 本期不做

| 功能 | 说明 |
|------|------|
| 语音消息支持 | 仅支持文本消息 |
| 多人协作 | 不支持多人同时远程控制 |
| 操作日志审计 | 后续版本考虑 |
| 图片/文件传输 | 后续版本考虑 |

---

## 11. 测试要点

### 11.1 单元测试

- 通道适配器接口测试
- 主控 Agent 权限检查测试
- 数据加密/解密测试
- 指令解析测试

### 11.2 集成测试

- 扫码接入流程测试
- 消息收发测试
- 会话切换流程测试
- MCP 管理测试
- 技能组切换测试

### 11.3 E2E 测试

- 完整的远程控制流程测试
- 安全确认流程测试
- 多通道并发测试

---

## 12. 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-05-26 | 初始版本 |
