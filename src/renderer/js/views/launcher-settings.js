// Paramètres › Launcher (thème, Discord, zone de notification, raccourcis) et Paramètres › Java et stockage.
import { t } from '../i18n.js';
import { stopGame } from '../actions.js';
import { api } from '../api.js';
import { LOADER_NAMES } from '../data.js';
import { formatSize, h, icon } from '../dom.js';
import { cleanStorage, loadStorage, refreshDiscord, removeRuntime, selectedCleanup, setLauncherPref, toggleCleanup } from '../launcher-actions.js';
import { SHORTCUTS } from '../shortcuts.js';
import { ACCENTS, accentTokens, applyAccent } from '../theme.js';
import { checkUpdate, installUpdate, updateBlocker, updateWaitText } from '../update-actions.js';
import { selectedInstance, state, toastError, update } from '../state.js';
import { close, dialog } from './modals.js';
import { languageSection } from './language.js';
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
    h('h2', { class: 'settings__title', id: 'theme-title' }, t('launcher.apparence')),
    h('span', { class: 'label', id: 'accent-label' }, t('launcher.couleur_accent')),
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
          'aria-label': t('launcher.couleur_personnalisee'),
          value: custom ? prefs.accent : '#e0559b',
          onInput: (e) => applyAccent(e.target.value),
          onChange: (e) => setLauncherPref({ accent: e.target.value }),
        }),
        h('span', null, t('launcher.perso')),
      ),
    ),
    h(
      'div',
      { class: 'theme-preview', 'aria-hidden': 'true' },
      h('span', { class: 'label' }, t('launcher.apercu')),
      h('span', { class: 'theme-preview__btn' }, icon('play'), t('common.jouer')),
      h('span', { class: 'toggle', 'aria-pressed': 'true' }),
      h('span', { class: 'theme-preview__text' }, 'Fabric 0.17.3'),
      h('span', { class: 'tag tag--release' }, t('common.prete')),
    ),
    h('p', { class: 'hint' }, t('launcher.la_couleur_change_tout_de')),
  );
}

function discordChip(prefs) {
  if (!state.discordReady) return h('span', { class: 'tag tag--muted' }, t('launcher.non_configure'));
  if (!prefs.discord) return h('span', { class: 'tag tag--muted' }, t('launcher.desactive'));
  if (!state.discord) return h('span', { class: 'tag tag--muted' }, '…');
  return state.discord.running ? h('span', { class: 'tag tag--ok' }, t('launcher.discord_ouvert')) : h('span', { class: 'tag tag--warn' }, t('launcher.discord_ferme'));
}

function discordSection(prefs) {
  if (state.discord === null && prefs.discord && state.discordReady && !discordSection.loading) {
    discordSection.loading = true;
    refreshDiscord().finally(() => { discordSection.loading = false; });
  }
  const ready = state.discordReady;
  const sample = selectedInstance() ?? state.instances[0];
  const name = sample ? `${sample.name} (${sample.version})` : t('launcher.survie_26');
  const loader = sample ? LOADER_NAMES[sample.loader] : 'Vanilla';
  const on = ready && prefs.discord;
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'discord-title' },
    h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'discord-title' }, 'Discord'), discordChip(prefs)),
    toggleRow('rpc-label', t('launcher.afficher_ma_partie_sur_discord'), on, () => setLauncherPref({ discord: !prefs.discord }), !ready),
    toggleRow('rpc-name-label', t('launcher.montrer_le_nom_de_instance'), on && prefs.discordShowName, () => setLauncherPref({ discordShowName: !prefs.discordShowName }), !on),
    h(
      'div',
      { class: `discord-card${on ? '' : ' discord-card--off'}` },
      h('span', { class: 'logo discord-card__logo', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'discord-card__body' },
        h('span', { class: 'label' }, t('launcher.ce_que_tes_amis_voient')),
        h('span', { class: 'discord-card__title' }, prefs.discordShowName ? t('launcher.joue', { name }) : t('launcher.joue_minecraft', { version: sample?.version ?? '26.3' })),
        h('span', { class: 'discord-card__detail' }, prefs.discordShowName ? t('launcher.depuis_12_min', { loader }) : t('launcher.depuis_12_min_2')),
      ),
    ),
    h(
      'p',
      { class: 'hint' },
      ready
        ? t('launcher.desactive_par_defaut_le_launcher')
        : t('launcher.il_manque_application_id_de'),
    ),
  );
}

