// @ts-check
'use strict';

const { t } = require('../i18n');
const { safeStorage } = require('electron');

/** Chiffre les jetons Microsoft avec la protection de Windows (DPAPI), liée à ta session Windows. */
const vault = {
  encrypt(text) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('ipc.le_chiffrement_de_windows_est'));
    return `enc:${safeStorage.encryptString(text).toString('base64')}`;
  },
  decrypt(data) {
    if (!data?.startsWith('enc:')) throw new Error(t('ipc.session_illisible'));
    return safeStorage.decryptString(Buffer.from(data.slice(4), 'base64'));
  },
};

module.exports = { vault };
