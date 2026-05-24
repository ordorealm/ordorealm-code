import CryptoJS from 'crypto-js';

/** 盐值缓存 */
let _salt: string | null = null;

/**
 * 获取用户数据目录中的盐值文件路径
 */
async function getSaltFilePath(): Promise<string> {
  const userDataPath = await window.api.fs.getUserDataPath();
  return `${userDataPath}/.salt`;
}

/**
 * 从磁盘加载或创建盐值
 * 盐值存储在用户数据目录，与 providers.json 同级
 * 这样即使 dev server 端口变化，盐值也能保持一致
 */
async function getOrCreateSalt(): Promise<string> {
  // 使用缓存
  if (_salt) {
    return _salt;
  }

  const saltFilePath = await getSaltFilePath();
  console.log('[Crypto] Salt file path:', saltFilePath);

  try {
    // 尝试从磁盘读取盐值
    const result = await window.electron.ipcRenderer.invoke('fs:readFile', saltFilePath);
    console.log('[Crypto] Read result:', result);
    if (result?.success && result?.content) {
      const loadedSalt = result.content.trim();
      if (loadedSalt) {
        _salt = loadedSalt;
        console.log('[Crypto] Loaded salt from disk, length:', loadedSalt.length);
        return loadedSalt;
      }
    }
  } catch (error) {
    console.log('[Crypto] No existing salt found, creating new one:', error);
  }

  // 生成新盐值
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const newSalt = Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  _salt = newSalt;
  console.log('[Crypto] Generated new salt, length:', newSalt.length);

  // 保存到磁盘
  try {
    const writeResult = await window.electron.ipcRenderer.invoke('fs:writeFile', saltFilePath, newSalt);
    console.log('[Crypto] Write result:', writeResult);
    console.log('[Crypto] Saved new salt to disk');
  } catch (error) {
    console.error('[Crypto] Failed to save salt:', error);
  }

  return newSalt;
}

/**
 * 同步版本的盐值获取（用于兼容）
 * 首次调用会返回临时值，应优先使用异步版本
 */
function getOrCreateSaltSync(): string {
  if (_salt) {
    return _salt;
  }

  // 触发异步加载
  getOrCreateSalt().catch(console.error);

  // 返回临时值（基于固定种子）
  // 注意：这只是临时方案，真正的加密应等待异步完成
  return 'temp-salt-pending-async-load';
}

/**
 * 初始化加密模块
 * 应在应用启动时调用，预加载盐值
 */
export async function initializeCrypto(): Promise<void> {
  await getOrCreateSalt();
  console.log('[Crypto] Initialized');
}

/**
 * 获取加密密钥
 */
async function getEncryptionKey(): Promise<string> {
  const salt = await getOrCreateSalt();
  return `devflow-encryption-key:${salt}`;
}

/**
 * 加密字符串
 * @param plainText 明文
 * @returns 加密后的字符串
 */
export async function encryptApiKey(plainText: string): Promise<string> {
  if (!plainText) return '';
  const key = await getEncryptionKey();
  return CryptoJS.AES.encrypt(plainText, key).toString();
}

/**
 * 解密字符串
 * @param encryptedText 加密的字符串
 * @returns 解密后的明文
 */
export async function decryptApiKey(encryptedText: string): Promise<string> {
  if (!encryptedText) return '';
  try {
    const key = await getEncryptionKey();
    const bytes = CryptoJS.AES.decrypt(encryptedText, key);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    console.error('Decryption failed:', error);
    return '';
  }
}

/**
 * 同步版本的加密（兼容旧代码）
 * @deprecated 使用 encryptApiKey 替代
 */
export function encryptApiKeySync(plainText: string): string {
  if (!plainText) return '';
  const salt = getOrCreateSaltSync();
  const key = `devflow-encryption-key:${salt}`;
  return CryptoJS.AES.encrypt(plainText, key).toString();
}

/**
 * 同步版本的解密（兼容旧代码）
 * @deprecated 使用 decryptApiKey 替代
 */
export function decryptApiKeySync(encryptedText: string): string {
  if (!encryptedText) return '';
  try {
    const salt = getOrCreateSaltSync();
    const key = `devflow-encryption-key:${salt}`;
    const bytes = CryptoJS.AES.decrypt(encryptedText, key);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    console.error('Decryption failed:', error);
    return '';
  }
}

/**
 * 检查字符串是否已加密
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  return value.length > 20 && /^[A-Za-z0-9+/=]+$/.test(value);
}
