/**
 * MCP Registry - MCP 注册表
 *
 * 管理所有内置 MCP 的定义信息
 */

import type {
  MCPDefinition,
  MCPCategory,
  MCPRegistryInterface,
  Platform
} from './types'
import { BUILTIN_MCPS, getCurrentPlatform, isPlatformSupported } from './types'

/**
 * 校验 MCP ID 格式（防止非法输入）
 */
function isValidMCPId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id) && id.length <= 64
}

/**
 * MCP Registry 实现
 */
class MCPRegistry implements MCPRegistryInterface {
  private definitions: Map<string, MCPDefinition>
  private currentPlatform: Platform

  constructor() {
    this.definitions = new Map()
    this.currentPlatform = getCurrentPlatform()
    this.initialize()
  }

  /**
   * 初始化注册表
   */
  private initialize(): void {
    for (const def of BUILTIN_MCPS) {
      this.definitions.set(def.id, def)
    }
  }

  /**
   * 获取所有 MCP 定义
   */
  getAll(): MCPDefinition[] {
    return Array.from(this.definitions.values())
  }

  /**
   * 根据 ID 获取 MCP 定义（带 ID 格式校验）
   */
  getById(id: string): MCPDefinition | undefined {
    // 校验 ID 格式，防止非法输入
    if (!isValidMCPId(id)) {
      return undefined
    }
    return this.definitions.get(id)
  }

  /**
   * 根据分类获取 MCP 列表
   */
  getByCategory(category: MCPCategory): MCPDefinition[] {
    return this.getAll().filter(def => def.category === category)
  }

  /**
   * 获取当前平台支持的 MCP 列表
   */
  getForCurrentPlatform(): MCPDefinition[] {
    return this.getAll().filter(isPlatformSupported)
  }

  /**
   * 获取默认启用的 MCP 列表
   */
  getDefaults(): MCPDefinition[] {
    return this.getForCurrentPlatform().filter(def => def.defaultEnabled)
  }

  /**
   * 获取分类统计
   */
  getCategoryStats(): Record<MCPCategory, number> {
    const stats: Record<MCPCategory, number> = {
      query: 0,
      browser: 0,
      desktop: 0,
      memory: 0,
      debug: 0
    }

    for (const def of this.getForCurrentPlatform()) {
      stats[def.category]++
    }

    return stats
  }

  /**
   * 获取总下载大小估算
   */
  getTotalDownloadSize(ids?: string[]): number {
    const mcps = ids
      ? ids.map(id => this.getById(id)).filter(Boolean) as MCPDefinition[]
      : this.getForCurrentPlatform()

    return mcps.reduce((total, def) => total + def.downloadSize, 0)
  }

  /**
   * 获取总运行时大小估算
   */
  getTotalRuntimeSize(ids?: string[]): number {
    const mcps = ids
      ? ids.map(id => this.getById(id)).filter(Boolean) as MCPDefinition[]
      : this.getForCurrentPlatform()

    return mcps.reduce((total, def) => total + def.runtimeSize, 0)
  }

  /**
   * 格式化大小显示
   */
  formatSize(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`
    } else if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`
    } else if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    } else {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    }
  }

  /**
   * 获取 MCP 摘要信息（用于 UI 显示）
   */
  getSummary(id: string): {
    id: string
    name: string
    category: MCPCategory
    downloadSize: string
    runtimeSize: string
    supported: boolean
    platformNote?: string
  } | undefined {
    const def = this.getById(id)
    if (!def) return undefined

    const supported = isPlatformSupported(def)
    let platformNote: string | undefined

    if (!supported) {
      if (def.platforms.includes('win32')) {
        platformNote = '仅支持 Windows'
      } else if (def.platforms.includes('darwin')) {
        platformNote = '仅支持 macOS'
      } else if (def.platforms.includes('linux')) {
        platformNote = '仅支持 Linux'
      }
    }

    return {
      id: def.id,
      name: def.name,
      category: def.category,
      downloadSize: this.formatSize(def.downloadSize),
      runtimeSize: this.formatSize(def.runtimeSize),
      supported,
      platformNote
    }
  }

  /**
   * 获取所有 MCP 摘要
   */
  getAllSummaries(): ReturnType<MCPRegistry['getSummary']>[] {
    return this.getAll()
      .map(def => this.getSummary(def.id))
      .filter(Boolean)
  }
}

// 单例实例
let registryInstance: MCPRegistry | null = null

/**
 * 获取 Registry 单例
 */
export function getMCPRegistry(): MCPRegistry {
  if (!registryInstance) {
    registryInstance = new MCPRegistry()
  }
  return registryInstance
}

/**
 * 便捷方法：获取所有 MCP
 */
export function getAllMCPs(): MCPDefinition[] {
  return getMCPRegistry().getAll()
}

/**
 * 便捷方法：根据 ID 获取 MCP
 */
export function getMCPById(id: string): MCPDefinition | undefined {
  return getMCPRegistry().getById(id)
}

/**
 * 便捷方法：获取当前平台支持的 MCP
 */
export function getSupportedMCPs(): MCPDefinition[] {
  return getMCPRegistry().getForCurrentPlatform()
}

/**
 * 便捷方法：获取默认启用的 MCP
 */
export function getDefaultMCPs(): MCPDefinition[] {
  return getMCPRegistry().getDefaults()
}

export { MCPRegistry }
