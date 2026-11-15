//! Import depuis un autre launcher : instances rangées dans un dossier avec instance.cfg et mmc-pack.json (copie du
//! dossier du jeu, loader, réglages, temps de jeu), comme core/importer.js. La source est seulement lue.

use crate::erreur::{Erreur, Resultat};
use crate::fichiers::lire_json;
use crate::gestion_instances::{creer, marquer_importee, modifier};
use crate::i18n::{t, tv};
use crate::instances::{dossier, lire};
use crate::jeu::Jeu;
use commun::{Instance, Reglages};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

// ---------- Copie avec progression ----------

/// Fichiers d'un dossier (chemins relatifs). Les liens symboliques sont ignorés : on ne sort jamais de la source.
pub fn lister_fichiers(racine: &Path, sauter: &dyn Fn(&Path) -> bool) -> std::io::Result<Vec<PathBuf>> {
    fn parcourir(racine: &Path, rel: &Path, sauter: &dyn Fn(&Path) -> bool, sortie: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for e in std::fs::read_dir(racine.join(rel))?.flatten() {
            let enfant = rel.join(e.file_name());
            if sauter(&enfant) {
                continue;
            }
            let genre = e.file_type()?;
            if genre.is_dir() {
                parcourir(racine, &enfant, sauter, sortie)?;
            } else if genre.is_file() {
                sortie.push(enfant);
            }
        }
        Ok(())
    }
    let mut l = vec![];
    parcourir(racine, Path::new(""), sauter, &mut l)?;
    Ok(l)
}

/// Copie `de` dans `vers` (qui ne doit pas exister), fichier par fichier, avec (fait, total).
pub fn copier_arbre(
    de: &Path,
    vers: &Path,
    sauter: &dyn Fn(&Path) -> bool,
    progres: &dyn Fn(usize, usize),
    annule: &AtomicBool,
) -> Resultat<usize> {
    let fichiers = lister_fichiers(de, sauter)?;
    let total = fichiers.len();
    progres(0, total);
    std::fs::create_dir_all(vers)?;
    let mut dernier = std::time::Instant::now();
    for (i, rel) in fichiers.iter().enumerate() {
        if annule.load(Ordering::Relaxed) {
            return Err(Erreur::code(t("importer.import_annule"), "CANCELLED"));
        }
        let cible = vers.join(rel);
        if let Some(d) = cible.parent() {
            std::fs::create_dir_all(d)?;
        }
        if cible.exists() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists).into());
        }
        std::fs::copy(de.join(rel), &cible)?;
        // Pas un message par fichier : une instance moddée en compte des milliers.
        if i + 1 == total || dernier.elapsed().as_millis() > 100 {
            dernier = std::time::Instant::now();
            progres(i + 1, total);
        }
    }
    Ok(total)
}

// ---------- Instances d'un autre launcher ----------

/// instance.cfg : INI (section [General]), valeurs parfois entre guillemets et échappées.
pub fn lire_cfg(texte: &str) -> HashMap<String, String> {
    let mut v = HashMap::new();
    let mut section = "General".to_string();
    for brut in texte.lines() {
        let l = brut.trim();
        if l.is_empty() || l.starts_with(';') || l.starts_with('#') {
            continue;
        }
        if let Some(s) = l.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            section = s.into();
            continue;
        }
        if section != "General" {
            continue;
        }
        let Some(eq) = l.find('=').filter(|e| *e >= 1) else { continue };
        let mut valeur = l[eq + 1..].trim();
        if valeur.len() >= 2 && valeur.starts_with('"') && valeur.ends_with('"') {
            valeur = &valeur[1..valeur.len() - 1];
        }
        let mut sortie = String::new();
        let mut c = valeur.chars();
        while let Some(x) = c.next() {
            if x == '\\' {
                match c.next() {
                    Some('n') => sortie.push('\n'),
                    Some('t') => sortie.push('\t'),
                    Some('r') => sortie.push('\r'),
                    Some(o) => sortie.push(o),
                    None => {}
                }
            } else {
                sortie.push(x);
            }
        }
        v.insert(l[..eq].trim().to_string(), sortie);
    }
    v
}

