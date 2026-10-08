# Satranç Turnuva Platformu

Ücretli girişli, eleme usulü çevrimiçi satranç turnuvası platformu. Modüler monolit,
TypeScript, PostgreSQL. Plan: "Satranç Turnuva Platformu — Modül Bazlı Uygulama Planı".
Kararlar: [`docs/kararlar.md`](docs/kararlar.md) (K1–K40).

## Durum: Dalga 1 + Dalga 2 tamam (ücretli turnuva uçtan uca, sandbox ödeme ile)

| Bölüm | Modül                                   | Kanıt                                                                                         |
| ----- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1     | M2 Satranç çekirdeği                    | 62 test, 20 perft sayımı, tarayıcı test masası                                                 |
| 2     | M0 Altyapı + M1 Kimlik                  | 20 test: kayıt/18+, e-posta doğrulama, oturum çalıntı tespiti                                   |
| 3     | M3 Oyun sunucusu ve saat                | 21 test: saat, bayrak, ilk hamle, kopma, sunucu yeniden başlatma                                |
| 4     | M5 Turnuva motoru                       | 23 test: tam turnuva, Armageddon, hazır olma, eşzamanlı katılım                                 |
| 5     | M4a Bot + M6 Rating                     | 16 test: UCI sürücüsü, bot oyunu, Glicko-2                                                     |
| 6     | M8 Çift taraflı defter                  | 13 test: DB tetikleyicileriyle denge/değişmezlik, ödül matematiği (280 kombinasyon), rastgele işlem dizileri |
| 7     | M7 Ödeme (sandbox + Stripe)             | 26 test: imza, yinelenen/eşzamanlı webhook, 3DS, red, iade kuyruğu, ters ibraz, mutabakat      |
| 8     | Ücretli kayıt, hesaplaşma, cüzdan       | 10 test: rezervasyon, süre dolumu, yetim iade, ayrılma, iptal, ödül bekletme, kill switch       |
| 9     | M4b Analiz + M10 Adil oyun (temel)      | 14 test: MultiPV analiz, risk modeli, odak telemetrisi, vaka → ödül kapısı → iptal (K29)       |
| 10    | M13 Yönetim paneli                      | 10 test: rol denetimi, dört göz, acil durdurma, elle iade, vaka kararı                          |
| 11    | Uçtan uca doğrulama                     | Tarayıcı testi (30 kontrol) + para simülasyonu (aşağıda)                                       |

Toplam **215 otomatik test**. Ek olarak:

- `npm run e2e` — gerçek Chromium: kayıt → bot → ücretsiz turnuva şampiyonluğu → **ücretli turnuva:
  ödeme sayfası, 3D Secure, webhook ile koltuk onayı, oyun, ödül, bekletme, cüzdan** → yönetim
  panelinde dört göz onayı → telefon genişliği.
- `npm run simulate` — 75 eşzamanlı ücretsiz turnuva (tutarlılık).
- `npm run simulate:money` — eşzamanlı ücretli turnuvalar; webhook'ların %50'si iki kez gelir;
  reddedilen kart, ödenmeyen rezervasyon, süre dolunca ödeme, ödeyip ayrılma, yönetici iptali,
  hile kararı, ters ibraz ve iadeler yoldayken **sunucu yeniden başlatma**. Sonunda: defter dengeli,
  her turnuvada komisyon + ödüller = koltuk × ücret (1 cent fark yok), emanetler ve geçici hesap
  sıfır, her olay tam bir kez işlendi, mutabakat farkı 0.

## İnternette test sunucusu (bilgisayar gerekmez, iPad'den)

`render.yaml` dosyası Render.com için hazır bir kurulumdur: test sunucusu + PostgreSQL, ücretsiz plan.

1. Kod bir GitHub deposunda olmalı.
2. `https://render.com/deploy?repo=https://github.com/<kullanıcı>/<depo>` adresini açın, GitHub ile giriş yapın, **Apply**.
3. 5–10 dk sonra `https://satranc-xxxx.onrender.com` adresi hazır olur.

Bu kurulumda `DEMO_TOOLS=1`: **ilk iki kayıt olan hesap yönetici olur**, ödemeler sahtedir (test kartı
`4242 4242 4242 4242`), ve yönetici turnuva sayfasında **"Bana bir koltuk bırakıp botlarla doldur"** ile
turnuvayı tek başına başlatabilir. Ücretsiz planda sunucu 15 dk hareketsizlikte uyur; ilk açılış ~1 dk sürer.
Ücretsiz PostgreSQL 30 gün sonra silinir. `DEMO_TOOLS` üretimde açılamaz.

## Çalıştırma

### A) Docker ile (en kolay)

```bash
docker compose up --build
```

