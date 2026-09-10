/* Mode guidage de l'application (phase 4, decision 5 et decision 7).
 *
 * Le guidage n'est pas une page : c'est un MODE de index.html. Ce module
 * recoit la carte MapLibre et le moteur deja charges, l'itineraire calcule
 * par le planificateur, et s'occupe de tout le reste : position en continu
 * (GPS reel ou simulateur du palier 1), suivi de progression (palier 2),
 * instructions par rue (palier 3, decision 7), trace au niveau de la rue
 * coloree par le meilleur cote, ecran maintenu allume, bip aux manoeuvres.
 *
 * Il ne touche ni au moteur ni aux couches du planificateur : il ajoute ses
 * propres sources et couches, les retire a l'arret, et rend l'ecran tel
 * qu'il l'a trouve.
 *
 * Deux sources de position, meme interface (source_position.js) :
 *  - reel : navigator.geolocation.watchPosition ;
 *  - repetition : le simulateur rejoue la trace (bruit 5 m par defaut, 0 pour
 *    juger le VISUEL sans que le point tremble ; x1 en temps
 *    reel, ou plus vite avec ?repetition=20). Sert aux demonstrations et aux
 *    tests assis, sans jamais faire croire a un guidage reel : la feuille du
 *    bas le dit.
 */

import { SourceGPS, SourceSimulee, prepareTrace, pointA, capA } from "./source_position.js";
import { planItineraire } from "./trace.js";
import { SuiviProgression } from "./suivi.js";
import { Guidage } from "./guidage.js";
import { Cote } from "./cote.js";
import { DetecteurEcart } from "./ecart.js";
import { Boussole, ecartCap } from "./boussole.js";
import { PositionAffichee, VITESSE_CAP_GPS as VITESSE_CAP } from "./position_affichee.js";
import { Podometre } from "./podometre.js";
import { Aimant } from "./aimant.js";

const SEUIL_RUE_M = 12;          // decision 7 : rue etroite = trottoirs a moins de 12 m
const ZOOM_MARCHE = 17.2;
const VITESSE_MARCHE = 1.3;      // m/s, pour le temps restant
const REPIT_RECALCUL_MS = 6000;  // apres un recalcul, delai avant d en accepter un autre (20 s avant la trace de Pornic n°3 du 2026-09-07 : les 2e et 3e erreurs, vues en 11 s, attendaient 10 s de plus ; le compteur du detecteur, >= 10 s, suffit comme garde)
// Arrets en cours de route (heure de passage, 2026-09-10) : l'itineraire est
// calcule pour une marche continue ; un arret (magasin, bar) decale l'heure de
// passage de tout ce qui reste. A la REPRISE de la marche apres un arret d'au
// moins ARRET_RECALCUL_S, on recalcule la suite depuis la position et l'heure
// courantes, sans rien demander a l'utilisateur. Un feu rouge (30 a 90 s) ne
// compte pas : un decalage inferieur au cinquieme d'un pas de 15 min ne change
// presque rien, et recalculer a chaque feu ferait clignoter l'ecran.
export const ARRET_RECALCUL_S = 180;
const ARRET_PROGRES_M = 5;       // avancee minimale sur la trace pour dire que l'on marche (bruit GPS a l'arret)
// Retour du test terrain de Pornic (2026-09-07) : le point bleu etait la
// projection sur la trace et le faisceau la direction de la trace, d'ou une
// impression de lenteur et une position fausse des qu'on quitte l'itineraire.
// Desormais : vraie position GPS, glissement anime entre deux positions,
// direction de marche en haut (la carte tourne, comme Plans ou Maps), cap
// pris sur la boussole a l'arret ou a petite vitesse, sur le GPS en marche.
// Depuis la simulation "banc de guidage" (meme jour, soir) : la position
// affichee est PREDITE entre deux positions GPS puis CORRIGEE en douceur
// (nav/position_affichee.js), et la camera est pilotee image par image, avec
// un lissage sur la position et un autre, plus lent, sur l'orientation.
const CADENCE_IMAGE_MS = 33;     // au plus 30 images par seconde vers MapLibre (setData passe par un worker)
const LISSAGE_CAMERA = 4;        // 1/s : la camera rattrape le point a ce rythme
const LISSAGE_CAP = 2.5;         // 1/s : l'orientation de la carte, plus lente
const PADDING_HAUT = 0.24;       // le marqueur a 62 % de la hauteur (plus de devant que de derriere)
// Rotation de la carte (levier n°2, 2026-09-07 soir) : la route GPS tremble de
// quelques degres ; on ne tourne pas sous CAP_ZONE_MORTE_DEG, et on tourne
// plus vite dans un vrai virage (au-dela de CAP_VIRAGE_DEG).
// ORIENTATION DE LA CARTE. Le 2026-09-07, Jean-Philippe demandait la direction
// de marche en haut, comme Plans. Le 2026-09-09, apres l'avoir vu sur Paris, il
// revient dessus : le fond OpenStreetMap est une IMAGE, le texte y est dessine,
// donc les noms de rues se retrouvent a l'envers des que la carte tourne. Plans
// n'a pas ce probleme parce que son fond est vectoriel. Tant que le notre est
// raster, le nord reste en haut ; le cone indique la direction de marche.
// ?orientation=marche remet l'ancien comportement pour comparer.
export const ORIENTATION_PAR_DEFAUT = "nord";   // "nord" ou "marche"
const CAP_ZONE_MORTE_DEG = 6;
const CAP_VIRAGE_DEG = 40;
const LISSAGE_CAP_VIRAGE = 5;    // 1/s
const COULEUR = { ombre: "#1565c0", soleil: "#f0a202", indetermine: "#9e9e9e", traversee: "#F2EDE7", liaison: "#F2EDE7" };
const VECTEUR = { nord: [0, 1], est: [1, 0], sud: [0, -1], ouest: [-1, 0] };

