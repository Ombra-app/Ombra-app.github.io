/* Podometre (phase 4, 2026-09-07, levier de fluidite n°1 valide par Jean-Philippe).
 *
 * Le GPS met une a deux secondes a voir qu'on demarre ou qu'on s'arrete ;
 * l'accelerometre le voit au pas pres. Meme interface web sur iPhone et
 * Android (`devicemotion`) ; iOS 13+ exige une autorisation demandee dans le
 * geste de l'utilisateur (`Podometre.autoriser()` des le "click" sur
 * "Y aller", avant tout await, comme la boussole).
 *
 * Detection : norme de l'acceleration (gravite comprise, donc independante
 * de l'orientation du telephone), moyenne glissante retiree, puis un pas =
 * franchissement montant d'un seuil, au plus tous les PAS_MIN_S. Sorties :
 * `pas` (compte), `cadence` (pas par seconde, lissee), `enMarche` (un pas
 * dans les ARRET_S dernieres secondes). Sans DOM : `traite(norme, t)` est
 * testable en Node (test_podometre.mjs). */

export const SEUIL_MS2 = 1.1;      // amplitude au-dessus de la moyenne glissante (m/s2)
export const PAS_MIN_S = 0.28;     // deux pas a moins de 0,28 s : impossible a pied (> 3,5 pas/s)
export const ARRET_S = 1.4;        // sans pas depuis 1,4 s : a l'arret
export const LISSAGE_MOYENNE = 0.08; // moyenne glissante de la norme (retire la gravite et la derive)
export const PASSE_BAS = 0.3;      // filtre passe-bas sur la norme (~2,5 Hz a 50 echantillons/s)
export const CREUX = 0.4;          // le creux qui suit le pic doit descendre sous -0,4 x seuil

export class Podometre {
  static disponible() { return typeof window !== "undefined" && "DeviceMotionEvent" in window; }

  /** A appeler dans le geste utilisateur. "granted", "denied" ou "inutile". Ne jette jamais. */
  static async autoriser() {
    try {
      if (!Podometre.disponible()) return "denied";
      if (typeof DeviceMotionEvent.requestPermission === "function") return await DeviceMotionEvent.requestPermission();
      return "inutile";
    } catch { return "denied"; }
  }

  constructor() {
    this.pas = 0; this.cadence = 0; this.dernierPas = null; this.moyenne = null; this.filtre = null; this.dessus = false; this.tPic = null; this.actif = false;
    this._sur = (e) => {
      const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
      this.traite(Math.hypot(a.x, a.y, a.z), performance.now() / 1000);
    };
  }

  demarrer() { if (!Podometre.disponible()) return false; window.addEventListener("devicemotion", this._sur, true); this.actif = true; return true; }
  arreter() { if (this.actif) window.removeEventListener("devicemotion", this._sur, true); this.actif = false; }

  /** Un echantillon : norme de l'acceleration (m/s2) a l'instant t (s). Retourne vrai si un pas vient d'etre compte.
   *  Un pas = un pic au-dessus du seuil SUIVI d'un creux sous -CREUX x seuil dans la seconde : le bruit
   *  d'une main qui tremble franchit parfois le seuil, rarement le pic et le creux dans l'ordre. */
  traite(norme, t) {
    // Passe-bas (la marche est sous 3 Hz ; le bruit d'une main qui tremble est au-dessus) puis moyenne retiree.
    if (this.filtre === null) { this.filtre = norme; this.moyenne = norme; }
    this.filtre += PASSE_BAS * (norme - this.filtre);
    this.moyenne += LISSAGE_MOYENNE * (this.filtre - this.moyenne);
    const ecart = this.filtre - this.moyenne;
    let pas = false;
    if (!this.dessus && ecart > SEUIL_MS2) { this.dessus = true; this.tPic = t; }
    else if (this.dessus && ecart < -CREUX * SEUIL_MS2) {
      this.dessus = false;
      const duree = t - (this.tPic ?? t);
      if (duree >= 0.08 && duree <= 0.9 && (this.dernierPas === null || this.tPic - this.dernierPas >= PAS_MIN_S)) {
        if (this.dernierPas !== null) { const c = 1 / (this.tPic - this.dernierPas); this.cadence = this.cadence ? this.cadence + 0.4 * (c - this.cadence) : c; }
        this.dernierPas = this.tPic; this.pas++; pas = true;
      }
    }
    return pas;
  }

  /** Vrai si un pas a ete compte dans les ARRET_S dernieres secondes. */
  enMarche(t = performance.now() / 1000) { return this.dernierPas !== null && t - this.dernierPas <= ARRET_S; }

  /** Etat compact pour le journal et la position affichee. */
  etat(t = performance.now() / 1000) { const m = this.enMarche(t); return { pas: this.pas, cadence: m ? this.cadence : 0, enMarche: m }; }
}
