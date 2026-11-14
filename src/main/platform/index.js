// @ts-check
'use strict';

// Tout ce qui dépend du système d'exploitation passe par ici : Windows, Linux et macOS ont leur implémentation,
// les autres systèmes reçoivent des versions neutres (listes vides, « non disponible »). Les dossiers par système
// sont dans chemins.js. Ce qui est déjà multiplateforme reste dans core/ : runtimes Java (java.js), règles Mojang
// (rules.js, args.js), Discord.

/** @type {Record<string, string>} */
const IMPLEMENTATIONS = { win32: './windows', linux: './linux', darwin: './mac' };

/** Implémentation pour un système donné (`process.platform`). Les tests l'appellent avec un autre nom. @param {string} name */
function platformFor(name) {
  return require(IMPLEMENTATIONS[name] ?? './autre');
}

module.exports = { ...platformFor(process.platform), platformFor };
