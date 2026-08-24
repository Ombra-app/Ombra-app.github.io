# Format d'export PWA (phase 3, palier 1) - version 1

Dossier : `pwa/data/<ville>/`. Genere par `make export-pwa` (aucun
recalcul : relecture du cache disque). Le moteur JS (palier 2) ne doit
dependre QUE de ce format, jamais du code Python.

## manifest.json
`format_version`, `ville`, `perimetre`, `bbox_wgs84`, `taille_tuile_m`
(1000), `pas_minutes`, `n_segments`, `n_traversees`,
`dates` : {date ISO -> liste des pas "HH:MM"},
`tuiles` : [{id "x_y" (grille L93 1 km), n_segments, n_noeuds, n_traversees}],
`conventions` (contrat de parite, recopie ci-dessous).

## tuiles/<id>.json
- `noeuds` : [[node_id, lon, lat], ...] (WGS84, 6 decimales ~0,11 m).
  Un noeud peut apparaitre dans plusieurs tuiles (frontieres) : union au
  chargement, memes coordonnees partout.
- `segments` : [{`i` index GLOBAL (cle des fichiers d'ombre), `a`/`b`
  node_id, `l` longueur en m (source de verite du cout - ne pas recalculer
  depuis la geometrie), `rue`, `cote` (boussole), `geom` [[lon,lat],...]}]
- `traversees` : [{`a`, `b`, `l`, `src` "osm_crossing"|"carrefour"}]
  (rangees dans la tuile du noeud `a`).

## ombres/<date>/<tuile>.json
- `pas` : liste des "HH:MM" ; `seg` : index globaux des segments de la
  tuile (meme ordre que tuiles/<id>.json) ;
- `v` : base64 d'un tableau Uint8 de taille len(seg)*len(pas), ordre
  SEGMENT-MAJOR (toutes les heures du segment 0, puis segment 1...).
  Valeur : 0-100 = % d'ombre ; **255 = indetermine** (sous emprise batie,
  a traiter comme OMBRE dans le cout - decision phase 2 palier 3) ;
- `conf` : base64 des bits (np.packbits, meme ordre) : 1 = confiance
  faible.

## Contrat de parite avec le moteur Python (obligatoire au palier 2)
- cout d'arete : l * (1 + k * fraction_soleil) + cout_traversee, avec
  fraction_soleil = 1 - v/100 (et 0 si v=255) ;
- couts de traversee : 15 m (osm_crossing) / 30 m (carrefour) ;
- plafond de detour 1,5 avec reduction de k par moities (plancher 0,25,
  repli direct) ;
- doublons d'arete (meme paire a,b) : le DERNIER segment (i croissant)
  gagne, y compris face a une traversee deja presente (une traversee ne
  remplace jamais une arete trottoir existante - ordre de construction
  Python : trottoirs d'abord, traversees ensuite, sans ecrasement).
