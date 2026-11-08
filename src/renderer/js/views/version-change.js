// Fenêtre d'aperçu avant de changer la version d'une instance : ce qui suit, ce qui est mis à jour, ce qui est désactivé.
import { t } from '../i18n.js';
import { h, icon } from '../dom.js';
import { state } from '../state.js';
import { runVersionChange, setVersionOption } from '../version-actions.js';
import { close, dialog } from './modals.js';

function tile(kind, count, label) {
  return h('div', { class: `vc-tile vc-tile--${kind}` }, h('b', null, String(count)), h('span', null, label));
}

function check(id, checked, title, detail, onChange, disabled) {
  return h(
    'label',
    { class: 'vc-check', for: id },
    h('input', { id, type: 'checkbox', checked: checked ? true : null, disabled, onChange: (e) => onChange(e.target.checked) }),
    h('span', null, h('b', null, title), h('small', null, detail)),
  );
}

export function versionChangeDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const target = modal.patch.version;
  const plan = modal.plan ?? [];
  const of = (fate) => plan.filter((p) => p.fate === fate);
  const updates = of('update');
  const missing = of('missing');
  const unknown = of('unknown');
  const notes = [
    ...missing.map((p) => [p.name, t('version.pas_de_version', { version: target })]),
    ...unknown.map((p) => [p.name, t('version.inconnu_modrinth')]),
    ...updates.map((p) => [p.name, t('version.mis_a_jour_vers', { number: p.number })]),
  ];
  return dialog({
    title: t('version.titre', { name: instance.name }),
    labelId: 'version-change-title',
    body: [
      h('p', { class: 'vc-route' }, h('b', null, modal.from), icon('next', 16), h('b', null, target)),
      modal.error
        ? h('p', { class: 'notice notice--warn', role: 'alert' }, icon('alert'), t('version.verification_impossible', { error: modal.error }))
        : h(
            'div',
            { class: 'vc-tiles' },
            tile('ok', updates.length, t('version.ont_une_version', { version: target })),
            tile('bad', missing.length, t('version.pas_encore', { version: target })),
            tile('unk', unknown.length, t('version.inconnus')),
          ),
      notes.length > 0 && h('div', { class: 'vc-list', 'data-scroll-key': 'version-change' }, notes.map(([name, note]) => h('div', { class: 'vc-row' }, h('span', null, name), h('span', null, note)))),
      updates.length > 0 && check('vc-update', modal.updateOk, t('version.mettre_a_jour_n', { count: updates.length }), t('version.mettre_a_jour_detail'), (v) => setVersionOption('updateOk', v), modal.busy),
      missing.length > 0 && check('vc-disable', modal.disableMissing, t('version.desactiver_n', { count: missing.length }), t('version.desactiver_detail'), (v) => setVersionOption('disableMissing', v), modal.busy),
      instance.settings.backupAuto && h('p', { class: 'notice' }, icon('archive'), t('version.mondes_sauvegardes', { version: target })),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', disabled: modal.busy, onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--primary', disabled: modal.busy, onClick: () => runVersionChange(modal) }, modal.busy ? t('version.en_cours') : t('version.passer_en', { version: target })),
    ],
  });
}
