import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { ZipFile } from 'yazl';
import type { MailboxEmailService } from '../../src/plugin/MultiMailboxService.js';
import type { PluginConfig } from '../../src/plugin/config.js';

export function config(overrides: Partial<PluginConfig> = {}): PluginConfig {
  const mailboxes = [
    { alias: 'finance', address: 'finance@example.com' },
    { alias: 'billing', address: 'billing@example.com' },
    { alias: 'archive', address: 'archive@example.com' },
  ] as const;
  const mailboxesByAlias = new Map(mailboxes.map((mailbox) => [mailbox.alias, mailbox]));

  return {
    mailboxes,
    mailboxesByAlias,
    maxConcurrentMailboxes: 2,
    maxMailboxesPerSearch: 3,
    maxResultsPerMailbox: 20,
    maxBodyChars: 12000,
    allowWrites: false,
    maxAttachmentInputBytes: 15 * 1024 * 1024,
    maxExtractedChars: 200_000,
    maxRawAttachmentBytes: 256 * 1024,
    maxConcurrentExtractions: 2,
    maxBatchSize: 25,
    maxQueriesPerBatch: 10,
    maxZipEntries: 200,
    maxZipUncompressedBytes: 50 * 1024 * 1024,
    maxContainerEntries: 1_000,
    maxContainerUncompressedBytes: 100 * 1024 * 1024,
    searchMemoryPath: undefined,
    ...overrides,
  };
}

export function stubEmailService(
  overrides: Partial<MailboxEmailService> = {}
): MailboxEmailService {
  const rejectUnstubbed = (method: string) => async () => {
    throw new Error(`stubEmailService: ${method} was not stubbed for this test`);
  };
  const methods: (keyof MailboxEmailService)[] = [
    'advancedSearchEmailsDetailed',
    'getEmailById',
    'listFoldersDetailed',
    'getFolderStatistics',
    'listAttachments',
    'downloadAttachment',
    'downloadAttachmentToFile',
    'downloadAllAttachmentsFromEmail',
    'moveEmailsToFolder',
    'copyEmailsToFolder',
    'batchMarkAsRead',
    'batchMarkAsUnread',
    'createDraft',
    'encodeFileForAttachment',
  ];
  const base = Object.fromEntries(
    methods.map((method) => [method, vi.fn(rejectUnstubbed(method))])
  ) as unknown as MailboxEmailService;
  return { ...base, ...overrides };
}

export const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 72 720 Td (FATURA 12345) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>`,
  'latin1'
);

export function writeMemory(yamlText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'search-memory-'));
  const file = join(dir, 'memory.yaml');
  writeFileSync(file, yamlText, { mode: 0o600 });
  return file;
}

export const SAMPLE_MEMORY_YAML = `
apelidos:
  "FUNDACAO EXEMPLO DE PREVIDENCIA": ["FEP"]
grupos:
  "GRUPO NAUTICO": ["Empresa Alfa Navegacao", "Empresa Beta Offshore"]
stopwords: ["LTDA", "GRUPO", "SA"]
outros_campos_privados:
  ignorado: true
`;

// A real workbook is a zip container whose internal part count grows with the
// number of sheets — the shape that made the OOXML pre-check trip over the
// user-facing .zip entry cap.
export async function buildXlsx(sheetCount: number): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  for (let index = 1; index <= sheetCount; index += 1) {
    workbook.addWorksheet(`Aba ${index}`).addRow([`valor-${index}`]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function buildZip(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(Buffer.from(content), name);
    }
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk as Buffer));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}
