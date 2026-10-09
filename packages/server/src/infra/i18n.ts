/**
 * Sunucu tarafı dil desteği (K48): e-posta ve telefon bildirimi metinleri Türkçe, İngilizce ve
 * Rusça. Arayüz metinleri tarayıcıda çevrilir (apps/web/public/i18n.js); burada yalnız sunucunun
 * kendisinin gönderdiği metinler var. Dil, kullanıcının hesabındaki tercihtir (users.locale).
 */
export type Locale = 'tr' | 'en' | 'ru';
export const LOCALES: readonly Locale[] = ['tr', 'en', 'ru'];
export const asLocale = (s: unknown): Locale => (LOCALES.includes(s as Locale) ? (s as Locale) : 'tr');

const usd = (cents: number, l: Locale) => {
  const v = (cents / 100).toFixed(2);
  return l === 'en' ? `$${v}` : `${v.replace('.', ',')} $`;
};

/** Sistem şablonlarının adlarını çevirir ("10 USD · 8 kişi · 5 dk"); bilinmeyen ad olduğu gibi kalır. */
export function localizeTournamentName(name: string, l: Locale): string {
  if (l === 'tr') return name;
  const paid = /^(\d+(?:[.,]\d+)?) USD · (\d+) kişi · (\d+) dk$/.exec(name);
  if (paid) return l === 'en' ? `${paid[1]} USD · ${paid[2]} players · ${paid[3]} min` : `${paid[1]} USD · ${paid[2]} уч. · ${paid[3]} мин`;
  const free = /^Ücretsiz (\d+) kişilik Blitz$/.exec(name);
  if (free) return l === 'en' ? `Free ${free[1]}-player Blitz` : `Бесплатный блиц · ${free[1]} уч.`;
  return name;
}

const ROUNDS: Record<string, [string, string]> = {
  Final: ['Final', 'Финал'],
  'Yarı final': ['Semifinal', 'Полуфинал'],
  'Çeyrek final': ['Quarterfinal', 'Четвертьфинал'],
  'Son 16': ['Round of 16', '1/8 финала'],
  'Son 32': ['Round of 32', '1/16 финала'],
};
export function localizeRound(round: string, l: Locale): string {
  if (l === 'tr') return round;
  const r = ROUNDS[round];
  if (r) return l === 'en' ? r[0] : r[1];
  const n = /^(\d+)\. tur$/.exec(round);
  if (n) return l === 'en' ? `Round ${n[1]}` : `${n[1]}-й тур`;
  return round;
}

interface Mail { subject: string; body: string }

export interface EmailTexts {
  greeting(name: string): string;
  signature: string;
  verifyEmail(link: string): Mail;
  tournamentJoined(p: { name: string; feeCents: number; capacity: number; readySeconds: number; link: string }): Mail;
  tournamentStarting(p: { readySeconds: number; link: string }): Mail;
  prizeReleased(p: { cents: number; link: string }): Mail;
  withdrawalPaid(p?: { link: string }): Mail;
  withdrawalRejected(p?: { link: string }): Mail;
  digest(p: { lines: { name: string; joined: number; capacity: number }[]; link: string; unsubscribe: string }): Mail;
  push: {
    readyTitle: string;
    readyBody(sec: number): string;
    tiebreakTitle: string;
    roundStarting(round: string): string;
    matchBody(whenSec: number, white: boolean): string;
  };
  unsubscribed: { title: string; ok: string; bad: string; back: string };
}

