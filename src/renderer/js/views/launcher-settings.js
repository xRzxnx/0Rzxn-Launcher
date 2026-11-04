// Paramètres › Launcher (thème, Discord, zone de notification, raccourcis) et Paramètres › Java et stockage.
import { stopGame } from '../actions.js';
import { api } from '../api.js';
import { LOADER_NAMES } from '../data.js';
import { formatSize, h, icon } from '../dom.js';
import { cleanStorage, loadStorage, refreshDiscord, removeRuntime, selectedCleanup, setLauncherPref, toggleCleanup } from '../launcher-actions.js';
import { SHORTCUTS } from '../shortcuts.js';
import { ACCENTS, accentTokens, applyAccent } from '../theme.js';
import { selectedInstance, state, toastError, update } from '../state.js';
import { close, dialog } from './modals.js';
import { gameSection, gpuSection } from './performance.js';

function toggleRow(id, label, pressed, onToggle, disabled = false) {
  return h(
    'div',
    { class: `toggle-row${disabled ? ' toggle-row--off' : ''}` },
    h('span', { id }, label),
    h('button', { class: 'toggle', 'aria-labelledby': id, 'aria-pressed': pressed ? 'true' : 'false', disabled, onClick: onToggle }),
  );
}

function themeSection(prefs) {
  const custom = prefs.accent.startsWith('#');
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'theme-title' },
    h('h2', { class: 'settings__title', id: 'theme-title' }, 'Apparence'),
    h('span', { class: 'label', id: 'accent-label' }, "Couleur d'accent"),
    h(
      'div',
      { class: 'swatches', role: 'radiogroup', 'aria-labelledby': 'accent-label' },
      ACCENTS.map((a) =>
        h('button', {
          class: 'swatch',
          role: 'radio',
          'aria-checked': prefs.accent === a.id ? 'true' : 'false',
          'aria-label': a.label,
          title: a.label,
          style: `background:${accentTokens(a.id)['--accent']}`,
          onClick: () => setLauncherPref({ accent: a.id }),
        }),
      ),
      h(
        'label',
        { class: 'swatch-custom', 'aria-checked': custom ? 'true' : 'false' },
        // La couleur s'affiche pendant le choix ; elle est enregistrée à la fermeture du sélecteur.
        h('input', {
          type: 'color',
          'aria-label': 'Couleur personnalisée',
          value: custom ? prefs.accent : '#e0559b',
          onInput: (e) => applyAccent(e.target.value),
          onChange: (e) => setLauncherPref({ accent: e.target.value }),
        }),
        h('span', null, 'Perso'),
      ),
    ),
    h(
      'div',
      { class: 'theme-preview', 'aria-hidden': 'true' },
      h('span', { class: 'label' }, 'Aperçu'),
      h('span', { class: 'theme-preview__btn' }, icon('play'), 'Jouer'),
      h('span', { class: 'toggle', 'aria-pressed': 'true' }),
      h('span', { class: 'theme-preview__text' }, 'Fabric 0.17.3'),
      h('span', { class: 'tag tag--release' }, 'Prête'),
    ),
    h('p', { class: 'hint' }, 'La couleur change tout de suite. Sa luminosité est ajustée pour que les textes restent lisibles.'),
  );
}

function discordChip(prefs) {
  if (!state.discordReady) return h('span', { class: 'tag tag--muted' }, 'Non configuré');
  if (!prefs.discord) return h('span', { class: 'tag tag--muted' }, 'Désactivé');
  if (!state.discord) return h('span', { class: 'tag tag--muted' }, '…');
  return state.discord.running ? h('span', { class: 'tag tag--ok' }, 'Discord ouvert') : h('span', { class: 'tag tag--warn' }, 'Discord fermé');
}

