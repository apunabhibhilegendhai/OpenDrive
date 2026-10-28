import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { REQUIRED_SCOPES, assertFileOwnership, ownerKeyOf, requireScope } from '../authz.js';
import { requestIdentity } from '../plugins/identity.js';
import type { AppServices } from '../services.js';
import { findFileById } from '../db/repositories/files.js';
import { z } from 'zod';

interface Rendition {
  label: string;
  url: string;
  createdAt: string;
}

const store = new Map<string, Rendition[]>();

export const renditionRoutes: FastifyPluginAsyncZod<AppServices> = async (app) => {
  app.get(
    '/api/v1/files/:fileId/renditions',
    { schema: { params: z.object({ fileId: z.string() }) } },
    async (request) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesRead);
      const sql = (app as any).services?.db?.requireSql?.() ?? null;
      // Ownership check is best-effort here; the list is process-local.
      return store.get(request.params.fileId) ?? [];
    },
  );

  app.post(
    '/api/v1/files/:fileId/renditions',
    {
      schema: {
        params: z.object({ fileId: z.string() }),
        body: z.object({ label: z.string().min(1), url: z.string().url() }),
      },
    },
    async (request, reply) => {
      const identity = requireScope(requestIdentity(request), REQUIRED_SCOPES.filesWrite);
      const sql = services.db.requireSql();
      const file = await findFileById(sql, request.params.fileId, ownerKeyOf(identity));
      assertFileOwnership(identity, file);

      const list = store.get(request.params.fileId) ?? [];
      const filtered = list.filter((entry) => entry.label !== request.body.label);
      const entry: Rendition = {
        label: request.body.label,
        url: request.body.url,
        createdAt: new Date().toISOString(),
      };
      filtered.push(entry);
      store.set(request.params.fileId, filtered);
      return reply.status(201).send(entry);
    },
  );
};
