// Performances : sections des paramètres (instance, global, launcher) et fenêtre « Pack Performances ».
import { num, t } from '../i18n.js';
import { formatGo, h, icon } from '../dom.js';
import { chosenPackMods, installPack, loadGpu, openPack, perfPreview, setGpu, togglePackMod, watchMetrics } from '../perf-actions.js';
import { setLauncherPref } from '../launcher-actions.js';
import { state, update } from '../state.js';
import { close, dialog } from './modals.js';

const GC_LABELS = { get zgc() { return t('performance.zgc_generationnel'); }, get g1() { return t('performance.g1_regle_pour_le_jeu'); }, get none() { return t('performance.celui_de_java_par_defaut'); } };

function presetDetail(id, preview, settings) {
  const java = preview?.javaMajor;
  if (id === 'auto') {
    if (!java) return t('performance.zgc_avec_java_21_threads');
    if (preview.gc === 'zgc') return `Java ${java} · ${java >= 25 ? t('performance.zgc_en_tetes_compacts') : t('performance.zgc_generationnel')}`;
    // Pourquoi pas ZGC : le premier critère manquant.
    const why = java < 21 ? '' : preview.cpus < 8 ? t('performance.zgc_demande_threads_ici', { cpus: preview.cpus }) : settings.ram < 6 ? t('performance.zgc_partir_de_go') : '';
    return t('performance.java_g1_regle_pour_le', { java, why });
  }
  if (id === 'g1') return t('performance.pauses_courtes_peu_de_processeur');
  if (id === 'zgc') return java && java < 21 ? t('performance.demande_java_21_ou_plus', { java }) : t('performance.pauses_quasi_nulles_un_peu');
  return java === 8 ? t('performance.comme_avant_java_utilise_parallel') : t('performance.comme_avant_aucun_reglage_ajoute');
}

function gcHint(settings, preview) {
  if (preview?.userGc) return { warn: true, text: t('performance.tes_arguments_jvm_section_avance') };
  if (settings.jvmPreset === 'none') return { warn: false, text: t('performance.le_launcher_ajoute_rien_tes') };
  if (preview?.javaMajor === 8) return { warn: false, text: t('performance.java_minecraft_16_et_avant') };
  return { warn: false, text: t('performance.les_fps_moyens_bougent_peu') };
}

function javaArgsSection({ settings, save }, preview) {
  const choose = (id) => update(() => { settings.jvmPreset = id; save(); });
  const presets = [
    { id: 'auto', title: t('common.automatique'), tag: t('settings.recommande') },
    { id: 'g1', title: t('performance.g1_regle') },
    { id: 'zgc', title: t('performance.zgc_generationnel') },
    { id: 'none', title: t('performance.java_par_defaut') },
  ];
  const hint = gcHint(settings, preview);
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'gc-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'gc-title' }, t('performance.arguments_java')), h('span', { class: 'tag tag--beta' }, t('performance.moins_de_saccades'))),
    h(
      'div',
      { role: 'radiogroup', 'aria-labelledby': 'gc-title', style: 'display:flex;flex-direction:column;gap:6px' },
      presets.map((p) =>
        h(
          'button',
          { class: 'option', role: 'radio', 'aria-checked': settings.jvmPreset === p.id ? 'true' : 'false', onClick: () => choose(p.id) },
          h('span', { class: 'option__dot', 'aria-hidden': 'true' }),
          h('span', { class: 'option__body' }, h('span', { class: 'option__title' }, p.title), h('span', { class: 'option__detail' }, presetDetail(p.id, preview, settings))),
          p.tag && h('span', { class: 'tag tag--ok' }, p.tag),
        ),
      ),
    ),
    preview &&
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'label' }, preview.javaMajor ? t('performance.envoye_java') : t('performance.envoye_java_exemple_avec_java')),
        h('code', { class: 'perf-args' }, [...preview.args, settings.jvmArgs.trim()].filter(Boolean).join(' ')),
      ),
    h('p', { class: `hint${hint.warn ? ' hint--warn' : ''}` }, hint.text),
  );
}

