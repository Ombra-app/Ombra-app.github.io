/* Cote de marche, trottoir d'en face et bande d'ombre a venir
 * (phase 4, palier 3, partie visuelle).
 *
 * Ce module repond a trois questions que l'indicateur de cote affiche sans
 * texte : de quel cote de la rue dois-je etre (gauche ou droite, dans le sens
 * de la marche), a quoi ressemblent les 150 m a venir des deux cotes (ombre,
 * soleil, inconnu), et l'instruction est-elle contre-intuitive (le cote
 * impose est nettement plus au soleil que l'autre), auquel cas il faut la
 * justifier : "cote soleil sur 80 m, traversee ensuite, puis 600 m a l'ombre".
 *
 * Choix actes le 2026-09-03 (BRIEF_PHASE4.md, palier 3) :
 *  - gauche/droite se calcule partout ou le cote boussole est connu : le
 *    cote boussole (nord/sud/est/ouest) est la direction dominante du vecteur
 *    axe de la rue -> trottoir (sidewalks.py, _boussole), et le cap de marche
 *    vient de la trace. Il suffit de savoir si ce vecteur est a gauche ou a
 *    droite du cap.
 *  - le trottoir d'en face est cherche par heuristique, sans changement de
 *    l'export : meme rue, autre cote, a moins de 25 m, et a peu pres parallele
 *    (la contrainte de parallelisme ecarte les appariements douteux sur les
 *    places, ou "l'autre cote" a 29 m est en fait une autre branche). Quand
 *    on ne sait pas, on le dit (connu: false), on ne pretend jamais.
 *  - contre-intuitif = sur les 50 m a venir, le trottoir suivi est plus au
 *    soleil que celui d'en face d'au moins 0,3 de fraction d'ombre.
 *
 * Ombre indeterminee (valeur 255 de l'export) : sous emprise batie, traitee
 * comme ombre par le moteur (contrat du manifeste). Ici elle est rendue
 * `null` pour l'affichage (bloc gris "couvert"), et comptee comme ombre dans
 * la justification, par coherence avec le moteur.
 *
 * Rien ici ne touche au moteur ni aux couts : lecture seule des segments et
 * des valeurs d'ombre deja chargees.
 */

import { wgs84VersL93 } from "../moteur.js";
import { pointA } from "./source_position.js";

export const VIS_A_VIS_MAX_M = 30;
export const HORIZON_BANDE_M = 150;
export const FENETRE_CONTRE_INTUITIF_M = 50;
export const SEUIL_CONTRE_INTUITIF = 0.3;
const PARALLELE_MAX_DEG = 35;
const SEUIL_OMBRE = 0.5;          // meme seuil que detaillerTrace (val >= 50 -> ombre)

const VECTEUR_BOUSSOLE = { nord: [0, 1], est: [1, 0], sud: [0, -1], ouest: [-1, 0] };

/* ---------------------------------------------------------------- geometrie */

function distancePointPolyligne(p, geomL93) {
  let m = Infinity;
  for (let i = 1; i < geomL93.length; i++) {
    const [x1, y1] = geomL93[i - 1], [x2, y2] = geomL93[i];
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - x1) * dx + (p[1] - y1) * dy) / L2)) : 0;
    m = Math.min(m, Math.hypot(p[0] - (x1 + t * dx), p[1] - (y1 + t * dy)));
  }
  return m;
}

function milieu(geomL93) {
  return geomL93[Math.floor(geomL93.length / 2)];
}

function directionSegment(geomL93) {
  const a = geomL93[0], b = geomL93[geomL93.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy);
  return n > 0 ? [dx / n, dy / n] : null;
}

/** Cap de marche a l'abscisse s, en L93, lisse sur +/- demi metres pour ne pas
 *  dependre d'un zigzag local de la geometrie exportee. */
export function directionMarche(trace, s, demi = 5) {
  const a = wgs84VersL93(...pointA(trace, Math.max(0, s - demi)));
  const b = wgs84VersL93(...pointA(trace, Math.min(trace.longueur, s + demi)));
  const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy);
  return n > 0 ? [dx / n, dy / n] : null;
}

/** "gauche" si le vecteur v est a gauche de la direction d, "droite" sinon,
 *  null si trop parallele pour trancher. */
function coteDe(d, v, minAbs = 0.2) {
  const gauche = [-d[1], d[0]];
  const p = gauche[0] * v[0] + gauche[1] * v[1];
  if (Math.abs(p) < minAbs) return null;
  return p > 0 ? "gauche" : "droite";
}

