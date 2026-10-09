/**
 * Bağımlılıksız Web Push gönderici (K46): RFC 8291 (aes128gcm içerik şifreleme) ve RFC 8292 (VAPID).
 * Tarayıcı aboneliği { endpoint, keys: { p256dh, auth } } ile gelir; bildirim içeriği yalnız o
 * tarayıcının çözebileceği şekilde şifrelenir.
 */
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
export const fromB64u = (s: string) => Buffer.from(s, 'base64url');

export interface VapidKeys {
  /** Sıkıştırılmamış P-256 açık anahtar (65 bayt), base64url. Tarayıcıya verilir. */
  publicKey: string;
  /** Özel anahtar (d), base64url. */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), fromB64u(pub.x as string), fromB64u(pub.y as string)]);
  return { publicKey: b64u(raw), privateKey: priv.d as string };
}

function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const raw = fromB64u(keys.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)), d: keys.privateKey },
    format: 'jwk',
  });
}

/** VAPID JWT (ES256). aud = push servisinin kökü. */
export function vapidJwt(keys: VapidKeys, endpoint: string, subject: string, ttlSec = 12 * 3600): string {
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject })));
  const sig = sign('sha256', Buffer.from(`${header}.${payload}`), { key: vapidPrivateKey(keys), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64u(sig)}`;
}

/** RFC 8291: içerik şifreleme. Dönen gövde push servisine olduğu gibi gönderilir. */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string, opts: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {}): Buffer {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Geçersiz abonelik anahtarı');
  const ecdh = opts.ecdh ?? createECDH('prime256v1');
  if (!opts.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = opts.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Bildirimi gönderir. Dönen: HTTP durum kodu (404/410: abonelik geçersiz, silinmeli). */
export async function sendPush(sub: PushSubscriptionKeys, payload: unknown, keys: VapidKeys, subject: string, ttlSec = 120): Promise<number> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSec),
      Urgency: 'high',
      Authorization: `vapid t=${vapidJwt(keys, sub.endpoint, subject)}, k=${keys.publicKey}`,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15_000),
  });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}
