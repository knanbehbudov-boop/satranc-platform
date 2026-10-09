import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  buildBracket,
  canTransition,
  eliminationRank,
  judgeMatch,
  TIEBREAK_TIME_CONTROL,
  roundName,
  seedCommitment,
  seedPositions,
  verifiableShuffle,
} from '../src/modules/tournament/rules.ts';

describe('M5 durum makinesi', () => {
  it('izinli ve yasak geçişler', () => {
    assert.ok(canTransition('OPEN', 'FULL'));
    assert.ok(canTransition('STARTING', 'CANCELLED'));
    assert.ok(canTransition('SETTLING', 'DISPUTED'));
    assert.ok(!canTransition('OPEN', 'RUNNING'), 'kontenjan dolmadan başlayamaz');
    assert.ok(!canTransition('SETTLED', 'OPEN'), 'son durumdan çıkış yok');
    assert.ok(!canTransition('RUNNING', 'CANCELLED'), 'başlamış turnuva iptal değil, ABORTED olur');
  });
});

describe('M5 bracket', () => {
  for (const [n, matches] of [[4, 3], [8, 7], [16, 15], [32, 31]] as const) {
    it(`${n} oyuncu: ${matches} maç, tek final, her maçın tek üst maçı`, () => {
      const b = buildBracket(n);
      assert.equal(b.length, matches);
      const finals = b.filter((m) => m.next === null);
      assert.equal(finals.length, 1);
      // Her üst maça tam iki maç bağlanır, biri a biri b tarafına.
      for (const m of b.filter((x) => x.round > 1)) {
        const feeders = b.filter((x) => x.next?.round === m.round && x.next.slot === m.slot);
        assert.deepEqual(feeders.map((f) => f.next?.side).sort(), ['a', 'b']);
      }
    });
  }

  it('geçersiz kontenjan reddedilir', () => {
    assert.throws(() => buildBracket(6));
    assert.throws(() => buildBracket(2));
  });

  it('elenme sıralaması (K8) ve tur adları', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map((r) => eliminationRank(r, 5)), [17, 9, 5, 3, 2]);
    assert.deepEqual([1, 2].map((r) => eliminationRank(r, 2)), [3, 2]);
    assert.deepEqual([1, 2, 3].map((r) => roundName(r, 3)), ['Çeyrek final', 'Yarı final', 'Final']);
  });

  it('klasik tohum yerleşimi: 8 → 1-8, 4-5, 2-7, 3-6', () => {
    assert.deepEqual(seedPositions(8), [1, 8, 4, 5, 2, 7, 3, 6]);
    assert.deepEqual(seedPositions(4), [1, 4, 2, 3]);
    assert.equal(new Set(seedPositions(32)).size, 32);
  });
});

describe('M5 commit-reveal', () => {
  it('aynı seed + aynı oyuncular → aynı sıra; giriş sırası sonucu etkilemez', () => {
    const secret = randomBytes(32).toString('hex');
    const tid = randomUUID();
    const players = Array.from({ length: 8 }, () => randomUUID());
    const a = verifiableShuffle(players, secret, tid);
    const b = verifiableShuffle([...players].reverse(), secret, tid);
    assert.deepEqual(a, b);
    assert.deepEqual([...a].sort(), [...players].sort());
    assert.equal(seedCommitment(secret).length, 64);
  });

  it('farklı seed farklı sıra üretir ve dağılım yaklaşık düzgündür', () => {
    const players = ['a', 'b', 'c', 'd'];
    const firstCounts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let i = 0; i < 4000; i++) {
      const order = verifiableShuffle(players, randomBytes(16).toString('hex'), 't');
      const k = order[0] as string;
      firstCounts[k] = (firstCounts[k] ?? 0) + 1;
    }
    for (const n of Object.values(firstCounts)) assert.ok(n > 850 && n < 1150, JSON.stringify(firstCounts));
  });
});

describe('M5 maç: tek oyun + beraberlikte 1 dakikalık tekrar oyunları', () => {
  const g = (gameNo: number, aWasWhite: boolean, result: '1-0' | '0-1' | '1/2-1/2') => ({ gameNo, aWasWhite, result });

  it('ilk oyun kazanılırsa maç biter', () => {
    assert.deepEqual(judgeMatch([g(1, true, '1-0')]), { kind: 'decided', winner: 'a', scoreA: 1, scoreB: 0, by: 'game' });
    assert.deepEqual(judgeMatch([g(1, true, '0-1')]), { kind: 'decided', winner: 'b', scoreA: 0, scoreB: 1, by: 'game' });
  });

  it('beraberlik tekrar oyunu ister, renkler değişir', () => {
    assert.deepEqual(judgeMatch([g(1, true, '1/2-1/2')]), { kind: 'tiebreak', gameNo: 2, aWhite: false });
    assert.deepEqual(judgeMatch([g(1, true, '1/2-1/2'), g(2, false, '1/2-1/2')]), { kind: 'tiebreak', gameNo: 3, aWhite: true });
  });

  it('biri kazanana kadar devam eder; beraberlik kimseye üstünlük vermez', () => {
    const draws = Array.from({ length: 9 }, (_, i) => g(i + 1, i % 2 === 0, '1/2-1/2'));
    assert.deepEqual(judgeMatch(draws), { kind: 'tiebreak', gameNo: 10, aWhite: false });
    const v = judgeMatch([...draws, g(10, false, '1-0')]);
    assert.deepEqual(v, { kind: 'decided', winner: 'b', scoreA: 4.5, scoreB: 5.5, by: 'tiebreak' });
  });

  it('tekrar oyunu 1 dakika, artışsız', () => {
    assert.equal(TIEBREAK_TIME_CONTROL, '60+0');
  });
});