/* --------------------------------------------------------------- contexte */

export class Cote {
  /** moteur : MoteurOmbra avec tuiles et ombres chargees ;
   *  plan : sortie de planItineraire() ; trace : prepareTrace(plan.points) ;
   *  date, heure : la journee et le pas d'ombre (heure ARRONDIE au pas) ;
   *  pasParSegment (facultatif) : Map i -> pas de PASSAGE de l'arete, tel que
   *  le moteur l'a lu (resultat.aretes[].pas, heure de passage du 2026-09-10) ;
   *  sans elle, tout est lu au pas de depart. */
  constructor(moteur, plan, trace, { date, heure, pasParSegment = null }) {
    this.moteur = moteur;
    this.plan = plan;
    this.trace = trace;
    this.date = date;
    this.heure = heure;
    const o = moteur.ombres.get(date);
    if (!o) throw new Error(`ombres non chargees pour ${date}`);
    this.indexPas = o.pas.indexOf(heure);
    if (this.indexPas < 0) throw new Error(`pas ${heure} absent de ${date}`);
    this.pasParSegment = pasParSegment;
    this._parRue = null;
    this._visAVis = new Map();
  }

  /** Fraction d'ombre [0,1] du segment i, null si indeterminee. Lue au pas de
   *  passage du segment `iRef` (le segment du trajet : un vis-a-vis est lu a
   *  l'heure ou l'on passe en face), sinon au pas de depart. */
  fractionOmbre(i, iRef = i) {
    const arr = this.moteur.ombres.get(this.date).v.get(i);
    if (!arr) return null;
    const val = arr[this.pasParSegment?.get(iRef) ?? this.indexPas];
    return val === 255 ? null : val / 100;
  }

  _indexParRue() {
    if (this._parRue) return this._parRue;
    const m = new Map();
    for (const s of this.moteur.segments.values()) {
      if (!s.rue || !s.cote) continue;
      if (!m.has(s.rue)) m.set(s.rue, []);
      m.get(s.rue).push(s);
    }
    this._parRue = m;
    return m;
  }

  /** Trottoir d'en face du segment i : { i, cote, distance_m } ou null. */
  visAVis(i) {
    if (this._visAVis.has(i)) return this._visAVis.get(i);
    const s = this.moteur.segments.get(i);
    let res = null;
    if (s && s.rue && s.cote) {
      const d0 = directionSegment(s.geomL93);
      const mid = milieu(s.geomL93);
      let meilleur = null, dMin = Infinity;
      for (const c of this._indexParRue().get(s.rue) ?? []) {
        if (c.i === i || c.cote === s.cote) continue;
        const d1 = directionSegment(c.geomL93);
        if (d0 && d1) {
          const cosA = Math.abs(d0[0] * d1[0] + d0[1] * d1[1]);
          if (cosA < Math.cos((PARALLELE_MAX_DEG * Math.PI) / 180)) continue;
        }
        // L'en face doit etre DU COTE OPPOSE a notre cote boussole : sur une
        // rue en L, l'autre branche porte le meme nom, un autre cote, et se
        // trouve a 10 m, mais du mauvais cote (mesure du 2026-09-05, rue des
        // Guillemites).
        const n = VECTEUR_BOUSSOLE[s.cote];
        const cm = milieu(c.geomL93);
        if (n && (cm[0] - mid[0]) * n[0] + (cm[1] - mid[1]) * n[1] > 0) continue;
        const d = distancePointPolyligne(mid, c.geomL93);
        if (d < dMin) { dMin = d; meilleur = c; }
      }
      if (meilleur && dMin <= VIS_A_VIS_MAX_M) res = { i: meilleur.i, cote: meilleur.cote, distance_m: dMin };
    }
    this._visAVis.set(i, res);
    return res;
  }

  /** Etape de trottoir active a s ; sur une traversee ou une liaison, le
   *  prochain trottoir (c'est la ou le marcheur va), sinon le precedent. */
  etapeTrottoir(s) {
    const e = this.plan.etapes;
    let i = e.findIndex((x) => s >= x.sDebut && s <= x.sFin);
    if (i < 0) i = s < (e[0]?.sDebut ?? 0) ? 0 : e.length - 1;
    for (let j = i; j < e.length; j++) if (e[j].type === "trottoir") return e[j];
    for (let j = i; j >= 0; j--) if (e[j].type === "trottoir") return e[j];
    return null;
  }

