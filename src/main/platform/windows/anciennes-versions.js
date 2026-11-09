'use strict';

// Retire les copies du launcher que le registre de Windows ne connaît pas :
//   - un dossier d'installation orphelin ;
//   - les exécutables portables et les installateurs plus anciens que cette version.
// Puis répare les raccourcis qui visaient une copie disparue.
//
// L'installateur dépose une marque (voir build/installer.nsh) et le launcher fait le travail à son
// démarrage suivant, en arrière-plan. Une mise à jour automatique ne dépose rien : elle ne déclenche pas d'analyse.
//
// Ne touche jamais aux données du joueur : elles sont dans AppData, que l'analyse ne parcourt pas.
// Un fichier n'est retenu que si son nom ET le nom de produit inscrit dans l'exécutable correspondent.
// Dans un dossier orphelin, seuls les éléments portant le nom d'un fichier de l'application sont retirés.
// Aucun processus n'est arrêté : le verrou d'instance unique garantit qu'aucune autre copie ne tourne.
const path = require('node:path');
// Le module fs d'Electron ouvre les .asar comme des dossiers : il faut voir ici les vrais fichiers.
const fs = process.versions.electron ? require('original-fs') : require('node:fs');
const fsp = fs.promises;

const MARQUE = 'anciennes-versions.a-nettoyer';
const JOURNAL = 'anciennes-versions.log';
const DUREE_ANALYSE = 20 * 1000;
const PROFONDEUR_RACCOURCIS = 2;
const RESSOURCES_MAX = 64 * 1024 * 1024;
const IGNORES = new Set(['appdata', 'programdata', 'windows', 'node_modules', '$recycle.bin', 'system volume information']);

const RT_VERSION = 16;
const SIGNATURE_VERSION = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
const CLE_PRODUIT = Buffer.from('ProductName\0', 'utf16le');

const memeChemin = (a, b) => a.toLowerCase() === b.toLowerCase();
const dans = (chemin, dossier) => memeChemin(chemin, dossier) || chemin.toLowerCase().startsWith(`${dossier.toLowerCase()}${path.sep}`);
const existe = (chemin) => fsp.lstat(chemin).then(() => true, () => false);

