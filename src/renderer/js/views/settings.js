// Paramètres : réglages de l'instance sélectionnée ou réglages globaux (utilisés par les nouvelles instances).
import { t } from '../i18n.js';
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
import { titleMenuSection } from './title-menu.js';
import { OS } from '../os.js';

// Exemple de chemin Java selon le système.
const JAVA_EXAMPLE = {
  windows: 'C:\\Program Files\\Java\\jdk-25\\bin\\java.exe',
  mac: '/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home/bin/java',
  linux: '/usr/lib/jvm/java-25-openjdk/bin/java',
};

const AFTER_LAUNCH = [
  { id: 'keep', get label() { return t('settings.rester_ouvert'); } },
  { id: 'minimize', get label() { return t('settings.reduire'); } },
  { id: 'hide', get label() { return t('settings.masquer'); } },
];

function ramHint(ram, guide) {
  if (!guide) return { warn: false, text: '' };
  const verdict = ramVerdict(ram, guide, state.memory.freeGb);
  return { warn: verdict.level !== 'ok', text: t('settings.conseille', { title: verdict.title, text: verdict.text, guide: ramRange(guide) }) };
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
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'ram-title' }, t('common.memoire')), value),
    h('label', { class: 'visually-hidden', for: 'ram' }, t('settings.memoire_maximale_en_go')),
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
      h('span', null, formatGo(1)),
      h('span', { title: guide?.pc.detail ?? null }, t('settings.ram_free', { pc: guide?.pc.summary ?? formatGo(Math.round(state.memory.totalGb)), free: formatGo(state.memory.freeGb.toFixed(1)) })),
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
      toastError(t('settings.choix_de_java_impossible'), error);
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
          h('span', { class: 'option__title' }, t('common.automatique')),
          h('span', { class: 'option__detail' }, details ? t('settings.java_runtime_mojang_pour', { java: details.java, version }) : t('settings.le_bon_java_pour_chaque')),
        ),
        h('span', { class: 'tag tag--ok' }, t('settings.recommande')),
      ),
      h(
        'button',
        { class: 'option', role: 'radio', 'aria-checked': custom ? 'true' : 'false', onClick: () => choose('custom') },
        h('span', { class: 'option__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'option__body' }, h('span', { class: 'option__title' }, t('common.personnalise')), h('span', { class: 'option__detail' }, t('settings.un_java_deja_installe_sur'))),
      ),
    ),
    custom &&
      h(
        'div',
        { class: 'input-row' },
        h('label', { class: 'visually-hidden', for: 'java-path' }, t('settings.chemin_de_java')),
        h('input', {
          id: 'java-path',
          class: 'input input--mono',
          type: 'text',
          spellcheck: 'false',
          placeholder: JAVA_EXAMPLE[OS],
          value: settings.javaPath,
          onInput: (e) => { settings.javaPath = e.target.value; save(); },
        }),
        h('button', { class: 'btn btn--lg', onClick: browse }, t('settings.parcourir')),
      ),
    custom && java32Notice(settings, choose),
    custom && systemJavaPicks(settings, save, details?.java),
    custom && details && h('p', { class: 'hint' }, t('settings.minecraft_demande_java_le_launcher', { version, java: details.java })),
  );
}

/** Version et 32/64 bits d'un Java personnalisé (java -version, lancé une fois par chemin). */
function javaProbe(file) {
  if (!file) return null;
  if (!(file in state.javaProbes)) {
    state.javaProbes[file] = { loading: true };
    api.probeJava(file).then(
      (info) => update((s) => { s.javaProbes[file] = info; }),
      () => update((s) => { s.javaProbes[file] = null; }),
    );
  }
  return state.javaProbes[file];
}

/** Java 32 bits avec plus de mémoire qu'il ne peut en prendre : dit tout de suite, avec la solution. */
function java32Notice(settings, choose) {
  const probe = javaProbe(settings.javaPath);
  if (probe?.bits !== 32) return null;
  return h(
    'div',
    { class: 'notice notice--warn', role: 'status' },
    icon('alert'),
    h(
      'span',
      null,
      h('strong', null, t('settings.java_32_bits')),
      ' ',
      settings.ram > 1.5 ? t('settings.java_32_bits_trop', { ram: formatGo(settings.ram) }) : t('settings.java_32_bits_limite'),
      h('span', { class: 'notice__actions' }, h('button', { class: 'btn btn--sm', onClick: () => choose('auto') }, t('settings.repasser_java_automatique'))),
    ),
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
    { class: 'java-picks', role: 'group', 'aria-label': t('settings.java_trouves_sur_ce_pc') },
    h('span', { class: 'label' }, t('settings.trouves_sur_ce_pc')),
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
        required && j.major < required && h('span', { class: 'tag tag--bad' }, t('settings.trop_ancien')),
        j.bits === 32 && h('span', { class: 'tag tag--bad' }, t('settings.bits_32')),
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
    h('h2', { class: 'settings__title', id: 'win-title' }, t('settings.fenetre_du_jeu')),
    h(
      'div',
      { class: 'resolution' },
      numberField('res-w', t('settings.largeur'), ctx, 'width'),
      h('span', { class: 'resolution__x', 'aria-hidden': 'true' }, '×'),
      numberField('res-h', t('settings.hauteur'), ctx, 'height'),
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'fs-label' }, t('settings.plein_ecran')),
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
    h('h2', { class: 'settings__title', id: 'adv-title' }, t('settings.avance')),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'label', for: 'jvm-args' }, t('settings.arguments_jvm_supplementaires')),
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
      h('span', { id: 'lowram-label' }, t('settings.avertir_si_la_ram_libre')),
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
      h('h2', { class: 'settings__title', id: 'after-title' }, t('settings.apres_le_lancement')),
      // « Masquer » ferme l'interface pendant la partie (avec le mode léger et l'icône près de l'horloge).
      h('p', { class: 'hint', style: 'font-size:13px' }, settings.afterLaunch === 'hide' ? t('settings.masquer_ferme_interface') : t('settings.le_launcher_revient_quand_tu')),
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