  /** Cote a suivre a l'abscisse s, dans le sens de la marche.
   *  { cote: "gauche"|"droite"|null, methode: "geometrie"|"boussole"|null,
   *    coteBoussole, rue, visAVis } */
  cote(s) {
    const e = this.etapeTrottoir(s);
    if (!e) return { cote: null, methode: null, coteBoussole: null, rue: null, visAVis: null };
    const seg = this.moteur.segments.get(e.i);
    const sMilieu = Math.min(Math.max(s, e.sDebut), e.sFin);
    const v = this.visAVis(e.i);
    const n = seg?.cote ? VECTEUR_BOUSSOLE[seg.cote] : null;
    let cote = null, methode = null;
    // 1. Boussole : le cote boussole est calcule depuis l'AXE de la rue, c'est
    //    la reference stable. Cap lisse sur +/- 5 m, puis +/- 15 m si le
    //    morceau est trop perpendiculaire (bout de trottoir au carrefour).
    if (n) for (const demi of [5, 15]) {
      const d = directionMarche(this.trace, sMilieu, demi);
      const c = d ? coteDe(d, n) : null;
      if (c) { cote = c; methode = demi === 5 ? "boussole" : "boussole_lissee"; break; }
    }
    // 2. Geometrie de l'en face, en dernier recours seulement : fragile dans
    //    les virages et aux angles (mesure du 2026-09-05 : 4 desaccords sur
    //    58, tous a des angles ou dans une rue en L).
    if (!cote && v) {
      const d = directionMarche(this.trace, sMilieu);
      const a = milieu(seg.geomL93), b = milieu(this.moteur.segments.get(v.i).geomL93);
      const c = d ? coteDe(d, [b[0] - a[0], b[1] - a[1]]) : null;
      if (c) { cote = c === "gauche" ? "droite" : "gauche"; methode = "geometrie"; }
    }
    return { cote, methode, coteBoussole: seg?.cote ?? null, rue: seg?.rue ?? null, visAVis: v };
  }

  /** Bande d'ombre des deux cotes, de s a s + horizon.
   *  Chaque bloc : { sDebut, sFin, type, ombre, connu }.
   *  ombre : fraction [0,1], ou null (indeterminee / inconnue / pas un trottoir).
   *  connu : false quand on ne sait pas (pas de vis-a-vis, traversee...). */
  bande(s, horizon = HORIZON_BANDE_M) {
    const fin = Math.min(this.trace.longueur, s + horizon);
    const suivi = [], enFace = [];
    for (const e of this.plan.etapes) {
      if (e.sFin <= s || e.sDebut >= fin) continue;
      const d = Math.max(e.sDebut, s), f = Math.min(e.sFin, fin);
      if (f - d <= 0) continue;
      if (e.type === "trottoir") {
        const o = this.fractionOmbre(e.i);
        suivi.push({ sDebut: d, sFin: f, type: "trottoir", ombre: o, connu: true, indetermine: o === null });
        const v = this.visAVis(e.i);
        const ov = v ? this.fractionOmbre(v.i) : null;
        enFace.push({ sDebut: d, sFin: f, type: "trottoir", ombre: ov, connu: !!v, indetermine: !!v && ov === null });
      } else {
        suivi.push({ sDebut: d, sFin: f, type: e.type, ombre: null, connu: false, indetermine: false });
        enFace.push({ sDebut: d, sFin: f, type: e.type, ombre: null, connu: false, indetermine: false });
      }
    }
    return { sDebut: s, sFin: fin, suivi, enFace };
  }

  /** Moyenne d'ombre ponderee par la longueur, sur les blocs evalues.
   *  L'indetermine compte comme ombre (contrat du moteur). null si moins de
   *  la moitie de la longueur est evaluee. */
  static moyenneOmbre(blocs) {
    let lEval = 0, lTot = 0, somme = 0;
    for (const b of blocs) {
      const L = b.sFin - b.sDebut;
      lTot += L;
      if (b.type !== "trottoir" || !b.connu) continue;
      lEval += L;
      somme += (b.ombre === null ? 1 : b.ombre) * L;
    }
    return lTot > 0 && lEval >= 0.5 * lTot ? somme / lEval : null;
  }

