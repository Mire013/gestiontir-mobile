// Paquets échangés avec le PC : même format que SyncMobile.cs côté PC.
// Paquet = en-tête "GT" + version 1 + type ('L' listes, 'S' saisies), nonce de 12 octets,
// puis JSON compressé (deflate brut) et chiffré en AES-256-GCM (l'en-tête est authentifié).
// En QR code : texte Base45 découpé en morceaux "GT:id:i:n:morceau".

// Alphabet Base45 (RFC 9285) = caractères du mode alphanumérique des QR codes
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

/** Types de paquets. */
export const TYPE_LISTES = "L".charCodeAt(0);
export const TYPE_SAISIES = "S".charCodeAt(0);

/** Octets → texte Base45. */
export function base45Encoder(octets) {
  // Texte
  let t = "";
  // Par paires d'octets : trois caractères, poids faible d'abord
  for (let i = 0; i + 1 < octets.length; i += 2) {
    // Nombre de 0 à 65535
    const n = octets[i] * 256 + octets[i + 1];
    // Trois caractères
    t += ALPHABET[n % 45] + ALPHABET[Math.floor(n / 45) % 45] + ALPHABET[Math.floor(n / 2025)];
  }
  // Octet seul à la fin : deux caractères
  if (octets.length % 2 === 1) {
    // Dernier octet
    const n = octets[octets.length - 1];
    // Deux caractères
    t += ALPHABET[n % 45] + ALPHABET[Math.floor(n / 45)];
  }
  // Résultat
  return t;
}

/** Texte Base45 → octets (exception si invalide). */
export function base45Decoder(texte) {
  // Valeur d'un caractère
  const v = (c) => { const k = ALPHABET.indexOf(c); if (k < 0) throw new Error("Texte Base45 invalide"); return k; };
  // Octets
  const octets = [];
  // Groupes de trois caractères
  let i = 0;
  // Groupes complets
  for (; i + 2 < texte.length; i += 3) {
    // Nombre
    const n = v(texte[i]) + v(texte[i + 1]) * 45 + v(texte[i + 2]) * 2025;
    // Contrôle
    if (n > 65535) throw new Error("Texte Base45 invalide");
    // Deux octets
    octets.push(n >> 8, n & 255);
  }
  // Reste de deux caractères : un octet
  if (texte.length - i === 2) {
    // Nombre
    const n = v(texte[i]) + v(texte[i + 1]) * 45;
    // Contrôle
    if (n > 255) throw new Error("Texte Base45 invalide");
    // Octet
    octets.push(n);
  } else if (texte.length - i === 1) {
    // Longueur impossible
    throw new Error("Texte Base45 tronqué");
  }
  // Résultat
  return Uint8Array.from(octets);
}

/** Transforme un flux (compression / décompression) appliqué à des octets. */
async function transformer(octets, flux) {
  // Flux d'entrée → transformation → réponse lisible d'un coup
  return new Uint8Array(await new Response(new Blob([octets]).stream().pipeThrough(flux)).arrayBuffer());
}

/** Compression deflate brute (comme DeflateStream du PC). */
const compresser = (octets) => transformer(octets, new CompressionStream("deflate-raw"));

/** Décompression deflate brute. */
const decompresser = (octets) => transformer(octets, new DecompressionStream("deflate-raw"));

/** Clé AES (octets bruts) prête pour WebCrypto. */
const cleAes = (cle) => crypto.subtle.importKey("raw", cle, "AES-GCM", false, ["encrypt", "decrypt"]);

/** Chiffre un objet en paquet (octets). */
export async function chiffrerPaquet(cle, type, objet) {
  // En-tête authentifié
  const entete = Uint8Array.of(71, 84, 1, type);
  // JSON compressé
  const clair = await compresser(new TextEncoder().encode(JSON.stringify(objet)));
  // Nonce aléatoire
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  // Chiffrement (résultat = texte chiffré suivi de l'étiquette de 16 octets, comme côté PC)
  const chiffre = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: entete, tagLength: 128 }, await cleAes(cle), clair));
  // Assemblage
  const paquet = new Uint8Array(4 + 12 + chiffre.length);
  // En-tête
  paquet.set(entete, 0);
  // Nonce
  paquet.set(nonce, 4);
  // Données
  paquet.set(chiffre, 16);
  // Résultat
  return paquet;
}