const TR: EmailTexts = {
  greeting: (n) => `Merhaba ${n},`,
  signature: '— Satranç Turnuvaları',
  verifyEmail: (link) => ({
    subject: 'E-posta adresinizi doğrulayın',
    body: `Hesabınızı doğrulamak için bağlantıyı açın:\n${link}\n\nBağlantı 48 saat geçerlidir.`,
  }),
  tournamentJoined: (p) => ({
    subject: `Kaydın alındı: ${p.name}`,
    body: `${p.name} turnuvasına kaydın alındı${p.feeCents ? ` (giriş ücreti ${usd(p.feeCents, 'tr')})` : ''}.\n`
      + `Turnuva ${p.capacity} kişi dolunca başlar. Dolduğunda sana telefon bildirimi gönderilir; "Hazırım" demek için ${p.readySeconds} saniyen olur.\n\n`
      + `Turnuva sayfası: ${p.link}`,
  }),
  tournamentStarting: (p) => ({
    subject: 'Turnuvan başlıyor — hemen "Hazırım" de',
    body: `Kayıtlı olduğun turnuva doldu ve başlıyor. ${p.readySeconds} saniye içinde "Hazırım" demezsen hükmen elenirsin.\n\n${p.link}`,
  }),
  prizeReleased: (p) => ({
    subject: 'Ödülün çekilebilir bakiyende',
    body: `${usd(p.cents, 'tr')} ödülün incelemeden geçti ve çekilebilir bakiyene eklendi.\n\nCüzdan: ${p.link}`,
  }),
  withdrawalPaid: (p) => ({
    subject: 'Para çekme talebin ödendi',
    body: `Para çekme talebin ödendi. Bankan veya ödeme sağlayıcın tarafından alınan komisyonlar platformumuza ait değildir.${p ? `\n\nCüzdan: ${p.link}` : ''}`,
  }),
  withdrawalRejected: (p) => ({
    subject: 'Para çekme talebin reddedildi',
    body: `Para çekme talebin reddedildi ve tutar bakiyene geri döndü. Ayrıntılar cüzdan sayfanda.${p ? `\n\nCüzdan: ${p.link}` : ''}`,
  }),
  digest: (p) => ({
    subject: 'Bugünün açık turnuvaları',
    body: `Kayıt alan ücretli turnuvalar:\n${p.lines.map((t) => `• ${t.name} — ${t.joined}/${t.capacity} kayıtlı`).join('\n')}\n\nKatılmak için: ${p.link}\n\n`
      + `Bu e-postayı yeni turnuvalardan haberdar olmak istediğin için alıyorsun. Almak istemiyorsan: ${p.unsubscribe}`,
  }),
  push: {
    readyTitle: 'Turnuvan başlıyor!',
    readyBody: (s) => `${s} saniye içinde "Hazırım" de.`,
    tiebreakTitle: 'Tekrar oyunu başlıyor',
    roundStarting: (r) => `${r} başlıyor`,
    matchBody: (w, white) => `${w > 1 ? `${w} sn sonra` : 'Şimdi'} · renk: ${white ? 'beyaz' : 'siyah'}`,
  },
  unsubscribed: {
    title: 'Bildirimler',
    ok: 'Yeni turnuva duyurularından çıktın. Turnuvalarına ait bildirimler (kayıt, başlama) gelmeye devam eder.',
    bad: 'Bağlantı geçersiz.',
    back: 'Siteye dön',
  },
};

const EN: EmailTexts = {
  greeting: (n) => `Hi ${n},`,
  signature: '— Chess Tournaments',
  verifyEmail: (link) => ({
    subject: 'Verify your email address',
    body: `Open this link to verify your account:\n${link}\n\nThe link is valid for 48 hours.`,
  }),
  tournamentJoined: (p) => ({
    subject: `You're registered: ${p.name}`,
    body: `You are registered for ${p.name}${p.feeCents ? ` (entry fee ${usd(p.feeCents, 'en')})` : ''}.\n`
      + `The tournament starts when all ${p.capacity} seats are filled. We'll send a phone notification when it fills; you'll have ${p.readySeconds} seconds to press "I'm ready".\n\n`
      + `Tournament page: ${p.link}`,
  }),
  tournamentStarting: (p) => ({
    subject: 'Your tournament is starting — press "I\'m ready" now',
    body: `Your tournament is full and starting. If you don't press "I'm ready" within ${p.readySeconds} seconds you are eliminated by forfeit.\n\n${p.link}`,
  }),
  prizeReleased: (p) => ({
    subject: 'Your prize is in your withdrawable balance',
    body: `Your ${usd(p.cents, 'en')} prize passed review and was added to your withdrawable balance.\n\nWallet: ${p.link}`,
  }),
  withdrawalPaid: (p) => ({
    subject: 'Your withdrawal has been paid',
    body: `Your withdrawal has been paid. Fees charged by your bank or payment provider are not charged by our platform.${p ? `\n\nWallet: ${p.link}` : ''}`,
  }),
  withdrawalRejected: (p) => ({
    subject: 'Your withdrawal was rejected',
    body: `Your withdrawal was rejected and the amount has been returned to your balance. Details are on your wallet page.${p ? `\n\nWallet: ${p.link}` : ''}`,
  }),
  digest: (p) => ({
    subject: "Today's open tournaments",
    body: `Paid tournaments open for registration:\n${p.lines.map((t) => `• ${t.name} — ${t.joined}/${t.capacity} registered`).join('\n')}\n\nTo join: ${p.link}\n\n`
      + `You receive this email because you asked to hear about new tournaments. To stop: ${p.unsubscribe}`,
  }),
  push: {
    readyTitle: 'Your tournament is starting!',
    readyBody: (s) => `Press "I'm ready" within ${s} seconds.`,
    tiebreakTitle: 'Rematch is starting',
    roundStarting: (r) => `${r} is starting`,
    matchBody: (w, white) => `${w > 1 ? `In ${w} s` : 'Now'} · color: ${white ? 'white' : 'black'}`,
  },
  unsubscribed: {
    title: 'Notifications',
    ok: 'You unsubscribed from new tournament announcements. Notifications about your own tournaments (registration, start) will continue.',
    bad: 'Invalid link.',
    back: 'Back to the site',
  },
};

