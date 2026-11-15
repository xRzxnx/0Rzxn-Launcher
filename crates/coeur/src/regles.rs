//! Règles des fichiers de version Mojang (système, architecture, fonctionnalités) et chemins Maven, comme core/rules.js.

use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

/// Système qui lance le jeu : nom Mojang, processeur (noms de Node : x64, arm64, ia32) et version du noyau.
#[derive(Debug, Clone, PartialEq)]
pub struct Systeme {
    pub nom: &'static str,
    pub arch: &'static str,
    pub version: String,
}

impl Systeme {
    pub fn actuel() -> &'static Systeme {
        static S: OnceLock<Systeme> = OnceLock::new();
        S.get_or_init(|| Systeme { nom: nom_os(), arch: arch(), version: version_os() })
    }
    /// Architecture comme l'écrivent les règles Mojang (« x86 » pour un processeur 32 bits).
    pub fn arch_mojang(&self) -> &'static str {
        if self.arch == "ia32" { "x86" } else { self.arch }
    }
}

pub fn nom_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// Processeur, avec les noms de Node (process.arch) gardés dans les dossiers et les règles du launcher.
pub fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        autre => autre,
    }
}

/// Version du système comme os.release() : « 10.0.26100 » sous Windows, version du noyau ailleurs.
fn version_os() -> String {
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let cle = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion");
        if let Ok(c) = cle {
            let majeure: u32 = c.get_value("CurrentMajorVersionNumber").unwrap_or(10);
            let mineure: u32 = c.get_value("CurrentMinorVersionNumber").unwrap_or(0);
            let build: String = c.get_value("CurrentBuildNumber").unwrap_or_default();
            return format!("{majeure}.{mineure}.{build}");
        }
        String::new()
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/sys/kernel/osrelease").map(|s| s.trim().to_string()).unwrap_or_default()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        std::process::Command::new("uname")
            .arg("-r")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    }
}

/// Fonctionnalités demandées au lancement (has_custom_resolution…) ; absente = false.
pub type Fonctions<'a> = &'a [(&'a str, bool)];

/// Applique une liste de règles « allow / disallow » : la dernière règle qui correspond l'emporte.
pub fn autorise(regles: Option<&Value>, fonctions: Fonctions, s: &Systeme) -> bool {
    let Some(regles) = regles.and_then(Value::as_array).filter(|r| !r.is_empty()) else { return true };
    let mut permis = false;
    for regle in regles {
        let mut ok = true;
        if let Some(os) = regle.get("os") {
            if os.get("name").and_then(Value::as_str).is_some_and(|n| n != s.nom) {
                ok = false;
            }
            if os.get("arch").and_then(Value::as_str).is_some_and(|a| a != s.arch_mojang()) {
                ok = false;
            }
            if let Some(v) = os.get("version").and_then(Value::as_str) {
                // Une expression illisible ne correspond à rien.
                if !Regex::new(v).is_ok_and(|r| r.is_match(&s.version)) {
                    ok = false;
                }
            }
        }
        if let Some(f) = regle.get("features").and_then(Value::as_object) {
            for (cle, valeur) in f {
                let demande = fonctions.iter().any(|(n, v)| n == cle && *v);
                if Some(demande) != valeur.as_bool() {
                    ok = false;
                }
            }
        }
        if ok {
            permis = regle.get("action").and_then(Value::as_str) == Some("allow");
        }
    }
    permis
}

/// « groupe:artefact:version[:classifieur][@ext] » → ses morceaux.
#[derive(Debug, Clone, PartialEq)]
pub struct Maven<'a> {
    pub groupe: &'a str,
    pub artefact: &'a str,
    pub version: &'a str,
    pub classifieur: Option<&'a str>,
    pub ext: &'a str,
}

pub fn maven(nom: &str) -> Maven<'_> {
    let (coords, ext) = nom.split_once('@').unwrap_or((nom, "jar"));
    let mut p = coords.split(':');
    Maven { groupe: p.next().unwrap_or(""), artefact: p.next().unwrap_or(""), version: p.next().unwrap_or(""), classifieur: p.next(), ext }
}

pub fn chemin_maven(nom: &str) -> String {
    let m = maven(nom);
    let fichier = match m.classifieur {
        Some(c) => format!("{}-{}-{c}.{}", m.artefact, m.version, m.ext),
        None => format!("{}-{}.{}", m.artefact, m.version, m.ext),
    };
    let mut morceaux: Vec<&str> = m.groupe.split('.').collect();
    morceaux.extend([m.artefact, m.version, &fichier]);
    morceaux.join("/")
}

