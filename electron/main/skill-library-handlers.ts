/**
 * Skill Library IPC Handlers
 * Handles skill library management operations in the main process
 * @module main/skill-library-handlers
 */

import { app, ipcMain } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import AdmZip from 'adm-zip'
import { v4 as uuidv4 } from 'uuid'

// Agent type definition (synced with renderer types)
type AgentType = 'claude-code' | 'codex' | 'opencode'

// Skill library metadata interface
interface SkillLibrary {
  id: string
  name: string
  description: string
  agentType: AgentType
  fileSize: number
  createdAt: string
  updatedAt: string
}

// Validation result interface
interface SkillLibraryValidateResult {
  valid: boolean
  error?: string
}

// Activation result interface
interface SkillLibraryActivateResult {
  success: boolean
  error?: string
}

// Agent type to directory name mapping
const AGENT_DIR_MAP: Record<AgentType, string> = {
  'claude-code': '.claude',
  'codex': '.codex',
  'opencode': '.opencode',
}

// Agent type to main file name mapping
const AGENT_MAIN_FILE_MAP: Record<AgentType, string> = {
  'claude-code': 'CLAUDE.md',
  'codex': 'AGENTS.md',
  'opencode': 'opencode.md',
}

// Valid main configuration files
const VALID_MAIN_FILES = ['CLAUDE.md', 'AGENTS.md', 'opencode.md']

// Maximum file size (100MB)
const MAX_FILE_SIZE = 100 * 1024 * 1024

/**
 * Get the skill libraries storage directory
 */
function getSkillLibrariesDir(): string {
  return path.join(app.getPath('userData'), 'skill-libraries')
}

/**
 * Get the library directory for a specific skill library
 */
function getLibraryDir(libraryId: string): string {
  return path.join(getSkillLibrariesDir(), libraryId)
}

/**
 * Get the path to library.json
 */
function getLibraryJsonPath(libraryId: string): string {
  return path.join(getLibraryDir(libraryId), 'library.json')
}

/**
 * Get the path to archive.zip
 */
function getArchiveZipPath(libraryId: string): string {
  return path.join(getLibraryDir(libraryId), 'archive.zip')
}

/**
 * Ensure the skill libraries directory exists
 */
async function ensureSkillLibrariesDir(): Promise<void> {
  const dir = getSkillLibrariesDir()
  try {
    await fs.access(dir)
  } catch {
    await fs.mkdir(dir, { recursive: true })
  }
}

/**
 * Find the root directory in a zip file
 * Returns the entry path prefix if files are nested in a subdirectory
 */
function findRootDirectory(entries: AdmZip.IZipEntry[]): string | null {
  // Check if any valid main file exists at root level
  for (const entry of entries) {
    const name = path.basename(entry.entryName)
    if (VALID_MAIN_FILES.includes(name) && !entry.isDirectory) {
      return null // Files are at root level
    }
  }

  // Find common directory prefix (ignoring macOS metadata directories)
  const dirEntries = new Set<string>()
  for (const entry of entries) {
    const parts = entry.entryName.split('/')
    if (parts.length > 1) {
      // Ignore macOS metadata directories
      if (parts[0] === '__MACOSX') continue
      dirEntries.add(parts[0] + '/')
    }
  }

  // If there's a single root directory, check if it contains main files
  if (dirEntries.size === 1) {
    const rootDir = Array.from(dirEntries)[0]
    for (const entry of entries) {
      if (entry.entryName.startsWith(rootDir)) {
        const relativePath = entry.entryName.slice(rootDir.length)
        const name = path.basename(relativePath)
        if (VALID_MAIN_FILES.includes(name) && !entry.isDirectory) {
          return rootDir
        }
      }
    }
  }

  return null
}

/**
 * Recursively find .md file in directory tree
 */
async function findMdFileRecursive(dirPath: string): Promise<string | null> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })

  // First, check for .md files at current level
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      return path.join(dirPath, entry.name)
    }
  }

  // Then check subdirectories
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const result = await findMdFileRecursive(path.join(dirPath, entry.name))
      if (result) return result
    }
  }

  return null
}

/**
 * List all skill libraries
 */
async function listLibraries(): Promise<SkillLibrary[]> {
  await ensureSkillLibrariesDir()

  const librariesDir = getSkillLibrariesDir()
  const entries = await fs.readdir(librariesDir, { withFileTypes: true })
  const libraries: SkillLibrary[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const libraryJsonPath = getLibraryJsonPath(entry.name)
    try {
      const content = await fs.readFile(libraryJsonPath, 'utf-8')
      const library: SkillLibrary = JSON.parse(content)
      libraries.push(library)
    } catch (err) {
      console.warn(`[SkillLibrary] Failed to read library.json for ${entry.name}:`, err)
    }
  }

  // Sort by creation time (newest first)
  libraries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return libraries
}

/**
 * Add a new skill library
 */
