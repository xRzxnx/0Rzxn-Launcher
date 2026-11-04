// Actions de la fenêtre « Importer » : instances d'autres launchers et mondes du .minecraft.
import { refreshInstances } from './actions.js';
import { api } from './api.js';
import { LOADER_NAMES } from './data.js';
import { selectedInstance, state, toast, toastError, update } from './state.js';
import { forgetWorlds } from './worlds-actions.js';

/** Modifie la fenêtre d'import si elle est toujours ouverte (les recherches sont asynchrones). */
function patch(mutate) {
  update((s) => {
    if (s.modal?.type === 'import') mutate(s.modal);
  });
}

export function openImport(tab = 'instances') {
  update((s) => {
    s.modal = { type: 'import', tab, instances: null, worlds: null, targetId: selectedInstance()?.id ?? null, copied: {} };
  });
  loadTab(tab);
}

export function showImportTab(tab) {
  patch((m) => { m.tab = tab; });
  loadTab(tab);
}

function loadTab(tab) {
  const modal = state.modal;
  if (modal?.type !== 'import' || modal[tab]) return;
  scan(tab, tab === 'instances' ? api.scanDefaultInstances() : api.scanWorlds());
}

async function scan(tab, promise) {
  try {
    const result = await promise;
    if (result) patch((m) => { m[tab] = result; });
  } catch (error) {
    patch((m) => { m[tab] = { error: error.message }; });
  }
}

export function pickImportFolder(tab) {
  scan(tab, tab === 'instances' ? api.pickInstances() : api.pickWorlds());
}

export async function importInstance(item) {
  try {
    const { instance, files, warnings } = await api.importInstance(item.path);
    await refreshInstances();
    update((s) => {
      s.modal = null;
      s.selectedId = instance.id;
      s.view = 'home';
    });
    toast({
      kind: warnings.length ? 'info' : 'success',
      title: `${instance.name} importée`,
      text: [`${files} fichiers copiés, Minecraft ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}.`, ...warnings].join(' '),
      timeout: warnings.length ? 12000 : 6000,
    });
  } catch (error) {
    toastError('Import impossible', error);
  }
}

export function setImportTarget(id) {
  patch((m) => { m.targetId = id; });
}

export async function importWorld(world) {
  const target = state.instances.find((i) => i.id === state.modal?.targetId);
  if (!target) return;
  try {
    const { folder } = await api.importWorld(world.path, target.id);
    patch((m) => { m.copied[world.path] = target.name; });
    forgetWorlds(target.id);
    toast({
      kind: 'success',
      title: `${world.name} copié`,
      text: `Dans « ${target.name} »${folder !== world.folder ? `, sous le nom ${folder}` : ''}. Il apparaît dans la liste des mondes du jeu.`,
    });
  } catch (error) {
    toastError('Copie impossible', error);
  }
}
