/** @deprecated Import ResultCache and its types from candidate-stores.ts. */

export type {
	ResultCacheEntryState as ToolCacheEntryState,
	ResultCacheInsertResult as ToolCacheInsertResult,
	ResultCacheLimits as ToolCacheLimits,
	ResultCacheLookup as ToolCacheLookup,
	ResultCacheSnapshot as ToolCacheSnapshot,
	SizedActionStoreEntry as ToolCacheEntry,
} from "./candidate-stores.ts";
export { ResultCache as ToolCache } from "./candidate-stores.ts";