function ramAdviceSection({ settings, save }, preview) {
  const ram = preview?.ram;
  const applied = ram != null && settings.ram === ram;
  const mods = preview?.mods ?? 0;
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'ram-advice-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'ram-advice-title' }, t('common.memoire_conseillee')), h('span', { class: 'ram-value' }, ram ? formatGo(ram) : '…')),
    ram &&
      h(
        'p',
        { class: 'perf-text' },
        [t('performance.ram_set', { ram: formatGo(settings.ram) }), mods ? t('performance.ram_with_mods', { count: mods, ram: formatGo(ram) }) : t('performance.ram_no_mods', { ram: formatGo(ram) }), settings.ram > ram && t('performance.ram_more_useless')].filter(Boolean).join(' '),
      ),
    h(
      'div',
      null,
      h('button', { class: `btn${applied ? '' : ' btn--primary'}`, disabled: !ram || applied, onClick: () => update(() => { settings.ram = ram; save(); }) }, applied ? t('performance.deja_applique') : t('performance.mettre', { value: ram ? formatGo(ram) : '…' })),
    ),
    h('p', { class: 'hint' }, t('performance.calcul_loader_nombre_de_mods', { pc: preview?.pc ?? formatGo(Math.round(state.memory.totalGb)) })),
  );
}

function prioritySection({ settings, save }) {
  const options = [
    { id: 'normal', label: t('performance.normale') },
    { id: 'above', label: t('performance.au_dessus_de_la_normale') },
  ];
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'prio-title' },
    h('h2', { class: 'settings__title', id: 'prio-title' }, t('performance.priorite_du_jeu')),
    h(
      'div',
      { class: 'segmented segmented--fill', role: 'radiogroup', 'aria-labelledby': 'prio-title' },
      options.map((o) =>
        h('button', { role: 'radio', 'aria-checked': settings.priority === o.id ? 'true' : 'false', onClick: () => update(() => { settings.priority = o.id; save(); }) }, o.label),
      ),
    ),
    h('p', { class: 'hint' }, t('performance.gain_faible_windows_donne_la')),
  );
}

function packCard(instance, preview) {
  const vanilla = instance.loader === 'vanilla';
  const count = preview?.packInstalled ?? 0;
  return h(
    'section',
    { class: 'settings__section perf-pack-card', 'aria-labelledby': 'pack-card-title' },
    h('span', { class: 'perf-bolt', 'aria-hidden': 'true' }, icon('bolt')),
    h(
      'span',
      { class: 'perf-pack-card__body' },
      h('h2', { class: 'settings__title', id: 'pack-card-title' }, t('performance.mods_optimisation')),
      h('span', { class: 'hint' }, vanilla ? t('performance.le_plus_gros_gain_de') : t(count ? 'performance.pack_count' : 'performance.pack_none', { count })),
    ),
    h('button', { class: 'btn btn--primary', disabled: Boolean(state.run?.instanceId === instance.id), onClick: () => openPack(instance) }, t('common.pack_performances')),
  );
}

/** Sections « Performances » des paramètres d'une instance (ou des réglages globaux, sans `instance`). */
export function performanceSections(ctx, instance) {
  const preview = perfPreview(instance?.id ?? null, ctx.settings);
  return {
    javaArgs: javaArgsSection(ctx, preview),
    ram: instance ? ramAdviceSection(ctx, preview) : null,
    priority: prioritySection(ctx),
    pack: instance ? packCard(instance, preview) : null,
  };
}

// ---------- Fenêtre Pack Performances ----------

const IMPACTS = () => ({
  fps: [t('performance.gros_gain_fps'), 'tag--ok'],
  fps2: [t('performance.fps_scenes_chargees'), 'tag--ok'],
  tick: [t('performance.logique_du_jeu'), 'tag--beta'],
  ram: [t('common.memoire'), 'tag--release'],
  start: [t('performance.demarrage'), 'tag--release'],
  eco: [t('performance.economie'), 'tag--warn'],
});

