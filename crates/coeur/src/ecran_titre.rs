//! Menu Cristal : écran titre du jeu à l'image du launcher, écrit sous forme de mise en page pour FancyMenu, comme
//! core/title-menu.js. Le launcher n'écrit que des fichiers de configuration ; le mod vient de Modrinth.

use crate::art_titre as art;
use crate::erreur::Resultat;
use crate::i18n::{t, tv};
use commun::{Instance, loader_name};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const FANCYMENU: &str = "fancymenu";
pub const STYLES: [&str; 3] = ["colonne", "centre", "minimal"];
const THEMES: [&str; 3] = ["sunset", "night", "forest"];
const MISE_EN_PAGE: &str = "0rzxn-menu.txt";
const TAMPON: &str = "ecrit-le.txt";
const IMAGES: &str = "0rzxn";
const PANORAMA: &str = "0rzxn";
const CLASSE_ECRAN_TITRE: &str = "net.minecraft.client.gui.screens.TitleScreen";
const RAPPORT_LOGO: f64 = 496.0 / 104.0;

/// Mods signalés comme incompatibles (plantages) sur la liste officielle de FancyMenu.
static CONFLITS: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    [
        (r"(?i)^chat[-_ ]?colou?rs", "Chat Colors"),
        (r"(?i)^controlify", "Controlify"),
        (r"(?i)^entity[-_ ]?model[-_ ]?features", "Entity Model Features"),
        (r"(?i)^holographic", "Holographic Renderers"),
        (r"(?i)^legacy4j", "Legacy4J"),
        (r"(?i)^seamless[-_ ]?loading", "Seamless Loading Screen"),
        (r"(?i)^trade[-_ ]?uses", "Trade Uses"),
        (r"(?i)^wakes", "Wakes"),
    ]
    .into_iter()
    .map(|(m, n)| (Regex::new(m).unwrap(), n))
    .collect()
});

struct Dossiers {
    mises_en_page: PathBuf,
    images: PathBuf,
    panorama: PathBuf,
    ecrans: PathBuf,
    options: PathBuf,
}

fn dossiers(dossier_jeu: &Path) -> Dossiers {
    let r = dossier_jeu.join("config").join(FANCYMENU);
    Dossiers {
        mises_en_page: r.join("customization"),
        images: r.join("assets").join(IMAGES),
        panorama: r.join("panoramas").join(PANORAMA),
        ecrans: r.join("customizablemenus.txt"),
        options: r.join("options.txt"),
    }
}

