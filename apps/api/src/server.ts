import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  ANONYMOUS_CREDENTIAL_HEADER,
  AppError,
  UPLOAD_PART_CHECKSUM_HEADER,
  isAppError,
  validationFailed,
} from '@opendrive/shared';
import type { ProblemDetails } from '@opendrive/shared';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { loadConfig } from './config.js';
import type { ApiConfig } from './config.js';
import { applyIdentityResolution } from './plugins/identity.js';
import { registerRoutes } from './routes/index.js';
import { applySecurityHeaders } from './security.js';
import { createServices } from './services.js';
import type { AppServices } from './services.js';
import type { StorageResolution } from './storage/registry.js';
import { SERVICE_VERSION } from './version.js';

/** Prefix for the interactive API documentation (disabled in production by default). */
export const DOCS_PREFIX = '/docs';

export interface BuildServerOptions {
  /** Pre-resolved configuration. Defaults to reading and validating the environment. */
  config?: ApiConfig;
  /** Pre-resolved storage provider. Defaults to resolving from configuration. */
  storage?: StorageResolution;
  /**
   * Pre-resolved services (database, verifier, hashing). Tests inject a scratch database and a
   * locally signed verifier; a deployment lets the server build them from configuration.
   *
   * When this is provided the caller owns the database connection and the server will not close it.
   */
  services?: AppServices;
  /** Override the Fastify logger (tests pass `false` to stay quiet). */
  logger?: FastifyServerOptions['logger'];
}

const API_DESCRIPTION = [
  'OpenDrive HTTP API.',
  '',
  'Identity, authorization and metadata are live. Credentials are verified (Supabase access token,',
  'anonymous session, API key), files and folders are listed and managed for their owner only, share',
  'links are created, resolved and revoked, and `/api/v1/me` reports the resulting identity and',
  'quota.',
  '',
  'Storage is live for configured providers: files upload through a chunked workflow (initiate,',
  'parts, complete/abort) and download by streaming the stored object. Bytes never enter PostgreSQL',
  'at any point, and a deployment with no storage provider attached answers `503` rather than',
  'accepting bytes it cannot store.',
].join('\n');

interface ProblemContext {
  instance: string;
  requestId: string;
}

/**
 * A preview URL carries its signing token in the query string, and the default request logging
 * includes `req.url`. Redacting just that parameter means a token can never be replayed out of a
 * log line, while the rest of the URL stays useful for diagnosis. Exported so it can be tested
 * directly rather than only through a live log stream.
 */
