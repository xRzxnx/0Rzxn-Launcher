// Actions de l'interface : elles appellent le processus principal puis mettent l'état à jour.
import { t } from './i18n.js';
import { api } from './api.js';
import { OS } from './os.js';
import { loadCrashes, openCrashes } from './crash-actions.js';
import { listenToTasks } from './activity-actions.js';
import { loadLauncherPrefs } from './launcher-actions.js';
import { loadUpdate } from './update-actions.js';
import { autoTitleMenu } from './title-menu-actions.js';
import { forgetOptimizations } from './perf-actions.js';
import { forgetWorlds } from './worlds-actions.js';
import { askVersionChange } from './version-actions.js';
import { activeAccount, dismissToast, forgetRamGuide, selectedInstance, state, subscribe, toast, toastError, update } from './state.js';

export async function refreshInstances() {
  const instances = await api.instances();
  update((s) => {
    s.instances = instances;
    if (!instances.some((i) => i.id === s.selectedId)) s.selectedId = instances[0]?.id ?? null;
  });
}

export async function refreshAccounts(data) {
  const accounts = data ?? (await api.accounts());
  update((s) => {
    s.accounts = accounts.accounts;
    s.activeAccountId = accounts.activeId;
  });
}

export async function refreshMemory() {
  const memory = await api.memory();
  update((s) => {
    s.memory = memory;
  });
  return memory;
}

async function loadVersions() {
  try {
    const data = await api.versions();
    update((s) => {
      s.versions.list = data.versions;
      s.versions.offline = data.offline;
      s.versions.latest = data.latest;
      s.versions.selected ??= data.latest?.release ?? data.versions[0]?.id ?? null;
      s.versions.loading = false;
    });
  } catch (error) {
    update((s) => {
      s.versions.loading = false;
      s.versions.error = error.message;
    });
  }
}

export async function init() {
  let ui;
  let launchState;
  try {
    let info, settings;
    [info, settings, launchState, ui] = await Promise.all([api.info(), api.settings(), api.launchState(), api.ui(), refreshAccounts(), refreshInstances(), refreshMemory(), loadLauncherPrefs(), loadUpdate()]);
    update((s) => {
      s.appVersion = info.version;
      s.microsoftReady = info.microsoftReady;
      s.discordReady = info.discordReady;
      if (info.features) s.features = info.features;
      s.globalSettings = settings;
      s.run = launchState.run;
      s.logs = launchState.logs;
      s.gameMetrics = launchState.metrics ?? null;
      if (s.instances.some((i) => i.id === ui.selectedId)) s.selectedId = ui.selectedId;
      s.sidebar.collapsed = ui.collapsedGroups ?? [];
      // Premier démarrage avec les rapports de crash : les anciens rapports ne comptent pas comme nouveaux.
      s.crashes.seenAt = ui.crashesSeenAt ?? Date.now();
      // Fenêtre recréée pendant ou après une partie (réglage « Masquer ») : même écran qu'avant sa fermeture.
      if (REOPEN_VIEWS.has(ui.reopenView)) s.view = ui.reopenView;
      s.ready = true;
    });
    api.refreshLooks().then(refreshAccounts, () => {}); // têtes de skin : en arrière-plan, hors connexion la dernière reste
  } catch (error) {
    update((s) => {
      s.loadError = error.message;
    });
    return;
  }
  listenToLaunches();
  listenToTasks();
  // Fin de partie arrivée pendant que la fenêtre était fermée : montrée comme si elle venait d'arriver.
  if (launchState.ended) handleLaunchStatus({ run: state.run, ...launchState.ended });
  rememberSelection(ui.selectedId);
  rememberView();
  api.on.launchRequest(launchFromShortcut);
  if (ui.pendingLaunch) launchFromShortcut(ui.pendingLaunch);
  if (ui.crashesSeenAt == null) api.saveUi({ crashesSeenAt: state.crashes.seenAt }).catch(() => {});
  loadVersions();
  loadCrashes();
}

const REOPEN_VIEWS = new Set(['home', 'mods', 'worlds', 'versions', 'console', 'activity', 'settings']);

/** L'écran affiché est tenu à jour dans le moteur (en mémoire seulement), pour rouvrir la fenêtre au même endroit. */
function rememberView() {
  let last = null;
  subscribe(() => {
    if (state.view === last) return;
    last = state.view;
    api.saveUi({ view: last }).catch(() => {});
  });
}

/** L'instance choisie est retenue pour la prochaine ouverture du launcher. */
function rememberSelection(saved) {
  let last = saved;
  subscribe(() => {
    if (state.selectedId === last) return;
    last = state.selectedId;
    api.saveUi({ selectedId: last }).catch(() => {});
  });
}

