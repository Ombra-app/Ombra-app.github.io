/* Detection d'ecart (phase 4, palier 4).
 *
 * LE SIGNAL FORT EST LA RUE, PAS LA DISTANCE. Mesure du 2026-09-03 : en
 * quittant le trajet de 60 m, la distance a l'itineraire peut descendre a
 * 0,5 m parce que le trajet se replie sur lui-meme dans un tissu dense. On
 * regarde donc dans quelle RUE le marcheur se trouve reellement (le trottoir
 * le plus proche de la position brute, dans un index local autour du trajet)
 * et on la compare a la rue attendue par le guidage : celle de l'instruction
 * en cours, ou la suivante (au coin d'un carrefour, les deux sont legitimes).
 *
 * LA DUREE FAIT L'HYSTERESIS. Un point GPS aberrant, ou un instant sur un
 * trottoir transversal en traversant, ne declenche rien : il faut que le
 * desaccord tienne SECONDES_ECART secondes d'affilee. Un point d'accord
 * rembobine le compteur (compteur qui fuit, pas remise a zero : deux points
 * bruites au milieu d'un vrai ecart ne le sauvent pas).
 *
 * La distance et la confiance du suivi ne sont que des signaux d'appoint :
 * une confiance nulle (position a plus de 4 x precision + 25 m de la trace)
 * qui dure compte aussi, parce qu'un marcheur peut etre dans une rue sans nom.
 *
 * Sorties : { hors: bool, ecart: bool (confirme), depuis_s, rueSuivie, rueAttendue }.
 */

import { wgs84VersL93 } from "../moteur.js";
import { capA } from "./source_position.js";

