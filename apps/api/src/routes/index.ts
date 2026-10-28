import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppServices } from '../services.js';
import { abuseRoutes } from './abuse.js';
import { apiKeyRoutes } from './api-keys.js';
import { deliveryRoutes } from './delivery.js';
import { fileRoutes } from './files.js';
import { importRoutes } from './imports.js';
import { renditionRoutes } from './renditions.js';
import { folderRoutes } from './folders.js';
import { identityRoutes } from './identity.js';
import { migrationRoutes } from './migration.js';
import { sessionRoutes } from './sessions.js';
import { shareRoutes } from './shares.js';
import { systemRoutes } from './system.js';
import { uploadRoutes } from './uploads.js';

/**
 * Route registration.
 *
 * Order matters for OpenAPI: `@fastify/swagger` must be registered before these plugins so every
 * route is discovered. System routes come first so liveness stays trivially reachable, and the
 * identity routes follow so a caller can find out who the server thinks they are before anything
 * else can go wrong.
 */
export const registerRoutes: FastifyPluginAsyncZod<AppServices> = async (app, services) => {
  await app.register(systemRoutes, services);
  await app.register(identityRoutes, services);
  await app.register(sessionRoutes, services);
  await app.register(migrationRoutes, services);
  await app.register(apiKeyRoutes, services);
  await app.register(uploadRoutes, services);
  await app.register(fileRoutes, services);
  await app.register(importRoutes, services);
  await app.register(renditionRoutes, services);
  await app.register(deliveryRoutes, services);
  await app.register(folderRoutes, services);
  await app.register(shareRoutes, services);
  await app.register(abuseRoutes);
};
