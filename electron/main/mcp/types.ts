/**
 * MCP Manager Type Definitions
 *
 * 内置 MCP 系统的类型定义，支持按需下载和国内镜像加速
 */

import type { ChildProcess } from 'child_process'

/**
 * MCP 分类
 */
export type MCPCategory =
  | 'query'      // 查询类：搜索、抓取
  | 'browser'    // 浏览器自动化
  | 'desktop'    // 桌面控制
  | 'memory'     // 记忆/知识图谱
  | 'debug'      // 调试工具

/**
 * 支持的平台
 */
export type Platform = 'darwin' | 'win32' | 'linux'

/**
 * MCP 下载状态
 */
export type DownloadStatus =
  | 'not_downloaded'   // 未下载
  | 'downloading'      // 下载中
  | 'downloaded'       // 已下载
  | 'download_failed'  // 下载失败
  | 'extracting'       // 解压中
  | 'ready'            // 就绪

/**
 * MCP 运行状态
 */
export type MCPStatus =
  | 'stopped'      // 已停止
  | 'starting'     // 启动中
  | 'running'      // 运行中
  | 'stopping'     // 停止中
  | 'error'        // 错误

/**
 * MCP 定义 - 注册表中的静态配置
 */
export interface MCPDefinition {
  /** MCP 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 分类 */
  category: MCPCategory
  /** npm 包名 */
  packageName: string
  /** 版本范围 */
  version: string
  /** 支持的平台，空数组表示全平台支持 */
  platforms: Platform[]
  /** 是否内置（无需下载） */
  builtin: boolean
  /** 是否默认启用 */
  defaultEnabled: boolean
  /** 下载大小估算（字节） */
  downloadSize: number
  /** 运行时大小估算（字节） */
  runtimeSize: number
  /** 镜像配置 */
  mirrors?: MCPMirror[]
  /** 依赖项（需要预安装） */
  dependencies?: string[]
  /** 权限要求说明 */
  permissions?: PermissionInstructions
  /** 启动参数模板 */
  argsTemplate?: string[]
  /** 环境变量模板 */
  envTemplate?: Record<string, string>
  /** 额外的运行时依赖（如 Playwright 的 Chromium） */
  runtimeDependencies?: RuntimeDependency[]
}

/**
 * 镜像源配置
 */
export interface MCPMirror {
  /** 镜像名称 */
  name: string
  /** 镜像 URL 模板，{package} 会被替换为包名 */
  url: string
  /** 适用地区 */
  region: 'cn' | 'global'
  /** 优先级（数字越小优先级越高） */
  priority: number
}

/**
 * 运行时依赖（如 Playwright 的 Chromium）
 */
export interface RuntimeDependency {
  /** 依赖标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 下载大小 */
  downloadSize: number
  /** 下载 URL 模板 */
  downloadUrl: string
  /** 镜像配置 */
  mirrors?: MCPMirror[]
}

/**
 * 权限要求说明
 */
export interface PermissionInstructions {
  /** macOS 权限说明 */
  macos?: {
    /** 需要的权限类型 */
    type: 'accessibility' | 'screen_recording' | 'full_disk_access' | 'automation'
    /** 说明文字 */
    instruction: string
    /** 系统设置路径 */
    settingsPath: string
  }
  /** Windows 权限说明 */
  windows?: {
    /** 需要的权限类型 */
    type: 'admin' | 'ui_access'
    /** 说明文字 */
    instruction: string
  }
}

/**
 * MCP 实例 - 运行时状态
 */
export interface MCPInstance {
  /** MCP ID */
  id: string
  /** 当前状态 */
  status: MCPStatus
  /** 下载状态 */
  downloadStatus: DownloadStatus
  /** 安装路径 */
  installPath?: string
  /** 进程句柄 */
  process?: ChildProcess
  /** PID */
  pid?: number
  /** 启动时间 */
  startTime?: number
  /** 错误信息 */
  error?: string
  /** 下载进度 (0-100) */
  downloadProgress?: number
  /** 当前下载的文件名 */
  downloadingFile?: string
  /** 已使用的工具列表 */
  toolsUsed?: string[]
  /** 最后活动时间 */
  lastActivity?: number
}

