import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { resolveStorageProvider } from './registry.js';

describe('resolveStorageProvider', () => {
  it('attaches no provider when storage is unconfigured', () => {
    const resolution = resolveStorageProvider(loadConfig({}));
    expect(resolution.provider).toBeNull();
    expect(resolution.productionSafe).toBe(false);
    expect(resolution.detail).toContain('501');
  });

  it('allows the in-memory test double outside production and labels it clearly', () => {
    const resolution = resolveStorageProvider(loadConfig({ STORAGE_PROVIDER: 'memory-test' }));
    expect(resolution.provider).not.toBeNull();
    expect(resolution.provider?.experimental).toBe(true);
    expect(resolution.productionSafe).toBe(false);
    expect(resolution.detail).toMatch(/not durable/i);
  });

  it('refuses the in-memory test double in production', () => {
    const resolution = resolveStorageProvider(
      loadConfig({ NODE_ENV: 'production', STORAGE_PROVIDER: 'memory-test' }),
    );
    expect(resolution.provider).toBeNull();
    expect(resolution.detail).toContain('refused in production');
  });

  it('attaches the experimental Telegram provider when its credentials are configured', () => {
    const resolution = resolveStorageProvider(
      loadConfig({ STORAGE_PROVIDER: 'telegram-experimental' }),
      {
        TELEGRAM_BOT_TOKEN: '1234567:AAAA-fake-token',
        TELEGRAM_STORAGE_CHAT_ID: '-1001234567890',
      },
    );
    expect(resolution.provider).not.toBeNull();
    expect(resolution.provider?.providerId).toBe('telegram');
    expect(resolution.provider?.experimental).toBe(true);
    expect(resolution.provider?.capabilities.multipartUpload).toBe(true);
    expect(resolution.provider?.capabilities.directDownloadUrl).toBe(false);
    expect(resolution.productionSafe).toBe(false);
    expect(resolution.detail).toMatch(/experimental/i);
  });

  it('attaches no Telegram provider when its credentials are missing', () => {
    const resolution = resolveStorageProvider(
      loadConfig({ STORAGE_PROVIDER: 'telegram-experimental' }),
      {},
    );
    expect(resolution.provider).toBeNull();
    expect(resolution.productionSafe).toBe(false);
    expect(resolution.detail).toMatch(/TELEGRAM_BOT_TOKEN/);
  });
});