const SECONDES_ECART = 18;      // duree de desaccord continu avant de conclure (~23 m a 1,3 m/s) ; mesure 2026-09-06 : sur 5 trajets x 3 graines, le desaccord le plus long d une trace FIDELE est de 14 s a 15 m de bruit et 15 s a 20 m
const SECONDES_MIN = 10;
// Route mesuree (cap GPS en marche, sinon vecteur des positions) contre le cap de
// la trace : idee de Jean-Philippe apres le test de Pornic (2026-09-07),
// "je suis parti a plus de 120 degres du cap a suivre, c'est un bon indice".
// Sur sa trace, la deviation etait de 40 a 60 degres pendant toute l'erreur
// (mesure : le cap attendu tourne de l'ouest au nord en 10 m). Le desaccord
// de cap ne compte que si l'on MARCHE, qu'il tient toute la fenetre, et que
// l'ecart a la trace grandit dans le meme temps (sinon, c'est le telephone
// tenu de travers). Il compte double : c'est le signal le plus precoce.
const ecartCapDeg = (a, b) => { let d = (b - a) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; };
const CAP_DEVIE_DEG = 35;        // deviation minimale entre cap mesure et cap de la trace (courant ou a +15 m, le plus favorable)
const CAP_FENETRE_S = 8;         // ...tenue pendant toute cette fenetre...
const CAP_VITESSE_MIN = 0.7;     // ...en marchant (m/s)...
const CAP_ECHANTILLONS_MIN = 5;  // ...avec au moins ce nombre de mesures...
const CAP_ANTICIPATION_M = 15;   // cap de la trace un peu plus loin : on tolere d'anticiper le virage
const CAP_ECART_CROISSANT = 0.5; // ...et un ecart a la trace qui a grandi de max(3 m, 0,5 x precision)        // duree minimale, GPS tres precis (voir requis dans maj)
const REMBOBINAGE = 1;          // un point d'accord retire 1 s au compteur (compteur qui fuit ; 2 avant la trace de Pornic du 2026-09-07, ou une seule seconde d'accord effacait 11 s de desaccord)
const DISTANCE_MOY_MIN_M = 15;  // distance moyenne a la trace sur la fenetre : plancher (25 avant Pornic : avec un GPS a 4 m, 25 m de plancher retardait tout)...
const DISTANCE_MOY_FACTEUR = 2.2; // ...et facteur de la precision annoncee (bruit 15 m -> 48 m)
const FENETRE_CAP_S = 20;       // fenetre pour estimer le cap de marche reel (positions brutes)
const DEPLACEMENT_MIN_M = 12;   // en dessous, pas de cap fiable (bruit)
const CAP_OPPOSE_DEG = 100;     // au-dela, on marche a l'oppose de la trace (fenetre de 20 s : l'erreur de cap due au bruit reste sous 40 degres)
const MARGE_RUE_M = 8;          // la rue suivie doit etre nettement plus proche que la rue attendue
const ECART_MIN_FACTEUR = 0.8;  // distance a la trace minimale pour un desaccord de rue : 0,8 x precision, plancher 8 m
// LA RUE AIMANTEE EST LE SIGNAL LE PLUS DIRECT. Depuis le 2026-09-08, la
// position affichee est aimantee sur le reseau de trottoirs : a l'ecran, le
// point est DANS une rue, et l'utilisateur voit tout de suite que ce n'est pas
// la bonne ("on le voit nettement a l'ecran, le navigateur devrait
// l'integrer", Jean-Philippe, trace 6 de Pornic). L'aimant est plus sur que le
// trottoir le plus proche calcule ici sur la position brute : il a la
// continuite temporelle et le filtre de cap. Quand il est certain (a moins de
// AIMANT_SUR_M du marcheur) et qu'il designe une rue qu'on n'attendait pas, on
// ne fait plus semblant de ne pas savoir.
const AIMANT_SUR_M = 3;         // (4 avant le lot recalibre du 2026-09-08 : 3 m donne 7 faux positifs et 1 erreur manquee sur 120 rejeux, contre 8 et 2) au-dela, l'aimantation n'est pas assez sure pour conclure
const AIMANT_MARGE_M = 5;       // et le trottoir attendu le plus proche doit etre nettement plus loin
const AIMANT_ECART_MIN_M = 12;  // ...et la trace deja a cette distance (plancher)...
const AIMANT_ECART_FACTEUR = 1; // ...ou a une fois la precision annoncee, le plus grand des deux
// Deux gardes ajoutees apres le rejeu PERTURBE du 2026-09-08 (bench/nav/
// rejeu_perturbe.mjs : les six traces reelles rejouees avec du bruit ajoute et
// des points perdus, plusieurs graines). Sans elles, le signal passait de 1 a
// 11 faux positifs sur 90 rejeux : sous bruit, la position brute se deporte
// dans la rue d'a cote, l'aimant s'y accroche a juste titre, et on concluait.
const AIMANT_STABLE_S = 3;      // la meme rue affichee, sans interruption, avant de conclure : le bruit fait sauter d'une rue a l'autre, une vraie erreur non
const AIMANT_PRECISION_MAX_M = 15; // au-dela, la rue affichee ne prouve rien
const SECONDES_AIMANT = 10;      // duree requise quand c'est la rue AFFICHEE qui accuse : le signal le plus direct qu'on ait, celui que l'oeil voit a l'ecran
const CASE_M = 50;              // taille des cases de l'index local
const MARGE_M = 250;            // rayon autour du trajet indexe

export class DetecteurEcart {
  /** moteur : segments charges ; trace : prepareTrace() ; guidage : Guidage (niveau rue). */
  constructor(moteur, trace, guidage, { secondes = SECONDES_ECART } = {}) {
    this.moteur = moteur; this.guidage = guidage; this.secondes = secondes;
    this.compteur = 0; this.dernierT = null; this.ecart = false; this.derniereRue = null; this._rueAff = null;
    this.trace = trace; this.recents = []; this.caps = [];
    this._indexe(trace);
  }

  /** Cap de marche reel : vecteur entre la position d'il y a FENETRE_CAP_S
   *  secondes et la position courante (le bruit se moyenne sur la fenetre).
   *  Retourne { cap, deplacement_m } ou null si trop court pour etre fiable. */
  capReel() {
    const r = this.recents; if (r.length < 2) return null;
    const dernier = r[r.length - 1];
    let premier = null;
    for (const p of r) if (dernier.t - p.t <= FENETRE_CAP_S * 1000) { premier = p; break; }
    if (!premier || premier === dernier) return null;
    const dx = dernier.x - premier.x, dy = dernier.y - premier.y;
    const d = Math.hypot(dx, dy);
    if (d < DEPLACEMENT_MIN_M) return null;
    return { cap: (Math.atan2(dx, dy) * 180) / Math.PI, deplacement_m: d, avance_m: (dernier.s ?? 0) - (premier.s ?? 0) };
  }

