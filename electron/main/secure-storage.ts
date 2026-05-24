/**
 * Secure Storage Module
 * Provides encryption/decryption for sensitive data like API Keys
 * Uses Electron's safeStorage API which leverages OS-level encryption
 *
 * Security Notes:
 * - macOS: Uses Keychain
 * - Windows: Uses DPAPI
 * - Linux: Uses libsecret (requires gnome-keyring or kwallet)
 *
 * @module main/secure-storage
 */

import { safeStorage } from 'electron'

/**
 * Secure Storage singleton class
 * Provides encryption and decryption for sensitive data
 */
export class SecureStorage {
  private static instance: SecureStorage | null = null

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): SecureStorage {
    if (!SecureStorage.instance) {
      SecureStorage.instance = new SecureStorage()
    }
    return SecureStorage.instance
  }

  /**
   * Check if encryption is available on this system
   * @returns true if encryption is available
   */
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Encrypt a plain text string
   * @param plainText - The text to encrypt
   * @returns Base64 encoded encrypted string
   * @throws Error if encryption is not available or encryption fails
   */
  encrypt(plainText: string): string {
    if (!this.isEncryptionAvailable()) {
      throw new Error('Encryption is not available on this system')
    }

    if (!plainText || plainText.trim() === '') {
      throw new Error('Cannot encrypt empty text')
    }

    try {
      const encrypted = safeStorage.encryptString(plainText)
      return encrypted.toString('base64')
    } catch (error) {
      console.error('[SecureStorage] Encryption failed:', error)
      throw new Error(`Encryption failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Decrypt an encrypted string
   * @param encryptedBase64 - Base64 encoded encrypted string
   * @returns Decrypted plain text
   * @throws Error if decryption fails
   */
  decrypt(encryptedBase64: string): string {
    if (!this.isEncryptionAvailable()) {
      throw new Error('Decryption is not available on this system')
    }

    if (!encryptedBase64 || encryptedBase64.trim() === '') {
      throw new Error('Cannot decrypt empty text')
    }

    try {
      const buffer = Buffer.from(encryptedBase64, 'base64')
      return safeStorage.decryptString(buffer)
    } catch (error) {
      console.error('[SecureStorage] Decryption failed:', error)
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Safely encrypt, returning null on failure instead of throwing
   * @param plainText - The text to encrypt
   * @returns Encrypted string or null on failure
   */
  safeEncrypt(plainText: string): string | null {
    try {
      return this.encrypt(plainText)
    } catch (error) {
      console.error('[SecureStorage] Safe encryption failed:', error)
      return null
    }
  }

  /**
   * Safely decrypt, returning null on failure instead of throwing
   * @param encryptedBase64 - Base64 encoded encrypted string
   * @returns Decrypted string or null on failure
   */
  safeDecrypt(encryptedBase64: string): string | null {
    try {
      return this.decrypt(encryptedBase64)
    } catch (error) {
      console.error('[SecureStorage] Safe decryption failed:', error)
      return null
    }
  }

  /**
   * Check if a string appears to be encrypted
   * Simple heuristic: encrypted strings are base64 and longer than original
   * @param text - Text to check
   * @returns true if the text appears to be encrypted
   */
  isEncrypted(text: string): boolean {
    // Encrypted strings are base64 encoded
    // They typically start with common base64 patterns and are longer
    if (!text || text.length < 20) return false

    // Check if it's valid base64
    const base64Regex = /^[A-Za-z0-9+/]+=*$/
    if (!base64Regex.test(text)) return false

    // Try to decode as base64 - if it fails, it's not encrypted by us
    try {
      const decoded = Buffer.from(text, 'base64')
      // Our encrypted strings are binary and longer than 16 bytes
      return decoded.length >= 16
    } catch {
      return false
    }
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static reset(): void {
    SecureStorage.instance = null
  }
}

// Export convenience functions
export const secureStorage = SecureStorage.getInstance()

export function encryptApiKey(plainText: string): string {
  return secureStorage.encrypt(plainText)
}

export function decryptApiKey(encrypted: string): string {
  return secureStorage.decrypt(encrypted)
}

export function isEncryptionAvailable(): boolean {
  return secureStorage.isEncryptionAvailable()
}
