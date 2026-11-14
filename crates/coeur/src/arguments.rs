//! Ligne de commande Java : formats moderne (arguments) et ancien (minecraftArguments), comme core/args.js.

use crate::performances::{arguments_jvm, coeurs_logiques};
use crate::regles::{Systeme, autorise};
use commun::Reglages;
use regex::{Captures, Regex};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub type Variables = HashMap<String, String>;

fn substituer(modele: &str, vars: &Variables) -> String {
    static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\$\{([^}]+)\}").unwrap());
    VAR.replace_all(modele, |c: &Captures| vars.get(&c[1]).cloned().unwrap_or_else(|| c[0].to_string())).into_owned()
}

fn collecter(liste: Option<&Value>, vars: &Variables, fonctions: &[(&str, bool)], s: &Systeme) -> Vec<String> {
    let mut sortie = vec![];
    for element in liste.and_then(Value::as_array).into_iter().flatten() {
        match element {
            Value::String(a) => sortie.push(a.clone()),
            _ if autorise(element.get("rules"), fonctions, s) => match element.get("value") {
                Some(Value::String(a)) => sortie.push(a.clone()),
                Some(Value::Array(l)) => sortie.extend(l.iter().filter_map(Value::as_str).map(String::from)),
                _ => {}
            },
            _ => {}
        }
    }
    sortie.iter().map(|a| substituer(a, vars)).collect()
}

/// Arguments de l'utilisateur : coupés aux espaces, un argument entièrement entre guillemets garde les siens.
pub fn decouper_arguments(texte: &str) -> Vec<String> {
    static MOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""[^"]*"|\S+"#).unwrap());
    MOT.find_iter(texte)
        .map(|m| {
            let a = m.as_str();
            let a = a.strip_prefix('"').unwrap_or(a);
            a.strip_suffix('"').unwrap_or(a).to_string()
        })
        .collect()
}

/// La version gère-t-elle Quick Play (1.20 et plus) ? Lu dans les arguments du fichier de version.
pub fn quick_play_gere(version: &Value) -> bool {
    version.pointer("/arguments/game").and_then(Value::as_array).into_iter().flatten().any(|e| {
        e.get("rules")
            .and_then(Value::as_array)
            .is_some_and(|r| r.iter().any(|r| r.pointer("/features/is_quick_play_singleplayer").is_some_and(|v| v.as_bool() == Some(true))))
    })
}

/// Hôte et port d'une adresse de serveur (« play.exemple.fr », « 1.2.3.4:25570 », « [::1]:25565 »).
pub fn cible_serveur(adresse: &str) -> (String, u16) {
    static V6: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[([^\]]+)\](?::(\d+))?$").unwrap());
    static V4: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^:]+)(?::(\d+))?$").unwrap());
    let texte = adresse.trim();
    match V6.captures(texte).or_else(|| V4.captures(texte)) {
        Some(c) => (c[1].to_string(), c.get(2).and_then(|p| p.as_str().parse().ok()).unwrap_or(25565)),
        None => (texte.to_string(), 25565),
    }
}

/// Entrer directement dans un monde (« singleplayer ») ou sur un serveur (« multiplayer »).
#[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct QuickPlay {
    #[serde(rename = "type")]
    pub genre: String,
    pub id: String,
    #[serde(default)]
    pub name: String,
}

pub struct Demande<'a> {
    pub version: &'a Value,
    pub vars: Variables,
    pub reglages: &'a Reglages,
    pub config_logs: Option<&'a Path>,
    pub quick_play: Option<&'a QuickPlay>,
    /// Fichier où le jeu note le monde ou le serveur rejoint (1.20 et plus).
    pub fichier_quick_play: Option<&'a Path>,
    /// Version de Java qui lance le jeu (choix du ramasse-miettes).
    pub java: u32,
    pub systeme: &'a Systeme,
    pub cpus: usize,
}

