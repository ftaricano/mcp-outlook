import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('legacy minimatch dependency compatibility', () => {
  it.each(['glob', 'readdir-glob'])(
    '%s can expand braces with its declared dependency tree',
    (parent) => {
      const parentRequire = createRequire(require.resolve(`${parent}/package.json`));
      const minimatchRequire = createRequire(parentRequire.resolve('minimatch/package.json'));
      const minimatch = minimatchRequire('minimatch') as (
        candidate: string,
        pattern: string
      ) => boolean;

      expect(minimatch('a.txt', '{a,b}.txt')).toBe(true);
      expect(minimatch('c.txt', '{a,b}.txt')).toBe(false);
    }
  );
});
