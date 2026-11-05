// Paramètres : réglages de l'instance sélectionnée ou réglages globaux (utilisés par les nouvelles instances).
import { saveSettings, versionDetails } from '../actions.js';
import { api } from '../api.js';
import { ramRange, ramVerdict } from '../data.js';
import { blockIcon, formatGo, h, icon } from '../dom.js';
import { ramGuide, refreshFreeRam } from '../perf-actions.js';
import { selectedInstance, state, toastError, update } from '../state.js';
import { go } from './chrome.js';
import { renderLauncherTab, renderStorageTab } from './launcher-settings.js';
import { loadSystemJavas } from '../launcher-actions.js';
import { performanceSections } from './performance.js';

const AFTER_LAUNCH = [
  { id: 'keep', label: 'Rester ouvert' },
  { id: 'minimize', label: 'Réduire' },
  { id: 'hide', label: 'Masquer' },
];

function ramHint(ram, guide) {
  if (!guide) return { warn: false, text: '' };
  const verdict = ramVerdict(ram, guide, state.memory.freeGb);
  return { warn: verdict.level !== 'ok', text: `${verdict.title} : ${verdict.text} Conseillé : ${ramRange(guide)}.` };
}

/** Ctx = { settings, save } : `save()` enregistre (avec un petit délai) le bon jeu de réglages. */
function memorySection({ settings, save }, instance) {
  const maxRam = Math.max(2, Math.floor(state.memory.totalGb * 2) / 2);
  const guide = ramGuide(instance);
  const hint = ramHint(settings.ram, guide);
  const value = h('span', { class: 'ram-value' }, formatGo(settings.ram));
  const hintEl = h('p', { class: `hint${hint.warn ? ' hint--warn' : ''}` }, hint.text);
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'ram-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'ram-title' }, 'Mémoire'), value),
    h('label', { class: 'visually-hidden', for: 'ram' }, 'Mémoire maximale en Go'),
    h('input', {
      id: 'ram',
      class: 'range',
      type: 'range',
      min: 1,
      max: maxRam,
      step: 0.5,
      value: settings.ram,
      onPointerdown: refreshFreeRam,
      // Mise à jour sans redessin complet, pour garder le curseur en main ; enregistré au relâchement.
      onInput: (e) => {
        settings.ram = Number(e.target.value);
        const next = ramHint(settings.ram, guide);
        value.textContent = formatGo(settings.ram);
        hintEl.textContent = next.text;
        hintEl.className = `hint${next.warn ? ' hint--warn' : ''}`;
      },
      onChange: save,
    }),
    h(
      'div',
      { class: 'scale' },
      h('span', null, '1 Go'),
      h('span', { title: guide?.pc.detail ?? null }, `${guide?.pc.summary ?? formatGo(Math.round(state.memory.totalGb))} · ${formatGo(state.memory.freeGb.toFixed(1))} libres`),
    ),
    hintEl,
  );
}

