// Calculs ISSF : mêmes règles que IssfService.cs sur le PC (le PC recalcule tout à l'import,
// ces calculs servent à l'affichage au stand).
// Cible (listes du PC) : { d10, pas, valeurMin, noir, mouche, largeur, hauteur, visuels, parLigne, ecart, ecartLignes }
// Discipline : { dixieme, regle (0 contact, 1 centre), mode (0 points, 1 extrêmes, 2 surface), impactsParCarton, retenus, cartons, maxSession }
// Impact : { carton (0 = essais), numero, visuel, x, y (mm, Y vers le bas), valeur, mouche }

/** Diamètre de la zone de valeur v (mm). */
export const diametreZone = (cible, v) => cible.d10 + (10 - v) * cible.pas;

/** Diamètre extérieur (zone de valeur minimale). */
export const diametreExterieur = (cible) => diametreZone(cible, cible.valeurMin);

/**
 * Points d'un impact. Distance retenue : bord du trou (règle « contact », le trou qui touche la
 * ligne compte la zone supérieure) ou centre du trou (règle « centre »).
 */
export function coter(cible, discipline, x, y, trou) {
  // Distance du centre du trou au centre du visuel
  const d = Math.hypot(x, y);
  // Rayon du trou pris en compte par la règle
  const rayonTrou = discipline.regle === 0 ? trou / 2 : 0;
  // Distance effective
  const e = d - rayonTrou;
  // Rayon du 10 et largeur d'une zone
  const r10 = cible.d10 / 2, w = cible.pas / 2;
  // Mouche (10 intérieur)
  const mouche = cible.mouche > 0 && e <= cible.mouche / 2 + 1e-9;
  // Valeur entière
  const valeur = e <= r10 + 1e-9 ? 10 : 10 - Math.ceil((e - r10) / w - 1e-9);
  // Hors cible
  if (valeur < cible.valeurMin) return { valeur: 0, mouche: false };
  // Points entiers
  if (!discipline.dixieme) return { valeur, mouche };
  // Dixièmes : position dans la zone (0 = intérieur, 9 = extérieur)
  let dixieme;
  // Zone 10 : du centre à la limite de la zone 10 pour le centre du trou
  if (valeur === 10) {
    // Étendue
    const etendue = r10 + rayonTrou;
    // Part
    dixieme = etendue <= 0 ? 0 : Math.floor(d / (etendue / 10) + 1e-9);
  } else {
    // Limite intérieure de la zone
    const interieur = r10 + (9 - valeur) * w;
    // Part
    dixieme = Math.floor((e - interieur) / (w / 10) + 1e-9);
  }
  // Points : x,9 à l'intérieur de la zone, x,0 à l'extérieur
  return { valeur: Math.round((valeur + 0.9 - Math.min(9, Math.max(0, dixieme)) * 0.1) * 10) / 10, mouche };
}

/** Score d'un carton : somme des impacts, ou des meilleurs si la discipline en retient une partie. */
export function scoreCarton(impacts, discipline) {
  // Valeurs de la meilleure à la moins bonne
  let valeurs = impacts.map((i) => i.valeur).sort((a, b) => b - a);
  // Seulement les meilleures
  if (discipline.retenus > 0) valeurs = valeurs.slice(0, discipline.retenus);
  // Somme arrondie au dixième
  return Math.round(valeurs.reduce((s, v) => s + v, 0) * 10) / 10;
}

/** Résultat de la session (match seulement) : points, ou moyenne des extrêmes (mm) / des surfaces (mm²). */
export function resultat(impacts, discipline) {
  // Cartons du match
  const cartons = new Map();
  // Regroupement
  for (const i of impacts.filter((i) => i.carton > 0)) {
    // Carton
    if (!cartons.has(i.carton)) cartons.set(i.carton, []);
    // Ajout
    cartons.get(i.carton).push(i);
  }
  // Aucun impact
  if (cartons.size === 0) return null;
  // Liste des cartons
  const liste = [...cartons.values()];
  // Points
  if (discipline.mode === 0) return Math.round(liste.reduce((s, c) => s + scoreCarton(c, discipline), 0) * 10) / 10;
  // Moyenne d'une statistique
  const moyenne = (f) => liste.reduce((s, c) => s + f(statistiques(c)), 0) / liste.length;
  // Extrêmes ou surface
  return discipline.mode === 1 ? Math.round(moyenne((s) => s.extremes) * 100) / 100 : Math.round(moyenne((s) => s.surface) * 10) / 10;
}