function packRow(mod, modal) {
  const usable = mod.state === 'available';
  const [label, cls] = usable ? IMPACTS()[mod.impact] : mod.state === 'installed' ? [t('common.installe'), 'tag--ok'] : mod.state === 'conflict' ? [t('performance.equivalent_present'), 'tag--warn'] : [t('performance.pas_pour_cette_version'), 'tag--muted'];
  return h(
    'label',
    { class: `cleanup__item${usable ? '' : ' cleanup__item--empty'}` },
    h('input', { type: 'checkbox', checked: usable && modal.picked[mod.slug], disabled: !usable, onChange: () => togglePackMod(mod.slug) }),
    h('span', { class: 'cleanup__body' }, h('span', { class: 'cleanup__label' }, mod.title), h('span', { class: 'cleanup__detail' }, mod.note ?? mod.what)),
    h('span', { class: `tag ${cls}` }, label),
  );
}

export function packDialog(modal) {
  const instance = state.instances.find((i) => i.id === modal.instanceId);
  if (!instance) return null;
  const data = modal.data;
  const vanilla = instance.loader === 'vanilla';
  const chosen = chosenPackMods(modal);
  const none = data && !data.mods.some((m) => m.state !== 'unavailable');
  let body;
  if (modal.loading) body = h('p', { class: 'hint' }, t('performance.recherche_des_mods_compatibles_sur'));
  else if (modal.error) body = h('p', { class: 'hint hint--error' }, t('performance.modrinth_injoignable', { error: modal.error }));
  else
    body = [
      vanilla &&
        h(
          'div',
          { class: 'perf-callout' },
          h('strong', null, t('performance.les_mods_ont_besoin_un')),
          h('span', null, t('performance.est_en_vanilla_le_launcher', { name: instance.name })),
        ),
      none &&
        h(
          'div',
          { class: 'perf-callout perf-callout--warn' },
          h('strong', null, t('performance.nothing_for', { loader: instance.loader === 'forge' ? 'Forge' : instance.loader, version: instance.version })),
          h('span', null, t('performance.aucun_mod_optimisation_est_publie')),
        ),
      h('div', { class: 'cleanup' }, data.mods.map((m) => packRow(m, modal))),
      h('p', { class: 'hint' }, t('performance.depuis_modrinth_avec_leurs_dependances')),
    ];
  const label = vanilla ? t('performance.passer_en_fabric_et_installer', { count: chosen.length }) : chosen.length ? t('performance.installer_mods', { count: chosen.length }) : t('performance.rien_installer');
  return dialog({
    title: t('common.pack_performances'),
    labelId: 'pack-title',
    size: 'dialog--wide',
    body: [h('p', { class: 'label', style: 'margin:0 0 10px' }, `${instance.name} · ${instance.loader === 'vanilla' ? 'Vanilla' : instance.loader} · Minecraft ${instance.version}`), body],
    foot: [
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--primary btn--lg', disabled: !chosen.length || Boolean(state.task), onClick: () => installPack(modal) }, label),
    ],
  });
}

// ---------- Paramètres › Launcher ----------

const fixed = (n, digits = 1) => num(n, { maximumFractionDigits: digits, minimumFractionDigits: digits });

