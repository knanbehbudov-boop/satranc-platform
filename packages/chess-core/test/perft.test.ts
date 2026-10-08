import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFen, perft } from '../src/index.ts';
import { PERFT_CASES } from './fixtures.ts';

describe('perft — hamle üreticisi doğruluğu', () => {
  for (const c of PERFT_CASES) {
    c.counts.forEach((expected, i) => {
      const depth = i + 1;
      it(`${c.name} — derinlik ${depth} = ${expected}`, () => {
        assert.equal(perft(parseFen(c.fen), depth), expected);
      });
    });
  }
});