async function addLibrary(
  zipPath: string,
  name: string,
  description: string,
  agentType: AgentType
): Promise<SkillLibrary> {
  await ensureSkillLibrariesDir()

  // Check if zip file exists
  try {
    await fs.access(zipPath)
  } catch {
    throw new Error(`Zip file not found: ${zipPath}`)
  }

  // Get file size
  const stats = await fs.stat(zipPath)
  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds 100MB limit (${(stats.size / 1024 / 1024).toFixed(2)} MB)`)
  }

  // Validate zip structure
  const validationResult = await validateLibrary(zipPath)
  if (!validationResult.valid) {
    throw new Error(validationResult.error || 'Invalid zip file structure')
  }

  // Generate UUID
  const id = uuidv4()

  // Create library directory
  const libraryDir = getLibraryDir(id)
  await fs.mkdir(libraryDir, { recursive: true })

  // Copy zip file
  const archivePath = getArchiveZipPath(id)
  await fs.copyFile(zipPath, archivePath)

  // Create library.json
  const now = new Date().toISOString()
  const library: SkillLibrary = {
    id,
    name,
    description,
    agentType,
    fileSize: stats.size,
    createdAt: now,
    updatedAt: now,
  }

  await fs.writeFile(getLibraryJsonPath(id), JSON.stringify(library, null, 2), 'utf-8')

  console.log(`[SkillLibrary] Added library: ${name} (${id})`)
  return library
}

/**
 * Update skill library metadata
 */
async function updateLibrary(
  id: string,
  name: string,
  description: string
): Promise<SkillLibrary> {
  const libraryJsonPath = getLibraryJsonPath(id)

  // Read existing library
  let library: SkillLibrary
  try {
    const content = await fs.readFile(libraryJsonPath, 'utf-8')
    library = JSON.parse(content)
  } catch {
    throw new Error(`Library not found: ${id}`)
  }

  // Update fields
  library.name = name
  library.description = description
  library.updatedAt = new Date().toISOString()

  // Save
  await fs.writeFile(libraryJsonPath, JSON.stringify(library, null, 2), 'utf-8')

  console.log(`[SkillLibrary] Updated library: ${name} (${id})`)
  return library
}

/**
 * Delete a skill library
 */
async function deleteLibrary(id: string): Promise<boolean> {
  const libraryDir = getLibraryDir(id)

  // Check if exists
  try {
    await fs.access(libraryDir)
  } catch {
    throw new Error(`Library not found: ${id}`)
  }

  // Delete directory
  await fs.rm(libraryDir, { recursive: true })

  console.log(`[SkillLibrary] Deleted library: ${id}`)
  return true
}

/**
 * Get the download path for a skill library
 */
async function downloadLibrary(id: string): Promise<{ path: string }> {
  const archivePath = getArchiveZipPath(id)

  // Check if exists
  try {
    await fs.access(archivePath)
  } catch {
    throw new Error(`Library archive not found: ${id}`)
  }

  return { path: archivePath }
}

/**
 * Validate a zip file for skill library structure
 */
async function validateLibrary(zipPath: string): Promise<SkillLibraryValidateResult> {
  try {
    // Check file exists
    try {
      await fs.access(zipPath)
    } catch {
      return { valid: false, error: 'File not found' }
    }

    // Check file size
    const stats = await fs.stat(zipPath)
    if (stats.size > MAX_FILE_SIZE) {
      return { valid: false, error: `File size exceeds 100MB limit (${(stats.size / 1024 / 1024).toFixed(2)} MB)` }
    }

    // Open zip and check structure
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries()

    if (entries.length === 0) {
      return { valid: false, error: 'Zip file is empty' }
    }

    // Find root directory (if nested)
    const rootDir = findRootDirectory(entries)

    // Check for main configuration file
    let hasMainFile = false
    for (const entry of entries) {
      if (entry.isDirectory) continue

      let entryName = entry.entryName
      if (rootDir) {
        entryName = entryName.slice(rootDir.length)
      }

      const name = path.basename(entryName)
      if (VALID_MAIN_FILES.includes(name)) {
        hasMainFile = true
        break
      }
    }

    if (!hasMainFile) {
      return {
        valid: false,
        error: 'Missing main configuration file (CLAUDE.md, AGENTS.md, or opencode.md)',
      }
    }

    return { valid: true }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    return { valid: false, error: `Failed to validate zip file: ${errorMessage}` }
  }
}

/**
 * Activate a skill library in a project
 */
async function activateLibrary(
  id: string,
  projectPath: string
): Promise<SkillLibraryActivateResult> {
  try {
    // Get library info
    const libraryJsonPath = getLibraryJsonPath(id)
    let library: SkillLibrary
    try {
      const content = await fs.readFile(libraryJsonPath, 'utf-8')
      library = JSON.parse(content)
    } catch {
      return { success: false, error: `Library not found: ${id}` }
    }

    // Get zip path
    const archivePath = getArchiveZipPath(id)
    try {
      await fs.access(archivePath)
    } catch {
      return { success: false, error: `Library archive not found: ${id}` }
    }

    // Determine target directory
    const targetDirName = AGENT_DIR_MAP[library.agentType]
    const targetPath = path.join(projectPath, targetDirName)

    // Clear target directory if exists
    if (fsSync.existsSync(targetPath)) {
      await fs.rm(targetPath, { recursive: true })
    }

    // Create target directory
    await fs.mkdir(targetPath, { recursive: true })

    // Open zip
    const zip = new AdmZip(archivePath)
    const entries = zip.getEntries()

    // Find root directory (if nested)
    const rootDir = findRootDirectory(entries)

    // Extract entries, stripping root directory prefix if needed
    for (const entry of entries) {
      if (entry.isDirectory) continue

      let entryName = entry.entryName

      // Skip macOS metadata directories
      if (entryName.startsWith('__MACOSX/')) continue

      if (rootDir) {
        entryName = entryName.slice(rootDir.length)
      }

      // Skip if entryName is empty after stripping
      if (!entryName || entryName.startsWith('/')) {
        entryName = entryName.replace(/^\//, '')
      }
      if (!entryName) continue

      const targetFilePath = path.join(targetPath, entryName)
      const targetFileDir = path.dirname(targetFilePath)

      // Create directory if needed
      await fs.mkdir(targetFileDir, { recursive: true })

      // Write file
      const content = entry.getData()
      await fs.writeFile(targetFilePath, content)
    }

    // Rename main configuration file if needed
    const targetMainFile = AGENT_MAIN_FILE_MAP[library.agentType]
    const existingMdPath = await findMdFileRecursive(targetPath)

    if (existingMdPath) {
      const existingMdFile = path.basename(existingMdPath)

      if (existingMdFile !== targetMainFile) {
        // Move and rename to the agent config directory (usually root of targetPath)
        const newPath = path.join(targetPath, targetMainFile)
        await fs.rename(existingMdPath, newPath)
        console.log(`[SkillLibrary] Renamed ${existingMdFile} to ${targetMainFile}`)
      }
    }

    console.log(`[SkillLibrary] Activated library: ${library.name} in ${projectPath}`)
    return { success: true }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error(`[SkillLibrary] Activation failed:`, errorMessage)
    return { success: false, error: errorMessage }
  }
}

/**
 * Register all skill library IPC handlers
 */
export function registerSkillLibraryHandlers(): void {
  // List all libraries
  ipcMain.handle(
    'skill-library:list',
    async (): Promise<{ success: boolean; skills: SkillLibrary[]; error?: string }> => {
      try {
        const skills = await listLibraries()
        return { success: true, skills }
      } catch (err) {
        console.error('[SkillLibrary] List failed:', err)
        return { success: false, skills: [], error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Add a library
  ipcMain.handle(
    'skill-library:add',
    async (
      _event,
      params: { zipPath: string; name: string; description: string; agentType: AgentType }
    ): Promise<{ success: boolean; library?: SkillLibrary; error?: string }> => {
      try {
        const library = await addLibrary(
          params.zipPath,
          params.name,
          params.description,
          params.agentType
        )
        return { success: true, library }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return { success: false, error: errorMessage }
      }
    }
  )

  // Update a library
  ipcMain.handle(
    'skill-library:update',
    async (
      _event,
      params: { id: string; name: string; description: string }
    ): Promise<{ success: boolean; library?: SkillLibrary; error?: string }> => {
      try {
        const library = await updateLibrary(params.id, params.name, params.description)
        return { success: true, library }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return { success: false, error: errorMessage }
      }
    }
  )

  // Delete a library
  ipcMain.handle(
    'skill-library:delete',
    async (_event, params: { id: string }): Promise<{ success: boolean; error?: string }> => {
      try {
        await deleteLibrary(params.id)
        return { success: true }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return { success: false, error: errorMessage }
      }
    }
  )

  // Download a library (get zip path)
  ipcMain.handle(
    'skill-library:download',
    async (_event, params: { id: string }): Promise<{ success: boolean; path?: string; error?: string }> => {
      try {
        const result = await downloadLibrary(params.id)
        return { success: true, path: result.path }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return { success: false, error: errorMessage }
      }
    }
  )

  // Validate a zip file
  ipcMain.handle(
    'skill-library:validate',
    async (_event, params: { zipPath: string }): Promise<SkillLibraryValidateResult> => {
      return await validateLibrary(params.zipPath)
    }
  )

  // Activate a library in a project
  ipcMain.handle(
    'skill-library:activate',
    async (
      _event,
      params: { id: string; projectPath: string }
    ): Promise<SkillLibraryActivateResult> => {
      return await activateLibrary(params.id, params.projectPath)
    }
  )

  console.log('[SkillLibrary] Handlers registered')
}
