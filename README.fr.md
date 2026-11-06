# 0Rzxn_ Launcher

*English version: [README.md](README.md)*

Launcher Minecraft: Java Edition pour Windows (Electron).

## Lancer l'app

```bash
npm install
npm start
```

Au premier `npm start`, Electron télécharge son programme (environ 100 Mo).

## Construire l'installateur Windows

```bash
npm run dist
```

Résultat : `dist\0Rzxn_-Launcher-Setup-<version>.exe` (installation pour ton compte Windows, sans droits administrateur, avec raccourcis Bureau et menu Démarrer).
L'installateur n'est pas signé : Windows SmartScreen affiche « Windows a protégé votre ordinateur » → **Informations complémentaires** → **Exécuter quand même**.
La désinstallation garde tes mondes et tes réglages (`%APPDATA%\.0rzxn` et `%APPDATA%\0Rzxn_ Launcher`).

Les icônes sont générées depuis `src/renderer/assets/logo-mark.svg` par `npm run icon` (→ `build/icon.ico`, `build/icon.png` et `src/main/assets/tray*.png`).

## Fonctionnalités

- Toutes les versions vanilla (manifeste officiel Mojang), y compris la nouvelle numérotation 26.x.
- Téléchargements vérifiés (SHA-1, taille, 3 essais, 16 en parallèle) et partagés entre instances.
- Java automatique : runtimes officiels de Mojang (Java 8, 17, 21, 25…), ou Java personnalisé.
- Instances séparées, temps de jeu, réglages par instance et globaux.
- **Loaders de mods** : Fabric, Quilt, Forge (toutes époques) et NeoForge, installés automatiquement au premier lancement.
- **Onglet Mods** : recherche Modrinth (mods, packs de ressources, shaders) filtrée sur l'instance, installation avec dépendances, mises à jour, activer / désactiver, glisser-déposer de fichiers.
- **Modpacks** : installer depuis Modrinth ou importer un `.mrpack` (nouvelle instance), mettre à jour (réglages et mondes conservés), exporter une instance en `.mrpack`.
- Comptes **Microsoft** et **hors-ligne**. Un nouveau compte hors-ligne demande d'abord un compte Microsoft qui possède le jeu. La connexion Microsoft attend l'accord de Mojang : voir [docs/MICROSOFT.md](docs/MICROSOFT.md).
- Console en direct (logs XML de Minecraft convertis, jeton masqué), arrêt du jeu, détection des crashs.
- **Langues** : français, anglais et espagnol, selon la langue de Windows, et changement immédiat dans Paramètres › Launcher.
- **Confort** : couleur d'accent au choix, statut Discord pendant une partie (désactivé par défaut, voir [docs/DISCORD.md](docs/DISCORD.md)), icône dans la zone de notification, raccourcis clavier (Ctrl+/ pour l'aide), gestion des Java et nettoyage de l'espace disque (Paramètres › Java et stockage).

Testé en vrai : 1.8.9 (Java 8), 1.12.2 (Java 8), 1.21.11 (Java 21) et 26.3 (Java 25).

## Où sont les données

- `%APPDATA%\.0rzxn\` : versions, bibliothèques, assets, Java (`runtime\`) et instances (`instances\<id>\minecraft\` = dossier du jeu).
- `%APPDATA%\0Rzxn_ Launcher\` : comptes (`accounts.json`) et réglages globaux (`settings.json`).

## Organisation du code

```
src/
├─ main/
│  ├─ main.js        fenêtre Electron et sécurité
│  ├─ preload.js     API exposée à l'interface (rien d'autre)
│  ├─ ipc.js         canaux interface ↔ cœur, gestion de la partie en cours
│  ├─ i18n/          messages du processus principal (fr, en, es)
│  ├─ microsoft-config.js  client ID de l'application Azure
│  ├─ microsoft-login.js   fenêtre de connexion Microsoft
│  └─ core/          cœur en Node pur (testable sans Electron)
│     ├─ download.js   téléchargements vérifiés
│     ├─ versions.js   manifeste Mojang, fichiers de version
│     ├─ install.js    bibliothèques, natives, assets, config des logs
│     ├─ loaders.js    Fabric, Quilt, Forge, NeoForge (versions + installation)
│     ├─ modrinth.js   API Modrinth (recherche, versions, empreintes)
│     ├─ content.js    mods, packs et shaders d'une instance
│     ├─ modpacks.js   .mrpack : installation, mise à jour, export
│     ├─ java.js       runtimes Java de Mojang
│     ├─ args.js       ligne de commande (formats moderne et ancien)
│     ├─ launch.js     pipeline de lancement en 9 étapes
│     ├─ logs.js       lecture des logs du jeu, masquage des secrets
│     ├─ instances.js  instances sur le disque
│     ├─ accounts.js   comptes (jetons Microsoft chiffrés, renouvellement auto)
│     ├─ microsoft.js  chaîne Microsoft → Xbox → XSTS → Minecraft
│     ├─ rules.js      règles Mojang (système, processeur) et chemins Maven
│     ├─ zip.js        extraction des natives
│     └─ store.js      lecture/écriture JSON
└─ renderer/       interface
   ├─ index.html, styles/, assets/ (polices embarquées, licence SIL OFL)
   └─ js/
      ├─ main.js      rendu et navigation
      ├─ state.js     état de l'interface
      ├─ actions.js   appels au cœur
      ├─ api.js       accès à l'API du preload
      ├─ banner.js    bannière pixel art générée
      └─ views/       un fichier par écran
```
