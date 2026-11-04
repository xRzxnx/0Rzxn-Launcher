// Actions de l'onglet Serveurs : liste (servers.dat de l'instance), ping, édition, connexion directe.
import { requestLaunch } from './actions.js';
import { api } from './api.js';
import { state, toast, toastError, update } from './state.js';

const PING_MAX_AGE = 60_000;

/** Liste des serveurs de l'instance (chargée à la demande). */
export function instanceServers(instance) {
  const known = state.servers.lists[instance.id];
  if (!known) refreshServers(instance);
  return state.servers.lists[instance.id];
}

export async function refreshServers(instance, { ping = false } = {}) {
  state.servers.lists[instance.id] = { ...(state.servers.lists[instance.id] ?? {}), loading: true };
  try {
    const items = await api.servers(instance.id);
    update((s) => { s.servers.lists[instance.id] = { items, loading: false }; });
    pingAll(instance, { force: ping });
  } catch (error) {
    update((s) => { s.servers.lists[instance.id] = { items: [], loading: false, error: error.message }; });
  }
}

function setItems(instance, items) {
  update((s) => { s.servers.lists[instance.id] = { items, loading: false }; });
  pingAll(instance);
}

/** Ping de tous les serveurs (ceux déjà interrogés il y a moins d'une minute sont gardés, sauf `force`). */
export function pingAll(instance, { force = false } = {}) {
  for (const server of state.servers.lists[instance.id]?.items ?? []) {
    const known = state.servers.pings[server.address];
    if (force || !known || (!known.loading && Date.now() - known.at > PING_MAX_AGE)) pingServer(instance, server);
  }
}

export async function pingServer(instance, server) {
  const address = server.address;
  if (state.servers.pings[address]?.loading) return;
  update((s) => { s.servers.pings[address] = { ...(s.servers.pings[address] ?? {}), loading: true }; });
  let result;
  try {
    result = await api.pingServer(address, { instanceId: instance.id, index: server.index });
  } catch (error) {
    result = { online: false, error: error.message };
  }
  update((s) => {
    s.servers.pings[address] = { ...result, loading: false, at: Date.now() };
    // Icône enregistrée dans servers.dat : on l'affiche aussi hors connexion.
    if (result.iconSaved) {
      const item = s.servers.lists[instance.id]?.items?.find((i) => i.index === server.index);
      if (item) item.icon = result.favicon;
    }
  });
}

export function openServerDialog(instance, server = null) {
  update((s) => {
    s.modal = {
      type: 'server',
      instanceId: instance.id,
      index: server?.index ?? null,
      draft: { name: server?.name ?? '', address: server?.address ?? '', resourcePacks: server?.resourcePacks ?? 'prompt' },
    };
  });
  setTimeout(() => document.getElementById('server-name')?.focus(), 50);
}

/** Enregistre la fenêtre « Serveur » (ajout ou modification). Lève une erreur lisible en cas de souci. */
export async function saveServer(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return;
  const items = modal.index === null ? await api.addServer(instance.id, modal.draft) : await api.updateServer(instance.id, modal.index, modal.draft);
  update((s) => { s.modal = null; });
  setItems(instance, items);
}

export async function moveServer(instance, server, offset) {
  const items = state.servers.lists[instance.id]?.items ?? [];
  const position = items.findIndex((i) => i.index === server.index);
  const target = items[position + offset];
  if (!target) return;
  try {
    setItems(instance, await api.moveServer(instance.id, server.index, target.index));
  } catch (error) {
    toastError('Serveur non déplacé', error);
  }
}

export async function removeServer(instance, server) {
  try {
    setItems(instance, await api.removeServer(instance.id, server.index));
  } catch (error) {
    toastError('Serveur non supprimé', error);
    return;
  }
  toast({
    title: `${server.name} supprimé`,
    text: server.address,
    actions: [
      {
        label: 'Annuler',
        run: async () => {
          try {
            const items = await api.addServer(instance.id, server);
            const added = items.at(-1);
            setItems(instance, added.index === server.index ? items : await api.moveServer(instance.id, added.index, server.index));
            pingServer(instance, server); // réenregistre son icône dans servers.dat
          } catch (error) {
            toastError('Serveur non restauré', error);
          }
        },
      },
    ],
  });
}

export function joinServer(server) {
  requestLaunch({ server: server.address });
}
