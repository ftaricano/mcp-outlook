// Pure format-sniffing helpers shared by the extraction supervisor
// (src/plugin/extractors.ts) and the isolated extraction worker
// (src/plugin/extractionWorker.ts). No I/O, no parser calls — safe to run in
// either thread.

export function bound(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

export function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('latin1').startsWith('%PDF');
}

export function isZipContainer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

export function isTextual(contentType: string, name: string): boolean {
  const lowered = contentType.toLowerCase();
  return (
    lowered.startsWith('text/') ||
    lowered.includes('json') ||
    lowered.includes('xml') ||
    lowered.includes('csv') ||
    /\.(txt|csv|json|xml|html?)$/i.test(name)
  );
}

export function isXlsxName(name: string, contentType: string): boolean {
  return /\.xlsx$/i.test(name) || contentType.includes('spreadsheetml');
}

export function isDocxName(name: string, contentType: string): boolean {
  return /\.docx$/i.test(name) || contentType.includes('wordprocessingml');
}

// Distinguishes a user-facing .zip archive attachment (browsable by entry,
// optionally password-protected) from an OOXML container such as .xlsx/.docx,
// which is also a PK-prefixed zip but is parsed whole, never entry-by-entry.
export function isZipArchiveAttachment(buffer: Buffer, name: string, contentType: string): boolean {
  const zipNamed = /\.zip$/i.test(name) || contentType.toLowerCase().includes('zip');
  return isZipContainer(buffer) && zipNamed;
}
