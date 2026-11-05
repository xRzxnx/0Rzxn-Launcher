// Actions de la fenêtre « Importer » : instances d'autres launchers.
import { refreshInstances } from './actions.js';
import { api } from './api.js';
import { LOADER_NAMES } from './data.js';
import { toast, toastError, update } from './state.js';

/** Modifie la fenêtre d'import si elle est toujours ouverte (les recherches sont asynchrones). */
function patch(mutate) {
  update((s) => {
    if (s.modal?.type === 'import') mutate(s.modal);
  });
}

export function openImport() {
  update((s) => { s.modal = { type: 'import', instances: null }; });
  scan(api.scanDefaultInstances());
}

async function scan(promise) {
  try {
    const result = await promise;
    if (result) patch((m) => { m.instances = result; });
  } catch (error) {
    patch((m) => { m.instances = { error: error.message }; });
  }
}

export function pickImportFolder() {
  scan(api.pickInstances());
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