type Props = Vec<(&'static str, String)>;

/// Chemin relatif au dossier du jeu : le raccourci « .minecraft/ » viserait le dossier officiel, pas l'instance.
fn local(nom: &str) -> String {
    format!("[source:local]config/fancymenu/assets/{IMAGES}/{nom}")
}

/// Une ligne finissant par « { » ouvrirait un bloc : accolades et retours à la ligne retirés.
fn propre(texte: &str) -> String {
    texte.replace(['{', '}', '\r', '\n'], " ").replace("%n%", " ").trim().to_string()
}

fn bloc(genre: &str, props: &[(&str, String)]) -> String {
    let lignes: Vec<String> = props.iter().map(|(k, v)| format!("  {k} = {v}")).collect();
    format!("{genre} {{\n{}\n}}", lignes.join("\n"))
}

fn place(ancre: &str, x: i64, y: i64, w: i64, h: i64) -> Props {
    vec![
        ("anchor_point", ancre.into()),
        ("x", x.to_string()),
        ("y", y.to_string()),
        ("width", w.to_string()),
        ("height", h.to_string()),
        ("auto_sizing", "false".into()),
        ("sticky_anchor", "false".into()),
        ("stay_on_screen", "false".into()),
    ]
}

fn image(id: &str, source: &str, position: Props, bord: Option<u32>) -> String {
    let mut p: Props = vec![("element_type", "image".into()), ("instance_identifier", format!("0rzxn_{id}")), ("source", local(source))];
    p.extend(position);
    if let Some(b) = bord {
        p.extend([
            ("nine_slice_texture", "true".into()),
            ("nine_slice_texture_border_x", b.to_string()),
            ("nine_slice_texture_border_y", b.to_string()),
        ]);
    }
    bloc("element", &p)
}

fn texte(id: &str, lignes: &[String], position: Props) -> String {
    let mut p: Props = vec![
        ("element_type", "text_v2".into()),
        ("instance_identifier", format!("0rzxn_{id}")),
        ("source_mode", "direct".into()),
        ("source", lignes.iter().map(|l| propre(l)).collect::<Vec<_>>().join("%n%")),
    ];
    p.extend(position);
    for (k, v) in [
        ("scale", "1"),
        ("base_color", "#FFFFFF"),
        ("shadow", "true"),
        ("parse_markdown", "false"),
        ("interactable", "false"),
        ("enable_scrolling", "false"),
        ("auto_line_wrapping", "true"),
        ("text_border", "0"),
    ] {
        p.push((k, v.into()));
    }
    bloc("element", &p)
}

fn cache(id: &str) -> String {
    bloc("vanilla_button", &[("element_type", "vanilla_button".into()), ("instance_identifier", id.into()), ("is_hidden", "true".into())])
}

/// Bouton du jeu déplacé : il garde sa fonction, sa langue et ce que les autres mods lui ajoutent.
fn bouton(id: &str, position: Props, principal: bool, etiquette: Option<&str>) -> String {
    let mut p: Props = vec![("element_type", "vanilla_button".into()), ("instance_identifier", id.into()), ("is_hidden", "false".into())];
    p.extend(position);
    let (normal, survol) =
        if principal { ("bouton-principal.png", "bouton-principal-survol.png") } else { ("bouton.png", "bouton-survol.png") };
    p.extend([
        ("backgroundnormal", local(normal)),
        ("backgroundhovered", local(survol)),
        ("nine_slice_custom_background", "true".into()),
        ("nine_slice_border_x", "4".into()),
        ("nine_slice_border_y", "4".into()),
    ]);
    if let Some(e) = etiquette {
        p.push(("label", e.into()));
    }
    bloc("vanilla_button", &p)
}

fn b(id: &str, position: Props) -> String {
    bouton(id, position, false, None)
}

const SOLO: &str = "mc_titlescreen_singleplayer_button";
const MULTI: &str = "mc_titlescreen_multiplayer_button";
const REALMS: &str = "mc_titlescreen_realms_button";
const OPTIONS: &str = "mc_titlescreen_options_button";
const QUITTER: &str = "mc_titlescreen_quit_button";
const MODS_FABRIC: &str = "modmenu_titlescreen_mods_button";
const MODS_FORGE: &str = "forge_titlescreen_mods_button";

/// Ces petites icônes n'ont pas de nom dans FancyMenu : il les repère par leur position, calculée sur un écran de
/// 1000 × 1000. Elles bougent selon la version ; une rangée de plus (Mod Menu) les décale de 24, NeoForge de 8.
/// Toutes les positions connues sont écrites : un numéro absent est ignoré.
const DECALAGES: [i64; 3] = [0, 8, 24];
fn icone(places: &[(i64, i64)], position: &Props) -> Vec<String> {
    places.iter().flat_map(|(x, y)| DECALAGES.iter().map(move |d| b(&format!("{x}{}", y + d), position.clone()))).collect()
}
fn langue(p: Props) -> Vec<String> {
    icone(&[(376, 382), (490, 370)], &p)
}
fn accessibilite(p: Props) -> Vec<String> {
    icone(&[(604, 382), (514, 370)], &p)
}
/// Apparue avec 26.3.
fn amis(p: Props) -> Vec<String> {
    icone(&[(466, 370)], &p)
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Infos {
    pub instance: String,
    pub joueur: Option<String>,
    pub loader: Option<String>,
    pub mods: usize,
    pub monde: Option<String>,
}

fn lignes_carte(i: &Infos) -> Vec<String> {
    let mods = (i.mods > 0).then(|| format!("{} mods", i.mods));
    let deuxieme = [i.loader.clone(), mods].into_iter().flatten().collect::<Vec<_>>().join(" \u{b7} ");
    let monde = i.monde.as_ref().map(|m| tv("titlemenu.dernier_monde", &[("name", m)]));
    [Some(i.instance.clone()), Some(deuxieme), monde].into_iter().flatten().filter(|l| !l.is_empty()).collect()
}

fn accueil(i: &Infos) -> String {
    match &i.joueur {
        Some(j) => tv("titlemenu.bon_retour", &[("name", j)]),
        None => t("titlemenu.bon_retour_seul"),
    }
}

fn hauteur_logo(w: i64) -> i64 {
    (w as f64 / RAPPORT_LOGO).round() as i64
}

fn carte(i: &Infos, ancre: &str, x: i64, y: i64) -> Vec<String> {
    let l = lignes_carte(i);
    let n = l.len() as i64;
    vec![
        image("carte", "verre.png", place(ancre, x, y, 140, 14 + n * 12), Some(6)),
        texte("carte_texte", &l, place(ancre, x + 7, y + 6, 126, 6 + n * 12)),
    ]
}

// Tailles en pixels d'interface : le plus petit écran courant fait 426 × 240.
fn colonne(i: &Infos, avec_carte: bool) -> Vec<String> {
    let a = "mid-left";
    let x = 20;
    let mut p = vec![
        image("verre", "verre.png", place(a, 10, -108, 160, 216), Some(6)),
        image("logo", "logo.png", place(a, x, -98, 140, hauteur_logo(140)), None),
        texte("accueil", &[accueil(i)], place(a, x, -62, 140, 20)),
    ];
    p.extend(langue(place(a, x, -24, 20, 20)));
    p.extend(accessibilite(place(a, x + 23, -24, 20, 20)));
    p.extend(amis(place(a, x + 46, -24, 20, 20)));
    p.extend([
        b(MODS_FABRIC, place(a, x + 69, -24, 71, 20)),
        b(MODS_FORGE, place(a, x + 69, -24, 71, 20)),
        bouton(SOLO, place(a, x, 3, 140, 20), true, None),
        b(MULTI, place(a, x, 26, 140, 20)),
        b(REALMS, place(a, x, 49, 140, 20)),
        b(OPTIONS, place(a, x, 72, 68, 20)),
        b(QUITTER, place(a, x + 72, 72, 68, 20)),
    ]);
    if avec_carte {
        p.extend(carte(i, "top-right", -150, 10));
    }
    p
}

fn centre(i: &Infos, avec_carte: bool) -> Vec<String> {
    let a = "mid-centered";
    let mut p = vec![
        image("verre", "verre.png", place(a, -115, -104, 230, 186), Some(6)),
        image("logo", "logo.png", place(a, -90, -94, 180, hauteur_logo(180)), None),
        bouton(SOLO, place(a, -100, -18, 200, 20), true, None),
        b(MULTI, place(a, -100, 5, 98, 20)),
        bouton(REALMS, place(a, 2, 5, 98, 20), false, Some("Realms")),
        b(OPTIONS, place(a, -100, 28, 98, 20)),
        b(QUITTER, place(a, 2, 28, 98, 20)),
    ];
    p.extend(langue(place(a, -100, 51, 20, 20)));
    p.extend(amis(place(a, -77, 51, 20, 20)));
    p.extend([b(MODS_FABRIC, place(a, -54, 51, 131, 20)), b(MODS_FORGE, place(a, -54, 51, 131, 20))]);
    p.extend(accessibilite(place(a, 80, 51, 20, 20)));
    // Trop peu de place à côté du bloc sur un petit écran : la carte devient une ligne dedans.
    if avec_carte {
        let l: Vec<String> = lignes_carte(i).into_iter().take(2).collect();
        p.push(texte("carte", &l, place(a, -100, -50, 200, 28)));
    }
    p
}

fn minimal(i: &Infos, avec_carte: bool) -> Vec<String> {
    let a = "bottom-centered";
    let y = -46;
    let mut p = vec![
        image("logo", "logo.png", place("top-left", 12, 10, 130, hauteur_logo(130)), None),
        image("verre", "verre.png", place(a, -207, y - 5, 414, 30), Some(6)),
        bouton(SOLO, place(a, -202, y, 78, 20), true, None),
        b(MULTI, place(a, -120, y, 78, 20)),
        bouton(REALMS, place(a, -38, y, 78, 20), false, Some("Realms")),
        b(OPTIONS, place(a, 44, y, 78, 20)),
        b(QUITTER, place(a, 126, y, 76, 20)),
    ];
    p.extend(langue(place("top-right", -56, 10, 20, 20)));
    p.extend(accessibilite(place("top-right", -33, 10, 20, 20)));
    p.extend(amis(place("top-right", -79, 10, 20, 20)));
    p.extend([b(MODS_FABRIC, place("top-right", -155, 10, 72, 20)), b(MODS_FORGE, place("top-right", -155, 10, 72, 20))]);
    if avec_carte {
        p.extend(carte(i, "top-right", -150, 36));
    }
    p
}

pub fn mise_en_page(style: &str, avec_carte: bool, infos: &Infos, heure: i64) -> String {
    let construire = match style {
        "centre" => centre,
        "minimal" => minimal,
        _ => colonne,
    };
    let s = |v: &str| v.to_string();
    let mut sections = vec![
        s("type = fancymenu_layout"),
        bloc(
            "layout-meta",
            &[
                ("identifier", s("title_screen")),
                ("render_custom_elements_behind_vanilla", s("true")),
                ("last_edited_time", heure.to_string()),
                ("is_enabled", s("true")),
                ("layout_index", s("0")),
                ("widget_identifier_revision", s("1")),
                ("randommode", s("false")),
                ("randomgroup", s("1")),
                ("randomonlyfirsttime", s("false")),
            ],
        ),
        bloc(
            "menu_background",
            &[("instance_identifier", s("0rzxn_fond")), ("background_type", s("panorama")), ("panorama_name", s(PANORAMA))],
        ),
        cache("minecraft_logo_widget"),
        cache("minecraft_splash_widget"),
        cache("minecraft_realms_notification_widget"),
    ];
    sections.extend(construire(infos, avec_carte));
    format!("{}\n", sections.join("\n\n"))
}

fn lire(f: &Path) -> Resultat<Option<String>> {
    match std::fs::read_to_string(f) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Ajoute l'écran titre aux écrans personnalisés sans retirer ceux que le joueur a activés lui-même.
fn activer_ecran_titre(f: &Path) -> Resultat<()> {
    let actuel = lire(f)?.unwrap_or_default();
    if actuel.contains("TitleScreen") || actuel.contains("class_442") {
        return Ok(());
    }
    let base = if actuel.trim().is_empty() { "type = customizablemenus" } else { actuel.trim() };
    Ok(std::fs::write(f, format!("{base}\n\n{CLASSE_ECRAN_TITRE} {{\n}}\n"))?)
}

/// Masque la barre d'outils et la fenêtre d'accueil de FancyMenu, sans toucher au reste de ses options.
fn masquer_extras(f: &Path) -> Resultat<()> {
    let Some(actuel) = lire(f)? else {
        // Premier lancement : FancyMenu complétera le fichier avec ses autres options.
        return Ok(std::fs::write(
            f,
            "##[customization]\n\nB:show_customization_overlay = 'false';\n\n##[tutorial]\n\nB:show_welcome_screen = 'false';\n",
        )?);
    };
    static R: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"((?:show_customization_overlay|show_welcome_screen)\s*=\s*')true(')").unwrap());
    let suivant = R.replace_all(&actuel, "${1}false${2}");
    if suivant != actuel {
        std::fs::write(f, suivant.as_bytes())?;
    }
    Ok(())
}

/// Écrit les images ; le panorama seulement si le décor a changé (il est long à dessiner).
fn ecrire_images(d: &Dossiers, graine: u32, theme: &str) -> Resultat<()> {
    std::fs::create_dir_all(&d.images)?;
    for (nom, donnees) in [
        ("verre.png", art::verre()),
        ("bouton.png", art::bouton()),
        ("bouton-survol.png", art::bouton_survol()),
        ("bouton-principal.png", art::bouton_principal()),
        ("bouton-principal-survol.png", art::bouton_principal_survol()),
        ("logo.png", art::logo()),
    ] {
        std::fs::write(d.images.join(nom), donnees)?;
    }
    let tampon = d.panorama.join("decor.txt");
    let voulu = format!("{graine}:{theme}");
    if std::fs::read_to_string(&tampon).ok().as_deref() == Some(voulu.as_str()) {
        return Ok(());
    }
    let dossier = d.panorama.join("panorama");
    std::fs::create_dir_all(&dossier)?;
    for (i, face) in art::faces_panorama(graine, theme, 1024).into_iter().enumerate() {
        std::fs::write(dossier.join(format!("panorama_{i}.png")), face)?;
    }
    let meta = bloc("panorama-meta", &[("name", PANORAMA.into()), ("speed", "1".into()), ("fov", "85".into()), ("angle", "8".into())]);
    std::fs::write(d.panorama.join("properties.txt"), format!("type = panorama\n\n{meta}\n"))?;
    Ok(std::fs::write(tampon, voulu)?)
}

/// Écrit tout le nécessaire dans le dossier du jeu.
pub fn ecrire(dossier_jeu: &Path, graine: u32, theme: &str, style: &str, avec_carte: bool, infos: &Infos, heure: i64) -> Resultat<()> {
    let d = dossiers(dossier_jeu);
    std::fs::create_dir_all(&d.mises_en_page)?;
    ecrire_images(&d, graine, if THEMES.contains(&theme) { theme } else { "sunset" })?;
    activer_ecran_titre(&d.ecrans)?;
    masquer_extras(&d.options)?;
    std::fs::write(d.mises_en_page.join(MISE_EN_PAGE), mise_en_page(style, avec_carte, infos, heure))?;
    Ok(std::fs::write(d.images.join(TAMPON), heure.to_string())?)
}

/// FancyMenu change l'heure de la mise en page à chaque enregistrement dans son éditeur.
fn retouche_en_jeu(d: &Dossiers) -> bool {
    let (Ok(page), Ok(tampon)) =
        (std::fs::read_to_string(d.mises_en_page.join(MISE_EN_PAGE)), std::fs::read_to_string(d.images.join(TAMPON)))
    else {
        return false;
    };
    static R: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"last_edited_time = (\d+)").unwrap());
    R.captures(&page).map(|c| c[1].to_string()).as_deref() != Some(tampon.trim())
}

