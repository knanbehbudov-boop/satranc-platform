// Sandbox ödeme sayfası betiği (CSP uyumlu: satır içi betik/stil yok).
(() => {
  const $ = (id) => document.getElementById(id);
  const intentId = decodeURIComponent(location.pathname.split('/').pop() || '');
  const secret = new URLSearchParams(location.search).get('secret') || '';
  const api = (p) => `/sandbox-psp/v1/checkout/${encodeURIComponent(intentId)}${p}`;
  let returnUrl = '/';

  const REASONS = {
    card_declined: 'Kart reddedildi.',
    insufficient_funds: 'Yetersiz bakiye.',
    authentication_failed: '3D Secure doğrulaması başarısız.',
  };

  function show(el, on) { $(el).classList.toggle('hidden', !on); }
  function msg(text, kind) {
    const m = $('message');
    m.textContent = text;
    m.className = `message ${kind || ''}`;
  }
  function money(cents, cur) {
    try { return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: cur }).format(cents / 100); }
    catch { return `${(cents / 100).toFixed(2)} ${cur}`; }
  }
  async function call(path, body) {
    const res = await fetch(api(path), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify({ secret, ...body }) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'İstek başarısız');
    return data;
  }
  function done(r) {
    if (r.status === 'succeeded') {
      msg('Ödeme başarılı. Siteye yönlendiriliyorsunuz…', 'ok');
      show('pay-form', false); show('three-ds', false);
      $('back').href = r.returnUrl || returnUrl; show('back', true);
      setTimeout(() => { location.href = r.returnUrl || returnUrl; }, 1200);
    } else if (r.status === 'requires_action') {
      show('pay-form', false); show('three-ds', true); msg('');
    } else if (r.status === 'failed') {
      show('three-ds', false); show('pay-form', true);
      msg(`${REASONS[r.reason] || 'Ödeme başarısız.'} Başka bir kartla tekrar deneyebilirsiniz.`, 'err');
    }
  }

  async function load() {
    try {
      const i = await call('?secret=' + encodeURIComponent(secret));
      returnUrl = i.returnUrl || '/';
      $('desc').textContent = i.description || 'Ödeme';
      $('amount').textContent = money(i.amountCents, i.currency);
      $('back').href = returnUrl;
      if (i.status === 'succeeded') return done({ status: 'succeeded', returnUrl });
      if (i.status === 'requires_action') return done({ status: 'requires_action' });
      show('pay-form', true);
      if (i.status === 'failed' && i.failureReason) msg(`${REASONS[i.failureReason] || 'Önceki deneme başarısız.'} Tekrar deneyebilirsiniz.`, 'err');
    } catch (e) {
      $('desc').textContent = 'Ödeme bulunamadı.';
      msg(e.message, 'err');
    }
  }

  // Kart numarasını 4'lü gruplar halinde göster.
  $('card').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 19);
    e.target.value = d.replace(/(.{4})/g, '$1 ').trim();
  });
  $('exp').addEventListener('input', (e) => {
    const d = e.target.value.replace(/\D/g, '').slice(0, 4);
    e.target.value = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
  });

  $('pay-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('pay-btn').disabled = true;
    msg('İşleniyor…');
    try {
      done(await call('/pay', { card: $('card').value, exp: $('exp').value, cvc: $('cvc').value }));
    } catch (err) {
      msg(err.message, 'err');
    } finally {
      $('pay-btn').disabled = false;
    }
  });
  $('approve-3ds').addEventListener('click', async () => {
    try { done(await call('/3ds', { approve: true })); } catch (err) { msg(err.message, 'err'); }
  });
  $('reject-3ds').addEventListener('click', async () => {
    try { done(await call('/3ds', { approve: false })); } catch (err) { msg(err.message, 'err'); }
  });

  load();
})();
