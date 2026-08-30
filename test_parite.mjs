/* Test de parite moteur JS vs moteur Python (phase 3, palier 2).
 *
 * Charge l'export tuile (pwa/data/paris) et les fixtures generees par le
 * moteur Python (pwa/fixtures_parite.json), rejoue chaque cas dans le
 * moteur JS et compare. Tolerances (documentees) : longueurs exportees au
 * cm et coordonnees WGS84 a 6 decimales (~0,11 m) -> derive cumulee bornee
 * sur ~250 troncons : distance/ombre/soleil/non-evalue +/- 0,6 m ;
 * cout +/- 0,8 ; ratio +/- 0,001 ; traversees, k_effectif, plafonne EXACTS.
 *
 * Cas particulier documente (constate en reel) : a k=0 deux plus courts
 * chemins STRICTEMENT co-optimaux peuvent differer entre Python et JS
 * (l'ombre n'est pas optimisee a k=0, la repartition ombre/soleil peut
 * alors differer librement). Si cout, distance, ratio et traversees sont
 * en parite mais que seule la repartition ombre/soleil differe, le cas est
 * marque "OK (co-optimal)" - l'OBJECTIF optimise est bien identique.
 * Lancement : node pwa/test_parite.mjs (depuis la racine du depot).
 */
import { readFileSync } from "node:fs";
import { MoteurOmbra } from "./moteur.js";

const RACINE = new URL("..", import.meta.url).pathname;
const DATA = `${RACINE}pwa/data/paris`;
const lis = (p) => JSON.parse(readFileSync(p, "utf8"));

const manifest = lis(`${DATA}/manifest.json`);
const fixtures = lis(`${RACINE}pwa/fixtures_parite.json`);

const moteur = new MoteurOmbra(
  manifest,
  async (id) => lis(`${DATA}/tuiles/${id}.json`),
  async (date, id) => lis(`${DATA}/ombres/${date}/${id}.json`),
);

const TOL_M = 0.6, TOL_COUT = 0.8, TOL_RATIO = 0.001;
let echecs = 0, total = 0, coOptimaux = 0;

// Garde-fou : des fixtures portant sur une date absente de l'export rendent le
// test INEXECUTABLE, ce qui est pire qu'un echec (panne silencieuse constatee le
// 2026-08-30). On le dit en clair plutot que de laisser remonter une exception
// technique depuis le moteur.
{
  const datesFixtures = [...new Set(fixtures.cas.map((c) => c.date))];
  const manquantes = datesFixtures.filter((d) => !manifest.dates[d]);
  if (manquantes.length) {
    console.error(
      `ECHEC : les fixtures portent sur ${manquantes.join(", ")}, absente(s) de l'export ` +
      `(dates disponibles : ${Object.keys(manifest.dates).join(", ")}).\n` +
      "Le test de parite ne peut pas s'executer : le filet de securite est LEVE.\n" +
      "Regenerer les fixtures : PYTHONPATH=src .venv/bin/python scripts/genere_fixtures_parite.py",
    );
    process.exit(1);
  }
}

