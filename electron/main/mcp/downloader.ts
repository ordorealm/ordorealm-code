/**
 * MCP Downloader - MCP 下载器
 *
 * 负责下载 MCP 包，支持国内镜像加速
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import https from 'https'
import http from 'http'
import * as tar from 'tar'

import type {
  MCPDefinition,
  MCPMirror,
  MCPDownloaderInterface,
  DownloadStatus
} from './types'

/**
 * 下载进度回调
 */
export type ProgressCallback = (progress: number, file: string, status: DownloadStatus) => void

/**
 * 下载配置
 */
export interface DownloadConfig {
  /** MCP 存储根目录 */
  mcpRoot: string
  /** 镜像偏好 */
  preferredMirror: 'cn' | 'global' | 'auto'
  /** 下载超时（毫秒） */
  timeout: number
  /** 重试次数 */
  retries: number
  /** npm install 超时（毫秒） */
  npmTimeout: number
  /** 运行时依赖下载超时（毫秒） */
  runtimeTimeout: number
}

/**
 * 默认下载配置
 */
const DEFAULT_CONFIG: DownloadConfig = {
  mcpRoot: '',
  preferredMirror: 'auto',
  timeout: 60000,
  retries: 3,
  npmTimeout: 120000,
  runtimeTimeout: 300000
}

/**
 * 校验 MCP ID 格式（防止路径遍历和命令注入）
 */