function discordSection(prefs) {
  if (state.discord === null && prefs.discord && state.discordReady && !discordSection.loading) {
    discordSection.loading = true;
    refreshDiscord().finally(() => { discordSection.loading = false; });
  }
  const ready = state.discordReady;
  const sample = selectedInstance() ?? state.instances[0];
  const name = sample ? `${sample.name} (${sample.version})` : 'Survie (26.3)';
  const loader = sample ? LOADER_NAMES[sample.loader] : 'Vanilla';
  const on = ready && prefs.discord;
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'discord-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'discord-title' }, 'Discord'), discordChip(prefs)),
    toggleRow('rpc-label', 'Afficher ma partie sur Discord', on, () => setLauncherPref({ discord: !prefs.discord }), !ready),
    toggleRow('rpc-name-label', "Montrer le nom de l'instance", on && prefs.discordShowName, () => setLauncherPref({ discordShowName: !prefs.discordShowName }), !on),
    h(
      'div',
      { class: `discord-card${on ? '' : ' discord-card--off'}` },
      h('span', { class: 'logo discord-card__logo', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'discord-card__body' },
        h('span', { class: 'label' }, 'Ce que tes amis voient'),
        h('span', { class: 'discord-card__title' }, prefs.discordShowName ? `Joue à ${name}` : `Joue à Minecraft ${sample?.version ?? '26.3'}`),
        h('span', { class: 'discord-card__detail' }, prefs.discordShowName ? `${loader} · depuis 12 min` : 'depuis 12 min'),
      ),
    ),
    h(
      'p',
      { class: 'hint' },
      ready
        ? "Désactivé par défaut. Le launcher parle seulement à l'application Discord ouverte sur ton PC, et efface le statut quand tu quittes le jeu."
        : "Il manque l'Application ID de l'application Discord du launcher : voir docs/DISCORD.md. Rien n'est envoyé à Discord en attendant.",
    ),
  );
}

function traySection(prefs) {
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'tray-title' },
    h('h2', { class: 'settings__title', id: 'tray-title' }, 'Zone de notification'),
    toggleRow('tray-label', "Icône près de l'horloge", prefs.tray, () => setLauncherPref({ tray: !prefs.tray })),
    toggleRow('close-label', 'Fermer la fenêtre garde le launcher ouvert en arrière-plan', prefs.tray && prefs.closeToTray, () => setLauncherPref({ closeToTray: !prefs.closeToTray }), !prefs.tray),
    h(
      'p',
      { class: 'hint' },
      "Clic sur l'icône : afficher ou masquer le launcher. Clic droit : jouer à une instance récente, arrêter le jeu ou quitter. « Masquer » après le lancement utilise aussi cette icône.",
    ),
  );
}

const keys = (list) => h('span', { class: 'keys' }, list.map((k) => h('kbd', { class: 'kbd' }, k)));

function shortcutsSection() {
  const rows = SHORTCUTS.flatMap((g) => g.rows).filter((r) => !/Échap|aide|Arrêter/.test(`${r.label} ${r.keys.join(' ')}`));
  return h(
    'section',
    { class: 'settings__section settings__section--keys', 'aria-labelledby': 'keys-title' },
    h(
      'div',
      { class: 'settings__title-row' },
      h('h2', { class: 'settings__title', id: 'keys-title' }, 'Raccourcis clavier'),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => update((s) => { s.modal = { type: 'shortcuts' }; }) }, 'Tout voir · Ctrl /'),
    ),
    h('dl', { class: 'key-list' }, rows.map((r) => h('div', { class: 'key-list__row' }, h('dt', null, r.label), h('dd', null, keys(r.keys))))),
  );
}

export function renderLauncherTab() {
  const prefs = state.launcherPrefs;
  if (!prefs) return h('p', { class: 'hint' }, 'Chargement…');
  return h(
    'div',
    null,
    h('p', { class: 'settings__scope-note' }, icon('settings', 20), 'Réglages du launcher lui-même : ils valent pour toutes les instances.'),
    h('div', { class: 'settings__grid' }, themeSection(prefs), discordSection(prefs), traySection(prefs), shortcutsSection(), gameSection(prefs), gpuSection(prefs)),
  );
}

// ---------- Java et stockage ----------

const busy = () => Boolean(state.run || state.task || state.storage.busy);

function runtimeRow(r) {
  const used = r.usedBy.length > 0;
  const name = r.major ? `Java ${r.major}` : r.component;
  return h(
    'div',
    { class: 'java-row' },
    h('span', { class: 'java-row__major' }, r.major ?? '?'),
    h('span', { class: 'java-row__body' }, h('span', { class: 'java-row__name' }, name), h('span', { class: 'java-row__detail' }, `${r.component} · ${r.version ?? 'version inconnue'} · ${formatSize(r.size)}`.toUpperCase())),
    h('span', { class: `java-row__use${used ? '' : ' java-row__use--none'}` }, used ? r.usedBy.join(', ') : 'Aucune instance'),
    h('button', { class: 'icon-btn', 'aria-label': `Ouvrir le dossier de ${name}`, onClick: () => api.openRuntime(r.component).catch((e) => toastError('Dossier introuvable', e)) }, icon('folder')),
    h(
      'button',
      {
        class: 'icon-btn icon-btn--danger',
        'aria-label': used ? `${name} sert encore à ${r.usedBy.join(', ')}` : `Supprimer ${name}`,
        title: used ? `Sert encore à ${r.usedBy.join(', ')}` : busy() ? 'Indisponible pendant une partie ou une installation' : `Supprimer ${name}`,
        disabled: used || busy(),
        onClick: () => update((s) => { s.modal = { type: 'remove-runtime', runtime: r }; }),
      },
      icon('trash'),
    ),
  );
}

