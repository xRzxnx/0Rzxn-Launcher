// Actions de l'interface : elles appellent le processus principal puis mettent l'état à jour.
import { api } from './api.js';
import { loadCrashes, openCrashes } from './crash-actions.js';
import { loadLauncherPrefs } from './launcher-actions.js';
import { activeAccount, selectedInstance, state, subscribe, toast, toastError, update } from './state.js';

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
  try {
    let info, settings, launchState;
    [info, settings, launchState, ui] = await Promise.all([api.info(), api.settings(), api.launchState(), api.ui(), refreshAccounts(), refreshInstances(), refreshMemory(), loadLauncherPrefs()]);
    update((s) => {
      s.appVersion = info.version;
      s.microsoftReady = info.microsoftReady;
      s.discordReady = info.discordReady;
      s.globalSettings = settings;
      s.run = launchState.run;
      s.logs = launchState.logs;
      if (s.instances.some((i) => i.id === ui.selectedId)) s.selectedId = ui.selectedId;
      s.sidebar.collapsed = ui.collapsedGroups ?? [];
      // Premier démarrage avec les rapports de crash : les anciens rapports ne comptent pas comme nouveaux.
      s.crashes.seenAt = ui.crashesSeenAt ?? Date.now();
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
  api.on.task((task) => update((s) => { s.task = task; }));
  rememberSelection(ui.selectedId);
  api.on.launchRequest(launchFromShortcut);
  if (ui.pendingLaunch) launchFromShortcut(ui.pendingLaunch);
  if (ui.crashesSeenAt == null) api.saveUi({ crashesSeenAt: state.crashes.seenAt }).catch(() => {});
  loadVersions();
  loadCrashes();
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
    toast({ kind: 'error', title: 'Raccourci invalide', text: "Cette instance n'existe plus." });
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
    title: `${instance.name} créée`,
    text: instance.installed ? 'Minecraft est déjà installé : tu peux jouer tout de suite.' : `Clique sur « Installer ${instance.version} » pour la préparer.`,
  });
}

/** Nom, icône ou version (fenêtre « Modifier l'instance »). */
export async function editInstance(id, patch) {
  await api.updateInstance(id, patch);
  await refreshInstances();
  update((s) => { s.modal = null; });
  toast({ kind: 'success', title: 'Instance modifiée', text: patch.name });
}

export async function duplicateInstance(id) {
  const source = state.instances.find((i) => i.id === id);
  try {
    const copy = await api.duplicateInstance(id, `${source.name} (copie)`);
    await refreshInstances();
    update((s) => { s.selectedId = copy.id; s.view = 'home'; });
    toast({ kind: 'success', title: `${copy.name} créée`, text: 'Copie complète : mondes, options et packs de ressources.' });
  } catch (error) {
    toastError('Copie impossible', error);
  }
}

export async function deleteInstance(id) {
  const instance = state.instances.find((i) => i.id === id);
  await api.deleteInstance(id);
  update((s) => { s.modal = null; });
  await refreshInstances();
  toast({ kind: 'success', title: `${instance?.name ?? 'Instance'} supprimée`, text: 'Le dossier est dans la corbeille de Windows si tu changes d’avis.' });
}

export function createShortcut(id) {
  api.createShortcut(id).then(
    (file) => toast({ kind: 'success', title: 'Raccourci créé', text: `« ${file.replace(/\.lnk$/, '')} » est sur ton bureau : il lance directement l'instance.` }),
    (error) => toastError('Raccourci impossible', error),
  );
}

const saveTimers = new Map();

/** Les réglages sont enregistrés automatiquement, 400 ms après la dernière modification. */
export function saveSettings(scope, instanceId) {
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
        toastError('Réglages non enregistrés', error);
      }
    }, 400),
  );
}

export function openInstanceFolder(id) {
  api.openInstanceFolder(id).catch((error) => toastError("Impossible d'ouvrir le dossier", error));
}

export function openLauncherFolder() {
  api.openLauncherFolder().catch((error) => toastError("Impossible d'ouvrir le dossier", error));
}

// ---------- Comptes ----------

