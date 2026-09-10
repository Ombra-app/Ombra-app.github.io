/* Boussole du telephone (phase 4, retour du test terrain du 2026-09-07 a
 * Pornic : "il faut coupler le faisceau a la boussole, comme Plans ou Maps").
 *
 * Donne le cap du telephone (degres, 0 = nord, sens horaire) a partir de
 * l'orientation de l'appareil. Sur iPhone c'est `webkitCompassHeading`
 * (deja absolu, deja corrige) ; ailleurs `deviceorientationabsolute` puis
 * `deviceorientation`, avec alpha (sens anti-horaire) converti en cap.
 * iOS 13+ exige une autorisation demandee DANS un geste de l'utilisateur :
 * `Boussole.autoriser()` doit etre appele des le "click" sur "Y aller",
 * avant tout `await`.
 *
 * Le cap est lisse (moyenne exponentielle sur le vecteur unitaire, pour
 * que 359 et 1 ne fassent pas 180) et livre au plus toutes les `cadence_ms`.
 */

export class Boussole {
  /** Vrai si l'appareil peut donner une orientation. */
  static disponible() { return typeof window !== "undefined" && "DeviceOrientationEvent" in window; }

  /** A appeler dans le geste utilisateur. Retourne "granted", "denied" ou
   *  "inutile" (pas de demande necessaire sur cet appareil). Ne jette jamais. */
  static async autoriser() {
    try {
      if (!Boussole.disponible()) return "denied";
      if (typeof DeviceOrientationEvent.requestPermission === "function") return await DeviceOrientationEvent.requestPermission();
      return "inutile";
    } catch { return "denied"; }
  }

  constructor({ cadence_ms = 150, lissage = 0.35 } = {}) {
    this.cadence_ms = cadence_ms; this.lissage = lissage;
    this.cap = null; this._x = 0; this._y = 0; this._dernier = 0; this._nom = null;
    this._surEvenement = (e) => this._traite(e);
    this.surCap = null;
  }

  demarrer(surCap) {
    if (!Boussole.disponible()) return false;
    this.surCap = surCap;
    // Android/Chrome : l'evenement absolu s'il existe, sinon le relatif.
    this._nom = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
    window.addEventListener(this._nom, this._surEvenement, true);
    return true;
  }

  arreter() {
    if (this._nom) window.removeEventListener(this._nom, this._surEvenement, true);
    this._nom = null; this.cap = null; this._x = this._y = 0;
  }

  /** Cap brut d'un evenement, ou null. Expose pour les tests. */
  static capDe(e) {
    if (typeof e.webkitCompassHeading === "number" && !Number.isNaN(e.webkitCompassHeading)) return (e.webkitCompassHeading + 360) % 360;
    if (typeof e.alpha === "number" && !Number.isNaN(e.alpha) && (e.absolute || !("absolute" in e))) return (360 - e.alpha) % 360;
    return null;
  }

  _traite(e) {
    const brut = Boussole.capDe(e);
    if (brut === null) return;
    const rad = (brut * Math.PI) / 180;
    if (this.cap === null) { this._x = Math.sin(rad); this._y = Math.cos(rad); }
    else { this._x += this.lissage * (Math.sin(rad) - this._x); this._y += this.lissage * (Math.cos(rad) - this._y); }
    this.cap = ((Math.atan2(this._x, this._y) * 180) / Math.PI + 360) % 360;
    const t = performance.now();
    if (t - this._dernier >= this.cadence_ms) { this._dernier = t; this.surCap?.(this.cap); }
  }
}

/** Ecart signe entre deux caps, en degres dans ]-180, 180]. */
export function ecartCap(a, b) { let d = (b - a) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; }
