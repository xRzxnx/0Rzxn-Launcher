// @ts-check
'use strict';

const { t } = require('../i18n');

/**
 * Une seule tâche longue à la fois (installation ou mise à jour d'un modpack, sauvegarde…), avec sa progression
 * envoyée à l'interface sur « task:progress ». Les tâches qui acceptent un signal (sauvegarde, restauration) peuvent être annulées.
 * @param {() => any} getWindow
 */
function createTaskRunner(getWindow) {
  /** @type {string | null} */
  let task = null;
  /** @type {AbortController | null} */
  let taskAbort = null;

  /**
   * @template T
   * @param {string} label
   * @param {(onProgress: (p: { label?: string, done: number, total: number }) => void, signal?: AbortSignal) => Promise<T>} work
   * @param {{ cancellable?: boolean }} [options]
   * @returns {Promise<T>}
   */
  const run = async (label, work, { cancellable = false } = {}) => {
    if (task) throw new Error(t('ipc.patiente_est_en_cours', { task }));
    task = label;
    taskAbort = cancellable ? new AbortController() : null;
    /** @param {object | null} payload */
    const send = (payload) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('task:progress', payload);
    };
    send({ label, done: 0, total: 0, cancellable });
    try {
      return await work((p) => send({ label: p.label ?? label, done: p.done, total: p.total, cancellable }), taskAbort?.signal);
    } finally {
      task = null;
      taskAbort = null;
      send(null);
    }
  };

  return {
    run,
    cancel: () => taskAbort?.abort(),
    /** Nom de la tâche en cours, ou null. */
    current: () => task,
  };
}

module.exports = { createTaskRunner };
