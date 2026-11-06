// Performances : aperçu des arguments Java, Pack Performances, consommation du launcher et carte graphique.
import { t } from './i18n.js';
import { refreshInstances } from './actions.js';
import { api } from './api.js';
import { refreshInstalled } from './mods-actions.js';
import { forgetRamGuide, selectedInstance, state, toast, toastError, update } from './state.js';

const previewKey = (instanceId, s) => `${instanceId ?? 'global'}|${s.jvmPreset}|${s.ram}|${s.jvmArgs}`;

/** Arguments envoyés à Java et RAM conseillée ; pendant le calcul, le dernier aperçu de l'instance reste affiché. */
export function perfPreview(instanceId, settings) {
  const key = previewKey(instanceId, settings);
  const known = state.perf.previews[key];
  if (!known) {
    state.perf.previews[key] = { loading: true };
    api
      .perfPreview(instanceId, settings)
      .then((data) => update((s) => {
        s.perf.previews[key] = data;
        s.perf.last[instanceId ?? 'global'] = data;
      }))
      .catch(() => update((s) => { s.perf.previews[key] = { error: true }; }));
  }
  return known && !known.loading && !known.error ? known : state.perf.last[instanceId ?? 'global'] ?? null;
}

/** Conseil de mémoire pour une instance (ou les réglages globaux) ; null pendant le calcul. */
export function ramGuide(instance) {
  const settings = instance?.settings ?? state.globalSettings;
  const key = `${instance?.id ?? 'global'}|${settings.jvmPreset}`;
  const known = state.perf.guides[key];
  if (!known) {
    state.perf.guides[key] = { loading: true };
    api
      .perfRamGuide(instance?.id ?? null, settings)
      .then((data) => update((s) => { s.perf.guides[key] = data; }))
      .catch(() => update((s) => { s.perf.guides[key] = { error: true }; }));
  }
  return known && !known.loading && !known.error ? known : null;
}

/** RAM libre à jour, sans redessin : l'interface reste celle que l'utilisateur est en train de manipuler. */
export function refreshFreeRam() {
  api.memory().then((memory) => { state.memory = memory; }).catch(() => {});
}

/** Le contenu de l'instance a changé : l'aperçu (nombre de mods, RAM conseillée) est à refaire. */
export function forgetPreviews(instanceId) {
  for (const key of Object.keys(state.perf.previews)) if (key.startsWith(`${instanceId}|`)) delete state.perf.previews[key];
  forgetRamGuide(instanceId);
}

export async function openPack(instance = selectedInstance()) {
  if (!instance) return;
  update((s) => { s.modal = { type: 'perf-pack', instanceId: instance.id, loading: true, data: null, picked: {}, error: null }; });
  try {
    const data = await api.perfPack(instance.id);
    update((s) => {
      if (s.modal?.type !== 'perf-pack' || s.modal.instanceId !== instance.id) return;
      s.modal.loading = false;
      s.modal.data = data;
      s.modal.picked = Object.fromEntries(data.mods.map((m) => [m.slug, m.checked]));
    });
  } catch (error) {
    update((s) => {
      if (s.modal?.type === 'perf-pack') Object.assign(s.modal, { loading: false, error: error.message });
    });
  }
}

export function togglePackMod(slug) {
  update((s) => {
    if (s.modal?.type === 'perf-pack') s.modal.picked[slug] = !s.modal.picked[slug];
  });
}

export function chosenPackMods(modal) {
  return (modal.data?.mods ?? []).filter((m) => m.state === 'available' && modal.picked[m.slug]);
}

export async function installPack(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  const slugs = chosenPackMods(modal).map((m) => m.slug);
  if (!instance || !slugs.length) return;
  const convert = instance.loader === 'vanilla';
  update((s) => { s.modal = null; });
  try {
    const result = await api.installPack(instance.id, slugs, { convert });
    if (convert) await refreshInstances();
    forgetPreviews(instance.id);
    const mods = result.installed.filter((m) => !m.dependency).length;
    const deps = result.installed.length - mods;
    toast({
      kind: result.failed.length ? 'error' : 'success',
      title: t('perf.pack_performances_mods_installes', { count: mods }),
      text: [
        convert && t('perf.est_passee_en_fabric', { name: instance.name }),
        deps > 0 && t('perf.dependances_ajoutees', { count: deps }),
        result.failed.length > 0 && t('perf.echec', { failed: result.failed.map((f) => f.title).join(', '), message: result.failed[0].message }),
      ].filter(Boolean).join(' ') || t('perf.les_fps_changent_au_prochain'),
      timeout: 9000,
    });
    refreshInstalled(state.instances.find((i) => i.id === instance.id) ?? instance, 'mods');
  } catch (error) {
    toastError(t('perf.pack_performances_non_installe'), error);
  }
}

// ---------- Paramètres › Launcher ----------

let metricsTimer = null;

/** Consommation du launcher, relevée toutes les 2 s tant que l'onglet Launcher est affiché. */
export function watchMetrics() {
  if (metricsTimer) return;
  const tick = async () => {
    const visible = state.view === 'settings' && state.settingsScope === 'launcher' && !document.hidden;
    if (!visible) {
      metricsTimer = null;
      return;
    }
    try {
      const metrics = await api.perfMetrics();
      update((s) => { s.perf.metrics = metrics; });
    } catch {
      // mesure indisponible : la carte garde l'ancienne valeur
    }
    metricsTimer = setTimeout(tick, 2000);
  };
  metricsTimer = setTimeout(tick, 0);
}

export async function loadGpu() {
  if (state.perf.gpu || state.perf.gpuLoading) return;
  state.perf.gpuLoading = true;
  try {
    const gpu = await api.gpuStatus();
    update((s) => { s.perf.gpu = gpu; });
  } catch {
    update((s) => { s.perf.gpu = { gpus: [], javas: 0, high: 0, enabled: false }; });
  } finally {
    state.perf.gpuLoading = false;
  }
}

/** Écrit (ou retire) la préférence de Windows : appelé seulement après la confirmation. */
export async function setGpu(on) {
  update((s) => { s.modal = null; s.perf.gpuBusy = true; });
  try {
    const prefs = await api.setGpu(on);
    update((s) => {
      s.launcherPrefs = prefs;
      s.perf.gpu = null;
    });
    toast({ kind: 'success', title: on ? t('perf.carte_dediee_choisie_pour_minecraft') : t('perf.choix_de_windows_retabli'), text: on ? t('perf.les_java_du_launcher_utiliseront') : t('perf.windows_choisit_de_nouveau_la') });
  } catch (error) {
    toastError(t('perf.reglage_de_windows_non_modifie'), error);
  } finally {
    update((s) => { s.perf.gpuBusy = false; });
    loadGpu();
  }
}
