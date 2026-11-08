// Fenêtres modales (nouvelle instance, comptes, RAM faible), écran de bienvenue et notifications.
import { languagePicker } from './language.js';
import { t } from '../i18n.js';
import { importInstance, openImport, pickImportFolder } from '../import-actions.js';
import { exportInstance } from '../mods-actions.js';
import { shareCrash } from '../crash-actions.js';
import { cleanDialog, removeRuntimeDialog, shortcutsDialog, stopGameDialog } from './launcher-settings.js';
import { addMicrosoftAccount, addOfflineAccount, createInstance, deleteInstance, disableLowRamWarning, editInstance, fixAllAndLaunch, fixModProblem, launchAnyway, loaderOptions, removeAccount, setActiveAccount, startLaunch, versionDetails } from '../actions.js';
import { bannerUrl } from '../banner.js';
import { LOADER_NAMES, LOADERS, loaderLabel, VERSION_TYPES } from '../data.js';
import { blockIcon, formatGo, formatPlaytime, h, icon, slugify } from '../dom.js';
import { openSkins } from '../skins-actions.js';
import { skinHead } from '../skin-view.js';
import { dismissToast, state, update } from '../state.js';
import { gpuConfirmDialog, packDialog } from './performance.js';
import { skinsDialog } from './skins.js';
import { openBackground } from '../background-actions.js';
import { backgroundDialog } from './background.js';
import { recapDialog } from './recap.js';
import { paletteDialog } from './palette.js';
import { wizardDialog } from './wizard.js';
import { modSetDeleteDialog, modSetDialog } from './mod-sets.js';
import { worldsDialog } from './worlds.js';

export const BLOCKS = () => [
  ['grass', t('modals.herbe')], ['diamond', t('modals.diamant')], ['stone', t('modals.pierre')],
  ['netherrack', 'Netherrack'], ['sand', t('modals.sable')], ['end', 'End'],
];


export function close() {
  update((s) => {
    s.modal = null;
  });
}

