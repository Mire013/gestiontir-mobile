// Gestion Tir Mobile : saisie au stand des sessions ISSF et des séances TSV, synchronisée avec le PC.
// Les données restent chiffrées dans le téléphone (coffre ouvert par le code personnel) ; les échanges
// avec le PC sont des paquets chiffrés avec la clé de jumelage (fichier ou QR codes).
import { el, nouvelId, isoLocal, heureDe, dateLisible, nombre, lireNombre, versBase64, depuisBase64, guidDepuisOctets, toast, confirmer } from "./outils.js";
import { chiffrerPaquet, dechiffrerPaquet, decouperQr, AssembleurQr, lireJumelage, TYPE_LISTES, TYPE_SAISIES } from "./paquets.js";
import { coffreExiste, creerCoffre, ouvrirCoffre, enregistrer, changerCode, fermerCoffre, effacerCoffre } from "./coffre.js";
import { coter, scoreCarton, resultat, texteResultat, statistiques, cartonEnCours, matchComplet } from "./issf.js";
import { VueCible } from "./cible-vue.js";
import { ouvrirAnalysePhoto } from "./photo.js";
import { afficherQr, lireQr } from "./qr.js";

// ===================== État =====================

// État déchiffré (null tant que le coffre est fermé)
let etat = null;
// Zone d'affichage des écrans
const vue = document.getElementById("vue");
// Arrêt de la caméra ou du défilement des QR codes de l'écran courant
let arreterEcran = null;
// Dernière activité (verrouillage automatique)
let derniereActivite = Date.now();
// Moment où l'application est passée en arrière-plan
let cacheeDepuis = null;
// Minutes d'inactivité avant verrouillage
const VERROU_INACTIVITE = 15;
// Minutes en arrière-plan avant verrouillage
const VERROU_ARRIERE_PLAN = 5;
// Libellés
const TYPES_SESSION = ["Entraînement", "Compétition", "Réglage"];

/** Enregistre l'état dans le coffre (chiffré). */
const sauver = () => enregistrer(etat);

// ===================== Écrans : outils =====================

/** Affiche un écran (l'écran précédent arrête sa caméra ou ses QR codes). */
function afficher(...contenu) {
  // Arrêt de l'écran précédent
  arreterEcran?.(); arreterEcran = null;
  // Remplacement (les blocs absents, null ou false, sont ignorés)
  vue.replaceChildren(...contenu.flat().filter((x) => x !== null && x !== undefined && x !== false));
  // Haut de page
  window.scrollTo(0, 0);
}

/** Barre de titre avec un bouton retour. */
function barre(titre, retour = accueil, ...actions) {
  // Barre
  return el("header", { class: "barre-titre" },
    retour ? el("button", { class: "icone", "aria-label": "Retour", onclick: retour }, "←") : el("span", { class: "logo" }, "◎"),
    el("h1", {}, titre),
    ...actions);
}

/**
 * Champ avec son libellé. Seul un contrôle simple (zone de saisie, liste) est enveloppé dans un <label> :
 * un <label> qui contient plusieurs boutons renvoie tous les touchers vers le premier (niveaux, « Maintenant », +5…).
 */
function champ(libelle, controle, aide) {
  // Contrôle simple : le libellé peut l'envelopper (toucher le libellé place le curseur dans le champ)
  const simple = controle instanceof HTMLInputElement || controle instanceof HTMLSelectElement || controle instanceof HTMLTextAreaElement;
  // Bloc
  return el(simple ? "label" : "div", { class: "champ" }, el("span", {}, libelle), controle, aide ? el("small", {}, aide) : null);
}

/** Liste déroulante liée à une propriété d'un objet (valeur vide = null). */
function choix(objet, propriete, options, apresChangement, vide = "—") {
  // Contrôle
  return el("select", {
    onchange: (e) => { objet[propriete] = e.target.value === "" ? null : (typeof options[0]?.valeur === "number" ? Number(e.target.value) : e.target.value); sauver(); apresChangement?.(); }
  },
  vide === null ? null : el("option", { value: "" }, vide),
  options.map((o) => el("option", { value: String(o.valeur), selected: String(o.valeur) === String(objet[propriete] ?? "") }, o.texte)));
}

/** Zone de texte liée à une propriété (texte, ou nombre si "nombre"). */
function saisie(objet, propriete, attributs = {}, estNombre = false) {
  // Contrôle
  const c = el(attributs.multiligne ? "textarea" : "input", {
    ...attributs, multiligne: null,
    value: objet[propriete] === null || objet[propriete] === undefined ? "" : estNombre ? String(objet[propriete]).replace(".", ",") : objet[propriete],
    oninput: (e) => { objet[propriete] = estNombre ? lireNombre(e.target.value) : (e.target.value.trim() === "" ? null : e.target.value); sauver(); }
  });
  // Résultat
  return c;
}

/** Case à cocher liée à une propriété. */
const caseACocher = (objet, propriete, texte, apres) => el("label", { class: "case" },
  el("input", { type: "checkbox", checked: !!objet[propriete], onchange: (e) => { objet[propriete] = e.target.checked; sauver(); apres?.(); } }), el("span", {}, texte));

/** Niveau de 1 à 5 (cœurs, étoiles...) lié à une propriété ; toucher le niveau choisi l'efface. */
function niveaux(objet, propriete, symbole) {
  // Conteneur
  const c = el("div", { class: "niveaux" });
  // Dessin
  const dessiner = () => c.replaceChildren(...[1, 2, 3, 4, 5].map((n) =>
    el("button", { type: "button", class: (objet[propriete] ?? 0) >= n ? "actif" : "", onclick: () => { objet[propriete] = objet[propriete] === n ? null : n; sauver(); dessiner(); } }, symbole)));
  // Premier dessin
  dessiner();
  // Résultat
  return c;
}

// ===================== Listes du PC =====================

/** Listes reçues du PC (vides si rien reçu). */
const L = () => etat.listes ?? { tireurs: [], stands: [], cibles: [], disciplines: [], armes: [], munitions: [], recus: [] };

/** Élément d'une liste par son identifiant. */
const trouver = (liste, id) => liste.find((x) => x.id === id) ?? null;

/** Discipline d'une session, avec sa cible. */
function disciplineDe(s) {
  // Discipline
  const d = trouver(L().disciplines, s.discipline);
  // Avec la cible
  return d ? { ...d, objetCible: trouver(L().cibles, d.cible) } : null;
}

/** Munition d'une saisie. */
const munitionDe = (s) => trouver(L().munitions, s.munition);

