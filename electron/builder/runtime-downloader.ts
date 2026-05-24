/**
 * Runtime Downloader
 * Downloads Node.js and Git runtimes from Chinese mirrors for offline packaging
 * @module builder/runtime-downloader
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RuntimeSource {
  url: string;
  dest: string;
  extract?: boolean;
  stripComponents?: number;
}

interface DownloadProgress {
  current: number;
  total: number;
  percent: number;
}

// ─── Configuration ───────────────────────────────────────────────────────────

// Chinese mirror sources for faster downloads
const MIRRORS = {
  node: 'https://npmmirror.com/mirrors/node',
  git: 'https://npmmirror.com/mirrors/git-for-windows',
};

// Node.js version to bundle
const NODE_VERSION = 'v20.11.0';

// Git version to bundle
const GIT_VERSION = 'v2.43.0.windows.1';

// Base directory for runtime storage
const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');

// ─── Runtime Definitions ─────────────────────────────────────────────────────

const RUNTIME_SOURCES: RuntimeSource[] = [
  // Node.js for Windows x64
  {
    url: `${MIRRORS.node}/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`,
    dest: path.join(RUNTIME_DIR, 'node', 'win-x64'),
    extract: true,
    stripComponents: 1,
  },
  // Node.js for macOS x64
  {
    url: `${MIRRORS.node}/${NODE_VERSION}/node-${NODE_VERSION}-darwin-x64.tar.gz`,
    dest: path.join(RUNTIME_DIR, 'node', 'darwin-x64'),
    extract: true,
    stripComponents: 1,
  },
  // Node.js for macOS arm64
  {
    url: `${MIRRORS.node}/${NODE_VERSION}/node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    dest: path.join(RUNTIME_DIR, 'node', 'darwin-arm64'),
    extract: true,
    stripComponents: 1,
  },
  // MinGit for Windows x64 (no GUI, command-line only)
  {
    url: `${MIRRORS.git}/${GIT_VERSION}/MinGit-2.43.0-64-bit.zip`,
    dest: path.join(RUNTIME_DIR, 'git', 'win-x64'),
    extract: true,
    stripComponents: 0,
  },
];

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Download a file from URL
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
        // Handle redirects
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
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
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
        fs.unlinkSync(destPath);
        reject(err);
      });
    };

    request(url);
  });
}

/**
 * Extract a zip file (using built-in unzip on macOS/Linux, PowerShell on Windows)
 */
async function extractZip(
  zipPath: string,
  destDir: string,
  stripComponents: number = 0
): Promise<void> {
  const { execSync } = await import('child_process');

  // Create temp extraction directory
  const tempDir = path.join(destDir, '.temp-extract');
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    if (process.platform === 'win32') {
      // Use PowerShell on Windows
      execSync(
        `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}' -Force"`,
        { stdio: 'inherit' }
      );
    } else {
      // Use unzip on macOS/Linux
      execSync(`unzip -o "${zipPath}" -d "${tempDir}"`, { stdio: 'inherit' });
    }

    // Handle strip components
    let sourceDir = tempDir;
    for (let i = 0; i < stripComponents; i++) {
      const items = fs.readdirSync(sourceDir);
      if (items.length === 1) {
        sourceDir = path.join(sourceDir, items[0]);
      }
    }

    // Move contents to destination
    const items = fs.readdirSync(sourceDir);
    for (const item of items) {
      const src = path.join(sourceDir, item);
      const dest = path.join(destDir, item);
      if (fs.existsSync(dest)) {
        fs.rmSync(dest, { recursive: true });
      }
      fs.renameSync(src, dest);
    }
  } finally {
    // Cleanup
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  }
}

/**
 * Extract a tar.gz file
 */
async function extractTarGz(
  tarGzPath: string,
  destDir: string,
  stripComponents: number = 0
): Promise<void> {
  const { execSync } = await import('child_process');

  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  // Extract using tar
  execSync(
    `tar -xzf "${tarGzPath}" -C "${destDir}" --strip-components=${stripComponents}`,
    { stdio: 'inherit' }
  );
}

/**
 * Check if runtime already exists
 */
function runtimeExists(destPath: string): boolean {
  // Check for Node.js
  const nodeExe = process.platform === 'win32'
    ? path.join(destPath, 'node.exe')
    : path.join(destPath, 'bin', 'node');

  // Check for Git (Windows only)
  const gitExe = path.join(destPath, 'cmd', 'git.exe');

  return fs.existsSync(nodeExe) || fs.existsSync(gitExe);
}

// ─── Main Download Function ──────────────────────────────────────────────────

/**
 * Download all runtimes
 */
export async function downloadRuntimes(
  platform?: 'win' | 'darwin',
  arch?: 'x64' | 'arm64'
): Promise<void> {
  console.log('========================================');
  console.log('Downloading runtimes from Chinese mirrors');
  console.log('========================================\n');

  // Filter runtimes based on current platform if not specified
  const sources = RUNTIME_SOURCES.filter((source) => {
    if (platform && arch) {
      const targetPlatform = source.dest.includes('win') ? 'win' : 'darwin';
      const targetArch = source.dest.includes('arm64') ? 'arm64' : 'x64';
      return targetPlatform === platform && targetArch === arch;
    }
    // Download all for current platform
    if (process.platform === 'win32') {
      return source.dest.includes('win-x64');
    }
    if (process.platform === 'darwin') {
      if (process.arch === 'arm64') {
        return source.dest.includes('darwin-arm64');
      }
      return source.dest.includes('darwin-x64');
    }
    return true;
  });

  for (const source of sources) {
    console.log(`\n📦 Processing: ${path.basename(source.url)}`);
    console.log(`   Destination: ${source.dest}`);

    // Check if already exists
    if (runtimeExists(source.dest)) {
      console.log('   ✅ Already exists, skipping');
      continue;
    }

    // Create destination directory
    fs.mkdirSync(source.dest, { recursive: true });

    // Download file
    const tempFile = path.join(RUNTIME_DIR, path.basename(source.url));
    console.log('   ⬇️  Downloading...');

    try {
      await downloadFile(source.url, tempFile, (progress) => {
        if (progress.percent % 10 === 0) {
          console.log(`   ${progress.percent}% (${(progress.current / 1024 / 1024).toFixed(1)}MB / ${(progress.total / 1024 / 1024).toFixed(1)}MB)`);
        }
      });

      console.log('   ✅ Download complete');

      // Extract if needed
      if (source.extract) {
        console.log('   📦 Extracting...');
        if (source.url.endsWith('.zip')) {
          await extractZip(tempFile, source.dest, source.stripComponents);
        } else if (source.url.endsWith('.tar.gz')) {
          await extractTarGz(tempFile, source.dest, source.stripComponents);
        }
        console.log('   ✅ Extraction complete');
      }

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
  console.log('✅ All runtimes downloaded successfully');
  console.log('========================================');
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

/**
 * Run when called directly
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let platform: 'win' | 'darwin' | undefined;
  let arch: 'x64' | 'arm64' | undefined;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) {
      platform = args[i + 1] as 'win' | 'darwin';
      i++;
    } else if (args[i] === '--arch' && args[i + 1]) {
      arch = args[i + 1] as 'x64' | 'arm64';
      i++;
    }
  }

  try {
    await downloadRuntimes(platform, arch);
    process.exit(0);
  } catch (error) {
    console.error('Failed to download runtimes:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
