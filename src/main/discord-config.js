'use strict';

// Application ID de l'application Discord du launcher : voir docs/DISCORD.md.
// Ce n'est pas un secret. Tant qu'il est vide, l'option Discord des paramètres l'explique.
const DISCORD_CLIENT_ID = '';

// LAUNCHER_DISCORD_CLIENT_ID permet de tester un autre identifiant sans modifier ce fichier,
// et LAUNCHER_DISCORD_PIPE de parler à un faux Discord (tests) au lieu de \\?\pipe\discord-ipc-N.
module.exports = {
  clientId: (process.env.LAUNCHER_DISCORD_CLIENT_ID ?? '').trim() || DISCORD_CLIENT_ID,
  pipe: (process.env.LAUNCHER_DISCORD_PIPE ?? '').trim() || null,
};
