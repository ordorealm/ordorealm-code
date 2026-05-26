/**
 * MCP Settings Component
 * @module components/settings/MCPSettings
 *
 * MCP 管理界面，显示所有可用的 MCP 及其状态
 */

import { useEffect, useState } from 'react'
import {
  useMCPStore,
  formatSize,
  getCategoryName,
  getStatusName,
  getDownloadStatusName,
  type MCPDefinition,
  type MCPInstance,
  type MCPCategory
} from '@/stores/mcp-store'

/**
 * MCP 卡片组件
 */
function MCPCard({
  definition,
  instance
}: {
  definition: MCPDefinition
  instance?: MCPInstance
}): JSX.Element {
  const [isOperating, setIsOperating] = useState(false)
  const { start, stop, download, enable, disable } = useMCPStore()

  const isRunning = instance?.status === 'running'
  const isDownloaded = instance?.downloadStatus === 'ready'
  const isDownloading = instance?.downloadStatus === 'downloading'
  // 从 stats.enabled 判断是否启用（enabled MCP 数量 > 0 且该 MCP 未被停止/禁用）
  const { stats } = useMCPStore()
  const isEnabled = stats.enabled > 0 && instance?.status !== 'stopped' || instance?.status === 'running'

  const handleDownload = async () => {
    setIsOperating(true)
    try {
      await download(definition.id)
    } finally {
      setIsOperating(false)
    }
  }

  const handleStart = async () => {
    setIsOperating(true)
    try {
      await start(definition.id)
    } finally {
      setIsOperating(false)
    }
  }

  const handleStop = async () => {
    setIsOperating(true)
    try {
      await stop(definition.id)
    } finally {
      setIsOperating(false)
    }
  }

  const handleToggleEnable = async () => {
    setIsOperating(true)
    try {
      if (isEnabled) {
        await disable(definition.id)
      } else {
        await enable(definition.id)
      }
    } finally {
      setIsOperating(false)
    }
  }

  // 分类图标
  const categoryIcons: Record<MCPCategory, JSX.Element> = {
    query: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
    ),
    browser: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
      </svg>
    ),
    desktop: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
    memory: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
      </svg>
    ),
    debug: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    )
  }

  return (
    <div className="p-4 bg-bg-secondary rounded-lg border border-border hover:border-border transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-text-muted">{categoryIcons[definition.category]}</span>
          <h4 className="font-medium text-text-primary">{definition.name}</h4>
        </div>
        <span className="text-xs px-2 py-0.5 rounded bg-bg-tertiary text-text-muted">
          {getCategoryName(definition.category)}
        </span>
      </div>

      {/* Description */}
      <p className="text-sm text-text-secondary mb-3 line-clamp-2">
        {definition.description}
      </p>

      {/* Status */}
      <div className="flex items-center gap-4 text-xs text-text-muted mb-3">
        <span>
          状态: <span className={isRunning ? 'text-accent-green' : 'text-text-secondary'}>
            {instance ? getStatusName(instance.status) : '未启动'}
          </span>
        </span>
        <span>
          大小: {formatSize(definition.downloadSize)}
        </span>
      </div>

      {/* Download Progress */}
      {isDownloading && (
        <div className="mb-3">
          <div className="flex items-center justify-between text-xs text-text-muted mb-1">
            <span>{instance?.downloadingFile || '下载中...'}</span>
            <span>{instance?.downloadProgress || 0}%</span>
          </div>
          <div className="h-1.5 bg-bg-tertiary rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-indigo transition-all duration-300"
              style={{ width: `${instance?.downloadProgress || 0}%` }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {instance?.error && (
        <div className="mb-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
          {instance.error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {!isDownloaded && !isDownloading && (
          <button
            onClick={handleDownload}
            disabled={isOperating}
            className="px-3 py-1.5 text-xs bg-accent-indigo text-white rounded hover:bg-accent-indigo/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isOperating ? '下载中...' : '下载'}
          </button>
        )}

        {isDownloaded && (
          <>
            {isRunning ? (
              <button
                onClick={handleStop}
                disabled={isOperating}
                className="px-3 py-1.5 text-xs bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isOperating ? '停止中...' : '停止'}
              </button>
            ) : (
              <button
                onClick={handleStart}
                disabled={isOperating}
                className="px-3 py-1.5 text-xs bg-accent-green/20 text-accent-green rounded hover:bg-accent-green/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isOperating ? '启动中...' : '启动'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * MCP Settings Component
 */
export function MCPSettings(): JSX.Element {
  const {
    definitions,
    instances,
    stats,
    isLoading,
    refresh,
    initialize,
    cleanup
  } = useMCPStore()

  // 初始化（带清理）
  useEffect(() => {
    initialize()
    return () => {
      cleanup()
    }
  }, [initialize, cleanup])

  // 按分类分组
  const groupedDefinitions = definitions.reduce((acc, def) => {
    const category = def.category
    if (!acc[category]) {
      acc[category] = []
    }
    acc[category].push(def)
    return acc
  }, {} as Record<MCPCategory, MCPDefinition[]>)

  const categoryOrder: MCPCategory[] = ['query', 'browser', 'desktop', 'memory', 'debug']

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text-primary">内置 MCP 工具</h3>
          <p className="text-xs text-text-muted mt-1">
            管理内置的 MCP 工具，支持按需下载
          </p>
        </div>
        <button
          onClick={() => refresh()}
          disabled={isLoading}
          className="p-2 text-text-muted hover:text-text-primary hover:bg-bg-hover rounded transition-colors disabled:opacity-50"
        >
          <svg
            className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.4 4.582M9 20l-1-1m0 0l1-1m-1 1h5m4-14v5h-.582m0 0a8.001 8.001 0 0115.356 2M15 20l1-1m0 0l-1 1m1-1h-5"
            />
          </svg>
        </button>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 p-3 bg-bg-secondary rounded-lg text-xs">
        <span className="text-text-muted">
          共 <span className="text-text-primary font-medium">{stats.total}</span> 个
        </span>
        <span className="text-text-muted">
          已下载 <span className="text-accent-indigo font-medium">{stats.downloadedSize}</span>
        </span>
        <span className="text-text-muted">
          运行中 <span className="text-accent-green font-medium">{stats.running}</span> 个
        </span>
      </div>

      {/* Loading State */}
      {isLoading && definitions.length === 0 && (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin w-6 h-6 border-2 border-accent-indigo border-t-transparent rounded-full" />
        </div>
      )}

      {/* MCP List */}
      {categoryOrder.map(category => {
        const mcps = groupedDefinitions[category]
        if (!mcps || mcps.length === 0) return null

        return (
          <div key={category} className="space-y-2">
            <h4 className="text-xs font-medium text-text-muted uppercase tracking-wider">
              {getCategoryName(category)}
            </h4>
            <div className="grid grid-cols-1 gap-3">
              {mcps.map(def => (
                <MCPCard
                  key={def.id}
                  definition={def}
                  instance={instances[def.id]}
                />
              ))}
            </div>
          </div>
        )
      })}

      {/* Empty State */}
      {!isLoading && definitions.length === 0 && (
        <div className="text-center py-8 text-text-muted">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
          </svg>
          <p>暂无 MCP 工具</p>
        </div>
      )}
    </div>
  )
}