  /** L'instruction a s est-elle contre-intuitive, et comment la justifier ?
   *  { actif, ombreSuivi, ombreEnFace, justification: { soleil_m, traversee_m,
   *    ombreApres_m } | null } */
  contreIntuitif(s, fenetre = FENETRE_CONTRE_INTUITIF_M) {
    // La fenetre s'arrete a la prochaine traversee : on compare les deux
    // cotes de la rue EN COURS. Sans cette borne, a 50 m de la traversee la
    // fenetre debordait sur l'autre cote, deja a l'ombre, et le motif
    // s'eteignait avant qu'on y soit (mesure du 2026-09-05, rue des Francs
    // Bourgeois). Sous 15 m, plus rien a comparer : l'annonce de traversee
    // prend le relais.
    const trav = this.plan.etapes.find((e) => e.type === "traversee" && e.sDebut > s);
    const horizon = Math.min(fenetre, trav ? trav.sDebut - s : fenetre);
    if (horizon < 15) return { actif: false, ombreSuivi: null, ombreEnFace: null, justification: null };
    const b = this.bande(s, horizon);
    const ombreSuivi = Cote.moyenneOmbre(b.suivi);
    const ombreEnFace = Cote.moyenneOmbre(b.enFace);
    const actif = ombreSuivi !== null && ombreEnFace !== null
      && ombreEnFace - ombreSuivi > SEUIL_CONTRE_INTUITIF;
    return { actif, ombreSuivi, ombreEnFace, justification: actif ? this._justifie(s) : null };
  }

  /** Meme question, pour la rue APRES la prochaine traversee : c'est ce qu'on
   *  affiche avec l'annonce de traversee ("Traverser, puis cote soleil sur
   *  130 m"), pour que le motif soit connu AVANT d'entrer dans la rue, et non
   *  une fois dedans, quand l'utilisateur a deja pu choisir l'ombre. */
  apresTraversee(s) {
    const trav = this.plan.etapes.find((e) => e.type === "traversee" && e.sFin > s);
    if (!trav) return { traversee: null, ...this.contreIntuitif(s) };
    return { traversee: trav, distance_m: Math.max(0, trav.sDebut - s), ...this.contreIntuitif(trav.sFin + 0.01) };
  }

  _estOmbre(e) {
    const o = this.fractionOmbre(e.i);
    return o === null || o >= SEUIL_OMBRE;
  }

  /** Vrai si l'etape k ET la prochaine etape de trottoir sont dans l'etat
   *  `ombre` : un seul bloc de 10 m ne fait pas un changement d'ambiance
   *  (mesure du 2026-09-05 : sans ce lissage, "cote soleil sur 4 m"). */
  _durable(k, ombre) {
    const e = this.plan.etapes;
    if (e[k].type !== "trottoir" || this._estOmbre(e[k]) !== ombre) return false;
    for (let m = k + 1; m < e.length; m++) {
      if (e[m].type === "traversee") return true;       // plus rien a contredire avant la traversee
      if (e[m].type === "trottoir") return this._estOmbre(e[m]) === ombre;
    }
    return true;
  }

  /** Distance au soleil restante sur ce cote, distance a la prochaine
   *  traversee, et longueur d'ombre continue apres elle. */
  _justifie(s) {
    const e = this.plan.etapes;
    let i = e.findIndex((x) => s >= x.sDebut && s < x.sFin);
    if (i < 0) i = e.length - 1;
    let traversee_m = null, soleil_m = null, ombreApres_m = 0;
    let j = i;
    for (; j < e.length; j++) {
      if (e[j].type === "traversee") { traversee_m = Math.max(0, e[j].sDebut - s); break; }
      if (soleil_m === null && e[j].sDebut > s && this._durable(j, true)) soleil_m = e[j].sDebut - s;
    }
    if (traversee_m === null) return { soleil_m: soleil_m ?? this.trace.longueur - s, traversee_m: null, ombreApres_m: 0 };
    if (soleil_m === null || soleil_m > traversee_m) soleil_m = traversee_m;
    // Ombre continue apres la traversee, jusqu'a la suivante ou jusqu'au
    // premier retour DURABLE du soleil.
    for (let k = j + 1; k < e.length; k++) {
      if (e[k].type === "traversee") break;
      if (e[k].type !== "trottoir") continue;
      if (!this._estOmbre(e[k]) && this._durable(k, false)) break;
      ombreApres_m += e[k].sFin - e[k].sDebut;
    }
    return { soleil_m, traversee_m, ombreApres_m };
  }
}

/** Phrase de justification, arrondie a 10 m : ce que la voix lira. */
export function texteJustification(j) {
  if (!j) return "";
  const r = (m) => `${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (j.traversee_m === null) return `Côté soleil sur ${r(j.soleil_m)}, jusqu'à l'arrivée`;
  const fin = j.ombreApres_m >= 10 ? `, puis ${r(j.ombreApres_m)} à l'ombre` : "";
  return `Côté soleil sur ${r(j.soleil_m)}, traversée dans ${r(j.traversee_m)}${fin}`;
}
