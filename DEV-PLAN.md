# Development Plan — devflow-ide 远程控制功能

## 项目信息

| 属性 | 值 |
|------|-----|
| 项目名称 | devflow-ide 远程控制（F03） |
| 技术栈 | Electron + React 18 + TypeScript + Zustand |
| 总 Phase 数 | 6 |
| 总 Task 数 | 24 |
| 创建日期 | 2026-05-26 |

---

## Phase 索引

| Phase | 名称 | Task 数量 | 依赖 | 状态 |
|-------|------|-----------|------|------|
| 1 | 基础设施 | 4 | 无 | ⬜ |
| 2 | 通道适配器 | 4 | P1 | ⬜ |
| 3 | 主控 Agent | 5 | P1 | ⬜ |
| 4 | IPC 通信 | 4 | P2, P3 | ⬜ |
| 5 | UI 界面 | 4 | P4 | ⬜ |
| 6 | 测试验证 | 3 | P5 | ⬜ |

---

## 执行策略

### 并行策略

```
Phase 2（通道适配器）和 Phase 3（主控 Agent）可并行执行
两者都只依赖 Phase 1，无相互依赖
```

### 恢复策略

- Task 级恢复：中断后从当前 Task 继续
- 状态保存在 `.superspec/state.json`

---

## Phase 详情

### Phase 1: 基础设施

**目标**：建立远程控制功能的基础数据模型和工具函数

**Tasks**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|----------|------|--------|
| T1-01 | 定义数据模型 | 1h | 无 | `src/shared/types/remote-control.ts` |
| T1-02 | 实现加密工具 | 1h | 无 | `src/main/utils/encryption.ts` |
| T1-03 | 实现配置存储 | 1.5h | T1-02 | `src/main/services/remote-control-storage.ts` |
| T1-04 | 创建 Zustand Store | 1h | T1-01 | `src/renderer/stores/remote-control-store.ts` |

**验收标准**：
- ✅ Channel、RemoteControlSettings 类型定义完整
- ✅ 加密/解密功能正确，密钥基于机器唯一标识
- ✅ 配置文件存储在 `{userData}/remote-control/` 目录
- ✅ Store 支持状态持久化

---

### Phase 2: 通道适配器

**目标**：集成 WeClaw SDK，实现微信通道适配器

**Tasks**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|----------|------|--------|
| T2-01 | 定义适配器接口 | 0.5h | T1-01 | `src/main/adapters/channel-adapter.ts` |
| T2-02 | 安装 WeClaw SDK | 0.5h | 无 | `package.json` |
| T2-03 | 实现微信适配器 | 2h | T2-01, T2-02 | `src/main/adapters/wechat-adapter.ts` |
| T2-04 | 实现适配器管理器 | 1h | T2-03 | `src/main/services/channel-manager.ts` |

**验收标准**：
- ✅ ChannelAdapter 接口定义完整（connect、disconnect、sendMessage、onMessage、requestConfirm）
- ✅ WeClaw SDK 正确安装并配置
- ✅ 微信适配器支持扫码连接、消息收发
- ✅ 适配器管理器支持多通道管理（≤3个）

---

### Phase 3: 主控 Agent

**目标**：实现主控 Agent，处理远程指令和权限控制

**Tasks**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|----------|------|--------|
| T3-01 | 定义 Agent 接口 | 0.5h | T1-01 | `src/main/agents/master-agent.ts` |
| T3-02 | 实现指令解析器 | 1.5h | T3-01 | `src/main/agents/command-parser.ts` |
| T3-03 | 实现权限控制器 | 1h | T3-01 | `src/main/agents/permission-controller.ts` |
| T3-04 | 实现操作执行器 | 2h | T3-01, T1-03 | `src/main/agents/operation-executor.ts` |
| T3-05 | 集成主控 Agent | 1h | T3-02, T3-03, T3-04 | `src/main/agents/master-agent.ts` |

