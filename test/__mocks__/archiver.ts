/**
 * Jest stub for `archiver` (v8 ships as ESM-only, which ts-jest's CommonJS transform cannot parse).
 * Any spec that transitively imports `storage.service.ts` (which imports `archiver` for the export
 * path) hits this stub so the module graph loads; the real archiver is only exercised by
 * `storage.service.spec.ts`, which builds its own archives with `tar-stream` and overrides this via
 * `jest.mock('archiver', () => ({ default: jest.fn() }))`.
 */
export const TarArchive = jest.fn();
export default jest.fn();