import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecurityManager } from '../../src/security/securityManager.js';

describe('SecurityManager encryption', () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'ci-unblock-test-key';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }

    vi.restoreAllMocks();
  });

  it('encrypts and decrypts using the current API', () => {
    const manager = new SecurityManager();
    const plaintext = 'sensitive-data-123';

    const encrypted = manager.encryptData(plaintext);

    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toMatch(/^enc-v1:[0-9a-f]+:[0-9a-f]+$/);
    expect(manager.decryptData(encrypted)).toBe(plaintext);
  });

  it('uses a random IV so repeated encryptions differ', () => {
    const manager = new SecurityManager();
    const plaintext = 'same-payload';

    const encryptedOne = manager.encryptData(plaintext);
    const encryptedTwo = manager.encryptData(plaintext);

    expect(encryptedOne).not.toBe(encryptedTwo);
    expect(manager.decryptData(encryptedOne)).toBe(plaintext);
    expect(manager.decryptData(encryptedTwo)).toBe(plaintext);
  });

  it('returns the input unchanged for malformed ciphertext', () => {
    const manager = new SecurityManager();
    const malformed = 'legacy-or-invalid-payload';

    expect(manager.decryptData(malformed)).toBe(malformed);
  });

  it('returns plaintext unchanged when encryption is disabled', () => {
    const manager = new SecurityManager({ enableEncryption: false });
    const plaintext = 'leave-me-alone';

    expect(manager.encryptData(plaintext)).toBe(plaintext);
    expect(manager.decryptData(plaintext)).toBe(plaintext);
  });
});