/** Fiches douilles où ranger les douilles d'une munition du commerce : celles de son calibre, plus celle déjà choisie. */
function douillesPour(s) {
  // Calibre de la munition
  const calibre = munitionDe(s)?.calibre;
  // Filtre (listes d'un PC plus ancien : pas de douilles)
  return (L().douilles ?? []).filter((d) => !calibre || !d.calibre || d.calibre === calibre || d.id === s.douille);
}

/** Douille proposée d'office : la seule du calibre exact de la munition du commerce, sinon aucune. */
function douilleParDefaut(s) {
  // Munition
  const m = munitionDe(s);
  // Rechargée ou inconnue : sa recette connaît la douille
  if (!m || m.rechargee || !m.calibre) return null;
  // Douilles du même calibre
  const memes = (L().douilles ?? []).filter((d) => d.calibre === m.calibre);
  // Seule ou aucune
  return memes.length === 1 ? memes[0].id : null;
}

/** Armes proposées : celles du tireur (ou sans tireur), plus l'arme déjà choisie. */
const armesPour = (s) => L().armes.filter((a) => !s.tireur || !a.tireur || a.tireur === s.tireur || a.id === s.arme);

/** Munitions proposées : celles du calibre de l'arme, plus la munition déjà choisie. */
function munitionsPour(s) {
  // Calibre de l'arme
  const calibre = trouver(L().armes, s.arme)?.calibre;
  // Filtre
  return L().munitions.filter((m) => !calibre || !m.calibre || m.calibre === calibre || m.id === s.munition);
}

/** Options d'une liste déroulante. */
const options = (liste) => liste.map((x) => ({ valeur: x.id, texte: x.nom }));

// ===================== Démarrage et coffre =====================

/** Premier écran selon la situation du téléphone. */
async function demarrer() {
  // Coffre présent : déverrouillage, sinon bienvenue
  if (await coffreExiste()) ecranDeverrouiller(); else ecranBienvenue();
}

/** Bienvenue : le téléphone n'est pas encore jumelé. */
function ecranBienvenue() {
  afficher(
    barre("Gestion Tir Mobile", null),
    el("section", { class: "carte" },
      el("h2", {}, "Bienvenue"),
      el("p", {}, "Cette application sert à saisir au stand vos sessions ISSF et vos séances TSV, puis à les envoyer à Gestion Tir sur le PC."),
      el("p", {}, "Pour commencer, jumelez le téléphone avec le PC : dans Gestion Tir, ouvrez « Téléphone » et affichez le QR code de jumelage."),
      el("button", { class: "principal large", onclick: () => ecranJumelage(false) }, "Jumeler avec le PC")),
    el("p", { class: "note" }, "Aucune donnée n'est envoyée sur Internet : le site ne contient que l'application, vos saisies restent chiffrées dans le téléphone."));
}

/** Jumelage : lecture du QR code affiché par le PC (ou saisie du texte). */
function ecranJumelage(dejaOuvert) {
  // Vidéo de la caméra
  const video = el("video", { class: "camera", muted: true });
  // Texte collé à la main
  const zone = el("textarea", { rows: 3, placeholder: "GTJ:..." });
  // Jumelage lu
  const lu = async (texte) => {
    // Lecture
    let j;
    try { j = lireJumelage(texte.trim()); } catch { j = null; }
    // Pas un code de jumelage
    if (!j) { if (texte.startsWith("GT")) toast("Ce n'est pas le QR code de jumelage."); return; }
    // Vibration de confirmation
    navigator.vibrate?.(60);
    // Clé et identifiant
    const cle = versBase64(j.cle), jumelage = guidDepuisOctets(j.jumelage);
    // Coffre déjà ouvert (rejumelage) : nouvelle clé, saisies conservées, listes effacées
    if (dejaOuvert) {
      etat.cle = cle; etat.jumelage = jumelage; etat.listes = null; etat.listesRecues = null;
      await sauver();
      toast("Téléphone rejumelé. Recevez maintenant les listes du PC.");
      ecranSynchro();
    } else {
      // Premier jumelage : choix du code
      ecranCreerCode({ version: 1, cle, jumelage, appareil: "Téléphone", listes: null, listesRecues: null, issf: [], tsv: [] });
    }
  };
  afficher(
    barre("Jumelage", dejaOuvert ? ecranReglages : ecranBienvenue),
    el("section", { class: "carte" },
      el("p", {}, "Visez le QR code de jumelage affiché par Gestion Tir sur le PC."),
      video,
      el("details", {}, el("summary", {}, "La caméra ne marche pas ?"),
        el("p", {}, "Copiez le texte affiché sous le QR code sur le PC, puis collez-le ici."),
        zone, el("button", { onclick: () => lu(zone.value) }, "Valider le texte"))));
  // Caméra
  lireQr(video, lu).then((arret) => { arreterEcran = arret; }).catch(() => toast("Caméra indisponible : utilisez le texte du PC."));
}

/** Choix du code personnel qui protège les données du téléphone. */
function ecranCreerCode(etatInitial) {
  // Champs
  const code = el("input", { type: "password", autocomplete: "new-password", placeholder: "6 caractères au moins" });
  const confirmation = el("input", { type: "password", autocomplete: "new-password" });
  // Validation
  const valider = async () => {
    // Longueur
    if (code.value.length < 6) { toast("Le code doit faire au moins 6 caractères."); return; }
    // Confirmation
    if (code.value !== confirmation.value) { toast("Les deux codes ne sont pas identiques."); return; }
    // Création (quelques secondes : le calcul de la clé est volontairement lent)
    bouton.disabled = true; bouton.textContent = "Chiffrement…";
    await creerCoffre(code.value, etatInitial);
    // État ouvert
    etat = etatInitial;
    toast("Téléphone jumelé. Recevez maintenant les listes du PC.");
    ecranSynchro();
  };
  // Bouton
  const bouton = el("button", { class: "principal large", onclick: valider }, "Créer le code");
  afficher(
    barre("Code personnel", null),
    el("section", { class: "carte" },
      el("p", {}, "Choisissez le code qui ouvrira l'application. Il chiffre toutes les données gardées dans le téléphone."),
      champ("Code", code, "Un code long (lettres et chiffres) protège mieux qu'un code à 6 chiffres."),
      champ("Confirmation", confirmation),
      bouton,
      el("p", { class: "note" }, "Code oublié = données du téléphone perdues (celles déjà envoyées au PC ne craignent rien).")));
}

