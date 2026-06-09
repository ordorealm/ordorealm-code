# OrdoRealm Code - 序境智码

<p align="center">
  <img src="resources/icon.svg" width="128" height="128" alt="OrdoRealm Code Logo">
</p>

<p align="center">
  <strong>AI-Powered Developer Workflow IDE</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#development">Development</a> •
  <a href="#license">License</a>
</p>

---

## Features

### 🤖 Multi-Agent Support
- **Claude Code** - Anthropic's official Claude coding assistant
- **Codex** - OpenAI's coding agent
- **OpenCode** - Open-source coding assistant

### 💬 Intelligent Chat Interface
- Real-time streaming responses
- Tool use visualization
- File change tracking
- Message grouping for better readability

### 🔧 MCP (Model Context Protocol) Integration
- Built-in MCP server management
- Support for external MCP servers
- Easy configuration and monitoring

### 📁 Project Management
- Multi-project workspace
- File tree navigation
- Code preview with syntax highlighting
- Session persistence per project

### 🎨 Modern UI
- Dark/Light theme support
- Responsive design
- Customizable provider/model selection per session

## Screenshots

<p align="center">
  <em>Coming soon...</em>
</p>

## Installation

### Prerequisites
- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Claude Code CLI** (optional, for Claude agent)

### Download

Download the latest release from [GitHub Releases](https://github.com/ordorealm/ordorealm-code/releases).

### Build from Source

```bash
# Clone the repository
git clone https://github.com/ordorealm/ordorealm-code.git
cd ordorealm-code

# Install dependencies
npm install

# Download runtime dependencies (Node.js, Git)
npm run download-runtime

# Development mode
npm run dev

# Build for production
npm run build:mac   # macOS
npm run build:win   # Windows
npm run build:linux # Linux
```

## Development

```bash
# Run in development mode
npm run dev

# Type checking
npm run typecheck

# Run tests
npm run test

# Format code
npm run format
```

## Project Structure

```
ordorealm-code/
├── electron/           # Electron main process
│   ├── main/          # Main process entry
│   ├── preload/       # Preload scripts
│   └── adapters/      # Agent adapters
├── src/
│   ├── main/          # Main process logic
│   ├── renderer/      # React renderer
│   └── shared/        # Shared types
├── resources/         # App resources (icons, etc.)
└── build/            # Build configuration
```

## Technology Stack

- **Electron** - Cross-platform desktop app
- **React** - UI framework
- **TypeScript** - Type-safe JavaScript
- **Tailwind CSS** - Utility-first CSS
- **Zustand** - State management
- **Monaco Editor** - Code editor
- **Vite** - Build tool

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Anthropic](https://www.anthropic.com/) for Claude and Claude Code
- [Electron](https://www.electronjs.org/) for the cross-platform framework
- [React](https://react.dev/) for the UI framework

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/ordorealm">OrdoRealm</a>
</p>
