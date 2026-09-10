/* Aimantation de la position sur le reseau de trottoirs (phase 4, demande de
 * Jean-Philippe apres le test terrain du 2026-09-08 : "le point est parfois en
 * dehors de la rue, il faut peut-etre une position aimantee qui me positionne
 * dans la rue, voire sur le bon cote du trottoir si la rue est large").
 *
 * Mesure sur ses trois traces reelles (298 points) : la position GPS brute est
 * a 0,7 a 1,1 m du trottoir le plus proche (mediane) et JAMAIS a plus de 4 m
 * d'un trottoir ; mais elle est a 3,6 a 16 m de la TRACE de l'itineraire,
 * parce qu'il marche sur l'autre cote de la rue. Aimanter sur le RESEAU, pas
 * sur l'itineraire : c'est la verite du terrain, et le bon cote vient tout
 * seul puisque les trottoirs sont modelises cote par cote.
 *
 * Le SUIVI DE PROGRESSION continue de travailler sur la position brute :
 * aimanter l'avancement sur la trace reviendrait a se cacher ses propres
 * erreurs. La DETECTION D'ECART, elle, recoit la rue aimantee depuis le
 * 2026-09-08 : l'aimant colle au RESEAU, pas a l'itineraire, donc il ne masque
 * rien, il dit dans quelle rue on marche vraiment. C'est meme le signal le
 * plus direct dont on dispose, celui que l'utilisateur voit a l'ecran (voir
 * AIMANT_SUR_M dans ecart.js).
 *
 * Trois gardes contre le saut d'un trottoir a l'autre :
 *  - rayon limite, proportionne a la precision annoncee ;
 *  - le trottoir doit etre oriente comme la marche (a 50 degres pres, dans un
 *    sens ou dans l'autre) des qu'on avance vraiment ;
 *  - hysteresis : le trottoir retenu la fois precedente part avec une avance,
 *    donnee au couple (rue, cote) et non au segment, puisqu'on change de
 *    segment tous les 10 m en marchant ; plus une prime a la continuite, qui
 *    penalise un candidat loin du point aimante d'il y a une seconde.
 */
import { wgs84VersL93 } from "../moteur.js";   // pas de conversion inverse : on interpole sur la geometrie WGS84 du meme troncon

export const RAYON_MIN_M = 12;      // rayon de recherche minimal...
export const RAYON_FACTEUR = 2;     // ...sinon 2 x la precision annoncee...
export const RAYON_MAX_M = 25;      // ...et jamais plus que ca
export const CAP_TOLERANCE_DEG = 50;
export const CAP_VITESSE_MIN = 0.7; // m/s : en dessous, le cap n'est pas fiable, on ne filtre pas
export const CAP_PRECISION_MAX_M = 12; // ...ni au-dessus de ce bruit annonce : mesure du 2026-09-08 (trace 6 de Pornic), a 15 m de precision le cap GPS a exclu pendant 25 s le trottoir REELLEMENT sous les pieds (a 0,3 m) au profit de celui d'a cote (a 5,8 m)
// L'HYSTERESIS EST UNE DUREE, PLUS UNE AVANCE. Une avance fixe de 4 m ne
// s'eteint jamais : mesure du 2026-09-08 (trace 6 de Pornic), elle a retenu
// la Rue Georges Clemenceau pendant 27 s a 4 - 11,6 m du marcheur alors que
// le trottoir reellement le plus proche etait a 0,3 - 3 m ("la trace s'est
// aimantee sur le mauvais parcours"). La remplacer par un simple plafond de
// distance fait trembler (6 -> 13 changements de trottoir sur la meme trace).
// On garde donc le trottoir courant tant qu'un autre ne fait pas MIEUX de
// BASCULE_M pendant BASCULE_S d'affilee : stable devant le bruit d'une
// seconde, et jamais bloque plus de deux secondes sur un trottoir depasse.
export const BASCULE_M = 2;         // avantage minimal d'un autre trottoir pour pretendre a la place
export const BASCULE_S = 2;         // ...qu'il doit tenir pendant ce temps...
export const BASCULE_FORTE_M = 8;   // ...sauf s'il est meilleur de tant : on bascule tout de suite
export const CONTINUITE = 0.25;     // penalite par metre d'ecart au point aimante precedent
export const CONTINUITE_S = 3;      // au-dela, le point precedent est trop vieux pour compter
export const CASE_M = 50, MARGE_M = 250;

