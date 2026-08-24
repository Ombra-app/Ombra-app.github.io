/* Moteur de routage Ombra embarque (phase 3, palier 2).
 *
 * JS pur, zero dependance, meme moteur dans le navigateur (PWA) et dans
 * Node (test de parite). Ne depend QUE du format d'export decrit dans
 * pwa/FORMAT.md - jamais du code Python. Le contrat de parite avec le
 * moteur Python (ombra.graph) est OBLIGATOIRE : couts, plafond, regles
 * de doublons identiques ; la parite est verifiee par pwa/test_parite.mjs
 * contre des fixtures generees par le moteur Python (a rejouer a chaque
 * evolution du modele).
 *
 * Echelle (amendement BRIEF_PHASE3) : chargement PARESSEUX des tuiles
 * (on ne charge que celles utiles au trajet + une marge) et A* plutot que
 * Dijkstra complet - heuristique = distance a vol d'oiseau, admissible
 * car le cout d'une arete est toujours >= sa longueur (k et couts de
 * traversee ne font qu'ajouter) : resultat identique a Dijkstra,
 * exploration bien moindre.
 */

// --- Constantes de cout : MIROIR EXACT de ombra.graph (contrat de parite) ---
export const COUT_TRAVERSEE_PASSAGE_M = 15.0;
export const COUT_TRAVERSEE_CARREFOUR_M = 30.0;
export const PLAFOND_DETOUR_DEFAUT = 1.5;
export const PAS_REDUCTION_K = 2.0;
export const K_MIN_REDUCTION = 0.25;

// --- Projection WGS84 -> Lambert-93 (EPSG:2154, conique conforme 2 paralleles).
// Necessaire pour reproduire le rattachement metrique du moteur Python
// (plus proche segment, projections en metres). Constantes RGF93/GRS80.
const A = 6378137.0;
const F = 1 / 298.257222101;
const E = Math.sqrt(2 * F - F * F);
const DEG = Math.PI / 180;
const LAT0 = 46.5 * DEG, LON0 = 3 * DEG, LAT1 = 44 * DEG, LAT2 = 49 * DEG;
const X0 = 700000.0, Y0 = 6600000.0;
function _m(phi) { const s = Math.sin(phi); return Math.cos(phi) / Math.sqrt(1 - E * E * s * s); }
function _t(phi) {
  const s = Math.sin(phi);
  return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - E * s) / (1 + E * s), E / 2);
}
const _N = (Math.log(_m(LAT1)) - Math.log(_m(LAT2))) / (Math.log(_t(LAT1)) - Math.log(_t(LAT2)));
const _F93 = _m(LAT1) / (_N * Math.pow(_t(LAT1), _N));
const _RHO0 = A * _F93 * Math.pow(_t(LAT0), _N);
export function wgs84VersL93(lon, lat) {
  const rho = A * _F93 * Math.pow(_t(lat * DEG), _N);
  const gamma = _N * (lon * DEG - LON0);
  return [X0 + rho * Math.sin(gamma), Y0 + _RHO0 - rho * Math.cos(gamma)];
}

function coutFixeTraversee(arete) {
  if (arete.type !== "traversee") return 0;
  return arete.src === "osm_crossing" ? COUT_TRAVERSEE_PASSAGE_M : COUT_TRAVERSEE_CARREFOUR_M;
}

function coutArete(arete, k, fractionSoleil, facteurTraversee) {
  return arete.l * (1 + k * fractionSoleil) + facteurTraversee * coutFixeTraversee(arete);
}

// --- File de priorite (tas binaire minimal) pour l'A* ---
class Tas {
  constructor() { this.t = []; }
  get taille() { return this.t.length; }
  pousse(prio, val) {
    const t = this.t; t.push([prio, val]);
    let i = t.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (t[p][0] <= t[i][0]) break; [t[p], t[i]] = [t[i], t[p]]; i = p; }
  }
  tire() {
    const t = this.t, haut = t[0], fin = t.pop();
    if (t.length) {
      t[0] = fin; let i = 0;
      for (;;) {
        const g = 2 * i + 1, d = g + 1; let m = i;
        if (g < t.length && t[g][0] < t[m][0]) m = g;
        if (d < t.length && t[d][0] < t[m][0]) m = d;
        if (m === i) break; [t[m], t[i]] = [t[i], t[m]]; i = m;
      }
    }
    return haut;
  }
}

