// Satranç Turnuvaları — web istemcisi (M14 MVP). Çerçevesiz, bağımlılıksız.
// Kurallar istemcide yalnızca gösterim ve anında geri bildirim içindir; karar sunucudadır.
(() => {
  'use strict';
  const C = window.ChessCore;

  // ---- küçük yardımcılar ------------------------------------------------------

  // Koşullu öğeler (cond ? x : null) sayfada "null" yazısı olarak görünmesin.
  const nativeReplace = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...nodes) {
    return nativeReplace.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  };

  /** Güvenli DOM oluşturucu: metin her zaman textContent ile yazılır (XSS yok). */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const view = () => document.getElementById('view');
  const mount = (...nodes) => view().replaceChildren(...nodes);
  const fmtClock = (ms) => {
    const s = Math.max(0, ms) / 1000;
    if (s < 10) return `0:0${s.toFixed(1)}`;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };
  const POOL_NAME = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Klasik', bot: 'Bot' };
  const STATUS = {
    OPEN: ['Kayıt açık', ''], FULL: ['Doldu', 'live'], STARTING: ['Hazır olma', 'warn'], RUNNING: ['Oynanıyor', 'live'],
    FINISHED: ['Bitti', 'done'], SETTLING: ['Sonuçlanıyor', 'done'], SETTLED: ['Tamamlandı', 'done'], CANCELLED: ['İptal', 'done'],
    ABORTED: ['Durduruldu', 'done'], DISPUTED: ['İncelemede', 'warn'], DRAFT: ['Taslak', 'done'],
  };
  const REASON = {
    mate: 'Mat', resign: 'Teslim', timeout: 'Süre bitti', timeout_vs_insufficient: 'Süre bitti; rakipte mat materyali yok',
    stalemate: 'Pat', insufficient_material: 'Yetersiz materyal', threefold_repetition: 'Üç kez tekrar', fifty_move: '50 hamle kuralı',
    agreement: 'Anlaşmalı beraberlik', abandon: 'Oyunu terk etti', forfeit: 'Hükmen (zamanında oynamadı)', adjudication: 'Hakem kararı',
  };

  /** Tutarlar her yerde tamsayı cent; gösterimde biçimlenir. */
  function money(cents, cur) {
    try { return new Intl.NumberFormat(I18N.intl, { style: 'currency', currency: cur || 'USD' }).format((cents || 0) / 100); }
    catch { return `${((cents || 0) / 100).toFixed(2)} ${cur}`; }
  }
  const fmtTime = (iso) => new Date(iso).toLocaleString(I18N.intl, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rankLabel = (rank, count) => (count > 1 ? `${rank}.–${rank + count - 1}.` : `${rank}.`);
  const ORPHAN_REASON = {
    seat_unavailable: 'Koltuğun artık yoktu (rezervasyon süresi dolmuş olabilir)',
    tournament_not_open: 'Turnuva kayıtları kapanmıştı',
    amount_mismatch: 'Ödenen tutar beklenenle uyuşmadı',
    card_country_blocked: 'Bu kartla ödeme kabul edilmiyor',
  };
  const PAY_FAIL = { card_declined: 'Kart reddedildi', insufficient_funds: 'Yetersiz bakiye', authentication_failed: '3D Secure doğrulanamadı' };

  /** K47: sıradaki seviye belirleme oyununu açar. */
  async function placementNext() {
    try {
      const r = await api('POST', '/v1/me/placement/next', {});
      location.hash = `#/oyun/${r.gameId}`;
    } catch (e) { toast(e.message); }
  }

  /** Kullanıcının harcanabilir bakiyesi (yüklenen + çekilebilir ödül), cent. */
  async function spendableCents(cur) {
    try {
      const r = await api('GET', '/v1/me/balance');
      const b = r.balances.find((x) => x.currency === (cur || 'USD'));
      return b ? b.totalCents : 0;
    } catch { return 0; }
  }

  /**
   * Ücretli turnuvaya katıl. Bakiye yeterliyse ücret bakiyeden düşülür ve koltuk hemen onaylanır;
   * yetersizse koltuk 10 dk ayrılır ve kartla ödeme sayfasına gidilir.
   */
  async function joinTournament(t) {
    let useWallet;
    if (t.entryFeeCents > 0) {
      const have = await spendableCents(t.currency);
      if (have >= t.entryFeeCents) {
        if (!confirm(`${t.name}\nGiriş ücreti ${money(t.entryFeeCents, t.currency)} bakiyenden düşülecek (bakiyen: ${money(have, t.currency)}). Katılmak istiyor musun?`)) return;
        useWallet = true;
      } else {
        const msg = `${t.name}\nGiriş ücreti ${money(t.entryFeeCents, t.currency)}. Bakiyen yetersiz (${money(have, t.currency)}).\n\nTamam: kartla öde (koltuğun 10 dakika ayrılır).\nİptal: vazgeç ya da önce Cüzdan'dan bakiye yükle.`;
        if (!confirm(msg)) return;
        useWallet = false;
      }
    }
    try {
      const r = await api('POST', `/v1/tournaments/${t.id}/join`, useWallet === undefined ? {} : { useWallet });
      if (r.paidFrom === 'wallet') toast(`Kaydın tamam: ${money(t.entryFeeCents, t.currency)} bakiyenden düşüldü.`);
      if (r.status === 'RESERVED') {
        if (r.checkoutUrl) location.href = r.checkoutUrl;
        else { toast('Koltuğun ayrıldı fakat ödeme sayfası açılamadı. Turnuva sayfasından tekrar dene.'); location.hash = `#/turnuva/${t.id}`; }
        return;
      }
      location.hash = `#/turnuva/${t.id}`;
    } catch (e) {
      toast(e.code === 'NOT_ENOUGH_RATED_GAMES' ? `${e.message}. Ücretsiz turnuvalarda oynayarak tamamlayabilirsin.` : e.message);
    }
  }

  async function resumePayment(id) {
    try {
      const r = await api('POST', `/v1/tournaments/${id}/pay`, {});
      if (r.checkoutUrl) location.href = r.checkoutUrl;
    } catch (e) { toast(e.message); }
  }

  function toast(text, link) {
    const t = el('div', { class: 'toast', role: 'status' }, el('div', {}, text), link ? el('a', { href: link.href }, link.text) : null);
    const box = document.getElementById('toasts');
    box.append(t);
    while (box.children.length > 2) box.firstElementChild.remove();
    setTimeout(() => t.remove(), link ? 12000 : 5000);
  }

  // ---- oturum ---------------------------------------------------------------

  const session = { token: null, user: null, refreshTimer: null };
  /** Sunucunun genel ayarları (demo araçları açık mı vb.). */
  let appCfg = { demoTools: false };
  const cfgReady = fetch('/v1/config').then((r) => r.json()).then((c) => { appCfg = c; }).catch(() => undefined);
  const deviceId = (() => {
    try {
      let id = localStorage.getItem('deviceId');
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem('deviceId', id);
      }
      return id;
    } catch {
      return crypto.randomUUID();
    }
  })();

  async function api(method, path, body, retry = true) {
    const headers = { 'x-device-id': deviceId };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (session.token) headers.authorization = `Bearer ${session.token}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    if (res.status === 401 && retry && session.token && !path.startsWith('/v1/auth/')) {
      if (await refresh()) return api(method, path, body, false);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(data?.message || `İstek başarısız (${res.status})`);
      err.code = data?.code;
      err.details = data?.details;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // httpOnly çerez okunamaz; daha önce oturum açıldığını gösteren hassas olmayan bir işaret tutulur.
  const hint = {
    set(v) { try { if (v) localStorage.setItem('hadSession', '1'); else localStorage.removeItem('hadSession'); } catch { /* */ } },
    get() { try { return localStorage.getItem('hadSession') === '1'; } catch { return true; } },
  };

  function adopt(r) {
    hint.set(true);
    syncLocale(r.user);
    session.token = r.accessToken;
    session.user = r.user;
    clearTimeout(session.refreshTimer);
    session.refreshTimer = setTimeout(() => void refresh(), Math.max(30, r.expiresIn - 60) * 1000);
    ws.authenticate();
    renderNav();
  }

  /**
   * K48: dil tercihi. Cihazda seçilmiş dil varsa hesaba yazılır (e-postalar o dilde gelir);
   * yoksa hesabın dili cihaza uygulanır.
   */
  let localeSynced = false;
  function syncLocale(user) {
    if (!user?.locale || localeSynced) return;
    localeSynced = true;
    if (I18N.explicit || user.locale === I18N.lang) {
      if (user.locale !== I18N.lang) void api('POST', '/v1/me/locale', { locale: I18N.lang }).catch(() => undefined);
    } else I18N.setLang(user.locale);
  }
  async function changeLang(l) {
    if (session.token) await api('POST', '/v1/me/locale', { locale: l }).catch(() => undefined);
    I18N.setLang(l);
  }
  (function langPicker() {
    const sel = document.getElementById('lang-select');
    if (!sel) return;
    sel.replaceChildren(...I18N.supported.map((l) => el('option', { value: l, selected: l === I18N.lang }, I18N.names[l])));
    sel.addEventListener('change', () => void changeLang(sel.value));
  })();

  async function refresh() {
    try {
      adopt(await api('POST', '/v1/auth/refresh', {}, false));
      return true;
    } catch {
      session.token = null;
      session.user = null;
      hint.set(false);
      renderNav();
      return false;
    }
  }

  async function logout() {
    try {
      await api('POST', '/v1/auth/logout', {}, false);
    } catch { /* yine de çık */ }
    session.token = null;
    session.user = null;
    hint.set(false);
    clearTimeout(session.refreshTimer);
    ws.reconnect();
    renderNav();
    location.hash = '#/';
  }

  // ---- WebSocket --------------------------------------------------------------

  const ws = {
    sock: null,
    listeners: new Set(),
    topics: new Set(),
    backoff: 500,
    open: false,
    connect() {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`;
      const s = new WebSocket(url);
      this.sock = s;
      s.onopen = () => {
        this.open = true;
        this.backoff = 500;
        document.getElementById('conn').hidden = true;
        this.authenticate();
        for (const t of this.topics) this.raw(JSON.parse(t));
      };
      s.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        for (const fn of [...this.listeners]) fn(m);
      };
      s.onclose = () => {
        this.open = false;
        const bar = document.getElementById('conn');
        bar.textContent = 'Bağlantı koptu, yeniden bağlanılıyor…';
        bar.hidden = false;
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(8000, this.backoff * 2);
      };
    },
    reconnect() {
      try { this.sock?.close(); } catch { /* */ }
    },
    authenticate() {
      if (this.open && session.token) this.raw({ type: 'auth', token: session.token });
    },
    raw(m) {
      if (this.open) this.sock.send(JSON.stringify(m));
    },
    send(m) {
      this.raw(m);
    },
    /** Bağlantı yenilense de tekrar gönderilecek abonelik mesajı. */
    keep(m) {
      this.topics.add(JSON.stringify(m));
      this.raw(m);
    },
    drop(m) {
      this.topics.delete(JSON.stringify(m));
    },
    on(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };

  // Uygulama genelindeki bildirimler: maç hazır, oyun başladı, hazır olma kontrolü.
  const matchTournament = new Map();
  ws.on((m) => {
    if (m.type === 'auth.ok') {
      // Kimlik doğrulanınca abonelikleri yenile (kişisel bildirimler için).
      for (const t of ws.topics) ws.raw(JSON.parse(t));
    } else if (m.type === 'match.ready') {
      matchTournament.set(m.matchId, m.tournamentId);
      const when = new Date(m.startAt).getTime() - Date.now();
      const label = m.tiebreak ? `${m.round}, tekrar oyunu (1 dk)` : m.round;
      toast(`${label} ${when > 1500 ? `${Math.round(when / 1000)} sn sonra başlıyor` : 'başlıyor'}. Rengin: ${m.color === 'w' ? 'beyaz' : 'siyah'}.`, { href: `#/oyun/${m.gameId}`, text: 'Oyuna git' });
    } else if (m.type === 'game.started') {
      if (m.matchId && !matchTournament.has(m.matchId)) matchTournament.set(m.matchId, null);
      if (!location.hash.startsWith(`#/oyun/${m.gameId}`)) location.hash = `#/oyun/${m.gameId}`;
    } else if (m.type === 'payment.confirmed') {
      if (!m.fromWallet) toast('Ödemen alındı, koltuğun onaylandı.', { href: `#/turnuva/${m.tournamentId}`, text: 'Turnuvaya git' });
    } else if (m.type === 'placement.step') {
      const box = el('div', {}, `Seviye belirleme: ${m.step}/${m.total} oyun tamam. `, el('button', { class: 'btn small', type: 'button', onclick: () => void placementNext() }, 'Sıradaki oyun'));
      toast(box);
    } else if (m.type === 'placement.done') {
      toast(`Seviyen belirlendi: başlangıç puanın yaklaşık ${m.estimate}. Gerçek maçlarla kesinleşir.`);
    } else if (m.type === 'wallet.deposited') {
      toast(`${money(m.amountCents, 'USD')} bakiyene yüklendi.`, { href: '#/cuzdan', text: 'Cüzdan' });
    } else if (m.type === 'withdrawal.paid') {
      toast('Para çekme talebin ödendi.', { href: '#/cuzdan', text: 'Cüzdan' });
    } else if (m.type === 'withdrawal.rejected') {
      toast('Para çekme talebin reddedildi; tutar bakiyene geri döndü.', { href: '#/cuzdan', text: 'Cüzdan' });
    } else if (m.type === 'payment.orphaned') {
      toast(`${ORPHAN_REASON[m.reason] || 'Ödemen koltuğa bağlanamadı'}. Ücretin otomatik olarak iade ediliyor.`, { href: '#/cuzdan', text: 'Cüzdan' });
    } else if (m.type === 'payment.failed') {
      toast(`Ödeme başarısız: ${PAY_FAIL[m.reason] || m.reason || 'bilinmeyen neden'}. Rezervasyon süresi içinde tekrar deneyebilirsin.`);
    } else if (m.type === 'reservation.expired') {
      toast('Ödeme süresi doldu; koltuğun bırakıldı.', { href: `#/turnuva/${m.tournamentId}`, text: 'Turnuva' });
    } else if (m.type === 'prize.awarded') {
      toast(`Tebrikler! ${m.rank}. oldun: ${money(m.cents, m.currency)}. Ödül ${fmtTime(m.holdUntil)} tarihine kadar güvenlik incelemesinde bekler.`, { href: '#/cuzdan', text: 'Cüzdan' });
    } else if (m.type === 'prize.released') {
      toast(`${money(m.cents, m.currency)} ödülün çekilebilir bakiyene geçti.`, { href: '#/cuzdan', text: 'Cüzdan' });
    } else if (m.type === 'tournament.readyCheck') {
      toast(`Turnuva doldu. ${m.readySeconds} saniye içinde "Hazırım" de.`, { href: `#/turnuva/${m.tournamentId}`, text: 'Turnuvaya git' });
      if (!location.hash.startsWith(`#/turnuva/${m.tournamentId}`)) location.hash = `#/turnuva/${m.tournamentId}`;
    }
  });

  // ---- gezinti -----------------------------------------------------------------

  function renderNav() {
    const nav = document.getElementById('nav');
    if (session.user) {
      nav.replaceChildren(...[
        el('a', { href: '#/' }, 'Lobi'),
        el('a', { href: '#/cuzdan', id: 'nav-wallet' }, 'Cüzdan'),
        el('a', { href: '#/asistan', id: 'nav-assistant' }, 'Asistan'),
        isStaff() ? el('a', { href: '#/yonetim', id: 'nav-admin' }, 'Yönetim') : null,
        el('a', { class: 'who', href: '#/ayarlar', id: 'nav-settings', title: 'Ayarlar' }, session.user.displayName),
        el('button', { class: 'btn', type: 'button', onclick: logout }, 'Çıkış'),
      ].filter(Boolean));
    } else {
      nav.replaceChildren(el('a', { class: 'btn', href: '#/giris' }, 'Giriş'), el('a', { class: 'btn primary', href: '#/kayit' }, 'Kayıt ol'));
    }
  }

  let cleanup = null;
  async function route() {
    if (cleanup) {
      try { cleanup(); } catch { /* */ }
      cleanup = null;
    }
    const hash = location.hash || '#/';
    const [path, qs] = hash.slice(1).split('?');
    const params = new URLSearchParams(qs || '');
    const parts = path.split('/').filter(Boolean);
    try {
      if (parts[0] === 'giris') return loginView();
      if (parts[0] === 'kayit') return registerView();
      if (parts[0] === 'dogrula') return verifyView(params.get('token'));
      if (parts[0] === 'oyun' && parts[1]) return (cleanup = gameView(parts[1]));
      if (parts[0] === 'turnuva' && parts[1]) return (cleanup = tournamentView(parts[1], params));
      if (parts[0] === 'cuzdan') return (cleanup = await walletView());
      if (parts[0] === 'asistan') return (cleanup = await assistantView(params.get('oyun')));
      if (parts[0] === 'ayarlar') return (cleanup = await settingsView());
      if (parts[0] === 'yonetim') return (cleanup = await adminView(parts[1] || 'genel', parts[2], params));
      return (cleanup = await lobbyView());
    } catch (e) {
      mount(el('p', { class: 'msg err' }, e.message || String(e)));
    }
  }

  // ---- giriş ve kayıt ----------------------------------------------------------

  const FIELD_NAMES = { email: 'E-posta', password: 'Şifre', displayName: 'Kullanıcı adı', birthDate: 'Doğum tarihi', countryCode: 'Ülke' };
  function fieldError(form, e) {
    const box = form.querySelector('.form-error');
    const fields = e.details?.fields ? Object.entries(e.details.fields).map(([k, v]) => `${I18N.t(FIELD_NAMES[k] || k)} ${I18N.t(String(v))}`).join(', ') : '';
    box.textContent = I18N.t(e.message) + (fields ? `: ${fields}` : '');
    box.hidden = false;
  }

  function loginView() {
    const form = el('form', { class: 'stack', id: 'login-form' },
      el('label', { class: 'field' }, el('span', {}, 'E-posta'), el('input', { id: 'login-email', type: 'email', required: true, autocomplete: 'email' })),
      el('label', { class: 'field' }, el('span', {}, 'Şifre'), el('input', { id: 'login-password', type: 'password', required: true, autocomplete: 'current-password' })),
      el('p', { class: 'msg err form-error', hidden: true }),
      el('button', { class: 'btn primary', type: 'submit' }, 'Giriş yap'),
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        adopt(await api('POST', '/v1/auth/login', { email: form.querySelector('#login-email').value, password: form.querySelector('#login-password').value }));
        location.hash = '#/';
      } catch (e) {
        fieldError(form, e);
      }
    });
    mount(el('section', { class: 'card narrow' }, el('h1', {}, 'Giriş'), form, el('p', { class: 'small muted' }, 'Hesabın yok mu? ', el('a', { href: '#/kayit' }, 'Kayıt ol'))));
  }

  const COUNTRIES = [['TR', 'Türkiye'], ['GB', 'Birleşik Krallık'], ['DE', 'Almanya'], ['NL', 'Hollanda'], ['FR', 'Fransa'], ['US', 'ABD'], ['ES', 'İspanya'], ['IT', 'İtalya'], ['GE', 'Gürcistan'], ['KZ', 'Kazakistan'], ['UA', 'Ukrayna'], ['RU', 'Rusya']];

  async function devVerify(email) {
    const mail = await api('GET', `/v1/dev/mailbox?email=${encodeURIComponent(email)}`);
    const token = mail.messages[0]?.token;
    if (!token) throw new Error('Posta kutusunda doğrulama e-postası yok');
    return api('POST', '/v1/auth/verify-email', { token });
  }

  function registerView() {
    const form = el('form', { class: 'stack', id: 'register-form' },
      el('label', { class: 'field' }, el('span', {}, 'E-posta'), el('input', { id: 'reg-email', type: 'email', required: true, autocomplete: 'email' })),
      el('label', { class: 'field' }, el('span', {}, 'Kullanıcı adı (3–20, harf, rakam, _ -)'), el('input', { id: 'reg-name', required: true, minlength: 3, maxlength: 20, autocomplete: 'username' })),
      el('label', { class: 'field' }, el('span', {}, 'Şifre (en az 10 karakter)'), el('input', { id: 'reg-password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
      el('div', { class: 'grid2' },
        el('label', { class: 'field' }, el('span', {}, 'Doğum tarihi'), el('input', { id: 'reg-birth', type: 'date', required: true })),
        el('label', { class: 'field' }, el('span', {}, 'Ülke'), el('select', { id: 'reg-country' }, COUNTRIES.map(([c, n]) => el('option', { value: c }, n)))),
      ),
      el('label', { class: 'check' }, el('input', { id: 'reg-tos', type: 'checkbox' }), el('span', {}, '18 yaşından büyüğüm; Kullanım Şartları ve Turnuva Kurallarını kabul ediyorum.')),
      el('label', { class: 'check' }, el('input', { id: 'reg-news', type: 'checkbox' }), el('span', {}, 'Yeni turnuvalardan e-postayla haberdar olmak istiyorum (günde en fazla bir e-posta; istediğin zaman çıkabilirsin).')),
      el('p', { class: 'small muted' }, 'Doğum tarihin yalnızca yaş kontrolü için kullanılır; yalnız doğum yılın saklanır.'),
      el('p', { class: 'msg err form-error', hidden: true }),
      el('button', { class: 'btn primary', type: 'submit' }, 'Kayıt ol'),
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const email = form.querySelector('#reg-email').value;
      const password = form.querySelector('#reg-password').value;
      try {
        await api('POST', '/v1/auth/register', {
          email,
          password,
          displayName: form.querySelector('#reg-name').value,
          birthDate: form.querySelector('#reg-birth').value,
          countryCode: form.querySelector('#reg-country').value,
          acceptTos: form.querySelector('#reg-tos').checked,
          newTournamentsEmail: form.querySelector('#reg-news').checked,
          locale: I18N.lang,
        });
        const done = el('section', { class: 'card narrow-wide' },
          el('h1', {}, 'Hesabın oluşturuldu'),
          el('p', {}, `${email} adresine doğrulama bağlantısı gönderdik. Turnuvalara katılmak için e-postanı doğrula.`),
          el('p', { class: 'msg info small' }, 'Geliştirme ortamında gerçek e-posta gönderilmez; aşağıdaki düğme geliştirme posta kutusundaki bağlantıyı kullanır.'),
          el('div', { class: 'row' },
            el('button', { class: 'btn primary', id: 'dev-verify', type: 'button', onclick: async () => {
              try {
                await devVerify(email);
                adopt(await api('POST', '/v1/auth/login', { email, password }));
                toast('E-posta doğrulandı. Hoş geldin!');
                location.hash = '#/';
              } catch (e) { toast(e.message); }
            } }, 'Doğrula ve giriş yap'),
            el('a', { class: 'btn', href: '#/giris' }, 'Giriş sayfası'),
          ),
        );
        mount(done);
      } catch (e) {
        fieldError(form, e);
      }
    });
    mount(el('section', { class: 'card narrow-wide' }, el('h1', {}, 'Kayıt ol'), form));
  }

  async function verifyView(token) {
    mount(el('p', { class: 'muted' }, 'Doğrulanıyor…'));
    try {
      await api('POST', '/v1/auth/verify-email', { token });
      mount(el('section', { class: 'card' }, el('h1', {}, 'E-posta doğrulandı'), el('a', { class: 'btn primary', href: session.user ? '#/' : '#/giris' }, session.user ? 'Lobiye dön' : 'Giriş yap')));
      if (session.user) await refresh();
    } catch (e) {
      mount(el('p', { class: 'msg err' }, e.message));
    }
  }

  // ---- lobi -------------------------------------------------------------------

  async function lobbyView() {
    const root = el('div', { class: 'grid2' });
    const left = el('div', { class: 'col' });
    const right = el('div', { class: 'col' });
    root.append(left, right);
    mount(root);

    if (appCfg.demoTools) {
      right.append(el('section', { class: 'card demo', id: 'demo-banner' },
        el('h2', {}, 'Test sürümü'),
        el('p', { class: 'small' }, 'Ödemeler sahtedir, gerçek para çekilmez. Test kartı: ', el('b', { class: 'mono' }, '4242 4242 4242 4242'), ' · tarih 12/30 · CVC 123.'),
        el('p', { class: 'small muted' }, 'İlk iki hesap yönetici olur. Turnuva sayfasında "Test botlarıyla doldur" ile turnuvayı tek başına başlatabilirsin.'),
      ));
    }
    // Ana ekran (K44): önce ücretli turnuvalar (açık olanlar kare kutucuklarda, süren/başlayacak olanlar
    // altında), ücretsiz turnuvalar ve bot antrenmanı en altta.
    const listCard = el('div', { class: 'col', id: 'tournament-list' }, el('section', { class: 'card' }, el('p', { class: 'muted small' }, 'Yükleniyor…')));
    left.append(listCard);
    const minutes = (tc) => Math.round(Number(String(tc).split('+')[0]) / 60);

    let active = null;
    async function loadList() {
      const data = await api('GET', '/v1/tournaments');
      active = data.active;
      const paid = data.tournaments.filter((t) => t.entryFeeCents > 0);
      const free = data.tournaments.filter((t) => !(t.entryFeeCents > 0));
      const seatsOf = (t) => el('span', { class: 'seats', 'aria-label': `${t.joined}/${t.capacity} dolu` }, Array.from({ length: Math.min(t.capacity, 8) }, (_, i) => el('i', { class: i < Math.round((t.joined / t.capacity) * Math.min(t.capacity, 8)) ? 'on' : '' })));
      const canJoin = (t) => t.status === 'OPEN' && session.user && !active;

      const open = paid.filter((t) => t.status === 'OPEN').sort((a, b) => a.capacity - b.capacity || minutes(a.timeControl) - minutes(b.timeControl));
      const tiles = open.map((t) => {
        const mine = active === t.id;
        const first = t.prizes?.[0]?.cents;
        const body = [
          el('span', { class: 'fee' }, money(t.entryFeeCents, t.currency)),
          el('span', { class: 'tc' }, `${minutes(t.timeControl)} dk · ${t.capacity} kişi`),
          first ? el('span', { class: 'who' }, `1. ${money(first, t.currency)}${t.prizes[1] ? ` · 2. ${money(t.prizes[1].cents, t.currency)}` : ''}`) : null,
          el('span', { class: 'who' }, seatsOf(t), ` ${t.joined}/${t.capacity}`),
        ];
        return canJoin(t)
          ? el('button', { class: 'tile', type: 'button', dataset: { join: t.id }, 'aria-label': `${t.name}, katıl`, onclick: () => joinTournament(t) }, body)
          : el('a', { class: `tile ${mine ? 'mine' : ''}`, href: `#/turnuva/${t.id}` }, body, mine ? el('span', { class: 'pill' }, 'Kayıtlısın') : null);
      });

      const row = (t) => {
        const [label, cls] = STATUS[t.status] || [t.status, ''];
        const mine = active === t.id;
        const action = canJoin(t)
          ? el('button', { class: 'btn accent', type: 'button', dataset: { join: t.id }, onclick: () => joinTournament(t) }, t.entryFeeCents ? `Katıl · ${money(t.entryFeeCents, t.currency)}` : 'Katıl')
          : el('a', { class: 'btn', href: `#/turnuva/${t.id}` }, mine ? 'Turnuvam' : 'Görüntüle');
        return el('div', { class: 'trow' },
          el('div', { class: 'col tiny' },
            el('div', { class: 'row' }, el('span', { class: 'name' }, t.name), el('span', { class: `pill ${cls}` }, label), mine ? el('span', { class: 'pill' }, 'Kayıtlısın') : null),
            el('div', { class: 'meta' },
              el('span', {}, `${t.capacity} kişi`), el('span', { class: 'mono' }, `${minutes(t.timeControl)} dk`),
              el('span', { class: t.entryFeeCents ? 'fee' : '' }, t.entryFeeCents ? money(t.entryFeeCents, t.currency) : 'Ücretsiz'),
              el('span', {}, seatsOf(t), ` ${t.joined}/${t.capacity}`),
            ),
          ),
          action,
        );
      };
      const going = paid.filter((t) => t.status !== 'OPEN');
      listCard.replaceChildren(
        el('section', { class: 'card', id: 'paid-tournaments' },
          el('div', { class: 'section-head' }, el('h2', {}, 'Ücretli turnuvalar'), el('span', { class: 'small muted' }, 'Kontenjan dolunca başlar · eleme usulü')),
          tiles.length ? el('div', { class: 'tiles' }, tiles) : el('p', { class: 'muted small' }, 'Şu an açık ücretli turnuva yok.'),
        ),
        going.length ? el('section', { class: 'card', id: 'running-tournaments' }, el('h2', {}, 'Süren ve başlayacak turnuvalar'), el('div', { class: 'tlist' }, going.map(row))) : null,
        el('section', { class: 'card', id: 'free-tournaments' },
          el('h2', {}, 'Ücretsiz turnuvalar'),
          free.length ? el('div', { class: 'tlist' }, free.map(row)) : el('p', { class: 'muted small' }, 'Şu an ücretsiz turnuva yok.'),
        ),
      );
    }
    await loadList();

    if (!session.user) {
      right.append(el('section', { class: 'card' },
        el('h2', {}, 'Başlamak için'),
        el('p', {}, 'Ücretsiz turnuvalara katılmak ve botla antrenman yapmak için hesap aç.'),
        el('div', { class: 'row' }, el('a', { class: 'btn primary', href: '#/kayit' }, 'Kayıt ol'), el('a', { class: 'btn', href: '#/giris' }, 'Giriş')),
      ));
    } else {
      const me = await api('GET', '/v1/me');
      session.user = me.user;
      if (!me.user.emailVerified) {
        right.append(el('section', { class: 'card' },
          el('p', { class: 'msg info' }, 'Turnuvalara katılmak için e-posta adresini doğrula.'),
          el('div', { class: 'row' },
            el('button', { class: 'btn primary', type: 'button', onclick: async () => {
              try { await devVerify(me.user.email); toast('E-posta doğrulandı.'); route(); } catch (e) { toast(e.message); }
            } }, 'Geliştirme kutusundan doğrula'),
            el('button', { class: 'btn', type: 'button', onclick: async () => { await api('POST', '/v1/auth/resend-verification', {}); toast('Bağlantı yeniden gönderildi.'); } }, 'Yeniden gönder'),
          ),
        ));
      }
      const live = await api('GET', '/v1/me/live-games');
      if (live.games.length) {
        right.append(el('section', { class: 'card' }, el('p', { class: 'msg ok' }, 'Devam eden bir oyunun var.'), el('a', { class: 'btn primary', href: `#/oyun/${live.games[0]}` }, 'Oyununa dön')));
      }
      const pl = await api('GET', '/v1/me/placement').catch(() => null);
      if (pl && (pl.needed || pl.status === 'active')) {
        right.append(el('section', { class: 'card', id: 'placement-card' },
          el('h2', {}, 'Seviyeni belirle'),
          el('p', { class: 'small' }, `Bota karşı ${pl.total} kısa oyun oyna; bot senin oyununa göre güçlenir ya da zayıflar. Sonunda başlangıç puanın belirlenir ve sana uygun rakiplerle eşleşirsin.`),
          pl.status === 'active' ? el('p', { class: 'small muted' }, `${pl.step}/${pl.total} oyun tamamlandı.`) : null,
          el('button', { class: 'btn primary', type: 'button', id: 'placement-next', onclick: () => void placementNext() },
            pl.status === 'active' ? `Sıradaki oyun (${pl.step + 1}/${pl.total})` : 'Başla'),
        ));
      }
      const r = await api('GET', '/v1/me/ratings');
      right.append(el('section', { class: 'card' },
        el('h2', {}, 'Rating'),
        r.ratings.length
          ? el('div', { class: 'ratings' }, r.ratings.map((x) => el('div', { class: 'r' }, el('b', {}, `${x.rating}${x.provisional ? '?' : ''}`), el('span', {}, `${POOL_NAME[x.pool] || x.pool} · ${x.games} oyun`))))
          : el('p', { class: 'muted small' }, 'Henüz rating yok. İlk oyunlarından sonra burada görünür.'),
      ));
      left.append(botPanel());
    }

    let t = null;
    const off = ws.on((m) => {
      if (m.type === 'lobby.update') {
        clearTimeout(t);
        t = setTimeout(() => void loadList().catch(() => undefined), 150);
      }
    });
    const sub = { type: 'lobby.subscribe' };
    ws.keep(sub);
    return () => {
      off();
      ws.drop(sub);
      clearTimeout(t);
    };
  }

  function botPanel() {
    const form = el('form', { class: 'stack', id: 'bot-form' },
      el('label', { class: 'field' }, el('span', {}, 'Seviye'), el('select', { id: 'bot-level' })),
      el('div', { class: 'grid2' },
        el('label', { class: 'field' }, el('span', {}, 'Renk'), el('select', { id: 'bot-color' }, el('option', { value: 'random' }, 'Rastgele'), el('option', { value: 'white' }, 'Beyaz'), el('option', { value: 'black' }, 'Siyah'))),
        el('label', { class: 'field' }, el('span', {}, 'Süre'), el('select', { id: 'bot-tc' }, [['180+2', '3+2'], ['300+3', '5+3'], ['600+5', '10+5'], ['60+0', '1+0']].map(([v, l]) => el('option', { value: v }, l)))),
      ),
      el('button', { class: 'btn primary', type: 'submit' }, 'Botla oyna'),
    );
    void api('GET', '/v1/bots/levels').then((r) => {
      form.querySelector('#bot-level').replaceChildren(...r.levels.map((l) => el('option', { value: l.id, selected: l.id === 'kolay' }, `${l.name} (~${l.elo})`)));
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      try {
        const g = await api('POST', '/v1/bots/games', { level: form.querySelector('#bot-level').value, color: form.querySelector('#bot-color').value, timeControl: form.querySelector('#bot-tc').value });
        location.hash = `#/oyun/${g.gameId}`;
      } catch (e) { toast(e.message); }
    });
    return el('section', { class: 'card' }, el('h2', {}, 'Antrenman: bota karşı'), el('p', { class: 'small muted' }, 'Bot oyunları ayrı bir rating havuzunda tutulur.'), form);
  }

  // ---- oyun ekranı -------------------------------------------------------------

  const PIECE_NAME = { k: 'şah', q: 'vezir', r: 'kale', b: 'fil', n: 'at', p: 'piyon' };
  /** Taşlar kendi setimiz (K44): /pieces/wK.svg … bP.svg */
  const pieceImg = (color, type) => el('img', { class: 'piece', src: `/pieces/${color}${type.toUpperCase()}.svg`, alt: '', draggable: 'false' });
  const FILES = 'abcdefgh';

  function gameView(gameId) {
    const s = {
      state: null, chess: null, myColor: null, selected: null, promo: null, clock: null, clockAt: 0,
      ended: null, offline: { w: false, b: false }, confirmResign: false,
    };
    const boardEl = el('div', { class: 'board', id: 'board', role: 'grid', 'aria-label': 'Satranç tahtası' });
    const top = el('div', { class: 'player', id: 'player-top' });
    const bottom = el('div', { class: 'player', id: 'player-bottom' });
    const status = el('div', { class: 'card', id: 'game-status' });
    const movesEl = el('ol', { class: 'moves', id: 'moves' });
    const actions = el('div', { class: 'row', id: 'game-actions' });
    const reviewEl = el('section', { class: 'card', id: 'review', hidden: true });
    mount(el('div', { class: 'game' },
      el('div', { class: 'board-wrap' }, top, boardEl, bottom),
      el('div', { class: 'col tight' }, status, reviewEl, el('section', { class: 'card' }, el('h2', {}, 'Hamleler'), movesEl), el('section', { class: 'card' }, actions)),
    ));
    let reviewState = null;
    let reviewPoll = null;
    let reportOpen = false;

    // ---- K45: oyun sonu analizi, asistan ve şikayet ----
    async function loadReview() {
      try { reviewState = await api('GET', `/v1/games/${gameId}/review`); } catch (e) { reviewState = { status: 'error', message: e.message }; }
      renderReview();
    }
    function renderReview() {
      if (!s.ended || !s.myColor) { reviewEl.hidden = true; return; }
      reviewEl.hidden = false;
      const opp = s.state.players[s.myColor === 'w' ? 'b' : 'w'];
      const head = el('div', { class: 'spread' }, el('h2', {}, 'Oyun analizi'),
        el('a', { class: 'btn small', href: `#/asistan?oyun=${gameId}`, id: 'ask-coach' }, 'Asistana sor'));
      const parts = [head];
      const r = reviewState;
      if (!r) parts.push(el('p', { class: 'small muted' }, 'Yükleniyor…'));
      else if (r.status === 'ready') {
        const CLS = [['best', 'En iyi'], ['good', 'İyi'], ['inaccuracy', 'Küçük hata'], ['mistake', 'Hata'], ['blunder', 'Büyük hata']];
        const row = (color) => {
          const p = r.players[color === 'w' ? 'white' : 'black'];
          const total = Object.values(p.counts).reduce((a, b) => a + b, 0) || 1;
          return el('div', { class: 'acc-row', dataset: { color } },
            el('div', { class: 'spread' },
              el('span', { class: 'pname' }, `${color === 'w' ? '○' : '●'} ${s.state.players[color].name || 'Bot'}${color === s.myColor ? ' (sen)' : ''}`),
              el('b', { class: 'acc mono' }, p.accuracy === null ? '—' : `%${p.accuracy.toLocaleString(I18N.intl)}`)),
            el('div', { class: 'acc-bar', 'aria-hidden': 'true' }, CLS.map(([k]) => p.counts[k] ? el('i', { class: `c-${k}`, style: null, dataset: { w: Math.round((p.counts[k] / total) * 100) } }) : null)),
            el('div', { class: 'acc-legend small' }, CLS.map(([k, label]) => el('span', { class: `c-${k}` }, `${label} ${p.counts[k]} (%${Math.round((p.counts[k] / total) * 100)})`))),
          );
        };
        parts.push(row('w'), row('b'), evalGraph(r.evalGraph));
        const key = r.moves.filter((m) => m.color === s.myColor && (m.class === 'mistake' || m.class === 'blunder'));
        parts.push(el('div', { class: 'col tiny' }, el('span', { class: 'small muted' }, key.length ? 'Senin kritik anların' : 'Büyük hata yapmadın.'),
          key.slice(0, 6).map((m) => el('div', { class: 'small' }, el('b', {}, `${Math.ceil(m.ply / 2)}${m.color === 'w' ? '.' : '...'} ${m.san}`), ` — ${m.class === 'blunder' ? 'büyük hata' : 'hata'}${m.bestSan ? ` · daha iyisi ${m.bestSan}` : ''}`))));
      } else if (r.status === 'queued' || r.status === 'running') {
        parts.push(el('p', { class: 'small', id: 'review-wait' }, 'Analiz ediliyor… Hazır olunca burada görünecek.'));
        // Bildirim kaçarsa yedek: birkaç saniyede bir yokla.
        clearTimeout(reviewPoll);
        reviewPoll = setTimeout(() => void loadReview(), 4000);
      } else if (r.status === 'error') {
        parts.push(el('p', { class: 'small muted' }, r.message));
      } else {
        parts.push(el('p', { class: 'small muted' }, 'Bu oyunun doğruluk oranını, iyi hamlelerini ve hatalarını görmek için analiz et.'),
          el('button', { class: 'btn primary', type: 'button', id: 'review-request', onclick: async () => {
            try {
              const r2 = await api('POST', `/v1/games/${gameId}/review`);
              // Analiz bu cevaptan önce bitmiş olabilir (WebSocket bildirimi önce gelir): hazır sonucu ezme.
              if (reviewState?.status !== 'ready') { reviewState = r2; renderReview(); }
              if (r2.status === 'ready') await loadReview();
            } catch (e) { toast(e.message); }
          } }, 'Analiz et'));
      }
      if (opp?.id && opp.id !== session.user.id && s.state.kind !== 'bot') {
        if (!reportOpen) parts.push(el('button', { class: 'link small', type: 'button', id: 'report-open', onclick: () => { reportOpen = true; renderReview(); } }, 'Rakibi şikayet et'));
        else {
          const cat = el('select', { id: 'report-category' }, el('option', { value: 'cheating' }, 'Hile şüphesi'), el('option', { value: 'abuse' }, 'Kötü davranış'), el('option', { value: 'other' }, 'Diğer'));
          const txt = el('textarea', { id: 'report-text', rows: 3, maxlength: 1000, placeholder: 'Neden şikayet ediyorsun? Kısaca anlat.' });
          const form = el('form', { class: 'stack', id: 'report-form' },
            el('label', { class: 'field' }, el('span', {}, 'Şikayet türü'), cat),
            el('label', { class: 'field' }, el('span', {}, 'Açıklama'), txt),
            el('p', { class: 'small muted' }, 'Şikayetin inceleme ekibine iletilir; kararı insanlar verir. Aynı oyun için bir kez şikayet edebilirsin.'),
            el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit' }, 'Gönder'), el('button', { class: 'btn', type: 'button', onclick: () => { reportOpen = false; renderReview(); } }, 'Vazgeç')),
          );
          form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            try {
              await api('POST', `/v1/games/${gameId}/report`, { category: cat.value, text: txt.value });
              reportOpen = false;
              toast('Şikayetin alındı. İnceleme ekibi değerlendirecek.');
              renderReview();
            } catch (e) { toast(e.message); }
          });
          parts.push(form);
        }
      }
      reviewEl.replaceChildren(...parts);
      for (const i of reviewEl.querySelectorAll('.acc-bar i')) i.style.flexGrow = i.dataset.w;
    }
    function evalGraph(values) {
      const W = 300;
      const H = 70;
      const n = Math.max(values.length, 2);
      const y = (v) => H / 2 - (Math.max(-1000, Math.min(1000, v)) / 1000) * (H / 2 - 2);
      const pts = values.map((v, i) => `${((i / (n - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`);
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('class', 'eval-graph');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', 'Oyun boyunca değerlendirme grafiği (üst beyaz üstün, alt siyah üstün)');
      const area = document.createElementNS(svgNs, 'polygon');
      area.setAttribute('points', `0,${H} ${pts.join(' ')} ${W},${H}`);
      area.setAttribute('class', 'eg-area');
      const mid = document.createElementNS(svgNs, 'line');
      mid.setAttribute('x1', '0'); mid.setAttribute('x2', String(W)); mid.setAttribute('y1', String(H / 2)); mid.setAttribute('y2', String(H / 2));
      mid.setAttribute('class', 'eg-mid');
      const line = document.createElementNS(svgNs, 'polyline');
      line.setAttribute('points', pts.join(' '));
      line.setAttribute('class', 'eg-line');
      svg.append(area, mid, line);
      return el('div', { class: 'eval-wrap' }, svg);
    }

    function rebuild(st) {
      s.state = st;
      const g = new C.ChessGame({ fen: st.initialFen, rules: C.CASUAL_RULES });
      for (const m of st.moves) g.move(m.uci);
      s.chess = g;
      s.myColor = session.user && st.players.w.id === session.user.id ? 'w' : session.user && st.players.b.id === session.user.id ? 'b' : null;
      setClock(st.clock);
      s.ended = st.status === 'finished' ? { result: st.result, reason: st.reason, winner: st.winner } : null;
      render();
    }
    function setClock(c) {
      s.clock = { ...c };
      s.clockAt = performance.now();
    }
    function remaining(color) {
      if (!s.clock) return 0;
      const base = color === 'w' ? s.clock.whiteMs : s.clock.blackMs;
      return s.clock.running === color && !s.ended ? base - (performance.now() - s.clockAt) : base;
    }

    function renderBoard() {
      const g = s.chess;
      const flipped = s.myColor === 'b';
      const order = [];
      for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) order.push(FILES[f] + (r + 1));
      if (flipped) order.reverse();
      const targets = new Map();
      if (s.selected) for (const m of g.moves(s.selected)) targets.set(m.to, m);
      const hist = g.history();
      const last = hist.length ? hist[hist.length - 1].move : null;
      let checkSq = null;
      if (g.isCheck()) for (const sq of order) { const p = g.get(sq); if (p && p.type === 'k' && p.color === g.turn) checkSq = sq; }
      boardEl.replaceChildren(...order.map((sq, idx) => {
        const file = FILES.indexOf(sq[0]);
        const rank = Number(sq[1]) - 1;
        const p = g.get(sq);
        const cls = ['sq', (file + rank) % 2 === 0 ? 'dark' : 'light'];
        if (last && (last.from === sq || last.to === sq)) cls.push('last');
        if (s.selected === sq) cls.push('selected');
        if (checkSq === sq) cls.push('check');
        return el('button', { type: 'button', class: cls.join(' '), dataset: { square: sq }, 'aria-label': p ? `${sq} ${I18N.t(p.color === 'w' ? 'beyaz' : 'siyah')} ${I18N.t(PIECE_NAME[p.type])}` : sq, onclick: () => onSquare(sq) },
          p ? pieceImg(p.color, p.type) : null,
          targets.has(sq) ? el('span', { class: p || targets.get(sq).flag === 'e' ? 'target capture' : 'target' }) : null,
          idx % 8 === 0 ? el('span', { class: 'coord rank' }, sq[1]) : null,
          idx >= 56 ? el('span', { class: 'coord file' }, sq[0]) : null,
        );
      }));
      if (s.promo) {
        boardEl.append(el('div', { class: 'promo' }, el('div', { class: 'promo-card' },
          el('div', {}, 'Terfi'),
          el('div', { class: 'promo-row' }, ['q', 'r', 'b', 'n'].map((t) => el('button', { type: 'button', id: `promo-${t}`, 'aria-label': PIECE_NAME[t], onclick: () => { const { from, to } = s.promo; s.promo = null; send(from, to, t); } }, pieceImg(s.myColor, t)))),
          el('button', { class: 'btn', type: 'button', onclick: () => { s.promo = null; render(); } }, 'Vazgeç'),
        )));
      }
    }

    function onSquare(sq) {
      const g = s.chess;
      if (!s.myColor || s.ended || g.turn !== s.myColor || s.promo) return;
      const p = g.get(sq);
      if (s.selected) {
        const opts = g.moves(s.selected).filter((m) => m.to === sq);
        if (opts.length) {
          if (opts[0].promotion) { s.promo = { from: s.selected, to: sq }; s.selected = null; render(); return; }
          const from = s.selected;
          s.selected = null;
          send(from, sq);
          return;
        }
        s.selected = p && p.color === s.myColor && sq !== s.selected ? sq : null;
        render();
        return;
      }
      if (p && p.color === s.myColor) { s.selected = sq; render(); }
    }

    function send(from, to, promotion) {
      const g = s.chess;
      let m;
      try { m = g.move(promotion ? { from, to, promotion } : { from, to }); } catch { render(); return; }
      // İyimser gösterim: sunucu onayı gelene kadar hamle tahtada görünür.
      ws.send({ type: 'game.move', gameId, uci: m.uci, seq: g.plyCount() });
      if (s.clock) { s.clock = { ...s.clock, [s.myColor === 'w' ? 'whiteMs' : 'blackMs']: remaining(s.myColor), running: s.myColor === 'w' ? 'b' : 'w' }; s.clockAt = performance.now(); }
      render();
    }

    function resync() { ws.send({ type: 'game.join', gameId }); }

    function renderPlayers() {
      const st = s.state;
      const flipped = s.myColor === 'b';
      const topColor = flipped ? 'w' : 'b';
      const bottomColor = flipped ? 'b' : 'w';
      for (const [node, c] of [[top, topColor], [bottom, bottomColor]]) {
        const pl = st.players[c];
        const ms = remaining(c);
        const running = s.clock && s.clock.running === c && !s.ended;
        node.replaceChildren(
          el('span', { class: 'pname' }, `${c === 'w' ? '○' : '●'} ${pl.name}`, s.offline[c] ? el('span', { class: 'off' }, 'bağlantı koptu') : null),
          el('span', { class: `clock${running ? ' running' : ''}${running && ms < 10000 ? ' low' : ''}`, id: `clock-${c}` }, fmtClock(ms)),
        );
      }
    }

    function renderStatus() {
      const st = s.state;
      const g = s.chess;
      const kind = st.kind === 'tournament' ? (st.tiebreak ? `Turnuva · ${st.gameNo - 1}. tekrar oyunu (1 dk)` : 'Turnuva') : st.kind === 'bot' ? 'Bot oyunu' : 'Serbest oyun';
      const tid = st.matchId ? matchTournament.get(st.matchId) : null;
      const lines = [el('div', { class: 'spread' }, el('span', { class: 'small muted' }, `${kind} · ${C.parseTimeControl(st.timeControl).label}`), tid ? el('a', { href: `#/turnuva/${tid}`, class: 'small' }, 'Turnuva tablosu') : el('a', { href: '#/', class: 'small' }, 'Lobi'))];
      if (s.ended) {
        const who = s.ended.winner ? `${s.ended.winner === 'w' ? 'Beyaz' : 'Siyah'} kazandı` : 'Berabere';
        lines.push(el('div', { class: 'result', id: 'game-result' }, `${s.ended.result.replace('1/2-1/2', '½–½')} · ${who}`), el('div', { class: 'muted' }, REASON[s.ended.reason] || s.ended.reason || ''));
        if (s.state.kind === 'tournament' && !s.ended.winner) lines.push(el('div', { class: 'small' }, 'Berabere: renkler değişerek 1 dakikalık tekrar oyunu başlayacak.'));
      } else {
        const mine = s.myColor && g.turn === s.myColor;
        lines.push(el('div', { id: 'turn-line' }, g.isCheck() ? 'Şah! ' : '', mine ? 'Sıra sende.' : s.myColor ? 'Rakibin düşünüyor.' : `Sıra ${g.turn === 'w' ? 'beyazda' : 'siyahta'}.`));
        if (st.drawOfferBy && s.myColor && st.drawOfferBy !== s.myColor) lines.push(el('p', { class: 'msg info' }, 'Rakibin beraberlik teklif etti.'));
      }
      status.replaceChildren(...lines);
    }

    function renderMoves() {
      const hist = s.chess.history();
      const items = [];
      for (let i = 0; i < hist.length; i++) {
        const h = hist[i];
        if (h.move.color === 'w' || i === 0) items.push(el('li', { class: 'no' }, `${h.fenBefore.split(' ')[5]}.`));
        if (h.move.color === 'b' && i === 0) items.push(el('li', {}, '…'));
        items.push(el('li', { class: i === hist.length - 1 ? 'latest' : '' }, h.move.san));
      }
      movesEl.replaceChildren(...items);
      movesEl.scrollTop = movesEl.scrollHeight;
    }

    function renderActions() {
      if (!s.myColor || s.ended) {
        actions.replaceChildren(el('a', { class: 'btn', href: '#/' }, 'Lobiye dön'));
        return;
      }
      const st = s.state;
      const canOffer = s.chess.plyCount() >= (st.rules?.drawOfferMinFullMoves || 0) * 2;
      const offered = st.drawOfferBy;
      actions.replaceChildren(
        s.confirmResign
          ? el('span', { class: 'row' }, el('button', { class: 'btn danger', type: 'button', id: 'resign-yes', onclick: () => { s.confirmResign = false; ws.send({ type: 'game.resign', gameId }); } }, 'Evet, teslim ol'), el('button', { class: 'btn', type: 'button', onclick: () => { s.confirmResign = false; render(); } }, 'Vazgeç'))
          : el('button', { class: 'btn danger', type: 'button', id: 'resign', onclick: () => { s.confirmResign = true; render(); } }, 'Teslim ol'),
        offered && offered !== s.myColor
          ? el('span', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: () => ws.send({ type: 'game.drawAccept', gameId }) }, 'Beraberliği kabul et'), el('button', { class: 'btn', type: 'button', onclick: () => ws.send({ type: 'game.drawDecline', gameId }) }, 'Reddet'))
          : el('button', { class: 'btn', type: 'button', disabled: !canOffer || offered === s.myColor || s.state.kind === 'bot', title: canOffer ? '' : `${st.rules.drawOfferMinFullMoves}. hamleden sonra`, onclick: () => ws.send({ type: 'game.drawOffer', gameId }) }, offered === s.myColor ? 'Teklif gönderildi' : 'Beraberlik teklif et'),
      );
    }

    function render() {
      if (!s.state) return;
      renderPlayers();
      renderBoard();
      renderStatus();
      renderMoves();
      renderActions();
      if (s.ended && s.myColor && reviewState === null) { reviewState = undefined; void loadReview(); }
      else renderReview();
    }

    const off = ws.on((m) => {
      if (m.gameId !== gameId && m.type !== 'error') return;
      if (m.type === 'game.state') rebuild(m);
      else if (m.type === 'game.move') {
        const g = s.chess;
        if (!g) return;
        if (m.ply === g.plyCount() && g.history()[m.ply - 1]?.move.uci === m.uci) {
          // Kendi iyimser hamlemizin onayı.
        } else if (m.ply === g.plyCount() + 1) {
          try { g.move(m.uci); } catch { resync(); return; }
        } else { resync(); return; }
        s.state.drawOfferBy = m.drawOfferBy;
        setClock(m.clock);
        render();
      } else if (m.type === 'game.end') {
        s.ended = { result: m.result, reason: m.reason, winner: m.winner };
        setClock(m.clock);
        s.selected = null;
        render();
      } else if (m.type === 'game.draw') {
        s.state.drawOfferBy = m.drawOfferBy;
        if (m.action === 'decline' && m.by !== s.myColor) toast('Beraberlik teklifi reddedildi.');
        render();
      } else if (m.type === 'game.presence') {
        s.offline[m.color] = !m.online;
        render();
      } else if (m.type === 'review.ready') {
        void loadReview();
      } else if (m.type === 'error' && (m.for || '').startsWith('game.')) {
        toast(m.message);
        resync();
      }
    });
    const join = { type: 'game.join', gameId };
    ws.keep(join);
    const ticker = setInterval(() => { if (s.state && !s.ended) renderPlayers(); }, 100);
    // Adil oyun telemetrisi (doküman 14.2 Katman 2): yalnız oyuncunun kendi canlı oyununda
    // sekme gizlendi/göründü bilgisi gönderilir; zaman damgasını sunucu koyar.
    const onVisibility = () => {
      if (s.myColor && !s.ended) ws.send({ type: 'game.focus', gameId, hidden: document.visibilityState === 'hidden' });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      off();
      clearTimeout(reviewPoll);
      ws.drop(join);
      ws.send({ type: 'game.leave', gameId });
      clearInterval(ticker);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  // ---- turnuva sayfası ---------------------------------------------------------

  function tournamentView(id, params = new URLSearchParams()) {
    let d = null;
    let verify = null;
    // Ödeme sayfasından dönüş: ?odeme=<id>. Durum yalnız sunucudan (webhook ile kesinleşmiş) okunur.
    const paymentId = params.get('odeme');
    let payment = null;
    let payPoll = null;
    async function pollPayment() {
      if (!paymentId || !session.user) return;
      try {
        payment = await api('GET', `/v1/payments/${paymentId}`);
        render();
        if (payment.status === 'CREATED' || (payment.status === 'SUCCEEDED' && d && !d.entries.some((e) => e.id === session.user.id && e.status !== 'RESERVED'))) {
          payPoll = setTimeout(pollPayment, 1000);
        }
      } catch { /* sessiz */ }
    }
    const root = el('div', { class: 'col' }, el('p', { class: 'muted' }, 'Yükleniyor…'));
    mount(root);

    function render() {
      if (!d) return;
      const me = session.user ? d.entries.find((e) => e.id === session.user.id) : null;
      const [label, cls] = STATUS[d.status] || [d.status, ''];
      const head = el('header', { class: 'spread' },
        el('div', {},
          el('p', { class: 'eyebrow' }, `${d.capacity} kişilik eleme · ${d.timeControlLabel} · ${d.entryFeeCents ? 'Ücretli' : 'Ücretsiz'}`),
          el('h1', {}, d.name),
        ),
        el('span', { class: `pill ${cls}`, id: 'tournament-status' }, label),
      );

      const paid = d.entryFeeCents > 0;
      const actions = [];
      if (d.status === 'OPEN') {
        if (me?.status === 'RESERVED') {
          actions.push(el('button', { class: 'btn accent', type: 'button', id: 'pay', onclick: () => resumePayment(id) }, `Öde · ${money(d.entryFeeCents, d.currency)}`));
          actions.push(el('button', { class: 'btn', type: 'button', id: 'leave', onclick: async () => { try { await api('POST', `/v1/tournaments/${id}/leave`, {}); } catch (e) { toast(e.message); } } }, 'Vazgeç'));
        } else if (me) {
          actions.push(el('button', { class: 'btn', type: 'button', id: 'leave', onclick: async () => {
            if (paid && !confirm(`Turnuvadan ayrılırsan ${money(d.entryFeeCents, d.currency)} ücretin iade edilir (bakiyeden ödediysen hemen bakiyene, kartla ödediysen kartına). Ayrılmak istiyor musun?`)) return;
            try {
              const r = await api('POST', `/v1/tournaments/${id}/leave`, {});
              if (r.refund) toast('Ayrıldın. Ücretin iade edildi.', { href: '#/cuzdan', text: 'Cüzdan' });
            } catch (e) { toast(e.message); }
          } }, 'Ayrıl'));
          const slot = el('div', { id: 'nudge-slot' });
          actions.push(slot);
          void pushNudge().then((n) => { if (n) slot.replaceChildren(n); });
        } else if (session.user) actions.push(el('button', { class: 'btn accent', type: 'button', id: 'join', onclick: () => joinTournament(d) }, paid ? `Katıl · ${money(d.entryFeeCents, d.currency)}` : 'Katıl'));
        else actions.push(el('a', { class: 'btn primary', href: '#/giris' }, 'Katılmak için giriş yap'));
      }
      let payMsg = null;
      if (me?.status === 'RESERVED' && d.status === 'OPEN') {
        const mins = Math.max(0, Math.ceil((new Date(me.reservedUntil).getTime() - Date.now()) / 60000));
        payMsg = el('p', { class: 'msg info', id: 'pay-msg' }, `Koltuğun ${mins} dakika boyunca senin için ayrıldı. Ödeme tamamlanınca kaydın kesinleşir.`);
      }
      if (payment) {
        const confirmed = me && me.status !== 'RESERVED';
        if (payment.status === 'SUCCEEDED') payMsg = el('p', { class: 'msg ok', id: 'pay-msg' }, confirmed ? `Ödeme alındı (kart •••• ${payment.cardLast4 || ''}). Kaydın kesinleşti.` : 'Ödeme alındı; koltuğun onaylanıyor…');
        else if (payment.status === 'CREATED') payMsg = el('p', { class: 'msg info', id: 'pay-msg' }, 'Ödeme sağlayıcısından onay bekleniyor…');
        else if (payment.status === 'FAILED') payMsg = el('p', { class: 'msg err', id: 'pay-msg' }, `Ödeme başarısız: ${PAY_FAIL[payment.failureReason] || payment.failureReason}.`);
        else if (payment.status === 'REFUNDED' || payment.refundStatus) payMsg = el('p', { class: 'msg err', id: 'pay-msg' }, 'Ödemen bu turnuvaya bağlanamadı ve iade edildi.');
      }
      if (d.status === 'STARTING' && me) {
        const left = Math.max(0, Math.round((new Date(d.readyDeadline).getTime() - Date.now()) / 1000));
        actions.push(me.ready
          ? el('span', { class: 'pill live' }, 'Hazırsın — diğerleri bekleniyor')
          : el('button', { class: 'btn accent', type: 'button', id: 'ready', onclick: () => ws.send({ type: 'tournament.ready', tournamentId: id }) }, `Hazırım (${left} sn)`));
      }
      if (d.status === 'OPEN' && appCfg.demoTools && isStaff()) {
        const joined = !!me;
        actions.push(el('button', { class: 'btn', type: 'button', id: 'fill-bots', onclick: async (ev) => {
          ev.target.disabled = true;
          ev.target.textContent = 'Botlar katılıyor…';
          try {
            const r = await api('POST', `/v1/admin/tournaments/${id}/fill-bots`, { leaveSeats: joined ? 0 : 1 });
            toast(joined ? `${r.added} test botu katıldı; turnuva doluyor.` : `${r.added} test botu katıldı. Son koltuk senin: "Katıl"a bas.`);
          } catch (e) { toast(e.message); ev.target.disabled = false; }
        } }, joined ? 'Kalan koltukları test botlarıyla doldur' : 'Bana bir koltuk bırakıp botlarla doldur'));
      }
      const myGame = d.matches.flatMap((m) => m.games.map((g) => ({ ...g, m }))).find((g) => g.status === 'active' && (g.m.a?.id === session.user?.id || g.m.b?.id === session.user?.id));
      if (myGame) actions.push(el('a', { class: 'btn primary', href: `#/oyun/${myGame.id}` }, 'Oyununa git'));

      const joinedCount = d.entries.filter((e) => e.status !== 'RESERVED').length;
      const info = el('section', { class: 'card' },
        el('div', { class: 'spread' },
          el('div', {}, el('div', { class: 'big-count' }, `${joinedCount}/${d.capacity}`), el('div', { class: 'small muted' }, 'oyuncu')),
          el('div', { class: 'row' }, actions),
        ),
        payMsg,
        d.status === 'STARTING' ? el('p', { class: 'msg info' }, `Turnuva doldu. Herkes ${d.readySeconds} saniye içinde "Hazırım" demeli; demeyen hükmen elenir${paid ? ' (ücret iade edilmez)' : ''}.`) : null,
        el('p', { class: 'small muted' }, 'Her tur tek oyun. Berabere biterse 1 dakikalık tekrar oyunları oynanır; her seferinde renkler değişir ve biri kazanana kadar sürer.'),
        paid ? el('p', { class: 'small muted', id: 'fairplay-note' }, 'Adil oyun: ücretli oyunlar bittikten sonra motorla analiz edilir; oyun sırasında sekme değiştirme kaydedilir. Ödüller inceleme bitince serbest kalır.') : null,
      );

      const rounds = [];
      for (let r = 1; r <= d.rounds; r++) {
        const ms = d.matches.filter((m) => m.round === r);
        rounds.push(el('div', { class: 'round' }, el('h3', {}, d.roundNames[r - 1]),
          ms.length ? ms.map((m) => matchCard(m)) : Array.from({ length: d.capacity / 2 ** r }, () => el('div', { class: 'match' }, el('div', { class: 'side muted' }, '—'), el('div', { class: 'side muted' }, '—'))),
        ));
      }
      const bracket = el('section', { class: 'card' }, el('h2', {}, 'Eleme tablosu'), el('div', { class: 'bracket', id: 'bracket' }, rounds));

      let prizes = null;
      if (paid) {
        const awarded = d.awards && d.awards.length;
        prizes = el('section', { class: 'card', id: 'prizes' }, el('h2', {}, awarded ? 'Ödüller' : 'Ödül tablosu'),
          awarded
            ? el('ul', { class: 'entrants' }, d.awards.map((a) => el('li', {},
              el('span', {}, `${a.rank}. ${a.name}`),
              el('span', {}, el('b', { class: 'mono' }, money(a.cents, d.currency)), ' ',
                el('span', { class: `pill ${a.status === 'RELEASED' ? 'live' : a.status === 'VOID' ? 'warn' : ''}` }, a.status === 'RELEASED' ? 'ödendi' : a.status === 'VOID' ? 'iptal' : 'bekletmede')))))
            : el('ul', { class: 'entrants' }, d.prizes.map((p) => el('li', {}, el('span', {}, rankLabel(p.rank, p.count)), el('b', { class: 'mono' }, p.count > 1 ? `${money(p.cents, d.currency)} (kişi başı)` : money(p.cents, d.currency))))),
          el('p', { class: 'small muted' },
            d.settlement
              ? `Toplam giriş ${money(d.settlement.grossCents, d.currency)} · sistem payı ${money(d.settlement.rakeCents, d.currency)} · ödül havuzu ${money(d.settlement.prizePoolCents, d.currency)}. Ödüller güvenlik incelemesi için bekletilir, sonra çekilebilir bakiyene geçer.`
              : `Kontenjan dolarsa: ${d.capacity} × ${money(d.entryFeeCents, d.currency)}, sistem payı %${(d.rakeBps / 100).toLocaleString(I18N.intl)}. Kuruş artığı şampiyona eklenir.`),
        );
      }

      const entrants = el('section', { class: 'card' }, el('h2', {}, 'Oyuncular'),
        d.entries.length ? el('ul', { class: 'entrants' }, [...d.entries].sort((a, b) => (a.finalRank ?? 99) - (b.finalRank ?? 99) || (a.seed ?? 99) - (b.seed ?? 99)).map((e) => el('li', {},
          el('span', {}, e.finalRank ? `${e.finalRank}. ` : '', e.name, session.user?.id === e.id ? ' (sen)' : ''),
          el('span', { class: 'small muted' }, e.status === 'RESERVED' ? 'ödeme bekleniyor' : d.status === 'STARTING' ? (e.ready ? 'hazır' : 'bekleniyor') : e.status === 'ELIMINATED' ? 'elendi' : e.status === 'WINNER' ? 'şampiyon' : e.seed ? `sıra ${e.seed}` : ''),
        ))) : el('p', { class: 'muted small' }, 'Henüz kimse katılmadı.'),
      );

      const fair = el('section', { class: 'card' }, el('h2', {}, 'Adil eşleştirme'),
        el('p', { class: 'small' }, 'Eşleşmeler gizli bir rastgele değerle (seed) belirlenir. Turnuva açılırken bu değerin özeti yayınlanır; başlangıçta değerin kendisi açıklanır. Böylece kimse eşleşmeleri sonradan değiştiremez.'),
        el('div', { class: 'small muted' }, 'Yayınlanan özet (SHA-256):'), el('div', { class: 'hash', id: 'seed-hash' }, d.seedHash),
        d.seed ? [el('div', { class: 'small muted' }, 'Açıklanan seed:'), el('div', { class: 'hash' }, d.seed),
          el('button', { class: 'btn', type: 'button', id: 'verify', onclick: async () => { verify = await api('GET', `/v1/tournaments/${id}/verify`); render(); } }, 'Doğrula')] : el('div', { class: 'small muted' }, 'Seed turnuva başlayınca açıklanacak.'),
        verify ? el('p', { class: `msg ${verify.hashMatches && verify.orderMatches ? 'ok' : 'err'}`, id: 'verify-result' }, verify.hashMatches && verify.orderMatches ? 'Doğrulandı: seed özetle eşleşiyor ve yerleşim yeniden üretildi.' : 'Doğrulama başarısız.') : null,
      );

      root.replaceChildren(head, el('div', { class: 'grid2' }, el('div', { class: 'col' }, info, bracket), el('div', { class: 'col' }, prizes, entrants, fair)));
    }

    function matchCard(m) {
      const mine = session.user && (m.a?.id === session.user.id || m.b?.id === session.user.id);
      const side = (p, score, isA) => {
        const won = m.winnerId && p && m.winnerId === p.id;
        const lost = m.winnerId && p && m.winnerId !== p.id;
        return el('div', { class: `side${won ? ' win' : ''}${lost ? ' lose' : ''}` }, el('span', {}, p ? p.name : m.status === 'VOID' ? '(boş)' : '—'), el('span', { class: 'mono' }, m.games.length ? String(Number(score)).replace('.5', '½') : ''));
      };
      const foot = [];
      if (m.decidedBy === 'no_show') foot.push('hükmen');
      if (m.decidedBy === 'walkover') foot.push('rakipsiz geçti');
      if (m.decidedBy === 'tiebreak') foot.push('tekrar oyunuyla');
      for (const g of m.games) {
        foot.push(el('a', { href: `#/oyun/${g.id}` }, g.tiebreak ? `T${g.gameNo - 1}` : 'Oyun', g.status === 'active' ? ' canlı' : g.result ? ` ${g.result.replace('1/2-1/2', '½')}` : ' bekliyor'));
      }
      return el('div', { class: `match${mine ? ' mine' : ''}` }, side(m.a, m.scoreA, true), side(m.b, m.scoreB, false), foot.length ? el('div', { class: 'foot' }, foot) : null);
    }

    const off = ws.on((m) => {
      if (m.type === 'tournament.update' && m.tournament.id === id) {
        d = m.tournament;
        for (const mt of d.matches) matchTournament.set(mt.id, id);
        render();
      } else if (m.type === 'error' && m.for === 'tournament.ready') toast(m.message);
    });
    const sub = { type: 'tournament.subscribe', tournamentId: id };
    ws.keep(sub);
    void api('GET', `/v1/tournaments/${id}`).then((x) => { d = x; for (const mt of d.matches) matchTournament.set(mt.id, id); render(); void pollPayment(); }).catch((e) => root.replaceChildren(el('p', { class: 'msg err' }, e.message)));
    const ticker = setInterval(() => { if (d && (d.status === 'STARTING' || d.entries.some((e) => e.status === 'RESERVED'))) render(); }, 1000);
    return () => {
      clearTimeout(payPoll);
      off();
      ws.drop(sub);
      ws.send({ type: 'tournament.unsubscribe', tournamentId: id });
      clearInterval(ticker);
    };
  }

  // ---- cüzdan --------------------------------------------------------------------

  async function walletView() {
    if (!session.user) {
      mount(el('section', { class: 'card narrow' }, el('p', {}, 'Cüzdanını görmek için giriş yap.'), el('a', { class: 'btn primary', href: '#/giris' }, 'Giriş')));
      return null;
    }
    const root = el('div', { class: 'col' }, el('p', { class: 'muted' }, 'Yükleniyor…'));
    mount(root);
    const PAY_STATUS = { CREATED: 'bekliyor', SUCCEEDED: 'ödendi', FAILED: 'başarısız', REFUNDED: 'iade edildi', DISPUTED: 'itiraz', CANCELED: 'iptal' };
    const REASONS = {
      ENTRY_PAID: 'Giriş', TOURNAMENT_SETTLE: 'Ödül (bekletmede)', PRIZE_RELEASE: 'Ödül serbest', PRIZE_VOID: 'Ödül iptali',
      PAYOUT: 'Çekim', PAYOUT_REQUEST: 'Çekim talebi', PAYOUT_REVERSAL: 'Çekim iadesi', ADJUSTMENT: 'Düzeltme',
      DEPOSIT: 'Bakiye yükleme', WALLET_ENTRY: 'Turnuva girişi', WALLET_REFUND: 'Giriş iadesi',
    };
    const BUCKET = { pending: 'bekletme', available: 'kazanç', deposit: 'yüklenen' };
    const W_STATUS = { REQUESTED: ['inceleniyor', ''], PAID: ['ödendi', 'live'], REJECTED: ['reddedildi', 'warn'], CANCELED: ['iptal', 'done'] };
    const METHOD = { ewallet: 'E-cüzdan', bank: 'Banka havalesi' };
    const params = new URLSearchParams((location.hash.split('?')[1]) || '');
    if (params.get('odeme')) {
      void api('GET', `/v1/payments/${params.get('odeme')}`).then((p) => {
        if (p.status === 'SUCCEEDED') toast('Ödeme alındı; bakiyen güncellendi.');
        else if (p.status === 'CREATED') toast('Ödeme onayı bekleniyor; birkaç saniye içinde bakiyene yansır.');
        else if (p.status === 'FAILED') toast(`Ödeme başarısız: ${PAY_FAIL[p.failureReason] || p.failureReason || ''}`);
      }).catch(() => undefined);
    }

    function payoutForm({ closure, rules, total, cur }) {
      const amount = el('input', { type: 'number', min: closure ? 0 : rules.minWithdrawCents / 100, step: '0.01', id: closure ? 'close-amount' : 'wd-amount', value: closure ? (total / 100).toFixed(2) : '', disabled: closure, inputmode: 'decimal' });
      const method = el('select', { id: closure ? 'close-method' : 'wd-method' }, el('option', { value: 'ewallet' }, 'E-cüzdan'), el('option', { value: 'bank' }, 'Banka havalesi'));
      const dest = el('input', { type: 'text', id: closure ? 'close-dest' : 'wd-dest', maxlength: 120, placeholder: 'E-cüzdan e-postası / hesap no' });
      const holder = el('input', { type: 'text', id: closure ? 'close-holder' : 'wd-holder', maxlength: 80, placeholder: 'Ad Soyad', value: '' });
      const preview = el('p', { class: 'small', id: closure ? 'close-preview' : 'wd-preview' });
      async function quote() {
        const cents = closure ? total : Math.round(Number(amount.value) * 100);
        dest.placeholder = method.value === 'bank' ? 'IBAN' : 'E-cüzdan e-postası / hesap no';
        if (!cents) { preview.textContent = ''; return; }
        const q = await api('GET', `/v1/me/wallet/quote?amountCents=${cents}&method=${method.value}`);
        preview.replaceChildren(
          el('span', {}, `Çekilen: ${money(q.amountCents, cur)} · tahmini komisyon: ${money(q.feeCents, cur)} · hesabına geçecek: `),
          el('b', {}, money(q.netCents, cur)),
        );
      }
      amount.addEventListener('input', () => void quote());
      method.addEventListener('change', () => void quote());
      const form = el('form', { class: 'stack', id: closure ? 'close-form' : 'withdraw-form' },
        closure ? null : el('label', { class: 'field' }, el('span', {}, `Tutar (en az ${money(rules.minWithdrawCents, cur)})`), amount),
        el('label', { class: 'field' }, el('span', {}, 'Yöntem'), method),
        el('label', { class: 'field' }, el('span', {}, 'Hesap bilgisi'), dest),
        el('label', { class: 'field' }, el('span', {}, 'Hesap sahibinin adı'), holder),
        preview,
        el('p', { class: 'msg info small', id: closure ? 'close-notice' : 'withdraw-notice' }, rules.notice.tr),
        el('button', { class: `btn ${closure ? 'danger' : 'primary'}`, type: 'submit' }, closure ? 'Hesabımı kapat ve bakiyemi çek' : 'Çekim talebi gönder'),
      );
      if (closure) void quote();
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const cents = closure ? total : Math.round(Number(amount.value) * 100);
        const sure = closure
          ? confirm(`Hesabın kapatılacak${total ? ` ve ${money(total, cur)} bakiyenin tamamı çekilecek` : ''}. Bu işlem geri alınamaz. Devam edilsin mi?`)
          : confirm(`${money(cents, cur)} çekim talebi gönderilsin mi? Komisyon çekilen tutardan düşülür.`);
        if (!sure) return;
        try {
          if (closure) {
            const r = await api('POST', '/v1/me/close-account', { method: method.value, destination: dest.value || undefined, holderName: holder.value || undefined });
            if (r.closed) { toast('Hesabın kapatıldı.'); await logout(); return; }
            toast('Hesap kapatma talebin alındı. Bakiyen gönderilince hesabın kapanacak.');
          } else {
            await api('POST', '/v1/me/withdrawals', { amountCents: cents, method: method.value, destination: dest.value, holderName: holder.value });
            toast('Çekim talebin alındı. Ödeme yapılınca bildirim alacaksın.');
          }
          await load();
        } catch (e) { toast(e.message); }
      });
      return form;
    }

    async function load() {
      const w = await api('GET', '/v1/me/wallet');
      const bals = w.balances.length ? w.balances : [{ currency: 'USD', availableCents: 0, pendingCents: 0, depositCents: 0, totalCents: 0 }];
      const usd = bals.find((b) => b.currency === 'USD') || bals[0];
      const cur = usd.currency;
      const rules = w.withdrawals.rules;
      const openW = w.withdrawals.items.find((x) => x.status === 'REQUESTED');
      const depositForm = el('form', { class: 'row', id: 'deposit-form' },
        el('input', { type: 'number', id: 'deposit-amount', min: rules.minDepositCents / 100, max: rules.maxDepositCents / 100, step: '1', value: String(rules.minDepositCents / 100), inputmode: 'numeric', class: 'amount-input' }),
        el('button', { class: 'btn primary', type: 'submit' }, 'Bakiye yükle'),
      );
      depositForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const cents = Math.round(Number(depositForm.querySelector('#deposit-amount').value) * 100);
        try {
          const r = await api('POST', '/v1/me/wallet/deposit', { amountCents: cents, key: `w${Date.now()}${Math.random().toString(36).slice(2, 8)}` });
          if (r.checkoutUrl) location.href = r.checkoutUrl;
        } catch (e) { toast(e.message); }
      });
      const summary = el('section', { class: 'card', id: 'wallet-balance' }, el('h2', {}, 'Bakiye'),
        el('div', { class: 'stat big' }, el('span', { class: 'small muted' }, 'Toplam bakiye'), el('b', { class: 'mono', dataset: { total: cur } }, money(usd.totalCents, cur))),
        el('div', { class: 'wallet-grid' },
          el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Yüklenen'), el('b', { class: 'mono', dataset: { deposit: cur } }, money(usd.depositCents, cur))),
          el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Kazanılan (çekilebilir)'), el('b', { class: 'mono', dataset: { available: cur } }, money(usd.availableCents, cur))),
          el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Bekletmede'), el('b', { class: 'mono', dataset: { pending: cur } }, money(usd.pendingCents, cur))),
        ),
        el('p', { class: 'small muted' }, `Bir kerede ${money(rules.minDepositCents, cur)}–${money(rules.maxDepositCents, cur)} yükleyebilirsin. Turnuva ücretleri bakiyenden düşülür.`),
        depositForm,
        el('p', { class: 'small muted' }, 'Ödüller, hile incelemesi için tutara göre 12–48 saat bekletilir; sonra çekilebilir bakiyeye geçer.'),
      );
      const withdraw = el('section', { class: 'card', id: 'withdraw-card' }, el('h2', {}, 'Para çek'),
        openW
          ? el('p', { class: 'msg info' }, `Bekleyen talebin var: ${money(openW.amountCents, openW.currency)} (${METHOD[openW.method]}). Sonuçlanınca yeni talep verebilirsin.`)
          : usd.totalCents >= rules.minWithdrawCents
            ? payoutForm({ closure: false, rules, total: usd.totalCents, cur })
            : el('p', { class: 'small muted' }, `En az çekim tutarı ${money(rules.minWithdrawCents, cur)}. Hesabını kapatırsan tutar ne olursa olsun bakiyenin tamamını çekebilirsin.`),
        w.withdrawals.items.length ? el('ul', { class: 'entrants', id: 'withdrawal-list' }, w.withdrawals.items.map((x) => el('li', {},
          el('span', {}, `${METHOD[x.method]} · ${x.destinationHint}`, el('span', { class: 'small muted' }, ` · ${fmtTime(x.createdAt)}${x.accountClosure ? ' · hesap kapatma' : ''}${x.note ? ` · ${x.note}` : ''}`)),
          el('span', {}, el('b', { class: 'mono' }, money(x.amountCents, x.currency)), el('span', { class: 'small muted' }, ` (net ${money(x.netCents, x.currency)}) `),
            el('span', { class: `pill ${W_STATUS[x.status][1]}` }, W_STATUS[x.status][0]),
            x.status === 'REQUESTED' ? el('button', { class: 'btn small', type: 'button', onclick: async () => {
              if (!confirm('Talep iptal edilsin mi? Tutar bakiyene geri döner.')) return;
              try { await api('POST', `/v1/me/withdrawals/${x.id}/cancel`); await load(); } catch (e) { toast(e.message); }
            } }, 'İptal') : null),
        ))) : null,
      );
      const closeCard = el('details', { class: 'card', id: 'close-account' }, el('summary', {}, 'Hesabı kapat'),
        el('p', { class: 'small' }, 'Hesabını kapatırsan, 20 $ altında olsa bile bakiyenin tamamı sana gönderilir ve hesabın kapanır. Devam eden turnuvan veya incelemedeki ödülün varsa önce onların bitmesi gerekir.'),
        openW ? el('p', { class: 'small muted' }, 'Bekleyen bir çekim talebin var; önce onun sonuçlanmasını bekle ya da iptal et.') : payoutForm({ closure: true, rules, total: usd.totalCents, cur }),
      );
      const awards = el('section', { class: 'card' }, el('h2', {}, 'Ödüller'),
        w.awards.length ? el('ul', { class: 'entrants' }, w.awards.map((a) => el('li', {},
          el('span', {}, el('a', { href: `#/turnuva/${a.tournamentId}` }, a.tournamentName), ` · ${a.rank}.`),
          el('span', {}, el('b', { class: 'mono' }, money(a.cents, a.currency)), ' ',
            el('span', { class: `pill ${a.status === 'RELEASED' ? 'live' : a.status === 'VOID' ? 'warn' : ''}` },
              a.status === 'RELEASED' ? 'çekilebilir' : a.status === 'VOID' ? 'iptal edildi' : `${fmtTime(a.holdUntil)}'e kadar bekletmede`)),
        ))) : el('p', { class: 'muted small' }, 'Henüz ödül yok.'),
      );
      const pays = el('section', { class: 'card' }, el('h2', {}, 'Ödemeler'),
        w.payments.length ? el('ul', { class: 'entrants', id: 'payment-list' }, w.payments.map((p) => el('li', {},
          el('span', {}, p.tournamentName ? el('a', { href: `#/turnuva/${p.tournamentId}` }, p.tournamentName) : p.purpose === 'deposit' ? 'Bakiye yükleme' : 'Ödeme', el('span', { class: 'small muted' }, ` · ${fmtTime(p.createdAt)}${p.cardLast4 ? ` · •••• ${p.cardLast4}` : ''}`)),
          el('span', {}, el('b', { class: 'mono' }, money(p.amountCents, p.currency)), ' ',
            el('span', { class: `pill ${p.status === 'SUCCEEDED' ? 'live' : p.status === 'REFUNDED' ? 'done' : p.status === 'FAILED' || p.status === 'DISPUTED' ? 'warn' : ''}` },
              p.refundStatus === 'PENDING' ? 'iade ediliyor' : PAY_STATUS[p.status] || p.status)),
        ))) : el('p', { class: 'muted small' }, 'Henüz ödeme yok.'),
      );
      const hist = el('section', { class: 'card' }, el('h2', {}, 'Hareketler'),
        w.history.length ? el('ul', { class: 'entrants' }, w.history.map((h) => el('li', {},
          el('span', {}, h.reason === 'PRIZE_RELEASE' && h.bucket === 'pending' ? 'Bekletmeden çıktı' : REASONS[h.reason] || h.reason, el('span', { class: 'small muted' }, ` · ${fmtTime(h.at)} · ${BUCKET[h.bucket] || h.bucket}`)),
          el('b', { class: `mono ${h.cents < 0 ? 'neg' : 'pos'}` }, `${h.cents > 0 ? '+' : ''}${money(h.cents, h.currency)}`),
        ))) : el('p', { class: 'muted small' }, 'Hareket yok.'),
      );
      root.replaceChildren(
        el('header', {}, el('p', { class: 'eyebrow' }, 'Hesap'), el('h1', {}, 'Cüzdan')),
        el('div', { class: 'grid2' }, el('div', { class: 'col' }, summary, withdraw, pays), el('div', { class: 'col' }, awards, hist, closeCard)),
      );
    }
    await load();
    let t = null;
    const off = ws.on((m) => {
      if (/^(payment|prize|wallet|withdrawal)\./.test(m.type)) { clearTimeout(t); t = setTimeout(() => void load().catch(() => undefined), 300); }
    });
    return () => { off(); clearTimeout(t); };
  }

  // ---- K46 bildirimler ve ayarlar ----------------------------------------------------------

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  let swReg = null;
  async function serviceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    if (!swReg) swReg = await navigator.serviceWorker.register('/sw.js');
    return swReg;
  }
  async function currentPushSubscription() {
    if (!pushSupported()) return null;
    const reg = await serviceWorker();
    return reg ? reg.pushManager.getSubscription() : null;
  }
  /** Telefon bildirimlerini açar: izin ister, aboneliği sunucuya kaydeder. */
  async function enablePush() {
    if (!pushSupported()) {
      throw new Error(isIos() && !isStandalone()
        ? 'iPhone/iPad\'de bildirim için önce Paylaş → "Ana Ekrana Ekle" ile uygulamayı ekle, sonra oradan açıp tekrar dene.'
        : 'Bu tarayıcı bildirimleri desteklemiyor.');
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Bildirim izni verilmedi. Tarayıcı ayarlarından izin verebilirsin.');
    const prefs = await api('GET', '/v1/me/notifications');
    const reg = await serviceWorker();
    const key = Uint8Array.from(atob(prefs.vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    await api('POST', '/v1/me/push-subscriptions', sub.toJSON());
    return true;
  }
  async function disablePush() {
    const sub = await currentPushSubscription();
    if (sub) {
      await api('POST', '/v1/me/push-subscriptions/remove', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe().catch(() => undefined);
    }
  }
  /** Turnuvaya katılınca, bildirim kapalıysa küçük bir öneri gösterir. */
  async function pushNudge() {
    try {
      if (!pushSupported() || Notification.permission !== 'default') return null;
      if (await currentPushSubscription()) return null;
    } catch { return null; }
    return el('div', { class: 'msg info small', id: 'push-nudge' },
      'Turnuvan başlarken telefonuna haber verelim mi? ',
      el('button', { class: 'btn small', type: 'button', onclick: async (ev) => {
        try { await enablePush(); toast('Bildirimler açıldı.'); ev.target.closest('#push-nudge')?.remove(); } catch (e) { toast(e.message); }
      } }, 'Bildirimleri aç'));
  }

  async function settingsView() {
    if (!session.user) { location.hash = '#/giris'; return null; }
    const prefs = await api('GET', '/v1/me/notifications');
    let sub = null;
    try { sub = await currentPushSubscription(); } catch { sub = null; }
    const news = el('input', { type: 'checkbox', id: 'pref-news', checked: prefs.newTournamentsEmail });
    news.addEventListener('change', async () => {
      try { await api('POST', '/v1/me/notifications', { newTournamentsEmail: news.checked }); toast(news.checked ? 'Yeni turnuva özetleri açıldı.' : 'Yeni turnuva özetlerinden çıktın.'); }
      catch (e) { toast(e.message); news.checked = !news.checked; }
    });
    const pushState = el('p', { class: 'small', id: 'push-state' });
    const pushBtn = el('button', { class: 'btn', type: 'button', id: 'push-toggle' });
    function paintPush() {
      const on = !!sub && Notification.permission === 'granted';
      pushState.textContent = !pushSupported()
        ? (isIos() && !isStandalone() ? 'iPhone/iPad\'de bildirim için: Safari\'de Paylaş → "Ana Ekrana Ekle", sonra uygulamayı ana ekrandan aç.' : 'Bu tarayıcı bildirimleri desteklemiyor.')
        : on ? 'Bu cihazda bildirimler açık.' : 'Bu cihazda bildirimler kapalı.';
      pushBtn.textContent = on ? 'Bu cihazda kapat' : 'Bu cihazda aç';
      pushBtn.hidden = !pushSupported();
    }
    pushBtn.addEventListener('click', async () => {
      try {
        if (sub) { await disablePush(); sub = null; toast('Bildirimler kapatıldı.'); }
        else { await enablePush(); sub = await currentPushSubscription(); toast('Bildirimler açıldı.'); }
      } catch (e) { toast(e.message); }
      paintPush();
    });
    paintPush();
    mount(el('div', { class: 'col narrow-wide', id: 'settings' },
      el('h1', {}, 'Ayarlar'),
      el('section', { class: 'card' }, el('h2', {}, 'Hesap'),
        el('p', {}, el('b', {}, session.user.displayName), el('span', { class: 'muted' }, ` · ${session.user.email}`))),
      el('section', { class: 'card' }, el('h2', {}, 'Dil'),
        el('p', { class: 'small muted' }, 'Arayüz ve e-postalar bu dilde gelir.'),
        el('select', { id: 'settings-lang', translate: 'no', onchange: (ev) => void changeLang(ev.target.value) },
          I18N.supported.map((l) => el('option', { value: l, selected: l === I18N.lang }, I18N.names[l])))),
      el('section', { class: 'card' }, el('h2', {}, 'Telefon bildirimleri'),
        el('p', { class: 'small muted' }, 'Kayıtlı olduğun turnuva dolup başlarken ve sıradaki maçın başlarken bildirim alırsın.'),
        pushState, pushBtn),
      el('section', { class: 'card' }, el('h2', {}, 'E-posta'),
        el('p', { class: 'small muted' }, 'Turnuva kaydı, başlama ve para çekme e-postaları her zaman gönderilir.'),
        el('label', { class: 'check' }, news, el('span', {}, 'Yeni turnuvalardan haberdar et (günde en fazla bir özet e-posta)'))),
      el('div', { class: 'row' }, el('a', { class: 'btn', href: '#/cuzdan' }, 'Cüzdan ve hesap kapatma')),
    ));
    return null;
  }

  // ---- K45 satranç asistanı ------------------------------------------------------------

  async function assistantView(gameId) {
    if (!session.user) { location.hash = '#/giris'; return null; }
    const LOCK = { LIVE_GAME: 'Devam eden bir oyunun var. Oyun sırasında asistan kapalıdır.', ACTIVE_TOURNAMENT: 'Süren bir turnuvadasın. Turnuva bitince asistanı kullanabilirsin.' };
    const chat = el('div', { class: 'chat', id: 'assistant-chat', 'aria-live': 'polite' });
    const info = el('p', { class: 'small muted', id: 'assistant-info' });
    const input = el('textarea', { id: 'assistant-input', rows: 2, maxlength: 2000, placeholder: gameId ? 'Bu oyun hakkında sor…' : 'Sorunu yaz…' });
    const sendBtn = el('button', { class: 'btn primary', type: 'submit' }, 'Gönder');
    const form = el('form', { class: 'stack', id: 'assistant-form' }, input, el('div', { class: 'spread' }, info, sendBtn));
    const quick = el('div', { class: 'quick' }, (gameId
      ? ['Bu oyunda nerede hata yaptım?', 'Bu oyundan ne öğrenmeliyim?', 'Açılışım nasıldı?']
      : ['Para nasıl çekerim?', 'Beraberlikte ne olur?', 'Rakibimi şikayet etmek istiyorum']
    ).map((q) => el('button', { class: 'btn small', type: 'button', onclick: () => { input.value = I18N.t(q); form.requestSubmit(); } }, q)));
    mount(el('section', { class: 'card narrow-wide', id: 'assistant' },
      el('div', { class: 'spread' }, el('h1', {}, 'Satranç Asistanı'), gameId ? el('a', { class: 'btn small', href: `#/oyun/${gameId}` }, 'Oyuna dön') : null),
      el('p', { class: 'small muted' }, gameId
        ? 'Koç modu: bitmiş oyununu birlikte değerlendirelim. Asistan yalnız bitmiş oyunlarda yardım eder.'
        : 'Kurallar, cüzdan, para çekme ve şikayetlerle ilgili sorularını yanıtlar. Oyunlarını değerlendirmek için oyun sayfasındaki "Asistana sor" düğmesini kullan.'),
      chat, quick, form,
    ));
    let st = null;
    // Mesaj içeriği çevrilmez (asistan zaten kullanıcının dilinde yazar).
    const bubble = (role, text) => el('div', { class: `bubble ${role}`, translate: 'no' }, text);
    async function load() {
      st = await api('GET', '/v1/assistant');
      const mine = st.messages.filter((m) => (gameId ? m.gameId === gameId : m.mode === 'support'));
      chat.replaceChildren(...(mine.length ? mine.map((m) => bubble(m.role, m.content)) : [bubble('assistant', I18N.t(gameId ? 'Merhaba! Bu oyununla ilgili ne sormak istersin?' : 'Merhaba! Ben Satranç Asistanı. Nasıl yardımcı olabilirim?'))]));
      chat.scrollTop = chat.scrollHeight;
      const blocked = !st.enabled ? 'Asistan şu anda kullanılamıyor.' : st.locked ? LOCK[st.locked] : st.remainingToday <= 0 ? 'Bugünkü soru hakkın doldu; yarın tekrar sorabilirsin.' : null;
      info.textContent = blocked || `Bugün kalan soru hakkın: ${st.remainingToday}/${st.limit}`;
      sendBtn.disabled = !!blocked;
      input.disabled = !!blocked;
    }
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      chat.append(bubble('user', text));
      const wait = bubble('assistant', '…');
      chat.append(wait);
      chat.scrollTop = chat.scrollHeight;
      sendBtn.disabled = true;
      try {
        const r = await api('POST', '/v1/assistant/messages', { text, ...(gameId ? { gameId } : {}), locale: I18N.lang });
        wait.textContent = r.reply;
        if (r.actions?.some((a) => a.type === 'complaint')) toast('Şikayetin inceleme ekibine iletildi.');
        info.textContent = `Bugün kalan soru hakkın: ${r.remainingToday}/${st.limit}`;
      } catch (e) {
        wait.remove();
        toast(e.message);
      } finally {
        sendBtn.disabled = false;
        chat.scrollTop = chat.scrollHeight;
      }
    });
    await load();
    return null;
  }

  // ---- yönetim paneli (M13) ---------------------------------------------------------

  function isStaff() {
    const r = session.user?.roles || [];
    return r.includes('admin') || r.includes('finance') || r.includes('fairplay');
  }
  const LEVEL_PILL = { critical: 'warn', high: 'warn', medium: '', low: 'done' };
  const LEVEL_TR = { critical: 'kritik', high: 'yüksek', medium: 'orta', low: 'düşük' };
  const ACTION_TR = {
    'fairplay.decide': 'Adil oyun kararı', 'user.ban': 'Kalıcı ban', 'user.unban': 'Ban kaldır', 'user.unfreeze': 'Dondurmayı kaldır',
    'payment.refund': 'Elle iade', 'flag.enable': 'Özelliği yeniden aç',
  };

  function table(headers, rows, id) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'tbl', id },
      el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.length ? rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c)))) : el('tr', {}, el('td', { colspan: headers.length, class: 'muted' }, 'Kayıt yok'))),
    ));
  }

  function askReason(label) {
    const r = prompt(`${label}\nGerekçe (denetim kaydına yazılır):`);
    if (r === null) return null;
    if (r.trim().length < 3) { toast('Gerekçe en az 3 karakter olmalı.'); return null; }
    return r.trim();
  }

  async function adminAct(fn, okText) {
    try {
      const r = await fn();
      toast(r?.needsApproval || r?.applied === false ? 'Talep oluşturuldu; başka bir yönetici onaylamalı (dört göz).' : okText || 'Tamam.');
      await route();
    } catch (e) { toast(e.message); }
  }

  async function adminView(tab, sub, params) {
    if (!session.user) { location.hash = '#/giris'; return null; }
    const tabs = [['genel', 'Genel'], ['vakalar', 'Vakalar'], ['onaylar', 'Onaylar'], ['cekimler', 'Çekimler'], ['finans', 'Finans'], ['turnuvalar', 'Turnuvalar'], ['kullanicilar', 'Kullanıcılar'], ['bayraklar', 'Bayraklar'], ['denetim', 'Denetim']];
    const body = el('div', { class: 'col', id: 'admin-body' }, el('p', { class: 'muted' }, 'Yükleniyor…'));
    mount(
      el('header', {}, el('p', { class: 'eyebrow' }, 'Yönetim'), el('h1', {}, 'Kontrol paneli')),
      el('nav', { class: 'tabs', id: 'admin-tabs' }, tabs.map(([k, label]) => el('a', { href: `#/yonetim/${k}`, class: k === tab ? 'on' : '' }, label))),
      body,
    );
    const me = session.user.id;
    try {
      if (tab === 'genel') {
        const o = await api('GET', '/v1/admin/overview');
        const stat = (label, value, cls) => el('div', { class: `stat ${cls || ''}` }, el('span', { class: 'small muted' }, label), el('b', { class: 'mono' }, value));
        const paid = o.flags.find((f) => f.key === 'paid_tournaments');
        body.replaceChildren(
          el('section', { class: 'card' }, el('h2', {}, 'Durum'),
            el('div', { class: 'stats' },
              stat('Bekleyen onay', o.pendingApprovals, o.pendingApprovals ? 'warn' : ''),
              stat('Açık vaka (yüksek+)', (o.openCases.high || 0) + (o.openCases.critical || 0), (o.openCases.high || o.openCases.critical) ? 'warn' : ''),
              stat('Açık vaka (orta)', o.openCases.medium || 0),
              stat('Analiz kuyruğu', `${o.analysisQueue.queued || 0} bekliyor · ${o.analysisQueue.failed || 0} hatalı`),
              stat('Ödemeler (24 sa)', `${o.payments24h.n} · ${money(o.payments24h.cents, 'USD')}`),
              stat('Bekleyen iade', `${o.refunds.pending}${o.refunds.stuck ? ` (${o.refunds.stuck} takılı)` : ''}`, o.refunds.stuck ? 'warn' : ''),
              stat('Kullanıcı', `${o.users.total} (+${o.users.new24} bugün, ${o.users.frozen} dondurulmuş)`),
              stat('Defter', o.ledger.balanced && !o.ledger.negativeUserBalances ? 'dengeli' : 'SORUN', o.ledger.balanced ? 'ok' : 'warn'),
            )),
          el('section', { class: 'card' }, el('h2', {}, 'Turnuvalar'),
            el('div', { class: 'row' }, Object.entries(o.tournaments).map(([k, v]) => el('span', { class: `pill ${(STATUS[k] || [])[1] || ''}` }, `${(STATUS[k] || [k])[0]}: ${v}`)))),
          el('section', { class: 'card' }, el('h2', {}, 'Acil durdurma'),
            el('p', {}, 'Ücretli kayıt: ', el('b', { id: 'paid-flag' }, paid?.enabled ? 'AÇIK' : 'KAPALI')),
            el('p', { class: 'small muted' }, 'Durdurmak tek kişiyle ve hemen olur. Yeniden açmak için ikinci bir yöneticinin onayı gerekir.'),
            el('button', { class: `btn ${paid?.enabled ? 'danger' : ''}`, type: 'button', id: 'kill-switch', onclick: () => {
              const reason = askReason(paid?.enabled ? 'Ücretli kayıtlar DURDURULACAK.' : 'Ücretli kayıtların yeniden açılması önerilecek.');
              if (reason) void adminAct(() => api('POST', '/v1/admin/flags/paid_tournaments', { enabled: !paid?.enabled, reason }), 'Ücretli kayıtlar durduruldu.');
            } }, paid?.enabled ? 'Ücretli kayıtları durdur' : 'Yeniden açmayı öner')),
          o.lastReconciliation ? el('p', { class: 'small muted' }, `Son mutabakat: ${fmtTime(o.lastReconciliation.created_at)} · fark ${money(o.lastReconciliation.diff_cents, o.lastReconciliation.currency)}`) : null,
        );
      } else if (tab === 'vakalar' && sub) {
        const d = await api('GET', `/v1/admin/cases/${sub}`);
        const c = d.case;
        const open = c.status === 'OPEN';
        const proposed = c.proposed_decision;
        body.replaceChildren(
          el('section', { class: 'card', id: 'case-detail' },
            el('div', { class: 'spread' }, el('h2', {}, `Vaka · ${c.display_name}`), el('span', { class: `pill ${LEVEL_PILL[c.level]}` }, `${LEVEL_TR[c.level]} · ${Number(c.max_score).toFixed(2)}`)),
            el('p', { class: 'small' }, `Durum: ${c.status} · Hesap: ${c.user_status} · Turnuva: ${c.tournament_name || '—'} (${c.tournament_status || '—'}) · Açıldı: ${fmtTime(c.opened_at)}`),
            el('h3', { class: 'h3' }, 'Sebepler'),
            el('ul', { class: 'reasons' }, (c.reasons || []).map((r) => el('li', {}, r.reason))),
            el('h3', { class: 'h3' }, 'Oyun analizleri'),
            table(['Oyun', 'Derinlik', 'Analiz edilen', 'ACPL', 'Top-1', 'Karmaşık top-1', 'Ritim (CV)'], d.analyses.map((a) => {
              const p = a.summary.players.white.userId === c.user_id ? a.summary.players.white : a.summary.players.black;
              return [el('a', { href: `#/oyun/${a.game_id}` }, a.game_id.slice(0, 8)), `d${a.depth}`, p.analysedMoves, p.acpl ?? '—', p.top1 ?? '—', p.complexTop1 ?? '—', p.thinkCv ?? '—'];
            })),
            el('h3', { class: 'h3' }, 'Risk skorları'),
            table(['Oyun', 'Skor', 'Motor benzerliği', 'Zaman', 'Odak', 'Bağlantı', 'Davranış'], d.riskScores.map((r) => [r.game_id.slice(0, 8), Number(r.score).toFixed(2), r.components.engine, r.components.time, r.components.focus, r.components.link, r.components.behav])),
            el('p', { class: 'small muted' }, 'Skor tek başına delil değildir; karar çoklu oyun ve göstergeye, insan incelemesine dayanır (doküman 14.4).'),
            open && !proposed ? el('div', { class: 'row' },
              el('button', { class: 'btn', type: 'button', id: 'propose-clear', onclick: () => { const r = askReason('Vaka TEMİZ kapatılacak; ödül serbest kalacak.'); if (r) void adminAct(() => api('POST', `/v1/admin/cases/${sub}/propose`, { decision: 'clear', reason: r })); } }, 'Temize çıkar (öner)'),
              el('button', { class: 'btn danger', type: 'button', id: 'propose-confirm', onclick: () => { const r = askReason('İHLAL onaylanacak; bekleyen ödül iptal edilip rezerve aktarılacak.'); if (r) void adminAct(() => api('POST', `/v1/admin/cases/${sub}/propose`, { decision: 'confirm', ban: confirm('Hesap kalıcı olarak da kapatılsın mı?'), reason: r })); } }, 'İhlali onayla (öner)'),
            ) : open ? el('p', { class: 'msg info' }, `Öneri bekliyor: ${proposed === 'clear' ? 'temize çıkar' : 'ihlal'} — "${c.proposed_note}". Onaylar sekmesinden ikinci kişi onaylar.`) : el('p', { class: 'msg ok' }, `Karar: ${c.status} — ${c.decision_note || ''}`),
          ),
          d.previousCases.length ? el('section', { class: 'card' }, el('h2', {}, 'Önceki vakalar'), table(['Durum', 'Seviye', 'Skor', 'Açıldı'], d.previousCases.map((p) => [p.status, LEVEL_TR[p.level], Number(p.max_score).toFixed(2), fmtTime(p.opened_at)]))) : null,
        );
      } else if (tab === 'vakalar') {
        const st = params.get('durum') || 'OPEN';
        const d = await api('GET', `/v1/admin/cases?status=${st}`);
        body.replaceChildren(el('section', { class: 'card' },
          el('div', { class: 'spread' }, el('h2', {}, 'Adil oyun vakaları'),
            el('div', { class: 'row' }, ['OPEN', 'CLEARED', 'CONFIRMED', 'ALL'].map((x) => el('a', { class: `btn ${x === st ? 'primary' : ''}`, href: `#/yonetim/vakalar?durum=${x}` }, { OPEN: 'Açık', CLEARED: 'Temiz', CONFIRMED: 'İhlal', ALL: 'Tümü' }[x])))),
          table(['Oyuncu', 'Seviye', 'Skor', 'Turnuva', 'Hesap', 'Açıldı', ''], d.cases.map((c) => [
            c.display_name, el('span', { class: `pill ${LEVEL_PILL[c.level]}` }, LEVEL_TR[c.level]), Number(c.max_score).toFixed(2), c.tournament_name || '—', c.user_status, fmtTime(c.opened_at),
            el('a', { class: 'btn', href: `#/yonetim/vakalar/${c.id}` }, c.proposed_decision ? 'İncele (öneri var)' : 'İncele'),
          ]), 'cases-table'),
        ));
      } else if (tab === 'onaylar') {
        const d = await api('GET', `/v1/admin/approvals?status=${params.get('durum') || 'PENDING'}`);
        body.replaceChildren(el('section', { class: 'card' },
          el('h2', {}, 'Dört göz onayları'),
          el('p', { class: 'small muted' }, 'Para ve hesap üzerinde kalıcı etkisi olan işlemler, öneren dışında bir yöneticinin onayıyla yürütülür.'),
          table(['İşlem', 'Hedef', 'Gerekçe', 'Öneren', 'Zaman', 'Durum', ''], d.approvals.map((a) => [
            ACTION_TR[a.action] || a.action, `${a.target_type} ${String(a.target_id).slice(0, 8)}${a.payload?.decision ? ` · ${a.payload.decision === 'clear' ? 'temiz' : 'ihlal'}${a.payload.ban ? ' + ban' : ''}` : ''}`,
            a.reason, a.requested_by_name, fmtTime(a.requested_at), a.status,
            a.status !== 'PENDING' ? (a.result?.error ? el('span', { class: 'err' }, a.result.error) : '') : a.requested_by === me
              ? el('div', { class: 'row' }, el('span', { class: 'small muted' }, 'Başka bir yönetici onaylamalı'), el('button', { class: 'btn', type: 'button', onclick: () => void adminAct(() => api('POST', `/v1/admin/approvals/${a.id}/reject`, { note: 'geri çekildi' }), 'Talep geri çekildi.') }, 'Geri çek'))
              : el('div', { class: 'row' },
                el('button', { class: 'btn accent', type: 'button', dataset: { approve: a.id }, onclick: () => void adminAct(() => api('POST', `/v1/admin/approvals/${a.id}/approve`, { note: '' }), 'Onaylandı ve yürütüldü.') }, 'Onayla'),
                el('button', { class: 'btn', type: 'button', onclick: () => void adminAct(() => api('POST', `/v1/admin/approvals/${a.id}/reject`, { note: prompt('Red notu') || '' }), 'Reddedildi.') }, 'Reddet')),
          ]), 'approvals-table'),
          el('a', { href: '#/yonetim/onaylar?durum=ALL', class: 'small' }, 'Geçmiş talepler'),
        ));
      } else if (tab === 'cekimler') {
        const st = params.get('durum') || 'REQUESTED';
        const d = await api('GET', `/v1/admin/withdrawals${st === 'ALL' ? '' : `?status=${st}`}`);
        const METHOD = { ewallet: 'E-cüzdan', bank: 'Banka' };
        body.replaceChildren(el('section', { class: 'card' },
          el('div', { class: 'spread' }, el('h2', {}, 'Para çekme talepleri'),
            el('div', { class: 'row' }, ['REQUESTED', 'PAID', 'REJECTED', 'ALL'].map((x) => el('a', { class: `btn ${x === st ? 'primary' : ''}`, href: `#/yonetim/cekimler?durum=${x}` }, { REQUESTED: 'Bekleyen', PAID: 'Ödenen', REJECTED: 'Reddedilen', ALL: 'Tümü' }[x])))),
          el('p', { class: 'small muted' }, 'Parayı platform hesabından gönderdikten sonra "Ödendi" ile dekont/işlem numarasını gir. Hesap sahibinin adı kullanıcıyla uyuşmuyorsa reddet; tutar bakiyesine geri döner.'),
          table(['Oyuncu', 'Tutar', 'Komisyon', 'Net', 'Yöntem', 'Hesap', 'Ad', 'Tarih', 'Durum', ''], d.withdrawals.map((w) => [
            `${w.user.displayName}${w.accountClosure ? ' (kapatma)' : ''}`, money(w.amountCents, w.currency), money(w.feeCents, w.currency), money(w.netCents, w.currency),
            METHOD[w.method], el('span', { class: 'mono small' }, w.destination), w.holderName, fmtTime(w.createdAt), w.status + (w.payoutRef ? ` · ${w.payoutRef}` : ''),
            w.status === 'REQUESTED' ? el('div', { class: 'row' },
              el('button', { class: 'btn small primary', type: 'button', onclick: () => {
                const ref = prompt(`${money(w.netCents, w.currency)} gönderildi mi?\nDekont / işlem numarası:`);
                if (ref && ref.trim().length >= 3) void adminAct(() => api('POST', `/v1/admin/withdrawals/${w.id}/paid`, { payoutRef: ref.trim() }), 'Ödendi olarak işaretlendi.');
              } }, 'Ödendi'),
              el('button', { class: 'btn small danger', type: 'button', onclick: () => {
                const r = askReason('Talep reddedilecek; tutar oyuncunun bakiyesine döner.');
                if (r) void adminAct(() => api('POST', `/v1/admin/withdrawals/${w.id}/reject`, { reason: r }), 'Reddedildi.');
              } }, 'Reddet'),
            ) : '',
          ]), 'withdrawals-table'),
        ));
      } else if (tab === 'finans') {
        const d = await api('GET', '/v1/admin/finance');
        body.replaceChildren(
          el('section', { class: 'card' }, el('div', { class: 'spread' }, el('h2', {}, 'Defter'),
            el('button', { class: 'btn', type: 'button', id: 'reconcile', onclick: () => void adminAct(async () => { const r = await api('POST', '/v1/admin/finance/reconcile', { currency: 'USD' }); toast(`Mutabakat: fark ${money(r.diffCents ?? 0, 'USD')}${r.ok ? ' (tamam)' : ' — İNCELE'}`); return {}; }, ' ') }, 'Mutabakat çalıştır')),
            el('p', { class: `msg ${d.invariants.balanced ? 'ok' : 'err'}` }, d.invariants.balanced ? 'Defter dengeli: her para biriminde borç = alacak.' : 'DEFTER DENGESİZ'),
            table(['Hesap', 'Tür', 'Para', 'Bakiye'], d.accounts.map((a) => [a.code, a.type, a.currency, money(a.balance_cents, a.currency)]), 'accounts-table')),
          el('section', { class: 'card' }, el('h2', {}, 'Son ödemeler'),
            table(['Oyuncu', 'Turnuva', 'Tutar', 'Ücret', 'Durum', 'İade', 'Zaman', ''], d.payments.map((p) => [
              p.display_name, p.tournament_name || '—', money(p.amount_cents, p.currency), money(p.fee_cents, p.currency), p.status,
              p.refund_status ? `${p.refund_status}${p.refund_error ? ` (${p.refund_attempts} deneme: ${p.refund_error})` : ''}` : '—', fmtTime(p.created_at),
              p.status === 'SUCCEEDED' && !p.refund_status ? el('button', { class: 'btn', type: 'button', onclick: () => { const r = askReason('Elle iade önerilecek.'); if (r) void adminAct(() => api('POST', `/v1/admin/payments/${p.id}/refund`, { reason: r })); } }, 'İade öner') : '',
            ]))),
          el('section', { class: 'card' }, el('h2', {}, 'Mutabakat raporları'),
            table(['Zaman', 'Para', 'Defter', 'Sağlayıcı', 'Fark', 'Dengesiz işlem'], d.reconciliation.map((r) => [fmtTime(r.created_at), r.currency, money(r.ledger_cents, r.currency), money(r.provider_cents, r.currency), money(r.diff_cents, r.currency), r.unbalanced_tx]))),
        );
      } else if (tab === 'turnuvalar') {
        const d = await api('GET', '/v1/admin/tournaments');
        body.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Turnuvalar'),
          table(['Ad', 'Durum', 'Oyuncu', 'Ücret', 'Havuz', 'Ödüller', 'Vaka', ''], d.tournaments.map((t) => [
            el('a', { href: `#/turnuva/${t.id}` }, t.name), el('span', { class: `pill ${(STATUS[t.status] || [])[1] || ''}` }, (STATUS[t.status] || [t.status])[0]), `${t.players}/${t.capacity}`,
            t.entry_fee_cents > 0 ? money(t.entry_fee_cents, t.currency) : 'ücretsiz', t.prize_pool_cents ? money(t.prize_pool_cents, t.currency) : '—',
            (t.awards || []).map((a) => `${a.rank}. ${money(a.cents, t.currency)} ${a.status === 'RELEASED' ? '✓' : a.status === 'VOID' ? '✗' : '…'}`).join(' · ') || '—',
            t.open_cases ? el('span', { class: 'pill warn' }, String(t.open_cases)) : '',
            ['OPEN', 'STARTING'].includes(t.status) ? el('button', { class: 'btn danger', type: 'button', onclick: () => { const r = askReason(`"${t.name}" iptal edilecek; ödenen tüm ücretler iade edilecek.`); if (r) void adminAct(() => api('POST', `/v1/admin/tournaments/${t.id}/cancel`, { reason: r }), 'Turnuva iptal edildi; iadeler başlatıldı.'); } }, 'İptal et') : '',
          ]), 'admin-tournaments')));
      } else if (tab === 'kullanicilar') {
        if (sub) {
          const d = await api('GET', `/v1/admin/users/${sub}`);
          const u = d.user;
          const propose = (action, label) => () => { const r = askReason(label); if (r) void adminAct(() => api('POST', `/v1/admin/users/${sub}/propose`, { action, reason: r })); };
          body.replaceChildren(el('section', { class: 'card' },
            el('div', { class: 'spread' }, el('h2', {}, u.display_name), el('span', { class: `pill ${u.status === 'active' ? 'live' : 'warn'}` }, u.status)),
            el('p', { class: 'small' }, `${u.email} · ${u.country_code} · roller: ${u.roles.join(', ')} · kayıt ${fmtTime(u.created_at)}`),
            el('div', { class: 'row' },
              u.status === 'active' ? el('button', { class: 'btn', type: 'button', onclick: () => { const r = askReason('Hesap GEÇİCİ dondurulacak (hemen).'); if (r) void adminAct(() => api('POST', `/v1/admin/users/${sub}/freeze`, { reason: r }), 'Hesap donduruldu.'); } }, 'Geçici dondur') : null,
              u.status === 'frozen' ? el('button', { class: 'btn', type: 'button', onclick: propose('unfreeze', 'Dondurma kaldırılacak.') }, 'Dondurmayı kaldır (öner)') : null,
              u.status !== 'banned' ? el('button', { class: 'btn danger', type: 'button', onclick: propose('ban', 'Hesap KALICI kapatılacak.') }, 'Kalıcı ban (öner)') : el('button', { class: 'btn', type: 'button', onclick: propose('unban', 'Ban kaldırılacak.') }, 'Banı kaldır (öner)'),
            ),
            el('h3', { class: 'h3' }, 'Bakiye'), table(['Para', 'Çekilebilir', 'Bekletmede'], d.balances.map((b) => [b.currency, money(b.availableCents, b.currency), money(b.pendingCents, b.currency)])),
            el('h3', { class: 'h3' }, 'Cihazlar'), table(['Cihaz', 'Son IP', 'Son görülme', 'Paylaşan hesap'], d.devices.map((x) => [x.device_key.slice(0, 10), x.last_ip, fmtTime(x.last_seen), x.shared_with ? el('span', { class: 'pill warn' }, String(x.shared_with)) : '0'])),
            el('h3', { class: 'h3' }, 'Vakalar'), table(['Durum', 'Seviye', 'Skor', 'Açıldı', ''], d.cases.map((c) => [c.status, LEVEL_TR[c.level], Number(c.max_score).toFixed(2), fmtTime(c.opened_at), el('a', { href: `#/yonetim/vakalar/${c.id}` }, 'aç')])),
            el('h3', { class: 'h3' }, 'Ödemeler'), table(['Turnuva', 'Tutar', 'Durum', 'Zaman'], d.payments.map((p) => [p.tournamentName || '—', money(p.amountCents, p.currency), p.status, fmtTime(p.createdAt)])),
            el('h3', { class: 'h3' }, 'Denetim'), table(['Zaman', 'İşlem', 'Veri'], d.audit.map((a) => [fmtTime(a.created_at), a.action, JSON.stringify(a.data).slice(0, 120)])),
          ));
        } else {
          const qv = params.get('q') || '';
          const d = await api('GET', `/v1/admin/users?q=${encodeURIComponent(qv)}`);
          const input = el('input', { id: 'user-q', value: qv, placeholder: 'E-posta, ad ya da kimlik' });
          body.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Kullanıcılar'),
            el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); location.hash = `#/yonetim/kullanicilar?q=${encodeURIComponent(input.value)}`; } }, input, el('button', { class: 'btn', type: 'submit' }, 'Ara')),
            table(['Ad', 'E-posta', 'Durum', 'Roller', 'Kayıt', ''], d.users.map((u) => [u.display_name, u.email, u.status, u.roles.join(', '), fmtTime(u.created_at), el('a', { class: 'btn', href: `#/yonetim/kullanicilar/${u.id}` }, 'Aç')]))));
        }
      } else if (tab === 'bayraklar') {
        const d = await api('GET', '/v1/admin/flags');
        body.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Özellik bayrakları'),
          table(['Anahtar', 'Durum', 'Açıklama', 'Güncellendi', ''], d.flags.map((f) => [
            f.key, el('span', { class: `pill ${f.enabled ? 'live' : 'warn'}` }, f.enabled ? 'açık' : 'kapalı'), f.note || '', fmtTime(f.updatedAt),
            el('button', { class: `btn ${f.enabled ? 'danger' : ''}`, type: 'button', onclick: () => { const r = askReason(f.enabled ? `${f.key} KAPATILACAK (hemen).` : `${f.key} yeniden açılması önerilecek.`); if (r) void adminAct(() => api('POST', `/v1/admin/flags/${f.key}`, { enabled: !f.enabled, reason: r }), 'Bayrak kapatıldı.'); } }, f.enabled ? 'Kapat' : 'Açmayı öner'),
          ]))));
      } else if (tab === 'denetim') {
        const d = await api('GET', '/v1/admin/audit?limit=200');
        body.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Denetim kaydı'),
          table(['Zaman', 'Kim', 'İşlem', 'Hedef', 'Veri'], d.entries.map((a) => [fmtTime(a.created_at), a.actor || 'sistem', a.action, `${a.target_type || ''} ${String(a.target_id || '').slice(0, 8)}`, JSON.stringify(a.data).slice(0, 160)]), 'audit-table')));
      }
    } catch (e) {
      body.replaceChildren(el('p', { class: 'msg err' }, e.status === 403 ? 'Bu bölüm için yetkiniz yok.' : e.message));
    }
    return null;
  }

  // ---- başlangıç ------------------------------------------------------------------

  window.addEventListener('hashchange', () => void route());
  renderNav();
  ws.connect();
  Promise.all([cfgReady, hint.get() ? refresh() : Promise.resolve(false)]).finally(() => void route());
})();