fn loader_de_uid(uid: &str) -> Option<&'static str> {
    match uid {
        "net.fabricmc.fabric-loader" => Some("fabric"),
        "org.quiltmc.quilt-loader" => Some("quilt"),
        "net.minecraftforge" => Some("forge"),
        "net.neoforged" => Some("neoforge"),
        _ => None,
    }
}

/// Composants gérés automatiquement par notre launcher (bibliothèques et mappings du loader).
const INTEGRES: [&str; 5] = ["net.minecraft", "org.lwjgl", "org.lwjgl3", "net.fabricmc.intermediary", "org.quiltmc.hashed"];

/// Icônes de l'autre launcher → nos icônes de blocs (les icônes personnalisées deviennent de l'herbe).
pub fn icone(cle: &str) -> &'static str {
    let k = cle.to_lowercase();
    if k.contains("diamond") {
        "diamond"
    } else if ["stone", "cobble", "iron", "gold", "brick"].iter().any(|x| k.contains(x)) {
        "stone"
    } else if ["nether", "flame", "fire", "magma"].iter().any(|x| k.contains(x)) {
        "netherrack"
    } else if k.contains("sand") {
        "sand"
    } else if k.contains("ender") || k.contains("end_") || k == "end" {
        "end"
    } else {
        "grass"
    }
}

/// Groupe de chaque instance (instgroups.json), par nom de dossier.
fn groupes(dossier_instances: &Path) -> HashMap<String, String> {
    let v: Value = lire_json(&dossier_instances.join("instgroups.json")).unwrap_or_default();
    let mut g = HashMap::new();
    for (nom, groupe) in v["groups"].as_object().into_iter().flatten() {
        for d in groupe["instances"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            g.insert(d.to_string(), nom.clone());
        }
    }
    g
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub path: PathBuf,
    pub folder: String,
    pub name: String,
    pub icon: &'static str,
    pub group: Option<String>,
    pub version: Option<String>,
    pub loader: String,
    pub loader_version: Option<String>,
    pub playtime: f64,
    pub last_played_at: Option<i64>,
    pub settings: Map<String, Value>,
    pub has_game_dir: bool,
    pub warnings: Vec<String>,
    pub problem: Option<String>,
    pub supported: bool,
}

fn vrai(cfg: &HashMap<String, String>, c: &str) -> bool {
    cfg.get(c).map(String::as_str) == Some("true")
}

/// Réglages propres à l'instance (seulement ceux que l'autre launcher marque comme « remplacés »).
fn reglages(cfg: &HashMap<String, String>) -> Map<String, Value> {
    let mut s = Map::new();
    let nombre = |c: &str| cfg.get(c).and_then(|v| v.parse::<f64>().ok());
    if vrai(cfg, "OverrideMemory")
        && let Some(mo) = nombre("MaxMemAlloc").filter(|m| *m > 0.0)
    {
        s.insert("ram".into(), json!((((mo / 1024.0) * 2.0).round() / 2.0).max(0.5)));
    }
    // Java choisi automatiquement par l'autre launcher : on laisse notre launcher choisir le sien.
    let java = cfg.get("JavaPath").map(|j| j.replace('/', std::path::MAIN_SEPARATOR_STR));
    if (vrai(cfg, "OverrideJavaLocation") || vrai(cfg, "OverrideJava"))
        && !vrai(cfg, "AutomaticJava")
        && let Some(j) = java.filter(|j| !j.is_empty() && Path::new(j).exists())
    {
        s.insert("java".into(), "custom".into());
        s.insert("javaPath".into(), j.into());
    }
    if (vrai(cfg, "OverrideJavaArgs") || vrai(cfg, "OverrideJava"))
        && let Some(a) = cfg.get("JvmArgs").filter(|a| !a.is_empty())
    {
        s.insert("jvmArgs".into(), a.clone().into());
    }
    let entier = |c: &str| cfg.get(c).and_then(|v| v.parse::<i64>().ok());
    if vrai(cfg, "OverrideWindow")
        && let (Some(l), Some(h)) = (entier("MinecraftWinWidth"), entier("MinecraftWinHeight"))
    {
        s.insert("width".into(), l.into());
        s.insert("height".into(), h.into());
    }
    s
}