export function dialog({ title, size = '', body, foot, labelId, onClose = close }) {
  return h(
    'div',
    { class: 'overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h(
      'section',
      { class: `dialog ${size}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelId },
      h(
        'div',
        { class: 'dialog__head' },
        h('h1', { class: 'dialog__title', id: labelId }, title),
        h('button', { class: 'dialog__close', 'aria-label': t('common.fermer'), onClick: onClose }, icon('close')),
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
    h('legend', { class: 'label' }, t('modals.compte_de_cette_instance')),
    choice(null, t('modals.compte_actif_du_launcher'), active ? t('modals.aujourd_hui', { name: active.name }) : t('modals.aucun_pour_le_moment')),
    state.accounts.map((a) => choice(a.id, a.name, a.type === 'microsoft' ? t('common.compte_microsoft') : t('common.hors_ligne'), skinHead(a, 32))),
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
    h('span', { class: 'label', id: 'loader-label' }, t('common.loader_de_mods')),
    h(
      'div',
      { class: 'loaders', role: 'radiogroup', 'aria-labelledby': 'loader-label' },
      LOADERS.map((loader) => {
        const count = versionsOf(loader).length;
        const available = loader === 'vanilla' || count > 0;
        let note = null;
        if (loader !== 'vanilla') note = !options ? (failed ? t('modals.erreur') : t('common.chargement')) : count ? t('modals.versions_count', { count }) : t('modals.indisponible');
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
        h('label', { class: 'label', for: 'loader-version' }, t('modals.version_de', { LOADER_NAMES: LOADER_NAMES[draft.loader] })),
        h(
          'select',
          { id: 'loader-version', class: 'select', onChange: (e) => update(() => { draft.loaderVersion = e.target.value; }) },
          versionsOf(draft.loader).map((v) =>
            h(
              'option',
              { value: v.id, selected: v.id === draft.loaderVersion },
              `${v.label ?? v.id}${v.id === recommended ? t('modals.recommandee') : ''}${v.stable ? '' : t('common.beta_2')}`,
            ),
          ),
        ),
        h(
          'p',
          { class: 'hint' },
          draft.loader === 'forge' || draft.loader === 'neoforge'
            ? t('modals.installeur_officiel_de_execute_au', { LOADER_NAMES: LOADER_NAMES[draft.loader] })
            : t('modals.installe_en_quelques_secondes_au', { LOADER_NAMES: LOADER_NAMES[draft.loader] }),
        ),
      ),
    failed && h('p', { class: 'hint hint--error' }, t('modals.liste_des_loaders_indisponible', { failed })),
  );
}

/** Fenêtre « Nouvelle instance », ou « Modifier l'instance » si modal.instanceId est présent. */
function instanceDialog(modal) {
  if (modal.wizard) return wizardDialog(modal);
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
      error.textContent = t('common.donne_un_nom_ton_instance');
      document.getElementById('instance-name')?.focus();
      return;
    }
    if (draft.loader !== 'vanilla' && !draft.loaderVersion) {
      error.textContent = t('modals.choisis_une_version_de', { LOADER_NAMES: LOADER_NAMES[draft.loader] });
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
    title: editing ? t('common.modifier_instance') : t('common.nouvelle_instance'),
    size: 'dialog--wide',
    labelId: 'new-instance-title',
    body: [
      h(
        'div',
        { style: 'display:flex;gap:20px;align-items:flex-end' },
        h(
          'div',
          { class: 'field' },
          h('span', { class: 'label', id: 'icon-label' }, t('common.icone')),
          h(
            'div',
            { class: 'icon-grid', role: 'radiogroup', 'aria-labelledby': 'icon-label' },
            BLOCKS().map(([kind, label]) =>
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
          h('label', { class: 'label', for: 'instance-name' }, t('common.nom')),
          h('input', {
            id: 'instance-name',
            class: 'input input--pixel',
            type: 'text',
            maxlength: 40,
            placeholder: t('modals.survie'),
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
        h('label', { class: 'label', for: 'instance-version' }, t('common.version_de_minecraft')),
        h(
          'select',
          { id: 'instance-version', class: 'select', onChange: (e) => update(() => { draft.version = e.target.value; }) },
          versionChoices(draft.version).map((v) =>
            h('option', { value: v.id, selected: v.id === draft.version }, `${v.id} · ${VERSION_TYPES[v.type] ?? v.type}${v.installed ? t('common.installee') : ''}`),
          ),
        ),
        h('p', { class: 'hint' }, details ? t('modals.java_sera_telecharge_automatiquement_si', { java: details.java }) : t('modals.le_bon_java_sera_telecharge')),
        versionChanged &&
          h(
            'p',
            { class: 'hint hint--warn' },
            t('modals.attention_un_monde_ouvert_en', { version: original.version }),
          ),
      ),
      loaderField(draft),
      accountField(draft),
      h('p', { class: 'path-preview' }, '~\\AppData\\Roaming\\.0rzxn\\instances\\', editing ? h('strong', null, original.id) : preview),
      error,
    ],
    foot: [
      editing
        ? h('button', { class: 'btn btn--ghost spacer', onClick: () => openBackground(original) }, t('modals.fond'))
        : h(
            'button',
            { class: 'btn btn--ghost spacer', onClick: openImport },
            t('common.importer_depuis_un_autre_launcher'),
          ),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--primary btn--lg', onClick: submit }, editing ? t('common.enregistrer') : t('common.creer')),
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
    title: t('modals.supprimer_instance'),
    size: 'dialog--small',
    labelId: 'delete-title',
    body: [
      h(
        'p',
        { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' },
        t('modals.et_tout_son_dossier_mondes', { name: instance.name }),
      ),
      h('p', { class: 'hint' }, t('modals.les_fichiers_de_minecraft_partages')),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--danger', onClick: confirm }, t('modals.mettre_la_corbeille')),
    ],
  });
}

function microsoftButton(style) {
  return h(
    'button',
    { class: 'btn btn--microsoft', style, disabled: state.signingIn, onClick: addMicrosoftAccount },
    icon('microsoft', 18),
    state.signingIn ? t('modals.connexion_en_cours') : t('modals.se_connecter_avec_microsoft'),
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
    placeholder: t('common.pseudo'),
    spellcheck: 'false',
    'data-keep': true, // la saisie survit aux redessins (voir main.js)
    onInput: () => { error.textContent = ''; },
    onKeydown: (e) => e.key === 'Enter' && submit(),
  });
  return { input, error, button: h('button', { class: 'btn btn--lg', onClick: submit }, idPrefix === 'welcome' ? t('common.continuer') : t('modals.ajouter')) };
}

// Un nouveau compte hors-ligne demande d'abord un compte Microsoft qui possède le jeu
// (vérifié aussi dans core/accounts.js). Les comptes hors-ligne déjà créés continuent de marcher.
const hasMicrosoftAccount = () => state.accounts.some((a) => a.type === 'microsoft');
const offlineLocked = () => t('modals.les_comptes_hors_ligne_se');

function offlineLine(account) {
  if (!account.look) return t('modals.hors_ligne_solo_et_serveurs');
  return account.look.skin ? t('modals.hors_ligne_tete_du_skin') : t('modals.hors_ligne_ce_pseudo_pas');
}

function accountsDialog() {
  const form = offlineForm('accounts');
  return dialog({
    title: t('common.comptes'),
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
                  a.type === 'offline' ? offlineLine(a) : a.needsLogin ? t('modals.session_expiree_reconnecte_toi') : t('common.compte_microsoft'),
                ),
              ),
              a.needsLogin
                ? h('button', { class: 'btn', disabled: state.signingIn, onClick: addMicrosoftAccount }, t('modals.se_reconnecter'))
                : active
                  ? h('span', { class: 'tag tag--ok' }, t('modals.actif'))
                  : h('button', { class: 'btn', disabled: Boolean(state.run), onClick: () => setActiveAccount(a.id) }, t('modals.utiliser')),
              h('button', { class: 'btn', onClick: () => openSkins(a.id) }, t('common.skin_et_cape')),
              h(
                'button',
                { class: 'dialog__close', 'aria-label': t('modals.retirer_le_compte', { name: a.name }), disabled: Boolean(state.run) && active, onClick: () => removeAccount(a.id) },
                icon('trash'),
              ),
            );
          }),
        ),
      h('h2', { class: 'label', style: 'margin:4px 0 0' }, t('common.ajouter_un_compte')),
      microsoftButton(),
      hasMicrosoftAccount()
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: 'accounts-offline', style: 'font-size:13px;font-weight:600' }, t('modals.compte_hors_ligne')),
            h('div', { class: 'input-row' }, form.input, form.button),
            form.error,
            h('p', { class: 'hint' }, t('modals.16_caracteres_lettres_chiffres_et')),
          )
        : h(
            'div',
            { class: 'field' },
            h('span', { style: 'font-size:13px;font-weight:600' }, t('modals.compte_hors_ligne')),
            h('p', { class: 'hint' }, offlineLocked()),
          ),
      h('p', { class: 'trust', style: 'margin:0' }, icon('lock'), t('modals.ton_mot_de_passe_reste')),
    ],
  });
}

function lowRamDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  return dialog({
    title: t('modals.memoire_libre_insuffisante'),
    size: 'dialog--small',
    labelId: 'lowram-title',
    body: [
      h(
        'p',
        { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' },
        t('modals.demande_mais_il_ne_reste', { name: instance.name, ram: formatGo(instance.settings.ram), freeGb: formatGo(state.memory.freeGb.toFixed(1)), totalGb: formatGo(Math.round(state.memory.totalGb)) }),
      ),
    ],
    foot: [
      h('button', { class: 'btn btn--ghost spacer', onClick: () => disableLowRamWarning(instance.id) }, t('modals.ne_plus_avertir')),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--primary btn--lg', onClick: () => startLaunch(instance.id, modal.options) }, t('modals.lancer_quand_meme')),
    ],
  });
}

function modCheckDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const canFixAll = modal.problems.every((p) => p.action);
  return dialog({
    title: t('modals.avant_de_lancer', { name: instance.name }),
    size: 'dialog--wide',
    labelId: 'modcheck-title',
    body: [
      h('p', { class: 'hint', style: 'margin:0 0 4px' }, t('modals.le_launcher_lu_les_mods')),
      h(
        'ul',
        { class: 'diag' },
        modal.problems.map((p) =>
          h(
            'li',
            { class: 'diag__row' },
            h('span', { class: `diag__tag diag__tag--${p.severity}` }, p.severity === 'blocking' ? t('modals.bloquant') : t('modals.risque')),
            h('div', { class: 'diag__text' }, h('b', {}, p.title), h('span', {}, p.text)),
            p.action && h('button', { class: 'btn btn--sm', onClick: () => fixModProblem(p) }, p.action.label),
          ),
        ),
      ),
    ],
    foot: [
      h('button', { class: 'btn btn--lg spacer', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg', onClick: launchAnyway }, t('modals.lancer_quand_meme')),
      canFixAll && h('button', { class: 'btn btn--primary btn--lg', onClick: fixAllAndLaunch }, t('modals.corriger_et_jouer')),
    ],
  });
}

export function renderModal() {
  const modal = state.modal;
  if (!modal) return null;
  if (modal.type === 'new-instance' || modal.type === 'edit-instance') return instanceDialog(modal);
  if (modal.type === 'background') return backgroundDialog(modal);
  if (modal.type === 'recap') return recapDialog(modal);
  if (modal.type === 'palette') return paletteDialog(modal);
  if (modal.type === 'mod-set') return modSetDialog(modal);
  if (modal.type === 'mod-set-delete') return modSetDeleteDialog(modal);
  if (modal.type === 'delete-instance') return deleteDialog(modal);
  if (modal.type === 'accounts') return accountsDialog();
  if (modal.type === 'skins') return skinsDialog(modal);
  if (modal.type === 'low-ram') return lowRamDialog(modal);
  if (modal.type === 'mod-check') return modCheckDialog(modal);
  if (modal.type === 'export') return exportDialog(modal);
  if (modal.type === 'import') return importDialog(modal);
  if (modal.type === 'share-crash') return shareDialog(modal);
  if (modal.type === 'shortcuts') return shortcutsDialog();
  if (modal.type === 'stop-game') return stopGameDialog();
  if (modal.type === 'remove-runtime') return removeRuntimeDialog(modal);
  if (modal.type === 'clean-storage') return cleanDialog(modal);
  if (modal.type === 'perf-pack') return packDialog(modal);
  if (modal.type === 'gpu-confirm') return gpuConfirmDialog(modal);
  if (['restore-world', 'delete-world', 'backup-failed'].includes(modal.type)) return worldsDialog(modal);
  return null;
}

/** Le rapport devient public sur mclo.gs : on le dit avant l'envoi. */
function shareDialog(modal) {
  return dialog({
    title: t('modals.partager_le_rapport'),
    size: 'dialog--small',
    labelId: 'share-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, t('modals.sera_envoye_sur_mclo_gs', { file: modal.item.file })),
      h('p', { class: 'hint' }, t('modals.avant_envoi_le_launcher_masque')),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--primary', onClick: () => shareCrash(modal.item) }, icon('external'), t('modals.envoyer_sur_mclo_gs')),
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
    title: t('modals.exporter_en_modpack'),
    labelId: 'export-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, t('modals.cree_un_fichier_mrpack_de', { name: instance.name })),
      field('export-name', t('modals.nom_du_modpack'), 'name', instance.name),
      field('export-version', t('common.version'), 'version', '1.0.0'),
      field('export-summary', t('modals.description_facultatif'), 'summary', t('modals.mon_pack_de_survie')),
      h(
        'p',
        { class: 'hint' },
        t('modals.les_mods_packs_et_shaders'),
      ),
      error,
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--primary btn--lg', onClick: submit }, icon('upload'), t('modals.exporter')),
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
    languagePicker({ extraClass: 'lang-picker--corner' }),
    h(
      'section',
      { class: 'welcome__panel', 'aria-labelledby': 'welcome-title' },
      h('span', { class: 'logo logo--lg', 'aria-hidden': 'true' }),
      h('div', null, h('h1', { class: 'welcome__title', id: 'welcome-title' }, t('modals.bienvenue')), h('p', { class: 'welcome__text' }, t('modals.connecte_ton_compte_microsoft_pour'))),
      microsoftButton('height:56px;font-size:18px'),
      h('p', { class: 'hint' }, offlineLocked()),
      h('p', { class: 'trust' }, icon('lock'), t('modals.la_connexion_se_fait_sur')),
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
      h('span', { class: 'toast__text' }, task.total ? t('modals.task_files', { done: task.done, total: task.total }) : t('modals.preparation')),
      h('span', { class: 'progress', style: 'margin-top:6px;height:10px' }, h('span', { class: 'progress__fill', style: `display:block;width:${percent ?? 5}%` })),
    ),
  );
}

export function renderToasts() {
  const toasts = state.toasts.map((item) =>
    h(
      'div',
      { class: `toast toast--${item.kind}`, role: item.kind === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast__icon' }, icon(item.kind === 'success' ? 'check' : item.kind === 'error' ? 'alert' : 'info')),
      h(
        'span',
        { class: 'toast__body' },
        h('span', { class: 'toast__title' }, item.title),
        item.text && h('span', { class: 'toast__text' }, item.text),
        item.actions.length > 0 &&
          h(
            'span',
            { class: 'toast__actions' },
            item.actions.map((a) => h('button', { class: 'btn', onClick: () => { dismissToast(item.id); a.run(); } }, a.label)),
          ),
      ),
      h('button', { class: 'dialog__close', style: 'width:28px;height:28px', 'aria-label': t('modals.fermer_la_notification'), onClick: () => dismissToast(item.id) }, icon('close')),
    ),
  );
  return state.task ? [taskCard(state.task), ...toasts] : toasts;
}

function importRows(items, row) {
  return h('ul', { class: 'import-list' }, items.map(row));
}

function importStatus(result, emptyTitle, emptyText) {
  if (!result) return h('p', { class: 'hint', role: 'status' }, t('common.recherche'));
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
      h('span', { class: 'hint' }, result?.dir ? [`${result.launcher ?? t('common.dossier')} · `, h('span', { class: 'import-source__path' }, result.dir)] : t('modals.dossier_par_defaut')),
      h('button', { class: 'btn', onClick: pickImportFolder }, icon('folder'), t('modals.autre_dossier')),
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
              h('span', { class: 'import-row__name' }, item.name, item.imported && h('span', { class: 'tag tag--ok' }, t('modals.deja_importee'))),
              h(
                'span',
                { class: 'import-row__meta' },
                [
                  item.version && `Minecraft ${item.version}`,
                  item.loader !== 'vanilla' && loaderLabel(item),
                  item.playtime ? formatPlaytime(item.playtime) : t('modals.jamais_lancee'),
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
              item.imported ? t('modals.reimporter') : t('modals.importer'),
            ),
          ),
        )
      : importStatus(result, t('modals.aucune_instance_trouvee'), t('modals.choisis_le_dossier_instances_un')),
    h(
      'p',
      { class: 'hint' },
      t('modals.le_dossier_du_jeu_est'),
    ),
  ];
}

function importDialog(modal) {
  return dialog({
    title: t('modals.importer'),
    size: 'dialog--wide',
    labelId: 'import-title',
    body: importInstancesTab(modal),
  });
}

