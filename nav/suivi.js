/* Suivi de progression le long d'un itineraire (phase 4, palier 2).
 *
 * PRINCIPE. On ne cherche pas "le point le plus proche de la trace" a chaque
 * position recue : ce calcul sans memoire saute d'un trottoir a l'autre et
 * repart en arriere des que le GPS bruite, puisque les deux cotes d'une rue du
 * Marais sont a 10-15 m l'un de l'autre, soit la precision du GPS lui-meme.
 *
 * On suit un ETAT : une abscisse curviligne ("je suis au metre 412 du trajet")
 * et une vitesse estimee. A chaque position :
 *   1. PREDICTION      s_pred = s + v * dt          (le marcheur a avance)
 *   2. OBSERVATION     projection sur la trace, cherchee UNIQUEMENT dans une
 *                      fenetre autour de s_pred (jamais sur toute la trace)
 *   3. CORRECTION      s = s_pred + K * (s_obs - s_pred), K faible
 * La prediction porte le signal, l'observation le recale. Le bruit, symetrique
 * autour de la position vraie, s'annule dans la correction au lieu de faire
 * sauter l'estimation.
 *
 * La progression est monotone par construction : s ne redescend jamais sous sa
 * valeur precedente. C'est ce qui permettra au palier 4 de distinguer un vrai
 * ecart d'un point GPS aberrant.
 */

import { wgs84VersL93 } from "../moteur.js";

const VITESSE_INIT = 1.3;      // m/s, marche normale
const VITESSE_MIN = 0.0;
const VITESSE_MAX = 2.6;       // au-dela, ce n'est plus de la marche
const K_POSITION = 0.25;       // poids de l'observation sur l'abscisse
const K_VITESSE = 0.05;        // poids de l'observation sur la vitesse
const SEUIL_ARRIVEE_M = 15;

/* Confiance accordee a l'observation, d'apres son eloignement de la trace,
 * rapporte a la precision ANNONCEE par le capteur.
 *
 * Sans ce garde-fou, l'estimation continue d'avancer par pure prediction
 * pendant que le marcheur s'eloigne : mesure du 2026-08-30, un ecart de 60 m
 * sur 120 m marches faisait progresser le suivi de 117 m le long d'un trajet
 * que personne ne parcourait. Etre loin de l'itineraire n'est pas une preuve
 * d'avancement sur cet itineraire.
 *
 * Les seuils suivent la precision : a 30 m de bruit, 60 m d'ecart est normal ;
 * a 0 m de bruit, c'est la preuve qu'on a quitte le chemin. */
function confianceObservation(ecart_m, precision_m) {
  const p = Math.max(3, precision_m ?? 10);
  const bon = 1.5 * p + 10;
  const mauvais = 4 * p + 25;
  if (ecart_m <= bon) return 1;
  if (ecart_m >= mauvais) return 0;
  return (mauvais - ecart_m) / (mauvais - bon);
}

export class SuiviProgression {
  /** trace : sortie de prepareTrace() ; fenetre_m : demi-largeur de recherche. */
  constructor(trace, { fenetre_m = 40, seuilArrivee_m = SEUIL_ARRIVEE_M } = {}) {
    this.trace = trace;
    this.fenetre_m = fenetre_m;
    this.seuilArrivee_m = seuilArrivee_m;
    this.l93 = trace.points.map(([lon, lat]) => wgs84VersL93(lon, lat));
    this.s = null;               // abscisse courante (m), null tant qu'aucun point
    this.v = VITESSE_INIT;
    this.t = null;
    this.arrive = false;
    this.confiance = 1;          // 1 = sur la trace, 0 = manifestement ailleurs
  }

  /** Projection sur la trace, restreinte a [sMin, sMax]. Retourne {s, ecart_m}. */
  _projete(px, py, sMin, sMax) {
    const { cumul } = this.trace;
    let meilleur = { s: sMin, ecart_m: Infinity };
    for (let i = 1; i < this.l93.length; i++) {
      if (cumul[i] < sMin || cumul[i - 1] > sMax) continue;   // hors fenetre
      const [x1, y1] = this.l93[i - 1], [x2, y2] = this.l93[i];
      const dx = x2 - x1, dy = y2 - y1;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2)) : 0;
      const ecart = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      if (ecart < meilleur.ecart_m) {
        const s = Math.min(sMax, Math.max(sMin, cumul[i - 1] + t * Math.sqrt(L2)));
        meilleur = { s, ecart_m: ecart };
      }
    }
    return meilleur;
  }

  /** Consomme une position { lon, lat, precision_m, t }.
   *  Retourne { s, avance_m, restant_m, ecart_m, vitesse_ms, arrive }. */
  maj(pos) {
    const [px, py] = wgs84VersL93(pos.lon, pos.lat);
    const L = this.trace.longueur;

    if (this.s === null) {
      // Premier point : recherche globale, seule fois ou l'on balaie tout.
      const p = this._projete(px, py, 0, L);
      this.s = p.s; this.t = pos.t;
      return this._sortie(p.ecart_m);
    }

    const dt = Math.max(0.001, (pos.t - this.t) / 1000);
    this.t = pos.t;

    // Fenetre elargie par l'incertitude annoncee : un point a +/- 30 m ne doit
    // pas etre cherche dans une fenetre de 40 m.
    const marge = this.fenetre_m + 2 * (pos.precision_m ?? 10);
    const sPredBrut = Math.min(L, this.s + this.v * dt);
    const p = this._projete(px, py, Math.max(0, sPredBrut - marge), Math.min(L, sPredBrut + marge));

    // La confiance module la PREDICTION : loin de la trace, on cesse d'avancer
    // a l'estime plutot que d'accumuler une progression imaginaire.
    const c = confianceObservation(p.ecart_m, pos.precision_m);
    this.confiance = c;
    const sPred = Math.min(L, this.s + this.v * dt * c);

    const innovation = p.s - sPred;
    const s = sPred + K_POSITION * c * innovation;
    if (c > 0) {
      this.v = Math.min(VITESSE_MAX, Math.max(VITESSE_MIN, this.v + (K_VITESSE * c * innovation) / dt));
    }
    this.s = Math.min(L, Math.max(this.s, s));      // monotone par construction
    if (L - this.s <= this.seuilArrivee_m) this.arrive = true;
    return this._sortie(p.ecart_m);
  }

  _sortie(ecart_m) {
    return {
      s: this.s,
      avance_m: this.s,
      restant_m: Math.max(0, this.trace.longueur - this.s),
      ecart_m,
      vitesse_ms: this.v,
      confiance: this.confiance,   // signal brut de la detection d'ecart (palier 4)
      arrive: this.arrive,
    };
  }
}
