/**
 * Runtime Manager
 * Manages bundled runtime dependencies (Node.js, Git) for offline operation
 *
 * On first launch, copies runtimes from app resources to user data directory.
 * Provides paths to Node.js and Git executables for use by adapters.
 *
 * @module main/runtime-manager
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Runtime environment configuration */
export interface RuntimeEnvConfig {
  /** Path to Node.js executable */
  nodePath: string;
  /** Path to npm executable (or npx) */
  npmPath: string;
  /** Path to Git executable */
  gitPath: string;
  /** Path to Bash shell (Windows: Git Bash, macOS/Linux: system bash) */
  bashPath: string;
  /** Shell to use for command execution */
  shell: string;
  /** PATH environment variable with runtime paths prepended */
  pathEnv: string;
}

/** Runtime initialization result */
export interface RuntimeInitResult {
  /** Whether this is the first launch (runtime was just extracted) */
  isFirstLaunch: boolean;
  /** The runtime environment configuration */
  envConfig: RuntimeEnvConfig;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Version marker file name */
const VERSION_MARKER = '.runtime-version';

/** Current runtime version (update when upgrading bundled runtimes) */
const RUNTIME_VERSION = '1.0.0';

/** Subdirectory name in userData for runtime extraction */
const RUNTIME_SUBDIR = 'runtime';

// ─── Runtime Manager Class ──────────────────────────────────────────────────

export class RuntimeManager {
  /** Path to bundled runtimes in app resources */
  private readonly resourcesRuntimeDir: string;

  /** Path to extracted runtimes in user data */
  private readonly userDataRuntimeDir: string;

  /** Cached environment config */
  private cachedEnvConfig: RuntimeEnvConfig | null = null;

  constructor() {
    // In packaged app: process.resourcesPath points to Resources/ (macOS) or resources/ (Windows)
    // In dev mode: falls back to electron/runtime/
    this.resourcesRuntimeDir = app.isPackaged
      ? path.join(process.resourcesPath, 'runtime')
      : path.join(__dirname, '..', 'runtime');

    // User data directory for runtime extraction
    this.userDataRuntimeDir = path.join(app.getPath('userData'), RUNTIME_SUBDIR);

    console.log('[RuntimeManager] Resources dir:', this.resourcesRuntimeDir);
    console.log('[RuntimeManager] User data dir:', this.userDataRuntimeDir);
  }

  // ── Public Interface ───────────────────────────────────────────────────────

  /**
   * Initialize runtime environment
   * Copies bundled runtimes to user data directory on first launch
   */
  async initialize(): Promise<RuntimeInitResult> {
    console.log('[RuntimeManager] Initializing...');

    // Check if runtime needs to be extracted
    const needsExtraction = this.needsExtraction();
    let isFirstLaunch = false;

    if (needsExtraction) {
      console.log('[RuntimeManager] First launch or version mismatch, extracting runtimes...');
      await this.extractRuntimes();
      isFirstLaunch = true;
    } else {
      console.log('[RuntimeManager] Runtimes already extracted, skipping');
    }

    // Build environment config
    const envConfig = this.buildEnvConfig();
    this.cachedEnvConfig = envConfig;

    // Validate runtimes exist
    this.validateRuntimes(envConfig);

    console.log('[RuntimeManager] Initialization complete');
    console.log('[RuntimeManager] Node.js:', envConfig.nodePath);
    console.log('[RuntimeManager] Git:', envConfig.gitPath);
    console.log('[RuntimeManager] Shell:', envConfig.shell);

    return { isFirstLaunch, envConfig };
  }

  /**
   * Get runtime environment configuration
   * Must call initialize() first
   */
  getEnvConfig(): RuntimeEnvConfig {
    if (!this.cachedEnvConfig) {
      throw new Error('[RuntimeManager] Not initialized. Call initialize() first.');
    }
    return this.cachedEnvConfig;
  }

  /**
   * Get Node.js executable path
   */
  getNodePath(): string {
    return this.getEnvConfig().nodePath;
  }

  /**
   * Get Git executable path
   */
  getGitPath(): string {
    return this.getEnvConfig().gitPath;
  }

  /**
   * Get Bash shell path
   */
  getBashPath(): string {
    return this.getEnvConfig().bashPath;
  }

  /**
   * Build PATH environment variable with runtime paths
   */
  getPathEnv(): string {
    return this.getEnvConfig().pathEnv;
  }

  /**
   * Get runtime directory path in user data
   */
  getRuntimeDir(): string {
    return this.userDataRuntimeDir;
  }

