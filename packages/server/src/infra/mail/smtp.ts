/**
 * Bağımlılıksız küçük SMTP istemcisi (K46). Gmail gibi bir hesapla da çalışır:
 *  - Gmail: SMTP_HOST=smtp.gmail.com, SMTP_PORT=465 (doğrudan TLS), SMTP_USER=adres@gmail.com,
 *    SMTP_PASS=Google hesabında oluşturulan "uygulama şifresi" (normal şifre değil).
 *  - 587 portunda STARTTLS desteklenir. Testlerde düz bağlantı (secure=false, starttls=false).
 * Gövde UTF-8 düz metin, base64 kodlu; başlık RFC 2047 ile kodlanır.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface SmtpOptions {
  host: string;
  port: number;
  /** Doğrudan TLS (465). false ise düz bağlanılır; sunucu destekliyorsa ve starttls açıksa yükseltilir. */
  secure: boolean;
  starttls?: boolean;
  user?: string;
  pass?: string;
  /** EHLO'da kullanılacak ad. */
  clientName?: string;
  timeoutMs?: number;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  /** Ek başlıklar (ör. List-Unsubscribe). */
  headers?: Record<string, string>;
}

class LineReader {
  private buf = '';
  private waiting: ((r: { code: number; text: string }) => void) | null = null;
  private failing: ((e: Error) => void) | null = null;
  private lines: string[] = [];
  private socket: Socket | TLSSocket;
  constructor(socket: Socket | TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }
  attach(socket: Socket | TLSSocket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) this.flush();
      }
    });
    socket.on('error', (e) => this.failing?.(e));
  }
  private flush() {
    if (!this.waiting) return;
    const all = this.lines.splice(0);
    const last = all[all.length - 1] ?? '';
    const w = this.waiting;
    this.waiting = null;
    this.failing = null;
    w({ code: Number(last.slice(0, 3)), text: all.join('\n') });
  }
  read(timeoutMs: number): Promise<{ code: number; text: string }> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SMTP zaman aşımı')), timeoutMs);
      this.waiting = (r) => {
        clearTimeout(t);
        resolve(r);
      };
      this.failing = (e) => {
        clearTimeout(t);
        reject(e);
      };
      if (this.lines.some((l) => /^\d{3}( |$)/.test(l))) this.flush();
    });
  }
  get raw() {
    return this.socket;
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');

/** Adres kısmını çıkarır: "Ad <a@b>" → a@b */
export function addressOf(s: string): string {
  const m = /<([^>]+)>/.exec(s);
  return (m?.[1] ?? s).trim();
}

export function buildMessage(m: MailMessage, now = new Date()): string {
  const fromName = /^(.*)<[^>]+>\s*$/.exec(m.from)?.[1]?.trim().replace(/^"|"$/g, '');
  const from = fromName ? `${encodeHeader(fromName)} <${addressOf(m.from)}>` : addressOf(m.from);
  const headers: Record<string, string> = {
    From: from,
    To: addressOf(m.to),
    Subject: encodeHeader(m.subject),
    Date: now.toUTCString().replace('GMT', '+0000'),
    'Message-ID': `<${now.getTime()}.${Math.random().toString(36).slice(2)}@${addressOf(m.from).split('@')[1] ?? 'localhost'}>`,
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Transfer-Encoding': 'base64',
    ...(m.headers ?? {}),
  };
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return `${head}\r\n\r\n${wrap76(b64(m.text))}`;
}

export async function sendMail(o: SmtpOptions, m: MailMessage): Promise<void> {
  const timeout = o.timeoutMs ?? 20_000;
  const socket: Socket | TLSSocket = await new Promise((resolve, reject) => {
    const s = o.secure
      ? tlsConnect({ host: o.host, port: o.port, servername: o.host }, () => resolve(s))
      : netConnect({ host: o.host, port: o.port }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeout, () => s.destroy(new Error('SMTP bağlantı zaman aşımı')));
  });
  const r = new LineReader(socket);
  const write = (line: string) => r.raw.write(`${line}\r\n`);
  const expect = async (codes: number[], what: string) => {
    const res = await r.read(timeout);
    if (!codes.includes(res.code)) throw new Error(`SMTP ${what} reddedildi: ${res.text.slice(0, 200)}`);
    return res;
  };
  try {
    await expect([220], 'karşılama');
    const name = o.clientName ?? 'localhost';
    write(`EHLO ${name}`);
    let ehlo = await expect([250], 'EHLO');
    if (!o.secure && o.starttls && /STARTTLS/i.test(ehlo.text)) {
      write('STARTTLS');
      await expect([220], 'STARTTLS');
      const up: TLSSocket = await new Promise((resolve, reject) => {
        const t = tlsConnect({ socket: r.raw as Socket, servername: o.host }, () => resolve(t));
        t.once('error', reject);
      });
      r.attach(up);
      write(`EHLO ${name}`);
      ehlo = await expect([250], 'EHLO');
    }
    if (o.user && o.pass) {
      write(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.pass}`, 'utf8').toString('base64')}`);
      await expect([235], 'kimlik doğrulama');
    }
    write(`MAIL FROM:<${addressOf(m.from)}>`);
    await expect([250], 'gönderen');
    write(`RCPT TO:<${addressOf(m.to)}>`);
    await expect([250, 251], 'alıcı');
    write('DATA');
    await expect([354], 'DATA');
    // Nokta ile başlayan satırlar çiftlenir (dot-stuffing); base64 gövdede olmaz ama başlıklar için güvenli.
    const body = buildMessage(m).replace(/\r\n\./g, '\r\n..');
    r.raw.write(`${body}\r\n.\r\n`);
    await expect([250], 'ileti');
    write('QUIT');
  } finally {
    r.raw.end();
  }
}