/** Déverrouillage par le code. */
function ecranDeverrouiller() {
  // Champ
  const code = el("input", { type: "password", autocomplete: "current-password", onkeydown: (e) => { if (e.key === "Enter") valider(); } });
  // Essai
  const valider = async () => {
    // Attente imposée après plusieurs erreurs
    const attente = Number(localStorage.getItem("gt-attente") || 0);
    if (Date.now() < attente) { toast(`Patientez ${Math.ceil((attente - Date.now()) / 1000)} s.`); return; }
    // Ouverture
    bouton.disabled = true; bouton.textContent = "Ouverture…";
    const e = await ouvrirCoffre(code.value);
    bouton.disabled = false; bouton.textContent = "Ouvrir";
    // Code faux
    if (!e) {
      // Nombre d'erreurs
      const erreurs = Number(localStorage.getItem("gt-erreurs") || 0) + 1;
      localStorage.setItem("gt-erreurs", String(erreurs));
      // Attente croissante à partir de 5 erreurs
      if (erreurs >= 5) localStorage.setItem("gt-attente", String(Date.now() + 30000 * (erreurs - 4)));
      code.value = ""; toast("Code incorrect."); return;
    }
    // Ouvert
    localStorage.removeItem("gt-erreurs"); localStorage.removeItem("gt-attente");
    etat = e; derniereActivite = Date.now();
    accueil();
  };
  // Bouton
  const bouton = el("button", { class: "principal large", onclick: valider }, "Ouvrir");
  afficher(
    barre("Gestion Tir Mobile", null),
    el("section", { class: "carte" }, champ("Code personnel", code), bouton,
      el("details", {}, el("summary", {}, "Code oublié ?"),
        el("p", {}, "Sans le code, les données du téléphone sont illisibles. Vous pouvez tout effacer puis rejumeler le téléphone avec le PC (les saisies déjà envoyées au PC sont conservées sur le PC)."),
        el("button", { class: "danger", onclick: async () => { if (await confirmer("Effacer toutes les données de ce téléphone ?", "Tout effacer")) { await effacerCoffre(); ecranBienvenue(); } } }, "Tout effacer"))));
  // Clavier
  setTimeout(() => code.focus(), 100);
}

/** Verrouille l'application (le code sera redemandé). */
async function verrouiller() {
  // Déjà fermé
  if (!etat) return;
  // Dernier enregistrement
  await sauver();
  // Oubli de la clé et des données en mémoire
  fermerCoffre(); etat = null;
  // Écran du code
  ecranDeverrouiller();
}

// ===================== Accueil =====================

/** Statut lisible d'une saisie. */
const statut = (s) => s._recue ? "reçue par le PC" : s._exportee ? "envoyée" : s._statut === "terminee" ? "à envoyer" : "en cours";

/** Accueil : nouvelles saisies et liste des saisies. */
function accueil() {
  // Toutes les saisies, la plus récente en haut
  const toutes = [...etat.issf.map((s) => ({ s, issf: true })), ...etat.tsv.map((s) => ({ s, issf: false }))].sort((a, b) => b.s.date.localeCompare(a.s.date));
  // Ligne d'une saisie
  const ligne = ({ s, issf }) => {
    // Discipline ou arme
    const d = issf ? disciplineDe(s) : null;
    // Résumé
    const r = issf && d ? resultat(s.impacts, d) : null;
    const resume = issf
      ? `${d?.nom ?? "Discipline ?"}${r !== null ? ` — ${texteResultat(r, d)}` : ""} — ${s.impacts.filter((i) => i.carton > 0).length} impact(s)`
      : `TSV — ${trouver(L().armes, s.arme)?.nom ?? "arme ?"} — ${s.tirs ?? 0} tir(s)`;
    // Ligne
    return el("button", { class: `ligne ${s._recue ? "recue" : ""}`, onclick: () => issf ? ecranSessionIssf(s.id) : ecranSeanceTsv(s.id) },
      el("span", { class: "date" }, dateLisible(s.date)),
      el("span", { class: "resume" }, resume),
      el("span", { class: `statut ${statut(s).replace(/ /g, "-")}` }, statut(s)));
  };
  // Nombre de saisies à envoyer
  const aEnvoyer = toutes.filter(({ s }) => s._statut === "terminee" && !s._recue && !s._exportee).length;
  afficher(
    barre("Gestion Tir Mobile", null,
      el("button", { class: "icone", "aria-label": "Réglages", onclick: ecranReglages }, "⚙"),
      el("button", { class: "icone", "aria-label": "Verrouiller", onclick: verrouiller }, "🔒")),
    etat.listes ? null : el("section", { class: "carte alerte" }, el("p", {}, "Recevez d'abord les listes du PC (tireurs, armes, munitions, disciplines)."),
      el("button", { class: "principal", onclick: ecranSynchro }, "Synchroniser")),
    el("div", { class: "actions" },
      el("button", { class: "principal large", disabled: !etat.listes, onclick: nouvelleSessionIssf }, "Nouvelle session ISSF"),
      el("button", { class: "principal large", disabled: !etat.listes, onclick: nouvelleSeanceTsv }, "Nouvelle séance TSV"),
      el("button", { class: "large", onclick: ecranSynchro }, aEnvoyer ? `Synchroniser (${aEnvoyer} à envoyer)` : "Synchroniser")),
    el("section", {}, el("h2", { class: "titre-liste" }, "Saisies"),
      toutes.length ? toutes.map(ligne) : el("p", { class: "note" }, "Aucune saisie pour l'instant.")));
}

// ===================== Session ISSF =====================

/** Crée une session ISSF pré-remplie (dernière session du téléphone, sinon choix du PC). */
function nouvelleSessionIssf() {
  // Dernière session du téléphone
  const derniere = [...etat.issf].sort((a, b) => b.date.localeCompare(a.date))[0];
  // Choix proposés par le PC
  const defauts = L().defauts ?? {};
  // Prochain numéro de carton : après la dernière session du téléphone, ou celui du PC
  const apresDerniere = derniere?.cartonDebut ? derniere.cartonDebut + Math.max(1, ...derniere.impacts.filter((i) => i.carton > 0).map((i) => i.carton)) : null;
  // Session
  const s = {
    id: nouvelId(), date: isoLocal(), type: 0,
    tireur: derniere?.tireur ?? defauts.tireur ?? (L().tireurs.length === 1 ? L().tireurs[0].id : null),
    stand: derniere?.stand ?? defauts.stand ?? (L().stands.length === 1 ? L().stands[0].id : null),
    discipline: derniere?.discipline ?? defauts.discipline ?? null,
    arme: derniere?.arme ?? defauts.arme ?? null,
    munition: derniere?.munition ?? defauts.munition ?? null,
    lot: null, recuperees: null, poste: derniere?.poste ?? defauts.poste ?? null, notePoste: null, noteMatch: null, note: null,
    echauffement: false, electronique: false, cartonDebut: Math.max(apresDerniere ?? 0, L().cartonSuivant ?? 0) || null,
    heureDebut: null, heureFin: null, physiqueAvant: null, physiqueApres: null, psychoAvant: null, psychoApres: null,
    interieur: derniere?.interieur ?? false, temperature: null, lumiereCible: null, lumiereAmbiante: null, ventilation: null, vent: null, ventDirection: null, humidite: null,
    impacts: [], _statut: "encours", _exportee: null, _recue: false
  };
  // Lot proposé s'il n'y en a qu'un
  const m = munitionDe(s);
  if (m?.lots?.length === 1) s.lot = m.lots[0].id;
  // Ajout
  etat.issf.push(s); sauver();
  // Écran : les infos d'abord
  ecranSessionIssf(s.id, s.discipline ? "cible" : "infos");
}