/* --- bip aux manoeuvres (WebAudio, debloque par le geste sur "Y aller") --- */
class Bip {
  constructor() { this.ctx = null; }
  armer() { try { this.ctx = this.ctx ?? new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === "suspended") this.ctx.resume(); } catch { this.ctx = null; } }
  jouer(motif = [[880, 0.09], [1175, 0.12]]) {
    if (!this.ctx) return;
    let t = this.ctx.currentTime;
    for (const [f, d] of motif) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + d + 0.02);
      t += d + 0.04;
    }
  }
}

/** Trace au niveau de la rue : pour chaque etape de trottoir dont le vis-a-vis
 *  est a moins de SEUIL_RUE_M, la geometrie est ramenee sur l'axe (decalee
 *  d'une demi-largeur vers l'en face) et la classe est celle du MEILLEUR des
 *  deux cotes. Retourne { features, pctRue, pctCote }. */
export function traceNiveauRue(moteur, plan, trace, cote) {
  const features = [];
  let lTot = 0, oCote = 0, oRue = 0;
  for (const e of plan.etapes) {
    const pts = [];
    for (let s = e.sDebut; s < e.sFin; s += 2) pts.push(pointA(trace, s));
    pts.push(pointA(trace, e.sFin));
    if (pts.length < 2) continue;
    let classe = e.type, coords = pts;
    if (e.type === "trottoir") {
      const o = cote.fractionOmbre(e.i);
      const oo = o === null ? 1 : o;
      let best = oo;
      const v = cote.visAVis(e.i);
      if (v && v.distance_m <= SEUIL_RUE_M) {
        const ov = cote.fractionOmbre(v.i, e.i);
        best = Math.max(oo, ov === null ? 1 : ov);
        const seg = moteur.segments.get(e.i);
        const n = VECTEUR[seg.cote] ?? [0, 0];
        const lat0 = pts[0][1];
        const dLon = 1 / (111320 * Math.cos((lat0 * Math.PI) / 180)), dLat = 1 / 111320;
        coords = pts.map(([lon, la]) => [lon - (n[0] * v.distance_m * dLon) / 2, la - (n[1] * v.distance_m * dLat) / 2]);
      }
      classe = best >= 0.5 ? "ombre" : (o === null && best === 1 ? "indetermine" : "soleil");
      lTot += e.sFin - e.sDebut; oCote += (e.sFin - e.sDebut) * oo; oRue += (e.sFin - e.sDebut) * best;
    }
    features.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords },
                    properties: { classe, sDebut: e.sDebut, sFin: e.sFin } });
  }
  return { features, pctRue: lTot > 0 ? Math.round((100 * oRue) / lTot) : null, pctCote: lTot > 0 ? Math.round((100 * oCote) / lTot) : null };
}

