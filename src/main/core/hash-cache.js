// @ts-check
'use strict';

// Empreintes et métadonnées des jars gardées entre deux ouvertures du launcher (table file_hashes de launcher.db).
// Un fichier n'est relu que si sa taille ou sa date a changé. Sans base, rien n'est gardé (le cache en mémoire
// de chaque module reste). Chaque lecteur garde sa partie des métadonnées : `content` (onglet Mods), `check`
// (contrôle avant lancement), sans écraser celle de l'autre.

/** @typedef {{ fileHash: (file: string, size: number, mtimeMs: number) => { sha1: string, meta: any } | null, saveFileHash: (file: string, row: { size: number, mtimeMs: number, sha1: string, meta?: any }) => any }} HashStore */

/** @type {HashStore | null} */
let store = null;

/** Branche la base (services/container.js) ; null la retire (tests). @param {HashStore | null} next */
function useStore(next) {
  store = next;
}

/**
 * Partie `part` des métadonnées gardées pour ce fichier, si elle existe et que le fichier n'a pas changé.
 * @param {string} file @param {{ size: number, mtimeMs: number }} stat @param {string} part
 * @returns {{ sha1: string, value: any } | null}
 */
function recall(file, stat, part) {
  const hit = store?.fileHash(file, stat.size, stat.mtimeMs);
  if (!hit || hit.meta?.[part] === undefined) return null;
  return { sha1: hit.sha1, value: hit.meta[part] };
}

/**
 * Garde la partie `part` des métadonnées de ce fichier (avec son empreinte SHA-1).
 * @param {string} file @param {{ size: number, mtimeMs: number }} stat @param {string} sha1 @param {string} part @param {any} value
 */
function remember(file, stat, sha1, part, value) {
  if (!store) return;
  const hit = store.fileHash(file, stat.size, stat.mtimeMs);
  const meta = { ...(hit && hit.sha1 === sha1 ? hit.meta : {}), [part]: value };
  store.saveFileHash(file, { size: stat.size, mtimeMs: stat.mtimeMs, sha1, meta });
}

module.exports = { useStore, recall, remember };
