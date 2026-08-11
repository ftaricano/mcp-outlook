import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandTerm, loadSearchMemory } from '../../src/plugin/searchMemory.js';

function writeMemory(yamlText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'search-memory-'));
  const file = join(dir, 'memory.yaml');
  writeFileSync(file, yamlText, { mode: 0o600 });
  return file;
}

const SAMPLE = `
apelidos:
  "FUNDACAO EXEMPLO DE PREVIDENCIA": ["FEP"]
grupos:
  "GRUPO NAUTICO": ["Empresa Alfa Navegacao", "Empresa Beta Offshore"]
stopwords: ["LTDA", "GRUPO", "SA"]
outros_campos_privados:
  ignorado: true
`;

describe('loadSearchMemory', () => {
  it('parses aliases, groups and stopwords, ignoring unknown keys', () => {
    const memory = loadSearchMemory(writeMemory(SAMPLE));
    expect(memory).not.toBeNull();
    expect(memory?.stopwords).toContain('ltda');
  });

  it('returns null when no path is given', () => {
    expect(loadSearchMemory(undefined)).toBeNull();
  });

  it('throws a redacted error for unreadable or invalid files', () => {
    expect(() => loadSearchMemory('/nonexistent/memory.yaml')).toThrow(
      /search memory file is not available/i
    );
    expect(() => loadSearchMemory(writeMemory('apelidos: [not, a, map]'))).toThrow(
      /search memory file is invalid/i
    );
  });
});

describe('expandTerm', () => {
  const memory = loadSearchMemory(writeMemory(SAMPLE))!;

  it('expands an official name into its alias, case and accent insensitive', () => {
    const variants = expandTerm(memory, 'Fundação Exemplo de Previdência');
    expect(variants[0]).toBe('Fundação Exemplo de Previdência');
    expect(variants).toContain('FEP');
  });

  it('expands a group member into the group name', () => {
    const variants = expandTerm(memory, 'Empresa Alfa Navegacao');
    expect(variants).toContain('GRUPO NAUTICO');
  });

  it('uses configured stopwords when matching a member name', () => {
    const variants = expandTerm(memory, 'Empresa Alfa Navegacao LTDA');
    expect(variants).toContain('GRUPO NAUTICO');
  });

  it('expands a group name into its member companies', () => {
    const variants = expandTerm(memory, 'grupo nautico');
    expect(variants).toEqual(
      expect.arrayContaining(['Empresa Alfa Navegacao', 'Empresa Beta Offshore'])
    );
  });

  it('dedupes and caps the number of variants', () => {
    const variants = expandTerm(memory, 'Empresa Alfa Navegacao');
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants.length).toBeLessThanOrEqual(6);
  });

  it('returns just the original term when nothing matches', () => {
    expect(expandTerm(memory, 'Cliente Desconhecido')).toEqual(['Cliente Desconhecido']);
  });
});
