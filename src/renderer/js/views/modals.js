// Fenêtres modales (nouvelle instance, comptes, RAM faible), écran de bienvenue et notifications.
import { importInstance, importWorld, openImport, pickImportFolder, setImportTarget, showImportTab } from '../import-actions.js';
import { exportInstance } from '../mods-actions.js';
import { saveServer } from '../servers-actions.js';
import { deleteWorld, runRestore } from '../worlds-actions.js';
import { shareCrash } from '../crash-actions.js';
import { screenshotViewer } from './screenshots.js';
import { cleanDialog, removeRuntimeDialog, shortcutsDialog, stopGameDialog } from './launcher-settings.js';
import { addMicrosoftAccount, addOfflineAccount, createInstance, deleteInstance, disableLowRamWarning, editInstance, loaderOptions, removeAccount, setActiveAccount, startLaunch, versionDetails } from '../actions.js';
import { bannerUrl } from '../banner.js';
import { LOADER_NAMES, LOADERS, loaderLabel, VERSION_TYPES } from '../data.js';
import { blockIcon, formatGo, formatPlaytime, h, icon, slugify } from '../dom.js';
import { openSkins } from '../skins-actions.js';
import { skinHead } from '../skin-view.js';
import { dismissToast, state, update } from '../state.js';
import { gpuConfirmDialog, packDialog } from './performance.js';
import { skinsDialog } from './skins.js';

const BLOCKS = [
  ['grass', 'Herbe'], ['diamond', 'Diamant'], ['stone', 'Pierre'],
  ['netherrack', 'Netherrack'], ['sand', 'Sable'], ['end', 'End'],
];


export function close() {
  update((s) => {
    s.modal = null;
  });
}

export function dialog({ title, size = '', body, foot, labelId }) {
  return h(
    'div',
    { class: 'overlay', onClick: (e) => e.target === e.currentTarget && close() },
    h(
      'section',
      { class: `dialog ${size}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId },
      h(
        'div',
        { class: 'dialog__head' },
        h('h1', { class: 'dialog__title', id: labelId }, title),
        h('button', { class: 'dialog__close', 'aria-label': 'Fermer', onClick: close }, icon('close')),
      ),
      h('div', { class: 'dialog__body' }, body),
      foot && h('div', { class: 'dialog__foot' }, foot),
    ),
  );
}

/** Compte de l'instance : le compte actif du launcher, ou toujours le même. Inutile avec un seul compte. */
function accountField(draft) {
  if (state.accounts.length < 2) return null;
  const selected = state.accounts.some((a) => a.id === draft.accountId) ? draft.accountId : null;
  const active = state.accounts.find((a) => a.id === state.activeAccountId);
  const choice = (id, name, sub, head) =>
    h(
      'label',
      { class: `account-choice${selected === id ? ' account-choice--on' : ''}` },
      h('input', { type: 'radio', name: 'instance-account', checked: selected === id, onChange: () => update(() => { draft.accountId = id; }) }),
      head,
      h('span', { class: 'account-choice__body' }, h('span', { class: 'account-choice__name' }, name), h('span', { class: 'hint' }, sub)),
    );
  return h(
    'fieldset',
    { class: 'field account-field' },
    h('legend', { class: 'label' }, 'Compte de cette instance'),
    choice(null, 'Compte actif du launcher', active ? `Aujourd’hui : ${active.name}` : 'Aucun pour le moment'),
    state.accounts.map((a) => choice(a.id, a.name, a.type === 'microsoft' ? 'Compte Microsoft' : 'Hors-ligne', skinHead(a, 32))),
  );
}

/** Versions proposées : toutes les releases, plus la version demandée si c'est un snapshot. */
function versionChoices(current) {
  const choices = state.versions.list.filter((v) => v.type === 'release');
  const extra = state.versions.list.find((v) => v.id === current && v.type !== 'release');
  return extra ? [extra, ...choices] : choices;
}

/** Choix du loader (selon la version de Minecraft choisie) et de sa version. */
function loaderField(draft) {
  const options = loaderOptions(draft.version);
  const failed = state.loaders[draft.version]?.error;
  const versionsOf = (loader) => options?.[loader]?.versions ?? [];

  // La version de Minecraft a changé : le choix précédent n'est peut-être plus valable.
  if (options && draft.loader !== 'vanilla') {
    if (versionsOf(draft.loader).length === 0) {
      draft.loader = 'vanilla';
      draft.loaderVersion = null;
    } else if (!versionsOf(draft.loader).some((v) => v.id === draft.loaderVersion)) {
      draft.loaderVersion = options[draft.loader].recommended;
    }
  }

  const pick = (loader) =>
    update(() => {
      draft.loader = loader;
      draft.loaderVersion = loader === 'vanilla' ? null : options?.[loader]?.recommended ?? null;
    });

  const recommended = options?.[draft.loader]?.recommended;
  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'label', id: 'loader-label' }, 'Loader de mods'),
    h(
      'div',
      { class: 'loaders', role: 'radiogroup', 'aria-labelledby': 'loader-label' },
      LOADERS.map((loader) => {
        const count = versionsOf(loader).length;
        const available = loader === 'vanilla' || count > 0;
        let note = null;
        if (loader !== 'vanilla') note = !options ? (failed ? 'ERREUR' : 'CHARGEMENT…') : count ? `${count} VERSIONS` : 'INDISPONIBLE';
        return h(
          'button',
          { role: 'radio', 'aria-checked': draft.loader === loader ? 'true' : 'false', disabled: !available, onClick: () => pick(loader) },
          LOADER_NAMES[loader],
          note && h('small', null, note),
        );
      }),
    ),
    draft.loader !== 'vanilla' &&
      h(
        'div',
        { class: 'field', style: 'margin-top:6px' },
        h('label', { class: 'label', for: 'loader-version' }, `Version de ${LOADER_NAMES[draft.loader]}`),
        h(
          'select',
          { id: 'loader-version', class: 'select', onChange: (e) => update(() => { draft.loaderVersion = e.target.value; }) },
          versionsOf(draft.loader).map((v) =>
            h(
              'option',
              { value: v.id, selected: v.id === draft.loaderVersion },
              `${v.label ?? v.id}${v.id === recommended ? ' · recommandée' : ''}${v.stable ? '' : ' · bêta'}`,
            ),
          ),
        ),
        h(
          'p',
          { class: 'hint' },
          draft.loader === 'forge' || draft.loader === 'neoforge'
            ? `L'installeur officiel de ${LOADER_NAMES[draft.loader]} s'exécute au premier lancement (de quelques secondes à une minute).`
            : `${LOADER_NAMES[draft.loader]} s'installe en quelques secondes au premier lancement.`,
        ),
      ),
    failed && h('p', { class: 'hint hint--error' }, `Liste des loaders indisponible : ${failed}`),
  );
}

