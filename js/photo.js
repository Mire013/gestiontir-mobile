// Analyse d'une cible prise en photo : le téléphone repère les trous (impacts) et les propose à la session.
// Tout se fait dans le téléphone, la photo n'est ni enregistrée ni envoyée.
//
// Principe :
// 1. Calage : l'utilisateur touche deux points connus de la cible (échelle en pixels par mm, rotation).
//    Des cercles sont dessinés sur la photo pour qu'il vérifie le calage avant de continuer.
// 2. Détection : dans chaque visuel, on cherche de petites taches à contraste local (plus sombres que le papier,
//    ou plus claires que le noir), de la taille du trou de la munition ; les formes allongées (lignes, bords du
//    visuel noir) sont écartées.
// 3. Revue : l'utilisateur retire les fausses détections (un toucher) et ajoute les trous manqués (un toucher).
//
// La photo doit être prise de face, cible entière visible et bien éclairée, sans ombre portée.
import { el, toast, nombre } from "./outils.js";
import { centresVisuels, diametreZone, diametreExterieur } from "./issf.js";

// Côté maximal de l'image analysée (pixels) : assez fin pour un trou de 4,5 mm, assez léger pour un téléphone
const COTE_MAX = 1600;

// ===================== Détection (fonctions pures, sans écran) =====================

/** Image intégrale (somme cumulée) pour calculer des moyennes de zones en temps constant. */
function integrale(gris, l, h) {
  // Tableau (l+1) × (h+1)
  const ii = new Float64Array((l + 1) * (h + 1));
  // Cumul ligne par ligne
  for (let y = 0; y < h; y++) {
    let ligne = 0;
    for (let x = 0; x < l; x++) {
      ligne += gris[y * l + x];
      ii[(y + 1) * (l + 1) + x + 1] = ii[y * (l + 1) + x + 1] + ligne;
    }
  }
  return ii;
}

