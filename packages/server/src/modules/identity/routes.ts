import type { Config } from '../../config.ts';
import { AppError, forbidden, unauthorized } from '../../infra/errors.ts';
import { RULES } from '../../infra/http/ratelimit.ts';
import type { Ctx, Router } from '../../infra/http/router.ts';
import { parse } from '../../infra/http/validate.ts';
import type { IdentityService, LoginResult } from './service.ts';

const REFRESH_COOKIE = 'rt';
const AUTH_PATH = '/v1/auth';

const COUNTRY = /^[A-Z]{2}$/;
const DISPLAY_NAME = /^[\p{L}\p{N}_-]{3,20}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/**
 * Yenileme ve çıkış uçları çerezle çalıştığından CSRF'e karşı Origin kontrolü:
 * tarayıcı Origin gönderiyorsa sunucunun kendi adresiyle aynı olmalı.
 */
function assertSameOrigin(ctx: Ctx): void {
  const origin = ctx.req.headers.origin;
  if (!origin) return;
  const host = ctx.req.headers.host;
  try {
    if (new URL(origin).host !== host) throw forbidden('CSRF', 'Çapraz kaynaklı istek reddedildi');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw forbidden('CSRF', 'Çapraz kaynaklı istek reddedildi');
  }
}

export function identityRoutes(router: Router, svc: IdentityService, cfg: Config): void {
  const meta = (ctx: Ctx) => ({ ip: ctx.ip, userAgent: ctx.userAgent, deviceKey: ctx.deviceKey });
  const issue = (ctx: Ctx, r: LoginResult) => {
    ctx.setCookie(REFRESH_COOKIE, r.refreshToken, { path: AUTH_PATH, maxAgeSec: cfg.refreshTokenTtlSec, httpOnly: true, sameSite: 'Strict' });
    return { user: r.user, accessToken: r.accessToken, expiresIn: r.expiresIn };
  };

  router.post('/v1/auth/register', async (ctx) => {
    ctx.limit(`register:${ctx.ip}`, { capacity: cfg.registrationsPerHourPerIp, refillPerSec: cfg.registrationsPerHourPerIp / 3600 });
    const b = parse(
      {
        email: { type: 'string', max: 254, pattern: EMAIL },
        password: { type: 'string', min: 1, max: 128, trim: false },
        displayName: { type: 'string', pattern: DISPLAY_NAME },
        birthDate: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ },
        countryCode: { type: 'string', upper: true, pattern: COUNTRY },
        acceptTos: { type: 'boolean', mustBeTrue: true },
      },
      ctx.body,
    );
    ctx.status = 201;
    return { user: await svc.register(b, meta(ctx)), tosVersion: cfg.tosVersion };
  });

  router.post('/v1/auth/verify-email', async (ctx) => {
    const b = parse({ token: { type: 'string', min: 20, max: 200 } }, ctx.body);
    return { user: await svc.verifyEmail(b.token) };
  });

  router.post('/v1/auth/resend-verification', async (ctx) => {
    const u = ctx.requireUser();
    ctx.limit(`resend:${u.id}`, RULES.register);
    await svc.resendVerification(u.id);
    return { ok: true };
  });

  router.post('/v1/auth/login', async (ctx) => {
    const b = parse({ email: { type: 'string', max: 254 }, password: { type: 'string', max: 128, trim: false } }, ctx.body);
    ctx.limit(`login:${ctx.ip}:${b.email.toLowerCase()}`, RULES.login);
    return issue(ctx, await svc.login(b.email, b.password, meta(ctx)));
  });

  router.post('/v1/auth/refresh', async (ctx) => {
    assertSameOrigin(ctx);
    const token = ctx.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('NO_SESSION', 'Oturum yok');
    try {
      return issue(ctx, await svc.refresh(token, meta(ctx)));
    } catch (e) {
      ctx.clearCookie(REFRESH_COOKIE, AUTH_PATH);
      throw e;
    }
  });

  router.post('/v1/auth/logout', async (ctx) => {
    assertSameOrigin(ctx);
    await svc.logout(ctx.cookies[REFRESH_COOKIE], ctx.user?.sessionId);
    ctx.clearCookie(REFRESH_COOKIE, AUTH_PATH);
    return undefined;
  });

  router.get('/v1/me', async (ctx) => ({ user: await svc.me(ctx.requireUser().id) }));

  router.get('/v1/me/sessions', async (ctx) => {
    const u = ctx.requireUser();
    return { sessions: await svc.listSessions(u.id, u.sessionId) };
  });

  router.delete('/v1/me/sessions/:id', async (ctx) => {
    const u = ctx.requireUser();
    await svc.revokeSessionFamily(u.id, ctx.params.id as string);
    return undefined;
  });

  if (cfg.devMailbox) {
    router.get('/v1/dev/mailbox', async (ctx) => {
      const email = ctx.query.get('email');
      if (!email) throw new AppError(400, 'VALIDATION', 'email parametresi gerekli');
      return { messages: await svc.devMailbox(email) };
    });
  }
}
