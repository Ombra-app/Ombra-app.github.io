/* Verification du suivi de progression (phase 4, palier 2).
 * Lancement : node pwa/nav/test_suivi.mjs (depuis la racine du depot).
 *
 * Les seuils viennent du BRIEF_PHASE4 : sans bruit l'abscisse suivie colle a
 * moins de 5 m ; sous bruit 15 m la progression reste monotone et l'erreur
 * finale sous 20 m. Tout est rejouable a graine fixee.
 */
import { readFileSync } from "node:fs";
import { MoteurOmbra, wgs84VersL93 } from "../moteur.js";
import { SourceSimulee, prepareTrace } from "./source_position.js";
import { traceItineraire } from "./trace.js";
import { SuiviProgression } from "./suivi.js";

const RACINE = new URL("../..", import.meta.url).pathname;
const DATA = `${RACINE}pwa/data/paris`;
const lis = (p) => JSON.parse(readFileSync(p, "utf8"));
const manifest = lis(`${DATA}/manifest.json`);
const moteur = new MoteurOmbra(manifest,
  async (id) => lis(`${DATA}/tuiles/${id}.json`),
  async (d, id) => lis(`${DATA}/ombres/${d}/${id}.json`));

const DATE = Object.keys(manifest.dates).sort().pop();
const HEURE = manifest.dates[DATE].includes("15:00") ? "15:00" : manifest.dates[DATE][0];
const depart = [2.3625, 48.8590], arrivee = [2.3535, 48.8555];
const res = await moteur.route({ depart, arrivee, k: 4, date: DATE, heure: HEURE, chargerToutes: true });
const points = traceItineraire(moteur, res, depart, arrivee);
const trace = prepareTrace(points);

let echecs = 0;
const verifie = (nom, ok, detail) => {
  console.log(`${ok ? "OK    " : "ECHEC "} ${nom}${detail ? " : " + detail : ""}`);
  if (!ok) echecs += 1;
};

/** Rejoue une source et compare l'abscisse suivie a l'abscisse vraie. */
function rejoue({ bruit_m, graine = 42, ecarts = [] }) {
  const src = new SourceSimulee({ points, bruit_m, graine, ecarts });
  const suivi = new SuiviProgression(trace);
  const lignes = [];
  for (const p of src.positions()) {
    const r = suivi.maj({ lon: p.lon, lat: p.lat, precision_m: p.precision_m, t: p.t });
    lignes.push({ suivi: r.s, vrai: p._vrai.s, ecart_m: r.ecart_m,
                  horsTrace: p._vrai.hors_trace, arrive: r.arrive, v: r.vitesse_ms });
  }
  const err = lignes.map((l) => Math.abs(l.suivi - l.vrai));
  const reculs = lignes.filter((l, i) => i > 0 && l.suivi < lignes[i - 1].suivi - 1e-9).length;
  return {
    lignes, reculs,
    errMax: Math.max(...err),
    errMoy: err.reduce((a, b) => a + b, 0) / err.length,
    errFin: err[err.length - 1],
  };
}

console.log(`Trace : ${trace.longueur.toFixed(1)} m (${DATE} ${HEURE}, k=4).\n`);

/* 1. Sans bruit : le suivi doit coller. */
{
  const r = rejoue({ bruit_m: 0 });
  verifie("sans bruit, ecart au reel < 5 m sur tout le trajet", r.errMax < 5,
          `max ${r.errMax.toFixed(2)} m, moyen ${r.errMoy.toFixed(2)} m`);
  verifie("sans bruit, aucun recul", r.reculs === 0, `${r.reculs} recul(s)`);
  verifie("arrivee detectee", r.lignes[r.lignes.length - 1].arrive);
}

/* 2. Sous bruit : monotonie et erreur finale bornees (exigences du brief). */
for (const bruit of [5, 15, 30]) {
  const r = rejoue({ bruit_m: bruit });
  verifie(`bruit ${bruit} m : progression monotone, aucun recul`, r.reculs === 0,
          `${r.reculs} recul(s)`);
  const seuil = bruit === 30 ? 35 : 20;
  verifie(`bruit ${bruit} m : erreur finale < ${seuil} m`, r.errFin < seuil,
          `finale ${r.errFin.toFixed(1)} m, max ${r.errMax.toFixed(1)} m, moyenne ${r.errMoy.toFixed(1)} m`);
}

/* 3. Determinisme : le suivi doit etre rejouable a l'identique. */
{
  const a = rejoue({ bruit_m: 15, graine: 7 }).lignes.map((l) => l.suivi.toFixed(4)).join(",");
  const b = rejoue({ bruit_m: 15, graine: 7 }).lignes.map((l) => l.suivi.toFixed(4)).join(",");
  verifie("suivi deterministe a graine egale", a === b);
}

