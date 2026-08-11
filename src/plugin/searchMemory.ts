import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const MAX_VARIANTS = 6;

const aliasValueSchema = z.union([z.string(), z.array(z.string())]);

const memoryFileSchema = z
  .object({
    apelidos: z.record(z.string(), aliasValueSchema).default({}),
    grupos: z.record(z.string(), z.array(z.string())).default({}),
    stopwords: z.array(z.string()).default([]),
  })
  .loose();

export class SearchMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchMemoryError';
  }
}

export interface SearchMemory {
  /** chave normalizada (lowercase, sem acento) → apelidos originais */
  readonly aliasesByName: ReadonlyMap<string, readonly string[]>;
  /** chave normalizada da empresa-membro → nome original do grupo */
  readonly groupByMember: ReadonlyMap<string, string>;
  /** chave normalizada do grupo → empresas originais */
  readonly membersByGroup: ReadonlyMap<string, readonly string[]>;
  readonly stopwords: readonly string[];
}

export function normalizeKey(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function normalizeLookupKey(value: string, stopwords: ReadonlySet<string>): string {
  return normalizeKey(value)
    .split(/\s+/)
    .filter((token) => token && !stopwords.has(token))
    .join(' ');
}

export function loadSearchMemory(path: string | undefined): SearchMemory | null {
  if (!path?.trim()) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new SearchMemoryError('Search memory file is not available');
  }

  let parsed: z.output<typeof memoryFileSchema>;
  try {
    const result = memoryFileSchema.safeParse(parse(raw));
    if (!result.success) throw new Error('schema');
    parsed = result.data;
  } catch {
    throw new SearchMemoryError('Search memory file is invalid');
  }

  const stopwords = Object.freeze([
    ...new Set(parsed.stopwords.map(normalizeKey).filter(Boolean)),
  ] as string[]);
  const stopwordSet = new Set(stopwords);

  const aliasesByName = new Map<string, readonly string[]>();
  for (const [name, value] of Object.entries(parsed.apelidos)) {
    const aliases = Array.isArray(value) ? value : [value];
    const key = normalizeLookupKey(name, stopwordSet);
    if (key) aliasesByName.set(key, Object.freeze([...aliases]));
  }

  const groupByMember = new Map<string, string>();
  const membersByGroup = new Map<string, readonly string[]>();
  for (const [group, members] of Object.entries(parsed.grupos)) {
    const groupKey = normalizeLookupKey(group, stopwordSet);
    if (groupKey) membersByGroup.set(groupKey, Object.freeze([...members]));
    for (const member of members) {
      const memberKey = normalizeLookupKey(member, stopwordSet);
      if (memberKey) groupByMember.set(memberKey, group);
    }
  }

  return Object.freeze({
    aliasesByName,
    groupByMember,
    membersByGroup,
    stopwords,
  });
}

export function expandTerm(memory: SearchMemory, term: string): string[] {
  const stopwords = new Set(memory.stopwords);
  const key = normalizeLookupKey(term, stopwords);
  const variants: string[] = [term];
  const seen = new Set([key]);

  const push = (candidate: string): void => {
    const candidateKey = normalizeLookupKey(candidate, stopwords);
    if (seen.has(candidateKey) || variants.length >= MAX_VARIANTS) return;
    seen.add(candidateKey);
    variants.push(candidate);
  };

  for (const alias of memory.aliasesByName.get(key) ?? []) push(alias);

  const group = memory.groupByMember.get(key);
  if (group) push(group);

  for (const member of memory.membersByGroup.get(key) ?? []) push(member);

  return variants;
}
