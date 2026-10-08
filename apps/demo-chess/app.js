// Test masası: yalnızca ChessCore'un açık API'sini kullanır (sunucunun kullanacağı API ile aynı).
(() => {
  const C = window.ChessCore;
  const FIX = window.__FIXTURES__;
  const $ = (id) => document.getElementById(id);

  const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const PIECE_NAME = { k: 'şah', q: 'vezir', r: 'kale', b: 'fil', n: 'at', p: 'piyon' };
  const COLOR_NAME = { w: 'Beyaz', b: 'Siyah' };
  const REASON = {
    mate: 'Mat',
    stalemate: 'Pat: sırası gelen tarafın yasal hamlesi yok ve şah tehdit altında değil.',
    insufficient_material: 'Yetersiz materyal: iki taraf da mat edemez.',
    threefold_repetition: 'Üç kez tekrar: aynı pozisyon üçüncü kez oluştu.',
    fifty_move: '50 hamle kuralı: 50 tam hamledir taş alınmadı, piyon oynamadı.',
    agreement: 'Karşılıklı anlaşmayla beraberlik.',
    resign: 'Teslim',
    timeout: 'Süre bitti',
    timeout_vs_insufficient: 'Süre bitti, ama rakipte mat edecek materyal yok: beraberlik.',
    abandon: 'Oyun terk edildi', forfeit: 'Hükmen', adjudication: 'Hakem kararı',
  };
  const ERR = {
    ILLEGAL_MOVE: 'Bu hamle yasal değil.',
    GAME_OVER: 'Oyun bitti; yeni oyun başlatın ya da bir senaryo yükleyin.',
    DRAW_OFFER_TOO_EARLY: 'Ücretli turnuvada beraberlik teklifi 20. hamle tamamlanınca açılır.',
    DRAW_OFFER_PENDING: 'Bu tarafın bekleyen bir teklifi zaten var.',
    NO_DRAW_OFFER: 'Kabul edilecek bir teklif yok: önce karşı taraf teklif etmeli.',
    TAKEBACK_DISABLED: 'Hamle geri alma bu platformda her formatta kapalıdır (doküman 3.4).',
    INVALID_FEN: 'FEN geçersiz.',
    INVALID_PGN: 'PGN okunamadı.',
  };

  const SCENARIOS = [
    { id: 'castle', title: 'Rok', sub: 'kısa ve uzun', fen: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
      hint: 'e1 şahına dokunun: g1 (O-O) ve c1 (O-O-O) işaretlenir. Kale kendiliğinden yer değiştirir. Bir kaleyi oynatırsanız o yöndeki rok hakkı kaybolur.' },
    { id: 'ep', title: 'Geçerken alma', sub: 'yalnızca hemen', fen: 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3',
      hint: 'Siyah az önce f7-f5 oynadı. e5 piyonuna dokunun: f6 geçerken almadır, d6 değildir. Başka bir hamle yaparsanız hak düşer.' },
    { id: 'promo', title: 'Terfi', sub: 'taş seçimi', fen: '8/1P5k/8/8/8/8/6K1/8 w - - 0 1',
      hint: 'b7 piyonunu b8’e sürün. Vezir, kale, fil veya at seçmeniz istenir; seçmeden terfi olmaz.' },
    { id: 'mate', title: 'Mat', sub: 'aptal matı', fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
      hint: 'Siyah oynuyor: d8 vezirini h4’e götürün. Hamle "Qh4#" olarak yazılır ve oyun biter.' },
    { id: 'stalemate', title: 'Pat', sub: 'tek hamlede', fen: '7k/8/6Q1/8/8/8/8/K7 w - - 0 1',
      hint: 'Veziri f7’ye götürün. Siyah şah tehdit altında değil ama gidecek karesi yok: beraberlik.' },
    { id: 'repeat', title: 'Üç kez tekrar', sub: 'otomatik', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      hint: 'Ng1, Nb8, Nf3, Nc6 dizisini iki kez oynayın. Aynı pozisyon üçüncü kez oluşunca oyun berabere biter.' },
    { id: 'insufficient', title: 'Yetersiz materyal', sub: 'yalnız şahlar', fen: '8/8/4k3/8/3q4/2K5/8/8 w - - 0 1',
      hint: 'Beyaz şah tehdit altında. Kxd4 ile veziri alın: tahtada yalnız şahlar kalır, oyun berabere biter.' },
    { id: 'fifty', title: '50 hamle', sub: '1 hamle kaldı', fen: '7k/8/8/8/8/8/R7/K7 w - - 99 80',
      hint: 'Sayaç 99 yarım hamlede. Taş almadan bir kale hamlesi yapın (ör. Rb2): 50 hamle kuralı dolar.' },
    { id: 'flag', title: 'Süre bitimi', sub: 'materyal kuralı', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1',
      hint: '"Beyazın süresi bitti" düğmesine basın: siyahta yalnız şah var, sonuç beraberlik. Senaryoyu yeniden yükleyip siyahın süresini bitirin: beyaz kazanır.' },
    { id: 'pin', title: 'Açmaz', sub: 'yasak hamle', fen: '4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1',
      hint: 'e2 atına dokunun: hiçbir kare işaretlenmez. At oynarsa e7 kalesi şaha vurur.' },
  ];

  const state = {
    paid: false,
    game: null,
    flipped: false,
    selected: null,
    pendingPromotion: null,
    confirm: null, // { kind: 'resign', color }
    message: null, // { kind: 'err'|'ok', text, code }
    hint: null,
  };

  function rules() {
    return state.paid
      ? C.rulesFor({ paid: true, timeControl: C.parseTimeControl('300+3') })
      : C.CASUAL_RULES;
  }

  function newGame(fen) {
    state.game = new C.ChessGame(fen ? { fen, rules: rules() } : { rules: rules() });
    state.selected = null;
    state.pendingPromotion = null;
    state.confirm = null;
  }

  function say(kind, text, code) {
    state.message = { kind, text, code };
  }

  function explain(e) {
    if (e && e.code) {
      const base = ERR[e.code] || e.message;
      const extra = e.code === 'INVALID_FEN' || e.code === 'INVALID_PGN' ? ` ${e.message}` : '';
      say('err', base + extra, e.code);
    } else {
      say('err', String(e && e.message ? e.message : e));
    }
  }

  function act(fn) {
    try {
      fn();
    } catch (e) {
      explain(e);
    }
    render();
  }

  // ---- tahta ---------------------------------------------------------------

  const FILES = 'abcdefgh';
  function squaresInOrder() {
    const out = [];
    for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) out.push(FILES[f] + (r + 1));
    return state.flipped ? out.reverse() : out;
  }

  function lastMove() {
    const h = state.game.history();
    return h.length ? h[h.length - 1].move : null;
  }

  function kingInCheckSquare() {
    if (!state.game.isCheck()) return null;
    for (const sq of squaresInOrder()) {
      const p = state.game.get(sq);
      if (p && p.type === 'k' && p.color === state.game.turn) return sq;
    }
    return null;
  }

  function renderBoard() {
    const board = $('board');
    board.textContent = '';
    const order = squaresInOrder();
    const targets = new Map();
    if (state.selected) for (const m of state.game.moves(state.selected)) targets.set(m.to, m);
    const lm = lastMove();
    const checkSq = kingInCheckSquare();

    order.forEach((sq, idx) => {
      const file = FILES.indexOf(sq[0]);
      const rank = Number(sq[1]) - 1;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `sq ${(file + rank) % 2 === 0 ? 'dark' : 'light'}`;
      if (lm && (lm.from === sq || lm.to === sq)) btn.classList.add('last');
      if (state.selected === sq) btn.classList.add('selected');
      if (checkSq === sq) btn.classList.add('check');
      btn.dataset.square = sq;
      const p = state.game.get(sq);
      btn.setAttribute('aria-label', p ? `${sq}, ${COLOR_NAME[p.color].toLowerCase()} ${PIECE_NAME[p.type]}` : sq);
      if (p) {
        const span = document.createElement('span');
        span.className = `piece ${p.color}`;
        span.textContent = GLYPH[p.type] + '︎';
        btn.appendChild(span);
      }
      if (targets.has(sq)) {
        const dot = document.createElement('span');
        dot.className = p || targets.get(sq).flag === 'e' ? 'target capture' : 'target';
        btn.appendChild(dot);
      }
      if (idx % 8 === 0) {
        const c = document.createElement('span');
        c.className = 'coord rank';
        c.textContent = sq[1];
        btn.appendChild(c);
      }
      if (idx >= 56) {
        const c = document.createElement('span');
        c.className = 'coord file';
        c.textContent = sq[0];
        btn.appendChild(c);
      }
      btn.addEventListener('click', () => onSquare(sq));
      board.appendChild(btn);
    });

    if (state.pendingPromotion) {
      const { color } = state.pendingPromotion;
      const wrap = document.createElement('div');
      wrap.className = 'promo';
      const card = document.createElement('div');
      card.className = 'promo-card';
      card.innerHTML = '<p>Piyon hangi taşa terfi etsin?</p>';
      const row = document.createElement('div');
      row.className = 'promo-row';
      for (const t of ['q', 'r', 'b', 'n']) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = `promo-${t}`;
        b.setAttribute('aria-label', PIECE_NAME[t]);
        b.innerHTML = `<span class="piece ${color}">${GLYPH[t]}︎</span>`;
        b.addEventListener('click', () => finishPromotion(t));
        row.appendChild(b);
      }
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = 'Vazgeç';
      cancel.addEventListener('click', () => { state.pendingPromotion = null; render(); });
      card.append(row, cancel);
      wrap.appendChild(card);
      board.appendChild(wrap);
      setTimeout(() => $('promo-q')?.focus(), 0);
    }
  }

  function onSquare(sq) {
    const g = state.game;
    if (state.pendingPromotion) return;
    state.message = null;
    if (g.status().over) {
      say('err', ERR.GAME_OVER, 'GAME_OVER');
      render();
      return;
    }
    const p = g.get(sq);
    if (state.selected) {
      const options = g.moves(state.selected).filter((m) => m.to === sq);
      if (options.length > 1 || (options[0] && options[0].promotion)) {
        state.pendingPromotion = { from: state.selected, to: sq, color: g.turn };
        render();
        return;
      }
      if (options.length === 1) {
        const from = state.selected;
        state.selected = null;
        act(() => g.move({ from, to: sq }));
        return;
      }
      if (p && p.color === g.turn) {
        state.selected = sq === state.selected ? null : sq;
        render();
        return;
      }
      // Yasal olmayan kare: motorun kendi hatasını göster.
      const from = state.selected;
      state.selected = null;
      act(() => g.move({ from, to: sq }));
      return;
    }
    if (p && p.color === g.turn) state.selected = sq;
    else if (p) say('err', `Sıra ${COLOR_NAME[g.turn].toLowerCase()} tarafta.`);
    render();
  }

  function finishPromotion(t) {
    const { from, to } = state.pendingPromotion;
    state.pendingPromotion = null;
    state.selected = null;
    act(() => state.game.move({ from, to, promotion: t }));
  }

  // ---- panel ---------------------------------------------------------------

  function renderPlayers() {
    const top = state.flipped ? 'w' : 'b';
    const bottom = state.flipped ? 'b' : 'w';
    const g = state.game;
    for (const [id, color] of [['player-top', top], ['player-bottom', bottom]]) {
      const el = $(id);
      const active = !g.status().over && g.turn === color;
      el.className = `player${active ? ' active' : ''}`;
      const offer = g.drawOfferedBy() === color ? ' · beraberlik teklif etti' : '';
      el.innerHTML = `<span><span class="turn-dot"></span><strong>${COLOR_NAME[color]}</strong>${offer}</span><span>${active ? 'hamle sırası' : ''}</span>`;
    }
  }

  function renderStatus() {
    const g = state.game;
    const s = g.status();
    const pill = $('status-pill');
    const detail = $('status-detail');
    if (s.over) {
      pill.className = 'pill over';
      pill.textContent = s.result.replace('1/2-1/2', '½–½');
      const who = s.winner ? `${COLOR_NAME[s.winner]} kazandı. ` : 'Berabere. ';
      detail.textContent = who + (REASON[s.reason] || s.reason);
    } else if (g.isCheck()) {
      pill.className = 'pill check';
      pill.textContent = 'Şah';
      detail.textContent = `${COLOR_NAME[g.turn]} şah tehdidi altında ve hamle sırası onda.`;
    } else {
      pill.className = 'pill';
      pill.textContent = 'Oyun sürüyor';
      detail.textContent = `Hamle sırası: ${COLOR_NAME[g.turn].toLowerCase()}. Yasal hamle sayısı: ${g.moves().length}.`;
    }

    const r = g.ruleSet;
    const fullMovesDone = Math.floor(g.plyCount() / 2);
    const chips = [
      [r.paid ? 'Ücretli turnuva kuralları' : 'Ücretsiz oyun kuralları', true],
      [r.drawOfferMinFullMoves ? `Beraberlik teklifi: ${g.canOfferDraw() ? 'açık' : `${fullMovesDone}/${r.drawOfferMinFullMoves} hamle`}` : 'Beraberlik teklifi: her zaman', g.canOfferDraw()],
      [`Ön hamle: ${r.premoveAllowed ? 'açık' : 'kapalı'}`, r.premoveAllowed],
      ['Geri alma: kapalı', false],
      ['Tekrar ve 50 hamle: otomatik', true],
    ];
    $('rule-chips').innerHTML = chips.map(([t, on]) => `<span class="chip${on ? ' on' : ''}">${t}</span>`).join('');

    const msg = $('msg');
    if (state.message) {
      msg.hidden = false;
      msg.className = `msg ${state.message.kind}`;
      msg.textContent = state.message.text;
      if (state.message.code) {
        const code = document.createElement('code');
        code.textContent = ` (${state.message.code})`;
        msg.appendChild(code);
      }
    } else {
      msg.hidden = true;
    }
  }

  function renderMoves() {
    const list = $('moves');
    const h = state.game.history();
    list.textContent = '';
    $('moves-empty').hidden = h.length > 0;
    let i = 0;
    while (i < h.length) {
      const first = h[i];
      const no = Number(first.fenBefore.split(' ')[5]);
      const li = (cls, text) => {
        const el = document.createElement('li');
        if (cls) el.className = cls;
        el.textContent = text;
        list.appendChild(el);
      };
      li('no', `${no}.`);
      if (first.move.color === 'b') {
        li('', '…');
        li(i === h.length - 1 ? 'latest' : '', first.move.san);
        i += 1;
        continue;
      }
      li(i === h.length - 1 ? 'latest' : '', first.move.san);
      const second = h[i + 1];
      li(second && i + 1 === h.length - 1 ? 'latest' : '', second ? second.move.san : '');
      i += 2;
    }
    list.scrollTop = list.scrollHeight;
  }

  function renderActions() {
    const g = state.game;
    const over = g.status().over;
    const wrap = $('actions');
    wrap.textContent = '';
    for (const color of ['w', 'b']) {
      const side = document.createElement('div');
      side.className = 'side';
      side.innerHTML = `<h3>${COLOR_NAME[color]}</h3>`;
      const add = (id, label, handler, opts = {}) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = id;
        b.className = `btn${opts.danger ? ' danger' : ''}`;
        b.textContent = label;
        b.disabled = !!opts.disabled;
        b.addEventListener('click', handler);
        side.appendChild(b);
      };
      const confirming = state.confirm && state.confirm.color === color;
      if (confirming) {
        add(`resign-yes-${color}`, 'Evet, teslim ol', () => {
          state.confirm = null;
          act(() => g.resign(color));
        }, { danger: true });
        add(`resign-no-${color}`, 'Vazgeç', () => { state.confirm = null; render(); });
      } else {
        add(`resign-${color}`, 'Teslim ol', () => { state.confirm = { color }; state.message = null; render(); }, { disabled: over, danger: true });
      }
      add(`flag-${color}`, `${COLOR_NAME[color]}ın süresi bitti`, () => act(() => {
        const s = g.flag(color);
        say('ok', s.reason === 'timeout' ? 'Süre bitti; rakip mat edebileceği için kazandı.' : 'Süre bitti; rakipte mat materyali yok, beraberlik.');
      }), { disabled: over });
      add(`offer-${color}`, 'Beraberlik teklif et', () => act(() => {
        g.offerDraw(color);
        if (!g.status().over) say('ok', `${COLOR_NAME[color]} beraberlik teklif etti. Karşı taraf kabul edebilir ya da hamle yaparak reddedebilir.`);
      }), { disabled: over });
      add(`accept-${color}`, 'Teklifi kabul et', () => act(() => g.acceptDraw(color)), { disabled: over });
      wrap.appendChild(side);
    }
  }

  function renderScenarios() {
    const wrap = $('scenarios');
    if (!wrap.childElementCount) {
      for (const s of SCENARIOS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn';
        b.id = `scn-${s.id}`;
        b.innerHTML = `${s.title}<span>${s.sub}</span>`;
        b.addEventListener('click', () => {
          state.message = null;
          state.hint = s.hint;
          act(() => newGame(s.fen));
        });
        wrap.appendChild(b);
      }
    }
    const hint = $('hint');
    hint.hidden = !state.hint;
    hint.textContent = state.hint || '';
  }

  function renderIO() {
    const fenInput = $('fen-input');
    if (document.activeElement !== fenInput) fenInput.value = state.game.fen();
    const pgnOut = $('pgn-output');
    if (document.activeElement !== pgnOut) {
      pgnOut.value = C.toPgn(state.game, { Event: 'Test masası', Site: 'Bölüm 1 demo', White: 'Beyaz', Black: 'Siyah' });
    }
  }

  function renderMode() {
    $('mode-casual').setAttribute('aria-pressed', String(!state.paid));
    $('mode-paid').setAttribute('aria-pressed', String(state.paid));
  }

  function render() {
    renderMode();
    renderPlayers();
    renderBoard();
    renderStatus();
    renderMoves();
    renderActions();
    renderScenarios();
    renderIO();
  }

  // ---- düğmeler ------------------------------------------------------------

  $('btn-new').addEventListener('click', () => { state.message = null; state.hint = null; act(() => newGame()); });
  $('btn-flip').addEventListener('click', () => { state.flipped = !state.flipped; render(); });
  $('btn-undo').addEventListener('click', () => act(() => state.game.undo()));
  $('mode-casual').addEventListener('click', () => { state.paid = false; state.hint = null; state.message = null; act(() => newGame()); });
  $('mode-paid').addEventListener('click', () => {
    state.paid = true;
    state.hint = 'Ücretli turnuva kuralları: beraberlik teklifi iki taraf 20 hamle yapana kadar kilitli; bu formatta ön hamle kapalı. "Beraberlik teklif et" düğmesine basıp hatayı görebilirsiniz.';
    state.message = null;
    act(() => newGame());
  });
  $('btn-fen-load').addEventListener('click', () => act(() => {
    const fen = $('fen-input').value;
    const g = new C.ChessGame({ fen, rules: rules() });
    state.game = g;
    state.selected = null;
    state.hint = null;
    say('ok', 'Pozisyon yüklendi.');
  }));
  $('btn-fen-copy').addEventListener('click', () => {
    const v = state.game.fen();
    const input = $('fen-input');
    const fallback = () => { input.focus(); input.select(); say('ok', 'FEN seçildi; kopyalamak için Ctrl+C / Cmd+C kullanın.'); render(); };
    try {
      navigator.clipboard.writeText(v).then(() => { say('ok', 'FEN panoya kopyalandı.'); render(); }, fallback);
    } catch {
      fallback();
    }
  });
  $('btn-pgn-load').addEventListener('click', () => act(() => {
    const parsed = C.parsePgn($('pgn-output').value);
    state.game = parsed.game;
    state.selected = null;
    state.hint = null;
    say('ok', `PGN yeniden oynandı: ${parsed.game.plyCount()} yarım hamle, beyan edilen sonuç ${parsed.declaredResult}.`);
  }));

  // ---- tarayıcı içi perft --------------------------------------------------

  function selftest() {
    const body = $('selftest-body');
    const rows = [];
    for (const c of FIX.perft) c.counts.forEach((n, i) => rows.push({ name: c.name, fen: c.fen, depth: i + 1, expected: n }));
    body.innerHTML = rows.map((r, i) => `<tr id="st-${i}"><td>${r.name}</td><td>${r.depth}</td><td class="num">${r.expected.toLocaleString('tr-TR')}</td><td class="num">–</td><td class="num">–</td><td class="res wait">sırada</td></tr>`).join('');
    $('selftest-summary').textContent = 'Çalışıyor…';
    document.body.dataset.selftest = 'running';
    let pass = 0;
    let i = 0;
    const t0 = performance.now();
    const step = () => {
      const r = rows[i];
      const tr = $(`st-${i}`);
      const t = performance.now();
      const got = C.perft(C.parseFen(r.fen), r.depth);
      const ms = performance.now() - t;
      const ok = got === r.expected;
      if (ok) pass++;
      tr.children[3].textContent = got.toLocaleString('tr-TR');
      tr.children[4].textContent = `${ms.toFixed(0)} ms`;
      tr.children[5].className = `res ${ok ? 'pass' : 'fail'}`;
      tr.children[5].textContent = ok ? 'Doğru' : 'HATALI';
      i++;
      if (i < rows.length) setTimeout(step, 0);
      else {
        // Ek kontrol: Opera Oyunu PGN'i, sunucuda üretilen son FEN ile aynı mı?
        let pgnOk = false;
        try {
          pgnOk = C.parsePgn(FIX.opera).game.fen() === FIX.operaFinalFen;
        } catch { pgnOk = false; }
        const total = performance.now() - t0;
        $('selftest-summary').textContent =
          `${pass}/${rows.length} perft sayımı doğru, toplam ${(total / 1000).toFixed(1)} sn. ` +
          `Opera Oyunu PGN'inin son pozisyonu sunucudakiyle ${pgnOk ? 'aynı' : 'FARKLI'}.`;
        document.body.dataset.selftest = pass === rows.length && pgnOk ? 'pass' : 'fail';
      }
    };
    setTimeout(step, 30);
  }
  $('btn-selftest').addEventListener('click', selftest);

  newGame();
  render();
  selftest();
})();
