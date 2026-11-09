// @ts-check
'use strict';

// Outils communs aux canaux : contrôle de l'origine, journal des erreurs, entrées texte, ouverture de dossier.
const { t } = require('../i18n');
const { ipcMain, shell } = require('electron');
const fs = require('node:fs');
const { journal } = require('../core/journal');

/**
 * `handle(canal, fn)` : seule la fenêtre du launcher peut appeler un canal ; les erreurs renvoyées
 * à l'interface sont aussi notées dans le journal.
 * @param {() => any} getWindow
 */
function createHandle(getWindow) {
  /** @param {string} channel @param {unknown} error @returns {never} */
  const failed = (channel, error) => {
    journal.warn(`IPC ${channel} failed:`, error);
    throw error;
  };
  /** @param {string} channel @param {(...args: any[]) => any} fn */
  return (channel, fn) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== getWindow()?.webContents) throw new Error(t('ipc.origine_refusee'));
      let result;
      try {
        result = fn(...args);
      } catch (error) {
        failed(channel, error);
      }
      return result instanceof Promise ? result.catch((error) => failed(channel, error)) : result;
    });
}

/** Une entrée venue de l'interface, ramenée à du texte. @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value : '');

/** Ouvre un dossier dans l'Explorateur (créé au besoin). @param {string} dir */
const openDir = async (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const error = await shell.openPath(dir);
  if (error) throw new Error(error);
};

/** Raccourci bureau : « --launch=<instance> » lance directement l'instance. @param {string[]} argv */
function launchArgument(argv) {
  const arg = argv.find((a) => a.startsWith('--launch='));
  const id = arg?.slice('--launch='.length) ?? '';
  return /^[a-z0-9-]+$/.test(id) ? id : null;
}

module.exports = { createHandle, text, openDir, launchArgument };