/// Retire uniquement nos fichiers : les mises en page créées par le joueur restent.
pub fn retirer(dossier_jeu: &Path) -> Resultat<()> {
    let d = dossiers(dossier_jeu);
    let f = d.mises_en_page.join(MISE_EN_PAGE);
    if f.exists() {
        std::fs::remove_file(f)?;
    }
    for r in [d.images, d.panorama] {
        if r.exists() {
            std::fs::remove_dir_all(r)?;
        }
    }
    Ok(())
}

pub fn a_mise_en_page(dossier_jeu: &Path) -> bool {
    dossiers(dossier_jeu).mises_en_page.join(MISE_EN_PAGE).exists()
}

fn jars(dossier_jeu: &Path) -> Vec<String> {
    std::fs::read_dir(dossier_jeu.join("mods"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.to_lowercase().ends_with(".jar"))
        .collect()
}

fn conflits(noms: &[String]) -> Vec<&'static str> {
    CONFLITS.iter().filter(|(m, _)| noms.iter().any(|n| m.is_match(n))).map(|(_, l)| *l).collect()
}

/// Monde joué en dernier : celui dont le level.dat est le plus récent.
fn dernier_monde(dossier_jeu: &Path) -> Option<String> {
    std::fs::read_dir(dossier_jeu.join("saves"))
        .ok()?
        .flatten()
        .filter_map(|e| Some((e.path().join("level.dat").metadata().ok()?.modified().ok()?, e.file_name().to_string_lossy().into_owned())))
        .max_by_key(|(t, _)| *t)
        .map(|(_, n)| n)
}

