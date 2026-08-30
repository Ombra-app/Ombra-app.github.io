/* Verification du simulateur de trace GPS (phase 4, palier 1).
 * Lancement : node pwa/nav/test_simulateur.mjs (depuis la racine du depot).
 *
 * Le simulateur est l'instrument de mesure de toute la phase 4. Un instrument
 * non verifie fausse tout ce qu'on mesurera avec : d'ou des seuils chiffres,
 * pas un simple "ca a l'air de marcher".
 */
import { readFileSync } from "node:fs";
import { MoteurOmbra, wgs84VersL93 } from "../moteur.js";
import { SourceSimulee, prepareTrace } from "./source_position.js";
import { traceItineraire } from "./trace.js";

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

/* distance metrique d'un point a la polyligne (projection sur chaque segment) */
function distanceATrace(lon, lat) {
  const [px, py] = wgs84VersL93(lon, lat);
  let best = Infinity;
  const l93 = trace.points.map(([a, b]) => wgs84VersL93(a, b));
  for (let i = 1; i < l93.length; i++) {
    const [x1, y1] = l93[i - 1], [x2, y2] = l93[i];
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L2)) : 0;
    const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    if (d < best) best = d;
  }
  return best;
}

console.log(`Itineraire moteur  : ${res.distance_m.toFixed(1)} m, ${res.aretes.length} aretes`);
console.log(`Trace de reference : ${trace.longueur.toFixed(1)} m, ${points.length} sommets `
          + `(${DATE} ${HEURE}, k=4).\n`);

/* 0. La trace doit representer FIDELEMENT l'itineraire : c'est le prealable a
      toute mesure faite avec le simulateur. */
{
  const ecartPct = 100 * Math.abs(trace.longueur - res.distance_m) / res.distance_m;
  verifie("longueur de trace coherente avec l'itineraire (< 3 %)", ecartPct < 3,
          `${trace.longueur.toFixed(1)} m contre ${res.distance_m.toFixed(1)} m, soit ${ecartPct.toFixed(1)} %`);
  let sautMax = 0;
  for (let i = 1; i < trace.cumul.length; i++) {
    const d = trace.cumul[i] - trace.cumul[i - 1];
    if (d > sautMax) sautMax = d;
  }
  verifie("aucun saut de jonction (< 25 m entre sommets consecutifs)", sautMax < 25,
          `saut max ${sautMax.toFixed(2)} m`);
}

/* 1. Sans bruit : les positions sont SUR la trace, et la couvrent en entier. */
{
  const s = new SourceSimulee({ points, bruit_m: 0, graine: 1 });
  const pos = s.positions();
  const dmax = Math.max(...pos.map((p) => distanceATrace(p.lon, p.lat)));
  verifie("sans bruit, positions sur la trace (< 0,5 m)", dmax < 0.5, `ecart max ${dmax.toFixed(3)} m`);
  const sFin = pos[pos.length - 1]._vrai.s;
  verifie("la trace est parcourue en entier (< 2 m du bout)",
          Math.abs(sFin - trace.longueur) < 2, `fin a ${sFin.toFixed(1)} / ${trace.longueur.toFixed(1)} m`);
  const croissant = pos.every((p, i) => i === 0 || p._vrai.s >= pos[i - 1]._vrai.s - 1e-9);
  verifie("abscisse strictement non decroissante", croissant);
  const duree = pos[pos.length - 1].t / 1000;
  verifie("duree coherente avec 1,3 m/s", Math.abs(duree - trace.longueur / 1.3) < 2,
          `${duree.toFixed(0)} s pour ${trace.longueur.toFixed(0)} m`);
}

/* 2. Determinisme : meme graine -> suite identique ; graine differente -> differente. */
{
  const mk = (g) => new SourceSimulee({ points, bruit_m: 15, graine: g }).positions();
  const a = JSON.stringify(mk(42)), b = JSON.stringify(mk(42)), c = JSON.stringify(mk(43));
  verifie("meme graine, suite identique", a === b);
  verifie("graine differente, suite differente", a !== c);
}

/* 3. Bruit : l'ecart-type mesure doit retrouver le bruit demande. */
for (const sigma of [5, 15, 30]) {
  const pos = new SourceSimulee({ points, bruit_m: sigma, graine: 7 }).positions();
  const ec = pos.map((p) => distanceATrace(p.lon, p.lat));
  const moy = ec.reduce((x, y) => x + y, 0) / ec.length;
  // Ecart moyen a la trace d'un bruit 2D d'ecart-type sigma : ordre de grandeur
  // sigma*0,6 a sigma*1,3 (la projection sur la trace absorbe la composante
  // longitudinale). On borne largement, le but est de detecter une erreur de
  // facteur, pas de valider une loi.
  verifie(`bruit ${sigma} m : ecart moyen dans la plage attendue`,
          moy > sigma * 0.4 && moy < sigma * 1.4, `moyenne ${moy.toFixed(1)} m`);
}

/* 4. Ecart scripte : le marcheur quitte bien la trace, au bon endroit, de la
      bonne distance, puis y revient. */
{
  const ECART = { a_m: 200, longueur_m: 60, cap_relatif_deg: 90 };
  const s = new SourceSimulee({ points, bruit_m: 0, graine: 1, ecarts: [ECART] });
  const pos = s.positions();
  const dehors = pos.filter((p) => p._vrai.hors_trace);
  verifie("l'ecart produit des positions hors trace", dehors.length > 0, `${dehors.length} positions`);
  const ecartMax = Math.max(...dehors.map((p) => p._vrai.ecart_m));
  verifie("eloignement maximal conforme (60 m attendus)", Math.abs(ecartMax - 60) < 2,
          `${ecartMax.toFixed(1)} m`);
  const dMax = Math.max(...dehors.map((p) => distanceATrace(p.lon, p.lat)));
  verifie("l'eloignement est reel (mesure sur la carte, > 50 m)", dMax > 50, `${dMax.toFixed(1)} m`);
  const sEcart = dehors[0]._vrai.s;
  verifie("l'ecart demarre a la bonne abscisse (200 m)", Math.abs(sEcart - 200) < 2, `${sEcart.toFixed(1)} m`);
  const apres = pos[pos.length - 1];
  verifie("retour sur la trace et arrivee au bout", !apres._vrai.hors_trace
          && Math.abs(apres._vrai.s - trace.longueur) < 2);
  verifie("le detour allonge le parcours de 2 x 60 m",
          Math.abs(s.longueurParcours - (trace.longueur + 120)) < 0.01,
          `${s.longueurParcours.toFixed(1)} m contre ${trace.longueur.toFixed(1)} m`);
}

/* 5. Cadence : le pas d'emission fixe la distance entre positions. */
{
  const pos = new SourceSimulee({ points, pas_ms: 500, vitesse_ms: 1.3, bruit_m: 0 }).positions();
  const d = pos[1]._vrai.s - pos[0]._vrai.s;
  verifie("pas de 500 ms a 1,3 m/s -> 0,65 m entre positions", Math.abs(d - 0.65) < 0.01,
          `${d.toFixed(3)} m`);
}

console.log(`\n${echecs === 0 ? "TOUT PASSE" : echecs + " ECHEC(S)"}`);
process.exit(echecs === 0 ? 0 : 1);
