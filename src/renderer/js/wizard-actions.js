// Assistant de création d'instance : choix du profil, nom et version, récapitulatif, création puis installation des mods.
import { refreshInstances } from './actions.js';
import { api } from './api.js';
import { forgetPreviews } from './perf-actions.js';
import { refreshInstalled } from './mods-actions.js';
import { state, toast, toastError, update } from './state.js';

/** Cartes de l'étape 1. `online` : le profil télécharge des mods, il faut une connexion. */
export const PROFILE_CARDS = [
  { id: 'survival', title: 'Survie optimisée', text: 'Fabric et Pack Performances, sur la version la plus récente', online: true },
  { id: 'pvp', title: 'PvP', text: 'Fabric, performances et confort : zoom, ping, infos de faim. Rien qui triche', online: true },
  { id: 'shaders', title: 'Shaders', text: 'Fabric, Sodium et Iris : prêt à recevoir un shader', online: true },
  { id: 'creative', title: 'Créatif', text: 'Vanilla, dernière version, rien à configurer', online: false },
  { id: 'modpack', title: 'Modpack', text: 'Choisir un pack complet sur Modrinth', online: true },
  { id: 'custom', title: 'Personnalisée', text: 'Le formulaire complet : version, loader, compte', online: false },
];

export const offline = () => Boolean(state.versions.offline);

const latestRelease = () => state.versions.latest?.release ?? state.versions.list.find((v) => v.type === 'release')?.id ?? '';

function wizardOf() {
  return state.modal?.type === 'new-instance' ? state.modal.wizard : null;
}

/** Ouvre l'assistant. Avec une version (onglet Versions) : directement l'étape 2, profil Créatif par défaut. */
export function openWizard(version) {
  const forced = typeof version === 'string' && version ? version : null;
  update((s) => {
    s.modal = {
      type: 'new-instance',
      draft: { icon: 'grass', name: '', version: forced ?? latestRelease(), loader: 'vanilla', loaderVersion: null, group: '', accountId: null },
      wizard: { step: forced ? 2 : 1, profile: forced ? 'creative' : null, forced, plan: null, nameEdited: false, error: null },
    };
  });
  if (forced) goToDetails();
}

function profileTitle(id) {
  return PROFILE_CARDS.find((c) => c.id === id)?.title ?? '';
}

export function pickProfile(id) {
  const card = PROFILE_CARDS.find((c) => c.id === id);
  if (!card || (card.online && offline())) return;
  if (id === 'modpack') {
    update((s) => {
      s.modal = null;
      s.view = 'mods';
      Object.assign(s.mods, { kind: 'modpacks', selected: null });
      s.mods.search.key = null;
    });
    return;
  }
  if (id === 'custom') {
    // Le formulaire actuel, tel quel, avec la version éventuellement choisie ailleurs.
    update((s) => { if (s.modal) s.modal.wizard = null; });
    return;
  }
  update((s) => { if (s.modal?.wizard) s.modal.wizard.profile = id; });
}

let planSeq = 0;

/** Calcule version, mods prévus et mémoire conseillée du profil (version imposée, ou choisie par l'assistant si null). */
async function runPlan(version) {
  const wiz = wizardOf();
  if (!wiz) return;
  const seq = ++planSeq;
  update(() => { wiz.plan = { loading: true }; wiz.error = null; });
  try {
    const plan = await api.profilePlan(wiz.profile, version);
    if (seq !== planSeq || wizardOf() !== wiz) return;
    update((s) => {
      wiz.plan = { data: plan };
      s.modal.draft.version = plan.version;
    });
  } catch (error) {
    if (seq === planSeq && wizardOf() === wiz) update(() => { wiz.plan = { error: error.message }; });
  }
}

/** Passe à l'étape 2 : nom prérempli (sauf s'il a été modifié) et plan du profil. */
export function goToDetails() {
  const wiz = wizardOf();
  if (!wiz || !wiz.profile) return;
  update((s) => {
    wiz.step = 2;
    if (!wiz.nameEdited) s.modal.draft.name = profileTitle(wiz.profile);
  });
  runPlan(wiz.forced ? state.modal.draft.version : null);
}

export function backToProfiles() {
  update(() => {
    const wiz = wizardOf();
    if (wiz) wiz.step = 1;
  });
}

export function setWizardVersion(version) {
  update((s) => { s.modal.draft.version = version; });
  runPlan(version);
}

export function setWizardName(name) {
  const wiz = wizardOf();
  state.modal.draft.name = name;
  if (wiz) wiz.nameEdited = true;
}

export function goToRecap() {
  const wiz = wizardOf();
  if (!wiz || wiz.plan?.loading || !wiz.plan?.data) return;
  if (!state.modal.draft.name.trim()) {
    update(() => { wiz.error = 'Donne un nom à ton instance.'; });
    return;
  }
  update(() => { wiz.step = 3; wiz.error = null; });
}

export function backToDetails() {
  update(() => {
    const wiz = wizardOf();
    if (wiz) wiz.step = 2;
  });
}

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

/** Crée l'instance, ferme l'assistant, puis installe les mods du profil avec une progression visible. */
export async function createFromWizard() {
  const modal = state.modal;
  const wiz = wizardOf();
  if (!wiz || modal.busy || !wiz.plan?.data) return;
  const { draft } = modal;
  const profile = wiz.profile;
  const hasMods = wiz.plan.data.mods.some((m) => m.available);
  update(() => { modal.busy = true; wiz.error = null; });
  let instance;
  try {
    instance = await api.profileCreate({ profile, name: draft.name.trim(), icon: draft.icon, version: draft.version, group: '', accountId: draft.accountId ?? null });
    await refreshInstances();
  } catch (error) {
    update(() => { modal.busy = false; wiz.error = error.message; });
    return;
  }
  update((s) => {
    s.selectedId = instance.id;
    s.view = 'home';
    s.modal = null;
  });
  if (!hasMods) {
    toast({
      kind: 'success',
      title: `${instance.name} créée`,
      text: wiz.plan.data.mods.length ? 'Aucun mod du profil n’existe pour cette version : l’instance est créée sans eux.' : 'Clique sur « Installer » pour la préparer, puis joue.',
    });
    return;
  }
  try {
    const result = await api.profileInstallMods(instance.id, profile);
    forgetPreviews(instance.id);
    const mods = result.installed.filter((m) => !m.dependency).length;
    const deps = result.installed.length - mods;
    toast({
      kind: result.failed.length ? 'error' : 'success',
      title: `${instance.name} créée : ${plural(mods, 'mod')} installé${mods > 1 ? 's' : ''}`,
      text:
        [
          deps > 0 && `${plural(deps, 'dépendance')} ajoutée${deps > 1 ? 's' : ''}.`,
          result.skipped.length > 0 && `Ignoré, indisponible en ${instance.version} : ${result.skipped.map((m) => m.title).join(', ')}.`,
          result.failed.length > 0 && `Échec : ${result.failed.map((f) => f.title).join(', ')}.`,
        ]
          .filter(Boolean)
          .join(' ') || 'Clique sur « Installer » pour préparer le jeu.',
      timeout: 9000,
    });
    refreshInstalled(state.instances.find((i) => i.id === instance.id) ?? instance, 'mods');
  } catch (error) {
    toastError(`${instance.name} créée, mais les mods n’ont pas été installés`, error);
  }
}
