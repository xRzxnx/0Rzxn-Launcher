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

const gb = (value) => `${String(value).replace('.', ',')} Go`;

/** « 4 à 6 Go », ou une seule valeur quand le PC limite la zone idéale. */
export function ramRange({ low, high }) {
  return low === high ? gb(low) : `${String(low).replace('.', ',')} à ${gb(high)}`;
}

/** Avis sur la mémoire choisie : level ok | warn | bad, titre court et explication. */
export function ramVerdict(ram, guide, freeGb) {
  if (ram > guide.cap) return { level: 'bad', title: 'Trop pour ce PC', text: 'Windows et ta carte graphique n’auraient plus assez de mémoire : tout le PC ralentirait.' };
  if (ram < guide.min) return { level: 'bad', title: 'Pas assez', text: 'Le jeu risque de saccader ou de planter en chargeant le monde.' };
  if (freeGb && ram > freeGb) return { level: 'warn', title: 'Peu de RAM libre', text: `Seulement ${gb(freeGb.toFixed(1))} libres maintenant : ferme des applications avant de jouer.` };
  if (ram < guide.low) return { level: 'warn', title: 'Un peu juste', text: 'Ça passe, mais attends-toi à des saccades dans les gros mondes.' };
  if (ram > guide.high) return { level: 'warn', title: 'Trop', text: 'Aucun FPS en plus, et des pauses plus longues quand Java fait le ménage.' };
  if (guide.limited) return { level: 'ok', title: 'Parfait', text: 'Le mieux pour ce PC : le reste de la mémoire garde Windows fluide.' };
  return { level: 'ok', title: 'Parfait', text: 'Bon équilibre : le jeu et ton PC restent à l’aise.' };
}

/** Fond du curseur : rouge, ambre, vert, ambre, rouge, aux seuils du conseil. */
export function ramZones({ min, low, high, cap }, sliderMin, sliderMax) {
  const at = (value) => `${(((value - sliderMin) / (sliderMax - sliderMin)) * 100).toFixed(1)}%`;
  const stops = [['#ff8f8f', min], ['#fcd34d', low], ['#3ddc84', high], ['#fcd34d', cap], ['#ff8f8f', sliderMax]];
  let from = '0%';
  const parts = stops.map(([color, end]) => {
    const part = `${color} ${from} ${at(end)}`;
    from = at(end);
    return part;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

const DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const DATE_LONG = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const formatDate = (iso) => (iso ? DATE.format(new Date(iso)) : '—');

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