pub fn infos(dossier_jeu: &Path, instance: &Instance, joueur: Option<&str>) -> Infos {
    Infos {
        instance: instance.name.clone(),
        joueur: joueur.map(String::from),
        loader: Some(loader_name(&instance.loader).into()),
        mods: jars(dossier_jeu).len(),
        monde: dernier_monde(dossier_jeu),
    }
}

fn reglage(instance: &Instance) -> Option<&Value> {
    instance.title_menu.as_ref().filter(|v| v.is_object())
}

fn style_de(instance: &Instance) -> &str {
    reglage(instance).and_then(|v| v["style"].as_str()).filter(|s| STYLES.contains(s)).unwrap_or("colonne")
}

fn carte_de(instance: &Instance) -> bool {
    reglage(instance).is_none_or(|v| v["card"] != Value::Bool(false))
}

/// Réécrit le menu avec les informations du moment : à l'activation, puis avant chaque lancement.
pub fn rafraichir(dossier_jeu: &Path, instance: &Instance, joueur: Option<&str>, garder_retouches: bool) -> Resultat<()> {
    // Les retouches du joueur dans le jeu passent avant.
    if garder_retouches && retouche_en_jeu(&dossiers(dossier_jeu)) {
        return Ok(());
    }
    let i = infos(dossier_jeu, instance, joueur);
    let theme = instance.background.as_ref().map(|f| f.kind.as_str()).unwrap_or("sunset");
    let heure = chrono::Utc::now().timestamp_millis();
    ecrire(dossier_jeu, instance.seed.unwrap_or(1), theme, style_de(instance), carte_de(instance), &i, heure)
}