/**
 * MCP 统计信息
 */
export interface MCPStats {
  /** 总 MCP 数量 */
  total: number
  /** 已启用的 MCP 数量 */
  enabled: number
  /** 正在运行的 MCP 数量 */
  running: number
  /** 已下载的 MCP 数量 */
  downloaded: number
  /** 总下载大小（字节） */
  totalDownloadSize: number
  /** 已下载大小（字节） */
  downloadedSize: number
}

/**
 * MCP Registry 接口
 */
export interface MCPRegistryInterface {
  /** 获取所有 MCP 定义 */
  getAll(): MCPDefinition[]
  /** 根据 ID 获取 MCP 定义 */
  getById(id: string): MCPDefinition | undefined
  /** 根据分类获取 MCP 列表 */
  getByCategory(category: MCPCategory): MCPDefinition[]
  /** 获取当前平台支持的 MCP 列表 */
  getForCurrentPlatform(): MCPDefinition[]
  /** 获取默认启用的 MCP 列表 */
  getDefaults(): MCPDefinition[]
}

/**
 * MCP 下载器接口
 */
export interface MCPDownloaderInterface {
  /** 下载 MCP */
  download(definition: MCPDefinition, onProgress?: (progress: number, file: string) => void): Promise<string>
  /** 检查是否已下载 */
  isDownloaded(definition: MCPDefinition): Promise<boolean>
  /** 获取下载路径 */
  getDownloadPath(definition: MCPDefinition): string
  /** 取消下载 */
  cancel?(downloadId: string): void
}

/**
 * MCP 启动器接口
 */
export interface MCPLauncherInterface {
  /** 启动 MCP */
  launch(definition: MCPDefinition, installPath: string): Promise<ChildProcess>
  /** 停止 MCP */
  stop(instance: MCPInstance): Promise<void>
  /** 检查健康状态 */
  healthCheck(instance: MCPInstance): Promise<boolean>
}

/**
 * MCP Manager 接口
 */
export interface MCPManagerInterface {
  /** 初始化 MCP 系统 */
  initialize(): Promise<void>
  /** 获取所有 MCP 定义 */
  getDefinitions(): MCPDefinition[]
  /** 获取所有实例 */
  getInstances(): Map<string, MCPInstance>
  /** 启用 MCP */
  enable(id: string): Promise<void>
  /** 禁用 MCP */
  disable(id: string): Promise<void>
  /** 启动 MCP */
  start(id: string): Promise<void>
  /** 停止 MCP */
  stop(id: string): Promise<void>
  /** 重启 MCP */
  restart(id: string): Promise<void>
  /** 获取统计信息 */
  getStats(): MCPStats
  /** 关闭所有 MCP */
  shutdown(): Promise<void>
}

/**
 * IPC 通信消息类型
 */
export interface MCPIPCMessages {
  'mcp:list': () => Promise<MCPDefinition[]>
  'mcp:instances': () => Promise<Record<string, MCPInstance>>
  'mcp:enable': (id: string) => Promise<void>
  'mcp:disable': (id: string) => Promise<void>
  'mcp:start': (id: string) => Promise<void>
  'mcp:stop': (id: string) => Promise<void>
  'mcp:restart': (id: string) => Promise<void>
  'mcp:stats': () => Promise<MCPStats>
  'mcp:download': (id: string) => Promise<void>
  'mcp:download-progress': (id: string, progress: number, file: string) => void
  'mcp:status-change': (id: string, status: MCPStatus) => void
}

/**
 * MCP 配置（持久化存储）
 */
export interface MCPConfig {
  /** 启用的 MCP ID 列表 */
  enabledMCPs: string[]
  /** 上次运行中的 MCP ID 列表（用于自动恢复） */
  runningMCPs?: string[]
  /** 自定义配置 */
  customConfigs?: Record<string, Record<string, unknown>>
  /** 镜像偏好 */
  preferredMirror?: 'cn' | 'global' | 'auto'
}