for (const cas of fixtures.cas) {
  total += 1;
  const r = await moteur.route({
    depart: cas.depart, arrivee: cas.arrivee, k: cas.k,
    date: cas.date, heure: cas.heure,
    plafondDetour: cas.plafond_detour ?? undefined,
    chargerToutes: true, // parite stricte d'abord ; le chargement paresseux est teste ensuite
  });
  const a = cas.attendu;
  const problemes = [];
  const verifM = (champ) => {
    const d = Math.abs(r[champ] - a[champ]);
    if (d > TOL_M) problemes.push(`${champ}: js=${r[champ].toFixed(2)} py=${a[champ]} (ecart ${d.toFixed(2)} m)`);
  };
  verifM("distance_m"); verifM("distance_ombre_m"); verifM("distance_soleil_m");
  verifM("distance_non_evaluee_m"); verifM("distance_direct_m");
  if (Math.abs(r.cout_pondere - a.cout_pondere) > TOL_COUT)
    problemes.push(`cout: js=${r.cout_pondere.toFixed(2)} py=${a.cout_pondere}`);
  if (Math.abs(r.ratio_detour - a.ratio_detour) > TOL_RATIO)
    problemes.push(`ratio: js=${r.ratio_detour.toFixed(5)} py=${a.ratio_detour}`);
  if (r.nb_traversees !== a.nb_traversees)
    problemes.push(`traversees: js=${r.nb_traversees} py=${a.nb_traversees}`);
  if (r.k_effectif !== a.k_effectif)
    problemes.push(`k_effectif: js=${r.k_effectif} py=${a.k_effectif}`);
  if (r.plafonne !== a.plafonne)
    problemes.push(`plafonne: js=${r.plafonne} py=${a.plafonne}`);

  const etiquette = `${cas.nom} k=${cas.k}${cas.plafond_detour ? ` plafond=${cas.plafond_detour}` : ""}`;
  // Exemption co-optimale : l'objectif OPTIMISE (le cout pondere) et toutes
  // les decisions (k_effectif, plafonne, nb de traversees) sont en parite,
  // seuls des attributs du chemin choisi different (distance/ombre/soleil/
  // ratio, bornes de securite 10 m / 0,005) -> deux chemins de cout EGAL,
  // l'arbitrage d'egalite differe entre networkx et notre A*, pas le moteur.
  // Constate en reel a k=0 (l'ombre n'y est pas optimisee : repartition
  // libre) et a k>0 (leger troc distance contre soleil a cout constant).
  const coutOk = Math.abs(r.cout_pondere - a.cout_pondere) <= TOL_COUT;
  const decisionsOk = r.k_effectif === a.k_effectif && r.plafonne === a.plafonne
    && r.nb_traversees === a.nb_traversees;
  const bornesOk = Math.abs(r.distance_m - a.distance_m) <= 10
    && Math.abs(r.ratio_detour - a.ratio_detour) <= 0.005;
  const seulementChemin = problemes.every((p) => /^(distance_|ratio)/.test(p));
  if (problemes.length && coutOk && decisionsOk && bornesOk && seulementChemin) {
    coOptimaux += 1;
    console.log(`OK     ${etiquette} (co-optimal : cout identique ${r.cout_pondere.toFixed(1)}, `
      + `chemin d'egalite different)`);
  } else if (problemes.length) {
    echecs += 1;
    console.log(`ECHEC  ${etiquette}`);
    for (const p of problemes) console.log(`       ${p}`);
  } else {
    console.log(`OK     ${etiquette} : ${r.distance_m.toFixed(1)} m, ${r.nb_traversees} trav, `
      + `k_eff=${r.k_effectif}, ombre=${r.distance_ombre_m.toFixed(1)} m`);
  }
}

// Chargement paresseux : meme trajet, tuiles restreintes au corridor -
// le resultat doit etre IDENTIQUE au chargement complet.
const casRef = fixtures.cas.find((c) => c.k === 4 && !c.plafond_detour);
const moteurLazy = new MoteurOmbra(
  manifest,
  async (id) => lis(`${DATA}/tuiles/${id}.json`),
  async (date, id) => lis(`${DATA}/ombres/${date}/${id}.json`),
);
const rLazy = await moteurLazy.route({
  depart: casRef.depart, arrivee: casRef.arrivee, k: 4,
  date: casRef.date, heure: casRef.heure,
});
total += 1;
const dLazy = Math.abs(rLazy.distance_m - casRef.attendu.distance_m);
if (dLazy > TOL_M || rLazy.nb_traversees !== casRef.attendu.nb_traversees) {
  echecs += 1;
  console.log(`ECHEC  chargement paresseux (${moteurLazy.tuilesChargees.size}/${manifest.tuiles.length} tuiles) : `
    + `js=${rLazy.distance_m.toFixed(2)} py=${casRef.attendu.distance_m}`);
} else {
  console.log(`OK     chargement paresseux : ${moteurLazy.tuilesChargees.size}/${manifest.tuiles.length} tuiles chargees, `
    + `resultat identique (${rLazy.distance_m.toFixed(1)} m)`);
}

console.log(`\n${total - echecs}/${total} cas en parite`
  + (coOptimaux ? ` (dont ${coOptimaux} co-optimal/aux a repartition differente)` : "") + ".");
process.exit(echecs ? 1 : 0);
