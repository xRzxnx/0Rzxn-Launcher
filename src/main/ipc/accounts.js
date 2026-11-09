'use strict';

// Comptes Microsoft et hors ligne, skins et capes.
const { t } = require('../i18n');
const { dialog, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const microsoft = require('../core/microsoft');
const { SkinStore, Wardrobe } = require('../core/skins');
const { clientId: MICROSOFT_CLIENT_ID } = require('../microsoft-config');
const { promptMicrosoftLogin } = require('../microsoft-login');
const { text } = require('./handle');

function register({ handle, getWindow, dirs, accounts }) {
  const skins = new SkinStore(dirs);
  const wardrobe = new Wardrobe({ accounts, store: skins });

  handle('accounts:list', () => accounts.list());
  handle('accounts:addOffline', (name) => accounts.addOffline(text(name)));
  handle('accounts:addMicrosoft', async () => {
    if (!MICROSOFT_CLIENT_ID) {
      throw new Error(t('ipc.la_connexion_microsoft_est_pas'));
    }
    const { code, verifier } = await promptMicrosoftLogin(getWindow(), MICROSOFT_CLIENT_ID);
    const session = await microsoft.signIn(MICROSOFT_CLIENT_ID, code, verifier);
    return { ...accounts.addMicrosoft(session), name: session.name };
  });
  handle('accounts:remove', (id) => accounts.remove(text(id)));
  handle('accounts:setActive', (id) => accounts.setActive(text(id)));
  handle('accounts:refreshLooks', () => wardrobe.refresh());

  // ---------- Skins et capes ----------
  // Les images passent par skin://texture/<empreinte> et skin://library/<id> : seulement le cache et « Mes skins ».
  protocol.handle('skin', async (request) => {
    try {
      const url = new URL(request.url);
      const id = url.pathname.replace(/^\//, '');
      const file = url.hostname === 'library' ? skins.skinFile(id) : await skins.texture(id);
      return new Response(await fs.promises.readFile(file), { headers: { 'Content-Type': 'image/png' } });
    } catch {
      return new Response('', { status: 404 });
    }
  });
  handle('skins:state', (id) => wardrobe.state(text(id)));
  handle('skins:library', () => skins.list());
  handle('skins:import', async () => {
    const result = await dialog.showOpenDialog(getWindow(), { title: t('ipc.importer_un_skin'), filters: [{ name: t('ipc.skin_minecraft_png'), extensions: ['png'] }], properties: ['openFile'] });
    const file = result.filePaths?.[0];
    if (result.canceled || !file) return null;
    const stat = await fs.promises.stat(file);
    if (stat.size > 2 * 1024 * 1024) throw new Error(t('common.ce_fichier_est_trop_lourd'));
    const { item, added } = skins.add(await fs.promises.readFile(file), { name: path.basename(file), variant: 'classic' });
    return { id: item.id, added, library: skins.list() };
  });
  handle('skins:copyPlayer', async (name) => {
    const { item, added } = await wardrobe.copyPlayer(text(name));
    return { id: item.id, name: item.name, added, library: skins.list() };
  });
  handle('skins:setVariant', (id, variant) => {
    skins.setVariant(text(id), text(variant));
    return skins.list();
  });
  handle('skins:remove', (id) => {
    skins.remove(text(id));
    return skins.list();
  });
  // Un refus de Mojang revient dans l'état (avec son code) : ce qui a déjà été appliqué reste à jour à l'écran.
  const attempt = async (id, action) => {
    try {
      return await action();
    } catch (error) {
      return wardrobe.snapshot(id, error);
    }
  };
  handle('skins:apply', (id, change) => attempt(text(id), () => wardrobe.apply(text(id), change ?? {})));
  handle('skins:reset', (id) => attempt(text(id), () => wardrobe.reset(text(id))));
}

module.exports = { register };
