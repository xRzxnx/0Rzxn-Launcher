// Onglet Mods : contenu installé dans l'instance et découverte sur Modrinth.
import { LOADER_NAMES } from '../data.js';
import { blockIcon, h, icon } from '../dom.js';
import { openPack } from '../perf-actions.js';
import {
  KIND_LABELS,
  deleteItem,
  importDropped,
  importModpack,
  installModpack,
  installProject,
  installedContent,
  openContentFolder,
  projectDetails,
  projectVersions,
  refreshInstalled,
  runSearch,
  searchKey,
  setModsView,
  toggleItem,
  updateItems,
} from '../mods-actions.js';
import { selectedInstance, state, update } from '../state.js';

const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const SORTS = [
  ['relevance', 'Pertinence'],
  ['downloads', 'Téléchargements'],
  ['follows', 'Abonnés'],
  ['updated', 'Mis à jour récemment'],
  ['newest', 'Nouveautés'],
];

function contentIcon(src, size = 44) {
  if (src) return h('img', { class: 'content-icon', src, alt: '', style: `width:${size}px;height:${size}px`, loading: 'lazy' });
  return h('span', { class: 'content-icon content-icon--empty', style: `width:${size}px;height:${size}px`, 'aria-hidden': 'true' }, icon('mods', size / 2));
}

function editInstance(instance) {
  update((s) => {
    s.modal = { type: 'edit-instance', instanceId: instance.id, draft: { name: instance.name, icon: instance.icon, version: instance.version, loader: instance.loader, loaderVersion: instance.loaderVersion } };
  });
}

/** Pourquoi ce type de contenu ne peut pas (encore) être utilisé dans cette instance. */
function blocker(instance, kind) {
  if (kind === 'mods' && instance.loader === 'vanilla') {
    return {
      text: 'Cette instance est vanilla : choisis un loader (Fabric, Quilt, Forge ou NeoForge) pour installer des mods.',
      action: [
        h('button', { class: 'btn btn--primary', onClick: () => editInstance(instance) }, "Modifier l'instance"),
        h('button', { class: 'btn', onClick: () => openPack(instance) }, icon('bolt'), 'Pack Performances'),
      ],
    };
  }
  return null;
}

function shaderHint(instance) {
  if (instance.loader === 'vanilla' || instance.loader === 'forge') {
    return 'Les shaders demandent Iris (Fabric, Quilt ou NeoForge) ou OptiFine, qui n’est pas sur Modrinth.';
  }
  const mods = state.mods.installed[`${instance.id}:mods`];
  if (mods?.items && !mods.items.some((i) => i.slug === 'iris' || i.modId === 'iris')) return 'Installe Iris (onglet Mods) pour utiliser les shaders.';
  return null;
}

// ---------- Installés ----------

