'use strict';

// Menu Cristal : écran titre du jeu à l'image du launcher, écrit sous forme de mise en page pour FancyMenu.
// Le launcher ne fournit que des fichiers de configuration ; le mod vient de Modrinth, jamais du launcher.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { t } = require('../i18n');
const { LOADER_NAMES } = require('./loaders');
const art = require('./title-art');

const FANCYMENU = 'fancymenu';
const STYLES = ['colonne', 'centre', 'minimal'];
const THEMES = ['sunset', 'night', 'forest'];
const LAYOUT_FILE = '0rzxn-menu.txt';
const STAMP_FILE = 'ecrit-le.txt';
const ASSET_DIR = '0rzxn';
const PANORAMA = '0rzxn';
const TITLE_SCREEN_CLASS = 'net.minecraft.client.gui.screens.TitleScreen';
const LOGO_RATIO = 496 / 104;

// Mods signalés comme incompatibles (plantages) sur la liste officielle de FancyMenu.
const KNOWN_CONFLICTS = [
  [/^chat[-_ ]?colou?rs/i, 'Chat Colors'],
  [/^controlify/i, 'Controlify'],
  [/^entity[-_ ]?model[-_ ]?features/i, 'Entity Model Features'],
  [/^holographic/i, 'Holographic Renderers'],
  [/^legacy4j/i, 'Legacy4J'],
  [/^seamless[-_ ]?loading/i, 'Seamless Loading Screen'],
  [/^trade[-_ ]?uses/i, 'Trade Uses'],
  [/^wakes/i, 'Wakes'],
];

const dirsOf = (gameDir) => {
  const root = path.join(gameDir, 'config', FANCYMENU);
  return {
    root,
    layouts: path.join(root, 'customization'),
    assets: path.join(root, 'assets', ASSET_DIR),
    panorama: path.join(root, 'panoramas', PANORAMA),
    screens: path.join(root, 'customizablemenus.txt'),
    options: path.join(root, 'options.txt'),
  };
};

// Chemin relatif au dossier du jeu : le raccourci « .minecraft/ » viserait le dossier officiel, pas l'instance.
const local = (name) => `[source:local]config/fancymenu/assets/${ASSET_DIR}/${name}`;

/** Une ligne se terminant par « { » ouvrirait un bloc : on retire accolades et retours à la ligne. */
const clean = (text) => String(text ?? '').replace(/[{}\r\n]/g, ' ').replace(/%n%/g, ' ').trim();

function block(type, props) {
  const lines = Object.entries(props).map(([key, value]) => `  ${key} = ${value}`);
  return `${type} {\n${lines.join('\n')}\n}`;
}

const place = (anchor, x, y, width, height) => ({ anchor_point: anchor, x, y, width, height, auto_sizing: false, sticky_anchor: false, stay_on_screen: false });

const image = (id, source, position, border) =>
  block('element', {
    element_type: 'image',
    instance_identifier: `0rzxn_${id}`,
    source: local(source),
    ...position,
    ...(border ? { nine_slice_texture: true, nine_slice_texture_border_x: border, nine_slice_texture_border_y: border } : {}),
  });

const text = (id, lines, position, scale = 1, color = '#FFFFFF') =>
  block('element', {
    element_type: 'text_v2',
    instance_identifier: `0rzxn_${id}`,
    source_mode: 'direct',
    source: [lines].flat().map(clean).join('%n%'),
    ...position,
    scale,
    base_color: color,
    shadow: true,
    parse_markdown: false,
    interactable: false,
    enable_scrolling: false,
    auto_line_wrapping: true,
    text_border: 0,
  });

const hidden = (id) => block('vanilla_button', { element_type: 'vanilla_button', instance_identifier: id, is_hidden: true });

/** Bouton du jeu déplacé : il garde sa fonction, sa langue et ce que les autres mods lui ajoutent. */
function widget(id, position, { primary = false, label = null } = {}) {
  return block('vanilla_button', {
    element_type: 'vanilla_button',
    instance_identifier: id,
    is_hidden: false,
    ...position,
    backgroundnormal: local(primary ? 'bouton-principal.png' : 'bouton.png'),
    backgroundhovered: local(primary ? 'bouton-principal-survol.png' : 'bouton-survol.png'),
    nine_slice_custom_background: true,
    nine_slice_border_x: 4,
    nine_slice_border_y: 4,
    ...(label ? { label } : {}),
  });
}

const W = {
  solo: 'mc_titlescreen_singleplayer_button',
  multi: 'mc_titlescreen_multiplayer_button',
  realms: 'mc_titlescreen_realms_button',
  options: 'mc_titlescreen_options_button',
  quit: 'mc_titlescreen_quit_button',
  fabricMods: 'modmenu_titlescreen_mods_button',
  forgeMods: 'forge_titlescreen_mods_button',
};