function validateMCPId(id: string): void {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid MCP ID: ${id}`)
  }
  if (id.length > 64) {
    throw new Error(`MCP ID too long: ${id}`)
  }
}

/**
 * 校验 npm 包名格式（防止命令注入）
 */
function validatePackageName(name: string): void {
  if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
    throw new Error(`Invalid package name: ${name}`)
  }
  if (name.length > 256) {
    throw new Error(`Package name too long: ${name}`)
  }
}

/**
 * 安全校验路径段（防止路径遍历，支持 npm scoped packages）
 */
function sanitizePathSegment(segment: string): string {
  // 检查路径遍历攻击
  if (segment.includes('..')) {
    throw new Error(`Path traversal detected in segment: ${segment}`)
  }

  // npm scoped package 格式: @scope/name
  // 允许 @ 开头和中间的 /，但不允许其他路径分隔符
  if (segment.startsWith('@') && segment.includes('/')) {
    // scoped package: @scope/name
    const parts = segment.split('/')
    if (parts.length !== 2) {
      throw new Error(`Invalid scoped package format: ${segment}`)
    }
    const [scope, name] = parts
    // 校验 scope 和 name 不包含非法字符
    if (!/^@[a-z0-9-~][a-z0-9-._~]*$/.test(scope)) {
      throw new Error(`Invalid scope in package name: ${segment}`)
    }
    if (!/^[a-z0-9-~][a-z0-9-._~]*$/.test(name)) {
      throw new Error(`Invalid name in scoped package: ${segment}`)
    }
    return segment
  }

  // 普通路径段：不允许路径分隔符
  if (/[\\/]/.test(segment)) {
    throw new Error(`Path separator in segment: ${segment}`)
  }

  return segment
}

/**
 * 验证路径在根目录内（防止路径遍历）
 */
function ensurePathWithinRoot(targetPath: string, root: string): void {
  const resolved = path.resolve(targetPath)
  const resolvedRoot = path.resolve(root)
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    throw new Error(`Path traversal detected: ${targetPath}`)
  }
}

/**
 * 检测是否应该使用国内镜像
 */
function shouldUseCNMirror(): boolean {
  // 检测环境变量
  if (process.env.MCP_MIRROR === 'cn') return true
  if (process.env.MCP_MIRROR === 'global') return false

  // 检测语言环境
  const lang = process.env.LANG || process.env.LC_ALL || ''
  if (lang.includes('zh_CN') || lang.includes('zh_TW')) return true

  // 检测时区
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz.startsWith('Asia/Shanghai') || tz.startsWith('Asia/Chongqing')) {
      return true
    }
  } catch {
    // ignore
  }

  // 默认使用全球镜像
  return false
}

/**
 * 获取排序后的镜像列表
 */
function getSortedMirrors(
  mirrors: MCPMirror[] | undefined,
  preferredMirror: 'cn' | 'global' | 'auto'
): MCPMirror[] {
  if (!mirrors || mirrors.length === 0) {
    return []
  }

  const sorted = [...mirrors].sort((a, b) => a.priority - b.priority)

  if (preferredMirror === 'auto') {
    const useCN = shouldUseCNMirror()
    // 优先排列偏好区域的镜像
    const preferred = sorted.filter(m => m.region === (useCN ? 'cn' : 'global'))
    const others = sorted.filter(m => m.region !== (useCN ? 'cn' : 'global'))
    return [...preferred, ...others]
  }

  const preferred = sorted.filter(m => m.region === preferredMirror)
  const others = sorted.filter(m => m.region !== preferredMirror)
  return [...preferred, ...others]
}

/**
 * 构建下载 URL（处理 scoped packages）
 */
function buildDownloadUrl(
  mirror: MCPMirror,
  packageName: string,
  version: string
): string {
  // 对于 scoped packages (@scope/name)，tarball 名称只包含 name 部分
  let tarballName: string
  if (packageName.startsWith('@') && packageName.includes('/')) {
    // scoped package: @scope/name -> name-version.tgz
    const namePart = packageName.split('/')[1]
    tarballName = `${namePart}-${version}`
  } else {
    tarballName = `${packageName}-${version}`
  }

  // 替换模板变量
  return mirror.url
    .replace('{package}', packageName)
    .replace('{version}', version)
    // 修正 tarball 名称：将 {package}-{version} 替换为正确的 tarball 名称
    .replace(/\/-\/.*\.tgz$/, `/-/${tarballName}.tgz`)
}

/**
 * 从 npm registry 获取最新版本号
 */
async function resolveLatestVersion(
  packageName: string,
  timeout: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${packageName}/latest`
    const timer = setTimeout(() => {
      reject(new Error('获取版本超时'))
    }, timeout)

    https.get(url, { timeout }, (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer)
        reject(new Error(`获取版本失败: HTTP ${response.statusCode}`))
        return
      }

      let data = ''
      response.on('data', (chunk) => { data += chunk })
      response.on('end', () => {
        clearTimeout(timer)
        try {
          const pkg = JSON.parse(data)
          resolve(pkg.version)
        } catch {
          reject(new Error('解析版本信息失败'))
        }
      })
      response.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    }).on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * 下载文件
 */
async function downloadFile(
  url: string,
  destPath: string,
  timeout: number,
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  // 防止无限重定向
  const MAX_REDIRECTS = 5

  async function doDownload(
    currentUrl: string,
    remainingRedirects: number
  ): Promise<void> {
    if (remainingRedirects <= 0) {
      throw new Error('Too many redirects')
    }

    return new Promise((resolve, reject) => {
      const protocol = currentUrl.startsWith('https') ? https : http

      const request = protocol.get(currentUrl, { timeout }, (response) => {
        // 处理重定向
        if (
          (response.statusCode === 301 || response.statusCode === 302) &&
          response.headers.location
        ) {
          response.resume() // 消费响应体
          doDownload(response.headers.location, remainingRedirects - 1)
            .then(resolve)
            .catch(reject)
          return
        }

        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`下载失败: HTTP ${response.statusCode}`))
          return
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10)
        let loadedSize = 0

        const fileStream = fs.createWriteStream(destPath)

        response.on('data', (chunk: Buffer) => {
          loadedSize += chunk.length
          if (onProgress) {
            onProgress(loadedSize, totalSize)
          }
        })

        response.on('error', (err) => {
          fileStream.close()
          reject(err)
        })

        fileStream.on('error', (err) => {
          response.destroy()
          reject(err)
        })

        fileStream.on('finish', () => {
          resolve()
        })

        response.pipe(fileStream)
      })

      request.on('error', reject)
      request.on('timeout', () => {
        request.destroy()
        reject(new Error('下载超时'))
      })
    })
  }

  return doDownload(url, MAX_REDIRECTS)
}