/** Déchiffre un paquet : { type, objet } ; exception lisible si la clé ne convient pas. */
export async function dechiffrerPaquet(cle, paquet) {
  // Contrôle de l'en-tête
  if (paquet.length < 32 || paquet[0] !== 71 || paquet[1] !== 84 || paquet[2] !== 1) {
    // Refus
    throw new Error("Ce fichier n'est pas un paquet Gestion Tir.");
  }
  // Déchiffrement
  let clair;
  try {
    // Vérifie l'authenticité et déchiffre
    clair = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: paquet.slice(4, 16), additionalData: paquet.slice(0, 4), tagLength: 128 }, await cleAes(cle), paquet.slice(16)));
  } catch {
    // Mauvaise clé : téléphone jumelé avec un autre PC, ou paquet abîmé
    throw new Error("Ce paquet n'a pas pu être déchiffré : le téléphone n'est pas jumelé avec ce PC, ou le fichier est abîmé.");
  }
  // JSON
  return { type: paquet[3], objet: JSON.parse(new TextDecoder().decode(await decompresser(clair))) };
}

/** Découpe un paquet en textes de QR codes (au plus "taille" caractères de données par code). */
export function decouperQr(paquet, taille = 500) {
  // Texte Base45
  const texte = base45Encoder(paquet);
  // Identifiant du message (4 caractères hexadécimaux en majuscules)
  const id = Array.from(crypto.getRandomValues(new Uint8Array(2)), (o) => o.toString(16).padStart(2, "0")).join("").toUpperCase();
  // Nombre de morceaux
  const n = Math.max(1, Math.ceil(texte.length / taille));
  // Morceaux
  return Array.from({ length: n }, (_, i) => `GT:${id}:${i + 1}:${n}:${texte.slice(i * taille, (i + 1) * taille)}`);
}

/** Rassemble les morceaux lus dans une suite de QR codes. */
export class AssembleurQr {
  // Morceaux reçus
  morceaux = new Map();
  // Message en cours
  id = null;
  // Nombre attendu
  total = 0;

  /** Ajoute un texte lu ; renvoie le paquet complet, ou null s'il manque des morceaux. */
  ajouter(texte) {
    // Découpe "GT:id:i:n:morceau" (le morceau peut contenir ':')
    const m = /^GT:([0-9A-F]{4}):(\d+):(\d+):(.*)$/s.exec(texte);
    // Pas un morceau de paquet
    if (!m) return null;
    // Numéro et total
    const i = Number(m[2]), n = Number(m[3]);
    // Incohérent
    if (i < 1 || i > n) return null;
    // Nouveau message : on repart de zéro
    if (m[1] !== this.id) { this.id = m[1]; this.total = n; this.morceaux.clear(); }
    // Morceau
    this.morceaux.set(i, m[4]);
    // Incomplet
    if (this.morceaux.size < this.total) return null;
    // Paquet complet
    let texteComplet = "";
    // Dans l'ordre
    for (let k = 1; k <= this.total; k++) texteComplet += this.morceaux.get(k);
    // Octets
    return base45Decoder(texteComplet);
  }
}

/** Lit le texte du QR code de jumelage "GTJ:..." : clé (32 octets) et identifiant du jumelage (16 octets). */
export function lireJumelage(texte) {
  // Préfixe attendu
  if (!texte.startsWith("GTJ:")) return null;
  // Octets
  const octets = base45Decoder(texte.slice(4));
  // Taille attendue
  if (octets.length !== 48) return null;
  // Résultat
  return { cle: octets.slice(0, 32), jumelage: octets.slice(32) };
}
