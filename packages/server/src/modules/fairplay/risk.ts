/**
 * Açıklanabilir risk skoru (doküman 14.3). Saf fonksiyon: girdiler toplanmış sinyallerdir.
 *
 *   R = clip( Σ w_i · S_i , 0, 1 )
 *
 * Her bileşen 0..1'dir ve neden o değeri aldığı "sebep" listesine yazılır. Ağırlıklar ve
 * eşikler başlangıç önerisidir; gerçek veriyle kalibre edilmelidir. Kesin eşikler
 * oyuncuya gösterilmez (tersine mühendislik önlemi); sebepler yalnız inceleyiciye gider.
 * Hiçbir skor kalıcı yaptırım uygulamaz: yalnız vaka açar (insan kararı, dört göz).
 */
import type { PlayerSummary } from './stats.ts';

export const MODEL_VERSION = 'risk-v1';

export const WEIGHTS = {
  engine: 0.30,
  time: 0.15,
  perf: 0.15,
  focus: 0.10,
  link: 0.15,
  behav: 0.10,
  collusion: 0.05,
} as const;

export const THRESHOLDS = { medium: 0.30, high: 0.60, critical: 0.85 } as const;

export type Level = 'low' | 'medium' | 'high' | 'critical';

export interface RiskInput {
  summary: PlayerSummary | null;
  rating: number;
  opponentRating: number;
  /** Bu oyundaki puanı (1, 0.5, 0). */
  score: number;
  focus: { hiddenOnMyTurn: number; hiddenMsOnMyTurn: number };
  link: { sharedAccounts: number; restrictedShared: number };
  behav: { accountAgeHours: number; paidEntries: number };
  collusion: { shortResign: boolean; repeatPairings: number };
}

export interface RiskResult {
  score: number;
  level: Level;
  components: Record<keyof typeof WEIGHTS, number>;
  reasons: string[];
}

