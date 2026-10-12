import { z } from 'zod';
import type { StoreObjectRef } from '@opendrive/shared';
import type { SqlExecutor } from '../client.js';
import { parseByteCount } from '../parse.js';

/**
 * Storage-object references.
 *
 * A `files` row says what a file *is*; a `storage_objects` row says where its bytes *are*. The two
 * are separate tables on purpose (docs/STORAGE-PROVIDERS.md): a file's provider reference can only
 * be read by the storage layer, so a metadata query — or a handler that forgets to project columns
 * — cannot leak a provider locator into a response.
 *
 * This is the only module that reads or writes that locator. It never logs one, and nothing it
 * returns is serialisable to a client: {@link StoreObjectRef.locator} is opaque and stays internal.
 *
 * The table allows one *active* object per file (a partial unique index), so a re-finalize of the
 * same upload is a conflict rather than a second row. Historical rows (`deleted`, `orphaned`) stay
 * behind, which is what lets a deletion be verified rather than assumed (D29).
 */

const storeObjectRefSchema = z.object({
  providerId: z.string().min(1).max(64),
  locator: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  checksumSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

export interface StorageObjectRecord {
  readonly id: string;
  readonly fileId: string;
  readonly ref: StoreObjectRef;
}

interface StorageObjectRow {
  id: string;
  fileId: string;
  providerRef: unknown;
}

/**
 * Records the durable object for a file.
 *
 * Runs after a provider has finalized an upload and verified its checksum. If a row already exists
 * the insert is rejected by the partial unique index and surfaces as a conflict: writing a second
 * active locator for one file would make "where are the bytes?" ambiguous.
 */
export async function insertActiveStorageObject(
  sql: SqlExecutor,
  input: {
    id: string;
    fileId: string;
    ref: StoreObjectRef;
  },
): Promise<StorageObjectRecord> {
  // A retried finalize reaches here with the object already recorded (the provider's `finalizeUpload`
  // is idempotent, so a client that retries after a partial failure gets the same object). Returning
  // the existing row rather than attempting a second insert keeps the operation idempotent end to
  // end; the partial unique index in the schema is the backstop if two ever truly race.
  const existing = await findActiveStorageObjectByFileId(sql, input.fileId);
  if (existing !== null) return existing;

  const ref = storeObjectRefSchema.parse(input.ref);
  const rows = await sql<StorageObjectRow[]>`
    insert into storage_objects (id, file_id, provider_id, provider_ref, size_bytes, checksum_sha256)
    values (${input.id}, ${input.fileId}, ${ref.providerId}, ${sql.json(ref)},
            ${ref.sizeBytes}, ${ref.checksumSha256})
    returning id::text as id, file_id as "fileId", provider_ref as "providerRef"
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('storage_objects insert returned no row');
  return { id: row.id, fileId: row.fileId, ref: parseRef(row.providerRef) };
}

/** The active object for a file, or null. Only the storage layer may call this. */
export async function findActiveStorageObjectByFileId(
  sql: SqlExecutor,
  fileId: string,
): Promise<StorageObjectRecord | null> {
  const rows = await sql<StorageObjectRow[]>`
    select id::text as id, file_id as "fileId", provider_ref as "providerRef"
      from storage_objects
     where file_id = ${fileId} and state = 'active'
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, fileId: row.fileId, ref: parseRef(row.providerRef) };
}

/** Marks an object's reference inactive once its bytes are gone. Idempotent in effect. */
export async function markStorageObjectDeleted(sql: SqlExecutor, id: string): Promise<void> {
  await sql`
    update storage_objects
       set state = 'deleted', deleted_at = coalesce(deleted_at, now())
     where id = ${id} and state <> 'deleted'
  `;
}

function parseRef(raw: unknown): StoreObjectRef {
  const parsed = storeObjectRefSchema.safeParse(raw);
  if (!parsed.success) {
    // A locator that does not match the shape this build wrote is a corruption, not a client
    // error. Fail loudly rather than fabricate a reference to the wrong object.
    throw new Error('storage_objects.provider_ref did not match the expected shape');
  }
  return {
    providerId: parsed.data.providerId,
    locator: parsed.data.locator,
    sizeBytes: parseByteCount(parsed.data.sizeBytes, 'storage_objects.size_bytes'),
    checksumSha256: parsed.data.checksumSha256,
  };
}