/// Les fichiers de version listent les natives de toutes les architectures pour un même système
/// (natives-windows et natives-windows-arm64) : on ne garde que celles de ce processeur.
pub fn natives_de_ce_processeur(classifieur: Option<&str>, arch: &str) -> bool {
    let Some(c) = classifieur.filter(|c| c.starts_with("natives-")) else { return true };
    if c.ends_with("-arm64") || c.ends_with("-aarch_64") {
        return arch == "arm64";
    }
    if c.ends_with("-x86") {
        return arch == "ia32";
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(nom: &'static str) -> Systeme {
        Systeme { nom, arch: "x64", version: "10.0.26100".into() }
    }

    #[test]
    fn sans_regle_tout_est_permis() {
        assert!(autorise(None, &[], &s("windows")));
        assert!(autorise(Some(&json!([])), &[], &s("windows")));
    }

    #[test]
    fn la_derniere_regle_qui_correspond_l_emporte() {
        let w = s("windows");
        assert!(autorise(Some(&json!([{ "action": "allow" }])), &[], &w));
        assert!(!autorise(Some(&json!([{ "action": "allow" }, { "action": "disallow", "os": { "name": "windows" } }])), &[], &w));
        assert!(autorise(Some(&json!([{ "action": "allow" }, { "action": "disallow", "os": { "name": "linux" } }])), &[], &w));
        assert!(!autorise(Some(&json!([{ "action": "allow", "os": { "name": "linux" } }])), &[], &w));
    }

    #[test]
    fn architecture_et_version_du_systeme() {
        let w = s("windows");
        assert!(!autorise(Some(&json!([{ "action": "allow", "os": { "arch": "x86" } }])), &[], &w));
        assert!(autorise(Some(&json!([{ "action": "allow", "os": { "arch": "x86" } }])), &[], &Systeme { arch: "ia32", ..w.clone() }));
        assert!(autorise(Some(&json!([{ "action": "allow", "os": { "name": "windows", "version": "^10\\." } }])), &[], &w));
        assert!(!autorise(Some(&json!([{ "action": "allow", "os": { "version": "^6\\." } }])), &[], &w));
        assert!(!autorise(Some(&json!([{ "action": "allow", "os": { "version": "([" } }])), &[], &w));
    }

    #[test]
    fn fonctionnalites_demandees() {
        let w = s("windows");
        let r = json!([{ "action": "allow", "features": { "has_custom_resolution": true } }]);
        assert!(autorise(Some(&r), &[("has_custom_resolution", true)], &w));
        assert!(!autorise(Some(&r), &[], &w));
        assert!(autorise(Some(&json!([{ "action": "allow", "features": { "is_demo_user": false } }])), &[], &w));
    }

    #[test]
    fn chemins_maven() {
        assert_eq!(chemin_maven("net.fabricmc:fabric-loader:0.17.2"), "net/fabricmc/fabric-loader/0.17.2/fabric-loader-0.17.2.jar");
        assert_eq!(chemin_maven("org.lwjgl:lwjgl:3.3.3:natives-windows"), "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar");
        assert_eq!(
            chemin_maven("de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412@zip"),
            "de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412.zip"
        );
        assert_eq!(maven("a.b:c:1:d@txt"), Maven { groupe: "a.b", artefact: "c", version: "1", classifieur: Some("d"), ext: "txt" });
    }

    #[test]
    fn natives_de_ce_processeur_seulement() {
        assert!(natives_de_ce_processeur(None, "x64"));
        assert!(natives_de_ce_processeur(Some("sources"), "x64"));
        assert!(natives_de_ce_processeur(Some("natives-windows"), "x64"));
        assert!(!natives_de_ce_processeur(Some("natives-windows-arm64"), "x64"));
        assert!(natives_de_ce_processeur(Some("natives-linux-aarch_64"), "arm64"));
        assert!(!natives_de_ce_processeur(Some("natives-windows-x86"), "x64"));
        assert!(natives_de_ce_processeur(Some("natives-windows-x86"), "ia32"));
    }

    #[test]
    fn systeme_actuel() {
        let s = Systeme::actuel();
        assert_eq!(s.nom, nom_os());
        if cfg!(windows) {
            assert!(Regex::new(r"^\d+\.\d+\.\d+$").unwrap().is_match(&s.version), "{}", s.version);
        }
    }
}