/** Fenêtre « Nouvelle instance », ou « Modifier l'instance » si modal.instanceId est présent. */
/** Groupe de la barre latérale : texte libre, avec les groupes existants proposés. */
function groupField(draft) {
  const groups = [...new Set(state.instances.map((i) => i.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'label', for: 'instance-group' }, 'Groupe'),
    h('input', {
      id: 'instance-group',
      class: 'input',
      type: 'text',
      maxlength: 30,
      list: 'instance-groups',
      placeholder: groups[0] ? `Aucun · ex. ${groups[0]}` : 'Aucun · ex. Moddées, Vanilla, PvP',
      value: draft.group ?? '',
      onInput: (e) => { draft.group = e.target.value; },
    }),
    h('datalist', { id: 'instance-groups' }, groups.map((g) => h('option', { value: g }))),
    h('p', { class: 'hint' }, 'Les instances d’un même groupe sont rangées ensemble dans la barre latérale.'),
  );
}

function instanceDialog(modal) {
  const draft = modal.draft;
  const editing = Boolean(modal.instanceId);
  const original = editing ? state.instances.find((i) => i.id === modal.instanceId) : null;
  if (editing && !original) return null;
  const preview = h('strong', null, slugify(draft.name || 'nouvelle-instance'));
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const details = versionDetails(draft.version);
  const versionChanged = editing && draft.version !== original.version;

  const submit = async () => {
    if (!draft.name.trim()) {
      error.textContent = 'Donne un nom à ton instance.';
      document.getElementById('instance-name')?.focus();
      return;
    }
    if (draft.loader !== 'vanilla' && !draft.loaderVersion) {
      error.textContent = `Choisis une version de ${LOADER_NAMES[draft.loader]}.`;
      return;
    }
    if (modal.busy) return;
    modal.busy = true;
    try {
      const data = { name: draft.name.trim(), icon: draft.icon, version: draft.version, loader: draft.loader, loaderVersion: draft.loaderVersion, group: draft.group ?? '', accountId: draft.accountId ?? null };
      if (editing) await editInstance(original.id, data);
      else await createInstance(data);
    } catch (e) {
      modal.busy = false;
      error.textContent = e.message;
    }
  };

  return dialog({
    title: editing ? "Modifier l'instance" : 'Nouvelle instance',
    size: 'dialog--wide',
    labelId: 'new-instance-title',
    body: [
      h(
        'div',
        { style: 'display:flex;gap:20px;align-items:flex-end' },
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'label', id: 'icon-label' }, 'Icône'),
          h(
            'div',
            { class: 'icon-grid', role: 'radiogroup', 'aria-labelledby': 'icon-label' },
            BLOCKS.map(([kind, label]) =>
              h(
                'button',
                { role: 'radio', 'aria-label': label, 'aria-checked': draft.icon === kind ? 'true' : 'false', onClick: () => update(() => { draft.icon = kind; }) },
                blockIcon(kind, 'block--md'),
              ),
            ),
          ),
        ),
        h(
          'div',
          { class: 'field', style: 'flex:1' },
          h('label', { class: 'label', for: 'instance-name' }, 'Nom'),
          h('input', {
            id: 'instance-name',
            class: 'input input--pixel',
            type: 'text',
            maxlength: 40,
            placeholder: 'Survie',
            value: draft.name,
            onInput: (e) => {
              draft.name = e.target.value;
              preview.textContent = slugify(draft.name || 'nouvelle-instance');
              error.textContent = '';
            },
            onKeydown: (e) => e.key === 'Enter' && submit(),
          }),
        ),
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'label', for: 'instance-version' }, 'Version de Minecraft'),
        h(
          'select',
          { id: 'instance-version', class: 'select', onChange: (e) => update(() => { draft.version = e.target.value; }) },
          versionChoices(draft.version).map((v) =>
            h('option', { value: v.id, selected: v.id === draft.version }, `${v.id} · ${VERSION_TYPES[v.type] ?? v.type}${v.installed ? ' · installée' : ''}`),
          ),
        ),
        h('p', { class: 'hint' }, details ? `Java ${details.java} sera téléchargé automatiquement si besoin.` : 'Le bon Java sera téléchargé automatiquement si besoin.'),
        versionChanged &&
          h(
            'p',
            { class: 'hint hint--warn' },
            `Attention : un monde ouvert en ${original.version} peut être abîmé par une version plus ancienne. Duplique l'instance avant si tu as un doute.`,
          ),
      ),
      loaderField(draft),
      groupField(draft),
      accountField(draft),
      h('p', { class: 'path-preview' }, '~\\AppData\\Roaming\\.0rzxn\\instances\\', editing ? h('strong', null, original.id) : preview),
      error,
    ],
    foot: [
      editing
        ? h('span', { class: 'spacer' })
        : h(
            'button',
            { class: 'btn btn--ghost spacer', onClick: () => openImport('instances') },
            'Importer depuis un autre launcher…',
          ),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--primary btn--lg', onClick: submit }, editing ? 'Enregistrer' : 'Créer'),
    ],
  });
}

function deleteDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const confirm = async () => {
    if (modal.busy) return;
    modal.busy = true;
    try {
      await deleteInstance(instance.id);
    } catch (e) {
      modal.busy = false;
      error.textContent = e.message;
    }
  };
  return dialog({
    title: "Supprimer l'instance ?",
    size: 'dialog--small',
    labelId: 'delete-title',
    body: [
      h(
        'p',
        { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' },
        `« ${instance.name} » et tout son dossier (mondes, captures, options) vont dans la corbeille de Windows. Tu pourras les restaurer depuis la corbeille.`,
      ),
      h('p', { class: 'hint' }, 'Les fichiers de Minecraft partagés (versions, Java, assets) restent installés pour tes autres instances.'),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--lg btn--danger', onClick: confirm }, 'Mettre à la corbeille'),
    ],
  });
}

function microsoftButton(style) {
  return h(
    'button',
    { class: 'btn btn--microsoft', style, disabled: state.signingIn, onClick: addMicrosoftAccount },
    icon('microsoft', 18),
    state.signingIn ? 'Connexion en cours…' : 'Se connecter avec Microsoft',
  );
}

function offlineForm(idPrefix) {
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const submit = async () => {
    try {
      await addOfflineAccount(input.value);
    } catch (e) {
      error.textContent = e.message;
      input.focus();
    }
  };
  const input = h('input', {
    id: `${idPrefix}-offline`,
    class: 'input input--pixel',
    type: 'text',
    maxlength: 16,
    placeholder: 'Pseudo',
    spellcheck: 'false',
    'data-keep': true, // la saisie survit aux redessins (voir main.js)
    onInput: () => { error.textContent = ''; },
    onKeydown: (e) => e.key === 'Enter' && submit(),
  });
  return { input, error, button: h('button', { class: 'btn btn--lg', onClick: submit }, idPrefix === 'welcome' ? 'Continuer' : 'Ajouter') };
}