function javaSection({ settings, save }, version) {
  const details = version ? versionDetails(version) : null;
  const custom = settings.java === 'custom';
  const choose = (java) => update(() => { settings.java = java; save(); });
  const browse = async () => {
    try {
      const file = await api.pickJava();
      if (file) update(() => { settings.javaPath = file; settings.java = 'custom'; save(); });
    } catch (error) {
      toastError('Choix de Java impossible', error);
    }
  };

  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'java-title' },
    h('h2', { class: 'settings__title', id: 'java-title' }, 'Java'),
    h(
      'div',
      { role: 'radiogroup', 'aria-labelledby': 'java-title', style: 'display:flex;flex-direction:column;gap:6px' },
      h(
        'button',
        { class: 'option', role: 'radio', 'aria-checked': custom ? 'false' : 'true', onClick: () => choose('auto') },
        h('span', { class: 'option__dot', 'aria-hidden': 'true' }),
        h(
          'span',
          { class: 'option__body' },
          h('span', { class: 'option__title' }, 'Automatique'),
          h('span', { class: 'option__detail' }, details ? `Java ${details.java} · runtime Mojang pour ${version}` : 'Le bon Java pour chaque version, téléchargé par le launcher'),
        ),
        h('span', { class: 'tag tag--ok' }, 'Recommandé'),
      ),
      h(
        'button',
        { class: 'option', role: 'radio', 'aria-checked': custom ? 'true' : 'false', onClick: () => choose('custom') },
        h('span', { class: 'option__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'option__body' }, h('span', { class: 'option__title' }, 'Personnalisé'), h('span', { class: 'option__detail' }, 'Un Java déjà installé sur ton PC')),
      ),
    ),
    custom &&
      h(
        'div',
        { class: 'input-row' },
        h('label', { class: 'visually-hidden', for: 'java-path' }, 'Chemin de Java'),
        h('input', {
          id: 'java-path',
          class: 'input input--mono',
          type: 'text',
          spellcheck: 'false',
          placeholder: 'C:\\Program Files\\Java\\jdk-25\\bin\\java.exe',
          value: settings.javaPath,
          onInput: (e) => { settings.javaPath = e.target.value; save(); },
        }),
        h('button', { class: 'btn btn--lg', onClick: browse }, 'Parcourir'),
      ),
    custom && systemJavaPicks(settings, save, details?.java),
    custom && details && h('p', { class: 'hint' }, `Minecraft ${version} demande Java ${details.java}. Le launcher vérifie la version avant de lancer.`),
  );
}

/** Java trouvés sur le PC (Paramètres › Java et stockage), à choisir en un clic. */
function systemJavaPicks(settings, save, required) {
  const found = state.storage.system;
  if (!found) {
    loadSystemJavas();
    return null;
  }
  if (found.length === 0) return null;
  return h(
    'div',
    { class: 'java-picks', role: 'group', 'aria-label': 'Java trouvés sur ce PC' },
    h('span', { class: 'label' }, 'Trouvés sur ce PC'),
    found.map((j) =>
      h(
        'button',
        {
          class: 'java-pick',
          'aria-pressed': settings.javaPath === j.path ? 'true' : 'false',
          title: j.path,
          onClick: () => update(() => { settings.javaPath = j.path; save(); }),
        },
        h('span', { class: 'java-pick__major' }, j.major),
        h('span', { class: 'java-pick__name' }, j.name),
        required && j.major < required && h('span', { class: 'tag tag--bad' }, 'Trop ancien'),
      ),
    ),
  );
}

function numberField(id, label, ctx, key) {
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'label', for: id }, label),
    h('input', {
      id,
      class: 'input input--mono',
      type: 'number',
      min: key === 'width' ? 320 : 240,
      max: 7680,
      value: ctx.settings[key],
      onInput: (e) => {
        const value = Number.parseInt(e.target.value, 10);
        if (Number.isInteger(value) && value >= 240) {
          ctx.settings[key] = value;
          ctx.save();
        }
      },
    }),
  );
}

function windowSection(ctx) {
  const { settings, save } = ctx;
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'win-title' },
    h('h2', { class: 'settings__title', id: 'win-title' }, 'Fenêtre du jeu'),
    h(
      'div',
      { class: 'resolution' },
      numberField('res-w', 'Largeur', ctx, 'width'),
      h('span', { class: 'resolution__x', 'aria-hidden': 'true' }, '×'),
      numberField('res-h', 'Hauteur', ctx, 'height'),
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'fs-label' }, 'Plein écran'),
      h('button', {
        class: 'toggle',
        'aria-labelledby': 'fs-label',
        'aria-pressed': settings.fullscreen ? 'true' : 'false',
        onClick: () => update(() => { settings.fullscreen = !settings.fullscreen; save(); }),
      }),
    ),
  );
}