const RU: EmailTexts = {
  greeting: (n) => `Привет, ${n}!`,
  signature: '— Шахматные турниры',
  verifyEmail: (link) => ({
    subject: 'Подтверди адрес почты',
    body: `Открой ссылку, чтобы подтвердить аккаунт:\n${link}\n\nСсылка действует 48 часов.`,
  }),
  tournamentJoined: (p) => ({
    subject: `Ты зарегистрирован: ${p.name}`,
    body: `Ты зарегистрирован на турнир ${p.name}${p.feeCents ? ` (взнос ${usd(p.feeCents, 'ru')})` : ''}.\n`
      + `Турнир начнётся, когда все места (${p.capacity}) будут заняты. Когда он заполнится, мы пришлём уведомление на телефон; на нажатие «Готов» будет ${p.readySeconds} секунд.\n\n`
      + `Страница турнира: ${p.link}`,
  }),
  tournamentStarting: (p) => ({
    subject: 'Турнир начинается — нажми «Готов»',
    body: `Твой турнир заполнен и начинается. Если не нажать «Готов» в течение ${p.readySeconds} секунд, будет техническое поражение.\n\n${p.link}`,
  }),
  prizeReleased: (p) => ({
    subject: 'Приз доступен к выводу',
    body: `Приз ${usd(p.cents, 'ru')} прошёл проверку и зачислен на баланс для вывода.\n\nКошелёк: ${p.link}`,
  }),
  withdrawalPaid: (p) => ({
    subject: 'Вывод средств выплачен',
    body: `Твой вывод средств выплачен. Комиссии, которые берёт твой банк или платёжный провайдер, не относятся к нашей платформе.${p ? `\n\nКошелёк: ${p.link}` : ''}`,
  }),
  withdrawalRejected: (p) => ({
    subject: 'Вывод средств отклонён',
    body: `Вывод отклонён, сумма возвращена на баланс. Подробности на странице кошелька.${p ? `\n\nКошелёк: ${p.link}` : ''}`,
  }),
  digest: (p) => ({
    subject: 'Открытые турниры сегодня',
    body: `Платные турниры с открытой регистрацией:\n${p.lines.map((t) => `• ${t.name} — ${t.joined}/${t.capacity} записано`).join('\n')}\n\nУчаствовать: ${p.link}\n\n`
      + `Ты получаешь это письмо, потому что подписался на новости о турнирах. Отписаться: ${p.unsubscribe}`,
  }),
  push: {
    readyTitle: 'Турнир начинается!',
    readyBody: (s) => `Нажми «Готов» в течение ${s} секунд.`,
    tiebreakTitle: 'Переигровка начинается',
    roundStarting: (r) => `${r} начинается`,
    matchBody: (w, white) => `${w > 1 ? `Через ${w} с` : 'Сейчас'} · цвет: ${white ? 'белые' : 'чёрные'}`,
  },
  unsubscribed: {
    title: 'Уведомления',
    ok: 'Ты отписался от анонсов новых турниров. Уведомления о твоих турнирах (регистрация, старт) продолжат приходить.',
    bad: 'Ссылка недействительна.',
    back: 'Вернуться на сайт',
  },
};

const ALL: Record<Locale, EmailTexts> = { tr: TR, en: EN, ru: RU };
export const emailText = (l: Locale): EmailTexts => ALL[l];