/** Ouverture depuis un raccourci bureau (--launch=<instance>). */
function launchFromShortcut(instanceId) {
  if (!state.instances.some((i) => i.id === instanceId)) {
    toast({ kind: 'error', title: t('actions.raccourci_invalide'), text: t('actions.cette_instance_existe_plus') });
    return;
  }
  update((s) => {
    s.selectedId = instanceId;
    s.view = 'home';
  });
  if (!state.run) requestLaunch();
}

/** Détails d'une version (Java requis…), chargés une seule fois à la demande. */
export function versionDetails(id) {
  if (!id) return null;
  const known = state.versionDetails[id];
  if (known) return known.loading || known.error ? null : known;
  state.versionDetails[id] = { loading: true };
  api.versionDetails(id).then(
    (details) => update((s) => { s.versionDetails[id] = details; }),
    (error) => update((s) => { s.versionDetails[id] = { error: error.message }; }),
  );
  return null;
}

/** Loaders disponibles pour une version de Minecraft, chargés une fois à la demande. */
export function loaderOptions(mc) {
  if (!mc) return null;
  const known = state.loaders[mc];
  if (known) return known.loading ? null : known;
  state.loaders[mc] = { loading: true };
  api.loaders(mc).then(
    (data) => update((s) => { s.loaders[mc] = data; }),
    (error) => update((s) => { s.loaders[mc] = { error: error.message }; }),
  );
  return null;
}

// ---------- Instances ----------

export async function createInstance(draft) {
  const instance = await api.createInstance(draft);
  await refreshInstances();
  update((s) => {
    s.selectedId = instance.id;
    s.view = 'home';
    s.modal = null;
  });
  toast({
    kind: 'success',
    title: t('common.creee', { name: instance.name }),
    text: instance.installed ? t('actions.minecraft_est_deja_installe_tu') : t('actions.clique_sur_installer_pour_la', { version: instance.version }),
  });
}

/** Nom, icône ou version (fenêtre « Modifier l'instance »). */
/**
 * options : planned (l'aperçu du changement de version a déjà été vu), skipBackup (continuer sans sauvegarde
 * des mondes), after (suite à exécuter une fois la modification faite : mises à jour de mods, par exemple).
 */
export async function editInstance(id, patch, options = {}) {
  const { planned = false, skipBackup = false, after = null } = options;
  const current = state.instances.find((i) => i.id === id);
  if (!planned && current && typeof patch.version === 'string' && patch.version !== current.version) {
    await askVersionChange(current, patch);
    return;
  }
  const result = await api.updateInstance(id, patch, { skipBackup });
  if (result?.backupError) {
    askBackupFailed(result.backupError, { retry: () => editInstance(id, patch, { planned, after }), skip: () => editInstance(id, patch, { planned, after, skipBackup: true }) });
    return;
  }
  forgetWorlds(id);
  await refreshInstances();
  forgetRamGuide(id);
  update((s) => { s.modal = null; });
  toast({ kind: 'success', title: t('actions.instance_modifiee'), text: patch.name });
  await after?.();
}

export async function duplicateInstance(id) {
  const source = state.instances.find((i) => i.id === id);
  try {
    const copy = await api.duplicateInstance(id, t('actions.copy_name', { name: source.name }));
    await refreshInstances();
    update((s) => { s.selectedId = copy.id; s.view = 'home'; });
    toast({ kind: 'success', title: t('common.creee', { name: copy.name }), text: t('actions.copie_complete_mondes_options_et') });
  } catch (error) {
    toastError(t('common.copie_impossible'), error);
  }
}

export async function deleteInstance(id) {
  const instance = state.instances.find((i) => i.id === id);
  await api.deleteInstance(id);
  update((s) => { s.modal = null; });
  await refreshInstances();
  toast({ kind: 'success', title: t('actions.supprimee', { name: instance?.name ?? t('common.instance') }), text: t('actions.le_dossier_est_dans_la') });
}

export function createShortcut(id) {
  // Windows : fichier .lnk sur le bureau. Linux : entrée dans le menu des applications, au nom de l'instance.
  const name = state.instances.find((i) => i.id === id)?.name ?? id;
  api.createShortcut(id).then(
    (file) => toast({
      kind: 'success',
      title: t('actions.raccourci_cree'),
      text: OS === 'linux' ? t('actions.raccourci_menu_applications', { name }) : t('actions.est_sur_ton_bureau_il', { file: file.replace(/\.lnk$/, '') }),
    }),
    (error) => toastError(t('actions.raccourci_impossible'), error),
  );
}