export class MoteurOmbra {
  /**
   * @param manifest contenu de manifest.json
   * @param chargeurTuile async (id) => contenu de tuiles/<id>.json
   * @param chargeurOmbres async (date, id) => contenu de ombres/<date>/<id>.json
   */
  constructor(manifest, chargeurTuile, chargeurOmbres) {
    this.manifest = manifest;
    this.chargeurTuile = chargeurTuile;
    this.chargeurOmbres = chargeurOmbres;
    this.noeuds = new Map();        // id -> [x, y] L93
    this.noeudsWgs = new Map();     // id -> [lon, lat] (pour le rendu)
    this.adj = new Map();           // id -> Map(voisin -> arete)
    this.segments = new Map();      // i global -> {a, b, l, geomL93, longsCumulees, rue, cote}
    this.ombres = new Map();        // "date" -> {pas: [...], v: Map(i -> Uint8Array)}
    this.tuilesChargees = new Set();
    this._segTries = [];            // segments {i, ...} tries par i (ordre "le dernier gagne")
    this._traversees = [];          // en attente d'application apres les segments
  }

  _poseArete(a, b, arete) {
    if (!this.adj.has(a)) this.adj.set(a, new Map());
    if (!this.adj.has(b)) this.adj.set(b, new Map());
    this.adj.get(a).set(b, arete);
    this.adj.get(b).set(a, arete);
  }

  async chargeTuiles(ids) {
    const nouvelles = ids.filter((id) => !this.tuilesChargees.has(id));
    if (!nouvelles.length) return;
    for (const id of nouvelles) {
      const t = await this.chargeurTuile(id);
      this.tuilesChargees.add(id);
      for (const [nid, lon, lat] of t.noeuds) {
        if (!this.noeuds.has(nid)) { this.noeuds.set(nid, wgs84VersL93(lon, lat)); this.noeudsWgs.set(nid, [lon, lat]); }
      }
      for (const s of t.segments) {
        const geomL93 = s.geom.map(([lon, lat]) => wgs84VersL93(lon, lat));
        const longs = [0];
        for (let p = 1; p < geomL93.length; p++) {
          const dx = geomL93[p][0] - geomL93[p - 1][0], dy = geomL93[p][1] - geomL93[p - 1][1];
          longs.push(longs[p - 1] + Math.hypot(dx, dy));
        }
        this.segments.set(s.i, { ...s, geomL93, longs });
        this._segTries.push(s);
      }
      for (const tr of t.traversees) this._traversees.push(tr);
    }
    // Reconstruction deterministe des aretes : contrat de parite -
    // segments en ordre d'index global croissant (le dernier gagne), puis
    // traversees SANS ecraser une arete existante (comme build_graph).
    this.adj = new Map();
    this._segTries.sort((s1, s2) => s1.i - s2.i);
    for (const s of this._segTries) this._poseArete(s.a, s.b, { type: "trottoir", l: s.l, i: s.i });
    for (const tr of this._traversees) {
      if (this.adj.has(tr.a) && this.adj.get(tr.a).has(tr.b)) continue;
      this._poseArete(tr.a, tr.b, { type: "traversee", l: tr.l, src: tr.src });
    }
  }

  async chargeToutesLesTuiles() {
    await this.chargeTuiles(this.manifest.tuiles.map((t) => t.id));
  }

  /** Tuiles utiles a un trajet : celles dont la case 1 km intersecte le
   * rectangle depart-arrivee dilate d'une marge (le detour "ombre max"
   * reste sous plafond x distance directe, la marge couvre largement). */
  tuilesPourTrajet(departL93, arriveeL93, margeM = 700) {
    const taille = this.manifest.taille_tuile_m;
    const xMin = Math.min(departL93[0], arriveeL93[0]) - margeM, xMax = Math.max(departL93[0], arriveeL93[0]) + margeM;
    const yMin = Math.min(departL93[1], arriveeL93[1]) - margeM, yMax = Math.max(departL93[1], arriveeL93[1]) + margeM;
    return this.manifest.tuiles.map((t) => t.id).filter((id) => {
      const [tx, ty] = id.split("_").map(Number);
      return tx * taille < xMax && (tx + 1) * taille > xMin && ty * taille < yMax && (ty + 1) * taille > yMin;
    });
  }