/**
 * 内置 MCP 定义列表
 */
export const BUILTIN_MCPS: MCPDefinition[] = [
  // 查询类 - Open WebSearch
  {
    id: 'open-websearch',
    name: 'Open WebSearch',
    description: '免费的网络搜索工具，无需 API Key，支持多搜索引擎',
    category: 'query',
    packageName: 'open-websearch',
    version: 'latest',
    platforms: [],
    builtin: false,
    defaultEnabled: true,
    downloadSize: 5 * 1024 * 1024, // ~5MB
    runtimeSize: 10 * 1024 * 1024, // ~10MB
    mirrors: [
      {
        name: 'npmmirror',
        url: 'https://registry.npmmirror.com/{package}/-/{package}-{version}.tgz',
        region: 'cn',
        priority: 1
      },
      {
        name: 'npm',
        url: 'https://registry.npmjs.org/{package}/-/{package}-{version}.tgz',
        region: 'global',
        priority: 2
      }
    ]
  },

  // 查询类 - Fetch (使用 mcp-server-fetch-typescript)
  {
    id: 'fetch',
    name: 'Fetch',
    description: '网页内容抓取工具，支持静态页面和动态渲染',
    category: 'query',
    packageName: 'mcp-server-fetch-typescript',
    version: 'latest',
    platforms: [],
    builtin: false,
    defaultEnabled: true,
    downloadSize: 3 * 1024 * 1024, // ~3MB
    runtimeSize: 8 * 1024 * 1024, // ~8MB
    mirrors: [
      {
        name: 'npmmirror',
        url: 'https://registry.npmmirror.com/{package}/-/{package}-{version}.tgz',
        region: 'cn',
        priority: 1
      },
      {
        name: 'npm',
        url: 'https://registry.npmjs.org/{package}/-/{package}-{version}.tgz',
        region: 'global',
        priority: 2
      }
    ]
  },

  // 浏览器自动化 - Playwright
  {
    id: 'playwright',
    name: 'Playwright',
    description: '强大的浏览器自动化工具，支持截图、表单填充、页面导航等',
    category: 'browser',
    packageName: '@playwright/mcp',
    version: 'latest',
    platforms: [],
    builtin: false,
    defaultEnabled: true,
    downloadSize: 50 * 1024 * 1024, // ~50MB (包本身)
    runtimeSize: 220 * 1024 * 1024, // ~220MB (含 Chromium)
    mirrors: [
      {
        name: 'npmmirror',
        url: 'https://registry.npmmirror.com/{package}/-/{package}-{version}.tgz',
        region: 'cn',
        priority: 1
      },
      {
        name: 'npm',
        url: 'https://registry.npmjs.org/{package}/-/{package}-{version}.tgz',
        region: 'global',
        priority: 2
      }
    ],
    runtimeDependencies: [
      {
        id: 'chromium',
        name: 'Chromium Browser',
        downloadSize: 170 * 1024 * 1024, // ~170MB
        downloadUrl: 'https://playwright.azureedge.net/builds/chromium/{version}/chromium-{platform}.zip',
        mirrors: [
          {
            name: 'taobao',
            url: 'https://npmmirror.com/mirrors/playwright/{version}/chromium-{platform}.zip',
            region: 'cn',
            priority: 1
          }
        ]
      }
    ]
  },

  // 浏览器自动化 - MCPBrowser
  {
    id: 'mcpbrowser',
    name: 'MCPBrowser',
    description: '浏览器自动化工具，支持 Cookie 持久化和浏览器指纹保持，适合自动化操作',
    category: 'browser',
    packageName: 'mcpbrowser',
    version: 'latest',
    platforms: [],
    builtin: false,
    defaultEnabled: true,
    downloadSize: 30 * 1024 * 1024, // ~30MB
    runtimeSize: 80 * 1024 * 1024, // ~80MB
    mirrors: [
      {
        name: 'npmmirror',
        url: 'https://registry.npmmirror.com/{package}/-/{package}-{version}.tgz',
        region: 'cn',
        priority: 1
      },
      {
        name: 'npm',
        url: 'https://registry.npmjs.org/{package}/-/{package}-{version}.tgz',
        region: 'global',
        priority: 2
      }
    ]
  },

  // 桌面控制 - Windows (使用 @cool-mcp/desktop-automation，预编译原生模块，开箱即用)
  {
    id: 'desktop-touch',
    name: 'Desktop Control',
    description: 'Windows 桌面自动化工具，支持鼠标键盘模拟、窗口控制、截图',
    category: 'desktop',
    packageName: '@cool-mcp/desktop-automation',
    version: '1.0.9',
    platforms: ['win32'],
    builtin: false,
    defaultEnabled: true,
    downloadSize: 15 * 1024 * 1024, // ~15MB
    runtimeSize: 40 * 1024 * 1024, // ~40MB
    permissions: {
      windows: {
        type: 'admin',
        instruction: '需要管理员权限以进行桌面自动化操作'
      }
    },
    mirrors: [
      {
        name: 'npmmirror',
        url: 'https://registry.npmmirror.com/{package}/-/{package}-{version}.tgz',
        region: 'cn',
        priority: 1
      },
      {
        name: 'npm',
        url: 'https://registry.npmjs.org/{package}/-/{package}-{version}.tgz',
        region: 'global',
        priority: 2
      }
    ]
  },

  // 桌面控制 - macOS
  {
    id: 'macos-automator',
    name: 'macOS Automator',
    description: 'macOS 桌面自动化工具，支持 AppleScript、快捷指令、系统控制',
    category: 'desktop',
    packageName: '@steipete/macos-automator-mcp',
    version: 'latest',
    platforms: ['darwin'],
    builtin: false,
    defaultEnabled: true,
    downloadSize: 8 * 1024 * 1024, // ~8MB
    runtimeSize: 20 * 1024 * 1024, // ~20MB
    permissions: {
      macos: {
        type: 'accessibility',
        instruction: '需要在系统偏好设置中授权辅助功能权限',
        settingsPath: '系统偏好设置 > 安全性与隐私 > 隐私 > 辅助功能'
      }
    },
    mirrors: [
      {
        name: 'npmmirror',
        url: 'https://registry.npmmirror.com/{package}/-/{package}-{version}.tgz',
        region: 'cn',
        priority: 1
      },
      {
        name: 'npm',
        url: 'https://registry.npmjs.org/{package}/-/{package}-{version}.tgz',
        region: 'global',
        priority: 2
      }
    ]
  },

  // 记忆 - Knowledge Graph Memory
  {
    id: 'memory',
    name: 'Memory',
    description: '知识图谱记忆系统，支持跨会话持久化存储，AI 可自动调用',
    category: 'memory',
    packageName: '@modelcontextprotocol/server-memory',
    version: 'latest',
    platforms: [],
    builtin: false,
    defaultEnabled: true,
    downloadSize: 5 * 1024 * 1024, // ~5MB
    runtimeSize: 15 * 1024 * 1024, // ~15MB
    mirrors: [
      {
        name: 'npmmirror',
        url: 'https://registry.npmmirror.com/{package}/-/{package}-{version}.tgz',
        region: 'cn',
        priority: 1
      },
      {
        name: 'npm',
        url: 'https://registry.npmjs.org/{package}/-/{package}-{version}.tgz',
        region: 'global',
        priority: 2
      }
    ]
  }
]

/**
 * 获取当前平台
 */
export function getCurrentPlatform(): Platform {
  return process.platform as Platform
}

/**
 * 检查 MCP 是否支持当前平台
 */
export function isPlatformSupported(definition: MCPDefinition): boolean {
  if (definition.platforms.length === 0) {
    return true
  }
  return definition.platforms.includes(getCurrentPlatform())
}
