/* Position AFFICHEE du marcheur (phase 4, apres le test terrain de Pornic du
 * 2026-09-07 et la simulation "banc de guidage").
 *
 * Le GPS donne une position par seconde, bruitee, parfois figee ou biaisee
 * au demarrage. Afficher chaque position telle quelle donne un point qui
 * saute, glisser vers elle donne un point en retard d'une seconde. Ici,
 * comme dans Plans ou Maps :
 *  1. PREDICTION : entre deux positions, le point avance avec la vitesse et
 *     la route connues (cap GPS en marche, sinon route de la trace) ;
 *  2. CORRECTION : une position GPS ne remplace pas le point, elle devient
 *     un ecart a absorber en douceur (63 % en TAU_CORRECTION_S) ;
 *  3. RECALAGE : tant que la precision annoncee est mauvaise (> PRECISION_FIABLE_M,
 *     seuil lu sur la trace de Pornic : 10 a 14 m au demarrage a froid, 4 m
 *     ensuite) et que la position reste compatible avec la trace, la cible
 *     est le point de la trace, pas la position brute ; des que le GPS est
 *     bon, ou que la position n'est plus compatible, la cible est la verite
 *     GPS. Le point gris de ce matin mentait toujours, le point brut disait
 *     une verite fausse pendant 30 s : ceci est le milieu.
 *  4. ARRET : sans position depuis SANS_GPS_S, la vitesse s'eteint.
 *  7. AIMANT (aimant.js, 2026-09-08) : quand un aimant est fourni, la cible
 *     n'est plus la position brute mais sa projection sur le trottoir le plus
 *     proche du reseau. Le point est alors DANS la rue, du bon cote, et la
 *     carte s'oriente sur l'axe du trottoir plutot que sur un cap GPS qui
 *     tremble. Affichage seulement : le suivi et la detection d'ecart
 *     continuent de travailler sur la position brute.
 *  6. GPS FIGE (trace de Pornic du 2026-09-08) : au demarrage, l'iPhone
 *     rejoue pendant 10 a 15 s la position qu'il avait en memoire, a
 *     l'identique. Le podometre, lui, comptait deja 19 pas. Une position
 *     repetee n'est donc pas une observation : on la laisse passer sans
 *     correction, et le point avance a l'estime (podometre + cap).
 *  5. PODOMETRE (podometre.js, 2026-09-07 soir) : quand il est la, c'est lui qui
 *     dit si l'on marche. A l'arret, la vitesse tombe en FREINAGE_PAS_MS2 ; en
 *     marche sans vitesse GPS fiable, vitesse = cadence x longueur de pas, la
 *     longueur de pas etant calibree sur le GPS des qu'il est bon.
 *
 * Tout est en metres dans un repere local (equirectangulaire autour du
 * premier point : largement suffisant a l'echelle d'une marche), sans DOM ni
 * carte : testable en Node (test_position_affichee.mjs). */
import { pointA, capA } from "./source_position.js";

export const TAU_CORRECTION_S = 0.45;
export const PRECISION_FIABLE_M = 8;
export const SANS_GPS_S = 2.5;
export const FREINAGE_MS2 = 0.8;
export const VITESSE_CAP_GPS = 0.7;   // m/s : en dessous, le cap GPS n'est pas fiable
export const GAIN_MIN = 0.3;          // part minimale d'une position GPS absorbee (voir fix)
export const LONGUEUR_PAS_M = 0.72;   // longueur de pas par defaut, calibree ensuite sur le GPS
export const FREINAGE_PAS_MS2 = 4;    // arret vu par le podometre : la vitesse tombe en ~0,3 s
export const VITESSE_CORRECTION_MAX = 4;   // m/s : une correction ne deplace jamais le point plus vite (un saut de trottoir s'etale au lieu de sauter)
export const PODO_FRAIS_S = 1.5;      // au-dela, l'etat du podometre est perime
export const FIGE_M = 0.05;           // position identique a la precedente : le GPS rejoue sa memoire
export const CLE_PAS = "ombra.longueur_pas";   // longueur de pas retenue d'une balade a l'autre

const R_TERRE = 6371008.8;
const ecartCap = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };

export class PositionAffichee {
  /** trace : prepareTrace() (peut changer : recale(trace)) ; facteurTemps : rejeu accelere (les positions arrivent
   *  facteurTemps fois plus vite que le temps simule). */
  constructor(trace, { facteurTemps = 1 } = {}) {
    this.trace = trace; this.facteur = facteurTemps;
    this.origine = null;              // [lon, lat] du repere local
    this.p = null;                    // position affichee (m)
    this.v = 0; this.cap = null;      // vitesse (m/s, temps simule) et route (deg)
    this.err = { x: 0, y: 0 };        // correction restante
    this.tFix = null;                 // temps (s, horloge d'affichage) de la derniere position
    this.recale = false;              // la cible courante est-elle un point de la trace ?
    this.derniereFix = null;
    this.podo = null; this.figeDepuis = 0; this.aimant = null; this.aimante = null;
    // Longueur de pas de la derniere balade (0,82 m mesure chez Jean-Philippe
    // le 2026-09-08, contre 0,72 par defaut) : le calibrage repart de la.
    let l = null;
    try { l = parseFloat(localStorage.getItem(CLE_PAS)); } catch {}
    this.longueurPas = (l >= 0.5 && l <= 1.0) ? l : LONGUEUR_PAS_M;
  }

  /** Aimant de reseau (aimant.js), ou null pour afficher la position brute. */
  poseAimant(aimant) { this.aimant = aimant; }

  /** Etat du podometre { enMarche, cadence (pas/s) } a l'instant t (horloge d'affichage). */
  podometre(etat, t) { this.podo = { ...etat, t }; }

  /* --- repere local --- */
  _versM([lon, lat]) {
    if (!this.origine) this.origine = [lon, lat];
    const kLat = R_TERRE * Math.PI / 180, kLon = kLat * Math.cos(this.origine[1] * Math.PI / 180);
    return { x: (lon - this.origine[0]) * kLon, y: (lat - this.origine[1]) * kLat };
  }
  _versWgs({ x, y }) {
    const kLat = R_TERRE * Math.PI / 180, kLon = kLat * Math.cos(this.origine[1] * Math.PI / 180);
    return [this.origine[0] + x / kLon, this.origine[1] + y / kLat];
  }

  /** Position affichee [lon, lat], ou null avant la premiere position. */
  get lonLat() { return this.p ? this._versWgs(this.p) : null; }

  /** Nouvelle trace (recalcul) : rien ne saute, la cible suivante fera le reste. */
  recaleSur(trace) { this.trace = trace; }