  _indexe(trace) {
    const l93 = trace.points.map(([lon, lat]) => wgs84VersL93(lon, lat));
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const [x, y] of l93) { xMin = Math.min(xMin, x); yMin = Math.min(yMin, y); xMax = Math.max(xMax, x); yMax = Math.max(yMax, y); }
    this.grille = new Map();
    let n = 0;
    for (const s of this.moteur.segments.values()) {
      const g = s.geomL93;
      const [x, y] = g[Math.floor(g.length / 2)];
      if (x < xMin - MARGE_M || x > xMax + MARGE_M || y < yMin - MARGE_M || y > yMax + MARGE_M) continue;
      for (const [px, py] of [g[0], g[g.length - 1], [x, y]]) {
        const k = `${Math.floor(px / CASE_M)}_${Math.floor(py / CASE_M)}`;
        if (!this.grille.has(k)) this.grille.set(k, new Set());
        this.grille.get(k).add(s);
      }
      n++;
    }
    this.nSegments = n;
  }

  /** Trottoir le plus proche de la position (index local), et distance au
   *  plus proche trottoir des rues attendues. { rue, cote, d, dAttendue } ou null. */
  rueSuivie(lon, lat, ruesAttendues = new Set()) {
    const [px, py] = wgs84VersL93(lon, lat);
    const cx = Math.floor(px / CASE_M), cy = Math.floor(py / CASE_M);
    let meilleur = null, dAttendue = Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = this.grille.get(`${cx + i}_${cy + j}`); if (!cell) continue;
      for (const s of cell) {
        const g = s.geomL93;
        let dSeg = Infinity;
        for (let p = 1; p < g.length; p++) {
          const [x1, y1] = g[p - 1], [x2, y2] = g[p];
          const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2)) : 0;
          dSeg = Math.min(dSeg, Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)));
        }
        if (!meilleur || dSeg < meilleur.d) meilleur = { rue: s.rue || null, cote: s.cote || null, d: dSeg, i: s.i };
        if (s.rue && ruesAttendues.has(s.rue)) dAttendue = Math.min(dAttendue, dSeg);
      }
    }
    if (meilleur) meilleur.dAttendue = Number.isFinite(dAttendue) ? dAttendue : null;
    return meilleur;
  }

  /** Distance moyenne a la trace sur la fenetre (null si moins de 5 points). */
  distanceMoyenne() {
    const r = this.recents; if (r.length < 5) return null;
    const dernier = r[r.length - 1];
    let somme = 0, n = 0;
    for (const p of r) if (dernier.t - p.t <= FENETRE_CAP_S * 1000) { somme += p.ecart; n++; }
    return n >= 5 ? somme / n : null;
  }

  /** Consomme une position brute, la sortie du suivi, et l'aimantation
   *  affichee (aimant.projette(), ou null). */
  maj(pos, sortieSuivi, aimante = null) {
    const dt = this.dernierT === null ? 0 : Math.max(0, Math.min(5, (pos.t - this.dernierT) / 1000));
    this.dernierT = pos.t;
    const attendu = this.guidage.rue(sortieSuivi.s);
    const rues = new Set();
    if (attendu?.rue) rues.add(attendu.rue);
    if (attendu?.manoeuvre?.rue) rues.add(attendu.manoeuvre.rue);
    if (attendu?.suivante?.rue) rues.add(attendu.suivante.rue);
    const suivie = this.rueSuivie(pos.lon, pos.lat, rues);
    this.derniereRue = suivie;
    // Positions brutes recentes, pour le cap reel et la progression sur la trace.
    const [x, y] = wgs84VersL93(pos.lon, pos.lat);
    this.recents.push({ t: pos.t, x, y, s: sortieSuivi.s, ecart: sortieSuivi.ecart_m ?? 0 });
    while (this.recents.length && pos.t - this.recents[0].t > (FENETRE_CAP_S + 5) * 1000) this.recents.shift();
    // Cap mesure contre cap de la trace (voir CAP_DEVIE_DEG).
    // ROUTE suivie (cap GPS en marche, sinon vecteur des positions recentes),
    // jamais la boussole : ou pointe le telephone n'est pas ou l'on va
    // (decision de Jean-Philippe, 2026-09-07 : "comparer un ecart de route").
    const capMesure = ((pos.vitesse ?? 0) >= CAP_VITESSE_MIN && pos.cap != null) ? pos.cap : (this.capReel()?.cap ?? null);
    if (capMesure != null) {
      const attenduIci = capA(this.trace, sortieSuivi.s), attenduLoin = capA(this.trace, Math.min(this.trace.longueur, sortieSuivi.s + CAP_ANTICIPATION_M));
      const dev = Math.min(Math.abs(ecartCapDeg(attenduIci, capMesure)), Math.abs(ecartCapDeg(attenduLoin, capMesure)));
      this.caps.push({ t: pos.t, dev, v: pos.vitesse ?? 0, ecart: sortieSuivi.ecart_m ?? 0 });
    }
    while (this.caps.length && pos.t - this.caps[0].t > CAP_FENETRE_S * 1000) this.caps.shift();
    let capDevie = false;
    if (this.caps.length >= CAP_ECHANTILLONS_MIN && pos.t - this.caps[0].t >= (CAP_FENETRE_S - 1) * 1000) {
      const enMarche = this.caps.filter((c) => c.v >= CAP_VITESSE_MIN);
      capDevie = enMarche.length >= CAP_ECHANTILLONS_MIN && enMarche.every((c) => c.dev >= CAP_DEVIE_DEG)
        && (this.caps[this.caps.length - 1].ecart - this.caps[0].ecart) > Math.max(3, CAP_ECART_CROISSANT * Math.max(3, pos.precision_m ?? 10));
    }
    // Trois desaccords possibles :
    //  1. une rue nommee differente de toutes les rues attendues ;
    //  2. une confiance nulle (loin de la trace, meme dans une rue sans nom) ;
    //  3. la bonne rue mais a l'oppose du sens de marche attendu (cas que ni
    //     la rue ni la distance ne voient avant longtemps).
    // Rue differente : nommee, hors des rues attendues, NETTEMENT plus proche
    // que le trottoir attendu le plus proche (une allee centrale ou une place
    // portent un autre nom a 5 m du trajet), et la trace deja a plus de
    // ECART_MIN_M (mesure du 2026-09-06 : sans ces deux gardes, 40 % des points
    // d'une trace fidele bruitee a 15 m etaient "dans une autre rue").
    const rueDifferente = !!suivie?.rue && rues.size > 0 && !rues.has(suivie.rue)
      && (suivie.dAttendue === null || suivie.dAttendue - suivie.d > MARGE_RUE_M)
      && (sortieSuivi.ecart_m ?? 0) > Math.max(8, ECART_MIN_FACTEUR * Math.max(3, pos.precision_m ?? 10));
    const loin = (sortieSuivi.confiance ?? 1) <= 0;
    // Sens oppose : cap reel a l'oppose du cap de la trace ET l'abscisse suivie
    // qui n'avance plus alors qu'on se deplace (sinon, c'est du bruit de cap).
    const reel = this.capReel();
    let oppose = false, stagne = false;
    if (reel) {
      const attenduCap = capA(this.trace, sortieSuivi.s);
      const delta = Math.abs(((reel.cap - attenduCap) + 540) % 360 - 180);
      oppose = delta >= CAP_OPPOSE_DEG && reel.avance_m < 0.4 * reel.deplacement_m;
    }
    // 4. Distance MOYENNE a la trace sur la fenetre, rapportee au bruit annonce :
    //    le bruit est symetrique et se moyenne, un vrai eloignement non. Voit le
    //    cas "tout droit au lieu de tourner" le long d'une cour parallele a la
    //    rue attendue, ou ni la rue ni le cap ne disent rien (mesure du
    //    2026-09-06). Une stagnation de l'abscisse a ete essayee et rejetee :
    //    trop de faux positifs a 15 m de bruit (118 points sur 860).
    const seuilMoy = Math.max(DISTANCE_MOY_MIN_M, DISTANCE_MOY_FACTEUR * Math.max(3, pos.precision_m ?? 10));
    const moy = this.distanceMoyenne();
    stagne = moy !== null && moy > seuilMoy;
    // 5. La rue AFFICHEE (position aimantee) n'est aucune des rues attendues,
    //    et l'aimantation est certaine. Signal fort : c'est ce que l'oeil voit.
    // Continuite de la rue AFFICHEE (independante du compteur de desaccord,
    // qui melange les motifs) : on veut la meme rue plusieurs secondes de suite.
    if (!this._rueAff || this._rueAff.rue !== (aimante?.rue ?? null)) this._rueAff = { rue: aimante?.rue ?? null, t: pos.t };
    const stable_s = (pos.t - this._rueAff.t) / 1000;
    const rueAimantee = !!aimante?.rue && rues.size > 0 && !rues.has(aimante.rue) && aimante.d <= AIMANT_SUR_M
      && stable_s >= AIMANT_STABLE_S && (pos.precision_m ?? 10) <= AIMANT_PRECISION_MAX_M
      && (suivie?.dAttendue == null || suivie.dAttendue - aimante.d > AIMANT_MARGE_M)
      // ...et la trace deja a bonne distance : au coin d'un carrefour, ou sur
      // le trottoir d'en face, la rue affichee change sans qu'on soit perdu.
      // Une derogation a cette garde, quand le trottoir attendu etait tres
      // loin, a ete essayee et RETIREE : le rejeu perturbe du 2026-09-08 lui
      // impute 2 faux positifs sur 90 rejeux, pour 3 secondes gagnees sur une
      // seule trace.
      && (sortieSuivi.ecart_m ?? 0) > Math.max(AIMANT_ECART_MIN_M, AIMANT_ECART_FACTEUR * Math.max(3, pos.precision_m ?? 10));
    const hors = rueDifferente || rueAimantee || loin || oppose || stagne || capDevie;
    // Preuve forte (distance moyenne au double du seuil) : le temps compte
    // double. Trace de Pornic du 2026-09-07 : 23 a 28 m d'ecart avec un GPS a
    // 4 m pendant 11 s, puis 30 m, et l'appli attendait encore 20 s.
    const fort = (moy !== null && moy > 2 * seuilMoy) || capDevie || rueAimantee;
    if (hors) this.compteur += dt * (fort ? 2 : 1);
    else this.compteur = Math.max(0, this.compteur - REMBOBINAGE * Math.max(dt, 1));
    // Duree requise selon la precision annoncee : les 18 s sont calibrees sur
    // un GPS bruite a 15-20 m (streak fidele max 14-15 s) ; a 4 m (Pornic,
    // 2026-09-07), le bruit ne tient pas 12 s d'affilee. 10 s + 0,5 s par metre.
    let requis = Math.min(this.secondes, SECONDES_MIN + 0.5 * Math.max(3, pos.precision_m ?? 10));
    if (rueAimantee) requis = Math.min(requis, SECONDES_AIMANT);
    this.ecart = this.compteur >= requis;
    return { hors, ecart: this.ecart, depuis_s: this.compteur, rueSuivie: suivie?.rue ?? null, rueAttendue: attendu?.rue ?? null,
             distanceTrottoir_m: suivie?.d ?? null, motif: rueAimantee ? "rue affichee" : rueDifferente ? "rue" : loin ? "loin" : oppose ? "sens" : stagne ? "distance" : capDevie ? "cap" : null };
  }

  /** Apres un recalcul : on repart de zero sur la nouvelle trace. */
  reinitialise(trace, guidage) {
    this.guidage = guidage; this.compteur = 0; this.ecart = false; this.dernierT = null;
    this.trace = trace; this.recents = []; this.caps = []; this._rueAff = null;
    this._indexe(trace);
  }
}
