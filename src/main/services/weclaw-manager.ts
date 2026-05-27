/**
 * WeClaw Process Manager
 *
 * Manages the WeClaw binary lifecycle: start, stop, status check.
 * This module handles the bundled WeClaw binary for WeChat remote control.
 *
 * @module main/services/weclaw-manager
 */

import { spawn, ChildProcess } from 'child_process';
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

export interface WeClawStatus {
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

    // Production path (bundled)
    const prodPath = path.join(
      process.resourcesPath,
      'runtime',
      'weclaw',
      platformDir,
      executable
    );

    // Development path
    const devPath = path.join(
      __dirname,
      '..',
      '..',
      'electron',
      'runtime',
      'weclaw',
      platformDir,
      executable
    );

    // Check production path first
    if (fs.existsSync(prodPath)) {
      return prodPath;
    }

    // Fall back to development path
    if (fs.existsSync(devPath)) {
      return devPath;
    }

    // Fall back to system PATH
    return executable;
  }

  /**
   * Check if WeClaw binary exists
   */
  isBinaryAvailable(): boolean {
    if (this.config.binaryPath === 'weclaw' || this.config.binaryPath === 'weclaw.exe') {
      // System PATH binary - check if command exists
      try {
        const result = spawn(this.config.binaryPath, ['--version'], {
          timeout: 5000,
        });
        return result.pid !== undefined;
      } catch {
        return false;
      }
    }
    return fs.existsSync(this.config.binaryPath);
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

        // Wait a bit for the process to start
        setTimeout(async () => {
          const newStatus = await this.getStatus();
          if (newStatus.running) {
            this.logger.info(`WeClaw started successfully (PID: ${newStatus.pid})`);
            resolve(true);
          } else {
            this.logger.error('WeClaw failed to start');
            reject(new Error('WeClaw failed to start'));
          }
        }, 2000);

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
  async getStatus(): Promise<WeClawStatus> {
    const status: WeClawStatus = {
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