const saveTimers = new Map();

/** Les réglages sont enregistrés automatiquement, 400 ms après la dernière modification. */
export function saveSettings(scope, instanceId) {
  if (scope !== 'global') forgetOptimizations(instanceId); // l'historique des optimisations a pu changer
  const key = scope === 'global' ? 'global' : instanceId;
  clearTimeout(saveTimers.get(key));
  saveTimers.set(
    key,
    setTimeout(async () => {
      try {
        if (scope === 'global') {
          const saved = await api.updateSettings(state.globalSettings);
          update((s) => { s.globalSettings = saved; });
        } else {
          const instance = state.instances.find((i) => i.id === instanceId);
          if (!instance) return;
          const saved = await api.updateInstance(instanceId, { settings: instance.settings });
          update((s) => {
            const index = s.instances.findIndex((i) => i.id === instanceId);
            if (index >= 0) s.instances[index] = { ...saved, settings: s.instances[index].settings };
          });
        }
      } catch (error) {
        toastError(t('common.reglages_non_enregistres'), error);
      }
    }, 400),
  );
}

export function openInstanceFolder(id) {
  api.openInstanceFolder(id).catch((error) => toastError(t('common.impossible_ouvrir_le_dossier'), error));
}

export function openLauncherFolder() {
  api.openLauncherFolder().catch((error) => toastError(t('common.impossible_ouvrir_le_dossier'), error));
}

// ---------- Comptes ----------

export async function addOfflineAccount(name) {
  const data = await api.addOfflineAccount(name);
  await refreshAccounts(data);
  api.refreshLooks().then(refreshAccounts, () => {});
  update((s) => {
    if (s.modal?.type === 'accounts') s.modal = null;
  });
  toast({ kind: 'success', title: t('actions.bienvenue', { name: name.trim() }), text: t('actions.compte_hors_ligne_ajoute_et') });
}

// ---------- Connexion Microsoft (dans le navigateur par défaut, phase 7) ----------

let loginWatched = false;
let loginTicker = null;

/** Suit l'état envoyé par le processus principal ; redessine chaque demi-minute le temps restant. */
function watchLogin() {
  if (loginWatched) return;
  loginWatched = true;
  api.on.loginState((next) => {
    update((s) => {
      if (next.phase === 'idle') {
        if (s.login?.phase !== 'expired') s.login = null;
      } else s.login = { phase: next.phase, url: next.url ?? null, expiresAt: next.expiresAt ?? null, copied: false };
    });
    clearInterval(loginTicker);
    loginTicker = next.phase === 'browser' ? setInterval(() => update(() => {}), 30_000) : null;
  });
}

/**
 * Ouvre la connexion Microsoft ; sert aussi à reconnecter un compte expiré.
 * `mode` : 'window' pour la fenêtre intégrée, sinon le navigateur habituel.
 */
export async function addMicrosoftAccount(mode) {
  if (!state.microsoftReady) {
    toast({
      title: t('actions.connexion_microsoft_bientot_disponible'),
      text: t('actions.il_manque_identifiant_de_application'),
      timeout: 9000,
    });
    return;
  }
  if (state.login && state.login.phase !== 'expired') return;
  const inWindow = mode === 'window';
  watchLogin();
  update((s) => { s.login = { phase: inWindow ? 'window' : 'starting', url: null, expiresAt: null, copied: false }; });
  try {
    const data = await api.addMicrosoftAccount(inWindow ? 'window' : 'browser');
    // Annulé, ou 10 minutes sans réponse du navigateur (bloc « Connexion annulée » avec Réessayer).
    if (data.ended) {
      update((s) => { s.login = data.ended === 'TIMEOUT' ? { phase: 'expired', url: null, expiresAt: null, copied: false } : null; });
      return;
    }
    update((s) => { s.login = null; });
    await refreshAccounts(data);
    toast({ kind: 'success', title: t('actions.connecte', { name: data.name }), text: t('actions.compte_microsoft_ajoute_et_selectionne') });
  } catch (error) {
    update((s) => { s.login = null; });
    toastError(t('actions.connexion_microsoft_impossible'), error);
  }
}

/** Bloc d'attente : rouvre la page de Microsoft dans le navigateur. */
export function reopenLogin() {
  api.loginReopen().catch(() => {});
}

/** Bloc d'attente : copie l'adresse de la page de connexion (à coller dans un autre navigateur). */
export async function copyLoginLink() {
  const url = state.login?.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    toast({ kind: 'error', title: t('common.le_presse_papiers_est_pas') });
    return;
  }
  update((s) => { if (s.login) s.login.copied = true; });
  setTimeout(() => update((s) => { if (s.login?.url === url) s.login.copied = false; }), 4000);
}

