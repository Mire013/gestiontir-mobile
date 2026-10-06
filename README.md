# Gestion Tir Mobile

Application web installable (PWA) qui sert à saisir au stand, sans connexion, les sessions ISSF
(impacts posés au doigt sur la cible, avec loupe) et les séances TSV, puis à les envoyer au logiciel
**Gestion Tir** sur le PC.

- Ce site ne contient que l'application : **aucune donnée** n'est envoyée ni stockée ici.
- Dans le téléphone, les données sont chiffrées (AES-256-GCM) avec une clé tirée du code personnel.
- Les échanges avec le PC sont des paquets chiffrés avec la clé du jumelage, transmis par un fichier
  (dossier partagé) ou par des QR codes.

## Installer

1. Ouvrir l'adresse du site sur le téléphone (Chrome sur Android, Safari sur iPhone).
2. « Ajouter à l'écran d'accueil ».
3. Dans Gestion Tir sur le PC, page « Téléphone » : afficher le QR code de jumelage et le scanner.

## Publier une nouvelle version

Changer le numéro de version dans `sw.js` (constante `VERSION`) et dans `index.html`
(`data-version`) : les téléphones proposent alors « Mettre à jour ».

## Bibliothèques embarquées

Voir [vendor/LICENCES.md](vendor/LICENCES.md).