/** Écran d'une session ISSF : onglets Cible, Infos, Conditions. */
function ecranSessionIssf(id, onglet = "cible") {
  // Session
  const s = etat.issf.find((x) => x.id === id);
  if (!s) { accueil(); return; }
  // Modifiable tant qu'elle n'est pas terminée
  const modifiable = s._statut !== "terminee";
  // Carton en cours et carton affiché (-1 = tous, 0 = essais)
  let modeEssais = false;
  let courant = 1, affiche = 1;
  // Contenu de l'onglet
  const contenu = el("div", { class: "onglet" });
  // Onglets
  const boutons = ["cible", "infos", "conditions"].map((o) => el("button", { class: o === onglet ? "actif" : "", onclick: () => { onglet = o; dessinerOnglets(); } }, { cible: "Cible", infos: "Infos", conditions: "Conditions" }[o]));
  const dessinerOnglets = () => {
    // Bouton actif
    boutons.forEach((b, k) => b.classList.toggle("actif", ["cible", "infos", "conditions"][k] === onglet));
    // Contenu
    contenu.replaceChildren(onglet === "cible" ? ongletCible() : onglet === "infos" ? ongletInfos() : ongletConditions());
  };

  // ---------- Onglet Cible ----------
  const ongletCible = () => {
    // Discipline
    const d = disciplineDe(s);
    if (!d?.objetCible) return el("p", { class: "note" }, "Choisissez d'abord la discipline dans l'onglet Infos.");
    // Diamètre des trous
    const trou = munitionDe(s)?.trou ?? 5.6;
    // Carton en cours
    courant = cartonEnCours(s.impacts, d);
    affiche = modeEssais ? 0 : courant;
    // Textes
    const score = el("div", { class: "score" }), titreCarton = el("span", { class: "titre-carton" }), stats = el("div", { class: "stats" });
    // Canevas
    const canvas = el("canvas", { class: "cible" });
    // Vue de la cible
    const vueCible = new VueCible(canvas, {
      // Points sous le doigt
      apercu: (visuel, x, y) => {
        const { valeur, mouche } = coter(d.objetCible, d, x, y, trou);
        const carton = modeEssais ? 0 : courant;
        const numero = s.impacts.filter((i) => i.carton === carton).length + 1;
        return `${carton === 0 ? "Essai" : `Carton ${carton}`} — impact ${numero} : ${nombre(valeur, d.dixieme ? 1 : 0)}${mouche ? " (mouche)" : ""}`;
      },
      // Impact posé
      impact: (visuel, x, y) => ajouter(visuel, x, y)
    });
    // Pose d'un impact dans la session (mêmes règles que sur le PC) ; renvoie null si c'est impossible
    const poser = (visuel, x, y, silencieux = false) => {
      // Saisie possible
      if (!modifiable) return null;
      // Carton qui reçoit l'impact
      const carton = modeEssais ? 0 : courant;
      // Match complet
      if (carton > 0 && s.impacts.filter((i) => i.carton === carton).length >= d.impactsParCarton) return null;
      // Points
      const { valeur, mouche } = coter(d.objetCible, d, x, y, trou);
      // Impact
      const impact = { carton, numero: s.impacts.filter((i) => i.carton === carton).length + 1, visuel, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, valeur, mouche };
      s.impacts.push(impact);
      // Heure de début au premier impact du match
      if (carton > 0 && !s.heureDebut) s.heureDebut = heureDe();
      // Carton plein : le suivant prend le relais
      if (carton > 0 && impact.numero >= d.impactsParCarton && courant < d.cartons) { courant++; if (!silencieux) toast(`Carton ${carton} terminé : carton ${courant}.`); }
      // Carton affiché
      affiche = carton === 0 ? 0 : courant;
      return impact;
    };
    // Ajout d'un impact touché sur la cible
    const ajouter = (visuel, x, y) => {
      // Pose
      const impact = poser(visuel, x, y);
      // Impossible : match complet
      if (!impact) { if (modifiable) toast("Session complète : terminez-la, ou passez en essais."); return; }
      // Vibration courte
      navigator.vibrate?.(15);
      // Enregistrement et affichage
      sauver(); rafraichir(impact);
    };
    // Ajout des impacts repérés sur une photo (dans le carton en cours, ou en essais)
    const ajouterLot = (liste) => {
      // Pose un par un, jusqu'à ce que le match soit complet
      let n = 0;
      for (const p of liste) { if (!poser(p.visuel, p.x, p.y, true)) break; n++; }
      // Enregistrement et affichage
      sauver(); rafraichir();
      // Bilan
      toast(n === liste.length ? `${n} impact(s) ajouté(s).` : `${n} impact(s) ajouté(s) sur ${liste.length} : session complète.`, 4000);
    };
    // Mise à jour de l'affichage
    const rafraichir = (dernier = null) => {
      // Impacts affichés
      const impacts = s.impacts.filter((i) => affiche === -1 ? i.carton > 0 : i.carton === affiche);
      // Dessin
      vueCible.definir({ cible: d.objetCible, impacts, trou, saisie: modifiable && (modeEssais || !matchComplet(s.impacts, d)), dernier: dernier ?? impacts[impacts.length - 1] ?? null });
      // Score
      const match = s.impacts.filter((i) => i.carton > 0);
      const max = d.mode === 0 && d.maxSession ? ` / ${nombre(d.maxSession, d.dixieme ? 1 : 0)}` : "";
      const scoreAffiche = affiche > 0 ? `Carton : ${texteResultat(scoreCarton(impacts, d), { ...d, mode: 0 })} — ` : "";
      score.textContent = `${scoreAffiche}Session : ${texteResultat(resultat(s.impacts, d), d)}${max} — ${match.length}/${d.impactsParCarton * d.cartons} — ${match.filter((i) => i.mouche).length} mouche(s) — ${s.impacts.length - match.length} essai(s)`;
      // Carton
      titreCarton.textContent = affiche === -1 ? "Tous les cartons" : affiche === 0 ? "Essais" : `Carton ${affiche}/${d.cartons}${affiche === courant && !modeEssais && !matchComplet(s.impacts, d) ? " (en cours)" : ""}`;
      if (matchComplet(s.impacts, d) && modifiable) titreCarton.textContent += " — complet";
      // Statistiques du carton affiché
      const st = statistiques(impacts);
      stats.textContent = st.nombre < 2 ? "" : `Extrêmes ${nombre(st.extremes, 1)} mm — surface ${nombre(st.surface / 100, 2)} cm² — point moyen ${nombre(Math.abs(st.moyen.x), 1)} mm ${st.moyen.x < 0 ? "à gauche" : "à droite"}, ${nombre(Math.abs(st.moyen.y), 1)} mm ${st.moyen.y > 0 ? "en bas" : "en haut"}`;
      // Bouton du mode
      boutonMode.textContent = modeEssais ? "Mode : essais" : "Mode : match";
      boutonMode.classList.toggle("essais", modeEssais);
    };
    // Changement de carton affiché
    const changer = (sens) => { affiche = Math.min(Math.max(affiche + sens, -1), d.cartons); rafraichir(); };
    // Bouton du mode
    const boutonMode = el("button", { onclick: () => { modeEssais = !modeEssais; affiche = modeEssais ? 0 : courant; rafraichir(); } }, "");
    // Annuler le dernier impact (des essais en mode essais, sinon du match)
    const annuler = () => {
      const liste = s.impacts.filter((i) => modeEssais ? i.carton === 0 : i.carton > 0).sort((a, b) => a.carton - b.carton || a.numero - b.numero);
      const dernier = liste[liste.length - 1];
      if (!dernier) return;
      s.impacts.splice(s.impacts.indexOf(dernier), 1);
      if (dernier.carton > 0) courant = dernier.carton;
      affiche = dernier.carton; sauver(); rafraichir();
    };
    // Premier affichage, une fois l'onglet mis en page
    setTimeout(() => rafraichir(), 0);
    // Onglet
    return el("div", { class: "saisie-cible" },
      score,
      el("div", { class: "barre-carton" },
        el("button", { onclick: () => changer(-1) }, "◀"), titreCarton, el("button", { onclick: () => changer(1) }, "▶"),
        el("button", { onclick: () => { affiche = -1; rafraichir(); } }, "Tous")),
      canvas,
      modifiable ? el("div", { class: "barre-outils" },
        boutonMode,
        el("button", { onclick: annuler }, "Annuler le dernier"),
        el("button", { onclick: () => ouvrirAnalysePhoto({ cible: d.objetCible, trou, valider: ajouterLot }) }, "📷 Photo"),
        el("button", { onclick: () => vueCible.zoomerCentre(1 / 1.5) }, "−"),
        el("button", { onclick: () => vueCible.zoomerCentre(1.5) }, "+"),
        el("button", { onclick: () => vueCible.ajuster() }, "⤢")) : el("div", { class: "barre-outils" },
        el("button", { onclick: () => vueCible.zoomerCentre(1 / 1.5) }, "−"), el("button", { onclick: () => vueCible.zoomerCentre(1.5) }, "+"), el("button", { onclick: () => vueCible.ajuster() }, "⤢")),
      stats,
      modifiable ? el("p", { class: "aide" }, "Posez le doigt sur la cible : la loupe montre l'endroit exact et les points ; levez le doigt pour poser l'impact. Deux doigts : zoom.") : null);
  };

  // ---------- Onglet Infos ----------
  const ongletInfos = () => {
    // Redessine après un changement qui modifie d'autres listes
    const redessiner = () => dessinerOnglets();
    // Munition et ses lots
    const m = munitionDe(s);
    // Champs (lecture seule si terminée)
    const formulaire = el("fieldset", { disabled: !modifiable },
      champ("Date", el("input", { type: "datetime-local", value: s.date.slice(0, 16), onchange: (e) => { s.date = e.target.value + ":00"; sauver(); } })),
      champ("Type", choix(s, "type", TYPES_SESSION.map((t, k) => ({ valeur: k, texte: t })), null, null)),
      champ("Tireur", choix(s, "tireur", options(L().tireurs), redessiner)),
      champ("Stand", choix(s, "stand", options(L().stands))),
      champ("Discipline", choix(s, "discipline", options(L().disciplines), () => { recoter(); redessiner(); }),
        s.impacts.length ? "Changer de discipline recalcule les points des impacts." : null),
      champ("Arme", choix(s, "arme", options(armesPour(s)), redessiner)),
      champ("Munition", choix(s, "munition", options(munitionsPour(s)), () => { const mm = munitionDe(s); s.lot = mm?.lots?.length === 1 ? mm.lots[0].id : null; recoter(); redessiner(); })),
      m?.rechargee ? champ("Lot de douilles", choix(s, "lot", options(m.lots ?? []))) : null,
      m?.rechargee ? champ("Douilles récupérées", saisie(s, "recuperees", { inputmode: "numeric", placeholder: "Vide = toutes" }, true)) : null,
      el("div", { class: "deux" },
        champ("Poste", saisie(s, "poste")),
        champ("Premier carton n°", saisie(s, "cartonDebut", { inputmode: "numeric" }, true))),
      el("div", { class: "deux" },
        champ("Début", el("div", { class: "heure" }, saisie(s, "heureDebut", { placeholder: "hh:mm" }), el("button", { type: "button", onclick: () => { s.heureDebut = heureDe(); sauver(); redessiner(); } }, "Maintenant"))),
        champ("Fin", el("div", { class: "heure" }, saisie(s, "heureFin", { placeholder: "hh:mm" }), el("button", { type: "button", onclick: () => { s.heureFin = heureDe(); sauver(); redessiner(); } }, "Maintenant")))),
      caseACocher(s, "echauffement", "Échauffement physique fait"),
      caseACocher(s, "electronique", "Cible électronique"),
      champ("Note sur le poste", saisie(s, "notePoste")),
      champ("Note sur le match", saisie(s, "noteMatch", { multiligne: true, rows: 3 })));
    // Formulaire
    return formulaire;
  };

  // Points de tous les impacts recalculés (discipline ou munition changée)
  const recoter = () => {
    const d = disciplineDe(s);
    if (!d?.objetCible) return;
    const trou = munitionDe(s)?.trou ?? 5.6;
    for (const i of s.impacts) Object.assign(i, coter(d.objetCible, d, i.x, i.y, trou));
    sauver();
  };

  // ---------- Onglet Conditions ----------
  const ongletConditions = () => el("fieldset", { disabled: !modifiable },
    caseACocher(s, "interieur", "Stand intérieur"),
    el("div", { class: "deux" },
      champ("Température (°C)", saisie(s, "temperature", { inputmode: "decimal" }, true)),
      champ("Humidité (%)", saisie(s, "humidite", { inputmode: "numeric" }, true))),
    el("div", { class: "deux" },
      champ("Vent (m/s)", saisie(s, "vent", { inputmode: "decimal" }, true)),
      champ("Vent venant de", choix(s, "ventDirection", Array.from({ length: 12 }, (_, k) => ({ valeur: k + 1, texte: `${k + 1} h` }))))),
    champ("Lumière sur la cible", niveaux(s, "lumiereCible", "☀")),
    champ("Lumière ambiante", niveaux(s, "lumiereAmbiante", "☀")),
    champ("Ventilation", saisie(s, "ventilation")),
    champ("État physique avant", niveaux(s, "physiqueAvant", "♥")),
    champ("État physique après", niveaux(s, "physiqueApres", "♥")),
    champ("État psychologique avant", niveaux(s, "psychoAvant", "★")),
    champ("État psychologique après", niveaux(s, "psychoApres", "★")),
    champ("Remarques", saisie(s, "note", { multiligne: true, rows: 3 })));

  // Points recalculés à l'ouverture (les listes du PC ont pu changer la cible ou la munition)
  if (modifiable && s.discipline) recoter();

  // Bas de l'écran : terminer, rouvrir ou supprimer
  const pied = el("div", { class: "pied" },
    s._statut !== "terminee"
      ? el("button", { class: "principal", onclick: async () => {
          const d = disciplineDe(s);
          if (!d) { toast("Choisissez la discipline."); return; }
          if (d && !matchComplet(s.impacts, d) && !(await confirmer("Le match n'est pas complet. Terminer quand même ?", "Terminer"))) return;
          if (!s.heureFin) s.heureFin = heureDe();
          s._statut = "terminee"; await sauver(); toast("Session terminée : elle partira à la prochaine synchronisation."); accueil();
        } }, "Terminer la session")
      : !s._exportee ? el("button", { onclick: () => { s._statut = "encours"; sauver(); ecranSessionIssf(s.id, onglet); } }, "Rouvrir pour modifier") : el("p", { class: "note" }, s._recue ? "Reçue par le PC : modifiez-la dans Gestion Tir." : "Envoyée au PC : modifiez-la dans Gestion Tir."),
    !s._exportee || s._recue ? el("button", { class: "danger", onclick: async () => {
      if (!(await confirmer("Supprimer cette session du téléphone ?", "Supprimer"))) return;
      etat.issf.splice(etat.issf.indexOf(s), 1); await sauver(); accueil();
    } }, "Supprimer") : null);

  // Écran
  afficher(barre("Session ISSF", accueil, el("span", { class: `statut ${statut(s).replace(/ /g, "-")}` }, statut(s))),
    el("nav", { class: "onglets" }, boutons), contenu, pied);
  // Premier onglet
  dessinerOnglets();
}