// Un nouveau compte hors-ligne demande d'abord un compte Microsoft qui possède le jeu
// (vérifié aussi dans core/accounts.js). Les comptes hors-ligne déjà créés continuent de marcher.
const hasMicrosoftAccount = () => state.accounts.some((a) => a.type === 'microsoft');
const OFFLINE_LOCKED = "Les comptes hors-ligne se débloquent après la connexion d'un compte Microsoft qui possède Minecraft: Java Edition.";

function offlineLine(account) {
  if (!account.look) return 'Hors-ligne · solo et serveurs hors-ligne';
  return account.look.skin ? 'Hors-ligne · tête du skin public de ce pseudo' : "Hors-ligne · ce pseudo n'a pas de skin public";
}

function accountsDialog() {
  const form = offlineForm('accounts');
  return dialog({
    title: 'Comptes',
    size: 'dialog--accounts',
    labelId: 'accounts-title',
    body: [
      state.accounts.length > 0 &&
        h(
          'ul',
          { class: 'account-list', style: 'padding:0' },
          state.accounts.map((a) => {
            const active = a.id === state.activeAccountId;
            return h(
              'li',
              { class: `account-row${active ? ' account-row--active' : ''}` },
              skinHead(a, 48),
              h(
                'span',
                { class: 'account-row__body' },
                h('span', { class: 'account-row__name' }, a.name),
                h(
                  'span',
                  { class: `account-row__type${a.needsLogin ? ' hint--warn' : ''}` },
                  a.type === 'microsoft' && icon('microsoft', 12),
                  a.type === 'offline' ? offlineLine(a) : a.needsLogin ? 'Session expirée : reconnecte-toi' : 'Compte Microsoft',
                ),
              ),
              a.needsLogin
                ? h('button', { class: 'btn', disabled: state.signingIn, onClick: addMicrosoftAccount }, 'Se reconnecter')
                : active
                  ? h('span', { class: 'tag tag--ok' }, 'ACTIF')
                  : h('button', { class: 'btn', disabled: Boolean(state.run), onClick: () => setActiveAccount(a.id) }, 'Utiliser'),
              h('button', { class: 'btn', onClick: () => openSkins(a.id) }, 'Skin et cape'),
              h(
                'button',
                { class: 'dialog__close', 'aria-label': `Retirer le compte ${a.name}`, disabled: Boolean(state.run) && active, onClick: () => removeAccount(a.id) },
                icon('trash'),
              ),
            );
          }),
        ),
      h('h2', { class: 'label', style: 'margin:4px 0 0' }, 'Ajouter un compte'),
      microsoftButton(),
      hasMicrosoftAccount()
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: 'accounts-offline', style: 'font-size:13px;font-weight:600' }, 'Compte hors-ligne'),
            h('div', { class: 'input-row' }, form.input, form.button),
            form.error,
            h('p', { class: 'hint' }, '3 à 16 caractères : lettres, chiffres et _.'),
          )
        : h(
            'div',
            { class: 'field' },
            h('span', { style: 'font-size:13px;font-weight:600' }, 'Compte hors-ligne'),
            h('p', { class: 'hint' }, OFFLINE_LOCKED),
          ),
      h('p', { class: 'trust', style: 'margin:0' }, icon('lock'), 'Ton mot de passe reste chez Microsoft. Le launcher garde seulement un jeton chiffré par Windows.'),
    ],
  });
}

function lowRamDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  return dialog({
    title: 'Mémoire libre insuffisante',
    size: 'dialog--small',
    labelId: 'lowram-title',
    body: [
      h(
        'p',
        { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' },
        `${instance.name} demande ${formatGo(instance.settings.ram)}, mais il ne reste que ${formatGo(state.memory.freeGb.toFixed(1))} libres sur ${formatGo(Math.round(state.memory.totalGb))}. Ferme d'autres programmes ou baisse la RAM de l'instance.`,
      ),
    ],
    foot: [
      h('button', { class: 'btn btn--ghost spacer', onClick: () => disableLowRamWarning(instance.id) }, 'Ne plus avertir'),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--primary btn--lg', onClick: () => startLaunch(instance.id, modal.options) }, 'Lancer quand même'),
    ],
  });
}

export function renderModal() {
  const modal = state.modal;
  if (!modal) return null;
  if (modal.type === 'new-instance' || modal.type === 'edit-instance') return instanceDialog(modal);
  if (modal.type === 'delete-instance') return deleteDialog(modal);
  if (modal.type === 'accounts') return accountsDialog();
  if (modal.type === 'skins') return skinsDialog(modal);
  if (modal.type === 'low-ram') return lowRamDialog(modal);
  if (modal.type === 'export') return exportDialog(modal);
  if (modal.type === 'server') return serverDialog(modal);
  if (modal.type === 'import') return importDialog(modal);
  if (modal.type === 'restore-world') return restoreDialog(modal);
  if (modal.type === 'delete-world') return deleteWorldDialog(modal);
  if (modal.type === 'share-crash') return shareDialog(modal);
  if (modal.type === 'screenshot') return screenshotViewer(modal);
  if (modal.type === 'shortcuts') return shortcutsDialog();
  if (modal.type === 'stop-game') return stopGameDialog();
  if (modal.type === 'remove-runtime') return removeRuntimeDialog(modal);
  if (modal.type === 'clean-storage') return cleanDialog(modal);
  if (modal.type === 'perf-pack') return packDialog(modal);
  if (modal.type === 'gpu-confirm') return gpuConfirmDialog(modal);
  return null;
}

/** Un monde du même nom existe déjà : restaurer à côté, ou remplacer (l'actuel part à la corbeille). */
function restoreDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  return dialog({
    title: 'Ce monde existe déjà',
    size: 'dialog--small',
    labelId: 'restore-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, `« ${modal.folder} » est déjà dans ${instance.name}. Que veux-tu faire de la sauvegarde ?`),
      h('p', { class: 'hint' }, 'À côté : la sauvegarde devient un nouveau monde, l’actuel ne bouge pas. Remplacer : l’actuel part dans la corbeille de Windows.'),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--lg', onClick: () => runRestore(instance, modal.source, 'replace') }, 'Remplacer'),
      h('button', { class: 'btn btn--lg btn--primary', onClick: () => runRestore(instance, modal.source, 'beside') }, 'Restaurer à côté'),
    ],
  });
}

function deleteWorldDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const confirm = async () => {
    if (modal.busy) return;
    modal.busy = true;
    try {
      await deleteWorld(instance, modal.folder, modal.name);
    } catch (e) {
      modal.busy = false;
      error.textContent = e.message;
    }
  };
  return dialog({
    title: 'Supprimer ce monde ?',
    size: 'dialog--small',
    labelId: 'delete-world-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, `« ${modal.name} » (saves\\${modal.folder}) va dans la corbeille de Windows. Tu pourras le restaurer depuis la corbeille.`),
      h('p', { class: 'hint' }, 'Ses sauvegardes .zip sont gardées.'),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--lg btn--danger', onClick: confirm }, 'Mettre à la corbeille'),
    ],
  });
}

/** Le rapport devient public sur mclo.gs : on le dit avant l'envoi. */
function shareDialog(modal) {
  return dialog({
    title: 'Partager le rapport ?',
    size: 'dialog--small',
    labelId: 'share-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, `${modal.item.file} sera envoyé sur mclo.gs, un site de partage de logs Minecraft. Toute personne qui a le lien pourra le lire.`),
      h('p', { class: 'hint' }, 'Avant l’envoi, le launcher masque les jetons de connexion et ton nom de session Windows ; mclo.gs masque aussi les adresses IP. Le lien est copié automatiquement.'),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--lg btn--primary', onClick: () => shareCrash(modal.item) }, icon('external'), 'Envoyer sur mclo.gs'),
    ],
  });
}

function exportDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const draft = modal.draft;
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const field = (id, label, key, placeholder) =>
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: id }, label),
      h('input', { id, class: 'input', type: 'text', maxlength: 80, placeholder, value: draft[key], onInput: (e) => { draft[key] = e.target.value; } }),
    );
  const submit = async () => {
    if (modal.busy) return;
    modal.busy = true;
    try {
      if (await exportInstance(instance, draft)) close();
    } catch (e) {
      error.textContent = e.message;
    } finally {
      modal.busy = false;
    }
  };
  return dialog({
    title: 'Exporter en modpack',
    labelId: 'export-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, `Crée un fichier .mrpack de « ${instance.name} » à partager ou à importer dans un autre launcher qui lit les fichiers .mrpack.`),
      field('export-name', 'Nom du modpack', 'name', instance.name),
      field('export-version', 'Version', 'version', '1.0.0'),
      field('export-summary', 'Description (facultatif)', 'summary', 'Mon pack de survie'),
      h(
        'p',
        { class: 'hint' },
        'Les mods, packs et shaders venant de Modrinth sont simplement référencés (le fichier reste léger). Les autres fichiers et le dossier config sont inclus. Les mondes, options et captures ne sont pas exportés.',
      ),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--primary btn--lg', onClick: submit }, icon('upload'), 'Exporter…'),
    ],
  });
}

export function renderWelcome() {
  if (!state.ready || state.accounts.length) return null;
  // Sans aucun compte, il n'y a pas encore de compte Microsoft : le hors-ligne n'est pas proposé ici.
  return h(
    'div',
    { class: 'welcome' },
    h('img', { class: 'welcome__art', src: bannerUrl(9, 1600, 900), alt: '' }),
    h(
      'section',
      { class: 'welcome__panel', 'aria-labelledby': 'welcome-title' },
      h('span', { class: 'logo logo--lg', 'aria-hidden': 'true' }),
      h('div', null, h('h1', { class: 'welcome__title', id: 'welcome-title' }, 'Bienvenue'), h('p', { class: 'welcome__text' }, 'Connecte ton compte Microsoft pour créer ta première instance et jouer.')),
      microsoftButton('height:56px;font-size:18px'),
      h('p', { class: 'hint' }, OFFLINE_LOCKED),
      h('p', { class: 'trust' }, icon('lock'), 'La connexion se fait sur la page officielle de Microsoft. Le launcher ne voit jamais ton mot de passe.'),
    ),
  );
}

/** Carte de progression d'une tâche longue (installation ou mise à jour d'un modpack). */
function taskCard(task) {
  const percent = task.total ? Math.round((task.done / task.total) * 100) : null;
  return h(
    'div',
    { class: 'toast toast--info', role: 'status' },
    h('span', { class: 'toast__icon' }, icon('download')),
    h(
      'span',
      { class: 'toast__body' },
      h('span', { class: 'toast__title' }, task.label),
      h('span', { class: 'toast__text' }, task.total ? `${task.done} / ${task.total} fichiers` : 'Préparation…'),
      h('span', { class: 'progress', style: 'margin-top:6px;height:10px' }, h('span', { class: 'progress__fill', style: `display:block;width:${percent ?? 5}%` })),
    ),
  );
}

