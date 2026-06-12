import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedFile {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

/**
 * AES-256-GCM with a per-file random nonce — the standard AEAD envelope
 * payload step. The KEY management lives in Vault Transit; this is only the
 * symmetric data path on a DEK that exists transiently in memory.
 */
export function encryptFile(dek: Buffer, plaintext: Buffer): EncryptedFile {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Throws on any tampering — GCM authenticates ciphertext + tag. */
export function decryptFile(dek: Buffer, file: EncryptedFile): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', dek, file.iv);
  decipher.setAuthTag(file.authTag);
  return Buffer.concat([decipher.update(file.ciphertext), decipher.final()]);
}