const ecartCap = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };
/** Ecart d'orientation entre un cap et un AXE (le trottoir se parcourt dans les deux sens) : 0 a 90. */
const ecartAxe = (cap, axe) => { const d = Math.abs(ecartCap(cap, axe)); return Math.min(d, 180 - d); };

export class Aimant {
  /** moteur : segments charges ; trace : prepareTrace() (delimite la zone indexee). */
  constructor(moteur, trace) { this.moteur = moteur; this.dernier = null; this._defi = null; this.premiere = null; this.bouge = false; this.recaleSur(trace); }

  /** Oublie le trottoir courant (depart, recalcul) : l'hysteresis repart de zero. */
  oublie() { this.dernier = null; this._defi = null; }

  /** Nouvelle trace (recalcul) : on reindexe la zone utile. */
  recaleSur(trace) {
    const l93 = trace.points.map(([lon, lat]) => wgs84VersL93(lon, lat));
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const [x, y] of l93) { xMin = Math.min(xMin, x); yMin = Math.min(yMin, y); xMax = Math.max(xMax, x); yMax = Math.max(yMax, y); }
    this.grille = new Map();
    for (const s of this.moteur.segments.values()) {
      const g = s.geomL93, [x, y] = g[Math.floor(g.length / 2)];
      if (x < xMin - MARGE_M || x > xMax + MARGE_M || y < yMin - MARGE_M || y > yMax + MARGE_M) continue;
      for (const [px, py] of [g[0], g[g.length - 1], [x, y]]) {
        const k = `${Math.floor(px / CASE_M)}_${Math.floor(py / CASE_M)}`;
        if (!this.grille.has(k)) this.grille.set(k, new Set());
        this.grille.get(k).add(s);
      }
    }
  }

  /** pos : { lon, lat, precision_m, cap, vitesse }.
   *  Retourne { lon, lat, d, rue, cote, i, cap } (cap = axe du trottoir dans le sens
   *  de marche), ou null si aucun trottoir plausible. */
  projette(pos) {
    // POSITION MEMORISEE AU REVEIL : au demarrage, l'iPhone rejoue 10 a 15 s
    // durant la derniere position qu'il connaissait, a l'identique. L'aimanter
    // donne un point NET et FAUX, colle a 2,4 m d'un trottoir d'une autre rue
    // que celle du depart (trace 6 de Pornic, 2026-09-08 : "la trace s'est
    // aimantee sur le mauvais parcours au debut"). Tant que l'appareil n'a pas
    // livre une position distincte de la premiere, on n'aimante pas : mieux
    // vaut un point flou qu'un point net au mauvais endroit.
    if (!this.bouge) {
      if (this.premiere === null) this.premiere = [pos.lon, pos.lat];
      else if (Math.abs(pos.lon - this.premiere[0]) > 1e-9 || Math.abs(pos.lat - this.premiere[1]) > 1e-9) this.bouge = true;
      if (!this.bouge) return null;
    }
    const [x, y] = wgs84VersL93(pos.lon, pos.lat);
    const rayon = Math.min(RAYON_MAX_M, Math.max(RAYON_MIN_M, RAYON_FACTEUR * (pos.precision_m ?? 10)));
    const capFiable = (pos.vitesse ?? 0) >= CAP_VITESSE_MIN && typeof pos.cap === "number" && !Number.isNaN(pos.cap)
      && (pos.precision_m ?? 10) <= CAP_PRECISION_MAX_M;
    const cases = new Set();
    const n = Math.ceil(rayon / CASE_M);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) cases.add(`${Math.floor(x / CASE_M) + i}_${Math.floor(y / CASE_M) + j}`);
    const p0 = this.dernier && (pos.t == null || this.dernier.t == null || pos.t - this.dernier.t <= CONTINUITE_S * 1000) ? this.dernier : null;
    let meilleur = null, courant = null;   // meilleur toutes rues confondues ; meilleur sur le trottoir deja retenu
    for (const k of cases) {
      const lot = this.grille.get(k); if (!lot) continue;
      for (const s of lot) {
        const g = s.geomL93;
        for (let p = 1; p < g.length; p++) {
          const ax = g[p - 1][0], ay = g[p - 1][1], dx = g[p][0] - ax, dy = g[p][1] - ay;
          const l2 = dx * dx + dy * dy; if (l2 === 0) continue;
          let t = ((x - ax) * dx + (y - ay) * dy) / l2; t = Math.max(0, Math.min(1, t));
          const px = ax + t * dx, py = ay + t * dy;
          const d = Math.hypot(x - px, y - py);
          if (d > rayon) continue;
          const axe = (Math.atan2(dx, dy) * 180) / Math.PI;
          if (capFiable && ecartAxe(pos.cap, axe) > CAP_TOLERANCE_DEG) continue;
          // Score SANS avance d'hysteresis : distance, plus une penalite pour
          // l'ecart au point aimante d'il y a une seconde (continuite).
          const score = d + (p0 ? CONTINUITE * Math.hypot(px - p0.x, py - p0.y) : 0);
          // Cap du trottoir dans le sens de marche : des deux sens, celui qui colle au cap mesure.
          const capSeg = capFiable && Math.abs(ecartCap(pos.cap, axe)) > 90 ? (axe + 180) % 360 : (axe + 360) % 360;
          const cand = { score, d, i: s.i, rue: s.rue || null, cote: s.cote || null, seg: s, p, t, cap: capSeg, x: px, y: py };
          if (!meilleur || score < meilleur.score) meilleur = cand;
          if (p0 && p0.rue === (s.rue || null) && p0.cote === (s.cote || null) && (!courant || score < courant.score)) courant = cand;
        }
      }
    }
    // Arbitrage : le trottoir courant garde sa place tant que le pretendant
    // n'a pas fait mieux de BASCULE_M pendant BASCULE_S (ou BASCULE_FORTE_M
    // tout de suite).
    if (courant && meilleur && (meilleur.rue !== courant.rue || meilleur.cote !== courant.cote)) {
      // Avantage mesure sur la DISTANCE seule : la prime de continuite sert a
      // departager deux troncons du meme trottoir, pas a proteger un trottoir
      // depasse (elle penalise mecaniquement tout candidat d'une autre rue).
      const avantage = courant.d - meilleur.d;
      const cle = `${meilleur.rue}|${meilleur.cote}`;
      if (avantage >= BASCULE_FORTE_M) this._defi = null;
      else if (avantage >= BASCULE_M) {
        if (!this._defi || this._defi.cle !== cle) this._defi = { cle, t: pos.t ?? 0 };
        if (((pos.t ?? 0) - this._defi.t) / 1000 < BASCULE_S) meilleur = courant;
        else this._defi = null;
      } else { this._defi = null; meilleur = courant; }
    } else this._defi = null;
    if (!meilleur) { this.dernier = null; return null; }
    this.dernier = { i: meilleur.i, rue: meilleur.rue, cote: meilleur.cote, x: meilleur.x, y: meilleur.y, t: pos.t ?? null };
    // Meme troncon, meme parametre : la projection revient en WGS84 sans conversion inverse.
    const g = meilleur.seg.geom, a = g[meilleur.p - 1], b = g[meilleur.p];
    return { lon: a[0] + meilleur.t * (b[0] - a[0]), lat: a[1] + meilleur.t * (b[1] - a[1]),
             d: meilleur.d, rue: meilleur.rue, cote: meilleur.cote, i: meilleur.i, cap: meilleur.cap };
  }
}