/** Moyenne des niveaux de gris dans un carré de demi-côté r centré en (x, y), borné à l'image. */
function moyenne(ii, l, h, x, y, r) {
  // Bornes
  const x0 = Math.max(0, x - r), x1 = Math.min(l, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
  // Somme par différence de coins
  const s = ii[y1 * (l + 1) + x1] - ii[y0 * (l + 1) + x1] - ii[y1 * (l + 1) + x0] + ii[y0 * (l + 1) + x0];
  // Moyenne
  return s / ((x1 - x0) * (y1 - y0));
}

/** Réglages selon la sensibilité (1 = prudent, 5 = très sensible) : plancher de contraste et facteur de bruit. */
const REGLAGES = { 1: [40, 7], 2: [30, 6], 3: [22, 5], 4: [16, 4], 5: [11, 3.2] };

/**
 * Cherche les trous dans une image en niveaux de gris.
 * @param {Float32Array} gris niveaux de gris (0 à 255), ligne par ligne
 * @param {Array<{visuel:number,x:number,y:number,rayon:number}>} zones disques à analyser (pixels)
 * @param {number} trouPx diamètre attendu d'un trou (pixels)
 * @param {number} sensibilite de 1 à 5
 * @returns {Array<{visuel:number,x:number,y:number,force:number,douteux:boolean}>} trous trouvés (pixels)
 */
export function detecterDansGris(gris, l, h, zones, trouPx, sensibilite = 3) {
  // Taille de référence d'un trou
  const D = Math.max(6, trouPx);
  // Petit carré (cœur du trou) et grand carré (papier autour)
  const r1 = Math.max(1, Math.round(D * 0.3)), r2 = Math.max(r1 + 2, Math.round(D * 1.25));
  // Surface attendue d'un trou
  const surfaceTrou = Math.PI * D * D / 4;
  // Réglages
  const [plancher, facteur] = REGLAGES[Math.min(5, Math.max(1, Math.round(sensibilite)))];
  // Image intégrale
  const ii = integrale(gris, l, h);
  // Résultat
  const trouves = [];

  for (const z of zones) {
    // Rectangle qui entoure le disque, borné à l'image
    const x0 = Math.max(0, Math.floor(z.x - z.rayon)), x1 = Math.min(l - 1, Math.ceil(z.x + z.rayon));
    const y0 = Math.max(0, Math.floor(z.y - z.rayon)), y1 = Math.min(h - 1, Math.ceil(z.y + z.rayon));
    const w = x1 - x0 + 1, hz = y1 - y0 + 1;
    // Réponse « petit carré − grand carré » et appartenance au disque
    const rep = new Float32Array(w * hz), dans = new Uint8Array(w * hz);
    const valeurs = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Hors du disque
        if ((x - z.x) ** 2 + (y - z.y) ** 2 > z.rayon * z.rayon) continue;
        // Contraste local
        const i = (y - y0) * w + (x - x0);
        rep[i] = moyenne(ii, l, h, x, y, r1) - moyenne(ii, l, h, x, y, r2);
        dans[i] = 1;
        valeurs.push(Math.abs(rep[i]));
      }
    }

    // Seuil : bruit de fond estimé par la médiane, avec un plancher
    if (valeurs.length === 0) continue;
    const triees = Float32Array.from(valeurs).sort();
    const sigma = triees[Math.floor(triees.length / 2)] * 1.4826;
    const seuil = Math.max(plancher, sigma * facteur);

    // Deux polarités : tache plus sombre que le papier (-1), plus claire que le noir (+1)
    for (const pol of [-1, 1]) {
      const vu = new Uint8Array(w * hz);
      for (let i0 = 0; i0 < w * hz; i0++) {
        // Pixel déjà vu ou sans contraste
        if (vu[i0] || !dans[i0] || rep[i0] * pol <= seuil) continue;
        // Parcours de la tache (8 voisins)
        const pile = [i0];
        vu[i0] = 1;
        let aire = 0, sx = 0, sy = 0, sp = 0, pic = 0, minx = w, maxx = 0, miny = hz, maxy = 0;
        while (pile.length) {
          const i = pile.pop();
          const x = i % w, y = (i - x) / w;
          // Poids = intensité de la réponse
          const p = rep[i] * pol;
          aire++; sx += x * p; sy += y * p; sp += p; pic = Math.max(pic, p);
          minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= hz) continue;
              const j = ny * w + nx;
              if (!vu[j] && dans[j] && rep[j] * pol > seuil) { vu[j] = 1; pile.push(j); }
            }
          }
        }

        // Forme : taille, rapport largeur/hauteur et remplissage du rectangle englobant
        const bw = maxx - minx + 1, bh = maxy - miny + 1;
        const plusGrand = Math.max(bw, bh), plusPetit = Math.min(bw, bh);
        if (aire < 0.1 * surfaceTrou || aire > 7 * surfaceTrou) continue;
        if (plusGrand > 3.2 * D || plusGrand / plusPetit > 2.4 || aire / (bw * bh) < 0.4) continue;
        // Trou trouvé (centre pondéré)
        trouves.push({ visuel: z.visuel, x: x0 + sx / sp, y: y0 + sy / sp, force: pic / seuil, douteux: plusGrand > 1.9 * D });
      }
    }
  }

  // Doublons (une même tache vue des deux polarités) : on garde la plus forte
  trouves.sort((a, b) => b.force - a.force);
  const uniques = [];
  for (const t of trouves) if (!uniques.some((u) => Math.hypot(u.x - t.x, u.y - t.y) < 0.8 * D)) uniques.push(t);
  return uniques;
}

// ===================== Calage =====================

/**
 * Calage à partir de deux points touchés.
 * Un seul visuel : A = centre, B = un point du bord extérieur de la dernière zone (échelle seulement).
 * Plusieurs visuels : A = centre du premier visuel (en haut à gauche), B = centre du dernier (échelle et rotation).
 * @returns {{ a:{x:number,y:number}, echelle:number, rotation:number }}
 */
export function caler(cible, a, b) {
  // Centres des visuels (mm, par rapport au centre du carton)
  const c = centresVisuels(cible);
  // Un seul visuel : le second point est sur le bord extérieur
  if (c.length === 1) return { a, echelle: Math.hypot(b.x - a.x, b.y - a.y) / (diametreExterieur(cible) / 2), rotation: 0 };
  // Plusieurs visuels : vecteur attendu (mm) et vecteur mesuré (pixels)
  const ex = c[c.length - 1].x - c[0].x, ey = c[c.length - 1].y - c[0].y;
  const px = b.x - a.x, py = b.y - a.y;
  return { a, echelle: Math.hypot(px, py) / Math.hypot(ex, ey), rotation: Math.atan2(py, px) - Math.atan2(ey, ex) };
}

