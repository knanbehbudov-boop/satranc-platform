# Karar kaydı

Uygulama planındaki karar kaydının kod tarafındaki kopyası. Kod bu tabloya uyar;
bir karar değişirse önce bu dosya, sonra ilgili modül ve testleri güncellenir.

## Plan aşamasında verilen kararlar (K1–K10)

| #   | Konu                              | Karar                                                                                               | Modül   | Kodda                                   |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------- | ------- | --------------------------------------- |
| K1  | Hazır olmayan oyuncu, yedek liste | MVP/V1'de standby yok; onay vermeyen hükmen elenir, rakip walkover ile geçer. V2'de ön provizyon.   | M5, M7  | Bölüm 4                                 |
| K2  | İki oyuncu da gelmezse            | İkisi de elenir; üst turdaki rakip walkover ile geçer.                                              | M5      | Bölüm 4                                 |
| K3  | Gecikme telafisi                  | Yapılandırılabilir, başlangıç 300 ms.                                                               | M3      | Bölüm 3                                 |
| K4  | Yuvarlama artığı                  | En yüksek ödüle eklenir.                                                                            | M8      | Bölüm 5                                 |
| K5  | Armageddon rengi                  | Sunucuda rastgele atanır ve kaydedilir; bidding V2.                                                 | M2, M5  | `armageddonClocks()`; renk Bölüm 4      |
| K6  | Ücretli giriş için minimum oyun   | İnsan rakiplere karşı 10 rated oyun; bot oyunları sayılmaz.                                         | M6      | Bölüm 3                                 |
| K7  | Ledger hesap planı                | USER_PAYMENT_IN geçici tahsilat hesabı.                                                             | M8      | Bölüm 5                                 |
| K8  | Elenme durumu                     | `entries.status` ELIMINATED; final_rank 3/5/9/17.                                                   | M5      | Bölüm 4                                 |
| K9  | PSP ücreti                        | Yaklaşım A: komisyondan karşılanır.                                                                 | M8, M14 | Bölüm 5                                 |
| K10 | Komisyon oranı                    | %12–15 bandı.                                                                                       | M8      | Bölüm 5                                 |

## Bölüm 1'de (M2) verilen ek kararlar

Doküman bu noktalarda değer vermiyordu; kod yazılırken karar gerekti.

| #   | Konu                         | Karar                                                                                                                                                  | Neden                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| K11 | Tekrar ve 50 hamle           | Üç kez tekrar ve 50 hamle kuralı **otomatik** beraberliktir (talep gerekmez). `RuleSet` içinde kapatılabilir.                                          | Doküman 3.4 bunları beraberlik koşulu olarak sayıyor; çevrimiçi oyunda talep düğmesi ek kolüzyon yüzeyi. |
| K12 | Armageddon artışı            | Beyaz 5 dk, siyah 4 dk; artış mini maçın ana zaman kontrolüyle aynı.                                                                                    | Doküman yalnız temel süreyi veriyor; 3.3 ücretli oyunda artışı öneriyor.                       |
| K13 | Süre bitimi, materyal kuralı | Rakipte piyon/kale/vezir varsa kazanır. Tek hafif taş veya tek renk filler: ancak süresi biten tarafın şah dışı taşı varsa kazanır, yoksa beraberlik. | FIDE 6.9'un uygulanabilir yaklaşımı (lichess ile aynı ölçü).                                   |
| K14 | "İlk 20 hamle"nin sayımı     | Beraberlik teklifi iki taraf da 20 hamle yapınca (40 yarım hamle) açılır.                                                                              | Satrançta "hamle" iki tarafın hamlesini kapsar.                                                |
| K15 | Geçerken alma ve FEN         | FEN ve tekrar anahtarı geçerken alma karesini yalnızca yasal bir alma varsa içerir.                                                                    | FIDE 9.2: aynı pozisyon tanımı; tekrar sayımı doğru olur.                                      |
| K16 | Dış kütüphane                | Kural motoru bağımlılıksız, kendi kodumuz (chess.js yerine).                                                                                           | Lisans riski sıfır, sunucu ve tarayıcıda aynı kod; doğruluk perft ile kanıtlandı.             |

## Bölüm 2–5'te (M0, M1, M3, M4a, M5, M6) verilen ek kararlar

| #   | Konu                              | Karar                                                                                                                                                         | Neden                                                                                                         |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| K17 | Sunucu çatısı                     | NestJS yerine Node'un yerleşik `http` modülü üzerinde küçük, bağımlılıksız katmanlar (yönlendirici, PostgreSQL istemcisi, WebSocket, JWT). Modül sınırları planla aynı. | Geliştirme ortamında npm deposu kapalı; test edilemeyen kod yazılmadı. Arayüzler `pg`, `ws`, Zod'a geçişe uygun tutuldu. |
| K18 | Faz 0 ölçeği                      | Tek düğüm: canlı oyun durumu bellekte, her hamle aynı anda PostgreSQL'e yazılır; yeniden başlatmada oyunlar hamlelerden kurulur. Redis ve çok düğüm yükte açılır. | 50–500 kullanıcılık beta için yeterli; sunucu çökmesi testle doğrulandı.                                       |
| K19 | Şifre özeti                       | scrypt (N=2^15). Özet biçimi algoritma içerir; argon2id'ye geçişte girişte yeniden özetlenir.                                                                | Node 22'de yerleşik argon2 yok; scrypt OWASP'ın kabul ettiği algoritmalardan.                                 |
| K20 | Kısa oyunlar ve rating            | 2 yarım hamleden kısa oyunlar (gelmeme, ilk hamle süresi) rating'e işlenmez.                                                                                 | Gelmeyen rakip yüzünden rating değişmemeli.                                                                   |
| K21 | Armageddon ve rating              | Armageddon oyunu rating'e yarım ağırlıkla işlenir.                                                                                                           | Doküman 13.4 önerisi.                                                                                         |
| K22 | Aynı anda turnuva                 | Kullanıcı aynı anda tek aktif turnuvada bulunabilir.                                                                                                         | İki turnuvanın oyunları çakışır; hükmen kayıp ve destek yükü yaratır.                                        |
| K23 | Doğum tarihi                      | Yaş tam tarihle kontrol edilir; yalnız doğum yılı saklanır.                                                                                                   | 18. doğum günü sınırında doğru karar + veri en aza indirme (GDPR).                                            |
| K24 | Hazır olma ve ilk oyun            | İlk tur oyunu hazır olma bitince 3 sn sonra başlar; oyuncu oyun ekranına otomatik yönlendirilir.                                                              | Kullanıcının maçı kaçırmaması için.                                                                           |
| K25 | Bot motoru                        | Stockfish varsa onu (STOCKFISH_PATH), yoksa aynı UCI protokolünü konuşan yerleşik motor. Yerleşik motor zayıftır; üretimde Stockfish kullanılır.              | Bu ortama Stockfish kurulamadı; UCI sürücüsü yerleşik motorla gerçekten test edildi.                         |
| K26 | Ücretli oyunu izleme              | Ücretli oyunlarda izleyici canlı oyunu göremez (oyun bitince görür).                                                                                          | Doküman 14.2 Katman 1'in Faz 0 karşılığı; gecikmeli yayın Dalga 2'de.                                         |