// ===================== Séance TSV =====================

/** Crée une séance TSV pré-remplie. */
function nouvelleSeanceTsv() {
  // Dernière séance du téléphone
  const derniere = [...etat.tsv].sort((a, b) => b.date.localeCompare(a.date))[0];
  // Choix proposés par le PC
  const defauts = L().defauts ?? {};
  // Séance
  const s = {
    id: nouvelId(), date: isoLocal(),
    tireur: derniere?.tireur ?? defauts.tireur ?? (L().tireurs.length === 1 ? L().tireurs[0].id : null),
    stand: derniere?.stand ?? defauts.stand ?? (L().stands.length === 1 ? L().stands[0].id : null),
    arme: derniere?.arme ?? null, munition: derniere?.munition ?? null, lot: null,
    tirs: null, recuperees: null, douille: null, exercice: null, carnet: false, responsable: derniere?.responsable ?? null, note: null,
    _statut: "encours", _exportee: null, _recue: false
  };
  // Carnet tenu par le tireur
  s.carnet = !!trouver(L().tireurs, s.tireur)?.carnet;
  // Douille de rangement (munition du commerce) : celle de la dernière séance, sinon la seule du calibre
  s.douille = derniere?.munition === s.munition && derniere?.douille ? derniere.douille : douilleParDefaut(s);
  // Ajout
  etat.tsv.push(s); sauver();
  ecranSeanceTsv(s.id);
}

