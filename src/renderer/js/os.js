// Système du PC, connu dès le chargement (argument passé par le processus principal) : 'windows', 'mac' ou 'linux'.
// Ajoute aussi la classe os-… sur <html> pour les quelques règles CSS qui en dépendent (barre de titre).
const platform = globalThis.window?.launcher?.platform ?? 'win32';

export const OS = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux';

if (globalThis.document) document.documentElement.classList.add(`os-${OS}`);