// Ces petites icônes n'ont pas de nom dans FancyMenu : il les repère par leur position, calculée sur
// un écran de 1000 × 1000. Elles changent de place selon la version, et une rangée de plus (Mod Menu)
// les décale de 24. Toutes les positions connues sont écrites : un numéro absent est simplement ignoré.
const icon = (spots, position) => spots.flatMap(([x, y]) => [y, y + 24].map((row) => widget(`${x}${row}`, position)));
const language = (position) => icon([[376, 382], [490, 370]], position);
const accessibility = (position) => icon([[604, 382], [514, 370]], position);
const friends = (position) => icon([[466, 370]], position); // apparue avec 26.3

const cardLines = (info) => [info.instance, [info.loader, info.mods ? `${info.mods} mods` : null].filter(Boolean).join(' · '), info.world ? t('titlemenu.dernier_monde', { name: info.world }) : null].filter(Boolean);
const greeting = (info) => (info.player ? t('titlemenu.bon_retour', { name: info.player }) : t('titlemenu.bon_retour_seul'));

// Tailles en pixels d'interface : le plus petit écran courant fait 426 × 240.
function colonne(info, showCard) {
  const a = 'mid-left';
  const x = 20;
  const logoW = 140;
  const parts = [
    image('verre', 'verre.png', place(a, 10, -108, 160, 216), 6),
    image('logo', 'logo.png', place(a, x, -98, logoW, Math.round(logoW / LOGO_RATIO))),
    text('accueil', greeting(info), place(a, x, -62, 140, 20)),
    ...language(place(a, x, -24, 20, 20)),
    ...accessibility(place(a, x + 23, -24, 20, 20)),
    ...friends(place(a, x + 46, -24, 20, 20)),
    widget(W.fabricMods, place(a, x + 69, -24, 71, 20)),
    widget(W.forgeMods, place(a, x + 69, -24, 71, 20)),
    widget(W.solo, place(a, x, 3, 140, 20), { primary: true }),
    widget(W.multi, place(a, x, 26, 140, 20)),
    widget(W.realms, place(a, x, 49, 140, 20)),
    widget(W.options, place(a, x, 72, 68, 20)),
    widget(W.quit, place(a, x + 72, 72, 68, 20)),
  ];
  if (showCard) parts.push(...card(info, 'top-right', -150, 10));
  return parts;
}

function centre(info, showCard) {
  const a = 'mid-centered';
  const logoW = 180;
  const parts = [
    image('verre', 'verre.png', place(a, -115, -104, 230, 186), 6),
    image('logo', 'logo.png', place(a, -logoW / 2, -94, logoW, Math.round(logoW / LOGO_RATIO))),
    widget(W.solo, place(a, -100, -18, 200, 20), { primary: true }),
    widget(W.multi, place(a, -100, 5, 98, 20)),
    widget(W.realms, place(a, 2, 5, 98, 20), { label: 'Realms' }),
    widget(W.options, place(a, -100, 28, 98, 20)),
    widget(W.quit, place(a, 2, 28, 98, 20)),
    ...language(place(a, -100, 51, 20, 20)),
    ...friends(place(a, -77, 51, 20, 20)),
    widget(W.fabricMods, place(a, -54, 51, 131, 20)),
    widget(W.forgeMods, place(a, -54, 51, 131, 20)),
    ...accessibility(place(a, 80, 51, 20, 20)),
  ];
  // Trop peu de place à côté du bloc sur un petit écran : la carte devient une ligne dedans.
  if (showCard) parts.push(text('carte', cardLines(info).slice(0, 2), place(a, -100, -50, 200, 28)));
  return parts;
}

function minimal(info, showCard) {
  const a = 'bottom-centered';
  const logoW = 130;
  const y = -46;
  const parts = [
    image('logo', 'logo.png', place('top-left', 12, 10, logoW, Math.round(logoW / LOGO_RATIO))),
    image('verre', 'verre.png', place(a, -207, y - 5, 414, 30), 6),
    widget(W.solo, place(a, -202, y, 78, 20), { primary: true }),
    widget(W.multi, place(a, -120, y, 78, 20)),
    widget(W.realms, place(a, -38, y, 78, 20), { label: 'Realms' }),
    widget(W.options, place(a, 44, y, 78, 20)),
    widget(W.quit, place(a, 126, y, 76, 20)),
    ...language(place('top-right', -56, 10, 20, 20)),
    ...accessibility(place('top-right', -33, 10, 20, 20)),
    ...friends(place('top-right', -79, 10, 20, 20)),
    widget(W.fabricMods, place('top-right', -155, 10, 72, 20)),
    widget(W.forgeMods, place('top-right', -155, 10, 72, 20)),
  ];
  if (showCard) parts.push(...card(info, 'top-right', -150, 36));
  return parts;
}