/** Écran d'une séance TSV. */
function ecranSeanceTsv(id) {
  // Séance
  const s = etat.tsv.find((x) => x.id === id);
  if (!s) { accueil(); return; }
  // Modifiable
  const modifiable = s._statut !== "terminee";
  // Redessin
  const redessiner = () => ecranSeanceTsv(id);
  // Munition
  const m = munitionDe(s);
  // Ajoute des tirs
  const plus = (n) => { s.tirs = Math.max(0, (s.tirs ?? 0) + n); sauver(); redessiner(); };
  afficher(barre("Séance TSV", accueil, el("span", { class: `statut ${statut(s).replace(/ /g, "-")}` }, statut(s))),
    el("fieldset", { class: "carte", disabled: !modifiable },
      champ("Date", el("input", { type: "date", value: s.date.slice(0, 10), onchange: (e) => { s.date = e.target.value + "T00:00:00"; sauver(); } })),
      champ("Tireur", choix(s, "tireur", options(L().tireurs), () => { s.carnet = !!trouver(L().tireurs, s.tireur)?.carnet; redessiner(); })),
      champ("Stand", choix(s, "stand", options(L().stands))),
      champ("Arme", choix(s, "arme", options(armesPour(s)), redessiner)),
      champ("Munition", choix(s, "munition", options(munitionsPour(s)), () => { const mm = munitionDe(s); s.lot = mm?.lots?.length === 1 ? mm.lots[0].id : null; s.douille = douilleParDefaut(s); redessiner(); })),
      m?.rechargee ? champ("Lot de douilles", choix(s, "lot", options(m.lots ?? []))) : null,
      champ("Munitions tirées", el("div", { class: "compteur" },
        saisie(s, "tirs", { inputmode: "numeric" }, true),
        el("button", { type: "button", onclick: () => plus(1) }, "+1"), el("button", { type: "button", onclick: () => plus(5) }, "+5"),
        el("button", { type: "button", onclick: () => plus(10) }, "+10"), el("button", { type: "button", onclick: () => plus(50) }, "+50"))),
      // Munition du commerce : fiche douille où ranger les douilles récupérées
      m && !m.rechargee ? champ("Ranger les douilles dans", choix(s, "douille", options(douillesPour(s)), redessiner, "Ne pas les garder"),
        (L().douilles ?? []).length ? null : "Renvoyez les listes depuis le PC pour choisir une douille.") : null,
      // Nombre de douilles récupérées (vide = toutes), qui rentrent dans le stock de douilles vides
      m?.rechargee || (m && s.douille) ? champ("Douilles récupérées", saisie(s, "recuperees", { inputmode: "numeric", placeholder: "Vide = toutes" }, true),
        "Elles rentrent dans le stock de douilles à la validation sur le PC.") : null,
      champ("Exercice", saisie(s, "exercice")),
      caseACocher(s, "carnet", "Inscrire au carnet de tir", redessiner),
      s.carnet ? champ("Responsable (contrôle)", saisie(s, "responsable")) : null,
      champ("Note", saisie(s, "note", { multiligne: true, rows: 3 }))),
    el("div", { class: "pied" },
      modifiable ? el("button", { class: "principal", onclick: async () => {
        if (!s.arme || !s.munition || !(s.tirs > 0)) { toast("Indiquez l'arme, la munition et le nombre de tirs."); return; }
        if (s.recuperees > s.tirs) { toast("Les douilles récupérées ne peuvent pas dépasser les munitions tirées."); return; }
        s._statut = "terminee"; await sauver(); toast("Séance terminée : elle partira à la prochaine synchronisation."); accueil();
      } }, "Terminer la séance")
        : !s._exportee ? el("button", { onclick: () => { s._statut = "encours"; sauver(); redessiner(); } }, "Rouvrir pour modifier") : el("p", { class: "note" }, "Envoyée au PC : modifiez-la dans Gestion Tir."),
      !s._exportee || s._recue ? el("button", { class: "danger", onclick: async () => {
        if (!(await confirmer("Supprimer cette séance du téléphone ?", "Supprimer"))) return;
        etat.tsv.splice(etat.tsv.indexOf(s), 1); await sauver(); accueil();
      } }, "Supprimer") : null));
}