function advancedSection({ settings, save }) {
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'adv-title' },
    h('h2', { class: 'settings__title', id: 'adv-title' }, 'Avancé'),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: 'jvm-args' }, 'Arguments JVM supplémentaires'),
      h('input', {
        id: 'jvm-args',
        class: 'input input--mono',
        type: 'text',
        placeholder: '-XX:+UseZGC',
        spellcheck: 'false',
        value: settings.jvmArgs,
        onInput: (e) => { settings.jvmArgs = e.target.value; save(); },
      }),
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'lowram-label' }, 'Avertir si la RAM libre est trop faible'),
      h('button', {
        class: 'toggle',
        'aria-labelledby': 'lowram-label',
        'aria-pressed': settings.lowRamWarning ? 'true' : 'false',
        onClick: () => update(() => { settings.lowRamWarning = !settings.lowRamWarning; save(); }),
      }),
    ),
  );
}

function afterLaunchSection({ settings, save }) {
  return h(
    'section',
    { class: 'settings__section settings__section--wide', 'aria-labelledby': 'after-title' },
    h(
      'div',
      { style: 'flex:1;min-width:240px;display:flex;flex-direction:column;gap:4px' },
      h('h2', { class: 'settings__title', id: 'after-title' }, 'Après le lancement'),
      h('p', { class: 'hint', style: 'font-size:13px' }, 'Le launcher revient quand tu quittes Minecraft.'),
    ),
    h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'after-title' },
      AFTER_LAUNCH.map((o) =>
        h(
          'button',
          { role: 'radio', 'aria-checked': settings.afterLaunch === o.id ? 'true' : 'false', onClick: () => update(() => { settings.afterLaunch = o.id; save(); }) },
          o.label,
        ),
      ),
    ),
  );
}

export function renderSettings() {
  const instance = selectedInstance();
  const scope = instance || state.settingsScope !== 'instance' ? state.settingsScope : 'global';
  const tab = (id, label) =>
    h('button', { role: 'tab', 'aria-selected': scope === id ? 'true' : 'false', onClick: () => update((s) => { s.settingsScope = id; }) }, label);
  const head = h(
    'div',
    { class: 'settings__head' },
    h('button', { class: 'btn btn--ghost', onClick: () => go('home') }, icon('back'), 'Retour'),
    h('h1', { class: 'page__title', style: 'font-size:28px' }, 'Paramètres'),
    h(
      'div',
      { class: 'segmented', role: 'tablist', 'aria-label': 'Rubriques des paramètres' },
      instance && tab('instance', `Instance ${instance.name}`),
      tab('global', 'Global'),
      tab('launcher', 'Launcher'),
      tab('storage', 'Java et stockage'),
    ),
    scope !== 'storage' && h('span', { class: 'settings__saved' }, 'Enregistré automatiquement'),
  );
  if (scope === 'launcher') return h('div', { class: 'page' }, head, renderLauncherTab());
  if (scope === 'storage') return h('div', { class: 'page' }, head, renderStorageTab());
  if (scope === 'global' && !state.globalSettings) return h('div', { class: 'page' }, 'Chargement…');
  const ctx =
    scope === 'instance'
      ? { settings: instance.settings, save: () => saveSettings('instance', instance.id) }
      : { settings: state.globalSettings, save: () => saveSettings('global') };

  return h(
    'div',
    { class: 'page' },
    head,
    h(
      'p',
      { class: 'settings__scope-note' },
      scope === 'instance' ? blockIcon(instance.icon, 'block--sm') : icon('settings', 20),
      scope === 'instance'
        ? `Ces réglages s'appliquent seulement à l'instance ${instance.name}. Ils prennent effet au prochain lancement.`
        : 'Réglages par défaut, copiés dans chaque nouvelle instance.',
    ),
    h(
      'div',
      { class: 'settings__grid' },
      memorySection(ctx, scope === 'instance' ? instance : null),
      javaSection(ctx, scope === 'instance' ? instance.version : null),
      ...Object.values(performanceSections(ctx, scope === 'instance' ? instance : null)).filter(Boolean),
      windowSection(ctx),
      advancedSection(ctx),
      afterLaunchSection(ctx),
    ),
  );
}
