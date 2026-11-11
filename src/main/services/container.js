// @ts-check
'use strict';

// Assemble les objets partagés du processus principal : le seul endroit qui décide des dossiers et des magasins.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AccountStore } = require('../core/accounts');
const { InstanceStore } = require('../core/instances');
const microsoft = require('../core/microsoft');
const net = require('../core/net');
const { gameDirs } = require('../core/store');
const { clientId: MICROSOFT_CLIENT_ID } = require('../microsoft-config');
const { openDatabase } = require('./db');
const hashCache = require('../core/hash-cache');
const { createSettingsStore } = require('./settings');
const { vault } = require('./vault');

function createServices() {
  const configDir = app.getPath('userData');
  const settings = createSettingsStore(path.join(configDir, 'settings.json'));
  net.configure({ version: app.getVersion(), ...settings.launcher().downloads });
  const dirs = gameDirs(path.join(app.getPath('appData'), '.0rzxn'));
  for (const dir of [dirs.instances, dirs.cache]) fs.mkdirSync(dir, { recursive: true });
  // Historique (tâches, parties), empreintes des jars : facultatif, le launcher marche sans.
  const db = openDatabase({ file: path.join(configDir, 'launcher.db') });
  hashCache.useStore(db);
  return {
    dirs,
    accounts: new AccountStore(configDir, {
      vault,
      renew: MICROSOFT_CLIENT_ID ? (refreshToken) => microsoft.renew(MICROSOFT_CLIENT_ID, refreshToken) : null,
    }),
    instances: new InstanceStore(dirs),
    settings,
    db,
  };
}

module.exports = { createServices };
