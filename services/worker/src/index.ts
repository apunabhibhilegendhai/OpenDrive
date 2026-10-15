#!/usr/bin/env node
import { createDefaultRegistry } from './jobs/registry.js';
import type { JobLogger, JobName } from './jobs/types.js';

/**
 * Background worker.
 *
 * Phase 0 STATUS: this process does not consume a queue yet, because none of the declared
 * jobs has an implementation and no Redis client is wired in. It reports the job contracts
 * it knows about, resolves the schema of each payload, and exits non-zero if a contract is
 * internally inconsistent. Claiming to "run jobs" while every handler is missing would be
 * the exact dishonesty this phase is meant to avoid.
 *
 * Phase 2 will replace the reported queue with the Redis implementation and add the run loop.
 */

const PAYLOAD_TEMPLATES: Record<JobName, unknown> = {
  'scan.requested': {
    fileId: 'file_0123456789012345678901234a',
    storageLocator: 'provider/opaque-locator',
    declaredMimeType: 'application/pdf',
    declaredSizeBytes: 1024,
  },
  'retention.expire_uploads': { olderThan: '2026-10-10T00:00:00.000Z' },
  'retention.expire_shares': { now: '2026-10-10T00:00:00.000Z' },
  'maintenance.cleanup_orphans': { dryRun: true, olderThan: '2026-10-10T00:00:00.000Z' },
  'maintenance.edge_cache_evict': { now: '2026-10-10T00:00:00.000Z', dryRun: true },
  'moderation.apply_takedown': {
    reportId: 'rpt_0123456789012345678901234a',
    fileId: 'file_0123456789012345678901234a',
    reason: 'malware',
  },
};

export interface JobSelfCheck {
  name: JobName;
  state: 'declared' | 'implemented';
  phase: string;
  summary: string;
  /** Whether the documented example payload satisfies the declared schema. */
  payloadContractHolds: boolean;
}

export interface WorkerSelfCheck {
  queueBackend: string;
  jobs: JobSelfCheck[];
  declaredCount: number;
  implementedCount: number;
  /** Non-empty when the worker cannot do its job, which is the Phase 0 state. */
  blockers: string[];
}

/** Validates that every declared job's documented example payload really satisfies its schema. */
export function selfCheck(): WorkerSelfCheck {
  const registry = createDefaultRegistry();
  const logger: JobLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  void logger;

  const jobs = registry.describe().map((description) => {
    const template = PAYLOAD_TEMPLATES[description.name];
    const validation = registry.validate(description.name, template);
    return {
      name: description.name,
      state: description.state,
      phase: description.phase,
      summary: description.summary,
      payloadContractHolds: validation.ok,
    };
  });

  const implementedCount = jobs.filter((job) => job.state === 'implemented').length;
  const brokenContracts = jobs.filter((job) => !job.payloadContractHolds).map((job) => job.name);

  const blockers = [
    'No Redis connection is configured, so no queue is consumed (Phase 2).',
    'Every declared job has state "declared": dispatch reports not_implemented instead of running.',
    ...brokenContracts.map((name) => `Job "${name}" has an inconsistent payload contract.`),
  ];

  return {
    queueBackend: 'none (in-memory semantics available for tests only)',
    jobs,
    declaredCount: jobs.length - implementedCount,
    implementedCount,
    blockers,
  };
}

function renderReport(report: WorkerSelfCheck): string {
  const lines = [
    'opendrive worker — contract report',
    '',
    `queue backend   ${report.queueBackend}`,
    `jobs declared   ${report.declaredCount}`,
    `jobs implemented ${report.implementedCount}`,
    '',
  ];
  for (const job of report.jobs) {
    const mark = job.payloadContractHolds ? 'ok ' : 'BAD';
    lines.push(`  [${mark}] ${job.name} — ${job.state}, ${job.phase}`);
    lines.push(`        ${job.summary}`);
  }
  lines.push('', 'Blockers before this worker can process anything:');
  for (const blocker of report.blockers) lines.push(`  - ${blocker}`);
  return lines.join('\n');
}

function main(argv: readonly string[]): number {
  const report = selfCheck();

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report)}\n`);
  }

  const inconsistent = report.jobs.some((job) => !job.payloadContractHolds);
  // Exit 0 when the contracts are consistent even though nothing runs yet: the exit code
  // reports whether the process's own configuration is correct, not whether the platform
  // is finished. Readiness of the platform is reported by the API.
  return inconsistent ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