function installedView(instance, running) {
  const kind = state.mods.kind;
  const data = installedContent(instance, kind);
  const filter = state.mods.filter.trim().toLowerCase();
  const items = (data?.items ?? []).filter((i) => !filter || `${i.title ?? ''} ${i.name} ${i.file}`.toLowerCase().includes(filter));
  const updates = (data?.items ?? []).filter((i) => i.update);

  const rows = items.map((item) =>
    h(
      'div',
      { class: `content-row${item.enabled ? '' : ' content-row--off'}` },
      contentIcon(item.icon),
      h(
        'div',
        { class: 'content-row__body' },
        h('div', { class: 'content-row__title' }, h('span', null, item.title ?? item.name), item.version && h('span', { class: 'content-row__version' }, item.version)),
        h('div', { class: 'content-row__meta' }, h('span', { class: 'mono' }, item.file), item.description && h('span', { class: 'content-row__desc' }, item.description)),
      ),
      h('span', { class: `tag ${item.projectId ? 'tag--release' : 'tag--beta'}` }, item.projectId ? 'MODRINTH' : item.isFolder ? 'DOSSIER' : 'LOCAL'),
      item.update &&
        h(
          'button',
          { class: 'btn btn--primary', disabled: running || state.mods.busy[item.file], onClick: () => updateItems(instance, [item.file]), title: `Mettre à jour vers ${item.update.number}` },
          icon('download'),
          item.update.number.length > 18 ? 'Mettre à jour' : item.update.number,
        ),
      h('button', {
        class: 'toggle',
        'aria-label': `${item.enabled ? 'Désactiver' : 'Activer'} ${item.title ?? item.name}`,
        'aria-pressed': item.enabled ? 'true' : 'false',
        disabled: running || state.mods.busy[item.file],
        onClick: () => toggleItem(instance, item),
      }),
      h(
        'button',
        { class: 'dialog__close', 'aria-label': `Supprimer ${item.title ?? item.name}`, disabled: running || state.mods.busy[item.file], onClick: () => deleteItem(instance, item) },
        icon('trash'),
      ),
    ),
  );

  let message = null;
  if (!data || (data.loading && !data.items)) message = 'Lecture du dossier…';
  else if (data.error) message = data.error;
  else if (!data.items.length) message = `Aucun ${KIND_LABELS[kind].toLowerCase().replace(/s$/, '')} pour l’instant. Va dans « Découvrir », ou glisse des fichiers ici.`;
  else if (!items.length) message = 'Aucun résultat pour ce filtre.';

  return [
    h(
      'div',
      { class: 'toolbar' },
      h(
        'label',
        { class: 'search' },
        icon('search'),
        h('span', { class: 'visually-hidden' }, 'Filtrer'),
        h('input', { id: 'mods-filter', type: 'search', placeholder: 'Filtrer…', value: state.mods.filter, onInput: (e) => update((s) => { s.mods.filter = e.target.value; }) }),
      ),
      updates.length > 0 &&
        h('button', { class: 'btn btn--primary btn--lg', disabled: running || state.mods.busy['*update-all*'], onClick: () => updateItems(instance) }, icon('download'), `Tout mettre à jour (${updates.length})`),
      kind === 'mods' && h('button', { class: 'btn btn--lg', disabled: running, onClick: () => openPack(instance) }, icon('bolt'), 'Pack Performances'),
      h('button', { class: 'btn btn--lg', onClick: () => refreshInstalled(instance), 'aria-label': 'Actualiser' }, icon('refresh')),
      h('button', { class: 'btn btn--lg', onClick: () => openContentFolder(instance) }, icon('folder'), 'Dossier'),
    ),
    data && !data.online && data.items?.length > 0 && h('p', { class: 'hint', style: 'margin:10px 0 0' }, 'Modrinth injoignable : mises à jour indisponibles, informations locales affichées.'),
    h(
      'div',
      { class: 'content-list', 'data-scroll-key': `installed-${kind}` },
      message ? h('p', { class: 'vtable__empty' }, message) : rows,
      !running && h('p', { class: 'drop-hint' }, icon('upload', 16), `Glisse des fichiers ${kind === 'mods' ? '.jar' : '.zip'} dans la fenêtre pour les ajouter.`),
    ),
  ];
}

// ---------- Découvrir ----------

function discoverView(instance, running) {
  const modpacks = state.mods.kind === 'modpacks';
  if (state.mods.search.key !== searchKey(instance) && !state.mods.search.loading) runSearch(instance);
  const search = state.mods.search;
  const installedIds = modpacks
    ? new Set(state.instances.map((i) => i.modpack?.projectId).filter(Boolean))
    : new Set((state.mods.installed[`${instance.id}:${state.mods.kind}`]?.items ?? []).map((i) => i.projectId).filter(Boolean));
  const install = (hit) => (modpacks ? installModpack(hit) : installProject(instance, hit.id, null, hit.title));

  const rows = search.hits.map((hit) =>
    h(
      'div',
      { class: 'content-row content-row--hit', 'aria-selected': hit.id === state.mods.selected ? 'true' : 'false', onClick: () => update((s) => { s.mods.selected = hit.id; }) },
      contentIcon(hit.icon),
      h(
        'div',
        { class: 'content-row__body' },
        h('div', { class: 'content-row__title' }, h('span', null, hit.title), h('span', { class: 'content-row__version' }, `par ${hit.author}`)),
        h('div', { class: 'content-row__meta' }, h('span', { class: 'content-row__desc' }, hit.description)),
        h(
          'div',
          { class: 'content-row__tags' },
          h('span', null, `${compact.format(hit.downloads)} téléchargements`),
          hit.categories.slice(0, 3).map((c) => h('span', { class: 'tag tag--beta' }, c.toUpperCase())),
        ),
      ),
      installedIds.has(hit.id) && !modpacks
        ? h('span', { class: 'tag tag--ok' }, 'INSTALLÉ')
        : h(
            'button',
            {
              class: 'btn btn--primary',
              disabled: running || state.mods.busy[hit.id] || Boolean(state.task),
              onClick: (e) => {
                e.stopPropagation();
                install(hit);
              },
            },
            icon('download'),
            state.mods.busy[hit.id] ? 'Installation…' : modpacks && installedIds.has(hit.id) ? 'Réinstaller' : 'Installer',
          ),
    ),
  );

  return [
    h(
      'div',
      { class: 'toolbar' },
      h(
        'label',
        { class: 'search' },
        icon('search'),
        h('span', { class: 'visually-hidden' }, 'Rechercher sur Modrinth'),
        h('input', {
          id: 'mods-query',
          type: 'search',
          placeholder: modpacks ? 'Rechercher un modpack sur Modrinth' : `Rechercher sur Modrinth (${instance.version}${state.mods.kind === 'mods' ? ` · ${LOADER_NAMES[instance.loader]}` : ''})`,
          value: state.mods.query,
          onInput: (e) => {
            state.mods.query = e.target.value;
            runSearch(instance, { delay: 300 });
            update();
          },
        }),
      ),
      h('label', { class: 'visually-hidden', for: 'mods-sort' }, 'Trier par'),
      h(
        'select',
        { id: 'mods-sort', class: 'select', style: 'width:220px;height:44px', onChange: (e) => setModsView({ sort: e.target.value }) },
        SORTS.map(([value, label]) => h('option', { value, selected: state.mods.sort === value }, label)),
      ),
      modpacks && h('button', { class: 'btn btn--lg', disabled: Boolean(state.task), onClick: importModpack }, icon('upload'), 'Importer un .mrpack…'),
    ),
    h('p', { class: 'page__meta', style: 'margin:12px 0 0' }, search.loading && !search.hits.length ? 'RECHERCHE…' : `${compact.format(search.total)} RÉSULTATS · MODRINTH`),
    h(
      'div',
      { class: 'content-list', 'data-scroll-key': `discover-${state.mods.kind}` },
      search.error && h('p', { class: 'vtable__empty' }, search.error),
      !search.error && !search.loading && !search.hits.length && h('p', { class: 'vtable__empty' }, modpacks ? 'Aucun modpack trouvé.' : 'Aucun résultat compatible avec cette instance.'),
      rows,
      search.hits.length < search.total &&
        h('button', { class: 'btn btn--lg', style: 'margin:12px auto', disabled: search.loading, onClick: () => runSearch(instance, { more: true }) }, search.loading ? 'Chargement…' : 'Plus de résultats'),
    ),
  ];
}