pub fn moddee(instance: &Instance) -> bool {
    instance.loader != "vanilla" && !instance.loader.is_empty()
}

/// Menu par défaut des instances moddées : il s'ajoute seul tant que personne n'a choisi pour l'instance.
/// `titleMenu` absent = jamais réglé ; null = menu classique choisi (ou retiré) : on n'y touche plus.
pub fn voulu_auto(instance: &Instance) -> bool {
    instance.title_menu.is_none() && moddee(instance)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Etat {
    pub modded: bool,
    /// None : inconnu (Modrinth ne répond pas).
    pub available: Option<bool>,
    pub installed: bool,
    pub active: bool,
    pub auto: bool,
    pub style: String,
    pub card: bool,
    pub conflicts: Vec<&'static str>,
}

/// Ce que l'interface doit savoir pour cette instance. `versions` (FancyMenu sur Modrinth pour l'instance) n'est
/// attendu que si le mod n'est pas déjà là.
pub async fn etat(dossier_jeu: &Path, instance: &Instance, versions: impl Future<Output = Resultat<usize>>) -> Etat {
    let modded = moddee(instance);
    let noms = jars(dossier_jeu);
    let installed = noms.iter().any(|n| n.to_lowercase().starts_with("fancymenu"));
    let available = if !modded {
        Some(false)
    } else if installed {
        Some(true)
    } else {
        versions.await.ok().map(|n| n > 0)
    };
    Etat {
        modded,
        available,
        installed,
        active: reglage(instance).is_some() && a_mise_en_page(dossier_jeu),
        auto: voulu_auto(instance),
        style: style_de(instance).into(),
        card: carte_de(instance),
        conflicts: conflits(&noms),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use serde_json::json;

    fn instance(v: Value) -> Instance {
        let mut base = json!({ "id": "a", "name": "A", "version": "1.21.11", "loader": "fabric" });
        for (k, x) in v.as_object().unwrap() {
            base[k] = x.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn mise_en_page_lisible() {
        let i = Infos {
            instance: "Survie {1}".into(),
            joueur: Some("Steve".into()),
            loader: Some("Fabric".into()),
            mods: 12,
            monde: Some("Mundo".into()),
        };
        let p = mise_en_page("colonne", true, &i, 42);
        assert!(p.starts_with("type = fancymenu_layout\n\nlayout-meta {\n  identifier = title_screen"));
        assert!(p.contains("  last_edited_time = 42\n"));
        assert!(p.contains("source = Survie  1%n%Fabric \u{b7} 12 mods%n%"), "{p}");
        assert!(p.contains("instance_identifier = 37638"), "langue décalée de 8 (NeoForge)");
        assert!(p.contains("  height = 29\n"), "logo de 140 de large");
        // Aucune ligne ne finit par « { » sauf les débuts de blocs.
        assert!(p.lines().filter(|l| l.ends_with('{')).all(|l| !l.starts_with(' ')));
        let c = mise_en_page("centre", false, &i, 1);
        assert!(c.contains("label = Realms") && !c.contains("0rzxn_carte"));
        assert!(mise_en_page("minimal", true, &i, 1).contains("0rzxn_carte_texte"));
        assert_eq!(lignes_carte(&Infos { instance: "A".into(), ..Default::default() }), vec!["A"]);
    }

    #[tokio::test]
    async fn ecrire_retoucher_retirer() {
        let d = Dossier::nouveau("ecran-titre");
        let jeu = d.0.join("jeu");
        std::fs::create_dir_all(jeu.join("mods")).unwrap();
        std::fs::write(jeu.join("mods/fancymenu-3.jar"), "").unwrap();
        std::fs::write(jeu.join("mods/Controlify-2.jar"), "").unwrap();
        let cfg = jeu.join("config/fancymenu");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("options.txt"), "B:show_welcome_screen = 'true';\nB:autre = 'true';\n").unwrap();
        std::fs::write(cfg.join("customizablemenus.txt"), "type = customizablemenus\n\nautre.Ecran {\n}\n").unwrap();

        let i = instance(json!({ "titleMenu": { "style": "minimal", "card": false } }));
        assert!(!voulu_auto(&i) && voulu_auto(&instance(json!({}))) && !voulu_auto(&instance(json!({ "titleMenu": null }))));
        // Mod présent : Modrinth n'est pas interrogé (sinon l'erreur donnerait None).
        let e = etat(&jeu, &i, async { Err(crate::erreur::Erreur::new("hors ligne")) }).await;
        assert_eq!(
            (e.installed, e.available, e.active, e.style.as_str(), e.card, e.conflicts),
            (true, Some(true), false, "minimal", false, vec!["Controlify"])
        );

        ecrire(&jeu, 3, "forest", "minimal", false, &infos(&jeu, &i, None), 1000).unwrap();
        assert!(etat(&jeu, &i, async { Ok(0) }).await.active);
        assert_eq!(std::fs::read_to_string(cfg.join("options.txt")).unwrap(), "B:show_welcome_screen = 'false';\nB:autre = 'true';\n");
        let ecrans = std::fs::read_to_string(cfg.join("customizablemenus.txt")).unwrap();
        assert!(ecrans.contains("autre.Ecran") && ecrans.ends_with("net.minecraft.client.gui.screens.TitleScreen {\n}\n"));
        assert_eq!(std::fs::read_to_string(cfg.join("panoramas/0rzxn/decor.txt")).unwrap(), "3:forest");
        assert!(cfg.join("panoramas/0rzxn/panorama/panorama_5.png").is_file());

        // Retouche dans l'éditeur de FancyMenu : gardée.
        let page = cfg.join("customization/0rzxn-menu.txt");
        std::fs::write(&page, std::fs::read_to_string(&page).unwrap().replace("last_edited_time = 1000", "last_edited_time = 2000"))
            .unwrap();
        rafraichir(&jeu, &i, Some("Alex"), true).unwrap();
        assert!(std::fs::read_to_string(&page).unwrap().contains("= 2000"));

        retirer(&jeu).unwrap();
        assert!(!a_mise_en_page(&jeu) && !cfg.join("assets/0rzxn").exists() && cfg.join("options.txt").exists());
        let vanilla = instance(json!({ "loader": "vanilla" }));
        assert_eq!(etat(&jeu, &vanilla, async { Ok(5) }).await.available, Some(false));
    }
}
