/**
 * Glicko-2 (Mark Glickman, "Example of the Glicko-2 system", 2013).
 * Saf fonksiyon; her oyun sonrası tek sonuçlu bir "dönem" olarak çağrılır
 * (çevrimiçi platformlarda yaygın uygulama).
 */
export interface Glicko {
  rating: number;
  rd: number;
  vol: number;
}

export interface Outcome {
  opponent: { rating: number; rd: number };
  /** 1 galibiyet, 0.5 beraberlik, 0 yenilgi */
  score: number;
}

export const DEFAULT_RATING: Glicko = { rating: 1500, rd: 350, vol: 0.06 };
export const SCALE = 173.7178;
/** RD sınırları: çok küçük RD rating'i dondurur, çok büyük anlamsızdır. */
export const RD_MIN = 45;
export const RD_MAX = 350;

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number): number => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

export function update(player: Glicko, outcomes: readonly Outcome[], tau = 0.5, clampRd = true): Glicko {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;

  if (outcomes.length === 0) {
    const rd = Math.sqrt(phi * phi + sigma * sigma) * SCALE;
    return { rating: player.rating, rd: clampRd ? Math.min(RD_MAX, rd) : rd, vol: sigma };
  }

  let vInv = 0;
  let deltaSum = 0;
  for (const o of outcomes) {
    const muJ = (o.opponent.rating - 1500) / SCALE;
    const phiJ = o.opponent.rd / SCALE;
    const gj = g(phiJ);
    const e = expected(mu, muJ, phiJ);
    vInv += gj * gj * e * (1 - e);
    deltaSum += gj * (o.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Oynaklık (volatilite): Illinois yöntemiyle kök bulma.
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  const EPS = 1e-6;
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  let guard = 0;
  while (Math.abs(B - A) > EPS && guard++ < 1000) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * deltaSum;

  const rd = newPhi * SCALE;
  return {
    rating: newMu * SCALE + 1500,
    rd: clampRd ? Math.min(RD_MAX, Math.max(RD_MIN, rd)) : rd,
    vol: newSigma,
  };
}