const LAUNCH_BACKUP = [
  { id: 'never', get label() { return t('settings.jamais'); } },
  { id: 'hardcore', get label() { return t('settings.hardcore_seulement'); } },
  { id: 'always', get label() { return t('settings.toujours'); } },
];

/** Sauvegardes automatiques des mondes : avant les changements risqués, à chaque lancement, et combien en garder. */
function worldBackupSection({ settings, save }) {
  const set = (key, value) => update(() => { settings[key] = value; save(); });
  return h(
    'section',
    { class: 'settings__section settings__section--wide', 'aria-labelledby': 'backup-title', style: 'flex-direction:column;align-items:stretch;gap:12px' },
    h('div', null, h('h2', { class: 'settings__title', id: 'backup-title' }, t('settings.sauvegardes_des_mondes')), h('p', { class: 'hint', style: 'font-size:13px;margin:4px 0 0' }, t('settings.sauvegardes_des_mondes_detail'))),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'backup-auto-label' }, t('settings.avant_les_changements_risques')),
      h('button', { class: 'toggle', 'aria-labelledby': 'backup-auto-label', 'aria-pressed': settings.backupAuto ? 'true' : 'false', onClick: () => set('backupAuto', !settings.backupAuto) }),
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'backup-launch-label' }, t('settings.a_chaque_lancement')),
      h(
        'div',
        { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'backup-launch-label' },
        LAUNCH_BACKUP.map((o) => h('button', { role: 'radio', 'aria-checked': settings.backupLaunch === o.id ? 'true' : 'false', onClick: () => set('backupLaunch', o.id) }, o.label)),
      ),
    ),
    h(
      'div',
      { class: 'toggle-row' },
      h('label', { for: 'backup-keep' }, t('settings.sauvegardes_auto_gardees')),
      h('input', {
        id: 'backup-keep',
        class: 'input',
        type: 'number',
        min: 1,
        max: 20,
        style: 'width:84px',
        value: String(settings.backupKeep),
        onChange: (e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n)) set('backupKeep', Math.min(20, Math.max(1, n)));
        },
      }),
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
    h('button', { class: 'btn btn--ghost', onClick: () => go('home') }, icon('back'), t('common.retour')),
    h('h1', { class: 'page__title', style: 'font-size:28px' }, t('common.parametres')),
    h(
      'div',
      { class: 'segmented', role: 'tablist', 'aria-label': t('settings.rubriques_des_parametres') },
      instance && tab('instance', t('common.instance_2', { name: instance.name })),
      tab('global', 'Global'),
      tab('launcher', 'Launcher'),
      tab('storage', t('settings.java_et_stockage')),
    ),
    scope !== 'storage' && h('span', { class: 'settings__saved' }, t('settings.enregistre_automatiquement')),
  );
  if (scope === 'launcher') return h('div', { class: 'page' }, head, renderLauncherTab());
  if (scope === 'storage') return h('div', { class: 'page' }, head, renderStorageTab());
  if (scope === 'global' && !state.globalSettings) return h('div', { class: 'page' }, t('common.chargement'));
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
        ? t('settings.ces_reglages_appliquent_seulement_instance', { name: instance.name })
        : t('settings.reglages_par_defaut_copies_dans'),
    ),
    h(
      'div',
      { class: 'settings__grid' },
      memorySection(ctx, scope === 'instance' ? instance : null),
      javaSection(ctx, scope === 'instance' ? instance.version : null),
      ...Object.values(performanceSections(ctx, scope === 'instance' ? instance : null)).filter(Boolean),
      scope === 'instance' && titleMenuSection(instance),
      windowSection(ctx),
      advancedSection(ctx),
      afterLaunchSection(ctx),
      worldBackupSection(ctx),
    ),
  );
}
