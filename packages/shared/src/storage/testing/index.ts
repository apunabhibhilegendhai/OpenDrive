/**
 * Test-only storage utilities. Imported via `@opendrive/shared/storage/testing`.
 *
 * Nothing in this module may be wired into a deployed environment: the in-memory
 * provider is a test double, and the contract suite is a development tool.
 */
export { MemoryStorageProvider } from './memory-provider.js';
export type { MemoryStorageProviderOptions } from './memory-provider.js';
export { describeStorageProviderContract } from './storage-contract.js';
export type { StorageContractOptions } from './storage-contract.js';