fn dossier_jeu_source(d: &Path) -> Option<PathBuf> {
    ["minecraft", ".minecraft"].iter().map(|n| d.join(n)).find(|p| p.exists())
}

/// Lit une instance d'un autre launcher sans rien modifier. `supported` est faux si on ne sait pas la reprendre.
pub fn lire_source(d: &Path, groupes: &HashMap<String, String>) -> Resultat<Source> {
    let cfg = lire_cfg(&std::fs::read_to_string(d.join("instance.cfg"))?);
    let pack: Value = lire_json(&d.join("mmc-pack.json")).unwrap_or_default();
    let composants: Vec<&Value> = pack["components"].as_array().into_iter().flatten().collect();
    let mut avertissements = vec![];
    let version = composants.iter().find(|c| c["uid"] == "net.minecraft").and_then(|c| c["version"].as_str()).map(String::from);
    let loaders: Vec<&&Value> = composants.iter().filter(|c| c["uid"].as_str().and_then(loader_de_uid).is_some()).collect();
    let loader = loaders.first().and_then(|c| c["uid"].as_str()).and_then(loader_de_uid).unwrap_or("vanilla").to_string();
    for c in &composants {
        let uid = c["uid"].as_str().unwrap_or("");
        if INTEGRES.contains(&uid) || loader_de_uid(uid).is_some() {
            continue;
        }
        let nom = c["cachedName"].as_str().filter(|n| !n.is_empty()).unwrap_or(uid);
        avertissements.push(tv("importer.composant_non_repris", &[("cachedName", nom)]));
    }
    let version_loader = loaders.first().and_then(|c| c["version"].as_str()).map(String::from);
    let probleme = if cfg.get("InstanceType").is_some_and(|t| !t.is_empty() && t != "OneSix") {
        Some(t("importer.ancien_format_instance_legacy_non"))
    } else if version.is_none() {
        Some(t("importer.version_de_minecraft_introuvable_dans"))
    } else if loaders.len() > 1 {
        Some(t("importer.plusieurs_loaders_de_mods_dans"))
    } else if loader != "vanilla" && version_loader.is_none() {
        Some(t("importer.version_du_loader_introuvable"))
    } else {
        None
    };
    if std::fs::read_dir(d.join("jarmods")).is_ok_and(|mut it| it.next().is_some()) {
        avertissements.push(t("importer.les_jar_mods_ne_sont"));
    }
    let dossier = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let secondes = cfg.get("totalTimePlayed").and_then(|v| v.parse::<f64>().ok()).filter(|s| *s > 0.0);
    let dernier = cfg.get("lastLaunchTime").and_then(|v| v.parse::<i64>().ok()).filter(|s| *s > 0);
    let nom = cfg.get("name").filter(|n| !n.trim().is_empty()).cloned().unwrap_or_else(|| dossier.clone());
    Ok(Source {
        path: d.into(),
        group: groupes.get(&dossier).cloned(),
        name: nom.trim().into(),
        icon: icone(cfg.get("iconKey").map_or("", String::as_str)),
        version,
        loader_version: if loader == "vanilla" { None } else { version_loader },
        loader,
        playtime: secondes.map_or(0.0, |s| (s / 60.0).round()),
        last_played_at: dernier,
        settings: reglages(&cfg),
        has_game_dir: dossier_jeu_source(d).is_some(),
        warnings: avertissements,
        supported: probleme.is_none(),
        problem: probleme,
        folder: dossier,
    })
}

/// Dossiers de données possibles du launcher compatible le plus courant, du plus probable au moins probable.
/// Les noms sont ceux de ses dossiers sur le disque, nécessaires pour le trouver (Flatpak compris sous Linux).
pub fn racines_import() -> Vec<PathBuf> {
    use crate::chemins::{app_data, maison, xdg};
    if cfg!(any(windows, target_os = "macos")) {
        return vec![app_data().join("PrismLauncher")];
    }
    vec![
        xdg("XDG_DATA_HOME", ".local/share").join("PrismLauncher"),
        maison().join(".var").join("app").join("org.prismlauncher.PrismLauncher").join("data").join("PrismLauncher"),
    ]
}