function detailPanel(instance, running) {
  const hit = state.mods.search.hits.find((x) => x.id === state.mods.selected);
  if (!hit) return null;
  const project = projectDetails(hit.id);
  const versions = projectVersions(hit.id, instance);
  const modpacks = state.mods.kind === 'modpacks';
  const installed = modpacks ? null : (state.mods.installed[`${instance.id}:${state.mods.kind}`]?.items ?? []).find((i) => i.projectId === hit.id);
  const selectId = `version-${hit.id}`;
  const typeLabel = { release: '', beta: ' · bêta', alpha: ' · alpha' };

  return h(
    'aside',
    { class: 'detail mod-detail', 'aria-label': `Détails de ${hit.title}`, 'data-scroll-key': 'mod-detail' },
    h('div', { style: 'display:flex;gap:14px;align-items:center' }, contentIcon(hit.icon, 64), h('div', null, h('h2', { class: 'mod-detail__title' }, hit.title), h('p', { class: 'hint' }, `par ${hit.author}`))),
    h('p', { class: 'mod-detail__desc' }, project?.description ?? hit.description),
    h(
      'dl',
      { class: 'detail__list' },
      h('dt', null, 'Téléchargements'),
      h('dd', null, compact.format(hit.downloads)),
      h('dt', null, 'Abonnés'),
      h('dd', null, compact.format(hit.follows)),
      project?.license && [h('dt', null, 'Licence'), h('dd', null, project.license)],
      installed && [h('dt', null, 'Installé'), h('dd', { class: 'mono' }, installed.version ?? installed.file)],
    ),
    project?.gallery?.[0] && h('img', { class: 'mod-detail__shot', src: project.gallery[0].url, alt: project.gallery[0].title ?? '' }),
    h('div', { class: 'detail__spacer' }),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: selectId }, 'Version'),
      versions === null
        ? h('p', { class: 'hint' }, 'Chargement des versions…')
        : versions.length === 0
          ? h('p', { class: 'hint hint--warn' }, modpacks ? 'Aucune version téléchargeable.' : `Aucune version pour ${instance.version}${state.mods.kind === 'mods' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}.`)
          : h(
              'select',
              { id: selectId, class: 'select' },
              versions.slice(0, 40).map((v, i) => {
                // Contenu : la dernière version stable. Modpack : la plus récente (comme le bouton Installer de la liste).
                const preferred = modpacks ? 0 : Math.max(0, versions.findIndex((x) => x.type === 'release'));
                return h('option', { value: v.id, selected: i === preferred }, `${v.number}${typeLabel[v.type] ?? ''}${modpacks ? ` · Minecraft ${v.gameVersions.at(-1)}` : ''}`);
              }),
            ),
    ),
    h(
      'button',
      {
        class: 'btn btn--primary btn--lg',
        disabled: running || !versions?.length || state.mods.busy[hit.id] || Boolean(state.task),
        onClick: () => {
          const versionId = document.getElementById(selectId)?.value ?? null;
          if (modpacks) installModpack(hit, versionId);
          else installProject(instance, hit.id, versionId, hit.title);
        },
      },
      icon('download'),
      state.mods.busy[hit.id] ? 'Installation…' : modpacks ? 'Créer une instance' : installed ? 'Installer cette version' : 'Installer',
    ),
    h('a', { class: 'btn btn--lg', href: `https://modrinth.com/${hit.projectType}/${hit.slug}`, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Voir sur Modrinth'),
  );
}