export function renderToasts() {
  const toasts = state.toasts.map((t) =>
    h(
      'div',
      { class: `toast toast--${t.kind}`, role: t.kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast__icon' }, icon(t.kind === 'success' ? 'check' : t.kind === 'error' ? 'alert' : 'info')),
      h(
        'span',
        { class: 'toast__body' },
        h('span', { class: 'toast__title' }, t.title),
        t.text && h('span', { class: 'toast__text' }, t.text),
        t.actions.length > 0 &&
          h(
            'span',
            { class: 'toast__actions' },
            t.actions.map((a) => h('button', { class: 'btn', onClick: () => { dismissToast(t.id); a.run(); } }, a.label)),
          ),
      ),
      h('button', { class: 'dialog__close', style: 'width:28px;height:28px', 'aria-label': 'Fermer la notification', onClick: () => dismissToast(t.id) }, icon('close')),
    ),
  );
  return state.task ? [taskCard(state.task), ...toasts] : toasts;
}

const GAME_TYPES = ['Survie', 'Créatif', 'Aventure', 'Spectateur'];

/** Le monde a été ouvert dans une version plus récente que l'instance (la liste des versions va de la plus récente à la plus ancienne). */
function worldIsNewer(world, instance) {
  const order = (id) => state.versions.list.findIndex((v) => v.id === id);
  const w = order(world.version);
  const i = order(instance?.version);
  return w >= 0 && i >= 0 && w < i;
}

function importRows(items, row) {
  return h('ul', { class: 'import-list' }, items.map(row));
}

function importStatus(result, emptyTitle, emptyText) {
  if (!result) return h('p', { class: 'hint', role: 'status' }, 'Recherche…');
  if (result.error) return h('p', { class: 'hint hint--error', role: 'alert' }, result.error);
  return h('div', { class: 'import-empty' }, h('p', { class: 'import-empty__title' }, emptyTitle), h('p', { class: 'hint' }, emptyText));
}

function importInstancesTab(modal) {
  const result = modal.instances;
  const items = result?.instances ?? [];
  return [
    h(
      'div',
      { class: 'import-source' },
      h('span', { class: 'hint' }, result?.dir ? [`${result.launcher ?? 'Dossier'} · `, h('span', { class: 'import-source__path' }, result.dir)] : 'Dossier par défaut'),
      h('button', { class: 'btn', onClick: () => pickImportFolder('instances') }, icon('folder'), 'Autre dossier…'),
    ),
    items.length
      ? importRows(items, (item) =>
          h(
            'li',
            { class: 'import-row' },
            blockIcon(item.icon, 'block--md'),
            h(
              'span',
              { class: 'import-row__body' },
              h('span', { class: 'import-row__name' }, item.name, item.imported && h('span', { class: 'tag tag--ok' }, 'DÉJÀ IMPORTÉE')),
              h(
                'span',
                { class: 'import-row__meta' },
                [
                  item.version && `Minecraft ${item.version}`,
                  item.loader !== 'vanilla' && loaderLabel(item),
                  item.playtime ? formatPlaytime(item.playtime) : 'jamais lancée',
                  item.group && `groupe ${item.group}`,
                ].filter(Boolean).join(' · '),
              ),
              item.problem && h('span', { class: 'import-row__meta hint--error' }, item.problem),
              item.warnings.map((w) => h('span', { class: 'import-row__meta hint--warn' }, w)),
            ),
            h(
              'button',
              { class: item.imported ? 'btn' : 'btn btn--primary', disabled: !item.supported || Boolean(state.task), onClick: () => importInstance(item) },
              icon('download'),
              item.imported ? 'Réimporter' : 'Importer',
            ),
          ),
        )
      : importStatus(result, 'Aucune instance trouvée', "Choisis le dossier « instances » d'un autre launcher (il contient un dossier par instance, chacun avec un fichier instance.cfg), ou directement le dossier d'une instance."),
    h(
      'p',
      { class: 'hint' },
      "Le dossier du jeu est copié en entier (mods, mondes, options, captures) avec le loader, les réglages propres à l'instance et le temps de jeu. L'original n'est jamais modifié. Ferme le jeu dans l'autre launcher avant d'importer.",
    ),
  ];
}

function importWorldsTab(modal) {
  const result = modal.worlds;
  const items = result?.worlds ?? [];
  const target = state.instances.find((i) => i.id === modal.targetId);
  const several = (result?.dirs?.length ?? 0) > 1;
  return [
    h(
      'div',
      { class: 'import-source' },
      h('span', { class: 'hint' }, result?.dirs?.length ? h('span', { class: 'import-source__path' }, result.dirs[0]) : '.minecraft', several && ` et ${result.dirs.length - 1} autre${result.dirs.length > 2 ? 's' : ''}`),
      h('button', { class: 'btn', onClick: () => pickImportFolder('worlds') }, icon('folder'), 'Autre dossier…'),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: 'import-target' }, "Copier dans l'instance"),
      state.instances.length
        ? h(
            'select',
            { id: 'import-target', class: 'select', onChange: (e) => setImportTarget(e.target.value) },
            state.instances.map((i) => h('option', { value: i.id, selected: i.id === modal.targetId }, `${i.name} · ${i.version}${i.loader !== 'vanilla' ? ` · ${LOADER_NAMES[i.loader]}` : ''}`)),
          )
        : h('p', { class: 'hint hint--warn' }, "Crée d'abord une instance pour y copier tes mondes."),
    ),
    items.length
      ? importRows(items, (world) => {
          const copiedTo = modal.copied[world.path];
          return h(
            'li',
            { class: 'import-row' },
            world.icon ? h('img', { class: 'import-row__icon', src: world.icon, alt: '' }) : blockIcon('grass', 'block--md'),
            h(
              'span',
              { class: 'import-row__body' },
              h('span', { class: 'import-row__name' }, world.name, world.hardcore && h('span', { class: 'tag tag--bad' }, 'HARDCORE')),
              h(
                'span',
                { class: 'import-row__meta' },
                [
                  world.version,
                  !world.hardcore && GAME_TYPES[world.gameType],
                  world.lastPlayed && `joué le ${new Date(world.lastPlayed).toLocaleDateString('fr-FR')}`,
                  several && world.source,
                ].filter(Boolean).join(' · '),
              ),
              target && worldIsNewer(world, target) &&
                h('span', { class: 'import-row__meta hint--warn' }, `Ouvert en ${world.version} : « ${target.name} » (${target.version}) est plus ancienne et peut l'abîmer.`),
              copiedTo && h('span', { class: 'import-row__meta hint--ok' }, `Copié dans « ${copiedTo} »`),
            ),
            h('button', { class: 'btn btn--primary', disabled: !target || Boolean(state.task), onClick: () => importWorld(world) }, icon('copy'), 'Copier'),
          );
        })
      : importStatus(result, 'Aucun monde trouvé', "Choisis un dossier .minecraft, un dossier saves ou le dossier d'un monde (par exemple celui d'une instance d'un autre launcher)."),
    h('p', { class: 'hint' }, "Le monde est copié dans le dossier saves de l'instance ; l'original reste intact. Si un monde porte déjà ce nom, la copie est renommée."),
  ];
}