  async chargeOmbres(date) {
    if (this.ombres.has(date)) return;
    const pasListe = this.manifest.dates[date];
    if (!pasListe) throw new Error(`date non exportee : ${date}`);
    const v = new Map();
    const conf = new Map();
    for (const id of this.tuilesChargees) {
      const o = await this.chargeurOmbres(date, id);
      const brut = Uint8Array.from(atob(o.v), (c) => c.charCodeAt(0));
      const confPack = Uint8Array.from(atob(o.conf), (c) => c.charCodeAt(0));
      const nPas = o.pas.length;
      o.seg.forEach((i, p) => {
        v.set(i, brut.subarray(p * nPas, (p + 1) * nPas));
        // Depaquetage du bitset confiance (np.packbits : gros bits d'abord).
        const bits = new Uint8Array(nPas);
        for (let j = 0; j < nPas; j++) {
          const idx = p * nPas + j;
          bits[j] = (confPack[idx >> 3] >> (7 - (idx & 7))) & 1;
        }
        conf.set(i, bits);
      });
    }
    this.ombres.set(date, { pas: pasListe, v, conf });
  }

  _fractionSoleil(date, indexPas, arete) {
    if (arete.type !== "trottoir") return 0;
    const o = this.ombres.get(date);
    const val = o.v.get(arete.i)[indexPas];
    return val === 255 ? 0 : 1 - val / 100; // 255 = indetermine = ombre (contrat)
  }

