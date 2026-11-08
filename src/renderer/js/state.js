import { t } from './i18n.js';
// État unique de l'interface. On le modifie uniquement via update(), qui redessine au prochain frame.
export const state = {
  ready: false,
  loadError: null,
  appVersion: null,
  microsoftReady: false, // client ID Azure configuré (src/main/microsoft-config.js)
  signingIn: false, // fenêtre de connexion Microsoft ouverte
  view: 'home', // home | mods | worlds | versions | console | settings
  instances: [],
  selectedId: null,
  accounts: [],
  activeAccountId: null,
  globalSettings: null,
  settingsScope: 'instance', // instance | global | launcher | storage
  launcherPrefs: null, // { accent, discord, discordShowName, tray, closeToTray }
  discordReady: false, // Application ID Discord configuré (src/main/discord-config.js)
  discord: null, // { configured, running, showing }
  launcherUpdate: null, // { supported, status, version, percent, transferred, total, checkedAt, error }
  storage: {
    loading: false,
    error: null,
    usage: null, // { total, parts: [{ id, label, size }] }
    plan: null, // [{ id, label, detail, size, count }]
    runtimes: null, // [{ component, major, version, size, usedBy }]
    system: null, // Java installés sur le PC : [{ path, major, name }]
    unchecked: [], // catégories de nettoyage décochées
    busy: false,
  },
  memory: { totalGb: 0, freeGb: 0 },
  versions: {
    list: [],
    loading: true,
    error: null,
    offline: false,
    filters: { release: true, snapshot: false, beta: false, alpha: false },
    query: '',
    selected: null,
  },
  versionDetails: {}, // id → { java, ... } | { loading } | { error }
  loaders: {}, // version de Minecraft → { fabric: { versions, recommended }, … } | { loading } | { error }
  console: { filter: 'all', autoscroll: true, tab: 'logs' }, // tab : logs | crashes
  sidebar: { query: '', collapsed: [] }, // recherche et groupes repliés de la barre des instances
  crashes: {
    list: null, // rapports de toutes les instances, du plus récent au plus ancien
    loading: false,
    seenAt: 0, // date du dernier passage sur l'onglet (pastille de la console)
    selected: null, // clé « instance:source:fichier »
    reports: {}, // clé → { loading } | { text, problems, suspects } | { error }
    shared: {}, // clé → { loading } | { url } | { error }
  },
  mods: {
    kind: 'mods', // mods | resourcepacks | shaders
    tab: 'installed', // installed | discover
    filter: '', // filtre de la liste installée
    query: '',
    sort: 'relevance',
    installed: {}, // « instance:type » → { loading, items, online, error }
    search: { key: null, loading: false, hits: [], total: 0, error: null },
    selected: null, // projet affiché à droite (Découvrir)
    projects: {}, // id → fiche Modrinth | { loading } | { error }
    versions: {}, // « projet:instance:type » → liste | { loading } | { error }
    busy: {}, // projet ou fichier en cours de traitement → true
  },
  resumeMenu: null, // instance dont le menu « Reprendre » est ouvert
  sidebarMenu: null, // menu du clic droit dans la barre latérale : { id, x, y }
  worlds: {
    lists: {}, // instance → { loading, worlds, backups, error }
    selected: {}, // instance → dossier du monde affiché à droite
    sort: 'last', // last | name | size
    filter: '',
    busy: {}, // « instance:dossier » → 'backup' | 'restore'
  },
  perf: {
    guides: {}, // « instance|préréglage » → conseil de mémoire | { loading } | { error }
    previews: {}, // « instance|préréglage|ram|arguments » → aperçu des arguments Java | { loading } | { error }
    last: {}, // instance → dernier aperçu (affiché pendant le calcul du suivant)
    metrics: null, // consommation du launcher { cpu, memoryMb, running }
    gpu: null, // { gpus, javas, high, enabled }
  },
  logs: [],
  run: null, // { instanceId, phase: 'preparing' | 'running', step, done, total, prepareOnly }
  task: null, // tâche longue en cours (modpack) : { label, done, total }
  modpackUpdates: {}, // instance → { checking } | { none } | { versionId, number }
  modal: null, // { type: 'new-instance' | 'accounts' | 'low-ram', ... }
  toasts: [],
};

const listeners = new Set();
let scheduled = false;

export function subscribe(listener) {
  listeners.add(listener);
}

export function update(mutate) {
  if (mutate) mutate(state);
  if (scheduled) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    listeners.forEach((listener) => listener());
  };
  // Fenêtre réduite pendant une partie : requestAnimationFrame est en pause, on passe par un minuteur.
  if (document.hidden) setTimeout(flush, 100);
  else requestAnimationFrame(flush);
}

/** Mods, shaders, version ou loader changés : le conseil de mémoire est à recalculer. */
export function forgetRamGuide(instanceId) {
  for (const key of Object.keys(state.perf.guides)) if (key.startsWith(`${instanceId}|`)) delete state.perf.guides[key];
}

export function selectedInstance() {
  return state.instances.find((instance) => instance.id === state.selectedId) ?? null;
}

export function activeAccount() {
  return state.accounts.find((account) => account.id === state.activeAccountId) ?? null;
}

/** Compte choisi pour cette instance, s'il existe encore ; null = le compte actif. */
export function instanceAccount(instance) {
  return state.accounts.find((account) => account.id === instance?.accountId) ?? null;
}

const STEP_COUNT = 9; // étapes du pipeline (data.js / core/launch.js)

/** Progression totale du lancement, de 0 à 100. */
export function runPercent(run) {
  const inStep = run.total ? run.done / run.total : 0;
  return Math.min(100, Math.round(((run.step + inStep) / STEP_COUNT) * 100));
}

export function instanceStatus(instance) {
  const run = state.run;
  if (run && run.instanceId === instance.id) {
    if (run.phase === 'running') return { kind: 'running', label: t('common.en_jeu') };
    if (run.prepareOnly) return { kind: 'busy', label: t('state.verification') };
    return { kind: 'busy', label: `${instance.installed ? t('common.lancement') : t('state.installation')} · ${runPercent(run)} %` };
  }
  return instance.installed ? { kind: 'ready', label: t('common.prete') } : { kind: 'idle', label: t('common.installer') };
}

let toastId = 0;

/** actions : [{ label, run }] */
export function toast({ kind = 'info', title, text, actions = [], timeout = 6000 }) {
  const id = ++toastId;
  update((s) => {
    s.toasts.push({ id, kind, title, text, actions });
    if (s.toasts.length > 4) s.toasts.shift();
  });
  if (timeout) setTimeout(() => dismissToast(id), timeout);
  return id;
}

export function dismissToast(id) {
  update((s) => {
    s.toasts = s.toasts.filter((t) => t.id !== id);
  });
}

export function toastError(title, error) {
  toast({ kind: 'error', title, text: error?.message ?? String(error), timeout: 9000 });
}