function card(info, anchor, x, y) {
  const lines = cardLines(info);
  return [
    image('carte', 'verre.png', place(anchor, x, y, 140, 14 + lines.length * 12), 6),
    text('carte_texte', lines, place(anchor, x + 7, y + 6, 126, 6 + lines.length * 12)),
  ];
}

const LAYOUTS = { colonne, centre, minimal };

function buildLayout({ style = 'colonne', card: showCard = true, info, time = Date.now() }) {
  const build = LAYOUTS[style] ?? colonne;
  const sections = [
    'type = fancymenu_layout',
    block('layout-meta', {
      identifier: 'title_screen',
      render_custom_elements_behind_vanilla: true,
      last_edited_time: time,
      is_enabled: true,
      layout_index: 0,
      widget_identifier_revision: 1,
      randommode: false,
      randomgroup: 1,
      randomonlyfirsttime: false,
    }),
    block('menu_background', { instance_identifier: '0rzxn_fond', background_type: 'panorama', panorama_name: PANORAMA }),
    hidden('minecraft_logo_widget'),
    hidden('minecraft_splash_widget'),
    hidden('minecraft_realms_notification_widget'),
    ...build(info, showCard),
  ];
  return `${sections.join('\n\n')}\n`;
}

/** Ajoute l'écran titre aux écrans personnalisés sans retirer ceux que tu as activés toi-même. */
async function enableTitleScreen(file) {
  let current = '';
  try {
    current = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (/TitleScreen|class_442/.test(current)) return;
  const base = current.trim() || 'type = customizablemenus';
  await fsp.writeFile(file, `${base}\n\n${TITLE_SCREEN_CLASS} {\n}\n`);
}

/** Masque la barre d'outils et la fenêtre d'accueil de FancyMenu, sans toucher au reste de ses options. */
async function hideExtras(file) {
  let current = null;
  try {
    current = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current === null) {
    // Premier lancement : FancyMenu complétera le fichier avec ses autres options.
    await fsp.writeFile(file, "##[customization]\n\nB:show_customization_overlay = 'false';\n\n##[tutorial]\n\nB:show_welcome_screen = 'false';\n");
    return;
  }
  const next = current.replace(/((?:show_customization_overlay|show_welcome_screen)\s*=\s*')true(')/g, '$1false$2');
  if (next !== current) await fsp.writeFile(file, next);
}

/** Écrit les images, seulement si elles manquent ou si le décor a changé. */
async function writeImages(dirs, { seed, theme }) {
  await fsp.mkdir(dirs.assets, { recursive: true });
  const logo = art.logoImage();
  const images = {
    'verre.png': art.glassPanel(),
    'bouton.png': art.buttonImage(),
    'bouton-survol.png': art.buttonHover(),
    'bouton-principal.png': art.primaryImage(),
    'bouton-principal-survol.png': art.primaryHover(),
    'logo.png': logo.png,
  };
  await Promise.all(Object.entries(images).map(([name, data]) => fsp.writeFile(path.join(dirs.assets, name), data)));

  const stamp = path.join(dirs.panorama, 'decor.txt');
  const wanted = `${seed}:${theme}`;
  const known = await fsp.readFile(stamp, 'utf8').catch(() => null);
  if (known === wanted) return;
  const imageDir = path.join(dirs.panorama, 'panorama');
  await fsp.mkdir(imageDir, { recursive: true });
  await Promise.all(art.panoramaFaces(seed, theme).map((data, i) => fsp.writeFile(path.join(imageDir, `panorama_${i}.png`), data)));
  await fsp.writeFile(
    path.join(dirs.panorama, 'properties.txt'),
    `type = panorama\n\n${block('panorama-meta', { name: PANORAMA, speed: 1.0, fov: 85.0, angle: 8.0 })}\n`,
  );
  await fsp.writeFile(stamp, wanted);
}

/** Écrit tout le nécessaire dans le dossier du jeu. */
async function writeMenu({ gameDir, seed, theme = 'sunset', style = 'colonne', card = true, info }) {
  const dirs = dirsOf(gameDir);
  await fsp.mkdir(dirs.layouts, { recursive: true });
  await writeImages(dirs, { seed, theme: THEMES.includes(theme) ? theme : 'sunset' });
  await enableTitleScreen(dirs.screens);
  await hideExtras(dirs.options);
  const time = Date.now();
  await fsp.writeFile(path.join(dirs.layouts, LAYOUT_FILE), buildLayout({ style, card, info, time }));
  await fsp.writeFile(path.join(dirs.assets, STAMP_FILE), String(time));
}

/** FancyMenu change l'heure de la mise en page à chaque enregistrement dans son éditeur. */
async function editedInGame(dirs) {
  const layout = await fsp.readFile(path.join(dirs.layouts, LAYOUT_FILE), 'utf8').catch(() => null);
  const stamp = await fsp.readFile(path.join(dirs.assets, STAMP_FILE), 'utf8').catch(() => null);
  if (layout === null || stamp === null) return false;
  return layout.match(/last_edited_time = (\d+)/)?.[1] !== stamp.trim();
}

/** Retire uniquement nos fichiers : les mises en page que tu as créées toi-même restent. */
async function removeMenu(gameDir) {
  const dirs = dirsOf(gameDir);
  await Promise.all([
    fsp.rm(path.join(dirs.layouts, LAYOUT_FILE), { force: true }),
    fsp.rm(dirs.assets, { recursive: true, force: true }),
    fsp.rm(dirs.panorama, { recursive: true, force: true }),
  ]);
}

const hasLayout = (gameDir) => fs.existsSync(path.join(dirsOf(gameDir).layouts, LAYOUT_FILE));

async function jarNames(gameDir) {
  const names = await fsp.readdir(path.join(gameDir, 'mods')).catch(() => []);
  return names.filter((n) => n.toLowerCase().endsWith('.jar'));
}

const conflictsIn = (names) => KNOWN_CONFLICTS.filter(([pattern]) => names.some((n) => pattern.test(n))).map(([, label]) => label);

/** Monde joué en dernier : celui dont le level.dat est le plus récent. */
async function lastWorld(gameDir) {
  const saves = path.join(gameDir, 'saves');
  const names = await fsp.readdir(saves).catch(() => []);
  let best = null;
  for (const name of names) {
    const time = await fsp.stat(path.join(saves, name, 'level.dat')).then((s) => s.mtimeMs).catch(() => 0);
    if (time && (!best || time > best.time)) best = { name, time };
  }
  return best?.name ?? null;
}

async function gatherInfo({ gameDir, instance, player = null }) {
  return {
    instance: instance.name,
    player,
    loader: LOADER_NAMES[instance.loader] ?? null,
    mods: (await jarNames(gameDir)).length,
    world: await lastWorld(gameDir),
  };
}

/** Réécrit le menu avec les informations du moment : appelé à l'activation, puis avant chaque lancement. */
async function refresh({ gameDir, instance, player = null, keepEdits = false }) {
  if (keepEdits && (await editedInGame(dirsOf(gameDir)))) return; // tes retouches dans le jeu passent avant
  const info = await gatherInfo({ gameDir, instance, player });
  await writeMenu({ gameDir, seed: instance.seed, theme: instance.background?.kind, style: instance.titleMenu?.style, card: instance.titleMenu?.card !== false, info });
}

const isModded = (instance) => Boolean(instance.loader) && instance.loader !== 'vanilla';

/**
 * Menu par défaut des instances moddées : il s'ajoute seul tant que personne n'a choisi pour l'instance.
 * `titleMenu` absent = jamais réglé ; null = menu classique choisi (ou retiré) : on n'y touche plus.
 */
const wantsAuto = (instance) => instance.titleMenu === undefined && isModded(instance);

/** Ce que l'interface doit savoir pour cette instance. `versions` interroge Modrinth. */
async function status({ gameDir, instance, versions }) {
  const modded = isModded(instance);
  const names = await jarNames(gameDir);
  const installed = names.some((n) => /^fancymenu/i.test(n));
  let available = null; // inconnu si Modrinth ne répond pas
  if (installed) available = true;
  else if (modded) available = await versions().then((list) => list.length > 0).catch(() => null);
  return {
    modded,
    available: modded ? available : false,
    installed,
    active: Boolean(instance.titleMenu) && hasLayout(gameDir),
    auto: wantsAuto(instance),
    style: STYLES.includes(instance.titleMenu?.style) ? instance.titleMenu.style : 'colonne',
    card: instance.titleMenu?.card !== false,
    conflicts: conflictsIn(names),
  };
}

const cleanOptions = (value) => (value ? { style: STYLES.includes(value.style) ? value.style : 'colonne', card: value.card !== false } : null);

module.exports = { FANCYMENU, STYLES, buildLayout, writeMenu, removeMenu, hasLayout, gatherInfo, refresh, status, wantsAuto, cleanOptions };