// ===================== Synchronisation =====================

/** Applique des listes reçues du PC. */
async function recevoirListes(paquet) {
  // Déchiffrement
  const { type, objet } = await dechiffrerPaquet(depuisBase64(etat.cle), paquet);
  // Mauvais type
  if (type !== TYPE_LISTES) throw new Error("Ce paquet contient des saisies, pas les listes du PC.");
  // Autre PC
  if (objet.jumelage !== etat.jumelage) throw new Error("Ces listes viennent d'un autre jumelage : rejumelez le téléphone.");
  // Listes
  etat.listes = objet; etat.listesRecues = isoLocal();
  // Saisies que le PC a reçues
  const recus = new Set(objet.recus ?? []);
  let confirmees = 0;
  for (const s of [...etat.issf, ...etat.tsv]) if (recus.has(s.id) && !s._recue) { s._recue = true; confirmees++; }
  // Enregistrement
  await sauver();
  // Message
  toast(`Listes reçues : ${objet.armes.length} arme(s), ${objet.munitions.length} munition(s), ${objet.disciplines.length} discipline(s).${confirmees ? ` ${confirmees} saisie(s) confirmée(s) par le PC.` : ""}`, 4500);
}

/** Saisies à envoyer : terminées et pas encore confirmées par le PC. */
const saisiesAEnvoyer = () => ({
  issf: etat.issf.filter((s) => s._statut === "terminee" && !s._recue),
  tsv: etat.tsv.filter((s) => s._statut === "terminee" && !s._recue)
});

/** Paquet chiffré des saisies à envoyer (et marque ces saisies comme envoyées). */
async function paquetSaisies() {
  // Saisies
  const { issf, tsv } = saisiesAEnvoyer();
  // Retire les informations propres au téléphone (champs "_")
  const net = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("_")));
  // Contenu (impacts compactés : [carton, numéro, visuel, x, y])
  const objet = {
    version: 1, cree: isoLocal(), appareil: etat.appareil,
    issf: issf.map((s) => ({ ...net(s), impacts: s.impacts.map((i) => [i.carton, i.numero, i.visuel, i.x, i.y]) })),
    tsv: tsv.map(net)
  };
  // Paquet
  const paquet = await chiffrerPaquet(depuisBase64(etat.cle), TYPE_SAISIES, objet);
  // Marquées comme envoyées
  for (const s of [...issf, ...tsv]) s._exportee = s._exportee ?? isoLocal();
  await sauver();
  // Résultat
  return paquet;
}

/** Écran de synchronisation. */
function ecranSynchro() {
  // Nombres
  const { issf, tsv } = saisiesAEnvoyer();
  const recues = [...etat.issf, ...etat.tsv].filter((s) => s._recue).length;
  // Sélecteur de fichier caché
  const fichier = el("input", { type: "file", hidden: true, onchange: async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    try { await recevoirListes(new Uint8Array(await f.arrayBuffer())); ecranSynchro(); } catch (err) { toast(err.message, 5000); }
  } });
  afficher(barre("Synchronisation", accueil),
    el("section", { class: "carte" },
      el("h2", {}, "1. Recevoir les listes du PC"),
      el("p", {}, etat.listes ? `Reçues le ${dateLisible(etat.listesRecues)} : ${L().tireurs.length} tireur(s), ${L().armes.length} arme(s), ${L().munitions.length} munition(s), ${L().disciplines.length} discipline(s).` : "Pas encore reçues."),
      el("p", { class: "note" }, "Sur le PC : Gestion Tir, page « Téléphone », « Envoyer les listes »."),
      el("div", { class: "actions" },
        el("button", { onclick: () => fichier.click() }, "Ouvrir le fichier des listes"),
        el("button", { onclick: () => ecranLecture("Listes du PC", async (paquet) => { await recevoirListes(paquet); ecranSynchro(); }) }, "Scanner les QR codes du PC")),
      fichier),
    el("section", { class: "carte" },
      el("h2", {}, "2. Envoyer mes saisies au PC"),
      el("p", {}, `${issf.length} session(s) ISSF et ${tsv.length} séance(s) TSV terminée(s), pas encore confirmée(s) par le PC.`),
      el("div", { class: "actions" },
        el("button", { class: "principal", disabled: !(issf.length + tsv.length), onclick: envoyerFichier }, "Enregistrer / partager le fichier"),
        el("button", { disabled: !(issf.length + tsv.length), onclick: async () => ecranQr(decouperQr(await paquetSaisies())) }, "Afficher en QR codes")),
      el("p", { class: "note" }, "Fichier : déposez-le dans le dossier partagé avec le PC (OneDrive, Google Drive…). QR codes : le PC les lit à la webcam (page « Téléphone », « Lire les QR codes »)."),
      el("p", { class: "note" }, "Les saisies sont confirmées à la réception suivante des listes du PC.")),
    el("section", { class: "carte" },
      el("h2", {}, "3. Faire de la place"),
      el("p", {}, `${recues} saisie(s) reçue(s) par le PC.`),
      el("button", { disabled: !recues, onclick: async () => {
        if (!(await confirmer(`Effacer du téléphone les ${recues} saisie(s) déjà reçue(s) par le PC ?`, "Effacer"))) return;
        etat.issf = etat.issf.filter((s) => !s._recue); etat.tsv = etat.tsv.filter((s) => !s._recue); await sauver(); ecranSynchro();
      } }, "Effacer les saisies reçues")));
}