impl<'a> Demande<'a> {
    pub fn new(version: &'a Value, vars: Variables, reglages: &'a Reglages) -> Self {
        let java = version.pointer("/javaVersion/majorVersion").and_then(Value::as_u64).unwrap_or(8) as u32;
        Self {
            version,
            vars,
            reglages,
            config_logs: None,
            quick_play: None,
            fichier_quick_play: None,
            java,
            systeme: Systeme::actuel(),
            cpus: coeurs_logiques(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ligne {
    pub jvm: Vec<String>,
    pub jeu: Vec<String>,
    /// Dossier des natives (-Djava.library.path).
    pub natives: PathBuf,
    pub gc: &'static str,
    /// Monde ou serveur réellement demandé au jeu.
    pub quick_play: Option<&'static str>,
}

pub fn construire(d: Demande) -> Ligne {
    let Demande { version, mut vars, reglages, config_logs, quick_play, fichier_quick_play, java, systeme: s, cpus } = d;
    let moderne = quick_play_gere(version);
    let cible = quick_play.filter(|q| q.genre == "singleplayer" || q.genre == "multiplayer");
    let genre = cible.map(|c| c.genre.as_str());
    let fonctions = [
        ("is_demo_user", false),
        ("has_custom_resolution", !reglages.fullscreen),
        ("has_quick_plays_support", moderne && fichier_quick_play.is_some()),
        ("is_quick_play_singleplayer", moderne && genre == Some("singleplayer")),
        ("is_quick_play_multiplayer", moderne && genre == Some("multiplayer")),
        ("is_quick_play_realms", false),
    ];
    if moderne {
        let id = |g: &str| cible.filter(|c| c.genre == g).map(|c| c.id.clone()).unwrap_or_default();
        vars.insert("quickPlayPath".into(), fichier_quick_play.map(|f| f.to_string_lossy().into_owned()).unwrap_or_default());
        vars.insert("quickPlaySingleplayer".into(), id("singleplayer"));
        vars.insert("quickPlayMultiplayer".into(), id("multiplayer"));
    }
    let regle = arguments_jvm(&reglages.jvm_preset, java, reglages.ram, &reglages.jvm_args, cpus);
    let mut jvm = regle.args;
    jvm.extend(decouper_arguments(&reglages.jvm_args));

    let var = |n: &str| vars.get(n).cloned().unwrap_or_default();
    if version.pointer("/arguments/jvm").is_some() {
        jvm.extend(collecter(version.pointer("/arguments/jvm"), &vars, &fonctions, s));
    } else {
        // macOS : la fenêtre du jeu (LWJGL) doit naître sur le premier fil ; les anciennes versions ne le disent pas.
        if s.nom == "osx" {
            jvm.push("-XstartOnFirstThread".into());
        }
        if s.nom == "windows" {
            jvm.push("-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump".into());
        }
        jvm.extend([
            format!("-Djava.library.path={}", var("natives_directory")),
            format!("-Dminecraft.launcher.brand={}", var("launcher_name")),
            format!("-Dminecraft.launcher.version={}", var("launcher_version")),
            "-cp".into(),
            var("classpath"),
        ]);
    }
    if let (Some(config), Some(arg)) = (config_logs, version.pointer("/logging/client/argument").and_then(Value::as_str)) {
        let chemin = HashMap::from([("path".to_string(), config.to_string_lossy().into_owned())]);
        jvm.push(substituer(arg, &chemin));
    }
    jvm.push("-Dlog4j2.formatMsgNoLookups=true".into());

    let mut jeu = if version.pointer("/arguments/game").is_some() {
        collecter(version.pointer("/arguments/game"), &vars, &fonctions, s)
    } else {
        let anciens = version.get("minecraftArguments").and_then(Value::as_str).unwrap_or("");
        let mut jeu: Vec<String> = anciens.split(' ').filter(|a| !a.is_empty()).map(|a| substituer(a, &vars)).collect();
        if !reglages.fullscreen {
            jeu.extend(["--width".into(), var("resolution_width"), "--height".into(), var("resolution_height")]);
        }
        jeu
    };
    if reglages.fullscreen {
        jeu.push("--fullscreen".into());
    }
    let mut rejoint = if moderne {
        match genre {
            Some("singleplayer") => Some("singleplayer"),
            Some("multiplayer") => Some("multiplayer"),
            _ => None,
        }
    } else {
        None
    };
    if !moderne && let Some(c) = cible.filter(|c| c.genre == "multiplayer") {
        let (hote, port) = cible_serveur(&c.id);
        jeu.extend(["--server".into(), hote, "--port".into(), port.to_string()]);
        rejoint = Some("multiplayer");
    }

    let natives = jvm
        .iter()
        .find_map(|a| a.strip_prefix("-Djava.library.path="))
        .map(|p| Path::new(p).components().collect())
        .unwrap_or_else(|| PathBuf::from(var("natives_directory")));
    Ligne { jvm, jeu, natives, gc: regle.gc, quick_play: rejoint }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fonction(nom: &str, valeur: Value) -> Value {
        json!({ "rules": [{ "action": "allow", "features": { nom: true } }], "value": valeur })
    }

    fn moderne() -> Value {
        json!({
            "id": "1.21.1",
            "javaVersion": { "majorVersion": 21 },
            "arguments": {
                "game": [
                    "--username", "${auth_player_name}", "--version", "${version_name}",
                    fonction("has_custom_resolution", json!(["--width", "${resolution_width}", "--height", "${resolution_height}"])),
                    fonction("has_quick_plays_support", json!(["--quickPlayPath", "${quickPlayPath}"])),
                    fonction("is_quick_play_singleplayer", json!(["--quickPlaySingleplayer", "${quickPlaySingleplayer}"])),
                    fonction("is_quick_play_multiplayer", json!(["--quickPlayMultiplayer", "${quickPlayMultiplayer}"])),
                    fonction("is_quick_play_realms", json!(["--quickPlayRealms", "${quickPlayRealms}"])),
                ],
                "jvm": [
                    { "rules": [{ "action": "allow", "os": { "name": "osx" } }], "value": ["-XstartOnFirstThread"] },
                    "-Djava.library.path=${natives_directory}", "-cp", "${classpath}",
                ],
            },
            "logging": { "client": { "argument": "-Dlog4j.configurationFile=${path}" } },
        })
    }

    fn ancien() -> Value {
        json!({ "id": "1.8.9", "minecraftArguments": "--username ${auth_player_name} --version ${version_name} --gameDir ${game_directory}" })
    }

    fn vars() -> Variables {
        [
            ("auth_player_name", "0Rzxn_"),
            ("version_name", "1.21.1"),
            ("game_directory", "C:/jeu"),
            ("natives_directory", "C:/jeu/natives"),
            ("classpath", "a.jar;b.jar"),
            ("launcher_name", "0Rzxn_ Launcher"),
            ("launcher_version", "0.4.0"),
            ("resolution_width", "854"),
            ("resolution_height", "480"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
    }

    fn reglages() -> Reglages {
        Reglages {
            fullscreen: false,
            jvm_preset: "g1".into(),
            ram: 4.0,
            jvm_args: r#"-Dfoo=bar "-Dchemin=C:\a b""#.into(),
            ..Default::default()
        }
    }

    fn sys(nom: &'static str) -> Systeme {
        Systeme { nom, arch: "x64", version: "10.0.26100".into() }
    }

    fn demande<'a>(v: &'a Value, r: &'a Reglages, s: &'a Systeme) -> Demande<'a> {
        Demande { systeme: s, cpus: 8, ..Demande::new(v, vars(), r) }
    }

    fn apres<'a>(l: &'a [String], a: &str) -> &'a str {
        &l[l.iter().position(|x| x == a).unwrap() + 1]
    }

    #[test]
    fn moderne_memoire_utilisateur_logs_resolution() {
        let (v, r, w) = (moderne(), reglages(), sys("windows"));
        let o = construire(Demande { config_logs: Some(Path::new("C:/logs/client.xml")), ..demande(&v, &r, &w) });
        assert_eq!(o.jvm[0], "-Xmx4096M");
        assert_eq!(o.gc, "g1");
        let pos = |a: &str| o.jvm.iter().position(|x| x == a).unwrap();
        assert!(pos("-XX:+UseG1GC") < pos("-Dfoo=bar"));
        pos(r"-Dchemin=C:\a b");
        pos("-Djava.library.path=C:/jeu/natives");
        assert_eq!(apres(&o.jvm, "-cp"), "a.jar;b.jar");
        pos("-Dlog4j.configurationFile=C:/logs/client.xml");
        assert_eq!(o.jvm.last().unwrap(), "-Dlog4j2.formatMsgNoLookups=true");
        assert!(!o.jvm.iter().any(|a| a == "-XstartOnFirstThread"));
        assert_eq!(o.jeu[..8], ["--username", "0Rzxn_", "--version", "1.21.1", "--width", "854", "--height", "480"]);
        assert!(!o.jeu.iter().any(|a| a.starts_with("--quickPlay")));
        assert_eq!(o.quick_play, None);
        assert_eq!(o.natives, Path::new("C:/jeu/natives").components().collect::<PathBuf>());
        let mac = sys("osx");
        assert!(construire(demande(&v, &r, &mac)).jvm.iter().any(|a| a == "-XstartOnFirstThread"));
    }

    #[test]
    fn moderne_plein_ecran() {
        let (v, w) = (moderne(), sys("windows"));
        let r = Reglages { fullscreen: true, ..reglages() };
        let o = construire(demande(&v, &r, &w));
        assert!(!o.jeu.iter().any(|a| a == "--width"));
        assert_eq!(o.jeu.last().unwrap(), "--fullscreen");
    }

    #[test]
    fn moderne_quick_play() {
        let (v, r, w) = (moderne(), reglages(), sys("windows"));
        let monde = QuickPlay { genre: "singleplayer".into(), id: "Mon monde".into(), name: String::new() };
        let solo =
            construire(Demande { quick_play: Some(&monde), fichier_quick_play: Some(Path::new("quickplay.json")), ..demande(&v, &r, &w) });
        assert_eq!(solo.quick_play, Some("singleplayer"));
        assert_eq!(apres(&solo.jeu, "--quickPlaySingleplayer"), "Mon monde");
        assert_eq!(apres(&solo.jeu, "--quickPlayPath"), "quickplay.json");
        assert!(!solo.jeu.iter().any(|a| a == "--quickPlayMultiplayer" || a == "--quickPlayRealms"));

        let serveur = QuickPlay { genre: "multiplayer".into(), id: "play.exemple.fr".into(), name: String::new() };
        let multi = construire(Demande { quick_play: Some(&serveur), ..demande(&v, &r, &w) });
        assert_eq!(multi.quick_play, Some("multiplayer"));
        assert_eq!(apres(&multi.jeu, "--quickPlayMultiplayer"), "play.exemple.fr");
        assert!(!multi.jeu.iter().any(|a| a == "--quickPlayPath" || a == "--server"));

        let realms = QuickPlay { genre: "realms".into(), id: "1".into(), name: String::new() };
        assert_eq!(construire(Demande { quick_play: Some(&realms), ..demande(&v, &r, &w) }).quick_play, None);
    }

    #[test]
    fn ancien_format() {
        let (v, r, w) = (ancien(), reglages(), sys("windows"));
        let o = construire(Demande { java: 8, ..demande(&v, &r, &w) });
        assert_eq!(o.jeu, ["--username", "0Rzxn_", "--version", "1.21.1", "--gameDir", "C:/jeu", "--width", "854", "--height", "480"]);
        assert!(o.jvm.iter().any(|a| a == "-Djava.library.path=C:/jeu/natives"));
        assert!(o.jvm.iter().any(|a| a == "-Dminecraft.launcher.brand=0Rzxn_ Launcher"));
        assert_eq!(apres(&o.jvm, "-cp"), "a.jar;b.jar");
        assert!(o.jvm.iter().any(|a| a.starts_with("-XX:HeapDumpPath=")));
        assert_eq!(o.gc, "g1");
        assert_eq!(Demande::new(&v, vars(), &r).java, 8);
    }

    #[test]
    fn ancien_format_sous_macos() {
        let (v, r) = (ancien(), reglages());
        let mac = sys("osx");
        let o = construire(demande(&v, &r, &mac));
        assert_eq!(o.jvm.iter().filter(|a| *a == "-XstartOnFirstThread").count(), 1);
        assert!(!o.jvm.iter().any(|a| a.starts_with("-XX:HeapDumpPath=")));
    }

    #[test]
    fn ancien_format_serveur_seulement() {
        let (v, r, w) = (ancien(), reglages(), sys("windows"));
        let serveur = QuickPlay { genre: "multiplayer".into(), id: "play.exemple.fr:25570".into(), name: String::new() };
        let multi = construire(Demande { quick_play: Some(&serveur), ..demande(&v, &r, &w) });
        assert_eq!(multi.jeu[multi.jeu.len() - 4..], ["--server", "play.exemple.fr", "--port", "25570"]);
        assert_eq!(multi.quick_play, Some("multiplayer"));
        let monde = QuickPlay { genre: "singleplayer".into(), id: "Mon monde".into(), name: String::new() };
        let solo = construire(Demande { quick_play: Some(&monde), ..demande(&v, &r, &w) });
        assert_eq!(solo.quick_play, None);
        assert!(!solo.jeu.iter().any(|a| a == "Mon monde"));
    }

    #[test]
    fn quick_play_selon_la_version() {
        assert!(quick_play_gere(&moderne()));
        assert!(!quick_play_gere(&ancien()));
        assert!(!quick_play_gere(&json!({ "arguments": { "game": ["--demo"] } })));
    }

    #[test]
    fn adresses_de_serveur() {
        assert_eq!(cible_serveur("play.exemple.fr"), ("play.exemple.fr".into(), 25565));
        assert_eq!(cible_serveur(" 1.2.3.4:25570 "), ("1.2.3.4".into(), 25570));
        assert_eq!(cible_serveur("[::1]:25566"), ("::1".into(), 25566));
        assert_eq!(cible_serveur("[2001:db8::1]"), ("2001:db8::1".into(), 25565));
    }

    #[test]
    fn arguments_de_l_utilisateur() {
        assert!(decouper_arguments("").is_empty());
        assert_eq!(decouper_arguments("  -Xss2M   -Da=b "), ["-Xss2M", "-Da=b"]);
        assert_eq!(decouper_arguments(r#"-Dx="un deux" "-Dy=trois quatre""#), [r#"-Dx="un"#, "deux", "-Dy=trois quatre"]);
    }
}