function traySection(prefs) {
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'tray-title' },
    h('h2', { class: 'settings__title', id: 'tray-title' }, t('launcher.zone_de_notification')),
    toggleRow('tray-label', t('launcher.icone_pres_de_horloge'), prefs.tray, () => setLauncherPref({ tray: !prefs.tray })),
    toggleRow('close-label', t('launcher.fermer_la_fenetre_garde_le'), prefs.tray && prefs.closeToTray, () => setLauncherPref({ closeToTray: !prefs.closeToTray }), !prefs.tray),
    h(
      'p',
      { class: 'hint' },
      t('launcher.clic_sur_icone_afficher_ou'),
    ),
  );
}

const RELEASES_URL = 'https://github.com/xRzxnx/0Rzxn-Launcher/releases';

function checkedAgo(time) {
  if (!time) return '';
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return t('update.checked_now');
  if (minutes < 60) return t('update.checked_minutes', { minutes });
  return t('update.checked_hours', { hours: Math.floor(minutes / 60) });
}

/** Ce que la section dit de la mise à jour en cours. */
function updateStatus(u) {
  const version = t('chrome.version', { appVersion: state.appVersion ?? '' });
  const line = (text, cls = 'hint') => h('p', { class: cls, role: 'status' }, text);
  if (!u?.supported) return line(t('update.installed_only', { version }));
  switch (u.status) {
    case 'checking':
      return line(t('update.searching'));
    case 'current':
      return line(t('update.up_to_date', { version, checked: checkedAgo(u.checkedAt) }));
    case 'waiting':
      return line(updateWaitText(u.version, updateBlocker()));
    case 'downloading':
      return h(
        'div',
        { class: 'update-progress', role: 'status' },
        h('p', { class: 'hint' }, u.total ? t('update.downloading_size', { version: u.version, done: formatSize(u.transferred), total: formatSize(u.total) }) : t('update.downloading', { version: u.version })),
        h('div', { class: 'update-progress__bar' }, h('i', { style: `width:${u.percent}%` })),
      );
    case 'ready': {
      const waiting = updateBlocker();
      return h(
        'div',
        { class: 'toggle-row' },
        h('span', { role: 'status' }, waiting ? updateWaitText(u.version, waiting) : t('update.ready', { version: u.version })),
        h('button', { class: 'btn btn--primary', disabled: Boolean(waiting), onClick: installUpdate }, t('update.restart')),
      );
    }
    case 'error':
      return line(u.error, 'hint hint--error');
    default:
      return line(version);
  }
}

function updateSection(prefs) {
  const u = state.launcherUpdate;
  const busy = u?.status === 'checking' || u?.status === 'downloading';
  return h(
    'section',
    { class: 'settings__section', 'aria-labelledby': 'update-title' },
    h(
      'div',
      { class: 'settings__title-row' },
      h('h2', { class: 'settings__title', id: 'update-title' }, t('update.title')),
      h('button', { class: 'btn btn--ghost', disabled: !u?.supported || busy, onClick: checkUpdate }, icon('search'), t('update.check')),
    ),
    updateStatus(u),
    toggleRow('update-label', t('update.auto'), prefs.autoUpdate, () => setLauncherPref({ autoUpdate: !prefs.autoUpdate })),
    h(
      'p',
      { class: 'hint' },
      t('update.hint'),
      h('a', { href: RELEASES_URL, target: '_blank', rel: 'noreferrer' }, t('update.whats_new')),
    ),
  );
}

const keys = (list) => h('span', { class: 'keys' }, list.map((k) => h('kbd', { class: 'kbd' }, k)));

