// @ts-check
'use strict';

// Historique des optimisations d'une instance (phase 6) : chaque changement de performances (mémoire, préréglage Java,
// priorité, arguments Java, pack Performances, mods d'un profil) est noté avec une copie de instance.json et options.txt
// prise juste avant, dans instances/<id>/.optimisations/<copie>/. « Revenir avant ce changement » remet les réglages
// et options.txt de cette copie, annule aussi les changements plus récents et met à la corbeille les mods qu'ils ont ajoutés.
const fs = require('node:fs');
const path = require('node:path');
const { t } = require('../i18n');

/** Réglages de l'instance qui comptent comme une optimisation. */
const PERF_KEYS = ['ram', 'jvmPreset', 'priority', 'jvmArgs'];
const KEPT = 10;
// Changements rapprochés (curseur de mémoire, saisie des arguments) : regroupés en un seul.
const MERGE_WINDOW = 60 * 1000;
const SNAPSHOTS = '.optimisations';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/**
 * @param {object} options
 * @param {any} options.db launcher.db (services/db.js)
 * @param {any} options.instances InstanceStore
 * @param {(file: string) => Promise<any>} options.trash corbeille de Windows
 * @param {() => number} [options.now]
 */
function createOptimizations({ db, instances, trash, now = Date.now }) {
  const baseDir = (id) => path.join(instances.dir(id), SNAPSHOTS);

  /** Copie de instance.json et options.txt ; renvoie le nom du dossier de la copie. */
  function snapshot(instance) {
    const base = baseDir(instance.id);
    let name = stamp(new Date(now()));
    for (let n = 2; fs.existsSync(path.join(base, name)); n++) name = `${stamp(new Date(now()))}-${n}`;
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(instances.file(instance.id), path.join(dir, 'instance.json'));
    const options = path.join(instances.gameDir(instance.id), 'options.txt');
    if (fs.existsSync(options)) fs.copyFileSync(options, path.join(dir, 'options.txt'));
    return name;
  }

  function removeSnapshot(instanceId, name) {
    if (!/^[\w-]+$/.test(name)) return;
    fs.rmSync(path.join(baseDir(instanceId), name), { recursive: true, force: true });
  }

  /** Plus de 10 : les plus anciennes partent (copie comprise). */
  function prune(instanceId) {
    const old = db.optimizations(instanceId).slice(KEPT);
    for (const row of old) removeSnapshot(instanceId, row.snapshot);
    db.removeOptimizations(old.map((row) => row.id));
  }

  /**
   * Note une optimisation avant de l'appliquer. Renvoie son identifiant (null sans base : rien n'est noté).
   * @param {any} instance @param {string} kind @param {any} [summary]
   */
  function record(instance, kind, summary = null) {
    if (!db.available) return null;
    const id = db.addOptimization({ instanceId: instance.id, kind, summary, snapshot: snapshot(instance), createdAt: now() });
    prune(instance.id);
    return id;
  }

  /**
   * Réglages de l'instance sur le point de changer : note les changements de performances.
   * Plusieurs changements des mêmes réglages en moins d'une minute n'en font qu'un (la copie d'avant le premier reste).
   * @param {any} instance @param {any} next réglages après le changement (déjà nettoyés)
   */
  function settingsChanging(instance, next) {
    if (!db.available) return null;
    const changes = PERF_KEYS.filter((key) => next[key] !== undefined && next[key] !== instance.settings[key]).map((key) => ({ key, from: instance.settings[key], to: next[key] }));
    if (!changes.length) return null;
    const [last] = db.optimizations(instance.id);
    if (last?.kind === 'settings' && now() - last.createdAt < MERGE_WINDOW) {
      const merged = new Map((last.summary?.changes ?? []).map((c) => [c.key, c]));
      for (const change of changes) merged.set(change.key, { key: change.key, from: merged.get(change.key)?.from ?? change.from, to: change.to });
      // Revenu à la valeur de départ : ce réglage n'a plus changé.
      const kept = [...merged.values()].filter((c) => c.from !== c.to);
      if (!kept.length) {
        removeSnapshot(instance.id, last.snapshot);
        db.removeOptimizations([last.id]);
        return null;
      }
      db.setOptimizationSummary(last.id, { changes: kept });
      return last.id;
    }
    return record(instance, 'settings', { changes });
  }

  /** Fichiers ajoutés par une optimisation (chemins relatifs au dossier du jeu), connus une fois appliquée. */
  function added(id, files) {
    if (id == null) return;
    db.setOptimizationAdded(id, files.filter((file) => typeof file === 'string'));
  }

  function list(instanceId) {
    return db.optimizations(instanceId).map(({ id, kind, createdAt, summary, added: files }) => ({ id, kind, createdAt, summary, added: files }));
  }

  /**
   * Revient à l'état d'avant l'optimisation `id` : réglages (et loader) de l'instance, options.txt ; les changements
   * plus récents sont aussi annulés et les fichiers qu'ils ont ajoutés vont à la corbeille.
   * @param {string} instanceId @param {number} id
   */
  async function revert(instanceId, id) {
    const rows = db.optimizations(instanceId);
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) throw new Error(t('ipc.optimisation_introuvable'));
    const target = rows[index];
    const undone = rows.slice(0, index + 1);
    const dir = path.join(baseDir(instanceId), target.snapshot);
    let before;
    try {
      before = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
    } catch {
      throw new Error(t('ipc.copie_optimisation_illisible'));
    }
    const gameDir = instances.gameDir(instanceId);
    let trashed = 0;
    for (const row of undone) {
      for (const rel of row.added) {
        const file = path.resolve(gameDir, rel);
        if (!file.startsWith(gameDir + path.sep) || !fs.existsSync(file)) continue;
        await trash(file);
        trashed += 1;
      }
    }
    const instance = instances.update(instanceId, { settings: before.settings, loader: before.loader, loaderVersion: before.loaderVersion });
    const options = path.join(dir, 'options.txt');
    if (fs.existsSync(options)) fs.copyFileSync(options, path.join(gameDir, 'options.txt'));
    for (const row of undone) removeSnapshot(instanceId, row.snapshot);
    db.removeOptimizations(undone.map((row) => row.id));
    return { instance, undone: undone.length, trashed };
  }

  return { PERF_KEYS, record, settingsChanging, added, list, revert };
}

module.exports = { createOptimizations, PERF_KEYS };
