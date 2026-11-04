'use strict';

// Application (client) ID de l'application Azure du launcher : voir docs/MICROSOFT.md.
// Ce n'est pas un secret. Tant qu'il est vide, le bouton « Se connecter avec Microsoft » l'explique.
const MICROSOFT_CLIENT_ID = '133282a2-2e6b-487f-8610-62f0aebd464f';

// La variable d'environnement LAUNCHER_MS_CLIENT_ID permet de tester un autre identifiant sans modifier ce fichier.
module.exports = {
  clientId: (process.env.LAUNCHER_MS_CLIENT_ID ?? '').trim() || MICROSOFT_CLIENT_ID,
};