/* 4. Ecarts volontaires. DEUX regimes, mesures le 2026-08-30 sur ce trajet.
 *
 *   a) ECART FRANC (a=200 m, 60 m de cote) : le point le plus proche de la
 *      trace reste le point de depart de l'ecart, a 60 m. Le suivi doit cesser
 *      d'avancer : il n'a plus aucune preuve de progression.
 *
 *   b) ECART TROMPEUR (a=900 m, 60 m de cote) : dans un tissu dense comme le
 *      Marais, l'itineraire se replie sur lui-meme. Marcher 60 m de travers
 *      laisse a 9 m SEULEMENT d'une autre portion du MEME trajet, 74 m en
 *      arriere. Aucune detection par la distance ne peut voir cela, et il
 *      serait malhonnete de faire semblant. On verifie donc l'inverse : que le
 *      suivi ne se bloque PAS sur un ecart qu'il n'a aucun moyen de constater.
 *
 * Conclusion pour le palier 4 : la distance a l'itineraire est un signal
 * FAIBLE. La detection d'ecart devra s'appuyer sur la rue suivie et la duree,
 * pas sur un simple seuil de proximite. */
{
  const src = new SourceSimulee({ points, bruit_m: 0, ecarts: [{ a_m: 200, longueur_m: 60, cap_relatif_deg: 90 }] });
  const suivi = new SuiviProgression(trace);
  const l = [];
  for (const p of src.positions()) {
    const r = suivi.maj({ lon: p.lon, lat: p.lat, precision_m: p.precision_m, t: p.t });
    l.push({ s: r.s, ecart_m: r.ecart_m, confiance: r.confiance, hors: p._vrai.hors_trace });
  }
  const dehors = l.filter((x) => x.hors);
  verifie("ecart franc : rejoue", dehors.length > 20, `${dehors.length} positions`);
  const avancee = dehors[dehors.length - 1].s - dehors[0].s;
  verifie("ecart franc : le suivi cesse d'avancer (< 15 m sur 120 m marches)",
          avancee < 15, `${avancee.toFixed(1)} m`);
  const ecartMax = Math.max(...dehors.map((x) => x.ecart_m));
  verifie("ecart franc : l'eloignement est mesure (~60 m)", ecartMax > 55 && ecartMax < 65,
          `${ecartMax.toFixed(1)} m`);
  const confMin = Math.min(...dehors.map((x) => x.confiance));
  verifie("ecart franc : la confiance tombe a zero (signal du palier 4)", confMin === 0,
          `minimum ${confMin.toFixed(2)}`);
  const fin = l[l.length - 1];
  verifie("ecart franc : le suivi rattrape la fin apres retour",
          Math.abs(fin.s - trace.longueur) < 25, `${fin.s.toFixed(1)} m`);
}
{
  // Le cas trompeur ne peut PAS etre epingle a une abscisse fixe : il depend de
  // la geometrie du trajet, qui change avec la date et les donnees d'ombre.
  // Premiere version du test (2026-08-30) figee a a_m=900 : elle est devenue
  // rouge des que l'export a change de date. On CHERCHE donc le cas au lieu de
  // le supposer, ce qui teste la propriete reelle et non une coincidence.
  const l93 = points.map(([a, b]) => wgs84VersL93(a, b));
  const distanceVraie = (lon, lat) => {
    const [px, py] = wgs84VersL93(lon, lat);
    let best = Infinity;
    for (let i = 1; i < l93.length; i++) {
      const [x1, y1] = l93[i - 1], [x2, y2] = l93[i];
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2)) : 0;
      const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      if (d < best) best = d;
    }
    return best;
  };

  let pire = null;
  for (let a = 100; a <= trace.longueur - 100; a += 50) {
    for (const cap of [90, -90]) {
      const src = new SourceSimulee({ points, bruit_m: 0, ecarts: [{ a_m: a, longueur_m: 60, cap_relatif_deg: cap }] });
      const dehors = src.positions().filter((p) => p._vrai.hors_trace);
      if (!dehors.length) continue;
      const loin = dehors.reduce((x, y) => (y._vrai.ecart_m > x._vrai.ecart_m ? y : x));
      const d = distanceVraie(loin.lon, loin.lat);
      if (!pire || d < pire.d) pire = { a, cap, d };
    }
  }
  verifie("il existe des ecarts INVISIBLES a la distance (60 m de travers, < 30 m mesures)",
          pire && pire.d < 30,
          pire ? `pire cas : a=${pire.a} m cap ${pire.cap > 0 ? "+" : ""}${pire.cap}, `
               + `le marcheur est a 60 m du chemin mais a ${pire.d.toFixed(1)} m de la trace`
               : "aucun");

  // Sur ce cas, le suivi ne doit pas se bloquer : il n'a aucun moyen de savoir.
  const src = new SourceSimulee({ points, bruit_m: 0, ecarts: [{ a_m: pire.a, longueur_m: 60, cap_relatif_deg: pire.cap }] });
  const suivi = new SuiviProgression(trace);
  let fin2 = null;
  for (const p of src.positions()) {
    const r = suivi.maj({ lon: p.lon, lat: p.lat, precision_m: p.precision_m, t: p.t });
    fin2 = r.s;
  }
  verifie("ecart trompeur : le suivi termine quand meme le trajet",
          Math.abs(fin2 - trace.longueur) < 30, `${fin2.toFixed(1)} m sur ${trace.longueur.toFixed(1)} m`);
}

/* 5. La fenetre de recherche interdit le saut a l'autre bout du trajet :
      un point aberrant tres loin ne doit pas teleporter le suivi. */
{
  const suivi = new SuiviProgression(trace);
  const src = new SourceSimulee({ points, bruit_m: 0 });
  const suite = src.positions();
  for (let i = 0; i < 60; i++) suivi.maj(suite[i]);
  const avant = suivi.s;
  const loin = suite[suite.length - 20];          // point pris pres de l'arrivee
  const r = suivi.maj({ lon: loin.lon, lat: loin.lat, precision_m: 5, t: suite[60].t });
  verifie("un point aberrant lointain ne teleporte pas le suivi",
          r.s - avant < 30, `saut de ${(r.s - avant).toFixed(1)} m`);
}

console.log(`\n${echecs === 0 ? "TOUT PASSE" : echecs + " ECHEC(S)"}`);
process.exit(echecs === 0 ? 0 : 1);
