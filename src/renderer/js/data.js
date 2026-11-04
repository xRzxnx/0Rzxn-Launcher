// Libellés partagés par l'interface. Les données elles-mêmes viennent du processus principal (api.js).

export const VERSION_TYPES = {
  release: 'Release',
  snapshot: 'Snapshot',
  beta: 'Bêta',
  alpha: 'Alpha',
  custom: 'Personnalisée',
};

// Mêmes étapes, dans le même ordre, que src/main/core/launch.js
export const LAUNCH_STEPS = [
  { name: 'Compte', detail: 'Vérification du compte' },
  { name: 'Composants', detail: 'Fichier de version Mojang' },
  { name: 'Fichiers du jeu', detail: 'Bibliothèques et assets' },
  { name: 'Java', detail: 'Runtime Mojang adapté' },
  { name: 'Loader de mods', detail: 'Vanilla : rien à installer' },
  { name: 'Vérification de Java', detail: 'java -version' },
  { name: 'Mémoire disponible', detail: 'RAM libre' },
  { name: 'Natives', detail: 'Bibliothèques natives' },
  { name: 'Lancement', detail: 'Démarrage de Minecraft' },
];

export const FILES_STEP = 2;
export const JAVA_STEP = 3;
export const LOADER_STEP = 4;
export const MEMORY_STEP = 6;

export const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
export const LOADER_NAMES = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' };

/** « Fabric 0.20.1 », « Forge 66.1.0 »… (sans le numéro de Minecraft répété). */
export function loaderLabel(instance) {
  if (!instance.loader || instance.loader === 'vanilla') return 'Vanilla';
  const short = String(instance.loaderVersion ?? '')
    .replace(new RegExp(`^${instance.version.replace(/\./g, '\\.')}-`), '')
    .replace(new RegExp(`-${instance.version.replace(/\./g, '\\.')}$`), '');
  return `${LOADER_NAMES[instance.loader]} ${short}`;
}

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const DATE_LONG = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const formatDate = (iso) => (iso ? DATE.format(new Date(iso)) : '—');
export const formatDateLong = (iso) => (iso ? DATE_LONG.format(new Date(iso)) : '');
export const formatDateShort = (iso) => (iso ? DATE_SHORT.format(new Date(iso)) : '');

/** « aujourd'hui », « hier », « il y a 3 jours »… */
export function formatLastPlayed(timestamp) {
  if (!timestamp) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(timestamp))) / 86_400_000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  if (days < 30) return `il y a ${days} jours`;
  return `le ${DATE.format(new Date(timestamp))}`;
}
