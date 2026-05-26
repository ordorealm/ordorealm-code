# Product-Spec.md

> 产品需求规格说明书
> 项目：devflow-ide
> 创建日期：2026-05-26
> 更新日期：2026-05-26
> 版本：2.0.0

---

## 产品概述

### 1.1 产品名称

远程控制功能（Remote Control）

### 1.2 产品简介

为 devflow-ide 添加远程控制功能，允许用户通过微信 ClawBot 等渠道远程查看项目会话状态、切换项目会话、管理 MCP 和技能组。主控 Agent 在 IDE 内部运行，复用现有 AI Provider 能力。

### 1.3 目标用户

个人开发者或小团队开发者，希望在外出时也能远程掌控项目运行状态。

### 1.4 核心价值

- **随时随地掌控**：外出时也能通过手机查看项目状态
- **远程操作**：无需回到电脑前即可切换项目、管理配置
- **安全可控**：重要操作需手机端二次确认

---

## 应用场景

### 场景 1：外出时查看项目状态

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

### 场景 2：远程切换项目会话

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

### 场景 3：远程管理 MCP 和技能组

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

### 场景 4：扫码接入

```yaml
who: 开发者
situation: 首次使用远程控制功能，需要接入微信 ClawBot
how:
  1. 在设置界面点击"添加通道"
  2. 显示二维码
  3. 手机微信扫码
  4. 手机端确认授权
  5. 连接成功，显示"已连接"状态
outcome: 远程控制功能已启用
```

---

## 功能索引

### 3.1 功能列表

| ID | 功能名称 | 描述 | 优先级 | specPath |
|----|---------|------|--------|----------|
| F03 | 远程控制 | 通过微信等渠道远程查看项目状态、切换项目会话 | P0 | .superspec/features/remote-control.md |

### 3.2 功能详情索引

详细功能描述见 `.superspec/features/` 目录：

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
| IPC 通信 | Electron IPC |
| 文件操作 | Node.js fs + crypto |
| 远程通道 | WeClaw SDK（npm 依赖） |
| 存储 | 本地文件系统（加密存储） |

### 4.3 架构设计

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

### 4.4 会话切换流程

```
项目会话 ──"切换项目"──→ 主控 Agent 会话 ──询问切换──→ 目标项目会话
                           ↓
                    只有在此处可询问状态
```

**关键规则**：
- 用户在项目会话中输入"切换项目"，自动回到主控 Agent 会话
- 只有在主控 Agent 会话中才能询问状态
- 主控 Agent 不能删除项目、不能重置项目会话

---

## 约束条件

### 5.1 功能约束

| 约束项 | 限制 |
|--------|------|
| 同时连接通道数 | ≤ 3 个 |
| 消息响应延迟 | < 3 秒 |
| 扫码超时时间 | 60 秒 |
| 文件存储位置 | `{userData}/remote-control/` |

### 5.2 权限控制

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

### 5.3 本期不做

| 功能 | 说明 |
|------|------|
| 语音消息支持 | 仅支持文本消息 |
| 多人协作 | 不支持多人同时远程控制 |
| 操作日志审计 | 后续版本考虑 |
| 图片/文件传输 | 后续版本考虑 |

---

## 接口设计

### 6.1 IPC 频道

| 频道名 | 方向 | 参数 | 返回值 | 说明 |
|--------|------|------|--------|------|
| `remote-control:get-status` | renderer → main | 无 | `RemoteControlStatus` | 获取远程控制状态 |
| `remote-control:connect` | renderer → main | `{channelType: 'wechat'}` | `{qrCode: string}` | 发起连接，返回二维码 |
| `remote-control:disconnect` | renderer → main | `{channelId: string}` | `boolean` | 断开通道 |
| `remote-control:list-channels` | renderer → main | 无 | `Channel[]` | 获取已连接通道列表 |
| `remote-control:update-settings` | renderer → main | `{requireConfirm: boolean}` | `boolean` | 更新安全设置 |

---

## UI 设计

### 7.1 设置界面

在 SettingsDialog 中新增"远程控制"标签页：

```
SettingsDialog Tabs:
├── "AI Provider" → ProviderSettings
├── "外观" → AppearanceSettings
├── "MCP 工具" → MCPSettings
└── "远程控制" → RemoteControlSettings（新增）
```

### 7.2 RemoteControlSettings 结构

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

### 7.3 扫码接入弹窗

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

---

## 数据模型

### 8.1 Channel

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

### 8.2 RemoteControlSettings

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

## 数据存储

### 9.1 文件结构

```
{userData}/remote-control/
├── settings.json           # 配置信息（加密）
└── tokens/
    └── wechat.enc          # 授权令牌（加密）
```

### 9.2 加密方案

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

## 主控 Agent 指令

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

---

## 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 2.0.0 | 2026-05-26 | 重构文档，移除已完成功能，专注远程控制（F03） |
| 1.1.0 | 2026-05-26 | 新增远程控制功能（F03）需求 |
| 1.0.0 | 2026-05-24 | 初始版本 |

---

## 附录

### 相关文件

- `.superspec/features/remote-control.md` - 远程控制功能详情

### 参考资料

- WeClaw SDK 文档：待补充