  /** Une position GPS. pos : { lon, lat, precision_m, cap, vitesse } ; suivi : sortie de
   *  SuiviProgression.maj (s, ecart_m, confiance) ; t : horloge d'affichage en secondes. */
  fix(pos, suivi, t) {
    const brut = this._versM([pos.lon, pos.lat]);
    const precision = pos.precision_m ?? 10;
    // Recalage sur la trace : GPS mediocre ET position compatible avec la trace.
    // Position figee : le GPS repete sa memoire, ce n'est pas une observation.
    // On garde le cap et la vitesse, mais aucune correction ne tire le point.
    if (this.derniereFix && Math.hypot(brut.x - this.derniereFix.x, brut.y - this.derniereFix.y) < FIGE_M) {
      // Ni tFix ni derniereFix : sans nouvelle observation, l'arret automatique
      // (SANS_GPS_S) reprend la main quand il n'y a pas de podometre.
      this.figeDepuis = (this.figeDepuis || 0) + 1;
      return;
    }
    this.figeDepuis = 0;
    // Cible, par ordre de preference : le trottoir le plus proche (aimant),
    // sinon la trace quand le GPS est mediocre mais compatible, sinon le brut.
    this.aimante = this.aimant ? this.aimant.projette(pos) : null;
    const compatible = suivi && (suivi.ecart_m ?? Infinity) <= Math.max(12, 1.2 * precision) && (suivi.confiance ?? 0) > 0.5;
    this.recale = !!this.aimante || (precision > PRECISION_FIABLE_M && compatible);
    const cible = this.aimante ? this._versM([this.aimante.lon, this.aimante.lat])
                : (this.recale ? this._versM(pointA(this.trace, suivi.s)) : brut);
    if (!this.p) { this.p = { ...cible }; this.err = { x: 0, y: 0 }; }
    else {
      // Gain de correction : une position precise tire fort, une position
      // mediocre tire peu (le bruit se moyenne au lieu d'agiter le point).
      // sigma de prediction 3 m contre la precision annoncee ; plancher 0,3.
      const g = this.recale ? 1 : Math.max(GAIN_MIN, 9 / (9 + precision * precision));
      this.err = { x: (cible.x - this.p.x) * g, y: (cible.y - this.p.y) * g };
    }
    // Vitesse et route.
    const v = pos.vitesse;
    if (typeof v === "number" && !Number.isNaN(v)) this.v = Math.max(0, v);
    else if (this.derniereFix && t > this.derniereFix.t) this.v = Math.min(3, Math.hypot(brut.x - this.derniereFix.x, brut.y - this.derniereFix.y) / ((t - this.derniereFix.t) * this.facteur));
    // Calibrage de la longueur de pas : vitesse GPS fiable et cadence connue.
    if (this.podo && this.podo.enMarche && this.podo.cadence > 1 && this.v >= 0.7) {
      this.longueurPas += 0.1 * (Math.max(0.5, Math.min(1.0, this.v / this.podo.cadence)) - this.longueurPas);
      try { localStorage.setItem(CLE_PAS, this.longueurPas.toFixed(3)); } catch {}
    }
    const capGps = (typeof pos.cap === "number" && !Number.isNaN(pos.cap) && this.v >= VITESSE_CAP_GPS) ? pos.cap : null;
    // L'axe du trottoir aimante est plus stable qu'un cap GPS : il oriente la carte.
    const capCible = (this.aimante && this.v >= VITESSE_CAP_GPS ? this.aimante.cap : null)
                   ?? capGps ?? (this.recale && suivi ? capA(this.trace, suivi.s) : null);
    if (capCible !== null) this.cap = this.cap === null ? capCible : this.cap + ecartCap(this.cap, capCible) * 0.6;
    this.tFix = t; this.derniereFix = { ...brut, t };
  }

  /** Une image d'affichage : dt en secondes d'horloge d'affichage. Retourne la position (m). */
  image(dt, t) {
    if (!this.p) return null;
    const dts = dt * this.facteur;                        // temps simule
    // Un podometre frais fait autorite sur "marche ou pas" : sans lui, l'absence
    // de position depuis SANS_GPS_S eteint la vitesse.
    const podoFrais = this.podo && t - this.podo.t <= PODO_FRAIS_S;
    if (!(podoFrais && this.podo.enMarche) && this.tFix !== null && (t - this.tFix) * this.facteur > SANS_GPS_S) this.v = Math.max(0, this.v - FREINAGE_MS2 * dts);
    // Podometre : l'arret et la reprise se voient au pas pres, bien avant le GPS.
    if (podoFrais) {
      if (!this.podo.enMarche) this.v = Math.max(0, this.v - FREINAGE_PAS_MS2 * dts);
      else if (this.podo.cadence > 0) {
        const vPas = this.podo.cadence * this.longueurPas;
        const gpsFiable = this.tFix !== null && (t - this.tFix) * this.facteur <= SANS_GPS_S && this.v >= 0.5;
        if (!gpsFiable) this.v += (vPas - this.v) * Math.min(1, dts * 3);
      }
    }
    if (this.cap !== null && this.v > 0) { const rad = this.cap * Math.PI / 180; this.p.x += this.v * dts * Math.sin(rad); this.p.y += this.v * dts * Math.cos(rad); }
    const k = 1 - Math.exp(-dts / TAU_CORRECTION_S);
    let cx = this.err.x * k, cy = this.err.y * k;
    // Plafond de vitesse de correction : un changement de trottoir se rattrape
    // en glissant, jamais en sautant (mesure du 2026-09-08 : sans plafond, une
    // image pouvait deplacer le point d'un metre).
    const norme = Math.hypot(cx, cy), max = VITESSE_CORRECTION_MAX * dts;
    if (norme > max && norme > 0) { const f = max / norme; cx *= f; cy *= f; }
    this.p.x += cx; this.p.y += cy; this.err.x -= cx; this.err.y -= cy;
    return this.p;
  }
}