  /**
   * Clean up extracted runtimes
   */
  async cleanup(): Promise<void> {
    console.log('[RuntimeManager] Cleaning up runtimes...');
    if (fs.existsSync(this.userDataRuntimeDir)) {
      fs.rmSync(this.userDataRuntimeDir, { recursive: true });
    }
    this.cachedEnvConfig = null;
  }

  // ── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Get runtime target directory name
   * Maps process.platform to directory naming convention:
   * - win32 -> win (Node.js uses 'win-x64', not 'win32-x64')
   * - darwin -> darwin (no change)
   */
  private getRuntimeTargetName(platform: string, arch: string): string {
    const platformName = platform === 'win32' ? 'win' : platform;
    return `${platformName}-${arch}`;
  }

  /**
   * Check if runtime needs to be extracted
   */
  private needsExtraction(): boolean {
    const markerPath = path.join(this.userDataRuntimeDir, VERSION_MARKER);

    // No marker file = first launch
    if (!fs.existsSync(markerPath)) {
      return true;
    }

    // Check version
    try {
      const currentVersion = fs.readFileSync(markerPath, 'utf8').trim();
      return currentVersion !== RUNTIME_VERSION;
    } catch {
      return true;
    }
  }

  /**
   * Extract bundled runtimes to user data directory
   */
  private async extractRuntimes(): Promise<void> {
    // Create target directory
    fs.mkdirSync(this.userDataRuntimeDir, { recursive: true });

    // Check if source runtime directory exists
    if (!fs.existsSync(this.resourcesRuntimeDir)) {
      console.warn('[RuntimeManager] No bundled runtimes found at:', this.resourcesRuntimeDir);
      console.warn('[RuntimeManager] Falling back to system runtimes');
      this.writeVersionMarker();
      return;
    }

    // Copy runtime files
    const platform = process.platform;
    const arch = process.arch;

    // Copy Node.js (use mapped target name for directory)
    const nodeTarget = this.getRuntimeTargetName(platform, arch);
    await this.copyRuntimeComponent('node', nodeTarget);

    // Copy Git (Windows only, uses 'win-x64' naming)
    if (platform === 'win32') {
      await this.copyRuntimeComponent('git', 'win-x64');
    }

    // Write version marker
    this.writeVersionMarker();
  }

