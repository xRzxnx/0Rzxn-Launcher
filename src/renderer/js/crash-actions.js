// Rapports de crash : liste de toutes les instances, explication, corrections en un clic, partage sur mclo.gs.
import { t } from './i18n.js';
import { api } from './api.js';
import { verifyInstance } from './actions.js';
import { refreshInstalled } from './mods-actions.js';
import { state, toast, toastError, update } from './state.js';

export const crashKey = (item) => `${item.instanceId}:${item.source}:${item.file}`;

export async function loadCrashes() {
  if (state.crashes.loading) return;
  update((s) => { s.crashes.loading = true; });
  try {
    const list = await api.crashes();
    update((s) => {
      s.crashes.list = list;
      s.crashes.loading = false;
      if (!list.some((c) => crashKey(c) === s.crashes.selected)) s.crashes.selected = list[0] ? crashKey(list[0]) : null;
    });
  } catch (error) {
    update((s) => {
      s.crashes.list = [];
      s.crashes.loading = false;
    });
    toastError(t('crash.rapports_de_crash_illisibles'), error);
  }
}

/** Rapports apparus depuis le dernier passage sur l'onglet (pastille de la console). */
export function unseenCrashes() {
  return (state.crashes.list ?? []).filter((c) => c.at > state.crashes.seenAt).length;
}

function markSeen() {
  const now = Date.now();
  state.crashes.seenAt = now;
  api.saveUi({ crashesSeenAt: now }).catch(() => {});
}

/** Ouvre la console sur les rapports ; `target` ({ instanceId, source, file }) est sélectionné. */
export async function openCrashes(target = null) {
  update((s) => {
    s.view = 'console';
    s.console.tab = 'crashes';
    if (target) s.crashes.selected = crashKey(target);
  });
  markSeen();
  await loadCrashes();
  markSeen();
  update();
}

export function selectCrash(item) {
  update((s) => { s.crashes.selected = crashKey(item); });
}

export function selectedCrash() {
  return (state.crashes.list ?? []).find((c) => crashKey(c) === state.crashes.selected) ?? null;
}

/** Texte et explication du rapport, lus une seule fois. */
export function crashReport(item) {
  const key = crashKey(item);
  const known = state.crashes.reports[key];
  if (known) return known;
  state.crashes.reports[key] = { loading: true };
  api.readCrash(item.instanceId, item.source, item.file).then(
    (report) => update((s) => { s.crashes.reports[key] = report; }),
    (error) => update((s) => { s.crashes.reports[key] = { error: error.message }; }),
  );
  return state.crashes.reports[key];
}

export async function copyCrash(item) {
  const report = state.crashes.reports[crashKey(item)];
  if (!report?.text) return;
  try {
    await navigator.clipboard.writeText(report.text);
    toast({ kind: 'success', title: t('crash.rapport_copie'), text: t('crash.lines_copied', { count: report.text.split('\n').length }), timeout: 3000 });
  } catch {
    toast({ kind: 'error', title: t('common.copie_impossible'), text: t('common.le_presse_papiers_est_pas') });
  }
}

export function askShare(item) {
  update((s) => { s.modal = { type: 'share-crash', item }; });
}

/** Envoi sur mclo.gs (après confirmation) ; le lien est copié. */
export async function shareCrash(item) {
  const key = crashKey(item);
  update((s) => {
    s.modal = null;
    s.crashes.shared[key] = { loading: true };
  });
  try {
    const { url } = await api.shareCrash(item.instanceId, item.source, item.file);
    const copied = await navigator.clipboard.writeText(url).then(() => true, () => false);
    update((s) => { s.crashes.shared[key] = { url, copied }; });
  } catch (error) {
    update((s) => { s.crashes.shared[key] = { error: error.message }; });
  }
}

export function openCrashFile(item) {
  api.openCrash(item.instanceId, item.source, item.file).catch((error) => toastError(t('crash.impossible_ouvrir_le_rapport'), error));
}

export function openCrashesFolder(instanceId) {
  api.openCrashesFolder(instanceId).catch((error) => toastError(t('common.impossible_ouvrir_le_dossier'), error));
}

/** Corrections proposées par l'explication : installer, désactiver, réglages… */
export async function runFix(item, action) {
  const instance = state.instances.find((i) => i.id === item.instanceId);
  if (!instance) return;
  const goTo = (view) => update((s) => { s.selectedId = instance.id; s.view = view; });
  if (action.type === 'settings') return goTo('settings');
  if (action.type === 'verify') {
    goTo('home');
    return verifyInstance(instance.id);
  }
  if (action.type === 'mods') {
    update((s) => { s.mods.kind = 'mods'; s.mods.tab = 'installed'; });
    return goTo('mods');
  }
  const busy = `${crashKey(item)}:${action.type}:${action.slug ?? action.modId}`;
  if (state.crashes.shared[busy]) return;
  update((s) => { s.crashes.shared[busy] = { loading: true }; });
  try {
    if (action.type === 'install') {
      const project = await api.modrinthProject(action.slug);
      const result = await api.installContent(instance.id, 'mods', project.id, null);
      const added = result.installed.map((d) => d.title).join(', ');
      toast({ kind: 'success', title: added ? t('crash.installe', { added }) : t('common.est_deja_installe', { title: project.title }), text: t('crash.relance_le_jeu_pour_verifier') });
    } else if (action.type === 'disable') {
      const { items } = await api.content(instance.id, 'mods');
      const mod = items.find((m) => m.enabled && (m.modId === action.modId || m.modId?.replace(/[-_]/g, '') === action.modId.replace(/[-_]/g, '')));
      if (!mod) throw new Error(t('crash.aucun_mod_actif_ne_correspond', { modId: action.modId, name: instance.name }));
      await api.toggleContent(instance.id, 'mods', mod.file);
      toast({ kind: 'success', title: t('crash.desactive', { name: mod.name }), text: t('crash.tu_peux_le_reactiver_dans') });
    }
    if (state.selectedId === instance.id) refreshInstalled(instance, 'mods');
  } catch (error) {
    toastError(action.type === 'install' ? t('common.installation_impossible') : t('common.action_impossible'), error);
  } finally {
    update((s) => { delete s.crashes.shared[busy]; });
  }
}