/** Enregistre ou partage le fichier des saisies. */
async function envoyerFichier() {
  try {
    // Paquet
    const paquet = await paquetSaisies();
    // Nom : GestionTir-saisies-AAAAMMJJ-HHMM.gtsync
    const nom = `GestionTir-saisies-${isoLocal().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}.gtsync`;
    const f = new File([paquet], nom, { type: "application/octet-stream" });
    // Partage (iPhone, Android) si possible, sinon téléchargement
    if (navigator.canShare?.({ files: [f] })) {
      try { await navigator.share({ files: [f], title: nom }); } catch (e) { if (e.name !== "AbortError") throw e; }
    } else {
      const a = el("a", { href: URL.createObjectURL(f), download: nom }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    toast("Fichier prêt : déposez-le dans le dossier partagé avec le PC.", 4000);
    ecranSynchro();
  } catch (e) { toast(e.message, 5000); }
}

/** Lecture d'une suite de QR codes à la caméra ; "recu" reçoit le paquet complet. */
function ecranLecture(titre, recu) {
  // Vidéo et progression
  const video = el("video", { class: "camera", muted: true });
  const progression = el("p", { class: "progression" }, "Visez le premier QR code affiché par le PC.");
  // Assembleur des morceaux
  const assembleur = new AssembleurQr();
  // Fini
  let fini = false;
  afficher(barre(titre, ecranSynchro), el("section", { class: "carte" }, video, progression));
  // Lecture
  lireQr(video, async (texte) => {
    if (fini) return;
    let paquet = null;
    try { paquet = assembleur.ajouter(texte); } catch { assembleur.id = null; }
    progression.textContent = assembleur.total ? `${assembleur.morceaux.size} code(s) lu(s) sur ${assembleur.total}…` : "Visez les QR codes du PC.";
    if (!paquet) return;
    fini = true; navigator.vibrate?.(80);
    try { await recu(paquet); } catch (e) { toast(e.message, 5000); ecranSynchro(); }
  }).then((arret) => { arreterEcran = arret; }).catch(() => { toast("Caméra indisponible : utilisez le fichier."); ecranSynchro(); });
}

/** Affiche les QR codes des saisies pour la webcam du PC. */
function ecranQr(textes) {
  // Canevas et légende
  const canvas = el("canvas", { class: "qr" });
  const legende = el("p", { class: "progression" });
  afficher(barre("QR codes pour le PC", ecranSynchro),
    el("section", { class: "carte centre" }, canvas, legende,
      el("p", { class: "note" }, "Sur le PC : page « Téléphone », « Lire les QR codes ». Montez la luminosité du téléphone."),
      el("button", { class: "principal", onclick: ecranSynchro }, "Terminé")));
  // Défilement
  arreterEcran = afficherQr(canvas, legende, textes);
}

// ===================== Réglages =====================

/** Réglages : nom de l'appareil, code, rejumelage, effacement. */
function ecranReglages() {
  // Champs du code
  const ancien = el("input", { type: "password", autocomplete: "current-password" });
  const nouveau = el("input", { type: "password", autocomplete: "new-password" });
  afficher(barre("Réglages", accueil),
    el("section", { class: "carte" },
      champ("Nom de ce téléphone (vu par le PC)", saisie(etat, "appareil"))),
    el("section", { class: "carte" },
      el("h2", {}, "Changer le code"),
      champ("Code actuel", ancien), champ("Nouveau code (6 caractères au moins)", nouveau),
      el("button", { onclick: async () => {
        if (nouveau.value.length < 6) { toast("Le code doit faire au moins 6 caractères."); return; }
        if (!(await ouvrirCoffre(ancien.value))) { toast("Code actuel incorrect."); return; }
        await changerCode(nouveau.value, etat); toast("Code changé."); accueil();
      } }, "Changer le code")),
    el("section", { class: "carte" },
      el("h2", {}, "Jumelage"),
      el("p", {}, `Jumelé avec le PC (référence ${etat.jumelage.slice(0, 8)}).`),
      el("button", { onclick: () => ecranJumelage(true) }, "Rejumeler (nouveau QR code du PC)")),
    el("section", { class: "carte" },
      el("h2", {}, "Effacer"),
      el("p", {}, "Supprime toutes les données de ce téléphone (les saisies non envoyées seront perdues)."),
      el("button", { class: "danger", onclick: async () => {
        if (!(await confirmer("Effacer toutes les données de ce téléphone ?", "Tout effacer"))) return;
        await effacerCoffre(); etat = null; ecranBienvenue();
      } }, "Tout effacer")),
    el("p", { class: "note" }, `Gestion Tir Mobile — version ${document.documentElement.dataset.version}`));
}

// ===================== Verrouillage automatique et installation =====================

// Activité : repousse le verrouillage
["pointerdown", "keydown"].forEach((t) => addEventListener(t, () => { derniereActivite = Date.now(); }, { passive: true }));
// Inactivité prolongée
setInterval(() => { if (etat && Date.now() - derniereActivite > VERROU_INACTIVITE * 60000) verrouiller(); }, 30000);
// Arrière-plan : enregistrement immédiat, verrouillage au retour si l'absence a duré
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { cacheeDepuis = Date.now(); if (etat) sauver(); }
  else if (etat && cacheeDepuis && Date.now() - cacheeDepuis > VERROU_ARRIERE_PLAN * 60000) verrouiller();
});

// Service worker : fonctionnement hors ligne et mises à jour (pas pendant les essais sur le PC, pour voir chaque modification)
if ("serviceWorker" in navigator && location.hostname !== "localhost") {
  navigator.serviceWorker.register("sw.js").then((r) => {
    // Nouvelle version installée : proposer de recharger
    r.addEventListener("updatefound", () => {
      const nouveau = r.installing;
      nouveau?.addEventListener("statechange", () => {
        if (nouveau.state === "installed" && navigator.serviceWorker.controller) {
          const b = el("button", { class: "principal", onclick: () => { nouveau.postMessage("activer"); } }, "Mettre à jour");
          document.getElementById("toasts").append(el("div", { class: "toast fixe" }, "Nouvelle version disponible. ", b));
        }
      });
    });
  });
  // Nouvelle version active : rechargement
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
}

// Démarrage
demarrer();
