/* Construction de la trace continue d'un itineraire (phase 4, palier 1).
 *
 * POURQUOI CE FICHIER EXISTE. `MoteurOmbra.detaillerTrace` renvoie des
 * troncons destines a l'AFFICHAGE : chaque troncon porte la geometrie brute du
 * segment de trottoir, dans l'ordre de stockage et non dans le sens de la
 * marche. Pour dessiner des lignes colorees, le sens n'a aucune importance.
 * Pour simuler un marcheur, il en a toute : concatener ces troncons tels quels
 * produit une trace en zigzag qui fait plus du double de la vraie longueur
 * (mesure du 2026-08-30 : 2547 m concatenes contre 1115 m d'itineraire reel).
 *
 * On reconstruit donc la trace depuis `resultat.aretes`, en orientant chaque
 * geometrie par les noeuds de l'arete, et en recalant ses extremites sur les
 * coordonnees des noeuds : les geometries exportees sont quantifiees, leurs
 * bouts ne coincident pas exactement avec les noeuds et laissaient des sauts
 * (jusqu'a 4,2 m), qu'un detecteur d'ecart prendrait pour un saut GPS.
 */

import { wgs84VersL93 } from "../moteur.js";

/** Construit la trace ET les plages d'abscisses par arete.
 *  Retourne { points, etapes: [{ sDebut, sFin, type, rue, cote, source, i }] }. */
export function planItineraire(moteur, resultat, departWgs, arriveeWgs) {
  const pts = [];
  const etapes = [];
  let cumul = 0;

  const wgs = (n) =>
    typeof n === "string" ? (n === "virtuel_depart" ? departWgs : arriveeWgs) : moteur.noeudsWgs.get(n);

  const pousse = ([lon, lat]) => {
    const d = pts[pts.length - 1];
    if (d && d[0] === lon && d[1] === lat) return 0;
    let ajout = 0;
    if (d) {
      const a = wgs84VersL93(d[0], d[1]), b = wgs84VersL93(lon, lat);
      ajout = Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    pts.push([lon, lat]);
    cumul += ajout;
    return ajout;
  };

  for (const { de, vers, arete } of resultat.aretes) {
    const sDebut = cumul;
    if (arete.type === "trottoir") {
      const s = moteur.segments.get(arete.i);
      let g = de === s.b ? [...s.geom].reverse() : s.geom;
      const a = wgs(de), b = wgs(vers);
      g = g.slice();
      if (a) g[0] = a;
      if (b) g[g.length - 1] = b;
      for (const c of g) pousse(c);
      etapes.push({ sDebut, sFin: cumul, type: "trottoir", rue: s.rue || null,
                    cote: s.cote || null, source: null, i: arete.i });
    } else {
      const a = wgs(de), b = wgs(vers);
      if (a) pousse(a);
      if (b) pousse(b);
      etapes.push({ sDebut, sFin: cumul,
                    type: arete.type === "traversee" ? "traversee" : "liaison",
                    rue: null, cote: null, source: arete.src ?? null, i: null });
    }
  }
  return { points: pts, etapes };
}

/** Trace seule, pour les usages qui n'ont pas besoin des plages. */
export function traceItineraire(moteur, resultat, departWgs, arriveeWgs) {
  return planItineraire(moteur, resultat, departWgs, arriveeWgs).points;
}
