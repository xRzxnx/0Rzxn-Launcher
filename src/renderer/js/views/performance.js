// Performances : sections des paramètres (instance, global, launcher) et fenêtre « Pack Performances ».
import { formatGo, h, icon } from '../dom.js';
import { chosenPackMods, installPack, loadGpu, openPack, perfPreview, setGpu, togglePackMod, watchMetrics } from '../perf-actions.js';
import { setLauncherPref } from '../launcher-actions.js';
import { state, update } from '../state.js';
import { close, dialog } from './modals.js';

const GC_LABELS = { zgc: 'ZGC générationnel', g1: 'G1 réglé pour le jeu', none: 'celui de Java par défaut' };

function presetDetail(id, preview, settings) {
  const java = preview?.javaMajor;
  if (id === 'auto') {
    if (!java) return 'ZGC AVEC JAVA 21+, 8 THREADS ET 6 GO · SINON G1 RÉGLÉ';
    if (preview.gc === 'zgc') return `JAVA ${java} · ${java >= 25 ? 'ZGC + EN-TÊTES COMPACTS' : 'ZGC GÉNÉRATIONNEL'}`;
    // Pourquoi pas ZGC : le premier critère manquant.
    const why = java < 21 ? '' : preview.cpus < 8 ? ` (ZGC DEMANDE 8 THREADS, ICI ${preview.cpus})` : settings.ram < 6 ? ' (ZGC À PARTIR DE 6 GO)' : '';
    return `JAVA ${java} · G1 RÉGLÉ POUR LE JEU${why}`;
  }
  if (id === 'g1') return 'PAUSES COURTES, PEU DE PROCESSEUR · TOUS LES JAVA';
  if (id === 'zgc') return java && java < 21 ? `DEMANDE JAVA 21 OU PLUS (ICI JAVA ${java}) : G1 SERA UTILISÉ` : 'PAUSES QUASI NULLES, UN PEU PLUS DE RAM ET DE PROCESSEUR';
  return java === 8 ? 'COMME AVANT · JAVA 8 UTILISE PARALLEL GC : SACCADES' : 'COMME AVANT · AUCUN RÉGLAGE AJOUTÉ';
}

function gcHint(settings, preview) {
  if (preview?.userGc) return { warn: true, text: 'Tes arguments JVM (section Avancé) choisissent déjà un ramasse-miettes : le launcher n’en ajoute pas.' };
  if (settings.jvmPreset === 'none') return { warn: false, text: 'Le launcher n’ajoute rien. Tes arguments de la section Avancé restent envoyés.' };
  if (preview?.javaMajor === 8) return { warn: false, text: 'Java 8 (Minecraft 1.16 et avant) fige le jeu par moments avec son réglage par défaut : G1 réglé corrige ça. C’est là que le gain se voit le plus.' };
  return { warn: false, text: 'Les FPS moyens bougent peu ; ce sont surtout les petites saccades qui disparaissent. Tes arguments de la section Avancé passent après et gardent le dernier mot.' };
}

function javaArgsSection({ settings, save }, preview) {
  const choose = (id) => update(() => { settings.jvmPreset = id; save(); });
  const presets = [
    { id: 'auto', title: 'Automatique', tag: 'Recommandé' },
    { id: 'g1', title: 'G1 réglé' },
    { id: 'zgc', title: 'ZGC générationnel' },
    { id: 'none', title: 'Java par défaut' },
  ];
  const hint = gcHint(settings, preview);
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'gc-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'gc-title' }, 'Arguments Java'), h('span', { class: 'tag tag--beta' }, 'Moins de saccades')),
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
        h('span', { class: 'label' }, preview.javaMajor ? 'Envoyé à Java' : 'Envoyé à Java (exemple avec Java 21)'),
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
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'ram-advice-title' }, 'Mémoire conseillée'), h('span', { class: 'ram-value' }, ram ? formatGo(ram) : '…')),
    ram &&
      h(
        'p',
        { class: 'perf-text' },
        `Tu as réglé ${formatGo(settings.ram)}. ${mods ? `Avec ${mods} mod${mods > 1 ? 's' : ''}` : 'Sans mods'}, ${formatGo(ram)} suffisent${settings.ram > ram ? ' : plus de mémoire ne donne pas plus de FPS.' : '.'}`,
      ),
    h(
      'div',
      null,
      h('button', { class: `btn${applied ? '' : ' btn--primary'}`, disabled: !ram || applied, onClick: () => update(() => { settings.ram = ram; save(); }) }, applied ? 'Déjà appliqué' : `Mettre ${ram ? formatGo(ram) : '…'}`),
    ),
    h('p', { class: 'hint' }, `Calcul : base du loader, nombre de mods, marge si tu imposes ZGC, au plus la moitié de la RAM du PC (${formatGo(Math.round(state.memory.totalGb))}).`),
  );
}