/** Cone de cap (polygone WGS84) pour le marqueur de position. */
function cone(lon, lat, capDeg, longueur_m = 60, demiAngle = 26) {
  const dLon = 1 / (111320 * Math.cos((lat * Math.PI) / 180)), dLat = 1 / 111320;
  const p = (a, r) => [lon + r * Math.sin((a * Math.PI) / 180) * dLon, lat + r * Math.cos((a * Math.PI) / 180) * dLat];
  const arc = [];
  for (let a = capDeg - demiAngle; a <= capDeg + demiAngle; a += 6) arc.push(p(a, longueur_m));
  return [[lon, lat], ...arc, [lon, lat]];
}

const vide = { type: "FeatureCollection", features: [] };

export class ModeGuidage {
  /** ui : { icone, dist, action, detail, minutes, restant, pct, mention, btnRecentrer }
   *  surEtat : rappel ({ etat, ... }) pour la page (demarre, position, arrive, arrete, erreur). */
  constructor({ map, moteur, ui, surEtat = () => {} }) {
    this.map = map; this.moteur = moteur; this.ui = ui; this.surEtat = surEtat;
    this.actif = false; this.source = null; this.wakeLock = null; this.bip = new Bip();
    this.suivreCamera = true; this.dernierePos = null; this.manoeuvresBipees = new Set();
    this.boussole = new Boussole(); this.capBoussole = null; this.capAffiche = null;
    this.posAff = null; this.anim = null; this.journal = null; this.cam = null;
    this.podometre = new Podometre(); this.etatPas = null; this.aimant = null;
    this._surDeplacementUtilisateur = () => { this.suivreCamera = false; this.ui.btnRecentrer.hidden = false; };
    this._surVisibilite = () => { if (document.visibilityState === "visible" && this.actif) this._verrou(); };
  }