  _rattache(pointL93) {
    // Plus proche segment (projection orthogonale sur chaque troncon de la
    // polyligne), comme attach_point cote Python. Balayage lineaire des
    // segments charges : quelques ms pour des dizaines de milliers.
    let meilleur = null;
    for (const s of this.segments.values()) {
      const g = s.geomL93;
      for (let p = 1; p < g.length; p++) {
        const ax = g[p - 1][0], ay = g[p - 1][1], bx = g[p][0], by = g[p][1];
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((pointL93[0] - ax) * dx + (pointL93[1] - ay) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(pointL93[0] - px, pointL93[1] - py);
        if (!meilleur || d < meilleur.d) {
          meilleur = { d, s, projection: s.longs[p - 1] + t * Math.hypot(dx, dy), point: [px, py] };
        }
      }
    }
    const longueurGeom = meilleur.s.longs[meilleur.s.longs.length - 1];
    return {
      segment: meilleur.s,
      projection_m: meilleur.projection,
      distance_fin_m: longueurGeom - meilleur.projection,
      point_projete: meilleur.point,
      distance_au_trottoir_m: meilleur.d,
    };
  }

  _astar(attDepart, attArrivee, date, indexPas, k, facteurTraversee) {
    const DEPART = "virtuel_depart", ARRIVEE = "virtuel_arrivee";
    // Aretes virtuelles d'attache (type "attache" : ni cout de traversee ni ombre).
    const virtuelles = new Map(); // noeud -> [{vers, arete}]
    const ajouteVirtuelle = (n1, n2, l) => {
      const arete = { type: "attache", l };
      if (!virtuelles.has(n1)) virtuelles.set(n1, []);
      if (!virtuelles.has(n2)) virtuelles.set(n2, []);
      virtuelles.get(n1).push({ vers: n2, arete });
      virtuelles.get(n2).push({ vers: n1, arete });
    };
    ajouteVirtuelle(DEPART, attDepart.segment.a, attDepart.projection_m);
    ajouteVirtuelle(DEPART, attDepart.segment.b, attDepart.distance_fin_m);
    ajouteVirtuelle(ARRIVEE, attArrivee.segment.a, attArrivee.projection_m);
    ajouteVirtuelle(ARRIVEE, attArrivee.segment.b, attArrivee.distance_fin_m);
    if (attDepart.segment.i === attArrivee.segment.i) {
      ajouteVirtuelle(DEPART, ARRIVEE, Math.abs(attDepart.projection_m - attArrivee.projection_m));
    }
    const cible = attArrivee.point_projete;
    const h = (n) => {
      if (n === ARRIVEE) return 0;
      const p = n === DEPART ? attDepart.point_projete : this.noeuds.get(n);
      return Math.hypot(p[0] - cible[0], p[1] - cible[1]);
    };
    const gScore = new Map([[DEPART, 0]]);
    const precedent = new Map();
    const clos = new Set();
    const tas = new Tas();
    tas.pousse(h(DEPART), DEPART);
    while (tas.taille) {
      const [, n] = tas.tire();
      if (clos.has(n)) continue;
      clos.add(n);
      if (n === ARRIVEE) break;
      const voisins = [];
      const reelles = this.adj.get(n);
      if (reelles) for (const [vers, arete] of reelles) voisins.push({ vers, arete });
      const virt = virtuelles.get(n);
      if (virt) for (const va of virt) voisins.push(va);
      for (const { vers, arete } of voisins) {
        if (clos.has(vers)) continue;
        const g = gScore.get(n) + coutArete(arete, k, this._fractionSoleil(date, indexPas, arete), facteurTraversee);
        if (gScore.has(vers) && g >= gScore.get(vers)) continue;
        gScore.set(vers, g);
        precedent.set(vers, [n, arete]);
        tas.pousse(g + h(vers), vers);
      }
    }
    if (!precedent.has(ARRIVEE)) return { reachable: false };
    // Remontee du chemin + statistiques reelles (memes definitions que Python).
    const aretes = [];
    let n = ARRIVEE;
    while (n !== DEPART) { const [prec, arete] = precedent.get(n); aretes.push({ de: prec, vers: n, arete }); n = prec; }
    aretes.reverse();
    let distance = 0, cout = 0, ombre = 0, soleil = 0, nonEvaluee = 0, traversees = 0;
    for (const { arete } of aretes) {
      const fs = this._fractionSoleil(date, indexPas, arete);
      distance += arete.l;
      cout += coutArete(arete, k, fs, facteurTraversee);
      if (arete.type === "traversee") traversees += 1;
      if (arete.type === "trottoir") { soleil += arete.l * fs; ombre += arete.l * (1 - fs); }
      else nonEvaluee += arete.l;
    }
    const evaluee = ombre + soleil;
    return {
      reachable: true,
      distance_m: distance, cout_pondere: cout,
      distance_ombre_m: ombre, distance_soleil_m: soleil, distance_non_evaluee_m: nonEvaluee,
      fraction_ombre_trajet: evaluee > 0 ? ombre / evaluee : null,
      nb_traversees: traversees,
      aretes,
    };
  }

  /** Itineraire avec plafond de detour : MIROIR de graph.route_avec_plafond. */
  async route({ depart, arrivee, k = 0, date, heure, facteurTraversee = 1.0, plafondDetour = PLAFOND_DETOUR_DEFAUT, chargerToutes = false }) {
    const departL93 = wgs84VersL93(depart[0], depart[1]);
    const arriveeL93 = wgs84VersL93(arrivee[0], arrivee[1]);
    await this.chargeTuiles(chargerToutes ? this.manifest.tuiles.map((t) => t.id) : this.tuilesPourTrajet(departL93, arriveeL93));
    await this.chargeOmbres(date);
    const pasListe = this.ombres.get(date).pas;
    // Arrondi au pas INFERIEUR, comme TimeStepCache.arrondir.
    const [hh, mm] = heure.split(":").map(Number);
    const pasMin = this.manifest.pas_minutes;
    const arrondie = `${String(hh).padStart(2, "0")}:${String(Math.floor(mm / pasMin) * pasMin).padStart(2, "0")}`;
    const indexPas = pasListe.indexOf(arrondie);
    if (indexPas < 0) throw new Error(`pas de temps ${arrondie} absent pour ${date}`);

    const attDepart = this._rattache(departL93);
    const attArrivee = this._rattache(arriveeL93);
    const base = this._astar(attDepart, attArrivee, date, indexPas, 0, facteurTraversee);
    if (!base.reachable) return { reachable: false, message: "Aucun chemin trouve : point isole du reseau." };
    let resultat = base, kEffectif = 0, plafonne = false;
    if (k > 0) {
      kEffectif = k;
      resultat = this._astar(attDepart, attArrivee, date, indexPas, kEffectif, facteurTraversee);
      while (resultat.distance_m > plafondDetour * base.distance_m && kEffectif / PAS_REDUCTION_K >= K_MIN_REDUCTION) {
        plafonne = true;
        kEffectif = kEffectif / PAS_REDUCTION_K;
        resultat = this._astar(attDepart, attArrivee, date, indexPas, kEffectif, facteurTraversee);
      }
      if (resultat.distance_m > plafondDetour * base.distance_m) { plafonne = true; kEffectif = 0; resultat = base; }
    }
    return {
      ...resultat,
      distance_direct_m: base.distance_m,
      ratio_detour: base.distance_m > 0 ? resultat.distance_m / base.distance_m : 1,
      k_demande: k, k_effectif: kEffectif, plafonne,
      heure: arrondie, date,
    };
  }

  /** Trace par troncon (classes ombre/soleil/indetermine/traversee) +
   * instructions lisibles - MIROIR de la logique de /api/route (phase 2,
   * palier 6) : groupes par (rue, cote boussole), traversees intercalees,
   * marqueurs "couvert" et "fiabilite faible". Pour le rendu uniquement. */
  detaillerTrace(resultat, departWgs, arriveeWgs) {
    const o = this.ombres.get(resultat.date);
    const indexPas = o.pas.indexOf(resultat.heure);
    const troncons = [];
    const instructions = [];
    let groupe = null, reportLiaison = 0;
    const clore = () => {
      if (!groupe) return;
      const evaluee = groupe.dOmbre + groupe.dSoleil;
      instructions.push({
        type: "marche",
        texte: (groupe.rue || "trottoir sans nom") + (groupe.cote ? `, cote ${groupe.cote}` : ""),
        distance_m: Math.round(groupe.distance),
        pct_ombre: evaluee > 0 ? Math.round(100 * groupe.dOmbre / evaluee) : null,
        indetermine: groupe.indetermine, confiance_faible: groupe.faible,
      });
      groupe = null;
    };
    for (const { de, vers, arete } of resultat.aretes) {
      if (arete.type === "trottoir") {
        const s = this.segments.get(arete.i);
        const val = o.v.get(arete.i)[indexPas];
        const faible = o.conf.get(arete.i)[indexPas] === 1;
        const indet = val === 255;
        const classe = indet ? "indetermine" : (val >= 50 ? "ombre" : "soleil");
        troncons.push({ classe, coords: s.geom, confiance_faible: faible });
        const cle = `${s.rue}|${s.cote}`;
        if (!groupe || groupe.cle !== cle) { clore(); groupe = { cle, rue: s.rue, cote: s.cote, distance: reportLiaison, dOmbre: 0, dSoleil: 0, indetermine: false, faible: false }; reportLiaison = 0; }
        groupe.distance += arete.l;
        if (indet) groupe.indetermine = true;
        else { groupe.dOmbre += arete.l * (val / 100); groupe.dSoleil += arete.l * (1 - val / 100); }
        if (faible) groupe.faible = true;
      } else if (arete.type === "traversee") {
        clore();
        troncons.push({ classe: "traversee", coords: [this.noeudsWgs.get(de), this.noeudsWgs.get(vers)] });
        instructions.push({
          type: "traversee",
          texte: arete.src === "osm_crossing" ? "Traverser au passage pieton" : "Traverser au carrefour",
          distance_m: Math.round(arete.l), pct_ombre: null, indetermine: false, confiance_faible: false,
        });
      } else { // attache virtuelle depart/arrivee
        const p1 = typeof de === "string" ? (de === "virtuel_depart" ? departWgs : arriveeWgs) : this.noeudsWgs.get(de);
        const p2 = typeof vers === "string" ? (vers === "virtuel_depart" ? departWgs : arriveeWgs) : this.noeudsWgs.get(vers);
        troncons.push({ classe: "liaison", coords: [p1, p2] });
        if (groupe) groupe.distance += arete.l; else reportLiaison += arete.l;
      }
    }
    clore();
    if (reportLiaison > 0 && instructions.length) instructions[instructions.length - 1].distance_m += Math.round(reportLiaison);
    return { troncons, instructions };
  }

  /** Trottoirs colores pour l'affichage (GeoJSON), depuis les tuiles
   * chargees et les valeurs d'ombre de l'instant. Remplace la couche
   * /api/sidewalks de la version Mac (les polygones d'ombre, non exportes,
   * ne sont pas affiches dans la PWA - limite documentee). */
  trottoirsGeoJSON(date, heureArrondie) {
    const o = this.ombres.get(date);
    const indexPas = o.pas.indexOf(heureArrondie);
    const features = [];
    for (const s of this.segments.values()) {
      const arr = o.v.get(s.i);
      if (!arr) continue;
      const val = arr[indexPas];
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: s.geom },
        properties: {
          fraction_ombre: val === 255 ? null : val / 100,
          indetermine: val === 255,
          confiance_faible: o.conf.get(s.i)[indexPas] === 1,
        },
      });
    }
    return { type: "FeatureCollection", features };
  }
}
