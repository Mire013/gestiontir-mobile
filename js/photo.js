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

/**
 * Densité d'une tache : part des pixels du cœur (disque de 0,35 diamètre de trou) qui s'écartent franchement du fond.
 * Un trou est plein (densité proche de 1) ; un chiffre ou un trait imprimé ne remplit qu'une fraction du disque.
 * @param {number} pol -1 : tache plus sombre que le fond ; +1 : plus claire
 */
function densite(gris, l, h, cx, cy, D, pol) {
  // Fond : médiane de quelques pixels sur une couronne autour du trou
  const fond = [];
  for (let a = 0; a < 24; a++) for (const f of [0.9, 1.15, 1.4]) {
    const x = Math.round(cx + Math.cos(a / 24 * 6.2832) * D * f), y = Math.round(cy + Math.sin(a / 24 * 6.2832) * D * f);
    if (x >= 0 && y >= 0 && x < l && y < h) fond.push(gris[y * l + x]);
  }
  if (fond.length < 10) return 0;
  fond.sort((p, q) => p - q);
  const bg = fond[fond.length >> 1];
  // Écarts (dans le sens de la tache) sur le cœur
  const R = Math.max(2, D * 0.35), ecarts = [];
  for (let y = Math.round(cy - R); y <= Math.round(cy + R); y++) for (let x = Math.round(cx - R); x <= Math.round(cx + R); x++) {
    if (x < 0 || y < 0 || x >= l || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
    ecarts.push(pol * (gris[y * l + x] - bg));
  }
  if (ecarts.length < 5) return 0;
  const tries = [...ecarts].sort((p, q) => p - q);
  // Niveau de référence : 90e centile ; il faut un vrai contraste
  const q90 = tries[Math.floor(tries.length * 0.9)];
  if (q90 < 15) return 0;
  return ecarts.filter((e) => e >= 0.5 * q90).length / ecarts.length;
}

/** Réglages selon la sensibilité (1 = prudent, 5 = très sensible) : plancher de contraste et facteur de bruit. */
// Densité minimale du cœur d'une tache pour être un trou (les chiffres imprimés sont bien en dessous)
const SEUIL_DENSITE = 0.55;
// Noyau d'un trou : pixel sous SEUIL_NOYAU et sous FRACTION_NOYAU du fond local
const SEUIL_NOYAU = 30, FRACTION_NOYAU = 0.3;
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
        // Un chiffre ou un trait imprimé ne remplit pas le cœur de la tache : on l'écarte
        const xc = x0 + sx / sp, yc = y0 + sy / sp, dens = densite(gris, l, h, xc, yc, D, pol);
        if (dens < SEUIL_DENSITE) continue;
        // Trou trouvé (centre pondéré)
        trouves.push({ visuel: z.visuel, x: xc, y: yc, force: pic / seuil, densite: dens, douteux: plusGrand > 1.9 * D });
      }
    }
  }

  // Noyaux très sombres (le fond d'un trou est presque noir, même dans le noir de la cible) : détecteur principal
  const uniques = [];
  for (const z of zones) uniques.push(...noyauxSombres(gris, l, h, ii, z, D, r2).map((n) => ({ ...n, visuel: z.visuel })));
  // Taches de contraste local : seulement si elles ne retrouvent pas un trou déjà vu (même tache vue des deux polarités : la plus forte)
  trouves.sort((a, b) => b.force - a.force);
  for (const t of trouves) if (!uniques.some((u) => Math.hypot(u.x - t.x, u.y - t.y) < 0.8 * D)) uniques.push(t);
  return uniques;
}

/**
 * Trous repérés par leur noyau très sombre : pixels bien plus sombres que le papier voisin (jamais le cas d'un chiffre
 * ou d'un trait imprimé). Les noyaux proches sont regroupés ; un groupe allongé est découpé en plusieurs trous.
 * @returns {Array<{x:number,y:number,force:number,densite:number,douteux:boolean}>}
 */