/** Résultat lisible. */
export function texteResultat(r, discipline) {
  // Pas de résultat
  if (r === null || r === undefined) return "—";
  // Selon le mode
  if (discipline.mode === 0) return `${r.toLocaleString("fr-FR", { minimumFractionDigits: discipline.dixieme ? 1 : 0, maximumFractionDigits: discipline.dixieme ? 1 : 0 })} pts`;
  // Extrêmes
  if (discipline.mode === 1) return `${r.toLocaleString("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} mm`;
  // Surface en cm²
  return `${(r / 100).toLocaleString("fr-FR", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} cm²`;
}

/** Statistiques d'un groupement : point moyen, écarts, extrêmes, surface, rayon moyen. */
export function statistiques(impacts) {
  // Positions
  const p = impacts.map((i) => ({ x: i.x, y: i.y }));
  // Aucun impact
  if (p.length === 0) return { nombre: 0, moyen: { x: 0, y: 0 }, ecartX: 0, ecartY: 0, extremes: 0, surface: 0, rayon: 0 };
  // Point moyen
  const moyen = { x: p.reduce((s, i) => s + i.x, 0) / p.length, y: p.reduce((s, i) => s + i.y, 0) / p.length };
  // Écarts maximum
  const xs = p.map((i) => i.x), ys = p.map((i) => i.y);
  // Distance des extrêmes
  let extremes = 0;
  // Toutes les paires
  for (let a = 0; a < p.length; a++) for (let b = a + 1; b < p.length; b++) extremes = Math.max(extremes, Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y));
  // Résultat
  return {
    nombre: p.length, moyen,
    ecartX: Math.max(...xs) - Math.min(...xs), ecartY: Math.max(...ys) - Math.min(...ys),
    extremes, surface: surface(p),
    rayon: p.reduce((s, i) => s + Math.hypot(i.x - moyen.x, i.y - moyen.y), 0) / p.length
  };
}

/** Enveloppe convexe (chaîne monotone), sommets dans l'ordre. */
export function enveloppe(points) {
  // Points triés sans doublons
  const p = [...new Map(points.map((i) => [`${i.x};${i.y}`, i])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  // Moins de 3 points
  if (p.length < 3) return p;
  // Signe du virage
  const virage = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  // Enveloppe
  const h = [];
  // Partie basse
  for (const q of p) { while (h.length >= 2 && virage(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop(); h.push(q); }
  // Partie haute
  const bas = h.length + 1;
  // Parcours inverse
  for (let i = p.length - 2; i >= 0; i--) { while (h.length >= bas && virage(h[h.length - 2], h[h.length - 1], p[i]) <= 0) h.pop(); h.push(p[i]); }
  // Le dernier point est le premier
  h.pop();
  // Résultat
  return h;
}

/** Surface (mm²) de l'enveloppe convexe. */
function surface(points) {
  // Enveloppe
  const e = enveloppe(points);
  // Moins de 3 sommets
  if (e.length < 3) return 0;
  // Formule du lacet
  let s = 0;
  // Chaque côté
  for (let i = 0; i < e.length; i++) { const a = e[i], b = e[(i + 1) % e.length]; s += a.x * b.y - b.x * a.y; }
  // Surface
  return Math.abs(s) / 2;
}

/** Centres des visuels sur le carton (mm, par rapport au centre du carton) — même grille que le PC. */
export function centresVisuels(cible) {
  // Nombre de visuels et de colonnes
  const n = Math.max(1, cible.visuels), colonnes = Math.min(Math.max(1, cible.parLigne), n);
  // Nombre de lignes
  const lignes = Math.ceil(n / colonnes);
  // Écart entre deux centres (à défaut : diamètre extérieur + 10 %)
  const ecart = cible.ecart > 0 ? cible.ecart : diametreExterieur(cible) * 1.1;
  // Écart entre deux lignes
  const ecartLignes = cible.ecartLignes > 0 ? cible.ecartLignes : ecart;
  // Centres
  return Array.from({ length: n }, (_, i) => ({ x: (i % colonnes - (colonnes - 1) / 2) * ecart, y: (Math.floor(i / colonnes) - (lignes - 1) / 2) * ecartLignes }));
}

/** Premier carton du match qui n'est pas plein (le dernier s'ils le sont tous). */
export function cartonEnCours(impacts, discipline) {
  // Chaque carton
  for (let c = 1; c <= discipline.cartons; c++) if (impacts.filter((i) => i.carton === c).length < discipline.impactsParCarton) return c;
  // Tous pleins
  return discipline.cartons;
}

/** Le match est-il complet ? */
export const matchComplet = (impacts, discipline) => impacts.filter((i) => i.carton > 0).length >= discipline.impactsParCarton * discipline.cartons;
