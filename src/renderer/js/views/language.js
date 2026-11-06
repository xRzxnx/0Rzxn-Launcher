// Choix de la langue : Paramètres › Launcher et écran Bienvenue (sans compte, les paramètres sont inaccessibles).
import { h } from '../dom.js';
import { currentLanguage, t } from '../i18n.js';
import { changeLanguage } from '../launcher-actions.js';
import { state } from '../state.js';

// Chaque langue garde son propre nom, pour qu'on retrouve la sienne quelle que soit celle affichée.
const LANGUAGES = [['fr', 'Français'], ['en', 'English'], ['es', 'Español']];

/** `withAuto` ajoute « Automatique » (langue de Windows) ; sinon la langue affichée est mise en avant. */
export function languagePicker({ withAuto = false, extraClass = '' } = {}) {
  const chosen = withAuto ? state.launcherPrefs?.language ?? 'auto' : currentLanguage();
  const options = [...(withAuto ? [['auto', t('common.automatique')]] : []), ...LANGUAGES];
  return h(
    'div',
    { class: `lang-picker ${extraClass}`.trim(), role: 'group', 'aria-label': t('launcher.language') },
    options.map(([value, label]) =>
      h('button', { id: `lang-${value}`, class: 'lang-picker__option', 'aria-pressed': chosen === value ? 'true' : 'false', onClick: () => changeLanguage(value) }, label),
    ),
  );
}

export function languageSection() {
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'language-title' },
    h('h2', { class: 'settings__title', id: 'language-title' }, t('launcher.language')),
    languagePicker({ withAuto: true }),
    h('p', { class: 'hint' }, t('launcher.language_hint')),
  );
}
