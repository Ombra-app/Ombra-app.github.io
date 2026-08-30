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

/** Trace continue [[lon,lat], ...] dans le sens de la marche.
 *  moteur : MoteurOmbra deja charge ; resultat : sortie de moteur.route(). */
export function traceItineraire(moteur, resultat, departWgs, arriveeWgs) {
  const pts = [];
  const pousse = ([lon, lat]) => {
    const d = pts[pts.length - 1];
    if (!d || d[0] !== lon || d[1] !== lat) pts.push([lon, lat]);
  };
  const wgs = (n) =>
    typeof n === "string" ? (n === "virtuel_depart" ? departWgs : arriveeWgs) : moteur.noeudsWgs.get(n);

  for (const { de, vers, arete } of resultat.aretes) {
    if (arete.type === "trottoir") {
      const s = moteur.segments.get(arete.i);
      let g;
      if (de === s.a) g = s.geom;
      else if (de === s.b) g = [...s.geom].reverse();
      else g = s.geom;                        // ne devrait pas arriver
      // Recalage des extremites sur les noeuds : supprime les sauts de jonction.
      const a = wgs(de), b = wgs(vers);
      g = g.slice();
      if (a) g[0] = a;
      if (b) g[g.length - 1] = b;
      for (const c of g) pousse(c);
    } else {
      // Traversee ou rattachement virtuel : segment droit entre les deux bouts.
      const a = wgs(de), b = wgs(vers);
      if (a) pousse(a);
      if (b) pousse(b);
    }
  }
  return pts;
}
