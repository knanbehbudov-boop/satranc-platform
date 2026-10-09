/**
 * K48 — dil desteği: arayüz sözlüğü ve sunucu tarafı e-posta metinleri.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { emailText, localizeTournamentName } from '../src/infra/i18n.ts';

function loadI18n(lang: string) {
  const ctx: Record<string, unknown> = {
    window: {},
    navigator: { language: lang },
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'loading', addEventListener() {} },
    location: {},
  };
  vm.runInNewContext(readFileSync(new URL('../../../apps/web/public/i18n.js', import.meta.url), 'utf8'), ctx);
  return (ctx.window as { I18N: { t(s: string): string; lang: string; rows(): string[][] } }).I18N;
}

describe('K48 arayüz sözlüğü', () => {
  it('her satır üç dilde; değişken parçalar her dilde aynı', () => {
    const I = loadI18n('en');
    const seen = new Set<string>();
    for (const row of I.rows()) {
      assert.equal(row.length, 3, JSON.stringify(row));
      assert.ok(!seen.has(row[0] as string), `tekrarlanan anahtar: ${row[0]}`);
      seen.add(row[0] as string);
      const ph = (s: string) => [...s.matchAll(/\{\d\}/g)].map((m) => m[0]).sort().join();
      assert.equal(ph(row[1] as string), ph(row[0] as string), `en: ${row[0]}`);
      assert.equal(ph(row[2] as string), ph(row[0] as string), `ru: ${row[0]}`);
      for (const s of row) assert.ok((s as string).trim() === s, `boşluk: ${JSON.stringify(s)}`);
    }
  });

  it('tarayıcı diline göre seçer; Türkçe kaynak olduğu gibi kalır', () => {
    assert.equal(loadI18n('ru-RU').lang, 'ru');
    assert.equal(loadI18n('tr').lang, 'tr');
    assert.equal(loadI18n('de-DE').lang, 'en');
    assert.equal(loadI18n('tr').t('Cüzdan'), 'Cüzdan');
  });

  it('düz, değişkenli ve iç içe metinleri çevirir', () => {
    const en = loadI18n('en');
    const ru = loadI18n('ru');
    assert.equal(en.t('Cüzdan'), 'Wallet');
    assert.equal(ru.t('Cüzdan'), 'Кошелёк');
    assert.equal(en.t('  Lobi '), '  Lobby ', 'baştaki/sondaki boşluk korunur');
    assert.equal(en.t('20 USD · 8 kişi · 5 dk'), '20 USD · 8 players · 5 min');
    assert.equal(en.t('Kolay (~1200)'), 'Easy (~1200)');
    assert.equal(ru.t('Ücretli turnuvalar için en az 5 rated oyun gerekli (şu an 2). Ücretsiz turnuvalarda oynayarak tamamlayabilirsin.'),
      'Для платных турниров нужно не менее 5 рейтинговых партий (сейчас 2). Их можно набрать, играя в бесплатных турнирах.');
    assert.equal(en.t('kullanıcının yazdığı bilinmeyen metin'), 'kullanıcının yazdığı bilinmeyen metin');
  });
});

describe('K48 e-posta metinleri', () => {
  it('turnuva adı ve e-postalar üç dilde', () => {
    assert.equal(localizeTournamentName('10 USD · 8 kişi · 5 dk', 'en'), '10 USD · 8 players · 5 min');
    assert.equal(localizeTournamentName('Ücretsiz 4 kişilik Blitz', 'ru'), 'Бесплатный блиц · 4 уч.');
    assert.equal(localizeTournamentName('Özel ad', 'en'), 'Özel ad');
    for (const l of ['tr', 'en', 'ru'] as const) {
      const m = emailText(l).withdrawalPaid();
      assert.ok(m.subject.length > 5 && m.body.length > 20);
    }
    assert.match(emailText('en').greeting('Ali'), /^Hi Ali/);
    assert.match(emailText('ru').signature, /Шахматные турниры/);
  });
});