/** Passe à la fenêtre intégrée (la page affiche une erreur, ou le navigateur ne s'ouvre pas). */
export function useLoginWindow() {
  if (state.login?.phase === 'expired') {
    update((s) => { s.login = null; });
    addMicrosoftAccount('window');
    return;
  }
  api.loginWindow().catch(() => {});
}

export function cancelLogin() {
  if (state.login?.phase === 'expired') {
    update((s) => { s.login = null; });
    return;
  }
  api.loginCancel().catch(() => {});
}

export function removeAccount(id) {
  api.removeAccount(id).then(
    (data) => {
      refreshAccounts(data);
      if (!data.accounts.length) update((s) => { s.modal = null; });
    },
    (error) => toastError(t('actions.compte_non_retire'), error),
  );
}

export function setActiveAccount(id) {
  api.setActiveAccount(id).then(refreshAccounts, (error) => toastError(t('actions.compte_non_selectionne'), error));
}

// ---------- Lancement ----------

let checkingMods = false;

/** Installe les dépendances réclamées par les mods de l'instance et renvoie le diagnostic à jour. */
export async function installMissingDeps(instanceId) {
  const progress = toast({ title: t('actions.installation_des_dependances'), timeout: 0 });
  try {
    const result = await api.resolveModDeps(instanceId);
    if (result.installed.length) {
      toast({ kind: 'success', title: t('actions.deps_added', { count: result.installed.length }), text: result.installed.map((d) => d.title).join(', ') });
    }
    return result;
  } finally {
    dismissToast(progress);
  }
}

export async function requestLaunch(options = {}) {
  const instance = selectedInstance();
  if (!instance || !activeAccount() || state.run || checkingMods) return;
  checkingMods = true;
  try {
    // Avant le diagnostic, qui voit ainsi FancyMenu et les mods qu'il demande.
    if (await autoTitleMenu(instance)) await refreshInstances();
    let { problems } = await api.checkMods(instance.id);
    if (problems.some((p) => p.dependency)) {
      try {
        ({ problems } = await installMissingDeps(instance.id));
      } catch (error) {
        toastError(t('common.installation_impossible'), error);
      }
    }
    if (problems.length) {
      update((s) => { s.modal = { type: 'mod-check', instanceId: instance.id, options, problems }; });
      return;
    }
  } catch {
    // le diagnostic ne doit jamais empêcher de jouer
  } finally {
    checkingMods = false;
  }
  continueLaunch(instance, options);
}

/** Applique une correction (activer ou désactiver un mod), puis met la liste à jour. */
export async function fixModProblem(problem) {
  const modal = state.modal;
  if (modal?.type !== 'mod-check' || !problem.action) return;
  try {
    await api.toggleContent(modal.instanceId, 'mods', problem.action.file);
    const { problems } = await api.checkMods(modal.instanceId);
    if (problems.length) update((s) => { if (s.modal?.type === 'mod-check') s.modal.problems = problems; });
    else {
      update((s) => { s.modal = null; });
      toast({ kind: 'success', title: t('actions.mods_corriges'), text: t('actions.plus_aucun_probleme_detecte') });
    }
  } catch (error) {
    toastError(t('actions.correction_impossible'), error);
  }
}

/** Applique toutes les corrections, puis lance. */
export async function fixAllAndLaunch() {
  const modal = state.modal;
  if (modal?.type !== 'mod-check') return;
  const files = [...new Set(modal.problems.map((p) => p.action?.file).filter(Boolean))];
  try {
    for (const file of files) await api.toggleContent(modal.instanceId, 'mods', file);
  } catch (error) {
    toastError(t('actions.correction_impossible'), error);
    return;
  }
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (instance) continueLaunch(instance, modal.options);
}

export function launchAnyway() {
  const modal = state.modal;
  const instance = modal && state.instances.find((i) => i.id === modal.instanceId);
  if (instance) continueLaunch(instance, modal.options);
}

async function continueLaunch(instance, options) {
  update((s) => { s.modal = null; });
  const { freeGb } = await refreshMemory();
  if (instance.settings.lowRamWarning && instance.settings.ram * 0.7 > freeGb) {
    update((s) => { s.modal = { type: 'low-ram', instanceId: instance.id, options }; });
    return;
  }
  startLaunch(instance.id, options);
}

