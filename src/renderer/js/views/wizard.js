// Assistant de création d'instance : trois étapes (style de jeu, nom et version, récapitulatif).
import { num, t } from '../i18n.js';
import { openImport } from '../import-actions.js';
import { LOADER_NAMES, VERSION_TYPES } from '../data.js';
import { blockIcon, formatGo, h, slugify } from '../dom.js';
import { state, update } from '../state.js';
import { backToDetails, backToProfiles, createFromWizard, goToDetails, goToRecap, offline, pickProfile, PROFILE_CARDS, setWizardName, setWizardVersion } from '../wizard-actions.js';
import { BLOCKS, close, dialog } from './modals.js';

function stepsBar(step) {
  return h('div', { class: 'wizard-steps', role: 'img', 'aria-label': t('wizard.etape_sur', { step }) }, [1, 2, 3].map((n) => h('span', { class: n <= step ? 'is-on' : '' })));
}

function stepProfiles(wiz) {
  const isOffline = offline();
  return [
    stepsBar(1),
    h('p', { class: 'hint', style: 'margin:0' }, t('wizard.etape_sur_quel_style_de')),
    h(
      'div',
      { class: 'wizard-grid' },
      PROFILE_CARDS.map((card) => {
        const blocked = isOffline && card.online;
        return h(
          'button',
          {
            class: 'wizard-card',
            'aria-pressed': wiz.profile === card.id ? 'true' : 'false',
            disabled: blocked,
            onClick: () => pickProfile(card.id),
          },
          h('b', null, card.title),
          h('span', null, blocked ? t('wizard.demande_une_connexion_internet_pour') : card.text),
        );
      }),
    ),
    isOffline && h('p', { class: 'hint hint--warn', role: 'status' }, t('wizard.hors_connexion_seules_les_cartes')),
  ];
}

function planLine(wiz) {
  const plan = wiz.plan;
  if (!plan || plan.loading) return h('p', { class: 'hint', role: 'status' }, t('wizard.recherche_de_la_version_compatible'));
  if (plan.error) return h('p', { class: 'hint hint--error', role: 'alert' }, t('wizard.verification_impossible', { error: plan.error }));
  const missing = plan.data.mods.filter((m) => !m.available);
  if (!missing.length) return h('p', { class: 'hint' }, plan.data.mods.length ? t('wizard.les_mods_du_profil_existent', { mods: plan.data.mods.length }) : t('wizard.aucun_mod_installer'));
  return h('p', { class: 'hint hint--warn' }, t('wizard.pas_de_version_pour_ignore', { missing: missing.map((m) => m.title).join(', '), version: plan.data.version }));
}

function stepDetails(wiz, draft) {
  const releases = state.versions.list.filter((v) => v.type === 'release');
  const extra = state.versions.list.find((v) => v.id === draft.version && v.type !== 'release');
  const choices = extra ? [extra, ...releases] : releases;
  const preview = h('strong', null, slugify(draft.name || 'nouvelle-instance'));
  return [
    stepsBar(2),
    h('p', { class: 'hint', style: 'margin:0' }, t('wizard.etape_sur_nom_icone_et')),
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
            h('button', { role: 'radio', 'aria-label': label, 'aria-checked': draft.icon === kind ? 'true' : 'false', onClick: () => update(() => { draft.icon = kind; }) }, blockIcon(kind, 'block--md')),
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
          value: draft.name,
          onInput: (e) => {
            setWizardName(e.target.value);
            preview.textContent = slugify(draft.name || 'nouvelle-instance');
          },
          onKeydown: (e) => e.key === 'Enter' && goToRecap(),
        }),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: 'instance-version' }, t('common.version_de_minecraft')),
      h(
        'select',
        { id: 'instance-version', class: 'select', disabled: Boolean(wiz.plan?.loading), onChange: (e) => setWizardVersion(e.target.value) },
        choices.map((v) => h('option', { value: v.id, selected: v.id === draft.version }, `${v.id} · ${VERSION_TYPES[v.type] ?? v.type}${v.installed ? t('common.installee') : ''}`)),
      ),
      planLine(wiz),
    ),
    h('p', { class: 'path-preview' }, '~\\AppData\\Roaming\\.0rzxn\\instances\\', preview),
  ];
}

function stepRecap(wiz, draft) {
  const plan = wiz.plan.data;
  const row = (label, value) => h('li', null, h('span', null, label), h('span', null, value));
  const ram = plan.ram;
  return [
    stepsBar(3),
    h('p', { class: 'hint', style: 'margin:0' }, t('wizard.etape_sur_recapitulatif')),
    h(
      'ul',
      { class: 'wizard-recap' },
      row(t('common.nom'), draft.name.trim()),
      row('Minecraft', plan.version),
      row(t('wizard.loader'), plan.loader === 'vanilla' ? t('wizard.vanilla_aucun') : LOADER_NAMES[plan.loader]),
      row(t('common.memoire_conseillee'), t('wizard.ram_summary', { ideal: formatGo(ram.ideal), low: num(ram.low), high: formatGo(ram.high) })),
    ),
    plan.mods.length > 0
      ? h(
          'div',
          { class: 'field' },
          h('span', { class: 'label' }, t('wizard.mods_prevus_sur', { mods: plan.mods.filter((m) => m.available).length, mods2: plan.mods.length })),
          h('div', { class: 'wizard-mods' }, plan.mods.map((m) => h('span', { class: m.available ? '' : 'is-skipped', title: m.available ? m.number : t('wizard.indisponible_pour_cette_version_ignore') }, m.title))),
          plan.mods.some((m) => !m.available) && h('p', { class: 'hint hint--warn' }, t('wizard.ignore_indisponible_en', { version: plan.version, mods: plan.mods.filter((m) => !m.available).map((m) => m.title).join(', ') })),
          h('p', { class: 'hint' }, t('wizard.leurs_dependances_fabric_api_par')),
        )
      : h('p', { class: 'hint' }, t('wizard.aucun_mod_minecraft_tel_quel')),
  ];
}

export function wizardDialog(modal) {
  const wiz = modal.wizard;
  const draft = modal.draft;
  const step = wiz.step;
  const busy = Boolean(modal.busy);
  const canNext = step === 1 ? Boolean(wiz.profile) : step === 2 ? Boolean(wiz.plan?.data) && !wiz.plan?.loading : true;
  return dialog({
    title: t('common.nouvelle_instance'),
    size: 'dialog--wide',
    labelId: 'new-instance-title',
    body: [
      ...(step === 1 ? stepProfiles(wiz) : step === 2 ? stepDetails(wiz, draft) : stepRecap(wiz, draft)),
      wiz.error && h('p', { class: 'hint hint--error', role: 'alert' }, wiz.error),
    ],
    foot: [
      step === 1
        ? h('button', { class: 'btn btn--ghost spacer', onClick: openImport }, t('common.importer_depuis_un_autre_launcher'))
        : h('button', { class: 'btn btn--ghost spacer', disabled: busy, onClick: step === 2 ? backToProfiles : backToDetails }, t('common.retour')),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      step === 3
        ? h('button', { class: 'btn btn--primary btn--lg', disabled: busy, onClick: createFromWizard }, busy ? t('wizard.creation') : t('common.creer'))
        : h('button', { class: 'btn btn--primary btn--lg', disabled: !canNext, onClick: step === 1 ? goToDetails : goToRecap }, t('wizard.suivant')),
    ],
  });
}
