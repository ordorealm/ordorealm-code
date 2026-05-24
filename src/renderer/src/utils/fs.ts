/**
 * 文件系统工具函数
 * 通过 Electron IPC 与主进程通信进行文件操作
 */

// 文件系统操作的 IPC 接口类型定义
interface FsResult<T = void> {
  success: boolean
  error?: string
  content?: T
}

interface DirEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: DirEntry[]
}

// 缓存用户数据路径，避免重复 IPC 调用
let _userDataPath: string | null = null

/**
 * 获取用户数据目录路径
 * 通过 IPC 从主进程获取，因为渲染进程没有 process.env
 * @returns 用户数据目录路径
 */
export async function getUserDataPathAsync(): Promise<string> {
  if (_userDataPath) {
    return _userDataPath
  }

  try {
    _userDataPath = await window.api.fs.getUserDataPath()
    return _userDataPath
  } catch (error) {
    console.error('Failed to get user data path:', error)
    // Fallback to a relative path
    return '.devflow'
  }
}

/**
 * 获取用户数据目录路径（同步版本，用于兼容）
 * 注意：首次调用会返回默认值，后续调用会返回缓存值
 * @returns 用户数据目录路径
 */
export function getUserDataPath(): string {
  if (_userDataPath) {
    return _userDataPath
  }

  // 返回默认值，同时异步获取真实路径
  // 这样可以避免阻塞，但首次调用可能返回不准确的值
  window.api.fs.getUserDataPath().then((path: string) => {
    _userDataPath = path
  }).catch((err: unknown) => {
    console.error('Failed to get user data path:', err)
  })

  // 返回临时默认值
  return '.devflow'
}

/**
 * 初始化用户数据路径
 * 在应用启动时调用，确保路径已缓存
 */
export async function initializeUserDataPath(): Promise<void> {
  _userDataPath = await window.api.fs.getUserDataPath()
  console.log('[fs] User data path:', _userDataPath)
}

/**
 * 确保目录存在
 * @param path 目录路径
 */
export async function ensureDir(path: string): Promise<boolean> {
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:mkdir', path)
    return (result as FsResult).success
  } catch (error) {
    console.error(`Failed to ensure directory: ${path}`, error)
    return false
  }
}

/**
 * 读取 JSON 文件
 * @param path 文件路径
 * @returns JSON 数据或 null
 */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:readFile', path) as FsResult<string>
    if (result.success && result.content) {
      return JSON.parse(result.content) as T
    }
    return null
  } catch (error) {
    console.error(`Failed to read JSON file: ${path}`, error)
    return null
  }
}

/**
 * 写入 JSON 文件
 * @param path 文件路径
 * @param data 要写入的数据
 * @returns 是否成功
 */
export async function writeJsonFile<T>(path: string, data: T): Promise<boolean> {
  try {
    const content = JSON.stringify(data, null, 2)
    const result = await window.electron.ipcRenderer.invoke('fs:writeFile', path, content)
    return (result as FsResult).success
  } catch (error) {
    console.error(`Failed to write JSON file: ${path}`, error)
    return false
  }
}

/**
 * 检查文件是否存在
 * @param path 文件路径
 * @returns 文件是否存在
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:exists', path)
    return result as boolean
  } catch (error) {
    console.error(`Failed to check file existence: ${path}`, error)
    return false
  }
}

/**
 * 删除文件
 * @param path 文件路径
 * @returns 是否成功
 */
export async function deleteFile(path: string): Promise<boolean> {
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:delete', path)
    return (result as FsResult).success
  } catch (error) {
    console.error(`Failed to delete file: ${path}`, error)
    return false
  }
}

/**
 * 读取目录
 * @param path 目录路径
 * @param depth 递归深度，默认为 1
 * @returns 目录条目列表
 */
export async function readDir(path: string, depth: number = 1): Promise<DirEntry[]> {
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:readDir', path, depth) as FsResult<DirEntry[]>
    if (result.success && result.content) {
      return result.content
    }
    return []
  } catch (error) {
    console.error(`Failed to read directory: ${path}`, error)
    return []
  }
}

/**
 * 读取文本文件
 * @param path 文件路径
 * @returns 文件内容或 null
 */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:readFile', path) as FsResult<string>
    if (result.success && result.content) {
      return result.content
    }
    return null
  } catch (error) {
    console.error(`Failed to read text file: ${path}`, error)
    return null
  }
}

/**
 * 写入文本文件
 * @param path 文件路径
 * @param content 文件内容
 * @returns 是否成功
 */
export async function writeTextFile(path: string, content: string): Promise<boolean> {
  try {
    const result = await window.electron.ipcRenderer.invoke('fs:writeFile', path, content)
    return (result as FsResult).success
  } catch (error) {
    console.error(`Failed to write text file: ${path}`, error)
    return false
  }
}