  /* ---------------------------------------------------------------- carte */
  _couches() {
    const map = this.map;
    if (map.getSource("g-route")) return;
    map.addSource("g-route", { type: "geojson", data: vide });
    map.addLayer({ id: "g-route-casing", type: "line", source: "g-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#fff", "line-width": 11, "line-opacity": .9 } });
    map.addLayer({ id: "g-route-marche", type: "line", source: "g-route",
      filter: ["!", ["in", ["get", "classe"], ["literal", ["traversee", "liaison"]]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["match", ["get", "classe"], "ombre", COULEUR.ombre, "soleil", COULEUR.soleil, "indetermine", COULEUR.indetermine, "#6a1b9a"],
               "line-width": 6, "line-opacity": ["case", ["get", "fait"], .45, 1] } });
    map.addLayer({ id: "g-route-traversee", type: "line", source: "g-route",
      filter: ["in", ["get", "classe"], ["literal", ["traversee", "liaison"]]],
      paint: { "line-color": "#6a1b9a", "line-width": 4, "line-dasharray": [1, 1.2] } });
    map.addSource("g-cone", { type: "geojson", data: vide });
    map.addLayer({ id: "g-cone", type: "fill", source: "g-cone", paint: { "fill-color": "#38BDF8", "fill-opacity": .2 } });
    map.addSource("g-pos", { type: "geojson", data: vide });
    map.addLayer({ id: "g-pos-halo", type: "circle", source: "g-pos",
      paint: { "circle-radius": ["get", "r"], "circle-color": "#38BDF8", "circle-opacity": .18 } });
    map.addLayer({ id: "g-pos", type: "circle", source: "g-pos",
      paint: { "circle-radius": 9, "circle-color": "#38BDF8", "circle-stroke-width": 3, "circle-stroke-color": "#070E1A" } });
  }
  _retireCouches() {
    for (const id of ["g-pos", "g-pos-halo", "g-cone", "g-route-traversee", "g-route-marche", "g-route-casing"]) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const id of ["g-pos", "g-cone", "g-route"]) if (this.map.getSource(id)) this.map.removeSource(id);
  }
  _couchesPlanificateur(visible) {
    for (const id of ["route-casing", "route-marche", "route-traversee", "points"])
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  }

  /* --------------------------------------------------------------- ecran */
  async _verrou() {
    try { if ("wakeLock" in navigator) this.wakeLock = await navigator.wakeLock.request("screen"); } catch { this.wakeLock = null; }
  }
  _libereVerrou() { try { this.wakeLock?.release(); } catch {} this.wakeLock = null; }

  /* ------------------------------------------------------------- demarrer */
  /** resultat : sortie de moteur.route ; depart, arrivee : [lon, lat] ;
   *  date, heure : la journee et le pas utilises pour cet itineraire ;
   *  repetition : null (GPS reel) ou facteur de vitesse du rejeu (1 = temps reel). */
  /** k, heureCourante() : pour le recalcul du palier 4 (meme k, heure reelle) ;
   *  ecartDemo : en repetition, ecart scripte [{ a_m, longueur_m, cap_relatif_deg }]. */
  async demarrer({ resultat, depart, arrivee, date, heure, repetition = null, k = 0, heureCourante = null, ecartDemo = [], bruit_m = 5,
                   orientation = ORIENTATION_PAR_DEFAUT }) {
    if (this.actif) this.arreter();
    this.arrivee = arrivee; this.k = k; this.heureCourante = heureCourante;
    this.repetition = repetition; this.date = date; this.heure = heure; this.heureFigee = false;
    this.orientationMarche = orientation === "marche";
    this.suivreCamera = true; this.arrive = false; this.dernierRecalcul = 0; this.recalculEnCours = false; this.nRecalculs = 0;
    this.sMax = 0; this.tProgres = performance.now();   // detection des arrets (ARRET_RECALCUL_S)
    this._construit(resultat, depart);
    this.detecteur = new DetecteurEcart(this.moteur, this.trace, this.guidage);
    this._couches();
    this._couchesPlanificateur(false);
    this._majTrace(0);

    // Enregistreur de trace : tout ce que le guidage a vu, pour rejouer un
    // test terrain a l'identique (pwa/nav/rejoue_trace.mjs).
    this.journal = { version: 1, debut: new Date().toISOString(), ville: this.moteur.manifest.ville ?? null,
      depart, arrivee, date, heure, k, repetition, longueur_m: this.trace.longueur, points: [], evenements: [] };
    this.capBoussole = null; this.capAffiche = capA(this.trace, 0);
    this.posAff = new PositionAffichee(this.trace, { facteurTemps: repetition ?? 1 });
    // Aimantation sur le reseau de trottoirs (demande du 2026-09-08).
    this.aimant = new Aimant(this.moteur, this.trace);
    this.posAff.poseAimant(this.aimant);
    if (!repetition) { this.boussole.demarrer((cap) => { this.capBoussole = cap; }); this.podometre.demarrer(); }
    this.etatPas = null;
    this.bip.armer();
    await this._verrou();
    document.addEventListener("visibilitychange", this._surVisibilite);
    this.map.on("dragstart", this._surDeplacementUtilisateur);
    this.map.on("wheel", this._surDeplacementUtilisateur);
    this.ui.btnRecentrer.hidden = true;
    this.ui.mention.textContent = `${repetition ? "Répétition · " : ""}Ombres du ${this._libelleDate(date)} à ${heure}`;

    this.actif = true;
    this.surEtat({ etat: "demarre", repetition: !!repetition, pctRue: this.pctRue, longueur_m: this.trace.longueur });
    this._afficher(this.guidage.rue(0), null);

    const surPosition = (pos) => this._surPosition(pos);
    if (repetition) {
      // bruit_m = 0 : la position est exacte. Indispensable pour juger le
      // rendu, sinon on ne sait pas si ce qu'on voit trembler vient de
      // l'affichage ou du bruit qu'on a soi-meme injecte.
      this.source = new SourceSimulee({ points: this.plan.points, bruit_m, graine: 7, facteurTemps: repetition, ecarts: ecartDemo });
      this.source.demarrer(surPosition);
    } else {
      this.source = new SourceGPS();
      this.source.demarrer(surPosition, (e) => this.surEtat({ etat: "erreur", message: e?.message || "position indisponible" }));
    }
    // Camera : cadrer le depart tout de suite, sans attendre le premier point.
    const [lon, lat] = this.plan.points[0];
    const h = this.map.getContainer().clientHeight;
    this.cam = { lon, lat, cap: this.orientationMarche ? this.capAffiche : 0 };
    this.map.jumpTo({ center: [lon, lat], zoom: ZOOM_MARCHE, bearing: this.cam.cap, padding: { top: h * PADDING_HAUT, bottom: 0, left: 0, right: 0 } });
    this.dernierFait = -1; this.derniereImage = null; this.dernierDessin = 0;
    this.anim = requestAnimationFrame((ts) => this._image(ts));
  }

  /** Trace enregistree pendant ce guidage (objet, ou null avant le premier depart). */
  get trace_enregistree() { return this.journal; }

  /** JSON de la trace enregistree, a partager pour rejouer le test. */
  exporterTrace() { return this.journal ? JSON.stringify(this.journal) : null; }

  /** Plan, trace, guidage, suivi, couleurs niveau rue pour un itineraire (depart, premier ou recalcule). */
  _construit(resultat, depart) {
    const moteur = this.moteur;
    this.plan = planItineraire(moteur, resultat, depart, this.arrivee);
    this.trace = prepareTrace(this.plan.points);
    // Pas de passage de chaque segment du trajet (heure de passage) : les
    // couleurs niveau rue sont lues a l'heure ou l'on y passe, comme le moteur.
    const pasParSegment = new Map();
    for (const { arete, pas } of resultat.aretes ?? []) if (arete.type === "trottoir" && pas !== undefined) pasParSegment.set(arete.i, pas);
    this.cote = new Cote(moteur, this.plan, this.trace, { date: this.date, heure: this.heure, pasParSegment });
    this.guidage = new Guidage(this.plan, this.trace.longueur, { trace: this.trace });
    this.suivi = new SuiviProgression(this.trace);
    this.manoeuvresBipees = new Set(); this.dernierFait = -1;
    const niveauRue = traceNiveauRue(moteur, this.plan, this.trace, this.cote);
    this.features = niveauRue.features; this.pctRue = niveauRue.pctRue;
  }

  /** Palier 4 : recalcul depuis la position reelle, meme k, heure courante.
   *  motif : "ecart" (defaut, le marcheur a quitte l'itineraire) ou "reprise"
   *  (il repart apres un arret : mise a jour discrete, sans le son d'erreur). */
  async _recalcule(pos, motif = "ecart") {
    if (this.recalculEnCours) return;
    this.recalculEnCours = true;
    try {
      // Heure figee : l'utilisateur l'a choisie lui-meme en marchant, elle
      // prime sur l'heure reelle (changeReglages).
      const heure = ((this.repetition || this.heureFigee) ? null : this.heureCourante?.()) || this.heure;
      const r = await this.moteur.route({ depart: [pos.lon, pos.lat], arrivee: this.arrivee, k: this.k, date: this.date, heure });
      if (!this.actif) return;
      if (!r.reachable) { this.surEtat({ etat: "erreur", message: "recalcul impossible depuis ici" }); return; }
      this.heure = r.heure ?? heure;
      this._construit(r, [pos.lon, pos.lat]);
      this.detecteur.reinitialise(this.trace, this.guidage);
      this.posAff?.recaleSur(this.trace);
      this.aimant?.recaleSur(this.trace); this.aimant?.oublie();   // meme comportement que le rejeu (rejoue_trace.mjs)
      this._majTrace(0);
      this.nRecalculs++;
      this.dernierRecalcul = performance.now();
      this.sMax = 0; this.tProgres = this.dernierRecalcul;   // nouvelle trace : l'abscisse repart de zero
      this.journal?.evenements.push({ t: pos.t ?? null, type: "recalcul", motif, n: this.nRecalculs, longueur_m: this.trace.longueur, heure: this.heure });
      if (motif === "reprise") this.bip.jouer([[880, 0.07]]);
      else this.bip.jouer([[660, 0.1], [520, 0.14]]);
      this.ui.mention.textContent = (this.repetition ? "Répétition · " : "")
        + (motif === "reprise" ? `Itinéraire mis à jour · ombres de ${this.heure}` : `Itinéraire recalculé · ombres de ${this.heure}`);
      this.surEtat({ etat: "recalcul", motif, n: this.nRecalculs, heure: this.heure, longueur_m: this.trace.longueur, pctRue: this.pctRue });
      this._afficher(this.guidage.rue(0), null);
    } finally { this.recalculEnCours = false; }
  }

  /** Changer le mode d'ombre, la journee ou l'heure SANS arreter la
   *  navigation, et recalculer depuis la position courante (demande de
   *  Jean-Philippe, 2026-09-08 : garder les reglages en marchant). Le repit
   *  entre deux recalculs ne s'applique pas : c'est une demande explicite,
   *  pas une detection d'ecart. */
  async changeReglages({ k = null, date = null, heure = null } = {}) {
    if (!this.actif || this.recalculEnCours) return false;
    if (k !== null) this.k = k;
    if (date !== null) this.date = date;
    if (heure !== null) { this.heure = heure; this.heureFigee = true; }
    const pos = this.dernierePos;
    if (!pos) return false;
    await this._recalcule({ lon: pos.lon, lat: pos.lat, t: Date.now() });
    return true;
  }

  arreter() {
    if (!this.actif) return;
    this.actif = false;
    try { this.source?.arreter(); } catch {}
    this.source = null;
    this.boussole.arreter(); this.podometre.arreter();
    if (this.anim) { cancelAnimationFrame(this.anim); this.anim = null; }
    this.map.easeTo({ bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 400 });
    if (this.journal) {
      this.journal.fin = new Date().toISOString();
      try { localStorage.setItem("ombra.derniere_trace", JSON.stringify(this.journal)); } catch {}
    }
    this._libereVerrou();
    document.removeEventListener("visibilitychange", this._surVisibilite);
    this.map.off("dragstart", this._surDeplacementUtilisateur);
    this.map.off("wheel", this._surDeplacementUtilisateur);
    this._retireCouches();
    this._couchesPlanificateur(true);
    this.surEtat({ etat: "arrete" });
  }

  recentrer() {
    this.suivreCamera = true; this.ui.btnRecentrer.hidden = true;
  }

  /* ------------------------------------------------------------ position */
  _surPosition(pos) {
    if (!this.actif || this.recalculEnCours) return;
    const r = this.suivi.maj(pos);
    const etat = this.guidage.rue(r.s);
    // Position affichee AVANT la detection : prediction puis correction, et
    // aimantation sur le reseau de trottoirs (position_affichee.js). La rue sur
    // laquelle le point est affiche est le signal d'ecart le plus direct qu'on
    // ait, celui que l'oeil voit : le detecteur le recoit (demande de
    // Jean-Philippe, 2026-09-08, "on le voit nettement a l'ecran").
    const precision = pos.precision_m ?? 10;
    this.posAff.fix(pos, r, performance.now() / 1000);
    // Palier 4 : rue suivie et duree, jamais la distance seule (ecart.js).
    const e = this.detecteur.maj(pos, r, this.posAff.aimante);
    if (e.ecart && !r.arrive && performance.now() - this.dernierRecalcul > REPIT_RECALCUL_MS) {
      this.surEtat({ etat: "ecart", motif: e.motif, rueSuivie: e.rueSuivie, rueAttendue: e.rueAttendue });
      this._recalcule(pos);
      return;
    }
    // Reprise apres un arret (heure de passage) : l'abscisse sur la trace n'a
    // pas avance pendant ARRET_RECALCUL_S et repart. Uniquement en reel : en
    // repetition l'horloge est simulee, et une heure figee par l'utilisateur
    // prime sur l'heure courante (changeReglages).
    if (r.s > this.sMax + ARRET_PROGRES_M) {
      const arretS = (performance.now() - this.tProgres) / 1000;
      this.sMax = r.s; this.tProgres = performance.now();
      const heureReelle = (!this.repetition && !this.heureFigee) ? this.heureCourante?.() : null;
      if (arretS >= ARRET_RECALCUL_S && !r.arrive && heureReelle) {
        this.journal?.evenements.push({ t: pos.t ?? null, type: "reprise", arret_s: Math.round(arretS) });
        this.surEtat({ etat: "reprise", arret_s: arretS });
        this._recalcule(pos, "reprise");
        return;
      }
    }
    this.enMarche = (pos.vitesse ?? 0) >= VITESSE_CAP && pos.cap !== null && pos.cap !== undefined;
    this.dernierePos = { lon: pos.lon, lat: pos.lat, precision_m: precision, s: r.s };
    this.journal?.points.push({ t: pos.t ?? null, lon: pos.lon, lat: pos.lat, prec: precision, cap: pos.cap ?? null, v: pos.vitesse ?? null,
      boussole: this.capBoussole, pas: this.etatPas?.pas ?? null, cadence: this.etatPas ? Math.round(this.etatPas.cadence * 100) / 100 : null,
      aimant: this.posAff.aimante ? { d: Math.round(this.posAff.aimante.d * 10) / 10, rue: this.posAff.aimante.rue, cote: this.posAff.aimante.cote } : null,
      s: Math.round(r.s * 10) / 10, ecart_m: r.ecart_m == null ? null : Math.round(r.ecart_m * 10) / 10,
      conf: r.confiance == null ? null : Math.round(r.confiance * 100) / 100, hors: !!e.hors, motif: e.motif ?? null, depuis_s: Math.round((e.depuis_s ?? 0) * 10) / 10 });
    this._majTrace(r.s);

    // Bip : une fois par manoeuvre, a l'annonce (25 m).
    if (etat.annonce && !this.manoeuvresBipees.has(etat.instruction.index)) {
      this.manoeuvresBipees.add(etat.instruction.index);
      this.bip.jouer(etat.manoeuvre.type === "tourner" ? [[880, 0.09], [1175, 0.12]] : [[880, 0.09]]);
    }
    this._afficher(etat, r);
    if (r.arrive && !this.arrive) {
      this.arrive = true;
      this.bip.jouer([[880, 0.09], [1175, 0.09], [1568, 0.16]]);
      this.surEtat({ etat: "arrive" });
    }
    this.surEtat({ etat: "position", s: r.s, confiance: r.confiance, ecart_m: r.ecart_m, rue: etat.rue, arrive: r.arrive, pos, cap: this.capAffiche });
  }

  /** Boucle d'image : position predite/corrigee, faisceau, camera. 30 images par seconde au plus. */
  _image(ts) {
    if (!this.actif) { this.anim = null; return; }
    this.anim = requestAnimationFrame((t2) => this._image(t2));
    if (this.derniereImage === null) { this.derniereImage = ts; return; }
    const dt = Math.min(0.25, (ts - this.derniereImage) / 1000); this.derniereImage = ts;   // plafond 0,25 s : un onglet ralenti (Chromium sans tete : 8 images/s) ne doit pas freiner la prediction
    if (!this.posAff.p) return;
    if (this.podometre.actif) { this.etatPas = this.podometre.etat(ts / 1000); this.posAff.podometre(this.etatPas, ts / 1000); }
    this.posAff.image(dt, ts / 1000);
    const [lon, lat] = this.posAff.lonLat;
    // Cap affiche : route GPS en marche, boussole a l'arret, trace a defaut ; lisse.
    const capCible = (this.enMarche && this.posAff.cap !== null) ? this.posAff.cap : (this.capBoussole ?? this.posAff.cap ?? capA(this.trace, this.dernierePos?.s ?? 0));
    const delta = this.capAffiche === null ? 0 : ecartCap(this.capAffiche, capCible);
    if (this.capAffiche === null) this.capAffiche = capCible;
    else if (Math.abs(delta) >= CAP_ZONE_MORTE_DEG) this.capAffiche += delta * Math.min(1, dt * (Math.abs(delta) >= CAP_VIRAGE_DEG ? LISSAGE_CAP_VIRAGE : LISSAGE_CAP));
    // Camera : suit le point avec un lissage ; l'orientation suit le cap affiche (deja lisse) sans re-lissage.
    if (this.suivreCamera && this.cam) {
      this.cam.lon += (lon - this.cam.lon) * Math.min(1, dt * LISSAGE_CAMERA); this.cam.lat += (lat - this.cam.lat) * Math.min(1, dt * LISSAGE_CAMERA);
      // Le cone tourne toujours avec la marche ; la CARTE, elle, ne tourne que
      // si on le lui demande (voir ORIENTATION_PAR_DEFAUT).
      this.cam.cap = this.orientationMarche ? this.capAffiche : 0;
    }
    if (ts - this.dernierDessin < CADENCE_IMAGE_MS) return;
    this.dernierDessin = ts;
    this._dessineMarqueur(lon, lat, this.dernierePos?.precision_m ?? 10);
    if (this.suivreCamera && this.cam) {
      const h = this.map.getContainer().clientHeight;
      this.map.jumpTo({ center: [this.cam.lon, this.cam.lat], bearing: this.cam.cap, zoom: Math.max(this.map.getZoom(), ZOOM_MARCHE), padding: { top: h * PADDING_HAUT, bottom: 0, left: 0, right: 0 } });
    }
  }

  _dessineMarqueur(lon, lat, precision) {
    this.map.getSource("g-pos")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { r: Math.max(14, Math.min(40, precision * 1.2)) } }] });
    this.map.getSource("g-cone")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Polygon", coordinates: [cone(lon, lat, this.capAffiche ?? 0)] }, properties: {} }] });
  }

  _majTrace(s) {
    const src = this.map.getSource("g-route"); if (!src) return;
    // Seulement quand un troncon de plus est parcouru : pas de reconstruction a chaque point.
    let nFait = 0; for (const f of this.features) if (f.properties.sFin <= s) nFait++;
    if (nFait === this.dernierFait) return;
    this.dernierFait = nFait;
    src.setData({ type: "FeatureCollection", features: this.features.map((f) => ({ ...f, properties: { ...f.properties, fait: f.properties.sFin <= s } })) });
  }

  _afficher(etat, r) {
    const ui = this.ui; if (!etat) return;
    const m = etat.manoeuvre;
    const d10 = (x) => `${Math.max(10, Math.round(x / 10) * 10)} m`;
    const nomRue = etat.rue || "trottoir sans nom";
    if (m.type === "arrivee") {
      ui.icone.textContent = "◎";
      ui.dist.textContent = d10(etat.distance_m);
      ui.action.textContent = etat.distance_m < 20 ? "Vous êtes arrivé" : `Continuez ${nomRue}`;
      ui.detail.textContent = "jusqu'à l'arrivée";
    } else if (etat.annonce && m.type === "tourner") {
      ui.icone.textContent = m.direction === "gauche" ? "↰" : m.direction === "droite" ? "↱" : "↶";
      ui.dist.textContent = d10(etat.distance_m);
      ui.action.textContent = m.direction === "demi-tour" ? "Faites demi-tour" : `Tournez à ${m.direction}`;
      ui.detail.textContent = (m.rue || "") + (m.traversee ? " · traversez" : "");
    } else {
      ui.icone.textContent = "↑";
      ui.dist.textContent = d10(etat.distance_m);
      ui.action.textContent = `Continuez ${nomRue}`;
      ui.detail.textContent = m.type === "tourner" ? `puis à ${m.direction}${m.rue ? ", " + m.rue : ""}` : `puis continuez${m.rue ? " " + m.rue : ""}`;
    }
    const restant = etat.restant_total_m;
    ui.minutes.textContent = `${Math.max(1, Math.round(restant / VITESSE_MARCHE / 60))} min`;
    ui.restant.textContent = `${d10(restant)} · `;
    ui.pct.textContent = this.pctRue === null ? "ombre non évaluée" : `${this.pctRue} % à l'ombre`;
  }

  _libelleDate(iso) {
    try { return new Date(iso + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); } catch { return iso; }
  }
}
