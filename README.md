# Satranç Turnuva Platformu

Ücretli girişli, eleme usulü çevrimiçi satranç turnuvası platformu. Modüler monolit,
TypeScript. Plan: "Satranç Turnuva Platformu — Modül Bazlı Uygulama Planı" dokümanı.
Kararlar: [`docs/kararlar.md`](docs/kararlar.md).

## Bölüm durumu

| Bölüm | Modül                         | Durum                | Nasıl kontrol edilir                         |
| ----- | ----------------------------- | -------------------- | -------------------------------------------- |
| 1     | M2 Satranç çekirdeği          | **Tamam**            | `npm run check` ve test masası sayfası       |
| 2     | M0 Altyapı + M1 Kimlik        | Sırada               |                                              |
| 3     | M3 Oyun sunucusu ve saat      | Bekliyor             |                                              |
| 4     | M5 Turnuva motoru (ücretsiz)  | Bekliyor             |                                              |
| 5     | M4a Bot + M6 Rating           | Bekliyor             |                                              |

## Gereksinim

- Node.js 22.18 veya üzeri (TypeScript dosyalarını derlemeden çalıştırır).
- `npm install` yalnızca tip kontrolü ve tarayıcı testi için gerekir; çekirdeğin
  kendisi hiçbir pakete bağımlı değildir.

## Komutlar

```bash
npm test              # 62 birim testi (perft, kurallar, FEN, SAN, PGN, zaman)
npm run typecheck     # TypeScript katı mod tip kontrolü
npm run build:demo    # dist/satranc-test-masasi.html sayfasını üretir
npm run test:browser  # sayfayı Chromium'da açar, 22 kontrolü tıklayarak yapar (Playwright gerekir)
npm run check         # hepsi sırayla
```

Test masası (`dist/satranc-test-masasi.html`) tek dosyadır; çift tıklayıp tarayıcıda açılabilir.

## Klasörler

```
packages/chess-core/   M2: kurallar, FEN/SAN/UCI/PGN, zaman kontrolü, kural setleri
  src/                 saf kod: veritabanı, ağ, saat ve rastgelelik yok
  test/                node:test birim testleri ve perft referans değerleri
apps/demo-chess/       test masası şablonu ve etkileşim kodu
scripts/               test masası derlemesi ve tarayıcı kontrolü
docs/kararlar.md       karar kaydı (K1–K16)
```
