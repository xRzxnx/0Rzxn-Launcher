'use strict';

// Aperçu de l'interface : lance le launcher depuis les sources avec des données de démonstration
// dans .apercu/, à côté du launcher installé. Ni ses données ni son verrou d'instance unique ne
// sont partagés. Les versions sont des fichiers vides pour afficher « Jouer » : le jeu ne se lance
// pas depuis l'aperçu. Réinitialiser : supprimer le dossier .apercu.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const root = path.join(__dirname, '..', '.apercu');
const configDir = path.join(root, 'config');
const instancesDir = path.join(root, '.0rzxn', 'instances');
const versionsDir = path.join(root, '.0rzxn', 'versions');

const HOUR = 3600 * 1000;
const DEMO = [
  { id: 'survie-1-21', name: 'Survie 1.21', icon: 'grass', version: '1.21.11', loader: 'fabric', loaderVersion: '0.17.2', group: 'Survie', playedAgo: 2, playtime: 5400, installed: true },
  { id: 'creatif', name: 'Créatif', icon: 'diamond', version: '26.3', loader: 'vanilla', loaderVersion: null, group: 'Survie', playedAgo: 30, playtime: 210, installed: true },
  { id: 'modpack-tech', name: 'Modpack Tech', icon: 'netherrack', version: '1.20.1', loader: 'forge', loaderVersion: '47.4.0', group: 'Modpacks', playedAgo: 120, playtime: 3500, installed: true },
  { id: 'pvp', name: 'PvP', icon: 'stone', version: '1.8.9', loader: 'vanilla', loaderVersion: null, group: null, playedAgo: null, playtime: 0, installed: false },
];

/** Fichiers vides reconnus comme une version installée. */
function fakeVersion(id) {
  const dir = path.join(versionsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id }));
  fs.writeFileSync(path.join(dir, `${id}.jar`), '');
}

/** Quelques parties sur les 14 derniers jours pour remplir le graphique de l'accueil. */
function demoStats(now, playtime) {
  if (!playtime) return { days: {}, sessions: 0, longest: 0 };
  const days = {};
  [18, 46, 0, 30, 72, 12, 0, 54, 36, 0, 64, 88, 22, 40].forEach((minutes, i) => {
    if (!minutes) return;
    const d = new Date(now - (13 - i) * 24 * HOUR);
    days[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = minutes;
  });
  return { days, sessions: 12, longest: 125 };
}

function seed() {
  if (fs.existsSync(configDir)) return;
  fs.mkdirSync(configDir, { recursive: true });
  const name = '0Rzxn_';
  const id = 'offline-demo';
  fs.writeFileSync(
    path.join(configDir, 'accounts.json'),
    JSON.stringify({ activeId: id, accounts: [{ id, type: 'offline', name, uuid: '00000000000030008000000000000000' }] }, null, 2),
  );
  const now = Date.now();
  DEMO.forEach(({ playedAgo, installed, ...instance }, index) => {
    const dir = path.join(instancesDir, instance.id);
    fs.mkdirSync(path.join(dir, 'minecraft'), { recursive: true });
    let loaderInstalled = null;
    if (installed) {
      fakeVersion(instance.version);
      if (instance.loaderVersion) {
        const versionId = `${instance.loader}-${instance.version}`;
        fakeVersion(versionId);
        loaderInstalled = { loader: instance.loader, loaderVersion: instance.loaderVersion, versionId };
      }
    }
    const data = {
      ...instance,
      loaderInstalled,
      accountId: null,
      seed: 120 + index * 170,
      createdAt: now - (index + 1) * 240 * HOUR,
      lastPlayedAt: playedAgo === null ? null : now - playedAgo * HOUR,
      stats: demoStats(now, instance.playtime),
    };
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(data, null, 2));
  });
}

seed();
app.setName(pkg.productName);
app.setVersion(pkg.version);
app.setPath('appData', root);
app.setPath('userData', configDir);
require('../src/main/main.js');