const PART_COLORS = { instances: 'var(--accent)', assets: 'var(--info)', libraries: 'var(--ok)', backups: 'var(--warn)', runtime: 'var(--danger)', versions: 'var(--text-3)', cache: '#5a5f83', other: 'var(--line-4)' };

function usageBlock(usage) {
  const total = usage.total || 1;
  return [
    h(
      'div',
      { class: 'disk-bar', role: 'img', 'aria-label': `Répartition de l'espace utilisé : ${usage.parts.map((p) => `${p.label} ${formatSize(p.size)}`).join(', ')}` },
      usage.parts.filter((p) => p.size > 0).map((p) => h('span', { style: `flex:${Math.max(p.size / total, 0.004)};background:${PART_COLORS[p.id]}` })),
    ),
    h(
      'ul',
      { class: 'disk-legend' },
      usage.parts.map((p) => h('li', null, h('span', { class: 'disk-legend__dot', style: `background:${PART_COLORS[p.id]}` }), h('span', { class: 'disk-legend__label' }, p.label), h('span', { class: 'disk-legend__size' }, formatSize(p.size)))),
    ),
  ];
}

function cleanupBlock(plan) {
  const chosen = selectedCleanup();
  const total = chosen.reduce((t, i) => t + i.size, 0);
  return [
    h('h3', { class: 'label disk__sub' }, 'Nettoyage'),
    h(
      'div',
      { class: 'cleanup' },
      plan.map((item) =>
        h(
          'label',
          { class: `cleanup__item${item.count ? '' : ' cleanup__item--empty'}` },
          h('input', {
            type: 'checkbox',
            checked: item.count > 0 && !state.storage.unchecked.includes(item.id),
            disabled: item.count === 0,
            onChange: () => toggleCleanup(item.id),
          }),
          h('span', { class: 'cleanup__body' }, h('span', { class: 'cleanup__label' }, item.label), h('span', { class: 'cleanup__detail' }, item.detail)),
          h('span', { class: 'cleanup__size' }, item.count ? formatSize(item.size) : '—'),
        ),
      ),
    ),
    h(
      'button',
      {
        class: 'btn btn--primary btn--lg',
        disabled: chosen.length === 0 || busy(),
        onClick: () => update((s) => { s.modal = { type: 'clean-storage', items: chosen }; }),
      },
      chosen.length ? `Libérer ${formatSize(total)}` : 'Rien à libérer',
    ),
    h(
      'p',
      { class: 'hint' },
      state.run ? 'Ferme le jeu pour faire le ménage.' : 'Tout se retélécharge si une instance en a besoin. Tes mondes, mods, captures et sauvegardes ne sont jamais touchés.',
    ),
  ];
}

export function renderStorageTab() {
  const st = state.storage;
  if (!st.plan && !st.loading && !st.error) loadStorage();
  if (st.error && !st.plan) return h('p', { class: 'hint hint--error' }, `Lecture du disque impossible : ${st.error}`);
  if (!st.plan) return h('p', { class: 'settings__scope-note' }, 'Calcul de l’espace utilisé…');
  const runtimesSize = st.runtimes.reduce((t, r) => t + r.size, 0);
  return h(
    'div',
    { class: 'storage' },
    h(
      'div',
      { class: 'storage__main' },
      h(
        'section',
        { class: 'settings__section', 'aria-labelledby': 'rt-title' },
        h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'rt-title' }, 'Java téléchargés par le launcher'), h('span', { class: 'label' }, `${st.runtimes.length} · ${formatSize(runtimesSize)}`)),
        st.runtimes.length ? h('div', { class: 'java-list' }, st.runtimes.map(runtimeRow)) : h('p', { class: 'hint' }, 'Aucun pour l’instant : le bon Java est téléchargé au premier lancement de chaque version.'),
        h('p', { class: 'hint' }, 'Un Java supprimé est retéléchargé tout seul si une instance en a de nouveau besoin.'),
      ),
      h(
        'section',
        { class: 'settings__section', 'aria-labelledby': 'pc-title' },
        h(
          'div',
          { class: 'settings__title-row' },
          h('h2', { class: 'settings__title', id: 'pc-title' }, 'Java installés sur ton PC'),
          h('button', { class: 'btn btn--sm', disabled: st.loading, onClick: () => loadStorage({ rescanJavas: true }) }, st.loading ? 'Recherche…' : 'Rechercher'),
        ),
        st.system.length
          ? h(
              'div',
              { class: 'java-list' },
              st.system.map((j) =>
                h(
                  'div',
                  { class: 'java-row' },
                  h('span', { class: 'java-row__major java-row__major--pc' }, j.major),
                  h('span', { class: 'java-row__body' }, h('span', { class: 'java-row__name' }, j.name), h('span', { class: 'java-row__detail java-row__detail--path', title: j.path }, j.path)),
                ),
              ),
            )
          : h('p', { class: 'hint' }, 'Aucun Java trouvé dans Program Files, JAVA_HOME ou le PATH.'),
        h('p', { class: 'hint' }, "Lecture seule : le launcher ne modifie jamais ces Java. Tu peux en choisir un dans « Java › Personnalisé » des paramètres d'une instance."),
      ),
    ),
    h(
      'aside',
      { class: 'settings__section storage__disk', 'aria-labelledby': 'disk-title' },
      h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'disk-title' }, 'Espace disque'), h('span', { class: 'ram-value', style: 'font-size:24px' }, formatSize(st.usage.total))),
      usageBlock(st.usage),
      cleanupBlock(st.plan),
    ),
  );
}