function noyauxSombres(gris, l, h, ii, z, D, r2) {
  // Pixels du noyau : sous 30, et sous 30 % du fond local (photo sombre : seuil plus bas)
  const x0 = Math.max(0, Math.floor(z.x - z.rayon)), x1 = Math.min(l - 1, Math.ceil(z.x + z.rayon));
  const y0 = Math.max(0, Math.floor(z.y - z.rayon)), y1 = Math.min(h - 1, Math.ceil(z.y + z.rayon));
  const w = x1 - x0 + 1, hz = y1 - y0 + 1, sombre = new Uint8Array(w * hz);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    // Pixel nettement sombre (test rapide) dans le disque
    if (gris[y * l + x] >= SEUIL_NOYAU || (x - z.x) ** 2 + (y - z.y) ** 2 > z.rayon * z.rayon) continue;
    // Plus sombre que 30 % du fond local, et d'au moins 25 niveaux : le bruit d'une photo sombre ne suffit pas
    const fond = moyenne(ii, l, h, x, y, r2);
    if (gris[y * l + x] < FRACTION_NOYAU * fond && fond - gris[y * l + x] >= 25) sombre[(y - y0) * w + (x - x0)] = 1;
  }
  // Pixels isolés (grain, bruit) écartés : un pixel du noyau a au moins un voisin sombre
  const px = [];
  for (let y = 1; y < hz - 1; y++) for (let x = 1; x < w - 1; x++) {
    if (!sombre[y * w + x]) continue;
    let voisins = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && sombre[(y + dy) * w + x + dx]) voisins++;
    if (voisins >= 0) px.push({ x: x + x0, y: y + y0 });
  }
  // Trop de pixels sombres (fond noir dans la zone) : ce détecteur ne s'applique pas
  if (px.length === 0 || px.length > 30000) return [];
  // Regroupement des pixels proches (distance maximale 0,55 diamètre de trou), par grille
  const g = Math.max(2, D * 0.55), cases = new Map();
  px.forEach((p, i) => { const k = `${Math.floor(p.x / g)},${Math.floor(p.y / g)}`; (cases.get(k) ?? cases.set(k, []).get(k)).push(i); });
  const groupe = new Int32Array(px.length).fill(-1), groupes = [];
  for (let i0 = 0; i0 < px.length; i0++) {
    if (groupe[i0] >= 0) continue;
    const pile = [i0], membres = [];
    groupe[i0] = groupes.length;
    while (pile.length) {
      const i = pile.pop(); membres.push(px[i]);
      const cx = Math.floor(px[i].x / g), cy = Math.floor(px[i].y / g);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const j of cases.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (groupe[j] < 0 && Math.hypot(px[j].x - px[i].x, px[j].y - px[i].y) <= g) { groupe[j] = groupes.length; pile.push(j); }
      }
    }
    groupes.push(membres);
  }

  const resultat = [];
  for (const m of groupes) {
    // Trop peu de pixels sombres : poussière ou grain
    if (m.length < 5) continue;
    // Centre, axe principal et longueur du groupe
    const mx = m.reduce((s, p) => s + p.x, 0) / m.length, my = m.reduce((s, p) => s + p.y, 0) / m.length;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const p of m) { cxx += (p.x - mx) ** 2; cyy += (p.y - my) ** 2; cxy += (p.x - mx) * (p.y - my); }
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ux = Math.cos(angle), uy = Math.sin(angle);
    let pmin = Infinity, pmax = -Infinity;
    for (const p of m) { const t = (p.x - mx) * ux + (p.y - my) * uy; pmin = Math.min(pmin, t); pmax = Math.max(pmax, t); }
    const longueur = pmax - pmin;
    // Largeur du groupe, perpendiculairement à l'axe : un trait imprimé (cercle, chiffre) est long et fin, un noyau de trou est ramassé
    let qmin = Infinity, qmax = -Infinity;
    for (const p of m) { const q = -(p.x - mx) * uy + (p.y - my) * ux; qmin = Math.min(qmin, q); qmax = Math.max(qmax, q); }
    if (qmax - qmin < 0.35 * longueur && longueur > 4) continue;
    // Groupe démesuré (ligne, bord de la photo, tapis) : ignoré
    if (longueur > 3.2 * D) continue;
    // Nombre de trous : 1 sauf si le groupe est long (des trous qui se touchent)
    const n = Math.min(4, Math.max(1, Math.round((longueur - 0.6 * D) / (0.9 * D)) + 1));
    for (let i = 0; i < n; i++) {
      // Un seul trou : centre du groupe ; plusieurs : répartis le long de l'axe (positions relatives au centre du groupe), un peu en retrait des extrémités
      const t = n === 1 ? 0 : pmin + 0.3 * D + i * (longueur - 0.6 * D) / (n - 1);
      resultat.push({ x: mx + t * ux, y: my + t * uy, force: Math.min(3, m.length / 12), densite: 1, douteux: n > 1 || longueur > 1.2 * D });
    }
  }
  return resultat;
}

// ===================== Calage =====================