function prioritySection({ settings, save }) {
  const options = [
    { id: 'normal', label: 'Normale' },
    { id: 'above', label: 'Au-dessus de la normale' },
  ];
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'prio-title' },
    h('h2', { class: 'settings__title', id: 'prio-title' }, 'Priorité du jeu'),
    h(
      'div',
      { class: 'segmented segmented--fill', role: 'radiogroup', 'aria-labelledby': 'prio-title' },
      options.map((o) =>
        h('button', { role: 'radio', 'aria-checked': settings.priority === o.id ? 'true' : 'false', onClick: () => update(() => { settings.priority = o.id; save(); }) }, o.label),
      ),
    ),
    h('p', { class: 'hint' }, 'Gain faible : Windows donne la main au jeu quand un autre programme charge le processeur (compilation, navigateur, enregistrement). Sinon, rien ne change.'),
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
      h('h2', { class: 'settings__title', id: 'pack-card-title' }, "Mods d'optimisation"),
      h('span', { class: 'hint' }, vanilla ? 'Le plus gros gain de FPS. Il faut passer l’instance en Fabric.' : `Le plus gros gain de FPS. ${count ? `${count} mod${count > 1 ? 's' : ''} du pack déjà installé${count > 1 ? 's' : ''}.` : 'Aucun installé.'}`),
    ),
    h('button', { class: 'btn btn--primary', disabled: Boolean(state.run?.instanceId === instance.id), onClick: () => openPack(instance) }, 'Pack Performances'),
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

const IMPACTS = {
  fps: ['Gros gain FPS', 'tag--ok'],
  fps2: ['FPS · scènes chargées', 'tag--ok'],
  tick: ['Logique du jeu', 'tag--beta'],
  ram: ['Mémoire', 'tag--release'],
  start: ['Démarrage', 'tag--release'],
  eco: ['Économie', 'tag--warn'],
};

function packRow(mod, modal) {
  const usable = mod.state === 'available';
  const [label, cls] = usable ? IMPACTS[mod.impact] : mod.state === 'installed' ? ['Installé', 'tag--ok'] : mod.state === 'conflict' ? ['Équivalent présent', 'tag--warn'] : ['Pas pour cette version', 'tag--muted'];
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
  if (modal.loading) body = h('p', { class: 'hint' }, 'Recherche des mods compatibles sur Modrinth…');
  else if (modal.error) body = h('p', { class: 'hint hint--error' }, `Modrinth injoignable : ${modal.error}`);
  else
    body = [
      vanilla &&
        h(
          'div',
          { class: 'perf-callout' },
          h('strong', null, "Les mods ont besoin d'un loader"),
          h('span', null, `${instance.name} est en vanilla. Le launcher la passe en Fabric (version recommandée), puis installe le pack. Mondes, réglages et packs de ressources restent ; tu peux revenir en vanilla depuis « Modifier ».`),
        ),
      none &&
        h(
          'div',
          { class: 'perf-callout perf-callout--warn' },
          h('strong', null, `Rien pour ${instance.loader === 'forge' ? 'Forge' : instance.loader} ${instance.version}`),
          h('span', null, "Aucun mod d'optimisation n'est publié pour cette version sur Modrinth. Les arguments Java réglés s'appliquent quand même."),
        ),
      h('div', { class: 'cleanup' }, data.mods.map((m) => packRow(m, modal))),
      h('p', { class: 'hint' }, 'Depuis Modrinth, avec leurs dépendances. Les mods déjà présents, ou un équivalent comme OptiFine, sont sautés.'),
    ];
  const label = vanilla ? `Passer en Fabric et installer ${chosen.length} mod${chosen.length > 1 ? 's' : ''}` : chosen.length ? `Installer ${chosen.length} mod${chosen.length > 1 ? 's' : ''}` : 'Rien à installer';
  return dialog({
    title: 'Pack Performances',
    labelId: 'pack-title',
    size: 'dialog--wide',
    body: [h('p', { class: 'label', style: 'margin:0 0 10px' }, `${instance.name} · ${instance.loader === 'vanilla' ? 'Vanilla' : instance.loader} · Minecraft ${instance.version}`), body],
    foot: [
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--primary btn--lg', disabled: !chosen.length || Boolean(state.task), onClick: () => installPack(modal) }, label),
    ],
  });
}

