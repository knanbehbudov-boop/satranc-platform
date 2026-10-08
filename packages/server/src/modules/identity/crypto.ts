/**
 * Şifre özeti ve erişim tokeni.
 *
 * Şifre: scrypt (Node yerleşik). Plan argon2id öneriyordu; Node 22'de yerleşik
 * argon2 yok ve npm deposuna erişim kapalı (karar K19). scrypt OWASP'ın kabul ettiği
 * algoritmalardandır. Özet biçimi algoritma ve parametreleri içerir, böylece ileride
 * argon2id'ye geçişte eski özetler girişte yeniden özetlenebilir (needsRehash).
 *
 * Erişim tokeni: HS256 JWT, kısa ömürlü (varsayılan 15 dk).
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT = {
  N: Number(process.env.SCRYPT_N ?? 2 ** 15),
  r: 8,
  p: 1,
  keyLen: 32,
};

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Sabit süreli karşılaştırma. Bilinmeyen biçimde false döner. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < SCRYPT.N;
}

/** Kullanıcı yokken de aynı süre harcansın (e-posta sızdırma koruması). */
export const DUMMY_HASH = `scrypt$${SCRYPT.N}$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

// ---- tokenler ---------------------------------------------------------------

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export interface AccessClaims {
  sub: string;
  sid: string;
  roles: string[];
  iat: number;
  exp: number;
}

export function signAccessToken(claims: Omit<AccessClaims, 'iat' | 'exp'>, secret: string, ttlSec: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ ...claims, iat: nowSec, exp: nowSec + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyAccessToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null; // "alg: none" ve algoritma karıştırma saldırılarına karşı
  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  let claims: AccessClaims;
  try {
    claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return null;
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || !Array.isArray(claims.roles)) return null;
  return claims;
}

// ---- şifre politikası -------------------------------------------------------

/**
 * Sızdırılmış şifre kontrolü: gerçek ortamda HIBP k-anonimlik API'si kullanılır
 * (yalnız özetin ilk 5 karakteri gönderilir). Ağ erişimi olmadığında en yaygın
 * şifrelerden oluşan yerel liste uygulanır.
 */
const COMMON = new Set([
  '1234567890', '12345678910', 'qwertyuiop', 'password123', 'password1!', 'iloveyou12', '1q2w3e4r5t',
  'qwerty1234', 'asdfghjkl1', 'abc1234567', 'sifre12345', 'parola1234', 'galatasaray', 'fenerbahce',
  'besiktas1903', 'trabzonspor', 'chess12345', 'satranc123', 'magnus1234', 'aaaaaaaaaa', '0000000000',
]);

export function passwordProblem(password: string, context: string[] = []): string | null {
  if (password.length < 10) return 'en az 10 karakter olmalı';
  if (password.length > 128) return 'en fazla 128 karakter olmalı';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'çok yaygın bir şifre';
  if (/^(.)\1+$/.test(password)) return 'tek karakterin tekrarı olamaz';
  for (const c of context) if (c && c.length >= 4 && lower.includes(c.toLowerCase())) return 'e-posta veya kullanıcı adını içeremez';
  return null;
}