/**
 * Cherche le visuel noir autour d'un point touché approximativement (le centre) et renvoie son centre et son rayon (pixels).
 * Principe : 72 rayons partent du point ; sur chacun, le bord du disque noir est la première zone claire d'au moins 14 pixels
 * qui suit une zone sombre. Les rayons aberrants (chiffres, lignes blanches) sont écartés, puis un cercle est ajusté.
 * @returns {{x:number,y:number,rayon:number}|null} null si la forme n'est pas assez nette
 */
export function trouverVisuelNoir(gris, l, h, p) {
  // Seuil sombre/clair : milieu entre les 10 % les plus sombres et les 10 % les plus clairs autour du point
  const cote = Math.round(Math.min(l, h) * 0.3), echantillon = [];
  for (let y = Math.max(0, Math.round(p.y) - cote); y < Math.min(h, Math.round(p.y) + cote); y += 3)
    for (let x = Math.max(0, Math.round(p.x) - cote); x < Math.min(l, Math.round(p.x) + cote); x += 3) echantillon.push(gris[y * l + x]);
  echantillon.sort((a, b) => a - b);
  const seuil = (echantillon[Math.floor(echantillon.length * 0.1)] + echantillon[Math.floor(echantillon.length * 0.9)]) / 2;
  // Portée maximale d'un rayon
  const portee = Math.round(Math.min(l, h) * 0.45), rayons = [];
  for (let a = 0; a < 72; a++) {
    const ca = Math.cos(a / 72 * 6.2832), sa = Math.sin(a / 72 * 6.2832);
    // Niveau (clair = vrai) du pixel à la distance r
    const clair = (r) => { const x = Math.round(p.x + ca * r), y = Math.round(p.y + sa * r); return x < 0 || y < 0 || x >= l || y >= h ? true : gris[y * l + x] > seuil; };
    let sombres = 0;
    for (let r = 2; r < portee; r++) {
      if (!clair(r)) { sombres++; continue; }
      // Zone claire : sustentée sur 14 pixels, après une vraie zone sombre
      if (sombres > 20) { let ok = true; for (let j = 1; j <= 14 && ok; j++) ok = clair(r + j); if (ok) { rayons.push({ a: a / 72 * 6.2832, r }); break; } }
    }
  }
  if (rayons.length < 36) return null;
  // Rayon médian et rayons proches de lui
  const triees = rayons.map((q) => q.r).sort((a, b) => a - b), med = triees[triees.length >> 1];
  const bons = rayons.filter((q) => Math.abs(q.r - med) < 0.12 * med).map((q) => ({ x: p.x + Math.cos(q.a) * q.r, y: p.y + Math.sin(q.a) * q.r }));
  if (bons.length < 30) return null;
  // Ajustement d'un cercle par les moindres carrés (méthode algébrique)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0; const n = bons.length;
  for (const q of bons) { const z = q.x * q.x + q.y * q.y; sx += q.x; sy += q.y; sxx += q.x * q.x; syy += q.y * q.y; sxy += q.x * q.y; sz += z; sxz += q.x * z; syz += q.y * z; }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], B = [sxz, syz, sz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d0 = det(A); if (Math.abs(d0) < 1e-9) return null;
  const rem = (c) => A.map((ligne, i) => ligne.map((v, j) => (j === c ? B[i] : v)));
  const a = det(rem(0)) / d0, b = det(rem(1)) / d0, c = det(rem(2)) / d0;
  const cx = a / 2, cy = b / 2, rayon = Math.sqrt(Math.max(0, c + cx * cx + cy * cy));
  // Contrôle : écart moyen des points au cercle
  const ecart = bons.reduce((s, q) => s + Math.abs(Math.hypot(q.x - cx, q.y - cy) - rayon), 0) / n;
  if (!(rayon > 0.03 * Math.min(l, h)) || ecart > 0.04 * rayon) return null;
  return { x: cx, y: cy, rayon };
}

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
  let etape = "choix", image = null, gris = null, points = [], calage = null, centres = [], impacts = [], sensibilite = 4, manuel = false, loupeActive = false;

  // ----- Éléments -----
  const racine = el("div", { class: "photo-ecran" });
  const consigne = el("p", { class: "photo-consigne" });
  const canvas = el("canvas", { class: "photo-canvas" });
  const loupe = el("canvas", { class: "photo-loupe", width: 160, height: 160, hidden: true });
  const actions = el("div", { class: "barre-outils" });
  const resume = el("p", { class: "note" });
  const reglage = el("label", { class: "champ photo-sensibilite" }, el("span", {}, "Sensibilité"),
    el("input", { type: "range", min: 1, max: 5, step: 1, value: 4, oninput: (e) => { sensibilite = Number(e.target.value); detecter(); } }),
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
    const zones = centres.map((c) => ({ ...c, rayon: diametreExterieur(cible) / 2 * calage.echelle + 0.5 * trouPx() }));
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
      actions.replaceChildren(el("button", { class: "principal", onclick: () => choisir(true) }, "ðŸ“· Prendre une photo"), el("button", { onclick: () => choisir(false) }, "Choisir une image"));
      resume.textContent = "";
    } else if (etape === "points") {
      consigne.textContent = nombreVisuels === 1
        ? (points.length === 0 ? (cible.noir > 0 && !manuel ? "Touchez le centre de la cible, à peu près : le téléphone repère ensuite le visuel noir tout seul." : "1/2 — Touchez le centre du 10 (la loupe aide à viser).") : `2/2 — Touchez un point du bord de la dernière zone (valeur ${cible.valeurMin}), n'importe où sur le cercle.`)
        : (points.length === 0 ? "1/2 — Touchez le centre du premier visuel (en haut à gauche)." : "2/2 — Touchez le centre du dernier visuel (en bas à droite).");
      actions.replaceChildren(el("button", { onclick: () => choisir(true) }, "Autre photo"), el("button", { disabled: points.length === 0, onclick: () => { points = []; rafraichir(); } }, "Refaire le calage"));
      resume.textContent = "";
    } else if (etape === "verif") {
      consigne.textContent = "Vérifiez : les cercles bleus doivent se superposer aux cercles imprimés. Sinon, refaites le calage.";
      actions.replaceChildren(el("button", { onclick: () => { points = []; calage = null; manuel = false; etape = "points"; rafraichir(); } }, "Refaire"), el("button", { onclick: () => { points = []; calage = null; manuel = true; etape = "points"; rafraichir(); } }, "Calage manuel"), el("button", { class: "principal", onclick: detecter }, "Chercher les impacts"));
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
    const p = position(ev), Z = Math.min(130, Math.max(20, image.width / 16)), ctx = loupe.getContext("2d");
    // Zone agrandie autour du doigt : environ un huitième de la largeur de la photo, pour voir la mouche et les cercles voisins
    ctx.clearRect(0, 0, 160, 160);
    ctx.drawImage(canvas, p.x - Z, p.y - Z, 2 * Z, 2 * Z, 0, 0, 160, 160);
    ctx.strokeStyle = "#ff3b30"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(80, 70); ctx.lineTo(80, 90); ctx.moveTo(70, 80); ctx.lineTo(90, 80); ctx.stroke();
    // Au-dessus du doigt, sans sortir de l'écran
    loupe.style.left = `${Math.min(window.innerWidth - 164, Math.max(4, ev.clientX - 80))}px`;
    loupe.style.top = `${Math.max(4, ev.clientY - 190)}px`;
    loupe.hidden = false; loupeActive = true;
  };
  canvas.addEventListener("pointerdown", (ev) => { if (etape === "points" || etape === "revue") { try { canvas.setPointerCapture?.(ev.pointerId); } catch { /* geste synthétique ou terminé */ } montrerLoupe(ev); } });
  canvas.addEventListener("pointermove", (ev) => { if (loupeActive) montrerLoupe(ev); });
  canvas.addEventListener("pointercancel", () => { loupe.hidden = true; loupeActive = false; });
  canvas.addEventListener("pointerup", (ev) => {
    // Fin de la visée
    loupe.hidden = true; loupeActive = false;
    const p = position(ev);
    if (etape === "points") {
      // Point de calage
      points.push(p);
      // Cible à un seul visuel noir : le premier toucher suffit, le téléphone repère le disque noir
      if (points.length === 1 && !manuel && cible.noir > 0 && nombreVisuels === 1) {
        const noir = trouverVisuelNoir(gris, image.width, image.height, p);
        if (noir) {
          points = [{ x: noir.x, y: noir.y }];
          calage = { a: { x: noir.x, y: noir.y }, echelle: noir.rayon / (cible.noir / 2), rotation: 0 };
          centres = centresPixels(cible, calage);
          etape = "verif";
          toast("Visuel noir repéré : vérifiez les cercles bleus.", 3500);
        } else {
          toast("Visuel noir non repéré : touchez maintenant un point du bord de la dernière zone.", 4500);
          manuel = true;
        }
      } else if (points.length === 2) {
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
