// Assistant de création d'instance : trois étapes (style de jeu, nom et version, récapitulatif).
import { openImport } from '../import-actions.js';
import { LOADER_NAMES, VERSION_TYPES } from '../data.js';
import { blockIcon, formatGo, h, slugify } from '../dom.js';
import { state, update } from '../state.js';
import { backToDetails, backToProfiles, createFromWizard, goToDetails, goToRecap, offline, pickProfile, PROFILE_CARDS, setWizardName, setWizardVersion } from '../wizard-actions.js';
import { BLOCKS, close, dialog } from './modals.js';

function stepsBar(step) {
  return h('div', { class: 'wizard-steps', role: 'img', 'aria-label': `Étape ${step} sur 3` }, [1, 2, 3].map((n) => h('span', { class: n <= step ? 'is-on' : '' })));
}

function stepProfiles(wiz) {
  const isOffline = offline();
  return [
    stepsBar(1),
    h('p', { class: 'hint', style: 'margin:0' }, 'Étape 1 sur 3 : quel style de jeu ?'),
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
          h('span', null, blocked ? 'Demande une connexion Internet pour télécharger les mods.' : card.text),
        );
      }),
    ),
    isOffline && h('p', { class: 'hint hint--warn', role: 'status' }, 'Hors connexion : seules les cartes Créatif et Personnalisée restent disponibles.'),
  ];
}

function planLine(wiz) {
  const plan = wiz.plan;
  if (!plan || plan.loading) return h('p', { class: 'hint', role: 'status' }, 'Recherche de la version compatible…');
  if (plan.error) return h('p', { class: 'hint hint--error', role: 'alert' }, `Vérification impossible : ${plan.error}`);
  const missing = plan.data.mods.filter((m) => !m.available);
  if (!missing.length) return h('p', { class: 'hint' }, plan.data.mods.length ? `Les ${plan.data.mods.length} mods du profil existent pour cette version.` : 'Aucun mod à installer.');
  return h('p', { class: 'hint hint--warn' }, `${missing.map((m) => m.title).join(', ')} : pas de version pour ${plan.data.version}, ignoré à l'installation.`);
}

function stepDetails(wiz, draft) {
  const releases = state.versions.list.filter((v) => v.type === 'release');
  const extra = state.versions.list.find((v) => v.id === draft.version && v.type !== 'release');
  const choices = extra ? [extra, ...releases] : releases;
  const preview = h('strong', null, slugify(draft.name || 'nouvelle-instance'));
  return [
    stepsBar(2),
    h('p', { class: 'hint', style: 'margin:0' }, 'Étape 2 sur 3 : nom, icône et version.'),
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
            h('button', { role: 'radio', 'aria-label': label, 'aria-checked': draft.icon === kind ? 'true' : 'false', onClick: () => update(() => { draft.icon = kind; }) }, blockIcon(kind, 'block--md')),
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
      h('label', { class: 'label', for: 'instance-version' }, 'Version de Minecraft'),
      h(
        'select',
        { id: 'instance-version', class: 'select', disabled: Boolean(wiz.plan?.loading), onChange: (e) => setWizardVersion(e.target.value) },
        choices.map((v) => h('option', { value: v.id, selected: v.id === draft.version }, `${v.id} · ${VERSION_TYPES[v.type] ?? v.type}${v.installed ? ' · installée' : ''}`)),
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
    h('p', { class: 'hint', style: 'margin:0' }, 'Étape 3 sur 3 : récapitulatif.'),
    h(
      'ul',
      { class: 'wizard-recap' },
      row('Nom', draft.name.trim()),
      row('Minecraft', plan.version),
      row('Loader', plan.loader === 'vanilla' ? 'Vanilla (aucun)' : LOADER_NAMES[plan.loader]),
      row('Mémoire conseillée', `${formatGo(ram.ideal)} (zone idéale ${ram.low} à ${ram.high} Go)`),
    ),
    plan.mods.length > 0
      ? h(
          'div',
          { class: 'field' },
          h('span', { class: 'label' }, `Mods prévus (${plan.mods.filter((m) => m.available).length} sur ${plan.mods.length})`),
          h('div', { class: 'wizard-mods' }, plan.mods.map((m) => h('span', { class: m.available ? '' : 'is-skipped', title: m.available ? m.number : 'Indisponible pour cette version : ignoré' }, m.title))),
          plan.mods.some((m) => !m.available) && h('p', { class: 'hint hint--warn' }, `Ignoré, indisponible en ${plan.version} : ${plan.mods.filter((m) => !m.available).map((m) => m.title).join(', ')}.`),
          h('p', { class: 'hint' }, 'Leurs dépendances (Fabric API par exemple) sont ajoutées automatiquement.'),
        )
      : h('p', { class: 'hint' }, 'Aucun mod : Minecraft tel quel.'),
  ];
}

export function wizardDialog(modal) {
  const wiz = modal.wizard;
  const draft = modal.draft;
  const step = wiz.step;
  const busy = Boolean(modal.busy);
  const canNext = step === 1 ? Boolean(wiz.profile) : step === 2 ? Boolean(wiz.plan?.data) && !wiz.plan?.loading : true;
  return dialog({
    title: 'Nouvelle instance',
    size: 'dialog--wide',
    labelId: 'new-instance-title',
    body: [
      ...(step === 1 ? stepProfiles(wiz) : step === 2 ? stepDetails(wiz, draft) : stepRecap(wiz, draft)),
      wiz.error && h('p', { class: 'hint hint--error', role: 'alert' }, wiz.error),
    ],
    foot: [
      step === 1
        ? h('button', { class: 'btn btn--ghost spacer', onClick: openImport }, 'Importer depuis un autre launcher…')
        : h('button', { class: 'btn btn--ghost spacer', disabled: busy, onClick: step === 2 ? backToProfiles : backToDetails }, 'Retour'),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      step === 3
        ? h('button', { class: 'btn btn--primary btn--lg', disabled: busy, onClick: createFromWizard }, busy ? 'Création…' : 'Créer')
        : h('button', { class: 'btn btn--primary btn--lg', disabled: !canNext, onClick: step === 1 ? goToDetails : goToRecap }, 'Suivant'),
    ],
  });
}
