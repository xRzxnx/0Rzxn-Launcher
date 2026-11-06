import { formatDateTime, num, t } from './i18n.js';
import { formatGo } from './dom.js';
// Libellés partagés par l'interface. Les données elles-mêmes viennent du processus principal (api.js).

export const VERSION_TYPES = {
  release: 'Release',
  snapshot: 'Snapshot',
  get beta() { return t('common.beta'); },
  alpha: 'Alpha',
  get custom() { return t('common.personnalisee'); },
};

// Mêmes étapes, dans le même ordre, que src/main/core/launch.js
export const LAUNCH_STEPS = [
  { get name() { return t('data.compte'); }, get detail() { return t('data.verification_du_compte'); } },
  { get name() { return t('data.composants'); }, get detail() { return t('data.fichier_de_version_mojang'); } },
  { get name() { return t('data.fichiers_du_jeu'); }, get detail() { return t('data.bibliotheques_et_assets'); } },
  { name: 'Java', get detail() { return t('data.runtime_mojang_adapte'); } },
  { get name() { return t('common.loader_de_mods'); }, get detail() { return t('data.vanilla_rien_installer'); } },
  { get name() { return t('data.verification_de_java'); }, detail: 'java -version' },
  { get name() { return t('data.memoire_disponible'); }, get detail() { return t('data.ram_libre'); } },
  { get name() { return t('data.natives'); }, get detail() { return t('data.bibliotheques_natives'); } },
  { get name() { return t('common.lancement'); }, get detail() { return t('data.demarrage_de_minecraft'); } },
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

/** « 4 à 6 Go » en français, ou une seule valeur quand le PC limite la zone idéale. */
export function ramRange({ low, high }) {
  return low === high ? formatGo(low) : t('ram.range', { low: num(low), high: formatGo(high) });
}

/** Avis sur la mémoire choisie : level ok | warn | bad, titre court et explication. */
export function ramVerdict(ram, guide, freeGb) {
  if (ram > guide.cap) return { level: 'bad', title: t('data.trop_pour_ce_pc'), text: t('data.windows_et_ta_carte_graphique') };
  if (ram < guide.min) return { level: 'bad', title: t('data.pas_assez'), text: t('data.le_jeu_risque_de_saccader') };
  if (freeGb && ram > freeGb) return { level: 'warn', title: t('data.peu_de_ram_libre'), text: t('data.seulement_libres_maintenant_ferme_des', { freeGb: formatGo(freeGb.toFixed(1)) }) };
  if (ram < guide.low) return { level: 'warn', title: t('data.un_peu_juste'), text: t('data.ca_passe_mais_attends_toi') };
  if (ram > guide.high) return { level: 'warn', title: t('data.trop'), text: t('data.aucun_fps_en_plus_et') };
  if (guide.limited) return { level: 'ok', title: t('data.parfait'), text: t('data.le_mieux_pour_ce_pc') };
  return { level: 'ok', title: t('data.parfait'), text: t('data.bon_equilibre_le_jeu_et') };
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

const DATE = { day: 'numeric', month: 'short', year: 'numeric' };

export const formatDate = (iso) => (iso ? formatDateTime(new Date(iso), DATE) : '—');

/** Suite de « Dernière partie » : aujourd'hui, hier, il y a 3 jours… */
export function formatLastPlayed(timestamp) {
  if (!timestamp) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(timestamp))) / 86_400_000);
  if (days <= 0) return t('played.today');
  if (days === 1) return t('played.yesterday');
  if (days < 30) return t('played.days_ago', { count: days });
  return t('played.on_date', { date: formatDateTime(new Date(timestamp), DATE) });
}
