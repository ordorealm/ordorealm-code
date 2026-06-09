# OrdoRealm Code - 序境智码

<p align="center">
  <img src="resources/icon.svg" width="128" height="128" alt="OrdoRealm Code Logo">
</p>

<p align="center">
  <strong>AI 驱动的开发者工作流 IDE</strong>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#安装">安装</a> •
  <a href="#开发">开发</a> •
  <a href="#技术栈">技术栈</a> •
  <a href="#许可证">许可证</a>
</p>

---

## 功能特性

### 🤖 多智能体支持

| 智能体 | 状态 | 说明 |
|--------|------|------|
| **Claude Code** | ✅ 已支持 | Anthropic 官方 Claude 编程助手 |
| **Codex** | 🚧 计划中 | OpenAI 编程助手 |
| **OpenCode** | 🚧 计划中 | 开源编程助手 |

### 💬 智能对话界面

- 实时流式响应
- 工具调用可视化
- 文件变更追踪
- 消息分组显示

### 🔧 MCP (模型上下文协议) 集成

- 内置 MCP 服务器管理
- 支持外部 MCP 服务器
- 便捷的配置与监控

### 📁 项目管理

- 多项目工作区
- 文件树导航
- 代码预览（语法高亮）
- 项目级会话持久化

### 🎨 现代化界面

- 深色/浅色主题支持
- 响应式设计
- 会话级 Provider/Model 选择

---

## 安装

### 系统要求

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0

### 下载安装

从 [GitHub Releases](https://github.com/ordorealm/ordorealm-code/releases) 下载最新版本。

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/ordorealm/ordorealm-code.git
cd ordorealm-code

# 安装依赖
npm install

# 下载运行时依赖 (Node.js, Git, Weclaw)
npm run download-runtime
npm run download-weclaw

# 开发模式
npm run dev

# 生产构建
npm run build:mac   # macOS
npm run build:win   # Windows
npm run build:linux # Linux
```

---

## 开发

```bash
# 开发模式
npm run dev

# 类型检查
npm run typecheck

# 代码格式化
npm run format
```

---

## 项目结构

```
ordorealm-code/
├── electron/           # Electron 主进程
│   ├── main/          # 主进程入口
│   ├── preload/       # 预加载脚本
│   └── adapters/      # 智能体适配器
├── src/
│   ├── main/          # 主进程逻辑
│   ├── renderer/      # React 渲染进程
│   └── shared/        # 共享类型定义
├── resources/         # 应用资源（图标等）
└── build/            # 构建配置
```

---

## 技术栈

| 技术 | 用途 |
|------|------|
| [Electron](https://www.electronjs.org/) | 跨平台桌面应用 |
| [React](https://react.dev/) | UI 框架 |
| [TypeScript](https://www.typescriptlang.org/) | 类型安全的 JavaScript |
| [Tailwind CSS](https://tailwindcss.com/) | 原子化 CSS |
| [Zustand](https://zustand-demo.pmnd.rs/) | 状态管理 |
| [Monaco Editor](https://microsoft.github.io/monaco-editor/) | 代码编辑器 |
| [Vite](https://vitejs.dev/) | 构建工具 |

---

## 贡献

欢迎提交 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 提交 Pull Request

---

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

---

## 致谢

- [Anthropic](https://www.anthropic.com/) - Claude 和 Claude Code
- [Electron](https://www.electronjs.org/) - 跨平台框架
- [React](https://react.dev/) - UI 框架

---

<p align="center">
  由 <a href="https://github.com/ordorealm">OrdoRealm</a> 用 ❤️ 制作
</p>

---

## English

### Features

#### 🤖 Multi-Agent Support

| Agent | Status | Description |
|-------|--------|-------------|
| **Claude Code** | ✅ Supported | Anthropic's official Claude coding assistant |
| **Codex** | 🚧 Planned | OpenAI's coding agent |
| **OpenCode** | 🚧 Planned | Open-source coding assistant |

#### 💬 Intelligent Chat Interface
- Real-time streaming responses
- Tool use visualization
- File change tracking
- Message grouping

#### 🔧 MCP Integration
- Built-in MCP server management
- External MCP server support

#### 📁 Project Management
- Multi-project workspace
- File tree navigation
- Code preview with syntax highlighting

#### 🎨 Modern UI
- Dark/Light theme
- Responsive design
- Per-session Provider/Model selection

### Installation

Download from [GitHub Releases](https://github.com/ordorealm/ordorealm-code/releases).

### Build from Source

```bash
git clone https://github.com/ordorealm/ordorealm-code.git
cd ordorealm-code
npm install
npm run download-runtime
npm run download-weclaw
npm run dev
```

### License

[MIT License](LICENSE)
