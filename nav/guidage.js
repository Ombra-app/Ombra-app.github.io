/* Guidage : de l'abscisse suivie a l'instruction courante (phase 4, palier 3).
 *
 * Le suivi (palier 2) repond "tu es au metre 412". Ce module repond "donc tu
 * marches rue de Turenne cote ouest, il te reste 90 m avant de traverser".
 *
 * Il produit aussi, et c'est capital pour le palier 4, la RUE ATTENDUE a
 * chaque abscisse : la mesure du palier 2 a montre que la distance a
 * l'itineraire est un signal faible (60 m de travers peuvent laisser a 9 m du
 * meme trajet replie). Savoir dans quelle rue le marcheur devrait etre est le
 * signal fort qui manquait.
 */

import { capA } from "./source_position.js";

/* ------------------------------------------------------------------------
 * NIVEAU RUE (decision 7, 2026-09-06). Le guidage ne parle plus de cote :
 * une instruction par RUE, un virage a chaque changement de rue, comme dans
 * Plans. Les traversees d'une meme rue d'un trottoir a l'autre disparaissent
 * des annonces ; les trottoirs sans nom (bouts de carrefour) s'attachent a la
 * rue en cours. Les listes par (rue, cote) ci-dessous restent la reference
 * fidele au planificateur, utilisee par les tests.
 * ------------------------------------------------------------------------ */

const VIRAGE_MIN_DEG = 30;      // en dessous, on "continue" ; au-dessus, on tourne
const RUE_COURTE_M = 15;        // une "rue" plus courte que ca est un bout de carrefour
const DEMI_TOUR_DEG = 150;

/** Direction d'un changement de cap (degres, > 0 = vers la droite). */
export function direction(capAvant, capApres) {
  const d = ((capApres - capAvant) + 540) % 360 - 180;
  if (Math.abs(d) >= DEMI_TOUR_DEG) return "demi-tour";
  if (Math.abs(d) < VIRAGE_MIN_DEG) return "tout droit";
  return d > 0 ? "droite" : "gauche";
}

/** Instructions par rue : [{ index, rue, sDebut, sFin, longueur_m,
 *  manoeuvre: { type: "tourner"|"continuer"|"arrivee", direction, rue, traversee } , texte }].
 *  La manoeuvre est ce qui se passe A LA FIN de l'instruction. */
export function construitInstructionsRue(plan, trace) {
  const groupes = [];
  let g = null;
  const nouveau = (e) => { g = { rue: e.rue, sDebut: e.sDebut, sFin: e.sFin, traverseeAvant: false }; groupes.push(g); };
  for (const e of plan.etapes) {
    if (e.type === "trottoir") {
      if (!g) { nouveau(e); continue; }
      if (!e.rue || !g.rue || e.rue === g.rue) { g.sFin = e.sFin; if (!g.rue) g.rue = e.rue; continue; }
      nouveau(e);
    } else {
      // traversee ou liaison : s'attache au groupe en cours ; si la rue change
      // juste apres, elle sera comptee comme traversee de la rue transversale.
      if (!g) { nouveau({ rue: null, sDebut: e.sDebut, sFin: e.sFin }); continue; }
      g.sFin = e.sFin;
      if (e.type === "traversee") g.traverseeFin = true;
    }
  }
  // Un groupe sans nom coince entre deux rues nommees se fond dans le precedent.
  let fusion = [];
  for (const x of groupes) {
    const prec = fusion[fusion.length - 1];
    if (prec && (!x.rue || x.rue === prec.rue)) { prec.sFin = x.sFin; prec.traverseeFin = x.traverseeFin; continue; }
    if (prec && !prec.rue) { prec.rue = x.rue; prec.sFin = x.sFin; prec.traverseeFin = x.traverseeFin; continue; }
    fusion.push({ ...x });
  }
  // Les rues de moins de RUE_COURTE_M (bouts de trottoir portant le nom d'une
  // rue transversale, 10 m au coin d'un carrefour) se fondent dans la rue
  // precedente : "Continuez rue Milo Adoner sur 10 m" n'est pas une
  // instruction (mesure du 2026-09-06 en repetition dans index.html).
  const courtes = [];
  for (const x of fusion) {
    const prec = courtes[courtes.length - 1];
    if (prec && x.sFin - x.sDebut < RUE_COURTE_M) { prec.sFin = x.sFin; prec.traverseeFin = x.traverseeFin; continue; }
    if (prec && prec.sFin - prec.sDebut < RUE_COURTE_M && courtes.length === 1) { prec.rue = x.rue; prec.sFin = x.sFin; prec.traverseeFin = x.traverseeFin; continue; }
    courtes.push(x);
  }
  // Deux voisines de meme nom apres fusion (A, courte B, A) redeviennent une seule.
  fusion = [];
  for (const x of courtes) {
    const prec = fusion[fusion.length - 1];
    if (prec && prec.rue === x.rue) { prec.sFin = x.sFin; prec.traverseeFin = x.traverseeFin; continue; }
    fusion.push(x);
  }
  // Manoeuvre a la fin de chaque groupe : virage vers la rue suivante.
  const L = trace.longueur;
  return fusion.map((x, i) => {
    const suiv = fusion[i + 1];
    let manoeuvre;
    if (!suiv) manoeuvre = { type: "arrivee", direction: null, rue: null, traversee: false };
    else {
      const avant = capA(trace, Math.max(x.sDebut, x.sFin - 12));
      const apres = capA(trace, Math.min(suiv.sFin, suiv.sDebut + 12));
      const dir = direction(avant, apres);
      manoeuvre = { type: dir === "tout droit" ? "continuer" : "tourner", direction: dir, rue: suiv.rue, traversee: !!x.traverseeFin };
    }
    const nomRue = x.rue || "trottoir sans nom";
    const texte = manoeuvre.type === "arrivee" ? `${nomRue}, jusqu'à l'arrivée`
      : manoeuvre.type === "continuer" ? `${nomRue}, puis continuez ${manoeuvre.rue || ""}`.trim()
      : `${nomRue}, puis ${manoeuvre.direction === "demi-tour" ? "demi-tour" : "à " + manoeuvre.direction} ${manoeuvre.rue || ""}`.trim();
    return { index: i, rue: x.rue, sDebut: x.sDebut, sFin: Math.min(L, x.sFin), longueur_m: Math.min(L, x.sFin) - x.sDebut, manoeuvre, texte };
  });
}

