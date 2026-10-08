/**
 * Küçük şema doğrulayıcı (Zod yerine; npm erişimi gelince Zod'a geçilebilir).
 * Her istek gövdesi bir şemadan geçer; bilinmeyen alanlar atılır.
 */
import { badRequest } from '../errors.ts';

type FieldSpec =
  | { type: 'string'; min?: number; max?: number; pattern?: RegExp; enum?: readonly string[]; optional?: boolean; trim?: boolean; lower?: boolean; upper?: boolean }
  | { type: 'int'; min?: number; max?: number; optional?: boolean }
  | { type: 'boolean'; optional?: boolean; mustBeTrue?: boolean }
  | { type: 'uuid'; optional?: boolean };

export type Schema = Record<string, FieldSpec>;

type Infer<F extends FieldSpec> = F extends { type: 'string' }
  ? string
  : F extends { type: 'int' }
    ? number
    : F extends { type: 'boolean' }
      ? boolean
      : string;

export type Parsed<S extends Schema> = {
  [K in keyof S as S[K] extends { optional: true } ? never : K]: Infer<S[K]>;
} & {
  [K in keyof S as S[K] extends { optional: true } ? K : never]?: Infer<S[K]>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parse<S extends Schema>(schema: S, input: unknown): Parsed<S> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('VALIDATION', 'İstek gövdesi bir JSON nesnesi olmalı');
  }
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, spec] of Object.entries(schema)) {
    let v = src[key];
    if (v === undefined || v === null || v === '') {
      if (!spec.optional) errors[key] = 'zorunlu';
      continue;
    }
    switch (spec.type) {
      case 'string': {
        if (typeof v !== 'string') { errors[key] = 'metin olmalı'; break; }
        if (spec.trim !== false) v = (v as string).trim();
        if (spec.lower) v = (v as string).toLowerCase();
        if (spec.upper) v = (v as string).toUpperCase();
        const s = v as string;
        if (spec.min !== undefined && s.length < spec.min) { errors[key] = `en az ${spec.min} karakter`; break; }
        if (spec.max !== undefined && s.length > spec.max) { errors[key] = `en fazla ${spec.max} karakter`; break; }
        if (spec.pattern && !spec.pattern.test(s)) { errors[key] = 'biçim geçersiz'; break; }
        if (spec.enum && !spec.enum.includes(s)) { errors[key] = `şunlardan biri olmalı: ${spec.enum.join(', ')}`; break; }
        out[key] = s;
        break;
      }
      case 'int': {
        const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
        if (typeof n !== 'number' || !Number.isInteger(n)) { errors[key] = 'tamsayı olmalı'; break; }
        if (spec.min !== undefined && n < spec.min) { errors[key] = `en az ${spec.min}`; break; }
        if (spec.max !== undefined && n > spec.max) { errors[key] = `en fazla ${spec.max}`; break; }
        out[key] = n;
        break;
      }
      case 'boolean': {
        if (typeof v !== 'boolean') { errors[key] = 'doğru/yanlış olmalı'; break; }
        if (spec.mustBeTrue && !v) { errors[key] = 'kabul edilmeli'; break; }
        out[key] = v;
        break;
      }
      case 'uuid': {
        if (typeof v !== 'string' || !UUID_RE.test(v)) { errors[key] = 'geçersiz kimlik'; break; }
        out[key] = v.toLowerCase();
        break;
      }
    }
  }
  if (Object.keys(errors).length) throw badRequest('VALIDATION', 'Girdi doğrulanamadı', { fields: errors });
  return out as Parsed<S>;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