export function startLaunch(instanceId, options = {}) {
  update((s) => { s.modal = null; });
  api.startLaunch(instanceId, options).then(
    (result) => {
      if (result?.backupError) {
        askBackupFailed(result.backupError, { retry: () => startLaunch(instanceId, options), skip: () => startLaunch(instanceId, { ...options, skipBackup: true }) });
      } else if (!options.prepareOnly) forgetWorlds(instanceId);
    },
    (error) => toastError(t('actions.lancement_impossible'), error),
  );
}

/** La sauvegarde automatique des mondes a échoué : l'opération attend un choix (réessayer ou continuer sans). */
export function askBackupFailed(message, { retry, skip }) {
  update((s) => { s.modal = { type: 'backup-failed', message, retry, skip }; });
}

export function verifyInstance(instanceId) {
  startLaunch(instanceId, { verify: true, prepareOnly: true });
}

export function stopGame() {
  api.stopLaunch().catch((error) => toastError(t('actions.impossible_arreter'), error));
}

export function disableLowRamWarning(instanceId) {
  const instance = state.instances.find((i) => i.id === instanceId);
  if (!instance) return;
  update((s) => {
    instance.settings.lowRamWarning = false;
    s.modal = null;
  });
  saveSettings('instance', instanceId);
}

function listenToLaunches() {
  api.on.reset(() => update((s) => { s.logs = []; }));
  api.on.logs((lines) => {
    const add = (s) => {
      s.logs.push(...lines);
      if (s.logs.length > 5000) s.logs.splice(0, s.logs.length - 5000);
    };
    // Seule la console affiche les logs : ailleurs, rien n'est redessiné (le jeu garde le processeur).
    if (state.view === 'console') update(add);
    else add(state);
  });
  api.on.progress((run) => update((s) => { s.run = run; }));
  // Mesures du jeu : seuls l'accueil et la console les montrent, ailleurs rien n'est redessiné.
  api.on.metrics((metrics) => {
    if (state.view === 'home' || state.view === 'console') update((s) => { s.gameMetrics = metrics; });
    else state.gameMetrics = metrics;
  });
  api.on.status(handleLaunchStatus);
}

/** Changement d'état de la partie (launch:status), ou fin de partie remise à une fenêtre recréée. */
async function handleLaunchStatus(status) {
  update((s) => {
    s.run = status.run;
    if (!status.run) s.gameMetrics = null;
  });
  const instance = state.instances.find((i) => i.id === (status.instanceId ?? status.run?.instanceId));
  const name = instance?.name ?? "L'instance";

  if (status.error && status.errorCode === 'JAVA_32_BIT' && instance) {
    // Java personnalisé 32 bits avec trop de mémoire : la solution en un clic.
    toast({
      kind: 'error',
      title: t('actions.lancement_arrete_java_32'),
      text: status.error,
      timeout: 0,
      actions: [
        { label: t('actions.repasser_java_automatique'), run: () => { instance.settings.java = 'auto'; saveSettings('instance', instance.id); } },
        { label: t('common.parametres'), run: () => update((s) => { s.view = 'settings'; s.settingsScope = 'instance'; s.selectedId = instance.id; }) },
      ],
    });
  } else if (status.error) {
    refreshAccounts().catch(() => {}); // une session Microsoft expirée est signalée dans la liste des comptes
    toast({
      kind: 'error',
      title: t('actions.le_lancement_echoue'),
      text: status.error,
      timeout: 12000,
      actions: [{ label: t('actions.voir_la_console'), run: () => update((s) => { s.view = 'console'; }) }],
    });
  }
  if (status.prepared) toast({ kind: 'success', title: t('actions.est_prete', { name }), text: t('actions.tous_les_fichiers_ont_ete') });
  if (status.crashed) {
    const report = status.crash && { instanceId: status.instanceId, ...status.crash };
    toast({
      kind: 'error',
      title: t('actions.le_jeu_plante'),
      text: t(report ? 'actions.crash_report_read' : 'actions.crash_report_console', { name, code: status.code }),
      timeout: 0,
      actions: report
        ? [{ label: t('actions.voir_explication'), run: () => openCrashes(report) }]
        : [{ label: t('actions.voir_la_console'), run: () => update((s) => { s.view = 'console'; s.console.tab = 'logs'; }) }],
    });
  }
  if (status.exited) {
    loadCrashes(); // le jeu a pu laisser un rapport de crash
  }
  if (status.run?.phase === 'running' && instance && !instance.installed) {
    toast({ kind: 'success', title: t('actions.est_prete', { name }), text: t('actions.minecraft_installe', { version: instance.version }) });
  }
  if (status.exited || status.prepared || status.run?.phase === 'running') await refreshInstances();
}