// ---------- Paramètres › Launcher ----------

const fr = (n, digits = 1) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits });

export function gameSection(prefs) {
  watchMetrics();
  const m = state.perf.metrics;
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'light-title' },
    h('h2', { class: 'settings__title', id: 'light-title' }, 'Pendant une partie'),
    h(
      'div',
      { class: 'toggle-row' },
      h('span', { id: 'light-label' }, 'Mode léger : le launcher se met en veille'),
      h('button', { class: 'toggle', 'aria-labelledby': 'light-label', 'aria-pressed': prefs.lightMode ? 'true' : 'false', onClick: () => setLauncherPref({ lightMode: !prefs.lightMode }) }),
    ),
    h(
      'ul',
      { class: 'perf-list' },
      h('li', null, "Fenêtre réduite ou masquée : l'interface ne se redessine plus."),
      h('li', null, "Les logs du jeu sont gardés et s'affichent quand tu reviens."),
      h('li', null, 'Toujours : la console ne dessine que les 500 dernières lignes, et rien n’est redessiné pour les logs hors de la console.'),
    ),
    h(
      'div',
      { class: 'perf-metrics' },
      h('span', { class: 'label' }, m?.running ? 'Le launcher pendant ta partie' : 'Le launcher en ce moment'),
      h(
        'div',
        { class: 'perf-metrics__grid' },
        h('span', null, h('strong', null, m ? `${fr(m.cpu)} %` : '…'), h('span', null, 'du processeur')),
        h('span', null, h('strong', null, m ? `${fr(m.memoryMb, 0)} Mo` : '…'), h('span', null, 'de mémoire')),
      ),
    ),
    h('p', { class: 'hint' }, 'Gain modeste en FPS : le jeu et le launcher tournent sur des cœurs différents. Ça compte surtout sur un PC de 4 cœurs ou moins.'),
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
  else if (!choice) chip = h('span', { class: 'tag tag--ok' }, 'Rien à faire');
  else chip = on ? h('span', { class: 'tag tag--ok' }, 'Carte dédiée') : h('span', { class: 'tag tag--muted' }, 'Choix de Windows');

  let body;
  if (!g) body = h('p', { class: 'hint' }, 'Détection des cartes graphiques…');
  else if (!g.gpus.length) body = h('p', { class: 'hint' }, 'Cartes graphiques non détectées.');
  else if (!choice)
    body = h('p', { class: 'perf-text' }, g.gpus.length === 1 ? "C'est la seule carte graphique de ce PC : le jeu l'utilise déjà. Rien à régler." : 'Aucune puce intégrée : le jeu utilise déjà une carte dédiée. Rien à régler.');
  else if (on)
    body = [
      h('p', { class: 'perf-text' }, `${dedicated[0].name} choisie pour ${g.high} Java du launcher. Les nouveaux Java téléchargés la reçoivent aussi.`),
      h('div', null, h('button', { class: 'btn', disabled: state.perf.gpuBusy, onClick: () => setGpu(false) }, 'Revenir au choix de Windows')),
    ];
  else
    body = [
      h('p', { class: 'perf-text' }, 'Sur un portable, Windows peut lancer Java sur la puce intégrée, bien plus lente.'),
      h('div', null, h('button', { class: 'btn btn--primary', disabled: state.perf.gpuBusy, onClick: () => update((s) => { s.modal = { type: 'gpu-confirm', name: dedicated[0].name, javas: g.javas }; }) }, `Utiliser ${dedicated[0].name} pour Minecraft…`)),
    ];
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'gpu-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'gpu-title' }, 'Carte graphique'), chip),
    g?.gpus.length > 0 && h('ul', { class: 'perf-gpus' }, g.gpus.map((x) => h('li', null, h('span', null, x.name), h('span', { class: 'label' }, x.integrated ? 'Intégrée' : 'Dédiée')))),
    body,
  );
}

export function gpuConfirmDialog(modal) {
  return dialog({
    title: 'Modifier un réglage de Windows ?',
    labelId: 'gpu-confirm-title',
    size: 'dialog--small',
    body: h(
      'p',
      { class: 'perf-text' },
      `Le launcher écrit « Hautes performances » pour ses ${modal.javas} java.exe dans tes préférences graphiques Windows (le même réglage que Paramètres › Affichage › Graphiques). Rien d'autre n'est touché, et tu peux revenir en arrière depuis cette page.`,
    ),
    foot: [h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'), h('button', { class: 'btn btn--primary btn--lg', onClick: () => setGpu(true) }, 'Oui, modifier')],
  });
}
