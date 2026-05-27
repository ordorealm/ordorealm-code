/**
 * WeClaw Process Manager
 *
 * Manages the WeClaw binary lifecycle: start, stop, status check.
 * This module handles the bundled WeClaw binary for WeChat remote control.
 *
 * @module main/services/weclaw-manager
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';
import { Logger } from '../utils/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WeClawManagerConfig {
  /** API address for WeClaw (default: 127.0.0.1:18011) */
  apiAddr?: string;
  /** Path to WeClaw binary (auto-detected if not specified) */
  binaryPath?: string;
  /** Enable debug logging */
  debug?: boolean;
}

export interface WeClawManagerStatus {
  /** Whether the WeClaw process is running */
  running: boolean;
  /** Whether logged in to WeChat */
  loggedIn: boolean;
  /** User ID if logged in */
  userId?: string;
  /** PID of the process */
  pid?: number;
  /** API address */
  apiAddr: string;
}

export interface WeClawCredentials {
  bot_token: string;
  ilink_bot_id: string;
  baseurl: string;
  ilink_user_id: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const WECLAW_DEFAULT_API_ADDR = '127.0.0.1:18011';
const WECLAW_PID_FILE = 'weclaw.pid';
const WECLAW_ACCOUNTS_DIR = '.weclaw/accounts';

// ─── WeClaw Manager Class ────────────────────────────────────────────────────

/**
 * WeClaw Process Manager
 *
 * Manages the bundled WeClaw binary for WeChat remote control functionality.
 */
export class WeClawManager {
  private config: Required<WeClawManagerConfig>;
  private process: ChildProcess | null = null;
  private logger: Logger;
  private pidFilePath: string;
  private accountsDir: string;

  constructor(config?: WeClawManagerConfig) {
    this.config = {
      apiAddr: config?.apiAddr ?? WECLAW_DEFAULT_API_ADDR,
      binaryPath: config?.binaryPath ?? this.detectBinaryPath(),
      debug: config?.debug ?? false,
    };

    this.logger = new Logger('WeClawManager', {
      enabled: true,
      level: this.config.debug ? 'debug' : 'info',
    });

    // Set up paths
    const homeDir = os.homedir();
    this.pidFilePath = path.join(homeDir, '.weclaw', WECLAW_PID_FILE);
    this.accountsDir = path.join(homeDir, WECLAW_ACCOUNTS_DIR);

    this.logger.info('WeClaw Manager initialized');
    this.logger.debug(`Binary path: ${this.config.binaryPath}`);
    this.logger.debug(`API address: ${this.config.apiAddr}`);
  }