// ---------- Page ----------

export function renderMods() {
  const instance = selectedInstance();
  const { kind } = state.mods;
  const modpacks = kind === 'modpacks';
  const tab = modpacks ? 'discover' : state.mods.tab;
  const running = Boolean(instance) && !modpacks && state.run?.instanceId === instance.id;
  const block = modpacks
    ? null
    : !instance
      ? { text: 'Crée une instance pour y ajouter du contenu, ou installe un modpack.', action: h('button', { class: 'btn btn--primary', onClick: () => setModsView({ kind: 'modpacks' }) }, 'Voir les modpacks') }
      : blocker(instance, kind);
  const installed = instance && !modpacks ? state.mods.installed[`${instance.id}:${kind}`] : null;
  const hint = kind === 'shaders' && instance ? shaderHint(instance) : null;
  if (kind === 'shaders' && instance) installedContent(instance, 'mods'); // pour savoir si Iris est là

  const drop = (e) => {
    e.preventDefault();
    if (!running && !block && !modpacks && e.dataTransfer?.files?.length) importDropped(instance, e.dataTransfer.files);
  };

  return h(
    'div',
    { class: 'mods-page', onDragover: (e) => e.preventDefault(), onDrop: drop },
    h(
      'div',
      { class: 'mods-main' },
      h(
        'div',
        { class: 'page__head' },
        h('h1', { class: 'page__title' }, 'Mods'),
        instance &&
          !modpacks &&
          h(
          'span',
          { class: 'mods-instance' },
          blockIcon(instance.icon, 'block--sm'),
          `${instance.name} · ${instance.version}${instance.loader !== 'vanilla' ? ` · ${LOADER_NAMES[instance.loader]}` : ''}`,
        ),
        h('span', { class: 'page__spacer' }),
        h(
          'div',
          { class: 'segmented', role: 'tablist', 'aria-label': 'Type de contenu' },
          Object.entries(KIND_LABELS).map(([value, label]) =>
            h('button', { role: 'tab', 'aria-selected': kind === value ? 'true' : 'false', onClick: () => setModsView({ kind: value }) }, label),
          ),
        ),
      ),
      !modpacks &&
      h(
        'div',
        { class: 'mods-tabs', role: 'tablist', 'aria-label': 'Vue' },
        h('button', { class: 'chip', 'aria-pressed': tab === 'installed' ? 'true' : 'false', onClick: () => setModsView({ tab: 'installed' }) }, 'Installés', h('span', { class: 'chip__count' }, installed?.items?.length ?? '…')),
        h('button', { class: 'chip', 'aria-pressed': tab === 'discover' ? 'true' : 'false', disabled: Boolean(block), onClick: () => setModsView({ tab: 'discover' }) }, 'Découvrir'),
      ),
      running && h('p', { class: 'offline-banner', style: 'margin:14px 0 0' }, icon('lock'), h('span', null, 'Le jeu est lancé : ferme-le pour modifier le contenu de cette instance.')),
      hint && h('p', { class: 'notice', style: 'margin:14px 0 0' }, icon('info'), hint),
      modpacks && h('p', { class: 'notice', style: 'margin:14px 0 0' }, icon('info'), 'Un modpack crée une nouvelle instance avec la bonne version de Minecraft, son loader et tous ses mods.'),
      block
        ? h('div', { class: 'empty', style: 'height:auto;padding:60px 20px' }, h('p', { class: 'empty__text' }, block.text), block.action)
        : tab === 'installed'
          ? installedView(instance, running)
          : discoverView(instance, running),
    ),
    !block && tab === 'discover' && detailPanel(instance, running),
  );
}
