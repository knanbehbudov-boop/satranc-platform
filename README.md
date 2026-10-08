# Satranç Turnuva Platformu

Ücretli girişli, eleme usulü çevrimiçi satranç turnuvası platformu. Modüler monolit,
TypeScript, PostgreSQL. Plan: "Satranç Turnuva Platformu — Modül Bazlı Uygulama Planı".
Kararlar: [`docs/kararlar.md`](docs/kararlar.md) (K1–K26).

## Durum: Dalga 1 (Faz 0, ücretsiz çekirdek) tamam

| Bölüm | Modül                               | Durum     | Kanıt                                                                  |
| ----- | ----------------------------------- | --------- | ---------------------------------------------------------------------- |
| 1     | M2 Satranç çekirdeği                | Tamam     | 62 test, 20 perft sayımı, tarayıcı test masası                          |
| 2     | M0 Altyapı + M1 Kimlik              | Tamam     | 20 test: kayıt/18+, e-posta doğrulama, oturum çalıntı tespiti, CSRF     |
| 3     | M3 Oyun sunucusu ve saat            | Tamam     | 21 test: saat, bayrak, ilk hamle, kopma, sunucu yeniden başlatma         |
| 4     | M5 Turnuva motoru (ücretsiz)        | Tamam     | 23 test: tam turnuva, Armageddon, hazır olma, eşzamanlı katılım          |
| 5     | M4a Bot + M6 Rating                 | Tamam     | 16 test: UCI sürücüsü, bot oyunu, Glicko-2 (Glickman örneği)            |
| —     | M14 Web arayüzü (MVP ekranları)     | Tamam     | Uçtan uca tarayıcı testi: kayıt → bot oyunu → turnuva şampiyonluğu      |
| —     | Simülasyon (M15)                    | Tamam     | 75 eşzamanlı turnuva, 360 oyuncu, 584 oyun, tutarlılık kontrolleri      |
| Sıradaki | Dalga 2: M8 Ledger, M7 Ödeme (sandbox), ücretli kayıt, M4b analiz, M13 yönetim | Bekliyor | |

## Çalıştırma

### A) Docker ile (en kolay)

```bash
docker compose up --build
```

Tarayıcıda http://localhost:8080 açın. PostgreSQL de birlikte başlar.

### B) Node + yerel PostgreSQL ile

Gereken: Node.js 22.18+ ve PostgreSQL 14+ (`initdb`, `pg_ctl` yolda ya da `/usr/lib/postgresql/*/bin`).

```bash
npm run db:start      # proje klasöründe (.data/pg) ayrı bir PostgreSQL kümesi kurar ve başlatır
npm start             # web paketini üretir, sunucuyu başlatır → http://127.0.0.1:8080
```

Harici npm bağımlılığı yoktur; `npm install` yalnız tip kontrolü (`typescript`) ve tarayıcı
testleri (`playwright`) için gerekir.

## Neyi deneyebilirsiniz

1. **Kayıt:** Kayıt ol → "Doğrula ve giriş yap". Gerçek e-posta gönderilmez; geliştirme posta
   kutusu kullanılır. 18 yaş altı doğum tarihi reddedilir.
2. **Bot:** Lobide "Antrenman: bota karşı" → seviye, renk, süre seç. Saatler sunucudan gelir.
3. **Turnuva:** "Ücretsiz 4 kişilik Blitz" turnuvasına katılın. 4 kişi dolunca "Hazırım" sayacı
   başlar, eşleşmeler açıklanır, oyun ekranına otomatik geçilir. Tek başına denemek için farklı
   tarayıcı profillerinden (ya da gizli pencerelerden) 4 hesap açın.
4. **Adillik:** Turnuva sayfasında yayınlanan seed özeti ve başlangıçta açıklanan seed → "Doğrula".
5. **Dayanıklılık:** Oyun sırasında sunucuyu durdurup yeniden başlatın; oyun kaldığı yerden sürer
   ve kesinti süresi saatten düşülmez.

## Testler

```bash
npm test              # 142 birim + entegrasyon testi (yerel PostgreSQL gerekir: npm run db:start)
npm run e2e           # gerçek Chromium'da uçtan uca akış (Playwright)
npm run simulate      # eşzamanlı turnuva simülasyonu: node scripts/simulate.mjs 60 15
npm run test:browser  # Bölüm 1 test masası kontrolü
npm run check         # hepsi
```

## Klasörler

```
packages/chess-core/        M2: kurallar, FEN/SAN/UCI/PGN, zaman kontrolü (sunucu + tarayıcı)
packages/server/
  migrations/               SQL şeması (geri alınamaz değişiklik yok; her değişiklik yeni dosya)
  src/infra/                M0: PostgreSQL istemcisi, HTTP yönlendirici, WebSocket, outbox, log
  src/modules/identity/     M1: kayıt, doğrulama, giriş, oturum, cihaz
  src/modules/game/         M3: saat, oyun sunucusu, kurtarma
  src/modules/bot/          M4a: UCI sürücüsü, seviyeler, yerleşik motor
  src/modules/rating/       M6: Glicko-2, havuzlar
  src/modules/tournament/   M5: durum makinesi, commit-reveal, bracket, mini maç
  test/                     entegrasyon testleri, senaryolu oyuncu
apps/web/public/            M14: web arayüzü (çerçevesiz)
apps/demo-chess/            Bölüm 1 test masası
scripts/                    yerel DB, derleme, uçtan uca test, simülasyon
docs/kararlar.md            karar kaydı
```

## Bilinen sınırlar (bilerek ertelenenler)

- **Stockfish** bu geliştirme ortamına kurulamadı; bot yerleşik motorla çalışır ve zayıftır.
  `STOCKFISH_PATH` verildiğinde aynı sürücü Stockfish'i kullanır.
- **E-posta** gerçek sağlayıcıya bağlı değil (M12); geliştirme posta kutusu kullanılıyor.
- **Google ile giriş ve 2FA** planda V1 kapsamında; henüz yok.
- **Çok düğüm ve Redis** (K18): Faz 0 tek düğüm. Yük testinden sonra açılacak.
- **Ücretli turnuva, ödeme, ledger, KYC** Dalga 2–3 kapsamında; giriş ücreti > 0 olan şablon reddedilir.
- **Yönetim paneli** yalnız şablon API'si; arayüzü Dalga 2'de (M13).
- **Docker dosyaları** bu ortamda Docker çalışmadığı için denenemedi; B yolu tam test edildi.
