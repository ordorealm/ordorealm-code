/**
 * WeClaw Binary Downloader
 * Downloads WeClaw binaries from GitHub Releases for offline packaging
 *
 * WeClaw is a WeChat AI Agent Bridge that connects WeChat to AI agents.
 * @see https://github.com/fastclaw-ai/weclaw
 *
 * @module builder/weclaw-downloader
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { execSync } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WeClawBinary {
  platform: 'darwin' | 'win32';
  arch: 'x64' | 'arm64';
  url: string;
  dest: string;
  executable: string;
}

interface DownloadProgress {
  current: number;
  total: number;
  percent: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

// WeClaw version to bundle
const WECLAW_VERSION = 'v0.7.1';

// GitHub Releases base URL
const GITHUB_RELEASES = 'https://github.com/fastclaw-ai/weclaw/releases/download';

// Base directory for WeClaw binaries
const WECLAW_DIR = path.join(__dirname, '..', 'runtime', 'weclaw');

// ─── Binary Definitions ─────────────────────────────────────────────────────

/**
 * WeClaw binaries for supported platforms
 * Only macOS and Windows as per user requirement
 */
const WECLAW_BINARIES: WeClawBinary[] = [
  // macOS x64 (Intel)
  {
    platform: 'darwin',
    arch: 'x64',
    url: `${GITHUB_RELEASES}/${WECLAW_VERSION}/weclaw_${WECLAW_VERSION}_darwin_amd64.tar.gz`,
    dest: path.join(WECLAW_DIR, 'darwin-x64'),
    executable: 'weclaw',
  },
  // macOS arm64 (Apple Silicon)
  {
    platform: 'darwin',
    arch: 'arm64',
    url: `${GITHUB_RELEASES}/${WECLAW_VERSION}/weclaw_${WECLAW_VERSION}_darwin_arm64.tar.gz`,
    dest: path.join(WECLAW_DIR, 'darwin-arm64'),
    executable: 'weclaw',
  },
  // Windows x64
  {
    platform: 'win32',
    arch: 'x64',
    url: `${GITHUB_RELEASES}/${WECLAW_VERSION}/weclaw_${WECLAW_VERSION}_windows_amd64.zip`,
    dest: path.join(WECLAW_DIR, 'win32-x64'),
    executable: 'weclaw.exe',
  },
];

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Download a file from URL with redirect support
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);

    const request = (urlString: string) => {
      https.get(urlString, (response) => {
        // Handle redirects (GitHub uses 302)
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(destPath);
            request(redirectUrl);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode} from ${urlString}`));
          return;
        }

        const total = parseInt(response.headers['content-length'] || '0', 10);
        let current = 0;

        response.on('data', (chunk) => {
          current += chunk.length;
          if (onProgress && total > 0) {
            onProgress({
              current,
              total,
              percent: Math.round((current / total) * 100),
            });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        if (fs.existsSync(destPath)) {
          fs.unlinkSync(destPath);
        }
        reject(err);
      });
    };

    request(url);
  });
}

/**
 * Extract a tar.gz file
 */
async function extractTarGz(
  tarGzPath: string,
  destDir: string,
): Promise<void> {
  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  // Extract using tar (cross-platform on Node.js 20+)
  execSync(
    `tar -xzf "${tarGzPath}" -C "${destDir}"`,
    { stdio: 'inherit' }
  );
}

/**
 * Extract a zip file
 */
async function extractZip(
  zipPath: string,
  destDir: string,
): Promise<void> {
  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  if (process.platform === 'win32') {
    // Use PowerShell on Windows
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    // Use unzip on macOS/Linux
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
  }
}

/**
 * Check if WeClaw binary already exists
 */
function weclawExists(destPath: string, executable: string): boolean {
  const exePath = path.join(destPath, executable);
  return fs.existsSync(exePath);
}

/**
 * Make binary executable (Unix)
 */
function makeExecutable(destPath: string, executable: string): void {
  if (process.platform !== 'win32') {
    const exePath = path.join(destPath, executable);
    if (fs.existsSync(exePath)) {
      fs.chmodSync(exePath, 0o755);
    }
  }
}

// ─── Main Download Function ──────────────────────────────────────────────────

/**
 * Download WeClaw binaries for specified platforms
 *
 * @param platform - Target platform ('darwin' | 'win32')
 * @param arch - Target architecture ('x64' | 'arm64')
 */
export async function downloadWeClaw(
  platform?: 'darwin' | 'win32',
  arch?: 'x64' | 'arm64'
): Promise<void> {
  console.log('========================================');
  console.log(`Downloading WeClaw ${WECLAW_VERSION} binaries`);
  console.log('========================================\n');

  // Filter binaries based on parameters or current platform
  const binaries = WECLAW_BINARIES.filter((binary) => {
    if (platform && arch) {
      return binary.platform === platform && binary.arch === arch;
    }
    // Download all for current platform
    if (process.platform === 'darwin') {
      return binary.platform === 'darwin';
    }
    if (process.platform === 'win32') {
      return binary.platform === 'win32';
    }
    // Download all if on different platform (for cross-build)
    return true;
  });

  for (const binary of binaries) {
    console.log(`\n📦 Processing: ${binary.platform}-${binary.arch}`);
    console.log(`   URL: ${binary.url}`);
    console.log(`   Destination: ${binary.dest}`);

    // Check if already exists
    if (weclawExists(binary.dest, binary.executable)) {
      console.log('   ✅ Already exists, skipping');
      continue;
    }

    // Create destination directory
    fs.mkdirSync(binary.dest, { recursive: true });

    // Download file
    const tempFile = path.join(WECLAW_DIR, path.basename(binary.url));
    console.log('   ⬇️  Downloading...');

    try {
      await downloadFile(binary.url, tempFile, (progress) => {
        if (progress.percent % 10 === 0 || progress.percent === 100) {
          console.log(`   ${progress.percent}% (${(progress.current / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB)`);
        }
      });

      console.log('   ✅ Download complete');

      // Extract
      console.log('   📦 Extracting...');
      if (binary.url.endsWith('.tar.gz')) {
        await extractTarGz(tempFile, binary.dest);
      } else if (binary.url.endsWith('.zip')) {
        await extractZip(tempFile, binary.dest);
      }
      console.log('   ✅ Extraction complete');

      // Make executable (Unix)
      makeExecutable(binary.dest, binary.executable);

      // Cleanup temp file
      fs.unlinkSync(tempFile);

    } catch (error) {
      console.error(`   ❌ Error: ${error}`);
      // Cleanup on error
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      throw error;
    }
  }

  console.log('\n========================================');
  console.log('✅ All WeClaw binaries downloaded successfully');
  console.log('========================================');
}

/**
 * Get the WeClaw binary path for the current platform
 */
export function getWeClawBinaryPath(): string | null {
  const platform = process.platform as 'darwin' | 'win32';
  const arch = process.arch as 'x64' | 'arm64';

  // Map Node.js arch to WeClaw arch names
  const archMap: Record<string, 'x64' | 'arm64'> = {
    x64: 'x64',
    arm64: 'arm64',
    amd64: 'x64',
    arm: 'arm64',
  };

  const mappedArch = archMap[arch] || 'x64';

  const binary = WECLAW_BINARIES.find(
    (b) => b.platform === platform && b.arch === mappedArch
  );

  if (!binary) {
    return null;
  }

  return path.join(binary.dest, binary.executable);
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

/**
 * Run when called directly
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let platform: 'darwin' | 'win32' | undefined;
  let arch: 'x64' | 'arm64' | undefined;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) {
      platform = args[i + 1] as 'darwin' | 'win32';
      i++;
    } else if (args[i] === '--arch' && args[i + 1]) {
      arch = args[i + 1] as 'x64' | 'arm64';
      i++;
    }
  }

  try {
    await downloadWeClaw(platform, arch);
    process.exit(0);
  } catch (error) {
    console.error('Failed to download WeClaw:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
