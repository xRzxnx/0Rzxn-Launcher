// @ts-check
'use strict';

const { t } = require('../i18n');
const { safeStorage } = require('electron');

/**
 * Le système protège-t-il vraiment les jetons ? Windows (DPAPI) et macOS (trousseau) oui. Linux seulement avec un
 * trousseau (GNOME Keyring, KWallet) : sans lui Electron utilise « basic_text », une clé connue de tous, et
 * `isEncryptionAvailable()` répond quand même oui. Sinon la session Microsoft reste en mémoire (AccountStore).
 * @param {{ platform?: string, storage?: { isEncryptionAvailable(): boolean, getSelectedStorageBackend?(): string } }} [ctx]
 */
function persistent({ platform = process.platform, storage = safeStorage } = {}) {
  if (!storage.isEncryptionAvailable()) return false;
  return platform !== 'linux' || storage.getSelectedStorageBackend?.() !== 'basic_text';
}

/** Chiffre les jetons Microsoft avec la protection du système (DPAPI de Windows, trousseau de macOS ou de Linux). */
const vault = {
  persistent: () => persistent(),
  encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('ipc.le_chiffrement_de_windows_est'));
    return `enc:${safeStorage.encryptString(text).toString('base64')}`;
  },
  decrypt(data) {
    if (!data?.startsWith('enc:')) throw new Error(t('ipc.session_illisible'));
    return safeStorage.decryptString(Buffer.from(data.slice(4), 'base64'));
  },
};

module.exports = { vault, persistent };
