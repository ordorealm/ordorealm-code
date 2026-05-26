/**
 * 加密工具模块
 *
 * 使用 Node.js crypto 模块，基于机器唯一标识生成密钥，
 * 使用 AES-256-CBC 加密算法对敏感数据进行加密存储。
 *
 * @module encryption
 */

import * as crypto from 'crypto';
import * as os from 'os';

/**
 * 基于机器唯一标识生成加密密钥
 *
 * 使用 hostname + platform + cpu model 组合生成唯一标识，
 * 确保密钥与当前机器绑定，增强安全性。
 *
 * @returns 32 字节的 AES-256 密钥
 */
function getEncryptionKey(): Buffer {
  const hostname = os.hostname();
  const platform = os.platform();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : 'unknown';

  const machineId = hostname + platform + cpuModel;
  console.log('[Encryption] Generating encryption key from machine identifier');

  return crypto.createHash('sha256').update(machineId).digest();
}

/**
 * 加密数据
 *
 * 使用 AES-256-CBC 算法加密数据，每次加密生成随机 IV，
 * 确保相同数据多次加密结果不同。
 *
 * @param data - 要加密的明文
 * @returns 加密后的字符串，格式为 "iv:encrypted"（hex 编码）
 * @example
 * ```typescript
 * const encrypted = encrypt('my secret data');
 * // 返回类似 "a1b2c3d4...:e5f6g7h8..."
 * ```
 */
export function encrypt(data: string): string {
  if (typeof data !== 'string') {
    throw new Error('Data to encrypt must be a string');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const result = iv.toString('hex') + ':' + encrypted;
  console.log('[Encryption] Data encrypted successfully');

  return result;
}

/**
 * 解密数据
 *
 * 解密由 encrypt 函数加密的数据，验证数据格式和完整性。
 *
 * @param encryptedData - 加密的字符串，格式为 "iv:encrypted"
 * @returns 解密后的明文
 * @throws Error 如果解密失败或数据格式无效
 * @example
 * ```typescript
 * const decrypted = decrypt(encryptedString);
 * // 返回原始明文
 * ```
 */
export function decrypt(encryptedData: string): string {
  if (typeof encryptedData !== 'string') {
    throw new Error('Encrypted data must be a string');
  }

  // 验证数据格式
  const parts = encryptedData.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted data format: expected "iv:encrypted"');
  }

  const [ivHex, encrypted] = parts;

  // 验证 IV 长度 (16 bytes = 32 hex chars)
  if (ivHex.length !== 32) {
    throw new Error('Invalid IV length: expected 32 hex characters');
  }

  // 验证加密数据不为空
  if (!encrypted || encrypted.length === 0) {
    throw new Error('Encrypted data is empty');
  }

  try {
    const key = getEncryptionKey();
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    console.log('[Encryption] Data decrypted successfully');
    return decrypted;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Encryption] Decryption failed:', errorMessage);

    // 区分不同的错误类型
    if (errorMessage.includes('bad decrypt') || errorMessage.includes('wrong final block length')) {
      throw new Error('Decryption failed: invalid data or key mismatch');
    }

    throw new Error(`Decryption failed: ${errorMessage}`);
  }
}

/**
 * 生成随机 UUID
 *
 * 使用 crypto.randomUUID() 生成符合 RFC 4122 标准的 UUID v4。
 *
 * @returns UUID 字符串（格式：xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）
 * @example
 * ```typescript
 * const id = generateId();
 * // 返回类似 "550e8400-e29b-41d4-a716-446655440000"
 * ```
 */
export function generateId(): string {
  const id = crypto.randomUUID();
  console.log('[Encryption] Generated UUID:', id);
  return id;
}

/**
 * 计算字符串的 SHA256 哈希
 *
 * 使用 SHA-256 算法计算数据的哈希值，用于数据完整性校验或
 * 生成唯一标识（不可逆）。
 *
 * @param data - 要哈希的数据
 * @returns hex 编码的 64 字符哈希值
 * @example
 * ```typescript
 * const hashValue = hash('my data');
 * // 返回类似 "e3b0c44298fc1c149afbf4c8996fb924..."
 * ```
 */
export function hash(data: string): string {
  if (typeof data !== 'string') {
    throw new Error('Data to hash must be a string');
  }

  const hashValue = crypto.createHash('sha256').update(data, 'utf8').digest('hex');
  console.log('[Encryption] Generated hash:', hashValue.substring(0, 16) + '...');

  return hashValue;
}

/**
 * 验证加密数据的完整性
 *
 * 检查加密数据是否可以被成功解密（不返回解密结果）。
 * 用于验证存储的令牌是否有效。
 *
 * @param encryptedData - 要验证的加密字符串
 * @returns 是否可以成功解密
 */
export function validateEncryptedData(encryptedData: string): boolean {
  try {
    decrypt(encryptedData);
    return true;
  } catch {
    return false;
  }
}
