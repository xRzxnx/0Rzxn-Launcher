// @ts-check
'use strict';

// Assemble les objets partagés du processus principal : le seul endroit qui décide des dossiers et des magasins.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { AccountStore } = require('../core/accounts');
const { InstanceStore } = require('../core/instances');
const microsoft = require('../core/microsoft');
const { gameDirs } = require('../core/store');
const { clientId: MICROSOFT_CLIENT_ID } = require('../microsoft-config');
const { createSettingsStore } = require('./settings');
const { vault } = require('./vault');

function createServices() {
  const configDir = app.getPath('userData');
  const dirs = gameDirs(path.join(app.getPath('appData'), '.0rzxn'));
  for (const dir of [dirs.instances, dirs.cache]) fs.mkdirSync(dir, { recursive: true });
  return {
    dirs,
    accounts: new AccountStore(configDir, {
      vault,
      renew: MICROSOFT_CLIENT_ID ? (refreshToken) => microsoft.renew(MICROSOFT_CLIENT_ID, refreshToken) : null,
    }),
    instances: new InstanceStore(dirs),
    settings: createSettingsStore(path.join(configDir, 'settings.json')),
  };
}

module.exports = { createServices };
