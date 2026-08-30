/* Source de position : GPS reel ou trace simulee (phase 4, palier 1).
 *
 * Toute la couche de navigation consomme UNE seule interface, pour qu'elle ne
 * sache jamais si elle est en simulation ou sur le terrain :
 *
 *     const src = new SourceSimulee({...}) | new SourceGPS();
 *     src.demarrer((pos) => { ... });   // pos = { lon, lat, precision_m, t }
 *     src.arreter();
 *
 * Pourquoi un simulateur AVANT la fonctionnalite : le perimetre du modele est
 * le Marais et le developpement ne s'y fait pas a pied. Sans rejeu, aucun
 * palier de la phase 4 ne serait verifiable. Le simulateur n'est donc pas un
 * confort, c'est l'outil de test de toute la phase.
 *
 * Deterministe : a graine egale et parametres egaux, la suite de positions est
 * identique. C'est ce qui rend les seuils de detection d'ecart calibrables.
 */

import { wgs84VersL93 } from "../moteur.js";

/* --- Generateur pseudo-aleatoire a graine (mulberry32) ---------------------
 * Math.random n'est pas reproductible : un test de detection d'ecart qui passe
 * une fois sur deux ne vaut rien. */
export function alea(graine) {
  let a = graine >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tirage gaussien centre reduit (Box-Muller), a partir d'un alea() donne. */
export function gaussienne(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const R_TERRE = 6378137;
const degParMetreLat = 1 / (R_TERRE * Math.PI / 180);
const degParMetreLon = (lat) => degParMetreLat / Math.cos((lat * Math.PI) / 180);

/** Polyligne + abscisses curvilignes en metres (longueurs calculees en
 *  Lambert-93, comme le moteur : memes distances, aucune divergence). */
export function prepareTrace(points) {
  if (!points || points.length < 2) throw new Error("trace : au moins 2 points");
  const l93 = points.map(([lon, lat]) => wgs84VersL93(lon, lat));
  const cumul = [0];
  for (let i = 1; i < l93.length; i++) {
    const dx = l93[i][0] - l93[i - 1][0], dy = l93[i][1] - l93[i - 1][1];
    cumul.push(cumul[i - 1] + Math.hypot(dx, dy));
  }
  return { points, cumul, longueur: cumul[cumul.length - 1] };
}

/** Position WGS84 a l'abscisse s (metres) le long de la trace preparee. */
export function pointA(trace, s) {
  const { points, cumul } = trace;
  if (s <= 0) return points[0].slice();
  if (s >= cumul[cumul.length - 1]) return points[points.length - 1].slice();
  let i = 1;
  while (i < cumul.length - 1 && cumul[i] < s) i++;
  const seg = cumul[i] - cumul[i - 1];
  const r = seg > 0 ? (s - cumul[i - 1]) / seg : 0;
  const [x1, y1] = points[i - 1], [x2, y2] = points[i];
  return [x1 + (x2 - x1) * r, y1 + (y2 - y1) * r];
}

/** Cap (degres, 0 = nord, sens horaire) de la trace a l'abscisse s. */
export function capA(trace, s) {
  const eps = 1.0;
  const a = pointA(trace, Math.max(0, s - eps));
  const b = pointA(trace, Math.min(trace.longueur, s + eps));
  const lat = (a[1] + b[1]) / 2;
  const dx = (b[0] - a[0]) * Math.cos((lat * Math.PI) / 180);
  const dy = b[1] - a[1];
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** Source reelle : navigator.geolocation. */
export class SourceGPS {
  constructor({ hauteAcuite = true } = {}) { this.hauteAcuite = hauteAcuite; this.id = null; }
  demarrer(surPosition, surErreur) {
    if (!navigator.geolocation) { surErreur?.(new Error("geolocalisation indisponible")); return; }
    this.id = navigator.geolocation.watchPosition(
      (p) => surPosition({ lon: p.coords.longitude, lat: p.coords.latitude,
                           precision_m: p.coords.accuracy ?? null, t: p.timestamp }),
      (e) => surErreur?.(e),
      { enableHighAccuracy: this.hauteAcuite, maximumAge: 0, timeout: 15000 },
    );
  }
  arreter() { if (this.id !== null) { navigator.geolocation.clearWatch(this.id); this.id = null; } }
}

/** Source simulee : rejoue une marche le long d'une trace.
 *
 *  points        trace a suivre, [[lon,lat], ...] (typiquement les troncons
 *                concatenes d'un itineraire calcule)
 *  vitesse_ms    vitesse de marche, defaut 1,3 m/s
 *  pas_ms        intervalle d'emission simule, defaut 1000 ms
 *  bruit_m       ecart-type du bruit gaussien en metres (0, 5, 15, 30...)
 *  graine        graine du generateur : meme graine = meme trace bruitee
 *  facteurTemps  acceleration du rejeu en temps reel (20 = 20x plus vite).
 *                N'affecte PAS les positions produites, seulement la cadence.
 *  ecarts        [{ a_m, longueur_m, cap_relatif_deg }] : a l'abscisse a_m, le
 *                marcheur quitte la trace sur longueur_m dans une direction
 *                tournee de cap_relatif_deg, puis revient sur ses pas et
 *                reprend. Sert a tester la detection d'ecart ET le retour.
 */
export class SourceSimulee {
  constructor({ points, vitesse_ms = 1.3, pas_ms = 1000, bruit_m = 0, graine = 1,
                facteurTemps = 1, ecarts = [] } = {}) {
    this.trace = prepareTrace(points);
    this.vitesse_ms = vitesse_ms;
    this.pas_ms = pas_ms;
    this.bruit_m = bruit_m;
    this.graine = graine;
    this.facteurTemps = facteurTemps;
    this.ecarts = [...ecarts].sort((a, b) => a.a_m - b.a_m);
    this.minuteur = null;
  }

  /** Longueur totale reellement parcourue, ecarts (aller-retour) compris. */
  get longueurParcours() {
    return this.trace.longueur + this.ecarts.reduce((s, e) => s + 2 * e.longueur_m, 0);
  }

  /** Position "vraie" (sans bruit) apres avoir marche `parcouru` metres.
   *  Retourne { lon, lat, s, hors_trace } - s = abscisse sur la trace. */
  positionVraie(parcouru) {
    let restant = parcouru;      // metres de marche restant a placer
    let sFait = 0;               // abscisse de trace deja consommee
    for (const e of this.ecarts) {
      const routeAvant = e.a_m - sFait;          // trace a parcourir avant l'ecart
      if (restant < routeAvant) break;           // on n'a pas encore atteint l'ecart
      restant -= routeAvant;
      sFait = e.a_m;
      const detour = 2 * e.longueur_m;           // aller puis retour
      if (restant < detour) {
        const d = restant <= e.longueur_m ? restant : detour - restant;
        const base = pointA(this.trace, e.a_m);
        const cap = capA(this.trace, e.a_m) + (e.cap_relatif_deg ?? 90);
        const rad = (cap * Math.PI) / 180;
        return {
          lon: base[0] + d * Math.sin(rad) * degParMetreLon(base[1]),
          lat: base[1] + d * Math.cos(rad) * degParMetreLat,
          s: e.a_m, hors_trace: true, ecart_m: d,
        };
      }
      restant -= detour;
    }
    const s = Math.min(sFait + restant, this.trace.longueur);
    const [lon, lat] = pointA(this.trace, s);
    return { lon, lat, s, hors_trace: false, ecart_m: 0 };
  }

  /** Suite complete des positions emises, sans horloge : c'est ce que les
   *  tests consomment. Le rejeu temps reel (`demarrer`) rejoue exactement
   *  cette meme suite. */
  positions() {
    const rnd = alea(this.graine);
    const total = this.longueurParcours;
    const pasM = this.vitesse_ms * (this.pas_ms / 1000);
    const sortie = [];
    for (let k = 0, parcouru = 0; parcouru <= total + 1e-9; k++, parcouru = k * pasM) {
      const v = this.positionVraie(parcouru);
      let lon = v.lon, lat = v.lat;
      if (this.bruit_m > 0) {
        lon += gaussienne(rnd) * this.bruit_m * degParMetreLon(lat);
        lat += gaussienne(rnd) * this.bruit_m * degParMetreLat;
      }
      sortie.push({
        lon, lat,
        precision_m: this.bruit_m > 0 ? Math.round(this.bruit_m * 1.5) : 5,
        t: k * this.pas_ms,
        _vrai: v,                          // reference, pour les tests uniquement
      });
    }
    return sortie;
  }

  demarrer(surPosition) {
    const suite = this.positions();
    let i = 0;
    const cadence = Math.max(1, this.pas_ms / this.facteurTemps);
    this.minuteur = setInterval(() => {
      if (i >= suite.length) { this.arreter(); return; }
      const p = suite[i++];
      surPosition({ lon: p.lon, lat: p.lat, precision_m: p.precision_m, t: p.t });
    }, cadence);
  }

  arreter() { if (this.minuteur !== null) { clearInterval(this.minuteur); this.minuteur = null; } }
}
