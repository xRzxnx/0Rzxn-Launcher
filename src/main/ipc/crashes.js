'use strict';

// Rapports de crash : liste, lecture expliquée, partage, ouverture.
const { shell } = require('electron');
const path = require('node:path');
const { createCrashService } = require('../services/crashes');
const { openDir } = require('./handle');

function register({ handle, dirs, instances }) {
  const crashService = createCrashService({ dirs, instances });
  const { crashDirs, crashPath } = crashService;
  handle('crashes:list', () => crashService.list());
  handle('crashes:read', (id, source, file) => crashService.read(id, source, file));
  handle('crashes:share', (id, source, file) => crashService.share(id, source, file));
  handle('crashes:open', async (id, source, file) => {
    const error = await shell.openPath(crashPath(id, source, file));
    if (error) throw new Error(error);
  });
  handle('crashes:openFolder', (id) => openDir(path.join(crashDirs(id).gameDir, 'crash-reports')));
}

module.exports = { register };