  /**
   * Detect the WeClaw binary path based on platform
   */
  private detectBinaryPath(): string {
    // In production, binary is bundled in resources/runtime/weclaw/
    // In development, check electron/runtime/weclaw/

    const platform = process.platform;
    const arch = process.arch;

    // Platform-arch mapping
    const platformDir = platform === 'darwin'
      ? `darwin-${arch === 'arm64' ? 'arm64' : 'x64'}`
      : `win32-x64`;

    const executable = platform === 'darwin' ? 'weclaw' : 'weclaw.exe';

    // Production path (bundled) - check if resourcesPath exists
    const prodPath = process.resourcesPath
      ? path.join(process.resourcesPath, 'runtime', 'weclaw', platformDir, executable)
      : '';

    // Development paths - check multiple possible locations
    // 1. From compiled out/main/ directory (electron-vite build)
    const devPathFromOut = path.join(
      __dirname,
      '..',
      '..',
      'electron',
      'runtime',
      'weclaw',
      platformDir,
      executable
    );

    // 2. Direct from project root (when running with tsx or from src/)
    const devPathFromCwd = path.join(
      process.cwd(),
      'electron',
      'runtime',
      'weclaw',
      platformDir,
      executable
    );

    // 3. From app path (Electron app.getAppPath())
    // Note: app.getAppPath() works even before app is ready, so we don't need isReady() check
    let devPathFromApp: string | null = null;
    try {
      // Dynamic import to avoid error when app is not available
      const { app } = require('electron');
      if (app) {
        // app.getAppPath() works even before app is ready in development mode
        devPathFromApp = path.join(
          app.getAppPath(),
          'electron',
          'runtime',
          'weclaw',
          platformDir,
          executable
        );
      }
    } catch {
      // app not available, skip
    }

    // Log all paths for debugging
    this.logger.debug('WeClaw binary path detection:');
    this.logger.debug(`  Platform: ${platform}, Arch: ${arch}`);
    if (prodPath) {
      this.logger.debug(`  Production path: ${prodPath} (exists: ${fs.existsSync(prodPath)})`);
    }
    this.logger.debug(`  Dev path (from out): ${devPathFromOut} (exists: ${fs.existsSync(devPathFromOut)})`);
    this.logger.debug(`  Dev path (from cwd): ${devPathFromCwd} (exists: ${fs.existsSync(devPathFromCwd)})`);
    if (devPathFromApp) {
      this.logger.debug(`  Dev path (from app): ${devPathFromApp} (exists: ${fs.existsSync(devPathFromApp)})`);
    }

    // Check production path first (only if valid)
    if (prodPath && fs.existsSync(prodPath)) {
      this.logger.info(`Using production WeClaw binary: ${prodPath}`);
      return prodPath;
    }

    // Check development paths in order
    if (fs.existsSync(devPathFromOut)) {
      this.logger.info(`Using dev WeClaw binary (from out): ${devPathFromOut}`);
      return devPathFromOut;
    }

    if (fs.existsSync(devPathFromCwd)) {
      this.logger.info(`Using dev WeClaw binary (from cwd): ${devPathFromCwd}`);
      return devPathFromCwd;
    }

    if (devPathFromApp && fs.existsSync(devPathFromApp)) {
      this.logger.info(`Using dev WeClaw binary (from app): ${devPathFromApp}`);
      return devPathFromApp;
    }

    // Fall back to system PATH
    this.logger.warn(`WeClaw binary not found in any known location, falling back to system PATH`);
    return executable;
  }

  /**
   * Check if WeClaw binary exists
   */
  isBinaryAvailable(): boolean {
    if (this.config.binaryPath === 'weclaw' || this.config.binaryPath === 'weclaw.exe') {
      // System PATH binary - check if command exists using execSync
      try {
        execSync(`which ${this.config.binaryPath}`, { timeout: 5000, stdio: 'pipe' });
        return true;
      } catch {
        // On Windows, use 'where' command instead
        if (process.platform === 'win32') {
          try {
            execSync(`where ${this.config.binaryPath}`, { timeout: 5000, stdio: 'pipe' });
            return true;
          } catch {
            return false;
          }
        }
        return false;
      }
    }
    return fs.existsSync(this.config.binaryPath);
  }

  /**
   * Get the current binary path
   * Useful for error messages and debugging
   */
  getBinaryPath(): string {
    return this.config.binaryPath;
  }

  /**
   * Start WeClaw daemon
   *
   * @returns Promise resolving to true if started successfully
   */
  async start(): Promise<boolean> {
    // Check if already running
    const status = await this.getStatus();
    if (status.running) {
      this.logger.info('WeClaw already running');
      return true;
    }

    // Check binary availability
    if (!this.isBinaryAvailable()) {
      this.logger.error('WeClaw binary not found');
      throw new Error('WeClaw binary not found. Please ensure WeClaw is installed.');
    }

    this.logger.info('Starting WeClaw daemon...');

    return new Promise((resolve, reject) => {
      try {
        // Start WeClaw in daemon mode
        this.process = spawn(
          this.config.binaryPath,
          ['start', '--api-addr', this.config.apiAddr],
          {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }
        );

        // Detach to let it run independently
        this.process.unref();

        // WeClaw daemon starts independently - the HTTP API is only available
        // after user scans QR code and logs in. We just verify the process started.
        // Give it a moment to spawn and create PID file
        setTimeout(async () => {
          // Check if process spawned (via PID file as fallback)
          if (fs.existsSync(this.pidFilePath)) {
            try {
              const pidContent = fs.readFileSync(this.pidFilePath, 'utf-8').trim();
              const pid = parseInt(pidContent, 10);
              if (!isNaN(pid)) {
                this.logger.info(`WeClaw daemon started (PID: ${pid})`);
                resolve(true);
                return;
              }
            } catch {
              // Ignore read errors
            }
          }

          // Even without PID file, the daemon may have started
          // The spawn succeeded, so assume it's running
          this.logger.info('WeClaw daemon start command executed');
          resolve(true);
        }, 1000); // Wait 1 second for daemon to initialize

      } catch (error) {
        this.logger.error('Failed to start WeClaw:', error);
        reject(error);
      }
    });
  }

