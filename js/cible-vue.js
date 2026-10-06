// Cible dessinée à l'échelle sur un canevas, pour la saisie au doigt :
// - un doigt : on vise (une loupe montre l'endroit exact sous le doigt et les points), on lève le doigt pour poser l'impact ;
// - deux doigts : zoom et déplacement de la vue ; molette et glisser à la souris sur ordinateur.
import { centresVisuels, diametreZone, diametreExterieur } from "./issf.js";

export class VueCible {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ impact?: (visuel:number, x:number, y:number) => void, apercu?: (visuel:number, x:number, y:number) => string }} rappels
   */
  constructor(canvas, rappels = {}) {
    // Canevas et rappels
    this.canvas = canvas;
    this.rappels = rappels;
    // Contenu dessiné
    this.cible = null;
    this.impacts = [];
    this.trou = 4.5;
    this.saisie = false;
    this.dernier = null;
    // Vue : pixels par mm et position à l'écran du centre du carton (pixels CSS)
    this.echelle = 1;
    this.centre = { x: 0, y: 0 };
    // Doigts posés (identifiant → position)
    this.doigts = new Map();
    // Geste en cours : "visee", "pince", "glisser" ou null
    this.geste = null;
    // Position visée (pixels CSS)
    this.visee = null;
    // Début du pincement
    this.pince = null;
    // Événements du pointeur (doigt, stylet, souris)
    canvas.addEventListener("pointerdown", (e) => this.appui(e));
    canvas.addEventListener("pointermove", (e) => this.mouvement(e));
    canvas.addEventListener("pointerup", (e) => this.relache(e, true));
    canvas.addEventListener("pointercancel", (e) => this.relache(e, false));
    // Molette : zoom (ordinateur)
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); this.zoomer(e.deltaY < 0 ? 1.2 : 1 / 1.2, this.position(e)); }, { passive: false });
    // Redimensionnement
    new ResizeObserver(() => this.redimensionner()).observe(canvas);
  }

  /** Change le contenu ; "ajuster" recadre la vue sur tout le carton. */
  definir({ cible, impacts, trou, saisie, dernier }, ajuster = false) {
    // Cible changée : nouvel ajustement
    const nouvelle = cible !== this.cible;
    // Contenu
    this.cible = cible; this.impacts = impacts ?? []; this.trou = trou ?? 4.5; this.saisie = !!saisie; this.dernier = dernier ?? null;
    // Vue
    if (ajuster || nouvelle) this.ajuster(); else this.dessiner();
  }

  /** Taille du canevas suivant celle de l'écran (pixels réels pour un dessin net). */
  redimensionner() {
    // Taille affichée
    const r = this.canvas.getBoundingClientRect();
    // Densité de pixels
    const dpr = window.devicePixelRatio || 1;
    // Taille réelle
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    // Nouvel ajustement
    this.ajuster();
  }

  /** Vue d'ensemble : tout le carton tient dans le canevas. */
  ajuster() {
    // Taille affichée
    const r = this.canvas.getBoundingClientRect();
    // Rien à ajuster
    if (!this.cible || r.width === 0) { this.dessiner(); return; }
    // Zone à montrer
    const l = Math.max(this.cible.largeur, diametreExterieur(this.cible)), h = Math.max(this.cible.hauteur, diametreExterieur(this.cible));
    // Échelle (marge de 8 pixels)
    this.echelle = Math.max(0.01, Math.min((r.width - 16) / l, (r.height - 16) / h));
    // Centre
    this.centre = { x: r.width / 2, y: r.height / 2 };
    // Dessin
    this.dessiner();
  }

  /** Zoom d'un facteur autour d'un point de l'écran. */
  zoomer(facteur, autour) {
    // Le point reste fixe
    this.centre = { x: autour.x - (autour.x - this.centre.x) * facteur, y: autour.y - (autour.y - this.centre.y) * facteur };
    // Nouvelle échelle
    this.echelle *= facteur;
    // Dessin
    this.dessiner();
  }

  /** Zoom autour du centre du canevas (boutons + et −). */
  zoomerCentre(facteur) {
    // Taille affichée
    const r = this.canvas.getBoundingClientRect();
    // Zoom
    this.zoomer(facteur, { x: r.width / 2, y: r.height / 2 });
  }

  // ===================== Conversions =====================

  /** Position d'un événement dans le canevas (pixels CSS). */
  position(e) {
    // Rectangle du canevas
    const r = this.canvas.getBoundingClientRect();
    // Position
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** Visuel le plus proche d'un point de l'écran, et position par rapport à son centre (mm). */
  versCible(p) {
    // Point du carton (mm)
    const mm = { x: (p.x - this.centre.x) / this.echelle, y: (p.y - this.centre.y) / this.echelle };
    // Centres des visuels
    const centres = centresVisuels(this.cible);
    // Plus proche
    let k = 0;
    // Recherche
    centres.forEach((c, i) => { if (Math.hypot(c.x - mm.x, c.y - mm.y) < Math.hypot(centres[k].x - mm.x, centres[k].y - mm.y)) k = i; });
    // Résultat
    return { visuel: k, x: mm.x - centres[k].x, y: mm.y - centres[k].y };
  }

  // ===================== Gestes =====================

  /** Doigt posé. */
  appui(e) {
    // Rien à faire sans cible
    if (!this.cible) return;
    // Suivi du pointeur même hors du canevas (refusé par certains navigateurs : sans gravité)
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* suivi limité au canevas */ }
    // Doigt mémorisé
    this.doigts.set(e.pointerId, this.position(e));
    // Deux doigts : pincement (la visée en cours est abandonnée)
    if (this.doigts.size === 2) {
      // Deux positions
      const [a, b] = [...this.doigts.values()];
      // Début du pincement
      this.pince = { distance: Math.hypot(a.x - b.x, a.y - b.y), milieu: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, echelle: this.echelle, centre: { ...this.centre } };
      // Geste
      this.geste = "pince";
      // Plus de visée
      this.visee = null;
    } else if (this.doigts.size === 1) {
      // Souris : bouton droit ou du milieu = déplacer la vue
      if (e.pointerType === "mouse" && e.button !== 0) { this.geste = "glisser"; this.depuis = this.position(e); return; }
      // Saisie : visée, sinon déplacement de la vue
      this.geste = this.saisie ? "visee" : "glisser";
      // Point de départ
      this.depuis = this.position(e);
      // Visée
      this.visee = this.saisie ? this.position(e) : null;
    }
    // Dessin
    this.dessiner();
  }

  /** Doigt déplacé. */
  mouvement(e) {
    // Doigt inconnu (souris survolant sans bouton)
    if (!this.doigts.has(e.pointerId)) return;
    // Position
    const p = this.position(e);
    // Mise à jour
    this.doigts.set(e.pointerId, p);
    // Pincement : zoom et déplacement
    if (this.geste === "pince" && this.doigts.size >= 2) {
      // Deux positions
      const [a, b] = [...this.doigts.values()];
      // Facteur de zoom
      const f = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, this.pince.distance);
      // Milieu actuel
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      // Nouvelle échelle
      this.echelle = this.pince.echelle * f;
      // Le point sous le milieu de départ suit le milieu actuel
      this.centre = { x: m.x - (this.pince.milieu.x - this.pince.centre.x) * f, y: m.y - (this.pince.milieu.y - this.pince.centre.y) * f };
    } else if (this.geste === "glisser") {
      // Déplacement de la vue
      this.centre = { x: this.centre.x + p.x - this.depuis.x, y: this.centre.y + p.y - this.depuis.y };
      // Nouvelle référence
      this.depuis = p;
    } else if (this.geste === "visee") {
      // Nouvelle visée
      this.visee = p;
    }
    // Dessin
    this.dessiner();
  }

  /** Doigt levé (ou geste annulé par le système). */
  relache(e, normal) {
    // Doigt inconnu
    if (!this.doigts.has(e.pointerId)) return;
    // Oubli du doigt
    this.doigts.delete(e.pointerId);
    // Fin de visée : impact posé si le doigt est levé dans le canevas
    if (this.geste === "visee" && normal && this.visee) {
      // Taille affichée
      const r = this.canvas.getBoundingClientRect();
      // Dans le canevas
      if (this.visee.x >= 0 && this.visee.y >= 0 && this.visee.x <= r.width && this.visee.y <= r.height) {
        // Position sur la cible
        const c = this.versCible(this.visee);
        // Prévient l'application
        this.rappels.impact?.(c.visuel, c.x, c.y);
      }
    }
    // Plus aucun doigt : fin du geste (après un pincement, le doigt restant ne vise pas)
    if (this.doigts.size === 0) this.geste = null;
    // Plus de visée
    this.visee = null;
    // Dessin
    this.dessiner();
  }

  // ===================== Dessin =====================

  /** Dessin complet : carton, visuels, impacts, puis la loupe pendant la visée. */
  dessiner() {
    // Densité de pixels
    const dpr = window.devicePixelRatio || 1;
    // Taille réelle du canevas suivant sa taille affichée (au premier dessin, ou si l'écran a tourné)
    const r = this.canvas.getBoundingClientRect();
    if (r.width > 0 && this.canvas.width !== Math.round(r.width * dpr)) { this.redimensionner(); return; }
    // Contexte
    const ctx = this.canvas.getContext("2d");
    // Repère en pixels CSS
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Taille
    const l = this.canvas.width / dpr, h = this.canvas.height / dpr;
    // Fond
    ctx.fillStyle = getComputedStyle(this.canvas).getPropertyValue("--fond-cible") || "#2a2a2a";
    ctx.fillRect(0, 0, l, h);
    // Pas de cible
    if (!this.cible) {
      // Message
      ctx.fillStyle = "#aaa"; ctx.font = "15px system-ui"; ctx.textAlign = "center";
      ctx.fillText("Choisissez une discipline.", l / 2, h / 2);
      // Fin
      return;
    }
    // Scène à l'échelle courante
    this.scene(ctx, this.echelle, this.centre);
    // Loupe pendant la visée
    if (this.visee) this.loupe(ctx, l);
  }

  /** Dessine la scène pour une échelle et un centre donnés. */
  scene(ctx, s, o) {
    // Cible
    const c = this.cible;
    // Point du carton (mm) vers l'écran
    const E = (x, y) => ({ x: o.x + x * s, y: o.y + y * s });
    // Carton blanc
    const coin = E(-c.largeur / 2, -c.hauteur / 2);
    ctx.fillStyle = "#fff"; ctx.fillRect(coin.x, coin.y, c.largeur * s, c.hauteur * s);
    // Centres des visuels
    const centres = centresVisuels(c);
    // Chaque visuel
    for (const v of centres) this.visuel(ctx, E(v.x, v.y), s);
    // Rayon des trous
    const r = Math.max(2, (this.trou / 2) * s);
    // Chaque impact
    for (const i of this.impacts) {
      // Centre du visuel
      const v = centres[i.visuel] ?? centres[0];
      // Position
      const p = E(v.x + i.x, v.y + i.y);
      // Trou
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(70,70,70,0.86)"; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = "#fff"; ctx.stroke();
      // Dernier impact : anneau de couleur
      if (i === this.dernier) { ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, 2 * Math.PI); ctx.lineWidth = 2.5; ctx.strokeStyle = "#e0a030"; ctx.stroke(); }
      // Numéro (dans le trou s'il est assez grand, sinon à côté)
      ctx.font = `600 ${Math.min(13, Math.max(9, r))}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      // Position du numéro
      const nx = r >= 8 ? p.x : p.x + r + 7, ny = r >= 8 ? p.y : p.y - r - 4;
      // Fond lisible à côté du trou
      if (r < 8) { ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(nx - 7, ny - 7, 14, 14); }
      // Texte
      ctx.fillStyle = "#fff"; ctx.fillText(String(i.numero), nx, ny);
    }
  }

  /** Un visuel : visuel noir, zones (traits blancs dans le noir), numéros, mouche. */
  visuel(ctx, centre, s) {
    // Cible
    const c = this.cible;
    // Visuel noir
    ctx.beginPath(); ctx.arc(centre.x, centre.y, (c.noir / 2) * s, 0, 2 * Math.PI); ctx.fillStyle = "#000"; ctx.fill();
    // Largeur d'une bande à l'écran
    const bande = (c.pas / 2) * s;
    // Zones de l'extérieur vers le 10
    for (let v = c.valeurMin; v <= 10; v++) {
      // Diamètre
      const d = diametreZone(c, v);
      // Cercle (blanc dans le noir)
      ctx.beginPath(); ctx.arc(centre.x, centre.y, (d / 2) * s, 0, 2 * Math.PI);
      ctx.lineWidth = 1; ctx.strokeStyle = d <= c.noir + 1e-6 ? "#fff" : "#000"; ctx.stroke();
      // Numéro au milieu de la bande, à gauche et à droite, si la place suffit
      if (v < 10 && bande >= 9) {
        // Couleur
        ctx.fillStyle = diametreZone(c, v + 1) < c.noir - 1e-6 ? "#fff" : "#000";
        ctx.font = `${Math.min(bande * 0.8, 15)}px system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        // Distance du centre
        const m = ((d + diametreZone(c, v + 1)) / 4) * s;
        // Gauche et droite
        ctx.fillText(String(v), centre.x - m, centre.y); ctx.fillText(String(v), centre.x + m, centre.y);
      }
    }
    // Mouche
    if (c.mouche > 0) { ctx.beginPath(); ctx.arc(centre.x, centre.y, (c.mouche / 2) * s, 0, 2 * Math.PI); ctx.strokeStyle = "#fff"; ctx.stroke(); }
    // 10 minuscule : un point blanc pour le repérer
    if ((c.d10 / 2) * s < 2) { ctx.beginPath(); ctx.arc(centre.x, centre.y, 1.5, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill(); }
  }

  /** Loupe au-dessus du doigt : la zone visée grossie, une croix et les points qui seraient comptés. */
  loupe(ctx, largeur) {
    // Point visé
    const p = this.visee;
    // Rayon de la loupe et grossissement
    const R = 62, G = 3;
    // Centre de la loupe : au-dessus du doigt (en dessous si on est tout en haut), gardé dans l'écran
    const lx = Math.min(Math.max(p.x, R + 4), largeur - R - 4), ly = p.y - R - 50 < R + 4 ? p.y + R + 50 : p.y - R - 50;
    // Découpe circulaire
    ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, R, 0, 2 * Math.PI); ctx.clip();
    // Fond
    ctx.fillStyle = "#2a2a2a"; ctx.fillRect(lx - R, ly - R, 2 * R, 2 * R);
    // Scène grossie : le point visé au centre de la loupe
    const s = this.echelle * G;
    this.scene(ctx, s, { x: lx - (p.x - this.centre.x) * G, y: ly - (p.y - this.centre.y) * G });
    // Trou fantôme
    ctx.beginPath(); ctx.arc(lx, ly, Math.max(2, (this.trou / 2) * s), 0, 2 * Math.PI);
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = "#e0a030"; ctx.stroke(); ctx.setLineDash([]);
    // Croix
    ctx.beginPath(); ctx.moveTo(lx - 10, ly); ctx.lineTo(lx + 10, ly); ctx.moveTo(lx, ly - 10); ctx.lineTo(lx, ly + 10);
    ctx.lineWidth = 1; ctx.strokeStyle = "#e0a030"; ctx.stroke();
    ctx.restore();
    // Bord de la loupe
    ctx.beginPath(); ctx.arc(lx, ly, R, 0, 2 * Math.PI); ctx.lineWidth = 3; ctx.strokeStyle = "#e0a030"; ctx.stroke();
    // Texte d'aperçu (points, numéro de l'impact)
    const c = this.versCible(p);
    const texte = this.rappels.apercu?.(c.visuel, c.x, c.y) ?? "";
    // Texte présent
    if (texte) {
      // Mesure
      ctx.font = "600 14px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const w = ctx.measureText(texte).width + 16;
      // Position : du côté de la loupe opposé au doigt (jamais caché par le doigt)
      const ty = ly < p.y ? ly - R - 16 : ly + R + 16;
      // Cadre gardé dans l'écran
      const tx = Math.min(Math.max(lx, w / 2 + 2), largeur - w / 2 - 2);
      // Fond
      ctx.fillStyle = "rgba(20,20,20,0.85)"; ctx.fillRect(tx - w / 2, ty - 12, w, 24);
      // Texte
      ctx.fillStyle = "#fff"; ctx.fillText(texte, tx, ty);
    }
  }
}