export function redactPreviewToken(url: string): string {
  return url.replace(/([?&]preview=)[^&#]*/i, '$1[redacted]');
}

/**
 * A cacheable delivery URL carries its signing token in a `token` query parameter. The same
 * reasoning applies as for a preview token: the default request logging includes `req.url`, so the
 * parameter is hidden rather than the whole URL.
 */
export function redactDeliveryToken(url: string): string {
  return url.replace(/([?&]token=)[^&#]*/i, '$1[redacted]');
}

/**
 * A share link carries its bearer token in the path. The reasoning behind redacting a preview token
 * applies unchanged: the default request logging includes `req.url`, and a token that reaches a log
 * line can be replayed. Only the `/s/<token>` segment is hidden; a `/s/<token>/download` request
 * still logs its `/download` suffix, so the route stays legible.
 */
export function redactShareToken(url: string): string {
  return url.replace(/^\/s\/[^/?#]+/, '/s/[redacted]');
}

interface ValidationIssueLike {
  instancePath?: string;
  message?: string;
}

/**
 * Fastify hands the error handler an `unknown`. Everything below narrows explicitly so a
 * thrown non-Error (a string, an object, a rejected promise value) cannot crash the handler
 * or leak an unexpected shape to clients.
 */
function asValidationIssues(error: unknown): ValidationIssueLike[] {
  if (typeof error !== 'object' || error === null) return [];
  const validation = (error as { validation?: unknown }).validation;
  if (!Array.isArray(validation)) return [];
  return validation as ValidationIssueLike[];
}

function statusCodeOf(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && Number.isInteger(statusCode)) return statusCode;
  }
  return 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

/** Turns a Fastify/Zod validation failure into the published problem shape. */
function validationProblem(
  issues: readonly ValidationIssueLike[],
  context: ProblemContext,
): ProblemDetails {
  const fields = issues.map((issue) => ({
    path:
      issue.instancePath === undefined || issue.instancePath === '' ? '(root)' : issue.instancePath,
    message: issue.message ?? 'is invalid',
  }));
  return validationFailed('Request validation failed.', fields).toProblemDetails(context);
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const ownsServices = options.services === undefined;
  const services =
    options.services ??
    createServices(config, options.storage === undefined ? {} : { storage: options.storage });

  const app = Fastify({
    logger: options.logger ?? {
      level: config.logLevel,
      // Fastify logs `req.url`, and a preview URL carries its signing token in the query string.
      // The serializer keeps every other field while redacting that one parameter.
      serializers: {
        req: (request: {
          id?: string;
          method?: string;
          url?: string;
          host?: string;
          ip?: string;
          socket?: { remotePort?: number };
        }) => ({
          id: request.id,
          method: request.method,
          url: redactShareToken(redactDeliveryToken(redactPreviewToken(request.url ?? ''))),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        }),
      },
    },
    trustProxy: config.trustProxy,
    // Request ids are generated server-side and echoed in responses. Client-supplied
    // ids are ignored: trusting them would allow log injection and trace confusion.
    genReqId: () => randomUUID(),
    requestIdHeader: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  app.addHook('onSend', async (request, reply) => {
    applySecurityHeaders(request, reply, DOCS_PREFIX);
  });

  // OpenAPI generation must be registered before the routes it documents.
  if (config.docsEnabled) {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'OpenDrive API',
          version: SERVICE_VERSION,
          description: API_DESCRIPTION,
        },
        servers: [],
        tags: [
          { name: 'system', description: 'Liveness, readiness and effective limits.' },
          { name: 'identity', description: 'Who the caller is, their quota and their API keys.' },
          { name: 'files', description: 'File and folder metadata for the owning principal.' },
          { name: 'uploads', description: 'Chunked, resumable upload workflow (Phase 2).' },
          { name: 'shares', description: 'Share links: creation, resolution and revocation.' },
          { name: 'moderation', description: 'Abuse reporting and takedowns (Phase 4).' },
        ],
      },
      transform: jsonSchemaTransform,
    });
    // @fastify/swagger v9 only decorates `app.swagger()`; it exposes no routes of its own,
    // so the canonical spec path is served explicitly below. The UI plugin additionally
    // serves the spec at /docs/json and /docs/yaml.
    await app.register(swaggerUi, { routePrefix: DOCS_PREFIX.slice(1) });
    app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());
  }

  // CORS is only enabled for explicitly configured origins. `credentials` stays false:
  // the API authenticates with bearer tokens, not cookies, so browsers must not attach
  // ambient credentials to cross-origin calls.
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? [...config.corsOrigins] : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-deletion-token',
      'x-request-id',
      // A migration call carries two credentials, and the second one travels in its own header.
      // Without it listed the browser would refuse the request before the API ever saw it.
      ANONYMOUS_CREDENTIAL_HEADER,
      UPLOAD_PART_CHECKSUM_HEADER,
    ],
    exposedHeaders: ['x-request-id', 'retry-after'],
    credentials: false,
    maxAge: 600,
  });

  // Upload parts arrive as raw bytes, not JSON. The body is handed to the route as the live stream
  // so a part is never buffered here; the handler bounds what it reads by the part size and passes
  // the stream straight to the storage provider. Registering the parser is what stops Fastify from
  // answering `415 Unsupported Media Type` to `application/octet-stream`.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = new AppError('NOT_FOUND', {
      detail: `No route matches ${request.method} ${request.url}.`,
    }).toProblemDetails({ instance: request.url, requestId: request.id });
    void reply.status(problem.status).send(problem);
  });

  app.setErrorHandler((error, request, reply) => {
    const context: ProblemContext = { instance: request.url, requestId: request.id };

    // A byte route (`/cdn`, a file's content, a share's bytes) sets `content-type` to the file's
    // own type before the storage read can fail, because the provider's stream is lazy: opening it
    // succeeds and the failure arrives while the bytes are read. Fastify refuses to send an object
    // under a non-JSON content-type, so without clearing the route's type here the real failure -
    // a 503 the caller could act on - is replaced by an opaque `FST_ERR_REP_INVALID_PAYLOAD_TYPE`
    // 500. Dropping both headers is what lets the problem document below be serialized as JSON.
    void reply.removeHeader('content-type');
    void reply.removeHeader('content-length');

    if (isAppError(error)) {
      // Expected failures: logged as ordinary request outcomes, not as server faults.
      request.log.info({ code: error.code, status: error.status }, 'request failed');
      void reply.status(error.status).send(error.toProblemDetails(context));
      return;
    }

    const issues = asValidationIssues(error);
    if (issues.length > 0) {
      const problem = validationProblem(issues, context);
      void reply.status(problem.status).send(problem);
      return;
    }

    const statusCode = statusCodeOf(error);
    if (statusCode >= 400 && statusCode < 500) {
      // Raised by a plugin (for example the rate limiter) or by Fastify itself.
      const code = statusCode === 429 ? 'RATE_LIMITED' : 'INVALID_REQUEST';
      const problem = new AppError(code, {
        detail: statusCode === 429 ? 'Too many requests. Retry later.' : messageOf(error),
      }).toProblemDetails(context);
      void reply.status(problem.status).send(problem);
      return;
    }

    // Unexpected: log the real error server-side, return nothing revealing.
    request.log.error({ err: error }, 'unhandled error');
    void reply.status(500).send(
      new AppError('INTERNAL', {
        detail: 'Unexpected internal error.',
        expose: false,
      }).toProblemDetails(context),
    );
  });

  // Installed on the root instance (not as a plugin) so the hook and decorators cover every route
  // registered below, whichever plugin they belong to.
  applyIdentityResolution(app, {
    sql: services.db.sql,
    verifier: services.verifier,
    hashIp: services.hashIp,
  });

  if (config.rateLimit.enabled) {
    // Registered *after* identity resolution so the limiter can key by principal rather than only
    // by address: a shared NAT or proxy would otherwise make one caller's flood everyone's problem,
    // and per-address limits alone cannot stop one authenticated account from saturating the API.
    // Resolving identity first is what makes `request.identity` available inside `keyGenerator`.
    await app.register(rateLimit, {
      max: config.rateLimit.requestsPerMinute,
      timeWindow: '1 minute',
      // With Redis configured the counters are shared across every API instance; without it they
      // are held in-process. `skipOnError` makes an unreachable Redis fail *open*: a limiter
      // outage must not become an API outage.
      ...(services.redis === null ? {} : { redis: services.redis.client, skipOnError: true }),
      keyGenerator: (request) => {
        const identity = request.identity;
        if (identity === null || identity === undefined || identity.kind === 'none') {
          return request.ip;
        }
        return identity.kind === 'user'
          ? `user:${identity.principal.userId}`
          : `session:${identity.principal.sessionId}`;
      },
      // Liveness must stay answerable even while an attacker floods the API.
      allowList: (request) => request.url === '/healthz',
    });
  }

  await app.register(registerRoutes, services);

  if (ownsServices) {
    // Closing the pool belongs to whoever opened it: an injected container outlives the server.
    app.addHook('onClose', async () => {
      await services.db.close();
      if (services.redis !== null) {
        // The plugin wires the client into its store but never closes it: that is ours to do.
        await services.redis.close();
      }
      // The edge cache is derived state; flushing its index is best-effort and must never block
      // shutdown. A fill still in flight is simply abandoned — the bytes are on the provider.
      if (services.edgeCache !== null) {
        await services.edgeCache.close();
      }
    });
  }

  await app.ready();
  return app;
}