const clip = (x: number) => Math.max(0, Math.min(1, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Rating bandına göre beklenen ACPL (doküman 14.4: bantlara ayrı baz çizgisi).
 * Başlangıç değerleri kaba bir eğridir; platform verisiyle yeniden kalibre edilmelidir.
 */
export function expectedAcpl(rating: number): number {
  const pts: [number, number][] = [[800, 110], [1200, 75], [1600, 50], [2000, 32], [2400, 20], [2800, 12]];
  if (rating <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    const [r1, a1] = pts[i]!;
    const [r0, a0] = pts[i - 1]!;
    if (rating <= r1) return a0 + ((rating - r0) / (r1 - r0)) * (a1 - a0);
  }
  return pts.at(-1)![1];
}

export function levelOf(score: number): Level {
  if (score >= THRESHOLDS.critical) return 'critical';
  if (score >= THRESHOLDS.high) return 'high';
  if (score >= THRESHOLDS.medium) return 'medium';
  return 'low';
}

export function computeRisk(x: RiskInput): RiskResult {
  const reasons: string[] = [];
  const s = x.summary;

  // S_engine: ACPL'nin bant beklentisinden sapması + karmaşık pozisyonlarda motorla uyum.
  let engine = 0;
  if (!s || s.analysedMoves < 8 || s.acpl === null) {
    reasons.push(`motor uyumu: yetersiz veri (${s?.analysedMoves ?? 0} hamle analiz edildi)`);
  } else {
    const exp = expectedAcpl(x.rating);
    const acplPart = clip((exp - s.acpl) / exp / 0.8);
    const matchPart = s.complexMoves >= 5 && s.complexTop1 !== null ? clip((s.complexTop1 - 0.5) / 0.4) : clip(((s.top1 ?? 0) - 0.65) / 0.3);
    engine = clip(0.5 * acplPart + 0.5 * matchPart);
    if (acplPart > 0.3) reasons.push(`ACPL ${s.acpl}, ${Math.round(x.rating)} rating için beklenen ~${Math.round(exp)}`);
    if (matchPart > 0.3) {
      reasons.push(s.complexMoves >= 5
        ? `karmaşık ${s.complexMoves} pozisyonda motorun ilk tercihi oranı %${Math.round((s.complexTop1 ?? 0) * 100)}`
        : `motorun ilk tercihi oranı %${Math.round((s.top1 ?? 0) * 100)}`);
    }
  }

  // S_time: aşırı düzenli ritim ve karmaşıklıktan bağımsız düşünme süresi.
  let time = 0;
  if (s && s.analysedMoves >= 8 && s.thinkCv !== null) {
    const regular = clip((0.45 - s.thinkCv) / 0.35);
    const flat = s.timeComplexityCorr === null ? 0 : clip((0.1 - s.timeComplexityCorr) / 0.4);
    time = clip(Math.max(regular, 0.6 * flat + 0.4 * regular));
    if (regular > 0.3) reasons.push(`düşünme süresi çok düzenli (değişim katsayısı ${s.thinkCv})`);
    if (flat > 0.5) reasons.push(`düşünme süresi pozisyon zorluğuyla ilişkisiz (r = ${s.timeComplexityCorr})`);
  }

  // S_perf: rating farkına göre beklenmeyen sonuç (performans sıçraması).
  const diff = x.opponentRating - x.rating;
  const expected = 1 / (1 + 10 ** (-diff / 400)) ;
  const surprise = x.score - (1 - expected);
  const perf = x.score > 0 && diff > 200 ? clip((diff - 200) / 600) * clip(surprise * 2) : 0;
  if (perf > 0.2) reasons.push(`${Math.round(diff)} puan güçlü rakibe karşı ${x.score === 1 ? 'galibiyet' : 'beraberlik'}`);

  // S_focus: kendi sırasındayken sekmeden çıkma (tek başına delil değildir).
  const focus = clip(x.focus.hiddenOnMyTurn / 5 * 0.6 + x.focus.hiddenMsOnMyTurn / 60_000 * 0.4);
  if (x.focus.hiddenOnMyTurn > 0) reasons.push(`kendi sırasında ${x.focus.hiddenOnMyTurn} kez sekmeden çıktı (toplam ${Math.round(x.focus.hiddenMsOnMyTurn / 1000)} sn)`);

  // S_link: aynı cihazı paylaşan hesaplar, özellikle kısıtlanmış olanlar.
  const link = clip(x.link.sharedAccounts / 3 + x.link.restrictedShared);
  if (x.link.sharedAccounts > 0) reasons.push(`aynı cihazı kullanan ${x.link.sharedAccounts} başka hesap${x.link.restrictedShared ? ` (${x.link.restrictedShared} kısıtlı)` : ''}`);

  // S_behav: yeni hesap → hemen ücretli turnuva örüntüsü.
  const age = x.behav.accountAgeHours;
  const behav = clip((age < 24 ? 1 : age < 24 * 7 ? 0.5 : 0) * (x.behav.paidEntries <= 3 ? 1 : 0.5));
  if (behav > 0) reasons.push(`hesap yaşı ${age < 48 ? `${Math.round(age)} saat` : `${Math.round(age / 24)} gün`}, ${x.behav.paidEntries}. ücretli turnuva`);

  // S_collusion: ani teslim, aynı rakiple tekrar eden eşleşme.
  const collusion = clip((x.collusion.shortResign ? 0.7 : 0) + clip((x.collusion.repeatPairings - 1) / 4) * 0.6);
  if (x.collusion.shortResign) reasons.push('oyun 10 yarım hamle dolmadan teslimle bitti');
  if (x.collusion.repeatPairings > 1) reasons.push(`aynı rakiple son 7 günde ${x.collusion.repeatPairings} ücretli oyun`);

  const components = { engine, time, perf, focus, link, behav, collusion };
  const score = clip(Object.entries(components).reduce((sum, [k, v]) => sum + WEIGHTS[k as keyof typeof WEIGHTS] * v, 0));
  const rounded = Object.fromEntries(Object.entries(components).map(([k, v]) => [k, r3(v)])) as RiskResult['components'];
  return { score: r3(score), level: levelOf(r3(score)), components: rounded, reasons };
}
