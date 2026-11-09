// @ts-check
'use strict';

// Tout ce qui dépend du système d'exploitation passe par ici : Windows a son implémentation complète,
// les autres systèmes reçoivent des versions neutres (listes vides, « non disponible ») en attendant la phase 9.
// Ce qui est déjà multiplateforme reste dans core/ : chemins Java (java.js), règles Mojang (rules.js, args.js), Discord.

/** Implémentation pour un système donné (`process.platform`). Les tests l'appellent avec un autre nom. @param {string} name */
function platformFor(name) {
  return name === 'win32' ? require('./windows') : require('./autre');
}

module.exports = { ...platformFor(process.platform), platformFor };
