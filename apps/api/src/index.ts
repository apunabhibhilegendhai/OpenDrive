// Must come first: loads .env before configuration is read.
import './env.js';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { resolveStorageProvider } from './storage/registry.js';

/**
 * API process entry point.
 *
 * Configuration is validated before anything listens; an invalid environment is a
 * startup failure rather than a surprising runtime behaviour. Missing secrets are not
 * fatal — the process starts and reports what is unconfigured via GET /readyz.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const storage = resolveStorageProvider(config);
  const app = await buildServer({ config, storage });

  for (const warning of config.configurationWarnings) {
    app.log.warn({ configuration: true }, warning);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      nodeEnv: config.nodeEnv,
      docsEnabled: config.docsEnabled,
      storageProvider: storage.configuredName,
      storageAttached: storage.provider !== null,
      productionSafeStorage: storage.productionSafe,
      rateLimitPerMinute: config.rateLimit.enabled
        ? config.rateLimit.requestsPerMinute
        : 'disabled',
      postgresConfigured: config.dependencies.postgres.configured,
      redisConfigured: config.dependencies.redis.configured,
      rateLimitStore: config.redisUrl === null ? 'in-memory' : 'redis',
    },
    'opendrive api ready',
  );
}

await main();
