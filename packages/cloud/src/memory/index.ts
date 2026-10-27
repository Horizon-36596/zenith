/**
 * The in-memory backend on its own, as `@horizon36596/zenith-cloud/memory`, so the web app's fake
 * cloud and its tests can use it without loading the Firebase SDK that the package's main entry
 * brings in.
 */
export { MemoryBackend, type MemoryBackendOptions } from "./memoryBackend.js";
export { MemoryDatabase, MemoryStore, type MemoryDatabaseOptions } from "./memoryStore.js";
export { MemoryTrustStore, StorageTrustStore, type PartnerKeyStatus, type StorageLike, type TrustStore } from "../keys/trust.js";