  /**
   * Copy a runtime component from resources to user data
   * @param component - Component name (e.g., 'node', 'git')
   * @param targetName - Target directory name (e.g., 'darwin-arm64', 'win-x64')
   */
  private async copyRuntimeComponent(
    component: string,
    targetName: string
  ): Promise<void> {
    const sourceDir = path.join(this.resourcesRuntimeDir, component, targetName);
    const targetDir = path.join(this.userDataRuntimeDir, component, targetName);

    if (!fs.existsSync(sourceDir)) {
      console.warn(`[RuntimeManager] ${component} runtime not found: ${sourceDir}`);
      return;
    }

    console.log(`[RuntimeManager] Copying ${component}: ${sourceDir} -> ${targetDir}`);

    // Remove old version
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true });
    }

    // Copy directory
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });

    // Make binaries executable (macOS/Linux)
    if (process.platform !== 'win32') {
      this.makeBinariesExecutable(targetDir);
    }

    console.log(`[RuntimeManager] ${component} copied successfully`);
  }

  /**
   * Make all files in bin/ directories executable
   */
  private makeBinariesExecutable(dir: string): void {
    const binDir = path.join(dir, 'bin');
    if (!fs.existsSync(binDir)) return;

    const entries = fs.readdirSync(binDir);
    for (const entry of entries) {
      const filePath = path.join(binDir, entry);
      try {
        fs.chmodSync(filePath, 0o755);
      } catch (err) {
        console.warn(`[RuntimeManager] Failed to chmod ${filePath}:`, err);
      }
    }
  }

  /**
   * Write version marker file
   */
  private writeVersionMarker(): void {
    const markerPath = path.join(this.userDataRuntimeDir, VERSION_MARKER);
    fs.writeFileSync(markerPath, RUNTIME_VERSION, 'utf8');
  }

  /**
   * Build runtime environment configuration
   */
  private buildEnvConfig(): RuntimeEnvConfig {
    const platform = process.platform;
    const arch = process.arch;
    // Use mapped target name for directory lookup
    const target = this.getRuntimeTargetName(platform, arch);

    // Determine Node.js path
    const nodeDir = path.join(this.userDataRuntimeDir, 'node', target);
    const nodePath = this.findExecutable(nodeDir, 'node');

    // Determine npm path
    const npmPath = this.findExecutable(nodeDir, 'npm');

    // Determine Git path
    const gitPath = this.findGitPath(platform, arch);

    // Determine Bash path
    const bashPath = this.findBashPath(platform, arch);

    // Determine shell
    const shell = this.findShell(platform, bashPath);

    // Build PATH
    const pathEnv = this.buildPathEnv(nodeDir, gitPath, bashPath);

    return {
      nodePath,
      npmPath,
      gitPath,
      bashPath,
      shell,
      pathEnv,
    };
  }

  /**
   * Find an executable in a directory
   */
  private findExecutable(dir: string, name: string): string {
    // Check if directory exists
    if (!fs.existsSync(dir)) {
      // Fall back to system path
      return this.findSystemExecutable(name);
    }

    // Try direct path
    if (process.platform === 'win32') {
      // Windows: check in root and bin
      const candidates = [
        path.join(dir, `${name}.exe`),
        path.join(dir, `${name}.cmd`),
        path.join(dir, 'bin', `${name}.exe`),
        path.join(dir, 'bin', `${name}.cmd`),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } else {
      // macOS/Linux: check in bin
      const candidates = [
        path.join(dir, 'bin', name),
        path.join(dir, name),
      ];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    // Fall back to system path
    return this.findSystemExecutable(name);
  }

  /**
   * Find Git executable path
   */
  private findGitPath(platform: string, _arch: string): string {
    if (platform === 'win32') {
      // Windows: use bundled MinGit
      const gitDir = path.join(this.userDataRuntimeDir, 'git', 'win-x64');
      const gitExe = path.join(gitDir, 'cmd', 'git.exe');
      if (fs.existsSync(gitExe)) {
        return gitExe;
      }
      // Fallback: check mingw/bin
      const gitBin = path.join(gitDir, 'mingw64', 'bin', 'git.exe');
      if (fs.existsSync(gitBin)) {
        return gitBin;
      }
    }

    // macOS/Linux: use system Git
    return this.findSystemExecutable('git');
  }

  /**
   * Find Bash shell path
   */
  private findBashPath(platform: string, _arch: string): string {
    if (platform === 'win32') {
      // Windows: use Git Bash from PortableGit
      const gitDir = path.join(this.userDataRuntimeDir, 'git', 'win-x64');

      // PortableGit has bash.exe in multiple locations
      // Priority: bin/bash.exe (main), usr/bin/bash.exe (fallback)
      const bashLocations = [
        path.join(gitDir, 'bin', 'bash.exe'),
        path.join(gitDir, 'usr', 'bin', 'bash.exe'),
      ];

      for (const bashPath of bashLocations) {
        if (fs.existsSync(bashPath)) {
          return bashPath;
        }
      }
    }

    // macOS/Linux: use system bash
    return this.findSystemExecutable('bash');
  }

  /**
   * Find shell for command execution
   */
  private findShell(platform: string, bashPath: string): string {
    if (platform === 'win32') {
      // Windows: prefer Git Bash
      if (bashPath && fs.existsSync(bashPath)) {
        return bashPath;
      }
      // Fallback to PowerShell
      return 'powershell.exe';
    }

    // macOS: use zsh if available, otherwise bash
    const zshPath = '/bin/zsh';
    if (fs.existsSync(zshPath)) {
      return zshPath;
    }
    return '/bin/bash';
  }

  /**
   * Build PATH environment variable with runtime paths prepended
   */
  private buildPathEnv(nodeDir: string, gitPath: string, bashPath: string): string {
    const paths: string[] = [];

    // Add Node.js directory
    if (fs.existsSync(nodeDir)) {
      const nodeBin = path.join(nodeDir, 'bin');
      if (fs.existsSync(nodeBin)) {
        paths.push(nodeBin);
      } else {
        paths.push(nodeDir);
      }
    }

    // Add Git directory
    if (gitPath) {
      paths.push(path.dirname(gitPath));
    }

    // Add Bash directory (contains other useful tools like sh, etc.)
    if (bashPath) {
      const bashDir = path.dirname(bashPath);
      if (!paths.includes(bashDir)) {
        paths.push(bashDir);
      }
    }

    // Add system PATH (Windows: use triple fallback, macOS/Linux: use process.env)
    const systemPath = process.platform === 'win32'
      ? this.getWindowsSystemPath()
      : (process.env.PATH || '');
    paths.push(systemPath);

    return paths.join(path.delimiter);
  }

  /**
   * Get Windows system PATH with triple fallback
   * Priority: Registry → CMD → process.env.PATH
   */
  private getWindowsSystemPath(): string {
    const { execSync } = require('child_process');

    // Method 1: Read from Windows Registry (most reliable)
    try {
      const regPaths: string[] = [];
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const regExe = `${systemRoot}\\System32\\reg.exe`;

      // System-level PATH (HKLM)
      try {
        const systemResult = execSync(
          `"${regExe}" query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v PATH`,
          { encoding: 'utf8', timeout: 5000 }
        );
        const systemPath = this.parseRegPathOutput(systemResult);
        if (systemPath) {
          regPaths.push(systemPath);
        }
      } catch { /* ignore */ }

      // User-level PATH (HKCU)
      try {
        const userResult = execSync(
          `"${regExe}" query "HKCU\\Environment" /v PATH`,
          { encoding: 'utf8', timeout: 5000 }
        );
        const userPath = this.parseRegPathOutput(userResult);
        if (userPath) {
          regPaths.push(userPath);
        }
      } catch { /* ignore */ }

      if (regPaths.length > 0) {
        // Expand environment variables (e.g., %USERPROFILE%, %SystemRoot%)
        const full = this.expandEnvVars(regPaths.join(';'));
        console.log('[RuntimeManager] Windows PATH from registry, length:', full.length);
        return full;
      }
    } catch (err) {
      console.warn('[RuntimeManager] Registry method failed:', err);
    }

    // Method 2: Get from CMD (fallback)
    try {
      const cmdPath = execSync(
        'cmd /c "echo %PATH%"',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (cmdPath && cmdPath.length > 0) {
        console.log('[RuntimeManager] Windows PATH from CMD, length:', cmdPath.length);
        return cmdPath;
      }
    } catch (err) {
      console.warn('[RuntimeManager] CMD method failed:', err);
    }

    // Method 3: Fallback to process.env.PATH
    console.log('[RuntimeManager] Using process.env.PATH as fallback');
    return process.env.PATH || '';
  }

  /**
   * Parse reg.exe output to extract PATH value
   * Handles different output formats across Windows versions
   */
  private parseRegPathOutput(output: string): string | null {
    // Remove line breaks for easier parsing
    const normalized = output.replace(/\r?\n/g, ' ').trim();

    // Pattern 1: Standard format "PATH    REG_SZ    value" or "PATH    REG_EXPAND_SZ    value"
    // The value may contain spaces and special characters
    const match1 = normalized.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+?)(?:\s*$|\s{2,})/i);
    if (match1 && match1[1]) {
      return match1[1].trim();
    }

    // Pattern 2: Alternative format with different spacing
    const match2 = normalized.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
    if (match2 && match2[1]) {
      // Remove trailing whitespace or control characters
      return match2[1].trim();
    }

    return null;
  }

  /**
   * Expand Windows environment variables in a path string
   * E.g., %USERPROFILE%\bin -> C:\Users\username\bin
   */
  private expandEnvVars(pathStr: string): string {
    // Common environment variables to expand
    const envVars: Record<string, string> = {
      '%USERPROFILE%': process.env.USERPROFILE || '',
      '%SystemRoot%': process.env.SystemRoot || 'C:\\Windows',
      '%ProgramFiles%': process.env.ProgramFiles || 'C:\\Program Files',
      '%ProgramFiles(x86)%': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      '%APPDATA%': process.env.APPDATA || '',
      '%LOCALAPPDATA%': process.env.LOCALAPPDATA || '',
      '%ProgramData%': process.env.ProgramData || 'C:\\ProgramData',
      '%COMSPEC%': process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe',
    };

    let result = pathStr;
    for (const [varName, varValue] of Object.entries(envVars)) {
      if (varValue) {
        // Case-insensitive replacement
        const regex = new RegExp(varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        result = result.replace(regex, varValue);
      }
    }

    return result;
  }

  /**
   * Find system executable using which/where
   */
  private findSystemExecutable(name: string): string {
    try {
      const { execSync } = require('child_process');
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
      return result.trim().split(/\r?\n/)[0].trim();
    } catch {
      // Return just the name and hope it's in PATH
      return process.platform === 'win32' ? `${name}.exe` : name;
    }
  }

  /**
   * Validate that critical runtimes exist
   */
  private validateRuntimes(envConfig: RuntimeEnvConfig): void {
    // Node.js is critical
    if (!fs.existsSync(envConfig.nodePath)) {
      console.error(`[RuntimeManager] ⚠️ Node.js not found at: ${envConfig.nodePath}`);
      console.error('[RuntimeManager] Falling back to system Node.js');
    }

    // Git is important but not critical on macOS (system Git usually available)
    if (!fs.existsSync(envConfig.gitPath)) {
      console.warn(`[RuntimeManager] ⚠️ Git not found at: ${envConfig.gitPath}`);
      if (process.platform === 'win32') {
        console.error('[RuntimeManager] Git is required on Windows');
      }
    }
  }
}