/// Dossier d'instances par défaut : celui du launcher compatible s'il est installé (réglage InstanceDir de son
/// fichier .cfg, sinon « instances »).
pub fn dossier_par_defaut(racines: &[PathBuf]) -> PathBuf {
    let racine = racines.iter().find(|r| r.exists()).or(racines.first()).cloned().unwrap_or_default();
    // Aucun launcher compatible installé : « instances ».
    let d = std::fs::read_to_string(racine.join("prismlauncher.cfg"))
        .ok()
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("InstanceDir=").map(|v| v.trim().trim_matches('"').to_string())))
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| "instances".into());
    let p = Path::new(&d);
    if p.is_absolute() { p.into() } else { racine.join(p) }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Analyse {
    pub launcher: Option<String>,
    pub dir: PathBuf,
    pub instances: Vec<Source>,
}

/// Instances d'un dossier : soit un dossier d'instances, soit une seule instance.
pub fn analyser(d: &Path) -> Analyse {
    if d.join("instance.cfg").exists() {
        let parent = d.parent().unwrap_or(d);
        let l = lire_source(d, &groupes(parent)).ok().into_iter().collect();
        return Analyse { launcher: Some(t("importer.autre_launcher")), dir: d.into(), instances: l };
    }
    let Ok(it) = std::fs::read_dir(d) else { return Analyse { launcher: None, dir: d.into(), instances: vec![] } };
    let g = groupes(d);
    let mut l: Vec<Source> = it
        .flatten()
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_dir())
                && !e.file_name().to_string_lossy().starts_with('.')
                && e.path().join("instance.cfg").exists()
        })
        .filter_map(|e| lire_source(&e.path(), &g).ok())
        .collect();
    l.sort_by_key(|s| std::cmp::Reverse(s.last_played_at.unwrap_or(0)));
    Analyse { launcher: Some(t("importer.autre_launcher")), dir: d.into(), instances: l }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Importee {
    pub instance: Instance,
    pub files: usize,
    pub warnings: Vec<String>,
}