/** Centre de chaque visuel sur la photo (pixels). */
export function centresPixels(cible, calage) {
  // Décalages (mm) par rapport au premier visuel
  const c = centresVisuels(cible);
  const cos = Math.cos(calage.rotation), sin = Math.sin(calage.rotation);
  return c.map((v, i) => {
    const dx = (v.x - c[0].x) * calage.echelle, dy = (v.y - c[0].y) * calage.echelle;
    return { visuel: i, x: calage.a.x + dx * cos - dy * sin, y: calage.a.y + dx * sin + dy * cos };
  });
}

/** Position d'un point de la photo (pixels) par rapport au centre du visuel (mm, Y vers le bas). */
export function enMm(calage, centre, p) {
  const dx = p.x - centre.x, dy = p.y - centre.y;
  const cos = Math.cos(-calage.rotation), sin = Math.sin(-calage.rotation);
  return { x: (dx * cos - dy * sin) / calage.echelle, y: (dx * sin + dy * cos) / calage.echelle };
}

// ===================== Écran =====================

/** Charge une photo, réduite à COTE_MAX pixels (l'orientation EXIF est respectée par le navigateur). */
async function chargerImage(fichier) {
  // Décodage
  let source;
  try { source = await createImageBitmap(fichier); } catch {
    source = await new Promise((ok, ko) => { const u = URL.createObjectURL(fichier), i = new Image(); i.onload = () => { URL.revokeObjectURL(u); ok(i); }; i.onerror = ko; i.src = u; });
  }
  // Réduction
  const k = Math.min(1, COTE_MAX / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * k); canvas.height = Math.round(source.height * k);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Niveaux de gris d'un canevas. */
function enGris(canvas) {
  const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  const gris = new Float32Array(canvas.width * canvas.height);
  for (let i = 0; i < gris.length; i++) gris[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return gris;
}

/**
 * Ouvre l'écran d'analyse d'une photo de cible.
 * @param {{ cible: object, trou: number, valider: (impacts: Array<{visuel:number,x:number,y:number}>) => void }} options
 *   cible : cible de la liste du PC ; trou : diamètre du trou (mm) ; valider : reçoit les impacts retenus (mm).
 */
export function ouvrirAnalysePhoto({ cible, trou, valider }) {
  // Visuels, rayon extérieur
  const nombreVisuels = centresVisuels(cible).length;
  // État
  let etape = "choix", image = null, gris = null, points = [], calage = null, centres = [], impacts = [], sensibilite = 3, loupeActive = false;

  // ----- Éléments -----
  const racine = el("div", { class: "photo-ecran" });
  const consigne = el("p", { class: "photo-consigne" });
  const canvas = el("canvas", { class: "photo-canvas" });
  const loupe = el("canvas", { class: "photo-loupe", width: 120, height: 120, hidden: true });
  const actions = el("div", { class: "barre-outils" });
  const resume = el("p", { class: "note" });
  const reglage = el("label", { class: "champ photo-sensibilite" }, el("span", {}, "Sensibilité"),
    el("input", { type: "range", min: 1, max: 5, step: 1, value: 3, oninput: (e) => { sensibilite = Number(e.target.value); detecter(); } }),
    el("small", {}, "Plus haut : plus de trous repérés, mais plus de fausses détections."));
  reglage.hidden = true;
  const fermer = () => { racine.remove(); loupe.remove(); };
  racine.append(
    el("div", { class: "photo-entete" }, el("strong", {}, "Analyse d'une photo de cible"), el("button", { onclick: fermer }, "Fermer")),
    consigne, canvas, actions, reglage, resume);
  document.body.append(racine, loupe);

  // ----- Choix de la photo -----
  const choisir = (capture) => {
    const champ = el("input", { type: "file", accept: "image/*", capture: capture ? "environment" : null, hidden: true });
    champ.addEventListener("change", async () => {
      const f = champ.files?.[0];
      if (!f) return;
      try {
        image = await chargerImage(f); gris = enGris(image);
        canvas.width = image.width; canvas.height = image.height;
        points = []; calage = null; impacts = []; etape = "points"; rafraichir();
      } catch { toast("Cette image ne peut pas être lue.", 4000); }
    });
    racine.append(champ);
    champ.click();
  };

  // ----- Détection -----
  const trouPx = () => Math.max(1, trou * calage.echelle);
  const detecter = () => {
    // Zones : disque un peu plus grand que la dernière zone
    const zones = centres.map((c) => ({ ...c, rayon: diametreExterieur(cible) / 2 * calage.echelle + 3 * trouPx() }));
    // Trous ajoutés à la main, conservés
    const manuels = impacts.filter((i) => i.manuel);
    // Détection automatique
    const auto = detecterDansGris(gris, image.width, image.height, zones, trouPx(), sensibilite).map((t) => ({ ...t, ...enMm(calage, centres[t.visuel], t) }));
    // Ordre de saisie arbitraire : par visuel, puis de haut en bas et de gauche à droite
    impacts = [...auto, ...manuels];
    etape = "revue"; rafraichir();
  };

  // ----- Dessin -----
  const rafraichir = () => {
    const ctx = canvas.getContext("2d");
    // Photo ou vide
    if (image) ctx.drawImage(image, 0, 0); else ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = !image;
    // Épaisseur de trait proportionnelle à la photo
    const e = Math.max(1.5, canvas.width / 450);
    // Points de calage touchés
    for (const p of points) {
      ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = e;
      ctx.beginPath(); ctx.moveTo(p.x - 12 * e, p.y); ctx.lineTo(p.x + 12 * e, p.y); ctx.moveTo(p.x, p.y - 12 * e); ctx.lineTo(p.x, p.y + 12 * e); ctx.stroke();
    }

    // Cercles des zones : à comparer aux cercles imprimés pour vérifier le calage
    if (calage) {
      ctx.strokeStyle = "rgba(0,200,255,.85)"; ctx.lineWidth = e * 0.6;
      for (const c of centres) for (let v = 10; v >= cible.valeurMin; v--) {
        ctx.beginPath(); ctx.arc(c.x, c.y, diametreZone(cible, v) / 2 * calage.echelle, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Trous retenus : numérotés ; orange = à vérifier ; bleu = ajouté à la main
    if (etape === "revue") {
      const r = Math.max(trouPx() * 0.8, 6 * e);
      ctx.font = `bold ${Math.round(10 * e)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ordonner(impacts).forEach((i, k) => {
        const p = enPixels(i);
        ctx.strokeStyle = i.manuel ? "#2f80ff" : i.douteux ? "#ff9500" : "#34c759"; ctx.lineWidth = e * 1.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle; ctx.fillText(String(k + 1), p.x, p.y - r - 7 * e);
      });
    }

    // Texte et boutons de l'étape
    if (etape === "choix") {
      consigne.textContent = "Prenez la cible en photo, de face, entière et bien éclairée (sans ombre), le plus près possible.";
      actions.replaceChildren(el("button", { class: "principal", onclick: () => choisir(true) }, "📷 Prendre une photo"), el("button", { onclick: () => choisir(false) }, "Choisir une image"));
      resume.textContent = "";
    } else if (etape === "points") {
      consigne.textContent = nombreVisuels === 1
        ? (points.length === 0 ? "1/2 — Touchez le centre du 10 (la loupe aide à viser)." : `2/2 — Touchez un point du bord de la dernière zone (valeur ${cible.valeurMin}), n'importe où sur le cercle.`)
        : (points.length === 0 ? "1/2 — Touchez le centre du premier visuel (en haut à gauche)." : "2/2 — Touchez le centre du dernier visuel (en bas à droite).");
      actions.replaceChildren(el("button", { onclick: () => choisir(true) }, "Autre photo"), el("button", { disabled: points.length === 0, onclick: () => { points = []; rafraichir(); } }, "Refaire le calage"));
      resume.textContent = "";
    } else if (etape === "verif") {
      consigne.textContent = "Vérifiez : les cercles bleus doivent se superposer aux cercles imprimés. Sinon, refaites le calage.";
      actions.replaceChildren(el("button", { onclick: () => { points = []; calage = null; etape = "points"; rafraichir(); } }, "Refaire le calage"), el("button", { class: "principal", onclick: detecter }, "Chercher les impacts"));
      resume.textContent = trouPx() < 5 ? "Attention : les trous font moins de 5 pixels sur la photo, rapprochez-vous pour une meilleure détection." : "";
    } else {
      consigne.textContent = "Touchez un cercle pour le retirer, ou un trou manqué pour l'ajouter (la loupe aide à viser).";
      const n = impacts.length, douteux = impacts.filter((i) => i.douteux).length;
      actions.replaceChildren(
        el("button", { onclick: () => { points = []; calage = null; impacts = []; etape = "points"; rafraichir(); } }, "Refaire"),
        el("button", { class: "principal", disabled: n === 0, onclick: () => { valider(ordonner(impacts).map((i) => ({ visuel: i.visuel, x: Math.round(i.x * 100) / 100, y: Math.round(i.y * 100) / 100 }))); fermer(); } }, `Ajouter ${n} impact(s)`));
      resume.textContent = `${n} impact(s) : ${impacts.filter((i) => !i.manuel).length} repéré(s), ${impacts.filter((i) => i.manuel).length} ajouté(s) à la main${douteux ? `, ${douteux} à vérifier (orange : peut-être deux trous voisins)` : ""}. Échelle : ${nombre(calage.echelle, 1)} pixels par mm.`;
    }
    reglage.hidden = etape !== "revue";
  };

  // Position d'un impact (mm) sur la photo (pixels)
  const enPixels = (i) => {
    const c = centres[i.visuel], cos = Math.cos(calage.rotation), sin = Math.sin(calage.rotation);
    return { x: c.x + (i.x * cos - i.y * sin) * calage.echelle, y: c.y + (i.x * sin + i.y * cos) * calage.echelle };
  };
  // Ordre d'affichage et de saisie : par visuel, puis de haut en bas et de gauche à droite
  const ordonner = (liste) => [...liste].sort((a, b) => a.visuel - b.visuel || Math.round(a.y / 8) - Math.round(b.y / 8) || a.x - b.x);

  // ----- Toucher, avec loupe -----
  const position = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * canvas.width / r.width, y: (ev.clientY - r.top) * canvas.height / r.height };
  };
  const montrerLoupe = (ev) => {
    if (!image) return;
    const p = position(ev), Z = 18, ctx = loupe.getContext("2d");
    // Zone agrandie 3,3 fois autour du doigt
    ctx.clearRect(0, 0, 120, 120);
    ctx.drawImage(canvas, p.x - Z, p.y - Z, 2 * Z, 2 * Z, 0, 0, 120, 120);
    ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(60, 0); ctx.lineTo(60, 120); ctx.moveTo(0, 60); ctx.lineTo(120, 60); ctx.stroke();
    // Au-dessus du doigt, sans sortir de l'écran
    loupe.style.left = `${Math.min(window.innerWidth - 124, Math.max(4, ev.clientX - 60))}px`;
    loupe.style.top = `${Math.max(4, ev.clientY - 150)}px`;
    loupe.hidden = false; loupeActive = true;
  };
  canvas.addEventListener("pointerdown", (ev) => { if (etape === "points" || etape === "revue") { canvas.setPointerCapture?.(ev.pointerId); montrerLoupe(ev); } });
  canvas.addEventListener("pointermove", (ev) => { if (loupeActive) montrerLoupe(ev); });
  canvas.addEventListener("pointercancel", () => { loupe.hidden = true; loupeActive = false; });
  canvas.addEventListener("pointerup", (ev) => {
    // Fin de la visée
    loupe.hidden = true; loupeActive = false;
    const p = position(ev);
    if (etape === "points") {
      // Point de calage
      points.push(p);
      if (points.length === 2) {
        calage = caler(cible, points[0], points[1]);
        centres = centresPixels(cible, calage);
        etape = "verif";
      }
      rafraichir();
    } else if (etape === "revue") {
      // Retrait d'un impact proche, sinon ajout à la main
      const rayon = Math.max(trouPx() * 1.2, canvas.width / 60);
      const proche = impacts.map((i) => ({ i, d: Math.hypot(enPixels(i).x - p.x, enPixels(i).y - p.y) })).filter((o) => o.d <= rayon).sort((a, b) => a.d - b.d)[0];
      if (proche) impacts.splice(impacts.indexOf(proche.i), 1);
      else {
        // Visuel le plus proche
        const v = centres.reduce((m, c) => (Math.hypot(c.x - p.x, c.y - p.y) < Math.hypot(centres[m].x - p.x, centres[m].y - p.y) ? c.visuel : m), 0);
        impacts.push({ visuel: v, ...enMm(calage, centres[v], p), force: 1, douteux: false, manuel: true });
      }
      rafraichir();
    }
  });

  // Premier écran
  rafraichir();
}
