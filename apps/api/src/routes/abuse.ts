import { API_PREFIX, abuseReportRequestSchema } from '@opendrive/shared';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { notImplementedHandler, stubResponses } from './stubs.js';

/**
 * Abuse reporting — CONTRACT ONLY (not implemented).
 *
 * Phase 4 must persist reports, rate limit submissions per IP, avoid storing reporter
 * email addresses in plaintext where possible, and expose an administrative triage and
 * takedown workflow (see docs/SECURITY.md, "Abuse handling").
 */

const abuseReportAcceptedSchema = z.object({
  reportId: z.string().regex(/^rpt_/),
  status: z.literal('received'),
});

export const abuseRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    `${API_PREFIX}/abuse-reports`,
    {
      schema: {
        tags: ['moderation'],
        summary: '[Phase 4] Report a file',
        description:
          'Publishes the Phase 4 contract for abuse reporting. NOT IMPLEMENTED in this build: ' +
          'always answers 501 — do not use this endpoint to report abuse yet.',
        body: abuseReportRequestSchema,
        response: { ...stubResponses, 202: abuseReportAcceptedSchema },
      },
    },
    notImplementedHandler('abuse.report', 'Phase 4'),
  );
};