function importDialog(modal) {
  const tabs = [
    ['instances', "Instances d'autres launchers"],
    ['worlds', 'Mondes'],
  ];
  return dialog({
    title: 'Importer',
    size: 'dialog--wide',
    labelId: 'import-title',
    body: [
      h(
        'div',
        { class: 'segmented', role: 'tablist', 'aria-label': "Type d'import" },
        tabs.map(([value, label]) => h('button', { role: 'tab', 'aria-selected': modal.tab === value ? 'true' : 'false', onClick: () => showImportTab(value) }, label)),
      ),
      modal.tab === 'worlds' ? importWorldsTab(modal) : importInstancesTab(modal),
    ],
  });
}

function serverDialog(modal) {
  const draft = modal.draft;
  const editing = modal.index !== null;
  const error = h('p', { class: 'hint hint--error', role: 'alert' });
  const submit = async () => {
    if (modal.busy) return;
    modal.busy = true;
    try {
      await saveServer(modal);
    } catch (e) {
      error.textContent = e.message;
    } finally {
      modal.busy = false;
    }
  };
  const input = (id, label, key, placeholder, extra = {}) =>
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: id }, label),
      h('input', {
        id,
        class: `input${key === 'address' ? ' mono' : ' input--pixel'}`,
        type: 'text',
        maxlength: key === 'name' ? 64 : 255,
        placeholder,
        value: draft[key],
        spellcheck: 'false',
        onInput: (e) => {
          draft[key] = e.target.value;
          error.textContent = '';
        },
        onKeydown: (e) => e.key === 'Enter' && submit(),
        ...extra,
      }),
    );
  return dialog({
    title: editing ? 'Modifier le serveur' : 'Ajouter un serveur',
    size: 'dialog--small',
    labelId: 'server-title',
    body: [
      input('server-name', 'Nom', 'name', 'Serveur Minecraft'),
      input('server-address', 'Adresse', 'address', 'play.exemple.fr ou 192.168.1.20:25565'),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'label', for: 'server-packs' }, 'Packs de ressources du serveur'),
        h(
          'select',
          { id: 'server-packs', class: 'select', onChange: (e) => { draft.resourcePacks = e.target.value; } },
          [['prompt', 'Demander'], ['enabled', 'Accepter'], ['disabled', 'Refuser']].map(([value, label]) => h('option', { value, selected: draft.resourcePacks === value }, label)),
        ),
      ),
      h('p', { class: 'hint' }, 'Enregistré dans servers.dat : le serveur apparaît aussi dans le menu Multijoueur du jeu.'),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--primary btn--lg', onClick: submit }, editing ? 'Enregistrer' : 'Ajouter'),
    ],
  });
}
