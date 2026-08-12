// Single definition of what counts as an addressable ZIP entry name, shared by
// the listing (zipArchive.ts) and the tool input schema (schemas.ts). They must
// agree: a name the listing shows but the schema rejects is an entry the caller
// can see and never extract, and a name the schema accepts but the listing
// never emits is an entry the caller cannot discover. Deliberately dependency-
// free so schemas.ts does not pull the zip parser onto the main thread.

export const MAX_ZIP_ENTRY_NAME_CHARS = 512;

/**
 * Rejects a `..` path *segment* (real traversal) rather than the substring —
 * `report..v2.pdf` is a legitimate file name and stays addressable. Backslash
 * is rejected because it is ambiguous between a separator (legacy Windows
 * zippers) and a literal character; `listZipEntries` reports how many entries
 * this excluded instead of dropping them silently.
 */
export function isAddressableZipEntryName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_ZIP_ENTRY_NAME_CHARS) return false;
  if (name.startsWith('/') || name.includes('\\')) return false;
  return !name.split('/').includes('..');
}