/**
 * 安全校验的 tar.gz 解压
 */
async function extractTarGzSafely(tarPath: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true })

  const resolvedDest = path.resolve(destDir)

  await tar.x({
    file: tarPath,
    cwd: destDir,
    strip: 1,
    onentry: (entry) => {
      // 防止 zip slip：校验每个解压路径都在目标目录内
      const entryPath = path.resolve(destDir, entry.path)
      if (!entryPath.startsWith(resolvedDest + path.sep) && entryPath !== resolvedDest) {
        throw new Error(`Unsafe path in tar archive: ${entry.path}`)
      }
    }
  })
}

/**
 * MCP Downloader 实现
 */
export class MCPDownloader implements MCPDownloaderInterface {
  private config: DownloadConfig
  /** 下载锁：防止并发下载同一个 MCP */
  private downloadLocks: Map<string, Promise<string>> = new Map()

  constructor(config: Partial<DownloadConfig> = {}) {
    // 设置默认 MCP 根目录
    const defaultRoot = path.join(
      app.getPath('userData'),
      'mcp-packages'
    )

    this.config = {
      ...DEFAULT_CONFIG,
      mcpRoot: defaultRoot,
      ...config
    }
  }

  /**
   * 获取 MCP 安装路径
   * 注意：tarball 解压后内容直接在 {mcpRoot}/{id}/ 目录下
   */
  getInstallPath(definition: MCPDefinition): string {
    const safeId = sanitizePathSegment(definition.id)
    const installPath = path.join(this.config.mcpRoot, safeId)
    ensurePathWithinRoot(installPath, this.config.mcpRoot)
    return installPath
  }

  /**
   * 获取下载路径（接口实现）
   */
  getDownloadPath(definition: MCPDefinition): string {
    return this.getInstallPath(definition)
  }