function shortcutsSection() {
  const rows = SHORTCUTS().flatMap((g) => g.rows).filter((r) => !r.helpOnly);
  return h(
    'section',
    { class: 'settings__section settings__section--keys', 'aria-labelledby': 'keys-title' },
    h(
      'div',
      { class: 'settings__title-row' },
      h('h2', { class: 'settings__title', id: 'keys-title' }, t('launcher.raccourcis_clavier')),
      h('button', { class: 'btn btn--ghost btn--sm', onClick: () => update((s) => { s.modal = { type: 'shortcuts' }; }) }, t('launcher.tout_voir_ctrl')),
    ),
    h('dl', { class: 'key-list' }, rows.map((r) => h('div', { class: 'key-list__row' }, h('dt', null, r.label), h('dd', null, keys(r.keys))))),
  );
}

export function renderLauncherTab() {
  const prefs = state.launcherPrefs;
  if (!prefs) return h('p', { class: 'hint' }, t('common.chargement'));
  return h(
    'div',
    null,
    h('p', { class: 'settings__scope-note' }, icon('settings', 20), t('launcher.reglages_du_launcher_lui_meme')),
    h('div', { class: 'settings__grid' }, languageSection(), themeSection(prefs), updateSection(prefs), discordSection(prefs), traySection(prefs), shortcutsSection(), gameSection(prefs), gpuSection(prefs)),
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
    h('span', { class: 'java-row__body' }, h('span', { class: 'java-row__name' }, name), h('span', { class: 'java-row__detail' }, `${r.component} · ${r.version ?? t('launcher.version_inconnue')} · ${formatSize(r.size)}`)),
    h('span', { class: `java-row__use${used ? '' : ' java-row__use--none'}` }, used ? r.usedBy.join(', ') : t('common.aucune_instance')),
    h('button', { class: 'icon-btn', 'aria-label': t('launcher.ouvrir_le_dossier_de', { name }), onClick: () => api.openRuntime(r.component).catch((e) => toastError(t('launcher.dossier_introuvable'), e)) }, icon('folder')),
    h(
      'button',
      {
        class: 'icon-btn icon-btn--danger',
        'aria-label': used ? t('launcher.sert_encore', { name, usedBy: r.usedBy.join(', ') }) : t('launcher.supprimer', { name }),
        title: used ? t('launcher.sert_encore_2', { usedBy: r.usedBy.join(', ') }) : busy() ? t('launcher.indisponible_pendant_une_partie_ou') : t('launcher.supprimer', { name }),
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
      { class: 'disk-bar', role: 'img', 'aria-label': t('launcher.repartition_de_espace_utilise', { parts: usage.parts.map((p) => `${p.label} ${formatSize(p.size)}`).join(', ') }) },
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
    h('h3', { class: 'label disk__sub' }, t('launcher.nettoyage')),
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
      chosen.length ? t('launcher.liberer', { total: formatSize(total) }) : t('launcher.rien_liberer'),
    ),
    h(
      'p',
      { class: 'hint' },
      state.run ? t('launcher.ferme_le_jeu_pour_faire') : t('launcher.tout_se_retelecharge_si_une'),
    ),
  ];
}

export function renderStorageTab() {
  const st = state.storage;
  if (!st.plan && !st.loading && !st.error) loadStorage();
  if (st.error && !st.plan) return h('p', { class: 'hint hint--error' }, t('launcher.lecture_du_disque_impossible', { error: st.error }));
  if (!st.plan) return h('p', { class: 'settings__scope-note' }, t('launcher.calcul_de_espace_utilise'));
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
        h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'rt-title' }, t('launcher.java_telecharges_par_le_launcher')), h('span', { class: 'label' }, `${st.runtimes.length} · ${formatSize(runtimesSize)}`)),
        st.runtimes.length ? h('div', { class: 'java-list' }, st.runtimes.map(runtimeRow)) : h('p', { class: 'hint' }, t('launcher.aucun_pour_instant_le_bon')),
        h('p', { class: 'hint' }, t('launcher.un_java_supprime_est_retelecharge')),
      ),
      h(
        'section',
        { class: 'settings__section', 'aria-labelledby': 'pc-title' },
        h(
          'div',
          { class: 'settings__title-row' },
          h('h2', { class: 'settings__title', id: 'pc-title' }, t('launcher.java_installes_sur_ton_pc')),
          h('button', { class: 'btn btn--sm', disabled: st.loading, onClick: () => loadStorage({ rescanJavas: true }) }, st.loading ? t('common.recherche') : t('launcher.rechercher')),
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
          : h('p', { class: 'hint' }, t('launcher.aucun_java_trouve_dans_program')),
        h('p', { class: 'hint' }, t('launcher.lecture_seule_le_launcher_ne')),
      ),
    ),
    h(
      'aside',
      { class: 'settings__section storage__disk', 'aria-labelledby': 'disk-title' },
      h('div', { class: 'settings__title-row' }, h('h2', { class: 'settings__title', id: 'disk-title' }, t('launcher.espace_disque')), h('span', { class: 'ram-value', style: 'font-size:24px' }, formatSize(st.usage.total))),
      usageBlock(st.usage),
      cleanupBlock(st.plan),
    ),
  );
}