export function gameSection(prefs) {
  watchMetrics();
  const m = state.perf.metrics;
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'light-title' },
    h('h2', { class: 'settings__title', id: 'light-title' }, t('performance.pendant_une_partie')),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'light-label' }, t('performance.mode_leger_le_launcher_se')),
      h('button', { class: 'toggle', 'aria-labelledby': 'light-label', 'aria-pressed': prefs.lightMode ? 'true' : 'false', onClick: () => setLauncherPref({ lightMode: !prefs.lightMode }) }),
    ),
    h(
      'ul',
      { class: 'perf-list' },
      h('li', null, t('performance.fenetre_reduite_ou_masquee_interface')),
      h('li', null, t('performance.les_logs_du_jeu_sont')),
      h('li', null, t('performance.toujours_la_console_ne_dessine')),
    ),
    h(
      'div',
      { class: 'perf-metrics' },
      h('span', { class: 'label' }, m?.running ? t('performance.le_launcher_pendant_ta_partie') : t('performance.le_launcher_en_ce_moment')),
      h(
        'div',
        { class: 'perf-metrics__grid' },
        h('span', null, h('strong', null, m ? `${fixed(m.cpu)} %` : '…'), h('span', null, t('performance.du_processeur'))),
        h('span', null, h('strong', null, m ? `${fixed(m.memoryMb, 0)} ${t('unit.mb')}` : '…'), h('span', null, t('performance.de_memoire'))),
      ),
    ),
    h('p', { class: 'hint' }, t('performance.gain_modeste_en_fps_le')),
  );
}

export function gpuSection(prefs) {
  loadGpu();
  const g = state.perf.gpu;
  const integrated = g?.gpus.filter((x) => x.integrated) ?? [];
  const dedicated = g?.gpus.filter((x) => !x.integrated) ?? [];
  const choice = integrated.length > 0 && dedicated.length > 0;
  const on = prefs.gpuHighPerformance && g?.high > 0;
  let chip;
  if (!g) chip = h('span', { class: 'tag tag--muted' }, '…');
  else if (!choice) chip = h('span', { class: 'tag tag--ok' }, t('performance.rien_faire'));
  else chip = on ? h('span', { class: 'tag tag--ok' }, t('performance.carte_dediee')) : h('span', { class: 'tag tag--muted' }, t('performance.choix_de_windows'));

  let body;
  if (!g) body = h('p', { class: 'hint' }, t('performance.detection_des_cartes_graphiques'));
  else if (!g.gpus.length) body = h('p', { class: 'hint' }, t('performance.cartes_graphiques_non_detectees'));
  else if (!choice)
    body = h('p', { class: 'perf-text' }, g.gpus.length === 1 ? t('performance.est_la_seule_carte_graphique') : t('performance.aucune_puce_integree_le_jeu'));
  else if (on)
    body = [
      h('p', { class: 'perf-text' }, t('performance.choisie_pour_java_du_launcher', { name: dedicated[0].name, high: g.high })),
      h('div', null, h('button', { class: 'btn', disabled: state.perf.gpuBusy, onClick: () => setGpu(false) }, t('performance.revenir_au_choix_de_windows'))),
    ];
  else
    body = [
      h('p', { class: 'perf-text' }, t('performance.sur_un_portable_windows_peut')),
      h('div', null, h('button', { class: 'btn btn--primary', disabled: state.perf.gpuBusy, onClick: () => update((s) => { s.modal = { type: 'gpu-confirm', name: dedicated[0].name, javas: g.javas }; }) }, t('performance.utiliser_pour_minecraft', { name: dedicated[0].name }))),
    ];
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'gpu-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'gpu-title' }, t('performance.carte_graphique')), chip),
    g?.gpus.length > 0 && h('ul', { class: 'perf-gpus' }, g.gpus.map((x) => h('li', null, h('span', null, x.name), h('span', { class: 'label' }, x.integrated ? t('performance.integree') : t('performance.dediee'))))),
    body,
  );
}

export function gpuConfirmDialog(modal) {
  return dialog({
    title: t('performance.modifier_un_reglage_de_windows'),
    labelId: 'gpu-confirm-title',
    size: 'dialog--small',
    body: h(
      'p',
      { class: 'perf-text' },
      t('performance.le_launcher_ecrit_hautes_performances', { javas: modal.javas }),
    ),
    foot: [h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')), h('button', { class: 'btn btn--primary btn--lg', onClick: () => setGpu(true) }, t('performance.oui_modifier'))],
  });
}