/** Regroupe les etapes du plan en instructions lisibles, avec leurs plages
 *  d'abscisses. Meme regle de regroupement que `detaillerTrace` : une
 *  instruction par couple (rue, cote), traversees intercalees. */
export function construitInstructions(plan) {
  const instructions = [];
  let groupe = null;
  let reportDebut = null;          // liaison en attente, a fondre dans le groupe suivant
  const clore = () => { if (groupe) { instructions.push(groupe); groupe = null; } };

  for (const e of plan.etapes) {
    if (e.type === "trottoir") {
      const cle = `${e.rue}|${e.cote}`;
      if (!groupe || groupe.cle !== cle) {
        clore();
        groupe = { cle, type: "marche", rue: e.rue, cote: e.cote,
                   sDebut: reportDebut ?? e.sDebut, sFin: e.sFin };
        reportDebut = null;
      } else groupe.sFin = e.sFin;
    } else if (e.type === "traversee") {
      clore();
      instructions.push({ type: "traversee", rue: null, cote: null,
                          source: e.source, sDebut: reportDebut ?? e.sDebut, sFin: e.sFin });
      reportDebut = null;
    } else {
      // Rattachement depart/arrivee : JAMAIS une instruction a lui seul. Il
      // s'ajoute au groupe en cours, ou au suivant s'il n'y en a pas encore.
      // (Regle miroir de detaillerTrace : sans elle on produit une instruction
      // de plus que le planificateur.)
      if (groupe) groupe.sFin = e.sFin;
      else if (reportDebut === null) reportDebut = e.sDebut;
    }
  }
  clore();
  if (reportDebut !== null && instructions.length) {
    instructions[instructions.length - 1].sFin = plan.etapes[plan.etapes.length - 1].sFin;
  }

  return instructions.map((x, idx) => etiquette(x, idx));
}

function etiquette(x, idx) {
  return {
    ...x, index: idx, longueur_m: x.sFin - x.sDebut,
    texte: x.type === "traversee"
      ? (x.source === "osm_crossing" ? "Traverser au passage pieton" : "Traverser au carrefour")
      : (x.rue || "trottoir sans nom") + (x.cote ? `, cote ${x.cote}` : ""),
  };
}

/** Vue GUIDAGE : ce qu'on dit reellement au marcheur.
 *
 *  Le planificateur produit des instructions de quelques metres, nees du
 *  decoupage geometrique du reseau ("Rue du Parc Royal, cote sud - 5 m").
 *  Elles n'ont aucun sens pour quelqu'un qui marche, et le suivi les enjambe
 *  entre deux points GPS : mesure du 2026-08-30, 3 instructions sur 38 etaient
 *  sautees sous bruit 15 m, toutes de moins de 12 m.
 *  On les fond donc dans l'instruction voisine. Les traversees ne sont JAMAIS
 *  fondues : ce sont des actions reelles, pas du decoupage. */