  /**
   * Stop WeClaw daemon
   *
   * @returns Promise resolving to true if stopped successfully
   */
  async stop(): Promise<boolean> {
    const status = await this.getStatus();
    if (!status.running) {
      this.logger.info('WeClaw not running');
      return true;
    }

    this.logger.info('Stopping WeClaw daemon...');

    return new Promise((resolve, reject) => {
      try {
        // Use WeClaw's stop command
        const stopProcess = spawn(
          this.config.binaryPath,
          ['stop'],
          {
            timeout: 10000,
          }
        );

        stopProcess.on('close', (code) => {
          if (code === 0) {
            this.logger.info('WeClaw stopped successfully');
            this.process = null;
            resolve(true);
          } else {
            this.logger.warn(`WeClaw stop returned code ${code}`);
            resolve(false);
          }
        });

        stopProcess.on('error', (error) => {
          this.logger.error('Failed to stop WeClaw:', error);
          reject(error);
        });

      } catch (error) {
        this.logger.error('Failed to stop WeClaw:', error);
        reject(error);
      }
    });
  }

  /**
   * Get WeClaw status
   *
   * Uses multiple detection methods:
   * 1. Health endpoint (HTTP)
   * 2. PID file check
   * 3. Credentials file check for login status
   */
  async getStatus(): Promise<WeClawManagerStatus> {
    const status: WeClawManagerStatus = {
      running: false,
      loggedIn: false,
      apiAddr: this.config.apiAddr,
    };

    // Method 1: Check health endpoint
    try {
      const response = await fetch(`http://${this.config.apiAddr}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        status.running = true;
        this.logger.debug('WeClaw health check passed');
      }
    } catch (error) {
      this.logger.debug('WeClaw health check failed:', error);
    }

    // Method 2: Check PID file (fallback)
    if (!status.running && fs.existsSync(this.pidFilePath)) {
      try {
        const pidContent = fs.readFileSync(this.pidFilePath, 'utf-8').trim();
        const pid = parseInt(pidContent, 10);

        if (!isNaN(pid)) {
          // Check if process is running
          try {
            process.kill(pid, 0); // Signal 0 doesn't kill, just checks
            status.running = true;
            status.pid = pid;
            this.logger.debug(`WeClaw process found via PID file: ${pid}`);
          } catch {
            // Process not running, clean up stale PID file
            this.logger.debug('Stale PID file found, cleaning up');
            fs.unlinkSync(this.pidFilePath);
          }
        }
      } catch (error) {
        this.logger.debug('Failed to read PID file:', error);
      }
    }

    // Method 3: Check credentials for login status
    if (status.running) {
      const credentials = this.loadCredentials();
      if (credentials) {
        status.loggedIn = true;
        status.userId = credentials.ilink_user_id;
        this.logger.debug(`WeClaw logged in as: ${credentials.ilink_user_id}`);
      }
    }

    return status;
  }

  /**
   * Load stored WeClaw credentials
   *
   * @returns Credentials object or null if not found
   */
  loadCredentials(): WeClawCredentials | null {
    // WeClaw stores credentials in ~/.weclaw/accounts/{id}.json
    const weclawDir = path.dirname(this.pidFilePath);
    const accountsDir = path.join(weclawDir, 'accounts');

    if (!fs.existsSync(accountsDir)) {
      return null;
    }

    try {
      const files = fs.readdirSync(accountsDir);
      const jsonFile = files.find(f => f.endsWith('.json'));

      if (!jsonFile) {
        return null;
      }

      const filePath = path.join(accountsDir, jsonFile);
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as WeClawCredentials;

    } catch (error) {
      this.logger.error('Failed to load credentials:', error);
      return null;
    }
  }

  /**
   * Get QR code URL for WeChat login
   *
   * @returns QR code image URL
   */
  async getQRCodeUrl(): Promise<string> {
    // WeClaw uses iLink API for QR code
    // The QR code is displayed in the WeClaw terminal
    // We can fetch it from the iLink API directly
    return 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3';
  }

  /**
   * Start WeClaw login process and return QR URL
   *
   * This method runs `weclaw login` and captures the QR URL from stdout.
   * The QR URL can be displayed to the user for WeChat scanning.
   *
   * @returns QR code URL for WeChat scan
   * @throws Error if login fails or QR URL not found
   */
  async startLogin(): Promise<string> {
    // Check binary availability
    if (!this.isBinaryAvailable()) {
      this.logger.error('WeClaw binary not found');
      throw new Error('WeClaw binary not found. Please ensure WeClaw is installed.');
    }

    this.logger.info('Starting WeClaw login process...');

    return new Promise((resolve, reject) => {
      try {
        const loginProcess = spawn(
          this.config.binaryPath,
          ['login'],
          {
            timeout: 30000, // 30 seconds to get QR code
          }
        );

        let output = '';
        let resolved = false;

        loginProcess.stdout.on('data', (data) => {
          output += data.toString();
          this.logger.debug(`WeClaw stdout: ${data.toString().trim()}`);

          // Parse QR URL from output
          // Format: QR URL: https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=...&bot_type=3
          const qrUrlMatch = output.match(/QR URL: (https:\/\/[^\s]+)/);
          if (qrUrlMatch && !resolved) {
            resolved = true;
            this.logger.info(`QR URL captured: ${qrUrlMatch[1]}`);
            resolve(qrUrlMatch[1]);
          }
        });

        loginProcess.stderr.on('data', (data) => {
          output += data.toString();
          this.logger.debug(`WeClaw stderr: ${data.toString().trim()}`);
        });

        loginProcess.on('error', (error) => {
          this.logger.error('WeClaw login process error:', error);
          if (!resolved) {
            resolved = true;
            reject(error);
          }
        });

        loginProcess.on('close', (code) => {
          // If we haven't resolved yet, check if we found a QR URL
          if (!resolved) {
            if (code === 0 || output.includes('QR URL:')) {
              // Try to extract QR URL one more time
              const qrUrlMatch = output.match(/QR URL: (https:\/\/[^\s]+)/);
              if (qrUrlMatch) {
                this.logger.info(`QR URL captured on close: ${qrUrlMatch[1]}`);
                resolve(qrUrlMatch[1]);
              } else {
                // Login completed without QR URL (might be already logged in)
                this.logger.info('WeClaw login completed without QR URL');
                resolve('');
              }
            } else {
              this.logger.error(`WeClaw login failed with code ${code}`);
              reject(new Error(`WeClaw login failed with code ${code}. Output: ${output}`));
            }
          }
        });

      } catch (error) {
        this.logger.error('Failed to start WeClaw login:', error);
        reject(error);
      }
    });
  }

  /**
   * Restart WeClaw daemon
   */
  async restart(): Promise<boolean> {
    await this.stop();
    // Wait for process to fully stop
    await new Promise(resolve => setTimeout(resolve, 2000));
    return this.start();
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    // Note: We don't stop the daemon here as it should run independently
    this.process = null;
    this.logger.info('WeClaw Manager cleaned up');
  }
}

// ─── Factory Function ────────────────────────────────────────────────────────

let instance: WeClawManager | null = null;

/**
 * Get the singleton WeClaw Manager instance
 */
export function getWeClawManager(config?: WeClawManagerConfig): WeClawManager {
  if (!instance) {
    instance = new WeClawManager(config);
  }
  return instance;
}

/**
 * Initialize WeClaw Manager
 */
export function initWeClawManager(config?: WeClawManagerConfig): WeClawManager {
  instance = new WeClawManager(config);
  return instance;
}
