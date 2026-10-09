// Dil desteği (K48): Türkçe (kaynak), İngilizce, Rusça.
// Arayüz Türkçe yazılır; bu dosya ekrana gelen her metni (sayfa, düğme, uyarı, sunucu hata mesajı)
// seçilen dile çevirir. Değişken parçalı metinler {0}, {1} kalıplarıyla eşleşir; parçalar da çevrilir.
// Yeni metin eklenince buraya da eklenmeli: `node scripts/check-i18n.mjs` eksikleri listeler.
// Yönetim paneli yalnız ekip içindir ve Türkçe kalır.
(() => {
  'use strict';
  const SUPPORTED = ['tr', 'en', 'ru'];
  const NAMES = { tr: 'Türkçe', en: 'English', ru: 'Русский' };
  const INTL = { tr: 'tr-TR', en: 'en-US', ru: 'ru-RU' };

  /** [Türkçe, English, Русский] */
  const D = [
    // marka ve gezinti
    ['Satranç Turnuvaları', 'Chess Tournaments', 'Шахматные турниры'],
    ['Satranç', 'Chess', 'Шахматы'],
    ['Turnuvaları', 'Tournaments', 'Турниры'],
    ['Ücretli turnuvalar yalnız 18 yaş ve üzeri içindir · Kart bilgileri ödeme sağlayıcısında girilir, bu sitede saklanmaz.',
      'Paid tournaments are for ages 18+ only · Card details are entered at the payment provider and are not stored on this site.',
      'Платные турниры только для лиц от 18 лет · Данные карты вводятся у платёжного провайдера и не хранятся на этом сайте.'],
    ['Dil', 'Language', 'Язык'],
    ['Lobi', 'Lobby', 'Лобби'],
    ['Cüzdan', 'Wallet', 'Кошелёк'],
    ['Asistan', 'Assistant', 'Ассистент'],
    ['Yönetim', 'Admin', 'Админ'],
    ['Ayarlar', 'Settings', 'Настройки'],
    ['Çıkış', 'Log out', 'Выйти'],
    ['Giriş', 'Log in', 'Вход'],
    ['Kayıt ol', 'Sign up', 'Регистрация'],
    ['Yükleniyor…', 'Loading…', 'Загрузка…'],
    ['Bağlantı koptu, yeniden bağlanılıyor…', 'Connection lost, reconnecting…', 'Соединение потеряно, переподключение…'],
    ['İstek başarısız ({0})', 'Request failed ({0})', 'Запрос не выполнен ({0})'],

    // havuzlar, durumlar, oyun sonu sebepleri
    ['Bullet', 'Bullet', 'Пуля'],
    ['Blitz', 'Blitz', 'Блиц'],
    ['Rapid', 'Rapid', 'Рапид'],
    ['Klasik', 'Classical', 'Классика'],
    ['Bot', 'Bot', 'Бот'],
    ['Kayıt açık', 'Registration open', 'Регистрация открыта'],
    ['Doldu', 'Full', 'Заполнен'],
    ['Hazır olma', 'Ready check', 'Проверка готовности'],
    ['Oynanıyor', 'In progress', 'Идёт игра'],
    ['Bitti', 'Finished', 'Завершён'],
    ['Sonuçlanıyor', 'Settling', 'Подведение итогов'],
    ['Tamamlandı', 'Completed', 'Завершён'],
    ['İptal', 'Cancelled', 'Отменён'],
    ['Durduruldu', 'Stopped', 'Остановлен'],
    ['İncelemede', 'Under review', 'На проверке'],
    ['Taslak', 'Draft', 'Черновик'],
    ['Mat', 'Checkmate', 'Мат'],
    ['Teslim', 'Resignation', 'Сдача'],
    ['Süre bitti', 'Time out', 'Время вышло'],
    ['Süre bitti; rakipte mat materyali yok', 'Time out; opponent has insufficient mating material', 'Время вышло; у соперника недостаточно материала для мата'],
    ['Pat', 'Stalemate', 'Пат'],
    ['Yetersiz materyal', 'Insufficient material', 'Недостаточно материала'],
    ['Üç kez tekrar', 'Threefold repetition', 'Троекратное повторение'],
    ['50 hamle kuralı', '50-move rule', 'Правило 50 ходов'],
    ['Anlaşmalı beraberlik', 'Draw by agreement', 'Ничья по соглашению'],
    ['Oyunu terk etti', 'Abandoned the game', 'Покинул партию'],
    ['Hükmen (zamanında oynamadı)', 'Forfeit (did not play in time)', 'Техническое поражение (не сделал ход вовремя)'],
    ['Hakem kararı', 'Arbiter decision', 'Решение арбитра'],

    // ödeme ve katılım
    ['Koltuğun artık yoktu (rezervasyon süresi dolmuş olabilir)', 'Your seat was no longer available (the reservation may have expired)', 'Твоё место уже недоступно (возможно, бронь истекла)'],
    ['Turnuva kayıtları kapanmıştı', 'Tournament registration had closed', 'Регистрация на турнир была закрыта'],
    ['Ödenen tutar beklenenle uyuşmadı', 'The amount paid did not match the expected amount', 'Оплаченная сумма не совпала с ожидаемой'],
    ['Kart reddedildi', 'Card declined', 'Карта отклонена'],
    ['Yetersiz bakiye', 'Insufficient funds', 'Недостаточно средств'],
    ['3D Secure doğrulanamadı', '3D Secure verification failed', 'Проверка 3D Secure не пройдена'],
    ['{0}\nGiriş ücreti {1} bakiyenden düşülecek (bakiyen: {2}). Katılmak istiyor musun?',
      '{0}\nThe entry fee of {1} will be deducted from your balance (balance: {2}). Do you want to join?',
      '{0}\nВзнос {1} будет списан с твоего баланса (баланс: {2}). Хочешь участвовать?'],
    ['{0}\nGiriş ücreti {1}. Bakiyen yetersiz ({2}).\n\nTamam: kartla öde (koltuğun 10 dakika ayrılır).\nİptal: vazgeç ya da önce Cüzdan\'dan bakiye yükle.',
      '{0}\nEntry fee {1}. Your balance is too low ({2}).\n\nOK: pay by card (your seat is held for 10 minutes).\nCancel: go back, or top up your balance in the Wallet first.',
      '{0}\nВзнос {1}. Недостаточно средств на балансе ({2}).\n\nОК: оплатить картой (место бронируется на 10 минут).\nОтмена: вернуться или сначала пополнить баланс в Кошельке.'],
    ['Kaydın tamam: {0} bakiyenden düşüldü.', 'You are registered: {0} was deducted from your balance.', 'Ты зарегистрирован: {0} списано с баланса.'],
    ['Koltuğun ayrıldı fakat ödeme sayfası açılamadı. Turnuva sayfasından tekrar dene.', 'Your seat is reserved but the payment page could not be opened. Try again from the tournament page.', 'Место забронировано, но страница оплаты не открылась. Попробуй снова со страницы турнира.'],
    ['{0}. Ücretsiz turnuvalarda oynayarak tamamlayabilirsin.', '{0}. You can complete them by playing in free tournaments.', '{0}. Их можно набрать, играя в бесплатных турнирах.'],

    // canlı bildirimler
    ['{0}, tekrar oyunu (1 dk)', '{0}, rematch (1 min)', '{0}, переигровка (1 мин)'],
    ['{0} {1}. Rengin: {2}.', '{0} {1}. Your color: {2}.', '{0} {1}. Твой цвет: {2}.'],
    ['{0} sn sonra başlıyor', 'starts in {0} s', 'начнётся через {0} с'],
    ['başlıyor', 'is starting', 'начинается'],
    ['{0} başlıyor', '{0} is starting', '{0} начинается'],
    ['Oyuna git', 'Go to game', 'К партии'],
    ['Ödemen alındı, koltuğun onaylandı.', 'Payment received, your seat is confirmed.', 'Оплата получена, место подтверждено.'],
    ['Turnuvaya git', 'Go to tournament', 'К турниру'],
    ['Seviye belirleme: {0}/{1} oyun tamam.', 'Placement: {0}/{1} games done.', 'Определение уровня: сыграно {0}/{1}.'],
    ['Sıradaki oyun', 'Next game', 'Следующая партия'],
    ['Seviyen belirlendi: başlangıç puanın yaklaşık {0}. Gerçek maçlarla kesinleşir.', 'Your level is set: your starting rating is about {0}. It will settle with real games.', 'Уровень определён: стартовый рейтинг около {0}. Он уточнится в реальных партиях.'],
    ['{0} bakiyene yüklendi.', '{0} was added to your balance.', '{0} зачислено на баланс.'],
    ['Para çekme talebin ödendi.', 'Your withdrawal has been paid.', 'Твой вывод средств выплачен.'],
    ['Para çekme talebin reddedildi; tutar bakiyene geri döndü.', 'Your withdrawal was rejected; the amount has been returned to your balance.', 'Вывод отклонён; сумма возвращена на баланс.'],
    ['{0}. Ücretin otomatik olarak iade ediliyor.', '{0}. Your fee is being refunded automatically.', '{0}. Взнос возвращается автоматически.'],
    ['Ödemen koltuğa bağlanamadı', 'Your payment could not be linked to a seat', 'Платёж не удалось привязать к месту'],
    ['Ödeme başarısız: {0}. Rezervasyon süresi içinde tekrar deneyebilirsin.', 'Payment failed: {0}. You can try again while your reservation lasts.', 'Платёж не прошёл: {0}. Можно попробовать снова, пока действует бронь.'],
    ['Ödeme süresi doldu; koltuğun bırakıldı.', 'Payment time ran out; your seat was released.', 'Время оплаты истекло; место освобождено.'],
    ['Turnuva', 'Tournament', 'Турнир'],
    ['Tebrikler! {0}. oldun: {1}. Ödül {2} tarihine kadar güvenlik incelemesinde bekler.', 'Congratulations! You finished {0}: {1}. The prize is held for a security review until {2}.', 'Поздравляем! Ты занял {0}-е место: {1}. Приз на проверке безопасности до {2}.'],
    ['{0} ödülün çekilebilir bakiyene geçti.', 'Your {0} prize is now in your withdrawable balance.', 'Приз {0} переведён на баланс для вывода.'],
    ['Turnuva doldu. {0} saniye içinde "Hazırım" de.', 'The tournament is full. Press "I\'m ready" within {0} seconds.', 'Турнир заполнен. Нажми «Готов» в течение {0} секунд.'],

    // giriş / kayıt
    ['E-posta', 'Email', 'Эл. почта'],
    ['Şifre', 'Password', 'Пароль'],
    ['Kullanıcı adı', 'Username', 'Имя пользователя'],
    ['Giriş yap', 'Log in', 'Войти'],
    ['Hesabın yok mu?', 'No account yet?', 'Нет аккаунта?'],
    ['Türkiye', 'Türkiye', 'Турция'],
    ['Birleşik Krallık', 'United Kingdom', 'Великобритания'],
    ['Almanya', 'Germany', 'Германия'],
    ['Hollanda', 'Netherlands', 'Нидерланды'],
    ['Fransa', 'France', 'Франция'],
    ['ABD', 'USA', 'США'],
    ['İspanya', 'Spain', 'Испания'],
    ['İtalya', 'Italy', 'Италия'],
    ['Gürcistan', 'Georgia', 'Грузия'],
    ['Kazakistan', 'Kazakhstan', 'Казахстан'],
    ['Ukrayna', 'Ukraine', 'Украина'],
    ['Rusya', 'Russia', 'Россия'],
    ['Diğer', 'Other', 'Другое'],
    ['Posta kutusunda doğrulama e-postası yok', 'No verification email in the mailbox', 'В почтовом ящике нет письма для подтверждения'],
    ['Kullanıcı adı (3–20, harf, rakam, _ -)', 'Username (3–20, letters, digits, _ -)', 'Имя пользователя (3–20, буквы, цифры, _ -)'],
    ['Şifre (en az 10 karakter)', 'Password (at least 10 characters)', 'Пароль (не менее 10 символов)'],
    ['Doğum tarihi', 'Date of birth', 'Дата рождения'],
    ['Ülke', 'Country', 'Страна'],
    ['18 yaşından büyüğüm; Kullanım Şartları ve Turnuva Kurallarını kabul ediyorum.', 'I am over 18 and accept the Terms of Use and Tournament Rules.', 'Мне больше 18 лет; я принимаю Условия использования и Правила турниров.'],
    ['Yeni turnuvalardan e-postayla haberdar olmak istiyorum (günde en fazla bir e-posta; istediğin zaman çıkabilirsin).', 'Email me about new tournaments (at most one email a day; you can unsubscribe at any time).', 'Сообщать мне о новых турнирах по почте (не более одного письма в день; можно отписаться в любой момент).'],
    ['Doğum tarihin yalnızca yaş kontrolü için kullanılır; yalnız doğum yılın saklanır.', 'Your date of birth is only used to check your age; only your birth year is stored.', 'Дата рождения используется только для проверки возраста; хранится только год рождения.'],
    ['Hesabın oluşturuldu', 'Your account has been created', 'Аккаунт создан'],
    ['{0} adresine doğrulama bağlantısı gönderdik. Turnuvalara katılmak için e-postanı doğrula.', 'We sent a verification link to {0}. Verify your email to join tournaments.', 'Мы отправили ссылку для подтверждения на {0}. Подтверди почту, чтобы участвовать в турнирах.'],
    ['Geliştirme ortamında gerçek e-posta gönderilmez; aşağıdaki düğme geliştirme posta kutusundaki bağlantıyı kullanır.', 'No real email is sent in the test environment; the button below uses the link from the test mailbox.', 'В тестовой среде настоящие письма не отправляются; кнопка ниже использует ссылку из тестового ящика.'],
    ['E-posta doğrulandı. Hoş geldin!', 'Email verified. Welcome!', 'Почта подтверждена. Добро пожаловать!'],
    ['Doğrula ve giriş yap', 'Verify and log in', 'Подтвердить и войти'],
    ['Giriş sayfası', 'Login page', 'Страница входа'],
    ['Doğrulanıyor…', 'Verifying…', 'Проверка…'],
    ['E-posta doğrulandı', 'Email verified', 'Почта подтверждена'],
    ['Lobiye dön', 'Back to lobby', 'В лобби'],
    ['metin olmalı', 'must be text', 'должно быть текстом'],
    ['biçim geçersiz', 'invalid format', 'неверный формат'],
    ['tamsayı olmalı', 'must be a whole number', 'должно быть целым числом'],
    ['doğru/yanlış olmalı', 'must be true/false', 'должно быть да/нет'],
    ['geçersiz kimlik', 'invalid id', 'неверный идентификатор'],
    ['geçersiz', 'invalid', 'неверно'],
    ['kullanımda', 'already in use', 'уже используется'],
    ['zorunlu', 'required', 'обязательно'],
    ['en az 10 karakter olmalı', 'must be at least 10 characters', 'должен быть не менее 10 символов'],
    ['en fazla 128 karakter olmalı', 'must be at most 128 characters', 'должен быть не более 128 символов'],
    ['çok yaygın bir şifre', 'is a very common password', 'слишком распространённый пароль'],
    ['tek karakterin tekrarı olamaz', 'cannot be a single repeated character', 'не может состоять из одного повторяющегося символа'],
    ['e-posta veya kullanıcı adını içeremez', 'cannot contain your email or username', 'не может содержать почту или имя пользователя'],
    ['Şifre {0}', 'Password {0}', 'Пароль: {0}'],

    // test sürümü bandı
    ['Test sürümü', 'Test version', 'Тестовая версия'],
    ['Ödemeler sahtedir, gerçek para çekilmez. Test kartı:', 'Payments are simulated; no real money is charged. Test card:', 'Платежи тестовые, реальные деньги не списываются. Тестовая карта:'],
    ['· tarih 12/30 · CVC 123.', '· expiry 12/30 · CVC 123.', '· срок 12/30 · CVC 123.'],
    ['İlk iki hesap yönetici olur. Turnuva sayfasında "Test botlarıyla doldur" ile turnuvayı tek başına başlatabilirsin.', 'The first two accounts become admins. Use "Fill with test bots" on a tournament page to start a tournament on your own.', 'Первые два аккаунта становятся администраторами. Кнопка «Заполнить тестовыми ботами» на странице турнира позволяет запустить турнир в одиночку.'],

    // lobi
    ['{0}/{1} dolu', '{0}/{1} joined', '{0}/{1} занято'],
    ['{0} dk · {1} kişi', '{0} min · {1} players', '{0} мин · {1} уч.'],
    ['{0} dk', '{0} min', '{0} мин'],
    ['{0} USD · {1} kişi · {2} dk', '{0} USD · {1} players · {2} min', '{0} USD · {1} уч. · {2} мин'],
    ['Ücretsiz 4 kişilik Blitz', 'Free 4-player Blitz', 'Бесплатный блиц · 4 уч.'],
    ['Ücretsiz 8 kişilik Blitz', 'Free 8-player Blitz', 'Бесплатный блиц · 8 уч.'],
    ['{0}, katıl', '{0}, join', '{0}, участвовать'],
    ['Kayıtlısın', 'Registered', 'Ты записан'],
    ['Katıl · {0}', 'Join · {0}', 'Участвовать · {0}'],
    ['Katıl', 'Join', 'Участвовать'],
    ['Turnuvam', 'My tournament', 'Мой турнир'],
    ['Görüntüle', 'View', 'Открыть'],
    ['{0} kişi', '{0} players', '{0} уч.'],
    ['Ücretsiz', 'Free', 'Бесплатно'],
    ['Ücretli turnuvalar', 'Paid tournaments', 'Платные турниры'],
    ['Kontenjan dolunca başlar · eleme usulü', 'Starts when full · knockout', 'Старт при заполнении · на выбывание'],
    ['Şu an açık ücretli turnuva yok.', 'No paid tournaments are open right now.', 'Сейчас нет открытых платных турниров.'],
    ['Süren ve başlayacak turnuvalar', 'Ongoing and upcoming tournaments', 'Текущие и предстоящие турниры'],
    ['Ücretsiz turnuvalar', 'Free tournaments', 'Бесплатные турниры'],
    ['Şu an ücretsiz turnuva yok.', 'No free tournaments right now.', 'Сейчас нет бесплатных турниров.'],
    ['Başlamak için', 'Get started', 'С чего начать'],
    ['Ücretsiz turnuvalara katılmak ve botla antrenman yapmak için hesap aç.', 'Create an account to join free tournaments and train against the bot.', 'Создай аккаунт, чтобы играть в бесплатных турнирах и тренироваться с ботом.'],
    ['Turnuvalara katılmak için e-posta adresini doğrula.', 'Verify your email address to join tournaments.', 'Подтверди адрес почты, чтобы участвовать в турнирах.'],
    ['E-posta doğrulandı.', 'Email verified.', 'Почта подтверждена.'],
    ['Geliştirme kutusundan doğrula', 'Verify from the test mailbox', 'Подтвердить из тестового ящика'],
    ['Bağlantı yeniden gönderildi.', 'Link sent again.', 'Ссылка отправлена повторно.'],
    ['Yeniden gönder', 'Send again', 'Отправить снова'],
    ['Devam eden bir oyunun var.', 'You have a game in progress.', 'У тебя идёт партия.'],
    ['Oyununa dön', 'Back to your game', 'Вернуться к партии'],
    ['Seviyeni belirle', 'Find your level', 'Определи свой уровень'],
    ['Bota karşı {0} kısa oyun oyna; bot senin oyununa göre güçlenir ya da zayıflar. Sonunda başlangıç puanın belirlenir ve sana uygun rakiplerle eşleşirsin.',
      'Play {0} short games against the bot; it gets stronger or weaker depending on how you play. At the end your starting rating is set and you are matched with suitable opponents.',
      'Сыграй {0} коротких партий с ботом; он усиливается или ослабевает в зависимости от твоей игры. В конце определяется стартовый рейтинг, и тебя сводят с подходящими соперниками.'],
    ['{0}/{1} oyun tamamlandı.', '{0}/{1} games completed.', 'Сыграно партий: {0}/{1}.'],
    ['Sıradaki oyun ({0}/{1})', 'Next game ({0}/{1})', 'Следующая партия ({0}/{1})'],
    ['Başla', 'Start', 'Начать'],
    ['Rating', 'Rating', 'Рейтинг'],
    ['{0} · {1} oyun', '{0} · {1} games', '{0} · партий: {1}'],
    ['Henüz rating yok. İlk oyunlarından sonra burada görünür.', 'No rating yet. It will appear here after your first games.', 'Рейтинга пока нет. Он появится после первых партий.'],
    ['Seviye', 'Level', 'Уровень'],
    ['Renk', 'Color', 'Цвет'],
    ['Rastgele', 'Random', 'Случайно'],
    ['Beyaz', 'White', 'Белые'],
    ['Siyah', 'Black', 'Чёрные'],
    ['beyaz', 'white', 'белые'],
    ['siyah', 'black', 'чёрные'],
    ['Süre', 'Time', 'Время'],
    ['Botla oyna', 'Play the bot', 'Играть с ботом'],
    ['Antrenman: bota karşı', 'Training: against the bot', 'Тренировка: против бота'],
    ['Bot oyunları ayrı bir rating havuzunda tutulur.', 'Bot games are kept in a separate rating pool.', 'Партии с ботом учитываются в отдельном рейтинге.'],
    ['{0} (~{1})', '{0} (~{1})', '{0} (~{1})'],
    // Genel ayraç: "A · B" biçimindeki metinlerde parçalar ayrı ayrı çevrilir (en son denenir).
    ['{0} · {1}', '{0} · {1}', '{0} · {1}'],
    ['Başlangıç', 'Beginner', 'Новичок'],
    ['Kolay', 'Easy', 'Лёгкий'],
    ['Orta', 'Medium', 'Средний'],
    ['İleri', 'Advanced', 'Продвинутый'],
    ['Usta', 'Master', 'Мастер'],
    ['Maksimum', 'Maximum', 'Максимум'],

    // oyun ekranı
    ['şah', 'king', 'король'],
    ['vezir', 'queen', 'ферзь'],
    ['kale', 'rook', 'ладья'],
    ['fil', 'bishop', 'слон'],
    ['at', 'knight', 'конь'],
    ['piyon', 'pawn', 'пешка'],
    ['elendi', 'eliminated', 'выбыл'],
    ['bekleniyor', 'waiting', 'ожидается'],
    ['Satranç tahtası', 'Chessboard', 'Шахматная доска'],
    ['Hamleler', 'Moves', 'Ходы'],
    ['Oyun analizi', 'Game analysis', 'Анализ партии'],
    ['Asistana sor', 'Ask the assistant', 'Спросить ассистента'],
    ['En iyi', 'Best', 'Лучший'],
    ['İyi', 'Good', 'Хороший'],
    ['Küçük hata', 'Inaccuracy', 'Неточность'],
    ['Hata', 'Mistake', 'Ошибка'],
    ['Büyük hata', 'Blunder', 'Зевок'],
    ['(sen)', '(you)', '(ты)'],
    ['Senin kritik anların', 'Your critical moments', 'Твои ключевые моменты'],
    ['Büyük hata yapmadın.', 'You made no blunders.', 'Зевков не было.'],
    ['büyük hata', 'blunder', 'зевок'],
    ['· daha iyisi {0}', '· better was {0}', '· лучше было {0}'],
    ['Analiz ediliyor… Hazır olunca burada görünecek.', 'Analyzing… It will appear here when ready.', 'Идёт анализ… Результат появится здесь.'],
    ['Bu oyunun doğruluk oranını, iyi hamlelerini ve hatalarını görmek için analiz et.', 'Analyze this game to see your accuracy, good moves and mistakes.', 'Проанализируй партию, чтобы увидеть точность, хорошие ходы и ошибки.'],
    ['Analiz et', 'Analyze', 'Анализировать'],
    ['Doğruluk', 'Accuracy', 'Точность'],
    ['Rakibi şikayet et', 'Report opponent', 'Пожаловаться на соперника'],
    ['Hile şüphesi', 'Suspected cheating', 'Подозрение на нечестную игру'],
    ['Kötü davranış', 'Bad behavior', 'Плохое поведение'],
    ['Neden şikayet ediyorsun? Kısaca anlat.', 'Why are you reporting? Describe briefly.', 'Почему ты жалуешься? Опиши кратко.'],
    ['Şikayet türü', 'Report type', 'Тип жалобы'],
    ['Açıklama', 'Description', 'Описание'],
    ['Şikayetin inceleme ekibine iletilir; kararı insanlar verir. Aynı oyun için bir kez şikayet edebilirsin.', 'Your report goes to the review team; people make the decision. You can report a game once.', 'Жалоба передаётся команде проверки; решение принимают люди. На одну партию можно пожаловаться один раз.'],
    ['Gönder', 'Send', 'Отправить'],
    ['Vazgeç', 'Cancel', 'Отмена'],
    ['Şikayetin alındı. İnceleme ekibi değerlendirecek.', 'Your report was received. The review team will look into it.', 'Жалоба получена. Команда проверки рассмотрит её.'],
    ['Oyun boyunca değerlendirme grafiği (üst beyaz üstün, alt siyah üstün)', 'Evaluation over the game (top: White better, bottom: Black better)', 'График оценки по ходу партии (вверху перевес белых, внизу — чёрных)'],
    ['Terfi', 'Promotion', 'Превращение'],
    ['bağlantı koptu', 'disconnected', 'соединение потеряно'],
    ['Turnuva · {0}. tekrar oyunu (1 dk)', 'Tournament · rematch {0} (1 min)', 'Турнир · переигровка {0} (1 мин)'],
    ['Bot oyunu', 'Bot game', 'Партия с ботом'],
    ['Serbest oyun', 'Casual game', 'Свободная партия'],
    ['Turnuva tablosu', 'Tournament bracket', 'Турнирная сетка'],
    ['{0} kazandı', '{0} won', '{0} победили'],
    ['Berabere', 'Draw', 'Ничья'],
    ['Berabere: renkler değişerek 1 dakikalık tekrar oyunu başlayacak.', 'Draw: a 1-minute rematch with colors swapped will start.', 'Ничья: начнётся переигровка на 1 минуту со сменой цвета.'],
    ['Şah!', 'Check!', 'Шах!'],
    ['Sıra sende.', 'Your move.', 'Твой ход.'],
    ['Rakibin düşünüyor.', 'Your opponent is thinking.', 'Соперник думает.'],
    ['Sıra {0}.', '{0} to move.', 'Ход: {0}.'],
    ['Rakibin beraberlik teklif etti.', 'Your opponent offered a draw.', 'Соперник предложил ничью.'],
    ['Evet, teslim ol', 'Yes, resign', 'Да, сдаться'],
    ['Teslim ol', 'Resign', 'Сдаться'],
    ['Beraberliği kabul et', 'Accept draw', 'Принять ничью'],
    ['Reddet', 'Decline', 'Отклонить'],
    ['{0}. hamleden sonra', 'after move {0}', 'после {0}-го хода'],
    ['Teklif gönderildi', 'Offer sent', 'Предложение отправлено'],
    ['Beraberlik teklif et', 'Offer a draw', 'Предложить ничью'],
    ['Beraberlik teklifi reddedildi.', 'Draw offer declined.', 'Предложение ничьей отклонено.'],
    ['Final', 'Final', 'Финал'],
    ['Yarı final', 'Semifinal', 'Полуфинал'],
    ['Çeyrek final', 'Quarterfinal', 'Четвертьфинал'],
    ['Son 16', 'Round of 16', '1/8 финала'],
    ['Son 32', 'Round of 32', '1/16 финала'],
    ['{0}. tur', 'Round {0}', '{0}-й тур'],
    ['Tekrar oyunu başlıyor', 'Rematch is starting', 'Переигровка начинается'],

    // turnuva sayfası
    ['{0} kişilik eleme · {1} · {2}', '{0}-player knockout · {1} · {2}', 'На выбывание · {0} уч. · {1} · {2}'],
    ['Ücretli', 'Paid', 'Платный'],
    ['Öde · {0}', 'Pay · {0}', 'Оплатить · {0}'],
    ['Turnuvadan ayrılırsan {0} ücretin iade edilir (bakiyeden ödediysen hemen bakiyene, kartla ödediysen kartına). Ayrılmak istiyor musun?',
      'If you leave the tournament your {0} fee is refunded (to your balance right away if you paid from it, or to your card if you paid by card). Do you want to leave?',
      'Если ты покинешь турнир, взнос {0} вернётся (сразу на баланс, если платил с него, или на карту, если платил картой). Покинуть турнир?'],
    ['Ayrıldın. Ücretin iade edildi.', 'You left. Your fee was refunded.', 'Ты покинул турнир. Взнос возвращён.'],
    ['Ayrıl', 'Leave', 'Покинуть'],
    ['Katılmak için giriş yap', 'Log in to join', 'Войди, чтобы участвовать'],
    ['Koltuğun {0} dakika boyunca senin için ayrıldı. Ödeme tamamlanınca kaydın kesinleşir.', 'Your seat is held for {0} minutes. Your registration is confirmed once payment completes.', 'Место забронировано на {0} мин. Регистрация подтвердится после оплаты.'],
    ['Ödeme alındı (kart •••• {0}). Kaydın kesinleşti.', 'Payment received (card •••• {0}). You are registered.', 'Оплата получена (карта •••• {0}). Регистрация подтверждена.'],
    ['Ödeme alındı; koltuğun onaylanıyor…', 'Payment received; confirming your seat…', 'Оплата получена; место подтверждается…'],
    ['Ödeme sağlayıcısından onay bekleniyor…', 'Waiting for confirmation from the payment provider…', 'Ожидаем подтверждение от платёжного провайдера…'],
    ['Ödeme başarısız: {0}.', 'Payment failed: {0}.', 'Платёж не прошёл: {0}.'],
    ['Ödemen bu turnuvaya bağlanamadı ve iade edildi.', 'Your payment could not be linked to this tournament and was refunded.', 'Платёж не удалось привязать к турниру, он возвращён.'],
    ['Hazırsın — diğerleri bekleniyor', 'You are ready — waiting for the others', 'Ты готов — ждём остальных'],
    ['Hazırım ({0} sn)', 'I\'m ready ({0} s)', 'Готов ({0} с)'],
    ['Botlar katılıyor…', 'Bots are joining…', 'Боты присоединяются…'],
    ['{0} test botu katıldı; turnuva doluyor.', '{0} test bots joined; the tournament is filling up.', 'Присоединилось тестовых ботов: {0}; турнир заполняется.'],
    ['{0} test botu katıldı. Son koltuk senin: "Katıl"a bas.', '{0} test bots joined. The last seat is yours: press "Join".', 'Присоединилось тестовых ботов: {0}. Последнее место твоё: нажми «Участвовать».'],
    ['Kalan koltukları test botlarıyla doldur', 'Fill the remaining seats with test bots', 'Заполнить оставшиеся места тестовыми ботами'],
    ['Bana bir koltuk bırakıp botlarla doldur', 'Fill with bots, leaving one seat for me', 'Заполнить ботами, оставив одно место мне'],
    ['Turnuva doldu. Herkes {0} saniye içinde "Hazırım" demeli; demeyen hükmen elenir{1}.', 'The tournament is full. Everyone must press "I\'m ready" within {0} seconds; anyone who doesn\'t is eliminated by forfeit{1}.', 'Турнир заполнен. Все должны нажать «Готов» в течение {0} секунд; кто не нажмёт — выбывает с техническим поражением{1}.'],
    ['(ücret iade edilmez)', '(the fee is not refunded)', '(взнос не возвращается)'],
    ['Her tur tek oyun. Berabere biterse 1 dakikalık tekrar oyunları oynanır; her seferinde renkler değişir ve biri kazanana kadar sürer.', 'Each round is one game. If it ends in a draw, 1-minute rematches are played with colors swapped each time, until someone wins.', 'Каждый тур — одна партия. При ничьей играются переигровки по 1 минуте со сменой цвета, пока кто-то не победит.'],
    ['Adil oyun: ücretli oyunlar bittikten sonra motorla analiz edilir; oyun sırasında sekme değiştirme kaydedilir. Ödüller inceleme bitince serbest kalır.', 'Fair play: paid games are analyzed after they finish; switching tabs during a game is recorded. Prizes are released once the review is complete.', 'Честная игра: платные партии анализируются после окончания; переключение вкладок во время игры фиксируется. Призы выплачиваются после проверки.'],
    ['Eleme tablosu', 'Bracket', 'Сетка'],
    ['Ödüller', 'Prizes', 'Призы'],
    ['Ödül tablosu', 'Prize table', 'Таблица призов'],
    ['ödendi', 'paid', 'выплачено'],
    ['{0} (kişi başı)', '{0} (each)', '{0} (каждому)'],
    ['Toplam giriş {0} · sistem payı {1} · ödül havuzu {2}. Ödüller güvenlik incelemesi için bekletilir, sonra çekilebilir bakiyene geçer.', 'Total entries {0} · platform fee {1} · prize pool {2}. Prizes are held for a security review, then move to your withdrawable balance.', 'Всего взносов {0} · комиссия платформы {1} · призовой фонд {2}. Призы удерживаются для проверки, затем переходят на баланс для вывода.'],
    ['Kontenjan dolarsa: {0} × {1}, sistem payı %{2}. Kuruş artığı şampiyona eklenir.', 'When full: {0} × {1}, platform fee {2}%. Any leftover cents go to the champion.', 'При заполнении: {0} × {1}, комиссия платформы {2}%. Остаток в центах получает чемпион.'],
    ['Oyuncular', 'Players', 'Игроки'],
    ['oyuncu', 'players', 'участников'],
    ['ödeme bekleniyor', 'awaiting payment', 'ожидается оплата'],
    ['hazır', 'ready', 'готов'],
    ['şampiyon', 'champion', 'чемпион'],
    ['sıra {0}', 'place {0}', 'место {0}'],
    ['Henüz kimse katılmadı.', 'No one has joined yet.', 'Пока никто не присоединился.'],
    ['Adil eşleştirme', 'Fair pairing', 'Честная жеребьёвка'],
    ['Eşleşmeler gizli bir rastgele değerle (seed) belirlenir. Turnuva açılırken bu değerin özeti yayınlanır; başlangıçta değerin kendisi açıklanır. Böylece kimse eşleşmeleri sonradan değiştiremez.',
      'Pairings are determined by a secret random value (seed). A hash of it is published when the tournament opens and the value itself is revealed at the start, so no one can change the pairings afterwards.',
      'Пары определяются секретным случайным значением (seed). При открытии турнира публикуется его хеш, а на старте раскрывается само значение — поэтому никто не может изменить пары задним числом.'],
    ['Yayınlanan özet (SHA-256):', 'Published hash (SHA-256):', 'Опубликованный хеш (SHA-256):'],
    ['Açıklanan seed:', 'Revealed seed:', 'Раскрытый seed:'],
    ['Doğrula', 'Verify', 'Проверить'],
    ['Seed turnuva başlayınca açıklanacak.', 'The seed will be revealed when the tournament starts.', 'Seed будет раскрыт на старте турнира.'],
    ['Doğrulandı: seed özetle eşleşiyor ve yerleşim yeniden üretildi.', 'Verified: the seed matches the hash and the bracket was reproduced.', 'Проверено: seed совпадает с хешем, сетка воспроизведена.'],
    ['Doğrulama başarısız.', 'Verification failed.', 'Проверка не пройдена.'],
    ['(boş)', '(empty)', '(пусто)'],
    ['hükmen', 'by forfeit', 'техническое'],
    ['rakipsiz geçti', 'bye', 'прошёл без соперника'],
    ['Oyun', 'Game', 'Партия'],
    ['canlı', 'live', 'в эфире'],
    ['Turnuvan başlarken telefonuna haber verelim mi?', 'Shall we notify your phone when your tournament starts?', 'Уведомить тебя на телефон, когда турнир начнётся?'],
    ['Bildirimleri aç', 'Turn on notifications', 'Включить уведомления'],

    // cüzdan
    ['Cüzdanını görmek için giriş yap.', 'Log in to see your wallet.', 'Войди, чтобы увидеть кошелёк.'],
    ['başarısız', 'failed', 'не удалось'],
    ['Ödül (bekletmede)', 'Prize (on hold)', 'Приз (удерживается)'],
    ['Ödül serbest', 'Prize released', 'Приз зачислен'],
    ['Ödül iptali', 'Prize cancelled', 'Приз отменён'],
    ['Çekim', 'Withdrawal', 'Вывод'],
    ['Çekim talebi', 'Withdrawal request', 'Заявка на вывод'],
    ['Çekim iadesi', 'Withdrawal returned', 'Возврат вывода'],
    ['Düzeltme', 'Adjustment', 'Корректировка'],
    ['Bakiye yükleme', 'Top-up', 'Пополнение'],
    ['Turnuva girişi', 'Tournament entry', 'Взнос за турнир'],
    ['Giriş iadesi', 'Entry refund', 'Возврат взноса'],
    ['kazanç', 'winnings', 'выигрыш'],
    ['yüklenen', 'topped up', 'пополнение'],
    ['E-cüzdan', 'E-wallet', 'Электронный кошелёк'],
    ['Banka havalesi', 'Bank transfer', 'Банковский перевод'],
    ['Ödeme alındı; bakiyen güncellendi.', 'Payment received; your balance has been updated.', 'Оплата получена; баланс обновлён.'],
    ['Ödeme onayı bekleniyor; birkaç saniye içinde bakiyene yansır.', 'Waiting for payment confirmation; it will show in your balance in a few seconds.', 'Ожидаем подтверждение оплаты; через несколько секунд сумма появится на балансе.'],
    ['Ödeme başarısız: {0}', 'Payment failed: {0}', 'Платёж не прошёл: {0}'],
    ['E-cüzdan e-postası / hesap no', 'E-wallet email / account no.', 'Почта / номер электронного кошелька'],
    ['Ad Soyad', 'Full name', 'Имя и фамилия'],
    ['Çekilen: {0} · tahmini komisyon: {1} · hesabına geçecek:', 'Withdrawn: {0} · estimated fee: {1} · you will receive:', 'Списывается: {0} · ориентировочная комиссия: {1} · ты получишь:'],
    ['Tutar (en az {0})', 'Amount (min. {0})', 'Сумма (мин. {0})'],
    ['Yöntem', 'Method', 'Способ'],
    ['Hesap bilgisi', 'Account details', 'Реквизиты'],
    ['Hesap sahibinin adı', 'Account holder name', 'Имя владельца счёта'],
    ['Hesabımı kapat ve bakiyemi çek', 'Close my account and withdraw my balance', 'Закрыть аккаунт и вывести баланс'],
    ['Çekim talebi gönder', 'Request withdrawal', 'Отправить заявку на вывод'],
    ['Hesabın kapatılacak{0}. Bu işlem geri alınamaz. Devam edilsin mi?', 'Your account will be closed{0}. This cannot be undone. Continue?', 'Аккаунт будет закрыт{0}. Это действие нельзя отменить. Продолжить?'],
    ['ve {0} bakiyenin tamamı çekilecek', 'and your entire balance of {0} will be withdrawn', 'и весь баланс {0} будет выведен'],
    ['{0} çekim talebi gönderilsin mi? Komisyon çekilen tutardan düşülür.', 'Request a withdrawal of {0}? The fee is deducted from the amount withdrawn.', 'Отправить заявку на вывод {0}? Комиссия вычитается из выводимой суммы.'],
    ['Hesabın kapatıldı.', 'Your account has been closed.', 'Аккаунт закрыт.'],
    ['Hesap kapatma talebin alındı. Bakiyen gönderilince hesabın kapanacak.', 'Your account closure request was received. Your account will close once your balance is sent.', 'Запрос на закрытие аккаунта получен. Аккаунт закроется после отправки баланса.'],
    ['Çekim talebin alındı. Ödeme yapılınca bildirim alacaksın.', 'Your withdrawal request was received. You will be notified when it is paid.', 'Заявка на вывод получена. Мы сообщим, когда выплата будет сделана.'],
    ['Bakiye yükle', 'Top up', 'Пополнить'],
    ['Bakiye', 'Balance', 'Баланс'],
    ['Toplam bakiye', 'Total balance', 'Общий баланс'],
    ['Yüklenen', 'Topped up', 'Пополнено'],
    ['Kazanılan (çekilebilir)', 'Won (withdrawable)', 'Выиграно (доступно к выводу)'],
    ['Bekletmede', 'On hold', 'Удерживается'],
    ['Bir kerede {0}–{1} yükleyebilirsin. Turnuva ücretleri bakiyenden düşülür.', 'You can top up {0}–{1} at a time. Tournament fees are deducted from your balance.', 'За один раз можно пополнить на {0}–{1}. Взносы за турниры списываются с баланса.'],
    ['Ödüller, hile incelemesi için tutara göre 12–48 saat bekletilir; sonra çekilebilir bakiyeye geçer.', 'Prizes are held 12–48 hours (depending on the amount) for a cheating review, then move to your withdrawable balance.', 'Призы удерживаются 12–48 часов (в зависимости от суммы) для проверки на нечестную игру, затем становятся доступны к выводу.'],
    ['Para çek', 'Withdraw', 'Вывести'],
    ['Bekleyen talebin var: {0} ({1}). Sonuçlanınca yeni talep verebilirsin.', 'You have a pending request: {0} ({1}). You can make a new one once it is completed.', 'У тебя есть заявка в обработке: {0} ({1}). Новую можно подать после её завершения.'],
    ['En az çekim tutarı {0}. Hesabını kapatırsan tutar ne olursa olsun bakiyenin tamamını çekebilirsin.', 'The minimum withdrawal is {0}. If you close your account you can withdraw your entire balance, whatever the amount.', 'Минимальная сумма вывода {0}. При закрытии аккаунта можно вывести весь баланс, независимо от суммы.'],
    ['· hesap kapatma', '· account closure', '· закрытие аккаунта'],
    ['(net {0})', '(net {0})', '(чистыми {0})'],
    ['Talep iptal edilsin mi? Tutar bakiyene geri döner.', 'Cancel the request? The amount returns to your balance.', 'Отменить заявку? Сумма вернётся на баланс.'],
    ['Hesabı kapat', 'Close account', 'Закрыть аккаунт'],
    ['Hesabını kapatırsan, 20 $ altında olsa bile bakiyenin tamamı sana gönderilir ve hesabın kapanır. Devam eden turnuvan veya incelemedeki ödülün varsa önce onların bitmesi gerekir.',
      'If you close your account, your entire balance is sent to you even if it is under $20, and your account is closed. Any ongoing tournament or prize under review must finish first.',
      'При закрытии аккаунта весь баланс отправляется тебе, даже если он меньше 20 $, и аккаунт закрывается. Сначала должны завершиться текущий турнир или проверка приза.'],
    ['Bekleyen bir çekim talebin var; önce onun sonuçlanmasını bekle ya da iptal et.', 'You have a pending withdrawal; wait for it to complete or cancel it first.', 'У тебя есть заявка на вывод в обработке; дождись её завершения или отмени.'],
    ['çekilebilir', 'withdrawable', 'доступно к выводу'],
    ['{0}\'e kadar bekletmede', 'on hold until {0}', 'удерживается до {0}'],
    ['Henüz ödül yok.', 'No prizes yet.', 'Призов пока нет.'],
    ['Ödemeler', 'Payments', 'Платежи'],
    ['Ödeme', 'Payment', 'Платёж'],
    ['Henüz ödeme yok.', 'No payments yet.', 'Платежей пока нет.'],
    ['Hareketler', 'Transactions', 'Операции'],
    ['Bekletmeden çıktı', 'Released from hold', 'Снято с удержания'],
    ['Hareket yok.', 'No transactions.', 'Операций нет.'],
    ['Hesap', 'Account', 'Аккаунт'],
    ['İptal et', 'Cancel', 'Отменить'],
    ['Bekliyor', 'Pending', 'Ожидает'],
    ['Ödendi', 'Paid', 'Выплачено'],
    ['Reddedildi', 'Rejected', 'Отклонено'],
    ['İptal edildi', 'Cancelled', 'Отменено'],
    ['Tutar', 'Amount', 'Сумма'],
    ['Komisyon', 'Fee', 'Комиссия'],
    ['Net', 'Net', 'Чистыми'],
    ['Tarih', 'Date', 'Дата'],
    ['Durum', 'Status', 'Статус'],
    ['Tür', 'Type', 'Тип'],
    ['Ücret', 'Fee', 'Взнос'],
    ['İade', 'Refund', 'Возврат'],
    ['Para çekme işlemlerinde bankanız veya ödeme sağlayıcınız tarafından alınan komisyonlar platformumuza ait değildir ve çekilen tutardan düşülür. Komisyon tutarı, onaylamadan önce size gösterilir.',
      'Withdrawal fees charged by your bank or payment provider are not set by us and are deducted from the amount withdrawn. The fee is shown before you confirm.',
      'Комиссии банка или платёжного провайдера при выводе средств не относятся к нашей платформе и вычитаются из выводимой суммы. Размер комиссии показывается до подтверждения.'],
    ['Bankan veya ödeme sağlayıcın tarafından alınan komisyonlar platformumuza ait değildir.', 'Fees charged by your bank or payment provider are not charged by our platform.', 'Комиссии, которые берёт твой банк или платёжный провайдер, не относятся к нашей платформе.'],

    // ayarlar ve bildirimler
    ['iPhone/iPad\'de bildirim için önce Paylaş → "Ana Ekrana Ekle" ile uygulamayı ekle, sonra oradan açıp tekrar dene.', 'For notifications on iPhone/iPad, first add the app with Share → "Add to Home Screen", then open it from there and try again.', 'Для уведомлений на iPhone/iPad сначала добавь приложение через «Поделиться» → «На экран „Домой“», затем открой его оттуда и попробуй снова.'],
    ['Bu tarayıcı bildirimleri desteklemiyor.', 'This browser does not support notifications.', 'Этот браузер не поддерживает уведомления.'],
    ['Bildirim izni verilmedi. Tarayıcı ayarlarından izin verebilirsin.', 'Notification permission was not granted. You can allow it in your browser settings.', 'Разрешение на уведомления не выдано. Его можно включить в настройках браузера.'],
    ['Bildirimler açıldı.', 'Notifications turned on.', 'Уведомления включены.'],
    ['Yeni turnuva özetleri açıldı.', 'New tournament digests turned on.', 'Подборки новых турниров включены.'],
    ['Yeni turnuva özetlerinden çıktın.', 'You unsubscribed from new tournament digests.', 'Ты отписался от подборок новых турниров.'],
    ['iPhone/iPad\'de bildirim için: Safari\'de Paylaş → "Ana Ekrana Ekle", sonra uygulamayı ana ekrandan aç.', 'For notifications on iPhone/iPad: in Safari tap Share → "Add to Home Screen", then open the app from the home screen.', 'Для уведомлений на iPhone/iPad: в Safari нажми «Поделиться» → «На экран „Домой“», затем открой приложение с главного экрана.'],
    ['Bu cihazda bildirimler açık.', 'Notifications are on for this device.', 'На этом устройстве уведомления включены.'],
    ['Bu cihazda bildirimler kapalı.', 'Notifications are off for this device.', 'На этом устройстве уведомления выключены.'],
    ['Bu cihazda kapat', 'Turn off on this device', 'Выключить на этом устройстве'],
    ['Bu cihazda aç', 'Turn on for this device', 'Включить на этом устройстве'],
    ['Bildirimler kapatıldı.', 'Notifications turned off.', 'Уведомления выключены.'],
    ['Telefon bildirimleri', 'Phone notifications', 'Уведомления на телефон'],
    ['Kayıtlı olduğun turnuva dolup başlarken ve sıradaki maçın başlarken bildirim alırsın.', 'You get a notification when a tournament you joined fills up and starts, and when your next match begins.', 'Ты получишь уведомление, когда твой турнир заполнится и начнётся, и когда начнётся следующий матч.'],
    ['Turnuva kaydı, başlama ve para çekme e-postaları her zaman gönderilir.', 'Emails about tournament registration, starts and withdrawals are always sent.', 'Письма о регистрации на турнир, его начале и выводе средств отправляются всегда.'],
    ['Yeni turnuvalardan haberdar et (günde en fazla bir özet e-posta)', 'Tell me about new tournaments (at most one digest email a day)', 'Сообщать о новых турнирах (не более одного письма в день)'],
    ['E-posta bildirimleri', 'Email notifications', 'Уведомления по почте'],
    ['Cüzdan ve hesap kapatma', 'Wallet and account closure', 'Кошелёк и закрытие аккаунта'],
    ['Dil tercihin kaydedildi.', 'Language preference saved.', 'Язык сохранён.'],
    ['Arayüz ve e-postalar bu dilde gelir.', 'The interface and emails use this language.', 'Интерфейс и письма будут на этом языке.'],

    // asistan
    ['Devam eden bir oyunun var. Oyun sırasında asistan kapalıdır.', 'You have a game in progress. The assistant is off during games.', 'У тебя идёт партия. Во время игры ассистент недоступен.'],
    ['Süren bir turnuvadasın. Turnuva bitince asistanı kullanabilirsin.', 'You are in an ongoing tournament. You can use the assistant once it ends.', 'Ты участвуешь в текущем турнире. Ассистент будет доступен после его окончания.'],
    ['Bu oyun hakkında sor…', 'Ask about this game…', 'Спроси об этой партии…'],
    ['Sorunu yaz…', 'Type your question…', 'Напиши вопрос…'],
    ['Bu oyunda nerede hata yaptım?', 'Where did I go wrong in this game?', 'Где я ошибся в этой партии?'],
    ['Bu oyundan ne öğrenmeliyim?', 'What should I learn from this game?', 'Чему мне научиться из этой партии?'],
    ['Açılışım nasıldı?', 'How was my opening?', 'Как я сыграл дебют?'],
    ['Para nasıl çekerim?', 'How do I withdraw money?', 'Как вывести деньги?'],
    ['Beraberlikte ne olur?', 'What happens after a draw?', 'Что происходит при ничьей?'],
    ['Rakibimi şikayet etmek istiyorum', 'I want to report my opponent', 'Хочу пожаловаться на соперника'],
    ['Satranç Asistanı', 'Chess Assistant', 'Шахматный ассистент'],
    ['Oyuna dön', 'Back to game', 'Вернуться к партии'],
    ['Koç modu: bitmiş oyununu birlikte değerlendirelim. Asistan yalnız bitmiş oyunlarda yardım eder.', 'Coach mode: let\'s review your finished game together. The assistant only helps with finished games.', 'Режим тренера: разберём твою завершённую партию вместе. Ассистент помогает только с завершёнными партиями.'],
    ['Kurallar, cüzdan, para çekme ve şikayetlerle ilgili sorularını yanıtlar. Oyunlarını değerlendirmek için oyun sayfasındaki "Asistana sor" düğmesini kullan.', 'Answers your questions about rules, the wallet, withdrawals and reports. To review your games, use the "Ask the assistant" button on the game page.', 'Отвечает на вопросы о правилах, кошельке, выводе средств и жалобах. Для разбора партий нажми «Спросить ассистента» на странице партии.'],
    ['Merhaba! Bu oyununla ilgili ne sormak istersin?', 'Hi! What would you like to ask about this game?', 'Привет! Что хочешь спросить об этой партии?'],
    ['Merhaba! Ben Satranç Asistanı. Nasıl yardımcı olabilirim?', 'Hi! I\'m the Chess Assistant. How can I help?', 'Привет! Я шахматный ассистент. Чем могу помочь?'],
    ['Asistan şu anda kullanılamıyor.', 'The assistant is not available right now.', 'Ассистент сейчас недоступен.'],
    ['Bugünkü soru hakkın doldu; yarın tekrar sorabilirsin.', 'You have used today\'s questions; you can ask again tomorrow.', 'Вопросы на сегодня закончились; можно спросить завтра.'],
    ['Bugün kalan soru hakkın: {0}/{1}', 'Questions left today: {0}/{1}', 'Осталось вопросов на сегодня: {0}/{1}'],
    ['Şikayetin inceleme ekibine iletildi.', 'Your report was sent to the review team.', 'Жалоба передана команде проверки.'],

    // sunucu hata mesajları
    ['Beklenmeyen bir hata oluştu', 'An unexpected error occurred', 'Произошла непредвиденная ошибка'],
    ['Doğum tarihi geçersiz', 'Invalid date of birth', 'Неверная дата рождения'],
    ['Kayıt için en az {0} yaşında olmalısınız', 'You must be at least {0} to sign up', 'Для регистрации нужно быть не младше {0} лет'],
    ['Bu e-posta ile kayıtlı bir hesap var', 'An account with this email already exists', 'Аккаунт с этой почтой уже существует'],
    ['Bu kullanıcı adı alınmış', 'This username is taken', 'Это имя пользователя занято'],
    ['Doğrulama bağlantısı geçersiz ya da süresi dolmuş', 'The verification link is invalid or has expired', 'Ссылка для подтверждения недействительна или устарела'],
    ['E-posta veya şifre hatalı', 'Incorrect email or password', 'Неверная почта или пароль'],
    ['Bu hesap kullanıcının isteğiyle kapatıldı', 'This account was closed at the user\'s request', 'Этот аккаунт закрыт по просьбе пользователя'],
    ['Oturum bulunamadı', 'Session not found', 'Сессия не найдена'],
    ['Oturum sonlandırıldı; tekrar giriş yapın', 'Session ended; please log in again', 'Сессия завершена; войди снова'],
    ['Oturum süresi doldu', 'Session expired', 'Сессия истекла'],
    ['Hesap kilitli', 'Account locked', 'Аккаунт заблокирован'],
    ['Kullanıcı bulunamadı', 'User not found', 'Пользователь не найден'],
    ['Hesabınız turnuvaya katılamaz', 'Your account cannot join tournaments', 'Твой аккаунт не может участвовать в турнирах'],
    ['Hesabınız kapatılıyor; yeni turnuvaya katılamazsınız', 'Your account is being closed; you cannot join new tournaments', 'Аккаунт закрывается; участвовать в новых турнирах нельзя'],
    ['Turnuvaya katılmak için e-posta adresinizi doğrulayın', 'Verify your email address to join tournaments', 'Подтверди адрес почты, чтобы участвовать в турнирах'],
    ['Oturum yok', 'Not logged in', 'Нет активной сессии'],
    ['Bu işlem için yetkiniz yok', 'You are not allowed to do this', 'Нет прав на это действие'],
    ['Bulunamadı', 'Not found', 'Не найдено'],
    ['Geçersiz bildirim aboneliği', 'Invalid notification subscription', 'Неверная подписка на уведомления'],
    ['Turnuva bulunamadı', 'Tournament not found', 'Турнир не найден'],
    ['Ücretli turnuvalara kayıt geçici olarak durduruldu', 'Registration for paid tournaments is temporarily paused', 'Регистрация на платные турниры временно приостановлена'],
    ['Ücretli turnuvalar için en az {0} rated oyun gerekli (şu an {1})', 'Paid tournaments require at least {0} rated games (you have {1})', 'Для платных турниров нужно не менее {0} рейтинговых партий (сейчас {1})'],
    ['Bu turnuva kayıt almıyor', 'This tournament is not accepting registrations', 'Этот турнир не принимает регистрацию'],
    ['Bu turnuva ülkenizde sunulmuyor', 'This tournament is not available in your country', 'Этот турнир недоступен в твоей стране'],
    ['Rating bandınız bu turnuvanın üstünde', 'Your rating is above this tournament\'s range', 'Твой рейтинг выше диапазона этого турнира'],
    ['Rating bandınız bu turnuvanın altında', 'Your rating is below this tournament\'s range', 'Твой рейтинг ниже диапазона этого турнира'],
    ['Başka bir aktif turnuvadasınız', 'You are already in another active tournament', 'Ты уже участвуешь в другом активном турнире'],
    ['Aynı cihaz veya ağdan bu turnuvada başka bir hesap var', 'Another account from the same device or network is in this tournament', 'В этом турнире уже есть другой аккаунт с того же устройства или сети'],
    ['Turnuva doldu', 'The tournament is full', 'Турнир заполнен'],
    ['Bu turnuvaya zaten katıldınız', 'You have already joined this tournament', 'Ты уже участвуешь в этом турнире'],
    ['Bakiyeniz bu turnuva için yetersiz', 'Your balance is too low for this tournament', 'Недостаточно средств для этого турнира'],
    ['Ödeme bekleyen bir koltuğunuz yok', 'You have no seat awaiting payment', 'У тебя нет места, ожидающего оплаты'],
    ['Rezervasyon süresi doldu', 'The reservation has expired', 'Бронь истекла'],
    ['Turnuva başladıktan sonra ayrılınamaz; maçınız hükmen kaybedilir', 'You cannot leave after the tournament starts; your match would be lost by forfeit', 'После старта турнира покинуть его нельзя; матч будет засчитан как техническое поражение'],
    ['Bu turnuvada kaydınız yok', 'You are not registered for this tournament', 'Ты не зарегистрирован в этом турнире'],
    ['Hazır olma aşamasında değil', 'Not in the ready check stage', 'Сейчас не этап проверки готовности'],
    ['Giriş gerekli', 'Login required', 'Требуется вход'],
    ['Oyun bulunamadı', 'Game not found', 'Партия не найдена'],
    ['Yalnız oyunu oynayanlar analizi görebilir', 'Only the players of this game can see the analysis', 'Анализ доступен только участникам партии'],
    ['Analiz oyun bitince açılır', 'Analysis is available once the game ends', 'Анализ доступен после окончания партии'],
    ['Günlük analiz sınırına ulaştın ({0})', 'You reached the daily analysis limit ({0})', 'Достигнут дневной лимит анализов ({0})'],
    ['Seviye belirleme tamamlandı', 'Placement is already complete', 'Определение уровня уже завершено'],
    ['Rated oyunların olduğu için seviye belirleme gerekmiyor', 'You already have rated games, so placement is not needed', 'У тебя уже есть рейтинговые партии, определение уровня не требуется'],
    ['Oyun canlı değil', 'The game is not live', 'Партия не идёт'],
    ['Bu oyunda oyuncu değilsiniz', 'You are not a player in this game', 'Ты не участник этой партии'],
    ['Hamle sırası eşleşmiyor; tahta yenilendi', 'Move order mismatch; the board was refreshed', 'Несовпадение очерёдности ходов; доска обновлена'],
    ['Sıra sizde değil', 'It is not your turn', 'Сейчас не твой ход'],
    ['Süreniz doldu', 'Your time ran out', 'Твоё время истекло'],
    ['Ücretli oyunlar yalnız bittikten sonra izlenebilir', 'Paid games can only be viewed after they finish', 'Платные партии можно смотреть только после окончания'],
    ['Bilinmeyen bot seviyesi', 'Unknown bot level', 'Неизвестный уровень бота'],
    ['Devam eden bir oyununuz var', 'You have a game in progress', 'У тебя идёт партия'],
    ['Yükleme tutarı {0}–{1} $ arasında olmalı', 'The top-up amount must be between {0} and {1} $', 'Сумма пополнения должна быть от {0} до {1} $'],
    ['Hesabınız bakiye yükleyemez', 'Your account cannot top up', 'Твой аккаунт не может пополнять баланс'],
    ['Hesabınız kapatılıyor; bakiye yüklenemez', 'Your account is being closed; you cannot top up', 'Аккаунт закрывается; пополнение невозможно'],
    ['Geçersiz ödeme yöntemi', 'Invalid payment method', 'Неверный способ оплаты'],
    ['Hesap bilgisi 3–120 karakter olmalı', 'Account details must be 3–120 characters', 'Реквизиты должны содержать 3–120 символов'],
    ['Hesap sahibinin adı 2–80 karakter olmalı', 'The account holder name must be 2–80 characters', 'Имя владельца должно содержать 2–80 символов'],
    ['Kart numarası girmeyin; e-cüzdan hesap e-postanızı veya numaranızı yazın', 'Do not enter a card number; enter your e-wallet email or account number', 'Не вводи номер карты; укажи почту или номер электронного кошелька'],
    ['Hesabınız şu anda para çekemez; destekle iletişime geçin', 'Your account cannot withdraw right now; please contact support', 'Сейчас вывод с аккаунта невозможен; обратись в поддержку'],
    ['Hesap kapatılmış', 'The account is closed', 'Аккаунт закрыт'],
    ['Bekleyen bir çekim talebiniz var', 'You have a pending withdrawal request', 'У тебя есть заявка на вывод в обработке'],
    ['Devam eden bir turnuvanız var; bitince hesabınızı kapatabilirsiniz', 'You have an ongoing tournament; you can close your account once it ends', 'У тебя идёт турнир; аккаунт можно закрыть после его окончания'],
    ['İncelemedeki ödülünüz serbest kalınca hesabınızı kapatabilirsiniz', 'You can close your account once your prize under review is released', 'Аккаунт можно закрыть после того, как приз пройдёт проверку'],
    ['Geçersiz tutar', 'Invalid amount', 'Неверная сумма'],
    ['En az çekim tutarı {0} $', 'The minimum withdrawal is {0} $', 'Минимальная сумма вывода {0} $'],
    ['Bakiyeniz yetersiz', 'Insufficient balance', 'Недостаточно средств'],
    ['Bu talep artık iptal edilemez', 'This request can no longer be cancelled', 'Эту заявку уже нельзя отменить'],
    ['Asistan şu anda kullanılamıyor', 'The assistant is not available right now', 'Ассистент сейчас недоступен'],
    ['Mesaj 1–2000 karakter olmalı', 'The message must be 1–2000 characters', 'Сообщение должно содержать 1–2000 символов'],
    ['Oyun ya da turnuva sürerken asistan kapalıdır; bitince tekrar dene', 'The assistant is off while a game or tournament is in progress; try again when it ends', 'Во время партии или турнира ассистент недоступен; попробуй после окончания'],
    ['Bugünkü soru hakkın doldu ({0})', 'You have used today\'s questions ({0})', 'Вопросы на сегодня закончились ({0})'],
    ['Asistan şu anda cevap veremiyor; biraz sonra tekrar dene', 'The assistant cannot answer right now; try again shortly', 'Ассистент сейчас не может ответить; попробуй чуть позже'],
    ['Yalnız kendi oyunlarını değerlendirebilirsin', 'You can only review your own games', 'Разбирать можно только свои партии'],
    ['Koç yalnız bitmiş oyunlarda çalışır', 'The coach only works on finished games', 'Тренер работает только с завершёнными партиями'],
    ['Açıklama 3–1000 karakter olmalı', 'The description must be 3–1000 characters', 'Описание должно содержать 3–1000 символов'],
    ['Geçersiz şikayet türü', 'Invalid report type', 'Неверный тип жалобы'],
    ['Yalnız oynadığın oyun için şikayette bulunabilirsin', 'You can only report games you played', 'Жаловаться можно только на свои партии'],
    ['Şikayet oyun bitince yapılabilir', 'You can report once the game ends', 'Пожаловаться можно после окончания партии'],
    ['Bot oyunlarında şikayet yapılamaz', 'Bot games cannot be reported', 'На партии с ботом жаловаться нельзя'],
    ['Günlük şikayet sınırına ulaştın (5)', 'You reached the daily report limit (5)', 'Достигнут дневной лимит жалоб (5)'],
    ['Bu oyun için zaten şikayette bulundun', 'You already reported this game', 'Ты уже пожаловался на эту партию'],
    ['Kart numarası geçersiz', 'Invalid card number', 'Неверный номер карты'],
    ['Son kullanma tarihi geçersiz', 'Invalid expiry date', 'Неверный срок действия'],
    ['Güvenlik kodu geçersiz', 'Invalid security code', 'Неверный код безопасности'],
    ['İstek gövdesi bir JSON nesnesi olmalı', 'The request body must be a JSON object', 'Тело запроса должно быть JSON-объектом'],
    ['Girdi doğrulanamadı', 'Please check the form', 'Проверь введённые данные'],
    ['İstek gövdesi çok büyük', 'The request is too large', 'Запрос слишком большой'],
    ['Geçersiz JSON', 'Invalid JSON', 'Неверный JSON'],
    ['Çok fazla istek; biraz sonra tekrar deneyin', 'Too many requests; please try again shortly', 'Слишком много запросов; попробуй чуть позже'],
    ['Çapraz kaynaklı istek reddedildi', 'Cross-origin request rejected', 'Межсайтовый запрос отклонён'],
    ['Oyununa git', 'Go to your game', 'К своей партии'],
    ['İçerik türü application/json olmalı', 'Content type must be application/json', 'Тип содержимого должен быть application/json'],
    ['Yöntem desteklenmiyor', 'Method not supported', 'Метод не поддерживается'],
    ['Ödeme bulunamadı', 'Payment not found', 'Платёж не найден'],
    ['Başarılı olmayan ödeme iade edilemez', 'An unsuccessful payment cannot be refunded', 'Неуспешный платёж нельзя вернуть'],
    ['İade tutarı ödemeyi aşıyor', 'The refund exceeds the payment', 'Сумма возврата превышает платёж'],
    ['Başarılı ödeme bulunamadı', 'No successful payment found', 'Успешный платёж не найден'],
    ['3D Secure adımı beklenmiyor', '3D Secure step not expected', 'Шаг 3D Secure не ожидается'],
    ['Bu anahtar başka bir ödemeye ait', 'This key belongs to another payment', 'Этот ключ относится к другому платежу'],
    ['Yalnız açık ya da başlamamış turnuva iptal edilebilir', 'Only open or not-yet-started tournaments can be cancelled', 'Отменить можно только открытый или не начавшийся турнир'],
    ['Talep bulunamadı', 'Request not found', 'Заявка не найдена'],
    ['Ödeme referansı (dekont/işlem no) 3–120 karakter olmalı', 'The payment reference must be 3–120 characters', 'Номер платёжного документа должен содержать 3–120 символов'],
    ['Bu talep zaten sonuçlandı', 'This request has already been completed', 'Эта заявка уже обработана'],
    ['Red gerekçesi en az 3 karakter olmalı', 'The rejection reason must be at least 3 characters', 'Причина отказа должна содержать не менее 3 символов'],
    ['Platformumuz bulunduğun bölgede hizmet vermiyor', 'Our platform is not available in your region', 'Наша платформа недоступна в твоём регионе'],
    ['Bu kartla ödeme kabul edilmiyor', 'Payments with this card are not accepted', 'Оплата этой картой не принимается'],
    ['Bu ülkeden kayıt kabul edilmiyor', 'Registration from this country is not accepted', 'Регистрация из этой страны не принимается'],
  ];

  const IDX = { en: 1, ru: 2 };
  const exact = new Map();
  const patterns = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const row of D) {
    const key = row[0];
    if (/\{\d\}/.test(key)) {
      const order = [];
      const re = esc(key).replace(/\\\{(\d)\\\}/g, (_, n) => { order.push(Number(n)); return '([\\s\\S]+?)'; });
      patterns.push({ re: new RegExp(`^${re}$`), order, row, weight: key.replace(/\{\d\}/g, '').length });
    } else exact.set(key, row);
  }
  patterns.sort((a, b) => b.weight - a.weight);

  function detect() {
    try {
      const s = localStorage.getItem('lang');
      if (SUPPORTED.includes(s)) return s;
    } catch { /* */ }
    const n = String(navigator.language || 'tr').slice(0, 2).toLowerCase();
    if (n === 'ru') return 'ru';
    if (n === 'tr' || n === 'az') return 'tr';
    return 'en';
  }
  let lang = detect();
  const explicit = (() => { try { return SUPPORTED.includes(localStorage.getItem('lang')); } catch { return false; } })();

  function core(s, depth) {
    const row = exact.get(s);
    if (row) return row[IDX[lang]];
    if (depth > 3 || !/\p{L}{2}/u.test(s)) return null;
    for (const p of patterns) {
      const m = p.re.exec(s);
      if (!m) continue;
      const vals = {};
      p.order.forEach((n, i) => { vals[n] = t(m[i + 1], depth + 1); });
      return p.row[IDX[lang]].replace(/\{(\d)\}/g, (_, n) => vals[n] ?? '');
    }
    return null;
  }

  /** Metni seçili dile çevirir; bilinmeyen metin olduğu gibi döner. */
  function t(s, depth = 0) {
    if (lang === 'tr' || typeof s !== 'string' || !s) return s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    if (!m[2]) return s;
    const out = core(m[2], depth);
    return out === null ? s : m[1] + out + m[3];
  }

  // ---- ekrandaki metni çevirme ----------------------------------------------------
  const ATTRS = ['placeholder', 'title', 'aria-label'];
  const seenText = new WeakMap();
  const seenAttr = new WeakMap();
  const skip = (elm) => !!elm && !!elm.closest('[translate="no"], script, style, textarea');

  function textNode(n) {
    const v = n.nodeValue;
    if (seenText.get(n) === v) return;
    if (skip(n.parentElement)) return;
    const o = t(v);
    seenText.set(n, o);
    if (o !== v) n.nodeValue = o;
  }
  function attr(elm, a) {
    const v = elm.getAttribute(a);
    if (v === null) return;
    const done = seenAttr.get(elm) || {};
    if (done[a] === v) return;
    const o = t(v);
    done[a] = o;
    seenAttr.set(elm, done);
    if (o !== v) elm.setAttribute(a, o);
  }
  function walk(node) {
    if (node.nodeType === 3) return textNode(node);
    if (node.nodeType !== 1 || skip(node)) return;
    for (const a of ATTRS) if (node.hasAttribute(a)) attr(node, a);
    if (node.tagName === 'INPUT' && /^(button|submit)$/i.test(node.type) && node.value) node.value = t(node.value);
    for (const c of node.childNodes) walk(c);
  }

  function start() {
    document.documentElement.lang = lang;
    if (lang === 'tr') return;
    walk(document.documentElement);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'childList') m.addedNodes.forEach(walk);
        else if (m.type === 'characterData') textNode(m.target);
        else if (m.type === 'attributes' && ATTRS.includes(m.attributeName) && !skip(m.target)) attr(m.target, m.attributeName);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    const nativeConfirm = window.confirm.bind(window);
    const nativeAlert = window.alert.bind(window);
    const nativePrompt = window.prompt.bind(window);
    window.confirm = (msg) => nativeConfirm(t(String(msg ?? '')));
    window.alert = (msg) => nativeAlert(t(String(msg ?? '')));
    window.prompt = (msg, def) => nativePrompt(t(String(msg ?? '')), def);
  }

  function setLang(l, reload = true) {
    if (!SUPPORTED.includes(l)) return;
    try { localStorage.setItem('lang', l); } catch { /* */ }
    // Kısa gecikme: çağıran aynı anda sayfa adresini değiştiriyorsa (girişten lobiye) yeni adres yüklensin.
    if (l !== lang && reload) setTimeout(() => location.reload(), 50);
  }

  window.I18N = {
    get lang() { return lang; },
    explicit,
    supported: SUPPORTED,
    names: NAMES,
    get intl() { return INTL[lang]; },
    t,
    /** Metnin sözlükte karşılığı var mı (aynı yazılan kelimeler dahil)? */
    known: (s) => { const m = /^\s*([\s\S]*?)\s*$/.exec(String(s)); const prev = lang; lang = lang === 'tr' ? 'en' : lang; try { return core(m[1], 0) !== null; } finally { lang = prev; } },
    setLang,
    keys: () => D.map((r) => r[0]),
    rows: () => D,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
