/**
 * Unit-test stub for the `meilisearch` package (ESM-only — ships no CJS build).
 * ts-jest runs in CommonJS mode, so any source file that does a value import from
 * `meilisearch` (e.g. `meilisearch.client.ts` imports the `Meilisearch` constructor)
 * hits "Cannot use import statement outside a module" when pulled into the unit-test
 * graph. This stub provides a no-op constructor so the module loads; SearchService unit
 * tests inject a mocked `MeilisearchClient` and never touch the real client.
 *
 * The type exports (`Index`, `SearchResponse`) mirror the real package's shapes closely
 * enough for source files to type-check under the moduleNameMapper redirect. They are
 * erased at runtime — only the `Meilisearch` class below has a runtime presence.
 */

export type SearchResponse<T = unknown> = {
  hits: T[];
  estimatedTotalHits?: number;
  processingTimeMs?: number;
  query?: string;
  limit?: number;
  offset?: number;
};

export interface Index<T = unknown> {
  updateSearchableAttributes(attrs: string[]): Promise<unknown>;
  updateFilterableAttributes(attrs: string[]): Promise<unknown>;
  updateSortableAttributes(attrs: string[]): Promise<unknown>;
  addDocuments(docs: T[], options?: { primaryKey?: string }): Promise<unknown>;
  deleteDocument(id: string): Promise<unknown>;
  deleteAllDocuments(): Promise<unknown>;
  search(query: string, options?: Record<string, unknown>): Promise<SearchResponse<T>>;
}

export class Meilisearch {
  // The real constructor takes { host, apiKey }; the stub ignores it. `void` marks it used
  // for the no-unused-vars rule while keeping the call site `new Meilisearch({ host, apiKey })`
  // type-valid.
  constructor(options: unknown) {
    void options;
  }

  health = jest.fn().mockResolvedValue({ status: 'available' });

  index = jest.fn().mockReturnValue({
    updateSearchableAttributes: jest.fn().mockResolvedValue(undefined),
    updateFilterableAttributes: jest.fn().mockResolvedValue(undefined),
    updateSortableAttributes: jest.fn().mockResolvedValue(undefined),
    addDocuments: jest.fn().mockResolvedValue(undefined),
    deleteDocument: jest.fn().mockResolvedValue(undefined),
    deleteAllDocuments: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue({ hits: [], estimatedTotalHits: 0 }),
  });
}