**验收标准**：
- ✅ 支持 9 个指令：/status、/switch、/restart、/mcp status|start|stop、/skillgroup list|switch、/help
- ✅ 权限控制正确：禁止删除项目、禁止重置会话
- ✅ 自然语言理解正确：能解析"切换到 xxx 项目"
- ✅ 重要操作需确认：/switch、/restart、/mcp start|stop、/skillgroup switch

---

### Phase 4: IPC 通信

**目标**：实现 Electron IPC 频道，连接渲染进程和主进程

**Tasks**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|----------|------|--------|
| T4-01 | 定义 IPC 频道 | 0.5h | T1-01 | `src/shared/ipc/remote-control-channels.ts` |
| T4-02 | 实现主进程 IPC Handler | 2h | T4-01, T2-04, T3-05 | `src/main/ipc/remote-control-handler.ts` |
| T4-03 | 实现渲染进程 IPC Client | 1h | T4-01 | `src/renderer/services/remote-control-client.ts` |
| T4-04 | 集成 IPC 通信 | 1h | T4-02, T4-03 | `src/main/index.ts`, `src/renderer/index.ts` |

**验收标准**：
- ✅ 5 个 IPC 频道定义完整
- ✅ 主进程 Handler 正确响应渲染进程请求
- ✅ 渲染进程 Client 封装完整
- ✅ IPC 通信类型安全

---

### Phase 5: UI 界面

**目标**：实现远程控制设置界面和扫码弹窗

**Tasks**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|----------|------|--------|
| T5-01 | 创建 RemoteControlSettings 组件 | 2h | T4-03, T1-04 | `src/renderer/components/settings/RemoteControlSettings.tsx` |
| T5-02 | 创建 ChannelCard 组件 | 1h | T5-01 | `src/renderer/components/settings/ChannelCard.tsx` |
| T5-03 | 创建 AddChannelDialog 组件 | 1.5h | T5-01 | `src/renderer/components/settings/AddChannelDialog.tsx` |
| T5-04 | 集成到 SettingsDialog | 0.5h | T5-01, T5-02, T5-03 | `src/renderer/components/settings/SettingsDialog.tsx` |

**验收标准**：
- ✅ 设置界面显示已连接通道列表
- ✅ 支持启用/禁用远程控制开关
- ✅ 扫码弹窗显示二维码和倒计时
- ✅ 安全设置：重要操作需确认选项

---

### Phase 6: 测试验证

**目标**：编写测试用例，验证功能正确性

**Tasks**：

| Task ID | 名称 | 预计时间 | 依赖 | 交付物 |
|---------|------|----------|------|--------|
| T6-01 | 单元测试 | 2h | P1-P5 | `tests/unit/remote-control/` |
| T6-02 | 集成测试 | 2h | T6-01 | `tests/integration/remote-control/` |
| T6-03 | E2E 测试 | 2h | T6-02 | `tests/e2e/remote-control.spec.ts` |

**验收标准**：
- ✅ 加密/解密测试通过
- ✅ 指令解析测试通过
- ✅ 权限控制测试通过
- ✅ IPC 通信测试通过
- ✅ E2E 测试覆盖主要流程

---

## 依赖图

```
                    ┌─────────────┐
                    │   P1 基础   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            │
      ┌───────────┐ ┌───────────┐       │
      │ P2 通道   │ │ P3 Agent  │       │
      └─────┬─────┘ └─────┬─────┘       │
            │             │             │
            └──────┬──────┘             │
                   │                    │
                   ▼                    │
            ┌───────────┐               │
            │  P4 IPC   │◄──────────────┘
            └─────┬─────┘
                  │
                  ▼
            ┌───────────┐
            │  P5 UI    │
            └─────┬─────┘
                  │
                  ▼
            ┌───────────┐
            │  P6 测试  │
            └───────────┘
```

---

## 技术约束

| 约束项 | 限制 |
|--------|------|
| 同时连接通道数 | ≤ 3 个 |
| 消息响应延迟 | < 3 秒 |
| 扫码超时时间 | 60 秒 |
| 文件存储位置 | `{userData}/remote-control/` |

---

## 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|---------|
| 1.0.0 | 2026-05-26 | 初始版本，规划 F03 远程控制功能开发计划 |