Tarayıcıda http://localhost:8080 açın. PostgreSQL de birlikte başlar. İmaj Stockfish içerir.

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
3. **Ücretsiz turnuva:** "Ücretsiz 4 kişilik Blitz"e katılın. 4 kişi dolunca "Hazırım" sayacı
   başlar. Tek başına denemek için farklı tarayıcı profillerinden (ya da gizli pencerelerden) 4 hesap açın.
4. **Ücretli turnuva (gerçek para yok, sandbox):** Yerelde hızlı denemek için `.env` dosyasında
   `PAID_MIN_RATED_GAMES=0` (K6: normalde 10 rated oyun gerekir) ve `PRIZE_HOLD_SEC=30` yapın.
   "5 USD · 4 kişilik Blitz" → "Katıl" → ödeme sağlayıcısının sayfası açılır. Test kartları:
   - `4242 4242 4242 4242` başarılı · `4000 0000 0000 3220` 3D Secure ister
   - `4000 0000 0000 0002` reddedilir · `4000 0000 0000 9995` yetersiz bakiye
   - herhangi bir gelecek tarih (12/30) ve 3 haneli CVC

   Dönüşte koltuk webhook ile onaylanır. Turnuva bitince ödüller turnuva sayfasında ve
   **Cüzdan**'da "bekletmede" görünür; analiz ve bekletme bitince "çekilebilir"e geçer.
5. **Yönetim paneli:** `node scripts/make-admin.mjs <e-posta> admin` → sayfayı yenileyin →
   menüde **Yönetim**. Dört göz onaylarını denemek için iki yönetici hesabı gerekir.
   Rol seçenekleri: `admin`, `finance`, `fairplay`.
6. **Adillik:** Turnuva sayfasında seed özeti → başlangıçta açıklanan seed → "Doğrula".
7. **Dayanıklılık:** Oyun ya da ödeme sırasında sunucuyu durdurup yeniden başlatın; oyun, webhook
   ve iadeler kaldığı yerden sürer.

## Testler

```bash
npm test                 # 215 birim + entegrasyon testi (yerel PostgreSQL: npm run db:start)
npm run e2e              # gerçek Chromium'da uçtan uca akış (Playwright)
npm run simulate         # ücretsiz turnuva simülasyonu: node scripts/simulate.mjs 60 15
npm run simulate:money   # ücretli turnuva + para simülasyonu: node scripts/simulate-money.mjs 8 3
npm run check            # hepsi
```

## Üretime çıkmadan önce (bu sürümde bilerek yapılmayanlar)

- **Gerçek ödeme sağlayıcısı:** Stripe bağdaştırıcısı yazıldı ve sahte sunucuyla test edildi;
  gerçek Stripe test hesabıyla (`PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `PSP_WEBHOOK_SECRET`,
  `PUBLIC_BASE_URL`) denenmesi gerekiyor. Stripe mutabakatı (Balance Transactions raporu) Faz 2.
- **Para çekme + KYC + 2FA** (K37): cüzdanda bakiye görünür, çekim kapalı.
- **Hukuk:** ülke bazlı uygunluk (beceri oyunu / kumar ayrımı), Kullanım Şartları, vergi.
  Ücretli turnuvalar hukuk görüşü alınmadan açılmamalı (`paid_tournaments` bayrağı).
- **Risk modeli eşikleri** (K34) gerçek veriyle kalibre edilmeli; ilk dönemde her yüksek vaka insan
  tarafından incelenmeli.
- **E-posta** gerçek sağlayıcıya bağlı değil (M12); geliştirme posta kutusu kullanılıyor.
- **Çok düğüm ve Redis** (K18): tek düğüm. Yük testinden sonra açılacak.
- **Docker dosyaları** bu ortamda Docker çalışmadığı için denenemedi (Node + PostgreSQL yolu tam test edildi).
- **Stockfish** bu ortama kurulamadı; testler yerleşik motorla. Üretimde Stockfish zorunlu (K33).

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
  src/modules/tournament/   M5: durum makinesi, commit-reveal, bracket, mini maç, ücretli akış, hesaplaşma
  src/modules/ledger/       M8: çift taraflı defter, ödül matematiği
  src/modules/payments/     M7: sağlayıcı arayüzü, sandbox PSP (ödeme sayfası dahil), Stripe, iade, mutabakat
  src/modules/fairplay/     M4b + M10: analiz işçisi, istatistik, risk modeli, vaka kuyruğu, ödül kapısı
  src/modules/admin/        M13: yönetim API'si, dört göz, özellik bayrakları
  test/                     entegrasyon testleri, senaryolu oyuncu
apps/web/public/            M14: web arayüzü (çerçevesiz)
apps/demo-chess/            Bölüm 1 test masası
scripts/                    yerel DB, derleme, uçtan uca test, simülasyonlar, make-admin
docs/kararlar.md            karar kaydı
```