export function fusionneCourtes(instructions, seuil_m = 12) {
  const sortie = [];
  for (const x of instructions) {
    if (x.type === "marche" && x.longueur_m < seuil_m && (sortie.length || instructions.length > 1)) {
      if (sortie.length) { sortie[sortie.length - 1].sFin = x.sFin; continue; }
      const suivantIdx = instructions.indexOf(x) + 1;
      if (suivantIdx < instructions.length) { instructions[suivantIdx].sDebut = x.sDebut; continue; }
    }
    sortie.push({ ...x });
  }
  return sortie.map((x, i) => etiquette(x, i));
}

const ANNONCE_M = 25;   // distance a laquelle on annonce la manoeuvre suivante

export class Guidage {
  /** plan : sortie de planItineraire() ; longueur : longueur de la trace. */
  constructor(plan, longueur_m, { seuilFusion_m = 12, trace = null } = {}) {
    this.plan = plan;
    this.longueur_m = longueur_m;
    /** Liste FIDELE au planificateur (reference, phase 2). */
    this.instructions = construitInstructions(plan);
    /** Liste effectivement annoncee au marcheur. */
    this.instructionsGuidage = fusionneCourtes(this.instructions, seuilFusion_m);
    /** Liste par RUE (decision 7) : celle du mode guidage de l'application. */
    this.instructionsRue = trace ? construitInstructionsRue(plan, trace) : [];
    this.trace = trace;
  }

  /** Etat de guidage NIVEAU RUE a l'abscisse s : rue en cours, manoeuvre a
   *  venir et sa distance, annonce a 25 m, rue suivante. */
  rue(s) {
    const liste = this.instructionsRue;
    if (!liste.length) return null;
    const idx = liste.findIndex((x) => s >= x.sDebut && s < x.sFin);
    const i = idx < 0 ? (s < liste[0].sDebut ? 0 : liste.length - 1) : idx;
    const courante = liste[i];
    const distance_m = Math.max(0, courante.sFin - s);
    return {
      instruction: courante,
      rue: courante.rue,
      manoeuvre: courante.manoeuvre,
      distance_m,
      annonce: courante.manoeuvre.type !== "arrivee" && distance_m <= ANNONCE_M,
      suivante: liste[i + 1] ?? null,
      restant_total_m: Math.max(0, this.longueur_m - s),
      progression: this.longueur_m > 0 ? Math.min(1, s / this.longueur_m) : 0,
    };
  }

  /** Etape du plan active a l'abscisse s (rue attendue, meme sur traversee). */
  etapeA(s) {
    const e = this.plan.etapes;
    for (let i = 0; i < e.length; i++) if (s >= e[i].sDebut && s <= e[i].sFin) return e[i];
    return s < e[0]?.sDebut ? e[0] : e[e.length - 1];
  }

  /** Rue et cote ATTENDUS a l'abscisse s. Sur une traversee ou une liaison,
   *  on renvoie la rue du prochain trottoir : c'est la ou le marcheur va. */
  rueAttendue(s) {
    const e = this.plan.etapes;
    let i = e.findIndex((x) => s >= x.sDebut && s <= x.sFin);
    if (i < 0) i = s < (e[0]?.sDebut ?? 0) ? 0 : e.length - 1;
    for (let j = i; j < e.length; j++) if (e[j].type === "trottoir") return { rue: e[j].rue, cote: e[j].cote };
    for (let j = i; j >= 0; j--) if (e[j].type === "trottoir") return { rue: e[j].rue, cote: e[j].cote };
    return { rue: null, cote: null };
  }

  /** Etat de guidage a l'abscisse s. */
  a(s) {
    const liste = this.instructionsGuidage;
    const idx = liste.findIndex((x) => s >= x.sDebut && s < x.sFin);
    const i = idx < 0 ? (s < liste[0].sDebut ? 0 : liste.length - 1) : idx;
    const courante = liste[i];
    const suivante = liste[i + 1] ?? null;
    const avantManoeuvre = Math.max(0, courante.sFin - s);
    return {
      instruction: courante,
      restant_dans_instruction_m: avantManoeuvre,
      suivante,
      annonce: suivante && avantManoeuvre <= ANNONCE_M ? suivante : null,
      rue_attendue: this.rueAttendue(s),
      restant_total_m: Math.max(0, this.longueur_m - s),
      progression: this.longueur_m > 0 ? Math.min(1, s / this.longueur_m) : 0,
    };
  }
}
