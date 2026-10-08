// Satranç Turnuvaları — web istemcisi (M14 MVP). Çerçevesiz, bağımlılıksız.
// Kurallar istemcide yalnızca gösterim ve anında geri bildirim içindir; karar sunucudadır.
(() => {
  'use strict';
  const C = window.ChessCore;

  // ---- küçük yardımcılar ------------------------------------------------------

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
    try { return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: cur || 'USD' }).format((cents || 0) / 100); }
    catch { return `${((cents || 0) / 100).toFixed(2)} ${cur}`; }
  }
  const fmtTime = (iso) => new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const rankLabel = (rank, count) => (count > 1 ? `${rank}.–${rank + count - 1}.` : `${rank}.`);
  const ORPHAN_REASON = {
    seat_unavailable: 'Koltuğun artık yoktu (rezervasyon süresi dolmuş olabilir)',
    tournament_not_open: 'Turnuva kayıtları kapanmıştı',
    amount_mismatch: 'Ödenen tutar beklenenle uyuşmadı',
  };
  const PAY_FAIL = { card_declined: 'Kart reddedildi', insufficient_funds: 'Yetersiz bakiye', authentication_failed: '3D Secure doğrulanamadı' };

  /** Ücretli turnuvaya katıl: koltuk 10 dk ayrılır ve ödeme sağlayıcısının sayfasına gidilir. */
  async function joinTournament(t) {
    if (t.entryFeeCents > 0 && !confirm(`${t.name}\nGiriş ücreti ${money(t.entryFeeCents, t.currency)}. Koltuğun 10 dakika ayrılacak ve ödeme sayfasına yönlendirileceksin. Devam edilsin mi?`)) return;
    try {
      const r = await api('POST', `/v1/tournaments/${t.id}/join`, {});
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
    session.token = r.accessToken;
    session.user = r.user;
    clearTimeout(session.refreshTimer);
    session.refreshTimer = setTimeout(() => void refresh(), Math.max(30, r.expiresIn - 60) * 1000);
    ws.authenticate();
    renderNav();
  }

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
      const label = m.armageddon ? 'Armageddon oyunu' : `${m.round}, ${m.gameNo}. oyun`;
      toast(`${label} ${when > 1500 ? `${Math.round(when / 1000)} sn sonra başlıyor` : 'başlıyor'}. Rengin: ${m.color === 'w' ? 'beyaz' : 'siyah'}.`, { href: `#/oyun/${m.gameId}`, text: 'Oyuna git' });
    } else if (m.type === 'game.started') {
      if (m.matchId && !matchTournament.has(m.matchId)) matchTournament.set(m.matchId, null);
      if (!location.hash.startsWith(`#/oyun/${m.gameId}`)) location.hash = `#/oyun/${m.gameId}`;
    } else if (m.type === 'payment.confirmed') {
      toast('Ödemen alındı, koltuğun onaylandı.', { href: `#/turnuva/${m.tournamentId}`, text: 'Turnuvaya git' });
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
      nav.replaceChildren(
        el('a', { href: '#/' }, 'Lobi'),
        el('a', { href: '#/cuzdan', id: 'nav-wallet' }, 'Cüzdan'),
        el('span', { class: 'who' }, session.user.displayName),
        el('button', { class: 'btn', type: 'button', onclick: logout }, 'Çıkış'),
      );
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
      return (cleanup = await lobbyView());
    } catch (e) {
      mount(el('p', { class: 'msg err' }, e.message || String(e)));
    }
  }

  // ---- giriş ve kayıt ----------------------------------------------------------

  function fieldError(form, e) {
    const box = form.querySelector('.form-error');
    box.textContent = e.message + (e.details?.fields ? `: ${Object.entries(e.details.fields).map(([k, v]) => `${k} ${v}`).join(', ')}` : '');
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

  const COUNTRIES = [['TR', 'Türkiye'], ['AZ', 'Azerbaycan'], ['GB', 'Birleşik Krallık'], ['DE', 'Almanya'], ['NL', 'Hollanda'], ['FR', 'Fransa'], ['US', 'ABD'], ['ES', 'İspanya'], ['IT', 'İtalya'], ['GE', 'Gürcistan'], ['KZ', 'Kazakistan'], ['UA', 'Ukrayna']];

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
    mount(
      el('header', {},
        el('p', { class: 'eyebrow' }, 'Eleme usulü · 2 oyunluk mini maçlar'),
        el('h1', {}, 'Turnuvalar'),
        el('p', { class: 'lede' }, 'Kontenjan dolunca turnuva başlar. Her eşleşme renk değişimli iki oyundur; eşitlikte Armageddon oynanır.'),
      ),
      root,
    );

    const listCard = el('section', { class: 'card', id: 'tournament-list' }, el('h2', {}, 'Açık ve süren turnuvalar'), el('p', { class: 'muted small' }, 'Yükleniyor…'));
    left.append(listCard);

    let active = null;
    async function loadList() {
      const data = await api('GET', '/v1/tournaments');
      active = data.active;
      const rows = data.tournaments.map((t) => {
        const [label, cls] = STATUS[t.status] || [t.status, ''];
        const seats = el('span', { class: 'seats', 'aria-label': `${t.joined}/${t.capacity} dolu` }, Array.from({ length: Math.min(t.capacity, 16) }, (_, i) => el('i', { class: i < Math.round((t.joined / t.capacity) * Math.min(t.capacity, 16)) ? 'on' : '' })));
        const mine = active === t.id;
        const action = t.status === 'OPEN' && session.user && !active
          ? el('button', { class: 'btn accent', type: 'button', dataset: { join: t.id }, onclick: () => joinTournament(t) }, t.entryFeeCents ? `Katıl · ${money(t.entryFeeCents, t.currency)}` : 'Katıl')
          : el('a', { class: 'btn', href: `#/turnuva/${t.id}` }, mine ? 'Turnuvam' : 'Görüntüle');
        return el('div', { class: 'trow' },
          el('div', { class: 'col tiny' },
            el('div', { class: 'row' }, el('span', { class: 'name' }, t.name), el('span', { class: `pill ${cls}` }, label), mine ? el('span', { class: 'pill' }, 'Kayıtlısın') : null),
            el('div', { class: 'meta' },
              el('span', {}, `${t.capacity} kişi`), el('span', { class: 'mono' }, t.timeControlLabel),
              el('span', { class: t.entryFeeCents ? 'fee' : '' }, t.entryFeeCents ? money(t.entryFeeCents, t.currency) : 'Ücretsiz'),
              el('span', {}, seats, ` ${t.joined}/${t.capacity}`),
            ),
          ),
          action,
        );
      });
      listCard.replaceChildren(el('h2', {}, 'Açık ve süren turnuvalar'), rows.length ? el('div', { class: 'tlist' }, rows) : el('p', { class: 'muted' }, 'Şu an turnuva yok.'));
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
      const r = await api('GET', '/v1/me/ratings');
      right.append(el('section', { class: 'card' },
        el('h2', {}, 'Rating'),
        r.ratings.length
          ? el('div', { class: 'ratings' }, r.ratings.map((x) => el('div', { class: 'r' }, el('b', {}, `${x.rating}${x.provisional ? '?' : ''}`), el('span', {}, `${POOL_NAME[x.pool] || x.pool} · ${x.games} oyun`))))
          : el('p', { class: 'muted small' }, 'Henüz rating yok. İlk oyunlarından sonra burada görünür.'),
      ));
      right.append(botPanel());
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

  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
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
    mount(el('div', { class: 'game' },
      el('div', { class: 'board-wrap' }, top, boardEl, bottom),
      el('div', { class: 'col tight' }, status, el('section', { class: 'card' }, el('h2', {}, 'Hamleler'), movesEl), el('section', { class: 'card' }, actions)),
    ));

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
        return el('button', { type: 'button', class: cls.join(' '), dataset: { square: sq }, 'aria-label': p ? `${sq} ${p.color === 'w' ? 'beyaz' : 'siyah'} ${p.type}` : sq, onclick: () => onSquare(sq) },
          p ? el('span', { class: `piece ${p.color}` }, GLYPH[p.type] + '︎') : null,
          targets.has(sq) ? el('span', { class: p || targets.get(sq).flag === 'e' ? 'target capture' : 'target' }) : null,
          idx % 8 === 0 ? el('span', { class: 'coord rank' }, sq[1]) : null,
          idx >= 56 ? el('span', { class: 'coord file' }, sq[0]) : null,
        );
      }));
      if (s.promo) {
        boardEl.append(el('div', { class: 'promo' }, el('div', { class: 'promo-card' },
          el('div', {}, 'Terfi'),
          el('div', { class: 'promo-row' }, ['q', 'r', 'b', 'n'].map((t) => el('button', { type: 'button', id: `promo-${t}`, onclick: () => { const { from, to } = s.promo; s.promo = null; send(from, to, t); } }, el('span', { class: `piece ${s.myColor}` }, GLYPH[t] + '︎')))),
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
      const kind = st.kind === 'tournament' ? (st.armageddon ? 'Turnuva · Armageddon' : `Turnuva · ${st.gameNo}. oyun`) : st.kind === 'bot' ? 'Bot oyunu' : 'Serbest oyun';
      const tid = st.matchId ? matchTournament.get(st.matchId) : null;
      const lines = [el('div', { class: 'spread' }, el('span', { class: 'small muted' }, `${kind} · ${C.parseTimeControl(st.timeControl).label}`), tid ? el('a', { href: `#/turnuva/${tid}`, class: 'small' }, 'Turnuva tablosu') : el('a', { href: '#/', class: 'small' }, 'Lobi'))];
      if (s.ended) {
        const who = s.ended.winner ? `${s.ended.winner === 'w' ? 'Beyaz' : 'Siyah'} kazandı` : 'Berabere';
        lines.push(el('div', { class: 'result', id: 'game-result' }, `${s.ended.result.replace('1/2-1/2', '½–½')} · ${who}`), el('div', { class: 'muted' }, REASON[s.ended.reason] || s.ended.reason || ''));
        if (s.state.armageddon && !s.ended.winner) lines.push(el('div', { class: 'small' }, 'Armageddon: beraberlikte siyah tur atlar.'));
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
            if (paid && !confirm(`Turnuvadan ayrılırsan ${money(d.entryFeeCents, d.currency)} ücretin kartına iade edilir. Ayrılmak istiyor musun?`)) return;
            try {
              const r = await api('POST', `/v1/tournaments/${id}/leave`, {});
              if (r.refund) toast('Ayrıldın. Ücretin iade ediliyor (birkaç gün içinde kartına yansır).', { href: '#/cuzdan', text: 'Cüzdan' });
            } catch (e) { toast(e.message); }
          } }, 'Ayrıl'));
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
        el('p', { class: 'small muted' }, `Her eşleşme renk değişimli 2 oyun; 1–1'de Armageddon (beyaz 5 dk, siyah 4 dk, beraberlikte siyah). Oyunlar arası mola ${d.breakSeconds} sn.`),
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
              ? `Toplam giriş ${money(d.settlement.grossCents, d.currency)} · komisyon ${money(d.settlement.rakeCents, d.currency)} · ödül havuzu ${money(d.settlement.prizePoolCents, d.currency)}. Ödüller güvenlik incelemesi için bekletilir, sonra çekilebilir bakiyene geçer.`
              : `Kontenjan dolarsa: ${d.capacity} × ${money(d.entryFeeCents, d.currency)}, komisyon %${(d.rakeBps / 100).toLocaleString('tr-TR')} (ödeme ücretleri dahil). Kuruş artığı şampiyona eklenir.`),
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
      if (m.decidedBy === 'armageddon') foot.push('Armageddon ile');
      for (const g of m.games) {
        foot.push(el('a', { href: `#/oyun/${g.id}` }, g.armageddon ? 'A' : `${g.gameNo}.`, g.status === 'active' ? ' canlı' : g.result ? ` ${g.result.replace('1/2-1/2', '½')}` : ' bekliyor'));
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
    const REASONS = { ENTRY_PAID: 'Giriş', TOURNAMENT_SETTLE: 'Ödül (bekletmede)', PRIZE_RELEASE: 'Ödül serbest', PRIZE_VOID: 'Ödül iptali', PAYOUT: 'Çekim', PAYOUT_REVERSAL: 'Çekim iadesi', ADJUSTMENT: 'Düzeltme' };
    async function load() {
      const w = await api('GET', '/v1/me/wallet');
      const bals = w.balances.length ? w.balances : [{ currency: 'USD', availableCents: 0, pendingCents: 0 }];
      const summary = el('section', { class: 'card', id: 'wallet-balance' }, el('h2', {}, 'Bakiye'),
        el('div', { class: 'wallet-grid' }, bals.map((b) => [
          el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Çekilebilir'), el('b', { class: 'mono', dataset: { available: b.currency } }, money(b.availableCents, b.currency))),
          el('div', { class: 'stat' }, el('span', { class: 'small muted' }, 'Bekletmede'), el('b', { class: 'mono', dataset: { pending: b.currency } }, money(b.pendingCents, b.currency))),
        ])),
        el('p', { class: 'small muted' }, 'Ödüller, hile incelemesi için tutara göre 12–48 saat bekletilir; sonra çekilebilir bakiyeye geçer.'),
        el('button', { class: 'btn', type: 'button', disabled: true, title: 'Kimlik doğrulama (KYC) gerekli' }, 'Para çek'),
        el('p', { class: 'small muted' }, 'Para çekme, kimlik doğrulaması (KYC) tamamlandığında açılır.'),
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
          el('span', {}, p.tournamentName ? el('a', { href: `#/turnuva/${p.tournamentId}` }, p.tournamentName) : 'Ödeme', el('span', { class: 'small muted' }, ` · ${fmtTime(p.createdAt)}${p.cardLast4 ? ` · •••• ${p.cardLast4}` : ''}`)),
          el('span', {}, el('b', { class: 'mono' }, money(p.amountCents, p.currency)), ' ',
            el('span', { class: `pill ${p.status === 'SUCCEEDED' ? 'live' : p.status === 'REFUNDED' ? 'done' : p.status === 'FAILED' || p.status === 'DISPUTED' ? 'warn' : ''}` },
              p.refundStatus === 'PENDING' ? 'iade ediliyor' : PAY_STATUS[p.status] || p.status)),
        ))) : el('p', { class: 'muted small' }, 'Henüz ödeme yok.'),
      );
      const hist = el('section', { class: 'card' }, el('h2', {}, 'Hareketler'),
        w.history.length ? el('ul', { class: 'entrants' }, w.history.map((h) => el('li', {},
          el('span', {}, h.reason === 'PRIZE_RELEASE' && h.bucket === 'pending' ? 'Bekletmeden çıktı' : REASONS[h.reason] || h.reason, el('span', { class: 'small muted' }, ` · ${fmtTime(h.at)} · ${h.bucket === 'pending' ? 'bekletme' : 'çekilebilir'}`)),
          el('b', { class: `mono ${h.cents < 0 ? 'neg' : 'pos'}` }, `${h.cents > 0 ? '+' : ''}${money(h.cents, h.currency)}`),
        ))) : el('p', { class: 'muted small' }, 'Hareket yok.'),
      );
      root.replaceChildren(
        el('header', {}, el('p', { class: 'eyebrow' }, 'Hesap'), el('h1', {}, 'Cüzdan')),
        el('div', { class: 'grid2' }, el('div', { class: 'col' }, summary, pays), el('div', { class: 'col' }, awards, hist)),
      );
    }
    await load();
    let t = null;
    const off = ws.on((m) => {
      if (/^(payment|prize)\./.test(m.type)) { clearTimeout(t); t = setTimeout(() => void load().catch(() => undefined), 300); }
    });
    return () => { off(); clearTimeout(t); };
  }

  // ---- başlangıç ------------------------------------------------------------------

  window.addEventListener('hashchange', () => void route());
  renderNav();
  ws.connect();
  (hint.get() ? refresh() : Promise.resolve(false)).finally(() => void route());
})();
