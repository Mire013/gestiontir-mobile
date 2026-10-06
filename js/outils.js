// Petits outils communs : création d'éléments, dates, nombres, identifiants.

/** Crée un élément HTML : el("button", { class: "x", onclick: f }, "Texte", autreElement). */
export function el(balise, attributs = {}, ...enfants) {
  // Élément
  const e = document.createElement(balise);
  // Attributs et gestionnaires d'événements
  for (const [nom, valeur] of Object.entries(attributs ?? {})) {
    // Valeur absente : attribut ignoré
    if (valeur === null || valeur === undefined || valeur === false) continue;
    // Gestionnaire d'événement (onclick, oninput...)
    if (nom.startsWith("on") && typeof valeur === "function") e.addEventListener(nom.slice(2), valeur);
    // Propriétés à poser directement (valeur d'un champ, case cochée)
    else if (nom === "value" || nom === "checked" || nom === "selected") e[nom] = valeur;
    // Attribut booléen
    else if (valeur === true) e.setAttribute(nom, "");
    // Attribut ordinaire
    else e.setAttribute(nom, valeur);
  }
  // Enfants : textes ou éléments (les tableaux sont aplatis, les vides ignorés)
  for (const enfant of enfants.flat(Infinity)) {
    // Rien
    if (enfant === null || enfant === undefined || enfant === false) continue;
    // Texte ou élément
    e.append(enfant instanceof Node ? enfant : document.createTextNode(String(enfant)));
  }
  // Résultat
  return e;
}

/** Identifiant unique (même format que les Guid du PC). */
export const nouvelId = () => crypto.randomUUID();

/** Deux chiffres. */
const d2 = (n) => String(n).padStart(2, "0");

/** Date et heure locales au format ISO sans fuseau : "2026-10-05T14:30:00" (lue telle quelle par le PC). */
export function isoLocal(date = new Date()) {
  // Composants locaux
  return `${date.getFullYear()}-${d2(date.getMonth() + 1)}-${d2(date.getDate())}T${d2(date.getHours())}:${d2(date.getMinutes())}:00`;
}

/** Heure "HH:mm" d'une date. */
export const heureDe = (date = new Date()) => `${d2(date.getHours())}:${d2(date.getMinutes())}`;

/** Date lisible "05/10/2026 14:30" d'un texte ISO local. */
export function dateLisible(iso, avecHeure = true) {
  // Découpe du texte ISO
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso ?? "");
  // Texte
  return m ? `${m[3]}/${m[2]}/${m[1]}${avecHeure ? ` ${m[4]}:${m[5]}` : ""}` : "";
}

/** Nombre à la française ("10,5") avec un nombre de décimales fixe. */
export const nombre = (v, decimales = 0) => (v ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: decimales, maximumFractionDigits: decimales });

/** Lit un nombre saisi ("10,5" ou "10.5") ; null si vide ou illisible. */
export function lireNombre(texte) {
  // Texte nettoyé
  const t = String(texte ?? "").trim().replace(",", ".");
  // Vide
  if (t === "") return null;
  // Nombre
  const v = Number(t);
  // Résultat
  return Number.isFinite(v) ? v : null;
}

/** Octets → Base64. */
export function versBase64(octets) {
  // Texte binaire
  let s = "";
  // Chaque octet
  for (const o of octets) s += String.fromCharCode(o);
  // Encodage
  return btoa(s);
}

/** Base64 → octets. */
export function depuisBase64(texte) {
  // Texte binaire
  const s = atob(texte);
  // Octets
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** 16 octets (ordre big-endian) → Guid "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx". */
export function guidDepuisOctets(octets) {
  // Hexadécimal
  const h = Array.from(octets, (o) => o.toString(16).padStart(2, "0")).join("");
  // Format Guid
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Petit message temporaire en bas de l'écran. */
export function toast(texte, duree = 2600) {
  // Zone des messages
  const zone = document.getElementById("toasts");
  // Message
  const m = el("div", { class: "toast" }, texte);
  // Affichage
  zone.append(m);
  // Disparition
  setTimeout(() => m.remove(), duree);
}

/** Boîte de confirmation (renvoie une promesse vrai / faux). */
export function confirmer(texte, oui = "Oui", non = "Annuler") {
  // Promesse résolue par l'un des boutons
  return new Promise((resoudre) => {
    // Fond
    const fond = el("div", { class: "modale-fond" });
    // Fermeture avec la réponse
    const fermer = (r) => { fond.remove(); resoudre(r); };
    // Contenu
    fond.append(el("div", { class: "modale" },
      el("p", {}, texte),
      el("div", { class: "barre" },
        el("button", { class: "secondaire", onclick: () => fermer(false) }, non),
        el("button", { class: "principal", onclick: () => fermer(true) }, oui))));
    // Affichage
    document.body.append(fond);
  });
}