function plusAncienne(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/** Entrée d'un répertoire de ressources : celle de l'identifiant demandé, sinon la première. */
function entreeRessource(ressources, repertoire, id = null) {
  const nommees = ressources.readUInt16LE(repertoire + 12);
  const numerotees = ressources.readUInt16LE(repertoire + 14);
  for (let i = 0; i < nommees + numerotees; i++) {
    const entree = repertoire + 16 + i * 8;
    if (id === null || (i >= nommees && ressources.readUInt32LE(entree) === id)) return ressources.readUInt32LE(entree + 4);
  }
  return null;
}

/** Bloc VS_VERSIONINFO dans la section .rsrc, ou null s'il n'y en a pas. */
function blocVersion(ressources, adresseSection) {
  let position = entreeRessource(ressources, 0, RT_VERSION);
  for (let niveau = 0; niveau < 2 && position !== null; niveau++) {
    if (position < 0x80000000) return null;
    position = entreeRessource(ressources, position - 0x80000000);
  }
  if (position === null || position >= 0x80000000) return null;
  const debut = ressources.readUInt32LE(position) - adresseSection;
  return ressources.subarray(debut, debut + ressources.readUInt32LE(position + 4));
}

/**
 * Nom de produit et version inscrits dans un exécutable Windows.
 * @returns {Promise<{ produit: string, version: number[] } | null>} null si le fichier ne se lit pas comme attendu
 */
async function infosExe(fichier) {
  const descripteur = await fsp.open(fichier, 'r');
  try {
    const lire = async (position, taille) => {
      const tampon = Buffer.alloc(taille);
      const { bytesRead } = await descripteur.read(tampon, 0, taille, position);
      return tampon.subarray(0, bytesRead);
    };

    const dos = await lire(0, 64);
    if (dos.toString('latin1', 0, 2) !== 'MZ') return null;
    const pe = dos.readUInt32LE(0x3c);
    const entete = await lire(pe, 24 + 240);
    if (entete.toString('latin1', 0, 4) !== 'PE\0\0') return null;

    const tailleOptionnelle = entete.readUInt16LE(20);
    const repertoires = entete.readUInt16LE(24) === 0x20b ? 24 + 112 : 24 + 96;
    const adresseRessources = entete.readUInt32LE(repertoires + 2 * 8);
    const sections = await lire(pe + 24 + tailleOptionnelle, entete.readUInt16LE(6) * 40);

    for (let s = 0; s + 40 <= sections.length; s += 40) {
      const adresse = sections.readUInt32LE(s + 12);
      const taille = sections.readUInt32LE(s + 16);
      if (adresse !== adresseRessources) continue;
      if (taille > RESSOURCES_MAX) return null;

      const bloc = blocVersion(await lire(sections.readUInt32LE(s + 20), taille), adresse);
      if (!bloc) return null;
      const fixe = bloc.indexOf(SIGNATURE_VERSION);
      const cle = bloc.indexOf(CLE_PRODUIT);
      if (fixe < 0 || cle < 0) return null;

      // Les valeurs d'un bloc de version commencent sur une frontière de 4 octets.
      const debut = (cle + CLE_PRODUIT.length + 3) & ~3;
      let fin = debut;
      while (fin + 1 < bloc.length && bloc.readUInt16LE(fin) !== 0) fin += 2;
      const haut = bloc.readUInt32LE(fixe + 8);
      const bas = bloc.readUInt32LE(fixe + 12);
      return {
        produit: bloc.toString('utf16le', debut, fin),
        version: [haut >>> 16, haut & 0xffff, bas >>> 16],
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    await descripteur.close();
  }
}

class Nettoyage {
  constructor({ garder, produit, exe, version, duree = DUREE_ANALYSE }) {
    Object.assign(this, { garde: path.resolve(garder), produit, exe });
    this.nouvelle = version.replace(/[-+].*$/, '').split('.').map(Number);
    this.prefixe = `${produit.replaceAll(' ', '-')}-`.toLowerCase();
    this.limite = Date.now() + duree;
    this.vus = new Set();
    this.dossiers = [];
    this.fichiers = [];
    this.journal = [];
  }

  nomDuLauncher(nom) {
    const minuscules = nom.toLowerCase();
    return memeChemin(nom, this.exe) || (minuscules.startsWith(this.prefixe) && minuscules.endsWith('.exe'));
  }

  async examiner(dossier, nom) {
    if (!this.nomDuLauncher(nom)) return;
    const fichier = path.join(dossier, nom);
    const infos = await infosExe(fichier).catch(() => null);
    if (infos?.produit !== this.produit) return;

    if (memeChemin(nom, this.exe)) {
      // Sans ses ressources, ce n'est qu'un exécutable renommé ou incomplet : on n'y touche pas.
      if (await existe(path.join(dossier, 'resources', 'app.asar'))) this.dossiers.push(dossier);
    } else if (plusAncienne(infos.version, this.nouvelle)) {
      this.fichiers.push(fichier);
    }
  }

  /** Parcours en largeur : les dossiers proches de la racine passent d'abord si le temps manque. */
  async analyser(racines) {
    const attente = [...racines];
    for (let i = 0; i < attente.length && Date.now() < this.limite; i++) {
      const dossier = attente[i];
      const cle = dossier.toLowerCase();
      if (this.vus.has(cle) || dans(dossier, this.garde)) continue;
      this.vus.add(cle);

      let entrees;
      try {
        entrees = await fsp.readdir(dossier, { withFileTypes: true });
      } catch {
        continue;
      }
      // Un dépôt de code contient des versions de travail, pas des versions installées.
      if (entrees.some((entree) => entree.name === '.git')) continue;

      for (const entree of entrees) {
        // Les jonctions et les fichiers en ligne ne sont ni des dossiers ni des fichiers ici : ils sont ignorés.
        if (entree.isFile() && entree.name.toLowerCase().endsWith('.exe')) await this.examiner(dossier, entree.name);
        else if (entree.isDirectory() && !entree.name.startsWith('.') && !IGNORES.has(entree.name.toLowerCase())) {
          attente.push(path.join(dossier, entree.name));
        }
      }
    }
  }

  async retirerDossier(dossier, contenu) {
    for (const nom of contenu) {
      await fsp.rm(path.join(dossier, nom), { recursive: true, force: true }).catch(() => {});
    }
    await fsp.rmdir(dossier).catch(() => {}); // refusé s'il reste des fichiers du joueur : le dossier reste
    if (!(await existe(path.join(dossier, this.exe)))) this.journal.push(`Dossier retire : ${dossier}`);
  }

  async retirer() {
    if (this.dossiers.length > 0) {
      const contenu = await fsp.readdir(this.garde);
      // Le dossier de l'application doit être listé en entier, sinon on ne sait pas quoi retirer.
      if (contenu.some((nom) => memeChemin(nom, this.exe))) {
        for (const dossier of this.dossiers) await this.retirerDossier(dossier, contenu);
      }
    }
    for (const fichier of this.fichiers) {
      await fsp.rm(fichier, { force: true }).catch(() => {});
      if (!(await existe(fichier))) this.journal.push(`Fichier retire : ${fichier}`);
    }
  }

  async reparerDans(dossier, profondeur, shell) {
    const entrees = await fsp.readdir(dossier, { withFileTypes: true }).catch(() => []);
    for (const entree of entrees) {
      const chemin = path.join(dossier, entree.name);
      if (entree.isDirectory() && profondeur < PROFONDEUR_RACCOURCIS) {
        await this.reparerDans(chemin, profondeur + 1, shell);
      } else if (entree.isFile() && entree.name.toLowerCase().endsWith('.lnk')) {
        await this.reparerRaccourci(chemin, shell);
      }
    }
  }

  async reparerRaccourci(chemin, shell) {
    try {
      const { target } = shell.readShortcutLink(chemin);
      if (!target || !this.nomDuLauncher(path.basename(target)) || (await existe(target))) return;
      const nouvelExe = path.join(this.garde, this.exe);
      shell.writeShortcutLink(chemin, 'update', { target: nouvelExe, cwd: this.garde, icon: nouvelExe, iconIndex: 0 });
      this.journal.push(`Raccourci repare : ${chemin}`);
    } catch {
      // raccourci illisible ou protégé en écriture
    }
  }
}

/**
 * @param {object} options
 * @param {string} options.garder dossier de la copie en cours d'exécution
 * @param {string} options.produit nom de produit du launcher
 * @param {string} options.exe nom de l'exécutable
 * @param {string} options.version version en cours d'exécution
 * @param {string[]} options.racines dossiers à analyser
 * @param {string[]} options.raccourcis dossiers de raccourcis à réparer
 * @param {object} options.shell shell d'Electron
 * @param {number} [options.duree] durée maximale de l'analyse en millisecondes
 * @returns {Promise<string[]>} ce qui a été fait
 */
async function nettoyer({ racines, raccourcis, shell, ...options }) {
  const nettoyage = new Nettoyage(options);
  await nettoyage.analyser(racines);
  await nettoyage.retirer();
  for (const dossier of raccourcis) await nettoyage.reparerDans(dossier, 0, shell);
  return nettoyage.journal;
}

/** Racines par défaut : là où un joueur garde ses téléchargements, puis les disques du système et de l'installation. */
function racinesParDefaut(garder, env = process.env) {
  const disque = (chemin) => path.parse(chemin).root;
  return [
    path.join(env.LOCALAPPDATA, 'Programs'),
    env.USERPROFILE,
    disque(env.USERPROFILE),
    disque(garder),
  ];
}

function raccourcisParDefaut(bureau, env = process.env) {
  return [
    bureau,
    path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(env.APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  ];
}

/**
 * Lance le nettoyage si l'installateur l'a demandé pour cette copie. Aucune erreur ne remonte.
 * @param {object} options
 * @param {string} options.donnees dossier des données du launcher, où se trouve la marque
 * @param {string} options.executable chemin de l'exécutable en cours
 * @param {string} options.produit nom de produit du launcher
 * @param {string} options.version version en cours d'exécution
 * @param {string} options.bureau dossier du Bureau
 * @param {object} options.shell shell d'Electron
 * @param {number} [options.duree] durée maximale de l'analyse en millisecondes
 */
async function apresInstallation({ donnees, executable, bureau, ...options }) {
  const marque = path.join(donnees, MARQUE);
  let prevu;
  try {
    prevu = (await fsp.readFile(marque, 'utf16le')).replace(/^\uFEFF/, '').trim();
  } catch {
    return;
  }

  // Une ancienne copie lancée par erreur ne doit pas prendre la nouvelle pour un orphelin.
  const garder = path.dirname(executable);
  if (!memeChemin(path.resolve(prevu), garder)) return;

  try {
    const journal = await nettoyer({
      ...options,
      garder,
      exe: path.basename(executable),
      racines: racinesParDefaut(garder),
      raccourcis: raccourcisParDefaut(bureau),
    });
    if (journal.length > 0) await fsp.writeFile(path.join(donnees, JOURNAL), `${journal.join('\n')}\n`);
  } catch {
    // Rien de grave : les anciennes copies restent simplement en place.
  } finally {
    await fsp.rm(marque, { force: true }).catch(() => {});
  }
}

module.exports = { apresInstallation, nettoyer, infosExe };