export async function addOfflineAccount(name) {
  const data = await api.addOfflineAccount(name);
  await refreshAccounts(data);
  api.refreshLooks().then(refreshAccounts, () => {});
  update((s) => {
    if (s.modal?.type === 'accounts') s.modal = null;
  });
  toast({ kind: 'success', title: `Bienvenue, ${name.trim()}`, text: 'Compte hors-ligne ajouté et sélectionné.' });
}

/** Ouvre la page de connexion Microsoft ; sert aussi à reconnecter un compte expiré. */
export async function addMicrosoftAccount() {
  if (!state.microsoftReady) {
    toast({
      title: 'Connexion Microsoft bientôt disponible',
      text: "Il manque l'identifiant de l'application Azure approuvée par Mojang (voir docs/MICROSOFT.md).",
      timeout: 9000,
    });
    return;
  }
  if (state.signingIn) return;
  update((s) => { s.signingIn = true; });
  try {
    const data = await api.addMicrosoftAccount();
    await refreshAccounts(data);
    update((s) => {
      if (s.modal?.type === 'accounts') s.modal = null;
    });
    toast({ kind: 'success', title: `Connecté : ${data.name}`, text: 'Compte Microsoft ajouté et sélectionné.' });
  } catch (error) {
    if (error.message !== 'Connexion annulée.') toastError('Connexion Microsoft impossible', error);
  } finally {
    update((s) => { s.signingIn = false; });
  }
}

export function removeAccount(id) {
  api.removeAccount(id).then(
    (data) => {
      refreshAccounts(data);
      if (!data.accounts.length) update((s) => { s.modal = null; });
    },
    (error) => toastError('Compte non retiré', error),
  );
}

export function setActiveAccount(id) {
  api.setActiveAccount(id).then(refreshAccounts, (error) => toastError('Compte non sélectionné', error));
}

// ---------- Lancement ----------

export async function requestLaunch(options = {}) {
  const instance = selectedInstance();
  if (!instance || !activeAccount() || state.run) return;
  const { freeGb } = await refreshMemory();
  if (instance.settings.lowRamWarning && instance.settings.ram * 0.7 > freeGb) {
    update((s) => { s.modal = { type: 'low-ram', instanceId: instance.id, options }; });
    return;
  }
  startLaunch(instance.id, options);
}

export function startLaunch(instanceId, options = {}) {
  update((s) => { s.modal = null; });
  api.startLaunch(instanceId, options).catch((error) => toastError('Lancement impossible', error));
}

export function verifyInstance(instanceId) {
  startLaunch(instanceId, { verify: true, prepareOnly: true });
}

export function stopGame() {
  api.stopLaunch().catch((error) => toastError("Impossible d'arrêter", error));
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
  api.on.status(async (status) => {
    update((s) => { s.run = status.run; });
    const instance = state.instances.find((i) => i.id === (status.instanceId ?? status.run?.instanceId));
    const name = instance?.name ?? "L'instance";

    if (status.error) {
      refreshAccounts().catch(() => {}); // une session Microsoft expirée est signalée dans la liste des comptes
      toast({
        kind: 'error',
        title: 'Le lancement a échoué',
        text: status.error,
        timeout: 12000,
        actions: [{ label: 'Voir la console', run: () => update((s) => { s.view = 'console'; }) }],
      });
    }
    if (status.prepared) toast({ kind: 'success', title: `${name} est prête`, text: 'Tous les fichiers ont été vérifiés.' });
    if (status.crashed) {
      const report = status.crash && { instanceId: status.instanceId, ...status.crash };
      toast({
        kind: 'error',
        title: 'Le jeu a planté',
        text: `${name} · code de sortie ${status.code}. ${report ? 'Le launcher a lu le rapport et explique l’erreur.' : 'Le rapport est dans la console.'}`,
        timeout: 0,
        actions: report
          ? [{ label: 'Voir l’explication', run: () => openCrashes(report) }]
          : [{ label: 'Voir la console', run: () => update((s) => { s.view = 'console'; s.console.tab = 'logs'; }) }],
      });
    }
    if (status.exited) {
      loadCrashes(); // le jeu a pu laisser un rapport de crash
    }
    if (status.run?.phase === 'running' && instance && !instance.installed) {
      toast({ kind: 'success', title: `${name} est prête`, text: `Minecraft ${instance.version} installé.` });
    }
    if (status.exited || status.prepared || status.run?.phase === 'running') await refreshInstances();
  });
}
