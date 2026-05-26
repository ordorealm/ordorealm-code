/**
 * MCP Manager Module
 *
 * 内置 MCP 系统的入口点
 */

// 类型导出
export * from './types'

// Registry 导出
export {
  getMCPRegistry,
  getAllMCPs,
  getMCPById,
  getSupportedMCPs,
  getDefaultMCPs,
  MCPRegistry
} from './registry'

// Downloader 导出
export {
  getMCPDownloader,
  MCPDownloader,
  type DownloadConfig,
  type ProgressCallback
} from './downloader'

// Launcher 导出
export {
  getMCPLauncher,
  MCPLauncher,
  type LaunchConfig,
  type MCPProcessOutput
} from './launcher'

// Manager 导出
export {
  getMCPManager,
  initializeMCP,
  MCPManager,
  type MCPManagerConfig,
  type StatusChangeCallback,
  type DownloadProgressCallback
} from './manager'

// Connector 导出
export {
  getMCPConnector,
  MCPConnector,
  type MCPTool,
  type ClaudeTool,
  type MCPServerConfig
} from './connector'
