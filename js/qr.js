// QR codes : affichage (une suite de codes qui défilent) et lecture par la caméra.
// Bibliothèques embarquées (fonctionnent hors ligne) : qrcode-generator (MIT) et jsQR (Apache 2.0),
// chargées par index.html. Le lecteur intégré au navigateur (BarcodeDetector) est utilisé s'il existe.

/** Dessine un texte en QR code sur un canevas (mode alphanumérique, correction d'erreur L). */
function dessinerQr(canvas, texte) {
  // Code
  const qr = qrcode(0, "L");
  // Données (caractères de l'alphabet alphanumérique des QR codes)
  qr.addData(texte, "Alphanumeric");
  // Calcul
  qr.make();
  // Nombre de modules, plus 4 de marge blanche de chaque côté
  const n = qr.getModuleCount(), total = n + 8;
  // Taille d'un module (pixels entiers pour un code net)
  const taille = Math.max(2, Math.floor(Math.min(canvas.clientWidth || 320, 520) * (window.devicePixelRatio || 1) / total));
  // Taille du canevas
  canvas.width = canvas.height = taille * total;
  // Contexte
  const ctx = canvas.getContext("2d");
  // Fond blanc
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Modules noirs
  ctx.fillStyle = "#000";
  // Chaque module
  for (let l = 0; l < n; l++) for (let c = 0; c < n; c++) if (qr.isDark(l, c)) ctx.fillRect((c + 4) * taille, (l + 4) * taille, taille, taille);
}

/**
 * Affiche une suite de QR codes qui défilent (un seul s'il n'y en a qu'un).
 * Renvoie une fonction qui arrête le défilement.
 */
export function afficherQr(canvas, legende, textes, intervalle = 900) {
  // Code affiché
  let i = 0;
  // Affiche le code courant
  const afficher = () => {
    // Dessin
    dessinerQr(canvas, textes[i]);
    // Légende
    if (legende) legende.textContent = textes.length > 1 ? `Code ${i + 1} sur ${textes.length} (ils défilent : laissez la caméra du PC dessus)` : "";
    // Suivant
    i = (i + 1) % textes.length;
  };
  // Premier code
  afficher();
  // Défilement
  const minuteur = textes.length > 1 ? setInterval(afficher, intervalle) : null;
  // Arrêt
  return () => clearInterval(minuteur);
}

/**
 * Lit des QR codes avec la caméra arrière, dans un élément vidéo.
 * Chaque texte lu est passé à "lu" ; renvoie une fonction qui arrête la caméra.
 */
export async function lireQr(video, lu) {
  // Caméra arrière, assez définie pour des codes denses
  const flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  // Affichage
  video.srcObject = flux;
  video.setAttribute("playsinline", "");
  await video.play();
  // Lecteur intégré au navigateur (Android) s'il lit les QR codes
  let detecteur = null;
  try {
    // Formats pris en charge
    if ("BarcodeDetector" in window && (await BarcodeDetector.getSupportedFormats()).includes("qr_code")) detecteur = new BarcodeDetector({ formats: ["qr_code"] });
  } catch { detecteur = null; }
  // Canevas de travail pour jsQR
  const toile = document.createElement("canvas");
  const ctx = toile.getContext("2d", { willReadFrequently: true });
  // Lecture en cours
  let actif = true;
  // Dernier texte lu (évite de le signaler en boucle)
  let precedent = "";
  // Une lecture
  const lire = async () => {
    // Arrêté
    if (!actif) return;
    try {
      // Image disponible
      if (video.readyState >= 2) {
        // Textes trouvés dans l'image
        let textes = [];
        // Lecteur intégré
        if (detecteur) textes = (await detecteur.detect(video)).map((c) => c.rawValue);
        else {
          // Image réduite (lecture plus rapide)
          const f = Math.min(1, 900 / video.videoWidth);
          toile.width = Math.round(video.videoWidth * f); toile.height = Math.round(video.videoHeight * f);
          ctx.drawImage(video, 0, 0, toile.width, toile.height);
          // Lecture par jsQR
          const code = jsQR(ctx.getImageData(0, 0, toile.width, toile.height).data, toile.width, toile.height, { inversionAttempts: "dontInvert" });
          // Texte
          if (code) textes = [code.data];
        }
        // Textes nouveaux
        for (const t of textes) if (t && t !== precedent) { precedent = t; lu(t); }
      }
    } catch { /* image illisible : on continue */ }
    // Lecture suivante
    if (actif) setTimeout(lire, detecteur ? 100 : 150);
  };
  // Démarrage
  lire();
  // Arrêt de la caméra
  return () => { actif = false; flux.getTracks().forEach((p) => p.stop()); video.srcObject = null; };
}