// ---------- Fenêtres ----------

export function shortcutsDialog() {
  return dialog({
    title: t('launcher.raccourcis_clavier'),
    size: 'dialog--wide dialog--keys',
    labelId: 'shortcuts-title',
    body: [
      h(
        'div',
        { class: 'shortcuts' },
        SHORTCUTS().map((g) =>
          h('div', null, h('h2', { class: 'label shortcuts__title' }, g.title), h('dl', { class: 'key-list' }, g.rows.map((r) => h('div', { class: 'key-list__row' }, h('dt', null, r.label), h('dd', null, keys(r.keys)))))),
        ),
      ),
      h('p', { class: 'hint' }, t('launcher.les_raccourcis_ne_marchent_pas')),
    ],
  });
}

export function stopGameDialog() {
  const running = state.run?.phase === 'running';
  if (!state.run) return null;
  return dialog({
    title: running ? t('launcher.arreter_le_jeu') : t('launcher.annuler_le_lancement'),
    size: 'dialog--small',
    labelId: 'stop-title',
    body: [
      h(
        'p',
        { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' },
        running ? t('launcher.minecraft_est_ferme_tout_de') : t('launcher.le_telechargement_ou_la_preparation'),
      ),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.continuer')),
      h('button', { class: 'btn btn--lg btn--danger', onClick: () => { close(); stopGame(); } }, running ? t('common.arreter_le_jeu') : t('launcher.annuler_le_lancement_2')),
    ],
  });
}

export function removeRuntimeDialog(modal) {
  const r = modal.runtime;
  const name = r.major ? `Java ${r.major}` : r.component;
  return dialog({
    title: t('launcher.supprimer_2', { name }),
    size: 'dialog--small',
    labelId: 'rm-runtime-title',
    body: [
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, t('launcher.le_dossier_runtime_est_supprime', { component: r.component, size: formatSize(r.size) })),
      h('p', { class: 'hint' }, t('launcher.il_sera_retelecharge_automatiquement_si')),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--danger', disabled: state.storage.busy, onClick: () => removeRuntime(r) }, state.storage.busy ? t('launcher.suppression') : t('common.supprimer')),
    ],
  });
}

export function cleanDialog(modal) {
  const total = modal.items.reduce((t, i) => t + i.size, 0);
  return dialog({
    title: t('launcher.liberer_2', { total: formatSize(total) }),
    size: 'dialog--small',
    labelId: 'clean-title',
    body: [
      h('ul', { class: 'clean-summary' }, modal.items.map((i) => h('li', null, h('span', null, i.label), h('span', { class: 'mono' }, formatSize(i.size))))),
      h('p', { style: 'margin:0;font-size:14px;line-height:1.6;color:var(--text-3)' }, t('launcher.ces_fichiers_sont_supprimes_definitivement')),
      h('p', { class: 'hint' }, t('launcher.tes_mondes_mods_captures_et')),
    ],
    foot: [
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn--lg', onClick: close }, t('common.annuler')),
      h('button', { class: 'btn btn--lg btn--danger', disabled: state.storage.busy, onClick: () => cleanStorage(modal.items.map((i) => i.id)) }, state.storage.busy ? t('launcher.nettoyage_2') : t('launcher.liberer_3')),
    ],
  });
}