/// Crée une nouvelle instance à partir d'une instance d'un autre launcher (copie complète de son dossier du jeu).
pub async fn importer(
    jeu: &Jeu,
    source_dir: &Path,
    defauts: &Reglages,
    progres: &dyn Fn(usize, usize),
    annule: &AtomicBool,
) -> Resultat<Importee> {
    let racine = &jeu.dossiers.racine;
    let s = lire_source(source_dir, &groupes(source_dir.parent().unwrap_or(source_dir)))?;
    if let Some(p) = &s.problem {
        return Err(Erreur::new(p.clone()));
    }
    let mc = s.version.clone().unwrap_or_default();
    let version_loader = match &s.loader_version {
        Some(v) => Some(jeu.version_loader_du_pack(&s.loader, &mc, v).await?),
        None => None,
    };
    let i = creer(
        racine,
        &json!({ "name": s.name, "icon": s.icon, "version": mc, "loader": s.loader, "loaderVersion": version_loader, "group": s.group }),
        defauts,
    )?;
    let resultat = (|| -> Resultat<usize> {
        if !s.settings.is_empty() {
            modifier(racine, &i.id, &json!({ "settings": s.settings }))?;
        }
        let mut n = 0;
        if let Some(de) = dossier_jeu_source(source_dir) {
            let vers = dossier(racine, &i.id).join("minecraft");
            // Dossier vide créé à la création.
            let _ = std::fs::remove_dir_all(&vers);
            n = copier_arbre(&de, &vers, &|rel| rel.file_name().is_some_and(|f| f == "session.lock"), progres, annule)?;
        }
        let origine = json!({ "launcher": t("importer.autre_launcher"), "path": source_dir, "name": s.name });
        marquer_importee(racine, &i.id, origine, s.playtime, s.last_played_at)?;
        Ok(n)
    })();
    match resultat {
        Ok(n) => Ok(Importee {
            instance: lire(racine, &i.id).ok_or_else(|| Erreur::new(t("instances.instance_introuvable")))?,
            files: n,
            warnings: s.warnings,
        }),
        Err(e) => {
            // Instance incomplète : on la retire. La source n'est jamais touchée.
            let _ = std::fs::remove_dir_all(dossier(racine, &i.id));
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chemins::Dossiers;
    use crate::essai::Dossier;
    use crate::net::Reseau;
    use std::sync::Arc;

    #[test]
    fn fichier_cfg_et_icones() {
        let c = lire_cfg("[General]\nname=\"Mon \\\"pack\\\"\"\nJvmArgs=-Xss2M\\n\n; note\n[UI]\nname=autre\n");
        assert_eq!(c["name"], "Mon \"pack\"");
        assert_eq!(c["JvmArgs"], "-Xss2M\n");
        assert_eq!(
            (icone("diamond_ore"), icone("cobblestone"), icone("magma"), icone("end"), icone("perso")),
            ("diamond", "stone", "netherrack", "end", "grass")
        );
    }

    #[tokio::test]
    async fn analyse_et_import_vanilla() {
        let d = Dossier::nouveau("import");
        let src = d.0.join("instances");
        d.ecrire("instances/instgroups.json", r#"{"groups":{"Amis":{"instances":["survie"]}}}"#);
        d.ecrire(
            "instances/survie/instance.cfg",
            "[General]\nname=Survie\niconKey=diamond\ntotalTimePlayed=3600\nlastLaunchTime=1700000000000\nOverrideMemory=true\nMaxMemAlloc=6144\nOverrideWindow=true\nMinecraftWinWidth=1600\nMinecraftWinHeight=900\n",
        );
        d.ecrire(
            "instances/survie/mmc-pack.json",
            r#"{"components":[{"uid":"net.minecraft","version":"1.21.1"},{"uid":"com.mumfrey.liteloader","cachedName":"LiteLoader"}]}"#,
        );
        d.ecrire("instances/survie/minecraft/saves/Monde/level.dat", "x");
        d.ecrire("instances/survie/minecraft/saves/Monde/session.lock", "x");
        d.ecrire("instances/legacy/instance.cfg", "InstanceType=Legacy\n");
        d.ecrire("instances/legacy/mmc-pack.json", "{}");
        d.ecrire("instances/.cache/instance.cfg", "");

        let a = analyser(&src);
        let noms: Vec<(&str, bool)> = a.instances.iter().map(|s| (s.name.as_str(), s.supported)).collect();
        assert_eq!(noms, [("Survie", true), ("legacy", false)]);
        let s = &a.instances[0];
        assert_eq!((s.group.as_deref(), s.icon, s.playtime, s.warnings.len()), (Some("Amis"), "diamond", 60.0, 1));
        assert_eq!(s.settings["ram"], 6.0);
        assert_eq!(analyser(&src.join("survie")).instances.len(), 1);

        let jeu = Jeu::new(Dossiers::new(&d.0.join("racine")), Arc::new(Reseau::new()));
        let i = importer(&jeu, &src.join("survie"), &Reglages::default(), &|_, _| {}, &AtomicBool::new(false)).await.unwrap();
        assert_eq!((i.files, i.instance.settings.ram, i.instance.settings.width, i.instance.playtime), (1, 6.0, 1600, 60.0));
        assert!(d.0.join("racine/instances/survie/minecraft/saves/Monde/level.dat").is_file());
        assert!(!d.0.join("racine/instances/survie/minecraft/saves/Monde/session.lock").exists());
        assert!(src.join("survie/minecraft/saves/Monde/session.lock").exists(), "source intacte");
        assert!(importer(&jeu, &src.join("legacy"), &Reglages::default(), &|_, _| {}, &AtomicBool::new(false)).await.is_err());
        let par_defaut = dossier_par_defaut(&[d.0.join("absent"), d.0.join("aussi")]);
        assert_eq!(par_defaut, d.0.join("absent").join("instances"));
    }
}
