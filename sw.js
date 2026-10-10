// Service worker : garde l'application dans le téléphone pour qu'elle marche sans réseau au stand.
// Aucune donnée personnelle ne passe par ici : seulement les fichiers de l'application.

// Version du cache (à changer à chaque publication pour que les téléphones se mettent à jour)
const VERSION = "gt-mobile-1.1.0";

// Fichiers de l'application
const FICHIERS = [
  "./", "index.html", "manifest.webmanifest", "css/app.css", "vendor/LICENCES.md",
  "js/app.js", "js/outils.js", "js/paquets.js", "js/coffre.js", "js/issf.js", "js/cible-vue.js", "js/photo.js", "js/qr.js",
  "vendor/jsQR.js", "vendor/qrcode.js",
  "icones/icone-180.png", "icones/icone-192.png", "icones/icone-512.png", "icones/icone-masquable-512.png"
];

// Installation : mise en cache de tous les fichiers
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FICHIERS)));
});

// Activation : suppression des anciennes versions
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((cles) => Promise.all(cles.filter((c) => c !== VERSION).map((c) => caches.delete(c)))).then(() => self.clients.claim()));
});

// L'application demande d'activer la nouvelle version (bouton « Mettre à jour »)
self.addEventListener("message", (e) => { if (e.data === "activer") self.skipWaiting(); });

// Requêtes : le cache d'abord (hors ligne), le réseau sinon
self.addEventListener("fetch", (e) => {
  // Seulement les lectures de ce site
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  // Réponse
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? fetch(e.request)));
});