  /**
   * 获取下载缓存路径
   * 对于 scoped packages，将 / 替换为 - 避免创建嵌套目录
   */
  getCachePath(definition: MCPDefinition): string {
    const safePackage = sanitizePathSegment(definition.packageName)
    // 将 scoped package 的 / 替换为 -，如 @scope/name -> @scope-name
    const cacheName = safePackage.replace(/\//g, '-')
    const cachePath = path.join(
      this.config.mcpRoot,
      'cache',
      `${cacheName}.tgz`
    )
    ensurePathWithinRoot(cachePath, this.config.mcpRoot)
    return cachePath
  }

  /**
   * 检查是否已下载
   */
  async isDownloaded(definition: MCPDefinition): Promise<boolean> {
    const installPath = this.getInstallPath(definition)
    const packageJsonPath = path.join(installPath, 'package.json')

    try {
      await fs.promises.access(packageJsonPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取下载状态
   */
  async getDownloadStatus(definition: MCPDefinition): Promise<DownloadStatus> {
    const isDownloaded = await this.isDownloaded(definition)
    if (isDownloaded) {
      return 'downloaded'
    }

    const cachePath = this.getCachePath(definition)
    try {
      await fs.promises.access(cachePath)
      return 'downloaded' // 缓存存在但未解压
    } catch {
      return 'not_downloaded'
    }
  }

  /**
   * 下载 MCP（带并发锁和镜像回退）
   */
  async download(
    definition: MCPDefinition,
    onProgress?: ProgressCallback
  ): Promise<string> {
    // 校验输入
    validateMCPId(definition.id)
    validatePackageName(definition.packageName)

    const { id } = definition

    // 检查是否有正在进行的下载（并发锁）
    const existingDownload = this.downloadLocks.get(id)
    if (existingDownload) {
      return existingDownload
    }

    // 检查是否已下载
    if (await this.isDownloaded(definition)) {
      return this.getInstallPath(definition)
    }

    // 创建下载 Promise 并加锁
    const downloadPromise = this._doDownload(definition, onProgress)
      .finally(() => this.downloadLocks.delete(id))

    this.downloadLocks.set(id, downloadPromise)
    return downloadPromise
  }

  /**
   * 实际执行下载（带镜像回退）
   */
  private async _doDownload(
    definition: MCPDefinition,
    onProgress?: ProgressCallback
  ): Promise<string> {
    const { packageName, mirrors } = definition
    let { version } = definition
    const cachePath = this.getCachePath(definition)

    // 如果版本是 'latest'，先解析实际版本号
    if (version === 'latest') {
      try {
        console.log(`[MCP Downloader] 解析 ${packageName} 最新版本...`)
        version = await resolveLatestVersion(packageName, this.config.timeout)
        console.log(`[MCP Downloader] 最新版本: ${version}`)
      } catch (err) {
        console.error(`[MCP Downloader] 解析版本失败:`, err)
        throw new Error(`无法获取 ${packageName} 的版本信息`)
      }
    }

    // 创建下载目录
    const cacheDir = path.dirname(cachePath)
    await fs.promises.mkdir(cacheDir, { recursive: true })

    // 获取排序后的镜像列表
    const sortedMirrors = getSortedMirrors(mirrors, this.config.preferredMirror)

    // 带回退的下载
    let downloadSuccess = false
    let lastError: Error | null = null

    if (sortedMirrors.length > 0) {
      for (const mirror of sortedMirrors) {
        try {
          const downloadUrl = buildDownloadUrl(mirror, packageName, version)
          console.log(`[MCP Downloader] 尝试从 ${mirror.name} 下载 ${packageName}@${version}`)
          console.log(`[MCP Downloader] URL: ${downloadUrl}`)

          onProgress?.(0, packageName, 'downloading')

          let lastProgress = 0
          await downloadFile(
            downloadUrl,
            cachePath,
            this.config.timeout,
            (loaded, total) => {
              const progress = total > 0 ? Math.round((loaded / total) * 100) : 50
              if (progress !== lastProgress) {
                lastProgress = progress
                onProgress?.(progress, packageName, 'downloading')
              }
            }
          )

          downloadSuccess = true
          break
        } catch (err) {
          console.warn(`[MCP Downloader] 镜像 ${mirror.name} 失败:`, err)
          lastError = err as Error
          continue
        }
      }
    }

    // 所有镜像都失败，尝试 npm registry
    if (!downloadSuccess) {
      try {
        // npm registry URL 格式：
        // 普通包: https://registry.npmjs.org/package/-/package-version.tgz
        // scoped 包: https://registry.npmjs.org/@scope/name/-/name-version.tgz
        let tarballName: string
        if (packageName.startsWith('@') && packageName.includes('/')) {
          // scoped package: @scope/name -> name-version.tgz
          const namePart = packageName.split('/')[1]
          tarballName = `${namePart}-${version}`
        } else {
          tarballName = `${packageName}-${version}`
        }
        const downloadUrl = `https://registry.npmjs.org/${packageName}/-/${tarballName}.tgz`
        console.log(`[MCP Downloader] 尝试从 npm registry 下载 ${packageName}`)

        onProgress?.(0, packageName, 'downloading')
        let lastProgress = 0
        await downloadFile(
          downloadUrl,
          cachePath,
          this.config.timeout,
          (loaded, total) => {
            const progress = total > 0 ? Math.round((loaded / total) * 100) : 50
            if (progress !== lastProgress) {
              lastProgress = progress
              onProgress?.(progress, packageName, 'downloading')
            }
          }
        )
        downloadSuccess = true
      } catch (err) {
        lastError = err as Error
      }
    }

    if (!downloadSuccess) {
      throw new Error(`所有镜像均失败: ${lastError?.message || '未知错误'}`)
    }

    // 解压文件
    onProgress?.(100, packageName, 'extracting')

    const installDir = path.join(this.config.mcpRoot, sanitizePathSegment(definition.id))
    ensurePathWithinRoot(installDir, this.config.mcpRoot)
    await fs.promises.mkdir(installDir, { recursive: true })

    try {
      await extractTarGzSafely(cachePath, installDir)
    } catch (err) {
      console.error(`[MCP Downloader] 解压失败:`, err)
      throw new Error(`解压失败: ${err}`)
    }

    // 清理缓存
    try {
      await fs.promises.unlink(cachePath)
    } catch {
      // ignore
    }

    // 注意：不在这里报告 100%，由 Manager 根据整体进度控制
    // 最后报告当前阶段完成状态
    onProgress?.(95, packageName, 'ready')

    return this.getInstallPath(definition)
  }

  /**
   * 清理下载缓存
   */
  async clearCache(): Promise<void> {
    const cacheDir = path.join(this.config.mcpRoot, 'cache')
    try {
      await fs.promises.rm(cacheDir, { recursive: true })
    } catch {
      // ignore
    }
  }

  /**
   * 获取 MCP 根目录
   */
  getMCPRoot(): string {
    return this.config.mcpRoot
  }

  /**
   * 设置镜像偏好
   */
  setMirrorPreference(preference: 'cn' | 'global' | 'auto'): void {
    this.config.preferredMirror = preference
  }

  /**
   * 安装 MCP 的依赖（带进度回调）
   */
  async installDependencies(
    definition: MCPDefinition,
    onProgress?: ProgressCallback
  ): Promise<void> {
    validateMCPId(definition.id)
    validatePackageName(definition.packageName)

    const safeId = sanitizePathSegment(definition.id)
    const installDir = path.join(this.config.mcpRoot, safeId)
    ensurePathWithinRoot(installDir, this.config.mcpRoot)

    const packageName = definition.packageName

    // 检查是否已有 node_modules（某些包在 tarball 中已包含依赖）
    const nodeModulesPath = path.join(installDir, 'node_modules')
    try {
      const stat = await fs.promises.stat(nodeModulesPath)
      if (stat.isDirectory()) {
        // 检查 node_modules 是否有内容
        const files = await fs.promises.readdir(nodeModulesPath)
        if (files.length > 0) {
          console.log(`[MCP Downloader] ${packageName} 已包含 node_modules，跳过 npm install`)
          onProgress?.(95, packageName, 'extracting')
          return
        }
      }
    } catch {
      // node_modules 不存在，继续安装
    }

    console.log(`[MCP Downloader] 安装依赖: ${packageName}`)
    onProgress?.(10, packageName, 'extracting')

    const { exec } = await import('child_process')
    const { promisify } = await import('util')
    const execAsync = promisify(exec)

    // 定时更新进度，让用户知道正在处理
    let progress = 10
    const progressInterval = setInterval(() => {
      if (progress < 90) {
        progress += 5
        onProgress?.(progress, packageName, 'extracting')
      }
    }, 2000) // 每2秒增加5%

    try {
      // 使用内置 npm 安装依赖
      const npmCommand = this.buildNpmCommand('install --production')
      console.log(`[MCP Downloader] 执行命令: ${npmCommand}`)

      // ★ 设置环境变量：将内置 Node.js 目录添加到 PATH
      // 这样 npm postinstall 脚本中的 `node` 命令才能找到
      const nodePath = this.getNodePath()
      // nodePath 示例:
      //   Windows: C:\...\runtime\node\win-x64\node.exe
      //   macOS:   /.../runtime/node/darwin-arm64/bin/node
      // nodeDir 是 node 可执行文件所在的目录:
      //   Windows: win-x64 (node.exe 在根目录)
      //   macOS:   darwin-arm64/bin (node 在 bin 子目录)
      const nodeDir = path.dirname(nodePath)

      const env: Record<string, string> = {
        ...process.env as Record<string, string>,
        // 将 Node.js 可执行文件所在目录添加到 PATH（最前面，确保优先使用）
        PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ''}`
      }

      console.log(`[MCP Downloader] PATH: ${env.PATH.substring(0, 200)}...`)

      const result = await execAsync(npmCommand, {
        cwd: installDir,
        timeout: this.config.npmTimeout,
        maxBuffer: 1024 * 1024 * 10, // 10MB buffer
        env,  // ★ 传递环境变量
      })

      if (result.stdout) {
        console.log(`[npm stdout] ${result.stdout.slice(0, 500)}`)
      }
      if (result.stderr) {
        console.log(`[npm stderr] ${result.stderr.slice(0, 500)}`)
      }

      clearInterval(progressInterval)
      onProgress?.(95, packageName, 'extracting')
    } catch (err) {
      clearInterval(progressInterval)

      // 检查是否是因为 node_modules 已存在导致的错误
      try {
        const files = await fs.promises.readdir(nodeModulesPath)
        if (files.length > 0) {
          console.log(`[MCP Downloader] ${packageName} node_modules 已存在，忽略 npm install 错误`)
          onProgress?.(95, packageName, 'extracting')
          return
        }
      } catch {
        // ignore
      }

      console.error(`[MCP Downloader] 安装依赖失败:`, err)
      throw new Error(`安装依赖失败: ${err}`)
    }
  }

  /**
   * 下载运行时依赖（如 Playwright 的 Chromium）
   */
  async downloadRuntimeDependency(
    definition: MCPDefinition,
    onProgress?: ProgressCallback
  ): Promise<void> {
    if (!definition.runtimeDependencies) return

    validateMCPId(definition.id)

    for (const dep of definition.runtimeDependencies) {
      onProgress?.(0, dep.name, 'downloading')

      if (definition.id === 'playwright') {
        const safeId = sanitizePathSegment(definition.id)
        const installDir = path.join(this.config.mcpRoot, safeId)
        ensurePathWithinRoot(installDir, this.config.mcpRoot)

        // Playwright 包解压后直接在安装目录
        // 检查 cli.js 或 index.js 是否存在
        const cliPath = path.join(installDir, 'cli.js')
        const indexPath = path.join(installDir, 'index.js')

        try {
          await fs.promises.access(cliPath)
        } catch {
          try {
            await fs.promises.access(indexPath)
          } catch {
            console.error(`[MCP Downloader] Playwright 未正确安装，找不到入口文件`)
            throw new Error(`Playwright 未正确安装`)
          }
        }

        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        const execAsync = promisify(exec)

        try {
          // 设置环境变量
          const nodeModulesBin = path.join(installDir, 'node_modules', '.bin')
          // ★ 添加 Node.js 到 PATH（npx/playwright 需要）
          const nodePath = this.getNodePath()
          const nodeDir = path.dirname(nodePath)
          const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            // 设置 Playwright 下载镜像
            PLAYWRIGHT_DOWNLOAD_HOST: shouldUseCNMirror()
              ? 'https://npmmirror.com/mirrors/playwright'
              : 'https://playwright.azureedge.net',
            // 将 Node.js 目录和 node_modules/.bin 添加到 PATH
            PATH: `${nodeDir}${path.delimiter}${nodeModulesBin}${path.delimiter}${process.env.PATH || ''}`
          }

          console.log(`[MCP Downloader] 安装 Playwright Chromium 到 ${installDir}`)
          onProgress?.(10, dep.name, 'downloading')

          // 定时更新进度
          let progress = 10
          const progressInterval = setInterval(() => {
            if (progress < 90) {
              progress += 3
              onProgress?.(progress, dep.name, 'downloading')
            }
          }, 3000) // 每3秒增加3%

          // ★ 国内镜像兼容：npmmirror 只同步到 playwright-core 1.48.0 左右的 Chromium
          // 先降级 playwright-core 到可用版本，安装浏览器后再恢复
          let savedPlaywrightCoreVersion = ''
          const playwrightCorePkgPath = path.join(installDir, 'node_modules', 'playwright-core', 'package.json')
          if (shouldUseCNMirror() && fs.existsSync(playwrightCorePkgPath)) {
            try {
              const pkgData = JSON.parse(fs.readFileSync(playwrightCorePkgPath, 'utf-8'))
              savedPlaywrightCoreVersion = pkgData.version
              console.log(`[MCP Downloader] 当前 playwright-core: ${savedPlaywrightCoreVersion}，降级到 1.48.0 以兼容国内镜像`)
              const downgradeCmd = this.buildNpmCommand('install playwright-core@1.48.0 --no-save')
              await execAsync(downgradeCmd, {
                cwd: installDir,
                timeout: 60000,
                maxBuffer: 1024 * 1024 * 10,
                env
              })
            } catch (e) {
              console.warn(`[MCP Downloader] playwright-core 降级失败，使用当前版本:`, e)
            }
          }

          // 使用 node_modules/.bin/playwright 或 npx 运行
          // 方案1: 直接使用 playwright-core 的 CLI（因为 @playwright/mcp 依赖 playwright-core）
          const playwrightCoreCli = path.join(installDir, 'node_modules', 'playwright-core', 'cli.js')
          let command: string

          if (fs.existsSync(playwrightCoreCli)) {
            // 使用 playwright-core CLI
            const nodePath = this.getNodePath()
            command = `"${nodePath}" "${playwrightCoreCli}" install chromium`
            console.log(`[MCP Downloader] 使用 playwright-core CLI`)
          } else {
            // 回退到 npx，使用内置 npx
            const npxPath = this.getNpmPath().replace('npm.cmd', 'npx.cmd').replace(/\/npm$/, '/npx')
            command = `"${npxPath}" playwright install chromium`
            console.log(`[MCP Downloader] 使用 npx playwright`)
          }

          console.log(`[MCP Downloader] 执行命令: ${command}`)

          const result = await execAsync(command, {
            cwd: installDir,
            env,
            timeout: this.config.runtimeTimeout,
            maxBuffer: 1024 * 1024 * 10
          })

          clearInterval(progressInterval)

          if (result.stdout) {
            console.log(`[Playwright stdout] ${result.stdout.slice(0, 1000)}`)
          }
          if (result.stderr) {
            console.log(`[Playwright stderr] ${result.stderr.slice(0, 1000)}`)
          }

          onProgress?.(100, dep.name, 'ready')
          console.log(`[MCP Downloader] Playwright Chromium 安装完成`)

          // ★ 恢复 playwright-core 到原版本
          if (savedPlaywrightCoreVersion && shouldUseCNMirror()) {
            try {
              console.log(`[MCP Downloader] 恢复 playwright-core 到 ${savedPlaywrightCoreVersion}`)
              const restoreCmd = this.buildNpmCommand(`install playwright-core@${savedPlaywrightCoreVersion} --no-save`)
              await execAsync(restoreCmd, {
                cwd: installDir,
                timeout: 60000,
                maxBuffer: 1024 * 1024 * 10,
                env
              })
            } catch (e) {
              console.warn(`[MCP Downloader] playwright-core 版本恢复失败:`, e)
            }
          }
        } catch (err) {
          console.error(`[MCP Downloader] 下载运行时依赖失败:`, err)
          throw new Error(`下载运行时依赖失败: ${err}`)
        }
      }
    }
  }

  /**
   * 获取运行时目标目录名
   * 映射 process.platform 到目录命名约定：
   * - win32 -> win (Node.js 使用 'win-x64'，不是 'win32-x64')
   * - darwin -> darwin (不变)
   */
  private getRuntimeTargetName(): string {
    const platform = process.platform
    const arch = process.arch
    const platformName = platform === 'win32' ? 'win' : platform
    return `${platformName}-${arch}`
  }

  /**
   * 获取 Node.js 可执行文件路径
   */
  private getNodePath(): string {
    const platform = process.platform
    const targetName = this.getRuntimeTargetName()
    const userDataDir = app.getPath('userData')

    // 1. 优先使用用户数据目录中的运行时（RuntimeManager 提取的位置）
    if (platform === 'win32') {
      // Windows: node.exe 在根目录
      const nodeExe = path.join(userDataDir, 'runtime', 'node', targetName, 'node.exe')
      if (fs.existsSync(nodeExe)) {
        return nodeExe
      }
    } else {
      // macOS/Linux: node 在 bin 目录
      const nodeBin = path.join(userDataDir, 'runtime', 'node', targetName, 'bin', 'node')
      if (fs.existsSync(nodeBin)) {
        return nodeBin
      }
    }

    // 2. 检查应用资源目录中的运行时（打包后的位置）
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'electron')

    if (platform === 'win32') {
      const nodeExe = path.join(resourcesDir, 'runtime', 'node', targetName, 'node.exe')
      if (fs.existsSync(nodeExe)) {
        return nodeExe
      }
    } else {
      const nodeBin = path.join(resourcesDir, 'runtime', 'node', targetName, 'bin', 'node')
      if (fs.existsSync(nodeBin)) {
        return nodeBin
      }
    }

    // 3. 回退到系统 Node.js
    return 'node'
  }

  /**
   * 获取 npm 可执行文件路径
   */
  private getNpmPath(): string {
    const platform = process.platform
    const targetName = this.getRuntimeTargetName()
    const userDataDir = app.getPath('userData')

    // 1. 优先使用用户数据目录中的运行时（RuntimeManager 提取的位置）
    if (platform === 'win32') {
      // Windows: npm.cmd 在根目录
      const npmCmd = path.join(userDataDir, 'runtime', 'node', targetName, 'npm.cmd')
      if (fs.existsSync(npmCmd)) {
        return npmCmd
      }
    } else {
      // macOS/Linux: npm 在 bin 目录
      const npmBin = path.join(userDataDir, 'runtime', 'node', targetName, 'bin', 'npm')
      if (fs.existsSync(npmBin)) {
        return npmBin
      }
    }

    // 2. 检查应用资源目录中的运行时（打包后的位置）
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : path.join(app.getAppPath(), 'electron')

    if (platform === 'win32') {
      const npmCmd = path.join(resourcesDir, 'runtime', 'node', targetName, 'npm.cmd')
      if (fs.existsSync(npmCmd)) {
        return npmCmd
      }
    } else {
      const npmBin = path.join(resourcesDir, 'runtime', 'node', targetName, 'bin', 'npm')
      if (fs.existsSync(npmBin)) {
        return npmBin
      }
    }

    // 3. 回退到系统 npm
    return 'npm'
  }

  /**
   * 构建 npm 命令（使用内置 Node.js 运行时）
   */
  private buildNpmCommand(args: string): string {
    const nodePath = this.getNodePath()
    const npmPath = this.getNpmPath()
    const platform = process.platform

    if (platform === 'win32') {
      // Windows: 直接调用 npm.cmd
      return `"${npmPath}" ${args}`
    } else {
      // macOS/Linux: 优先使用 node 执行 npm-cli.js（更可靠）
      const targetName = this.getRuntimeTargetName()
      const npmCliPath = path.join(
        app.getPath('userData'),
        'runtime',
        'node',
        targetName,
        'lib',
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js'
      )
      if (fs.existsSync(npmCliPath)) {
        return `"${nodePath}" "${npmCliPath}" ${args}`
      }
      // 回退到 npm 脚本
      return `"${npmPath}" ${args}`
    }
  }
}

// 单例实例
let downloaderInstance: MCPDownloader | null = null

/**
 * 获取 Downloader 单例
 */
export function getMCPDownloader(config?: Partial<DownloadConfig>): MCPDownloader {
  if (!downloaderInstance) {
    downloaderInstance = new MCPDownloader(config)
  }
  return downloaderInstance
}

/**
 * 重置单例（用于测试）
 */
export function resetMCPDownloader(): void {
  downloaderInstance = null
}