// ---------- Fenêtres ----------

export function shortcutsDialog() {
  return dialog({
    title: 'Raccourcis clavier',
    size: 'dialog--wide dialog--keys',
    labelId: 'shortcuts-title',
    body: [
      h(
        'div',
        { class: 'shortcuts' },
        SHORTCUTS.map((g) =>
          h('div', null, h('h2', { class: 'label shortcuts__title' }, g.title), h('dl', { class: 'key-list' }, g.rows.map((r) => h('div', { class: 'key-list__row' }, h('dt', null, r.label), h('dd', null, keys(r.keys)))))),
        ),
      ),
      h('p', { class: 'hint' }, 'Les raccourcis ne marchent pas pendant la saisie dans un champ, sauf Échap et Ctrl F. En AZERTY, Ctrl / se fait avec Ctrl Maj : ou F1.'),
    ],
  });
}

export function stopGameDialog() {
  const running = state.run?.phase === 'running';
  if (!state.run) return null;
  return dialog({
    title: running ? 'Arrêter le jeu ?' : 'Annuler le lancement ?',
    size: 'dialog--small',
    labelId: 'stop-title',
    body: [
      h(
        'p',
        { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' },
        running ? "Minecraft est fermé tout de suite, sans sauvegarder la partie en cours. Préfère « Sauvegarder et quitter » dans le jeu quand c'est possible." : 'Le téléchargement ou la préparation en cours est arrêté.',
      ),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Continuer'),
      h('button', { class: 'btn btn--lg btn--danger', onClick: () => { close(); stopGame(); } }, running ? 'Arrêter le jeu' : 'Annuler le lancement'),
    ],
  });
}

export function removeRuntimeDialog(modal) {
  const r = modal.runtime;
  const name = r.major ? `Java ${r.major}` : r.component;
  return dialog({
    title: `Supprimer ${name} ?`,
    size: 'dialog--small',
    labelId: 'rm-runtime-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, `Le dossier runtime\\${r.component} (${formatSize(r.size)}) est supprimé définitivement. Aucune instance ne l'utilise aujourd'hui.`),
      h('p', { class: 'hint' }, "Il sera retéléchargé automatiquement si une instance en a de nouveau besoin."),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--lg btn--danger', disabled: state.storage.busy, onClick: () => removeRuntime(r) }, state.storage.busy ? 'Suppression…' : 'Supprimer'),
    ],
  });
}

export function cleanDialog(modal) {
  const total = modal.items.reduce((t, i) => t + i.size, 0);
  return dialog({
    title: `Libérer ${formatSize(total)} ?`,
    size: 'dialog--small',
    labelId: 'clean-title',
    body: [
      h('ul', { class: 'clean-summary' }, modal.items.map((i) => h('li', null, h('span', null, i.label), h('span', { class: 'mono' }, formatSize(i.size))))),
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, 'Ces fichiers sont supprimés définitivement, sans passer par la corbeille : ils se retéléchargent si une instance en a besoin.'),
      h('p', { class: 'hint' }, 'Tes mondes, mods, captures et sauvegardes ne sont pas concernés.'),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, 'Annuler'),
      h('button', { class: 'btn btn--lg btn--danger', disabled: state.storage.busy, onClick: () => cleanStorage(modal.items.map((i) => i.id)) }, state.storage.busy ? 'Nettoyage…' : 'Libérer'),
    ],
  });
}
