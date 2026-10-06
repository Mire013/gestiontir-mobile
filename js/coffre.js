// Coffre du téléphone : toutes les données (clé de jumelage, listes, saisies) sont gardées dans
// IndexedDB, chiffrées en AES-256-GCM avec une clé tirée du code personnel (PBKDF2-SHA256).
// Sans le code, le contenu stocké est illisible. Le coffre se referme après un temps d'inactivité.

// Base IndexedDB
const NOM_BASE = "gestiontir";
// Magasin
const MAGASIN = "coffre";
// Enregistrement unique
const CLE_ENREGISTREMENT = "principal";
// Nombre d'itérations PBKDF2 (ralentit les essais de codes)
const ITERATIONS = 600000;

// Clé AES dérivée du code (en mémoire seulement, tant que le coffre est ouvert)
let cleCoffre = null;
// Sel du coffre
let selCoffre = null;
// Écriture en cours (les enregistrements sont faits l'un après l'autre)
let fileEcriture = Promise.resolve();

/** Ouvre la base IndexedDB. */
function ouvrirBase() {
  // Promesse sur la requête d'ouverture
  return new Promise((resoudre, rejeter) => {
    // Ouverture (version 1)
    const requete = indexedDB.open(NOM_BASE, 1);
    // Création du magasin à la première ouverture
    requete.onupgradeneeded = () => requete.result.createObjectStore(MAGASIN);
    // Succès
    requete.onsuccess = () => resoudre(requete.result);
    // Erreur
    requete.onerror = () => rejeter(requete.error);
  });
}

/** Lit ou écrit l'enregistrement du coffre. */
async function acceder(mode, valeur) {
  // Base
  const base = await ouvrirBase();
  // Transaction
  return new Promise((resoudre, rejeter) => {
    // Magasin
    const magasin = base.transaction(MAGASIN, mode).objectStore(MAGASIN);
    // Lecture, écriture ou suppression
    const requete = mode === "readonly" ? magasin.get(CLE_ENREGISTREMENT) : valeur === undefined ? magasin.delete(CLE_ENREGISTREMENT) : magasin.put(valeur, CLE_ENREGISTREMENT);
    // Succès
    requete.onsuccess = () => { base.close(); resoudre(requete.result); };
    // Erreur
    requete.onerror = () => { base.close(); rejeter(requete.error); };
  });
}

/** Clé AES dérivée d'un code et d'un sel. */
async function deriver(code, sel) {
  // Matériau de clé : le code
  const materiau = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]);
  // Dérivation
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: sel, iterations: ITERATIONS, hash: "SHA-256" }, materiau, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Un coffre existe-t-il déjà sur ce téléphone ? */
export async function coffreExiste() {
  // Lecture
  return !!(await acceder("readonly"));
}

/** Crée le coffre avec un code et un état initial. */
export async function creerCoffre(code, etat) {
  // Sel aléatoire
  selCoffre = crypto.getRandomValues(new Uint8Array(16));
  // Clé
  cleCoffre = await deriver(code, selCoffre);
  // Premier enregistrement
  await enregistrer(etat);
}

/** Ouvre le coffre avec le code : renvoie l'état, ou null si le code est faux. */
export async function ouvrirCoffre(code) {
  // Enregistrement chiffré
  const e = await acceder("readonly");
  // Pas de coffre
  if (!e) return null;
  // Clé du code proposé
  const cle = await deriver(code, e.sel);
  try {
    // Déchiffrement (échoue si le code est faux)
    const clair = await crypto.subtle.decrypt({ name: "AES-GCM", iv: e.iv }, cle, e.donnees);
    // Coffre ouvert
    cleCoffre = cle;
    // Sel
    selCoffre = e.sel;
    // État
    return JSON.parse(new TextDecoder().decode(clair));
  } catch {
    // Code faux
    return null;
  }
}

/** Enregistre l'état (chiffré) ; les écritures sont faites dans l'ordre. */
export function enregistrer(etat) {
  // Coffre fermé : rien
  if (!cleCoffre) return Promise.resolve();
  // Clé et sel de cet instant
  const cle = cleCoffre, sel = selCoffre;
  // Mise en file
  fileEcriture = fileEcriture.then(async () => {
    // Nonce
    const iv = crypto.getRandomValues(new Uint8Array(12));
    // Chiffrement
    const donnees = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cle, new TextEncoder().encode(JSON.stringify(etat)));
    // Écriture
    await acceder("readwrite", { sel, iv, donnees });
  });
  // Promesse de fin
  return fileEcriture;
}

/** Change le code (re-chiffre l'état avec une nouvelle clé). */
export async function changerCode(nouveauCode, etat) {
  // Nouveau sel
  selCoffre = crypto.getRandomValues(new Uint8Array(16));
  // Nouvelle clé
  cleCoffre = await deriver(nouveauCode, selCoffre);
  // Enregistrement
  await enregistrer(etat);
}

/** Ferme le coffre (oublie la clé en mémoire). */
export function fermerCoffre() {
  // Oubli
  cleCoffre = null;
}

/** Efface toutes les données du téléphone. */
export async function effacerCoffre() {
  // Fermeture
  cleCoffre = null;
  // Suppression
  await acceder("readwrite", undefined);
}
