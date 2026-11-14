//! Java automatique (runtimes officiels de Mojang) et Java du PC, comme core/java.js et platform/chemins.js.

use crate::erreur::{Erreur, Resultat};
use crate::i18n::{t, tv};
use crate::jeu::Jeu;
use crate::net::Options;
use crate::regles::Systeme;
use crate::telechargement::{Progression, Tache, sha1};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const URL_INDEX: &str = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";
const MARQUE: &str = ".0rzxn-manifest";
/// Mémoire au plus d'un Java 32 bits, en Go (l'espace d'adresses limite le tas à environ 1,5 Go sous Windows).
pub const JAVA_32_MAX_GO: f64 = 1.5;

/// Clé de Mojang pour un système et un processeur (`arch` : celui du PC, ou x64 pour Rosetta).
pub fn cle_plateforme(arch: &str, os: &str) -> &'static str {
    match (os, arch) {
        ("windows", "arm64") => "windows-arm64",
        ("windows", "ia32") => "windows-x86",
        ("windows", _) => "windows-x64",
        ("osx", "arm64") => "mac-os-arm64",
        ("osx", _) => "mac-os",
        (_, "ia32") => "linux-i386",
        _ => "linux",
    }
}

/// La version a-t-elle des natives pour les Mac Apple Silicon ? Oui à partir de Minecraft 1.19 (LWJGL 3.3).
pub fn natives_mac_arm64(version: &Value) -> bool {
    version.get("libraries").and_then(Value::as_array).into_iter().flatten().any(|lib| {
        lib.get("name").and_then(Value::as_str).is_some_and(|n| n.contains("natives-macos-arm64"))
            || lib
                .pointer("/downloads/classifiers")
                .and_then(Value::as_object)
                .is_some_and(|c| c.keys().any(|k| k.contains("natives-macos-arm64")))
    })
}

/// Mac Apple Silicon et version sans natives arm64 : le jeu tourne avec un Java Intel, traduit par Rosetta.
pub fn rosetta_necessaire(version: &Value, s: &Systeme) -> bool {
    s.nom == "osx" && s.arch == "arm64" && !natives_mac_arm64(version)
}

/// Rosetta 2 installé (Apple le place toujours ici).
pub fn rosetta_installe() -> bool {
    Path::new("/Library/Apple/usr/share/rosetta/rosetta").exists()
}

/// Exécutable Java d'un runtime Mojang. Sous Windows, java.exe (et non javaw) pour lire les logs.
pub fn executable_runtime(dossier: &Path, os: &str) -> PathBuf {
    match os {
        "windows" => dossier.join("bin").join("java.exe"),
        "osx" => dossier.join("jre.bundle").join("Contents").join("Home").join("bin").join("java"),
        _ => dossier.join("bin").join("java"),
    }
}

impl Jeu {
    /// Installe (si besoin) le runtime `composant` (ex. java-runtime-epsilon) et renvoie le chemin de Java.
    /// Hors connexion, un runtime déjà installé est réutilisé. `arch` x64 sur un Mac Apple Silicon : version Intel
    /// (Rosetta), rangée à part (« jre-legacy-x64 ») pour ne pas écraser la version arm64.
    pub async fn runtime(
        &self,
        composant: &str,
        arch: &str,
        annule: Option<CancellationToken>,
        progression: Option<Arc<dyn Fn(Progression) + Send + Sync>>,
    ) -> Resultat<PathBuf> {
        let s = Systeme::actuel();
        let nom = if arch == s.arch { composant.to_string() } else { format!("{composant}-{arch}") };
        let dossier = self.dossiers.runtime.join(nom);
        let exe = executable_runtime(&dossier, s.nom);
        let marque = dossier.join(MARQUE);
        let installe = exe.is_file() && marque.is_file();

        let o = Options::annulable(annule.as_ref());
        let entree = match self.reseau().json::<Value>(URL_INDEX, &o).await {
            Ok(index) => index.get(cle_plateforme(arch, s.nom)).and_then(|p| p.get(composant)).and_then(|c| c.get(0)).cloned(),
            Err(_) if installe => return Ok(exe),
            Err(e) => {
                return Err(Erreur::new(tv("java.java_est_pas_encore_installe", &[("component", composant), ("message", &e.message)])));
            }
        };
        let Some(entree) = entree else {
            if installe {
                return Ok(exe);
            }
            return Err(Erreur::new(tv("java.mojang_ne_fournit_pas_pour", &[("component", composant)])));
        };
        let attendu = entree.pointer("/manifest/sha1").and_then(Value::as_str).unwrap_or("");
        if installe && std::fs::read_to_string(&marque).is_ok_and(|m| m.trim() == attendu) {
            return Ok(exe);
        }

        let url = entree.pointer("/manifest/url").and_then(Value::as_str).unwrap_or("");
        let brut = self.reseau().octets(url, &o).await?;
        if sha1(&brut) != attendu {
            return Err(Erreur::new(t("java.le_manifeste_de_java_telecharge")));
        }
        let manifeste: Value = serde_json::from_slice(&brut).map_err(|e| Erreur::new(e.to_string()))?;
        let mut taches = vec![];
        let mut executables = vec![];
        let mut liens = vec![];
        for (nom, f) in manifeste.get("files").and_then(Value::as_object).into_iter().flatten() {
            let cible = crate::installation::sous(&dossier, nom);
            match f.get("type").and_then(Value::as_str) {
                Some("directory") => std::fs::create_dir_all(&cible)?,
                Some("file") => {
                    let Some(r) = f.pointer("/downloads/raw") else { continue };
                    if f.get("executable").and_then(Value::as_bool) == Some(true) {
                        executables.push(cible.clone());
                    }
                    taches.push(Tache {
                        url: r.get("url").and_then(Value::as_str).unwrap_or("").into(),
                        chemin: cible,
                        sha1: r.get("sha1").and_then(Value::as_str).map(String::from),
                        taille: r.get("size").and_then(Value::as_u64),
                        ..Default::default()
                    });
                }
                Some("link") => liens.push((cible, f.get("target").and_then(Value::as_str).unwrap_or("").to_string())),
                _ => {}
            }
        }
        self.telechargeur.tous(taches, 16, false, annule, progression).await?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in &executables {
                std::fs::set_permissions(f, std::fs::Permissions::from_mode(0o755))?;
            }
            for (lien, vers) in &liens {
                let _ = std::fs::remove_file(lien);
                std::os::unix::fs::symlink(vers, lien)?;
            }
        }
        #[cfg(not(unix))]
        let _ = (executables, liens);
        std::fs::write(&marque, attendu)?;
        Ok(exe)
    }
}

/// 64 ou 32 bits d'après `java -version` : les Java 64 bits l'écrivent, les 32 bits non. None si on ne peut pas le dire.
pub fn bits_java(sortie: &str) -> Option<u8> {
    if sortie.to_ascii_lowercase().contains("64-bit") {
        Some(64)
    } else if sortie.contains("Client VM") || sortie.contains("Server VM") {
        Some(32)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InfoJava {
    pub major: u32,
    pub description: String,
    pub bits: Option<u8>,
}

/// Interprète la sortie de `java -version` (« 1.8.0_51 » → 8, « 21.0.7 » → 21).
pub fn lire_version_java(sortie: &str) -> Option<InfoJava> {
    static V: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"version "(\d+)(?:\.(\d+))?"#).unwrap());
    let c = V.captures(sortie)?;
    let premier: u32 = c[1].parse().ok()?;
    let major = if premier == 1 { c.get(2)?.as_str().parse().ok()? } else { premier };
    let description = sortie.lines().next().unwrap_or("").trim().to_string();
    Some(InfoJava { major, description, bits: bits_java(sortie) })
}

/// Programme lancé sans fenêtre de console sous Windows.
pub fn commande(exe: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(exe);
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

/// Lance `java -version` : version majeure, première ligne, 32 ou 64 bits.
pub async fn sonder(exe: &Path) -> Resultat<InfoJava> {
    let nom = exe.to_string_lossy();
    let enfant = commande(exe).arg("-version").kill_on_drop(true).output();
    let sortie = match tokio::time::timeout(Duration::from_secs(15), enfant).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            let code = e.raw_os_error().map(|c| c.to_string()).unwrap_or_else(|| e.kind().to_string());
            return Err(Erreur::new(tv("java.java_ne_demarre_pas", &[("code", &code), ("exe", &nom)])));
        }
        Err(_) => return Err(Erreur::new(tv("java.version_de_java_illisible", &[("exe", &nom)]))),
    };
    let texte = format!("{}{}", String::from_utf8_lossy(&sortie.stderr), String::from_utf8_lossy(&sortie.stdout));
    lire_version_java(&texte).ok_or_else(|| Erreur::new(tv("java.version_de_java_illisible", &[("exe", &nom)])))
}

/// Comme `sonder`, sans relancer Java si ce fichier (même taille, même date) a déjà été vérifié.
pub async fn sonder_en_cache(exe: &Path) -> Resultat<InfoJava> {
    static VUS: LazyLock<Mutex<HashMap<PathBuf, (String, InfoJava)>>> = LazyLock::new(Mutex::default);
    let cle = std::fs::metadata(exe).ok().map(|m| format!("{}:{:?}", m.len(), m.modified().ok()));
    if let Some(c) = &cle
        && let Some((k, info)) = VUS.lock().unwrap_or_else(|e| e.into_inner()).get(exe)
        && k == c
    {
        return Ok(info.clone());
    }
    let info = sonder(exe).await?;
    if let Some(c) = cle {
        VUS.lock().unwrap_or_else(|e| e.into_inner()).insert(exe.to_path_buf(), (c, info.clone()));
    }
    Ok(info)
}

/// « 1.8.0_51 » → 8, « 21.0.7 » → 21.
pub fn majeure(version: &str) -> Option<u32> {
    let mut p = version.split(['.', '_', '+', '-']).map(|x| x.parse::<u32>());
    match p.next()? {
        Ok(1) => p.next()?.ok(),
        Ok(n) => Some(n),
        Err(_) => None,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Runtime {
    pub component: String,
    pub dir: PathBuf,
    pub version: Option<String>,
    pub major: Option<u32>,
    pub complete: bool,
}

impl Jeu {
    /// Runtimes Mojang téléchargés par le launcher (dossier runtime).
    pub fn runtimes(&self) -> Vec<Runtime> {
        let Ok(it) = std::fs::read_dir(&self.dossiers.runtime) else { return vec![] };
        let os = Systeme::actuel().nom;
        it.flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .map(|e| {
                let dir = e.path();
                let version = std::fs::read_to_string(dir.join("release")).ok().and_then(|r| {
                    r.lines().find_map(|l| l.strip_prefix("JAVA_VERSION=\"").and_then(|v| v.strip_suffix('"')).map(String::from))
                });
                Runtime {
                    component: e.file_name().to_string_lossy().into_owned(),
                    complete: executable_runtime(&dir, os).is_file() && dir.join(MARQUE).is_file(),
                    major: version.as_deref().and_then(majeure),
                    version,
                    dir,
                }
            })
            .collect()
    }
}

const FOURNISSEURS: [&str; 10] = [
    "Java",
    "Eclipse Adoptium",
    "Eclipse Foundation",
    "AdoptOpenJDK",
    "Microsoft",
    "Zulu",
    "BellSoft",
    "Amazon Corretto",
    "Semeru",
    "OpenJDK",
];

/// Où chercher les Java installés : dossier parent, préfixe des sous-dossiers, chemin du « home » du JDK.
pub struct Lieu {
    pub parent: PathBuf,
    pub prefixe: &'static str,
    pub home: &'static [&'static str],
}

/// Lieux connus du système (lecture seule). `env` : variables d'environnement, remplaçables pour les tests.
pub fn lieux_java(os: &str, maison: &Path, env: &dyn Fn(&str) -> Option<String>) -> Vec<Lieu> {
    let lieu = |parent: PathBuf, prefixe, home| Lieu { parent, prefixe, home };
    let ide = maison.join(".jdks"); // Java téléchargés par les IDE de JetBrains
    match os {
        "windows" => {
            let mut racines: Vec<String> = vec![];
            for v in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
                if let Some(r) = env(v).filter(|r| !racines.contains(r)) {
                    racines.push(r);
                }
            }
            let mut l: Vec<Lieu> = racines.iter().flat_map(|r| FOURNISSEURS.map(|f| lieu(Path::new(r).join(f), "", &[]))).collect();
            l.push(lieu(ide, "", &[]));
            l
        }
        "osx" => {
            const PAQUET: &[&str] = &["Contents", "Home"];
            const BREW: &[&str] = &["libexec", "openjdk.jdk", "Contents", "Home"];
            vec![
                lieu("/Library/Java/JavaVirtualMachines".into(), "", PAQUET),
                lieu(maison.join("Library").join("Java").join("JavaVirtualMachines"), "", PAQUET),
                lieu("/opt/homebrew/opt".into(), "openjdk", BREW),
                lieu("/usr/local/opt".into(), "openjdk", BREW),
                lieu(ide, "", PAQUET),
            ]
        }
        _ => vec![
            lieu("/usr/lib/jvm".into(), "", &[]),
            lieu(maison.join(".sdkman").join("candidates").join("java"), "", &[]),
            lieu(ide, "", &[]),
        ],
    }
}

/// Chemins où chercher un Java du PC : lieux connus, JAVA_HOME puis PATH. `sous_dossiers` est remplaçable pour les tests.
pub fn candidats(
    os: &str,
    maison: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    sous_dossiers: &dyn Fn(&Path) -> Vec<String>,
) -> Vec<PathBuf> {
    let exe = if os == "windows" { "java.exe" } else { "java" };
    let mut trouves = vec![];
    for l in lieux_java(os, maison, env) {
        for nom in sous_dossiers(&l.parent).into_iter().filter(|n| n.starts_with(l.prefixe)) {
            let home = l.home.iter().fold(l.parent.join(nom), |p, s| p.join(s));
            trouves.push(home.join("bin").join(exe));
        }
    }
    if let Some(h) = env("JAVA_HOME").filter(|h| !h.is_empty()) {
        trouves.push(Path::new(&h).join("bin").join(exe));
    }
    let separateur = if os == "windows" { ';' } else { ':' };
    for d in env("PATH").or_else(|| env("Path")).unwrap_or_default().split(separateur).filter(|d| !d.is_empty()) {
        trouves.push(Path::new(d).join(exe));
    }
    trouves
}

/// Nom affiché d'un Java du PC : son dossier (« jdk-21 ») ; sur macOS on remonte au paquet (« temurin-21.jdk »).
pub fn nom_dossier_java(chemin: &str) -> String {
    let mut p: Vec<&str> = chemin.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
    p.pop(); // java ou java.exe
    if p.last().is_some_and(|d| d.eq_ignore_ascii_case("bin")) {
        p.pop();
    }
    if p.ends_with(&["Contents", "Home"]) {
        p.truncate(p.len() - 2);
        if p.ends_with(&["libexec", "openjdk.jdk"]) {
            p.truncate(p.len() - 2);
        }
    }
    let nom = p.last().copied().unwrap_or("");
    nom.strip_suffix(".jdk").unwrap_or(nom).to_string()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JavaDuPc {
    pub path: PathBuf,
    pub major: u32,
    pub bits: Option<u8>,
    pub description: String,
    pub name: String,
}

fn sous_dossiers(d: &Path) -> Vec<String> {
    std::fs::read_dir(d)
        .map(|it| {
            it.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).collect()
        })
        .unwrap_or_default()
}

impl Jeu {
    /// Java installés sur le PC, hors runtimes du launcher : un seul par version exacte.
    pub async fn java_du_pc(&self) -> Vec<JavaDuPc> {
        let s = Systeme::actuel();
        let maison = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default();
        // Windows et macOS ignorent la casse des noms de fichiers, Linux non.
        let plier = |p: &Path| {
            let t = p.to_string_lossy().into_owned();
            if s.nom == "linux" { t } else { t.to_lowercase() }
        };
        let racine = format!("{}{}", plier(&self.dossiers.racine), std::path::MAIN_SEPARATOR);
        let mut vus = vec![];
        let mut chemins = vec![];
        for f in candidats(s.nom, &maison, &|v| std::env::var(v).ok(), &sous_dossiers) {
            let Ok(reel) = std::fs::canonicalize(&f) else { continue };
            let cle = plier(&reel).trim_start_matches(r"\\?\").to_string();
            if vus.contains(&cle) || cle.starts_with(&racine) {
                continue;
            }
            vus.push(cle);
            chemins.push(f);
        }
        let sondes = futures_util::future::join_all(chemins.iter().map(|f| sonder_en_cache(f))).await;
        let mut descriptions = vec![];
        chemins
            .into_iter()
            .zip(sondes)
            .filter_map(|(path, r)| {
                let info = r.ok().filter(|i| !descriptions.contains(&i.description))?;
                descriptions.push(info.description.clone());
                let dossier = nom_dossier_java(&path.to_string_lossy());
                // Raccourci d'Oracle (« javapath », « java8path ») : on montre la version.
                static RACCOURCI: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^javad*path").unwrap());
                let generique = dossier.is_empty() || RACCOURCI.is_match(&dossier);
                let name = if generique { format!("Java {}", info.major) } else { dossier };
                Some(JavaDuPc { path, major: info.major, bits: info.bits, description: info.description, name })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trente_deux_ou_soixante_quatre_bits() {
        let hotspot64 = "java version \"1.8.0_451\"\nJava(TM) SE Runtime Environment (build 1.8.0_451-b10)\nJava HotSpot(TM) 64-Bit Server VM (build 25.451-b10, mixed mode)";
        let hotspot32 = "java version \"1.8.0_451\"\nJava(TM) SE Runtime Environment (build 1.8.0_451-b10)\nJava HotSpot(TM) Client VM (build 25.451-b10, mixed mode, sharing)";
        let server32 =
            "openjdk version \"17.0.2\"\nOpenJDK Runtime Environment (build 17.0.2+8)\nOpenJDK Server VM (build 17.0.2+8, mixed mode)";
        let openj9 = "openjdk version \"17.0.9\"\nIBM Semeru Runtime Open Edition (build 17.0.9+9)\nEclipse OpenJ9 VM (build openj9-0.41.0, JRE 17 Windows 11 amd64-64-Bit Compressed References)";
        assert_eq!(bits_java(hotspot64), Some(64));
        assert_eq!(bits_java(hotspot32), Some(32));
        assert_eq!(bits_java(server32), Some(32));
        assert_eq!(bits_java(openj9), Some(64));
        assert_eq!(bits_java("version \"21\""), None);
        let info = lire_version_java(hotspot64).unwrap();
        assert_eq!((info.major, info.description.as_str()), (8, "java version \"1.8.0_451\""));
        assert_eq!(lire_version_java("openjdk version \"25\" 2025-09-16").unwrap().major, 25);
        assert_eq!(lire_version_java("rien"), None);
    }

    #[test]
    fn versions_majeures() {
        assert_eq!(majeure("1.8.0_51"), Some(8));
        assert_eq!(majeure("21.0.7"), Some(21));
        assert_eq!(majeure("17"), Some(17));
        assert_eq!(majeure("x"), None);
    }

    #[test]
    fn plateformes_et_rosetta() {
        assert_eq!(cle_plateforme("x64", "windows"), "windows-x64");
        assert_eq!(cle_plateforme("arm64", "osx"), "mac-os-arm64");
        assert_eq!(cle_plateforme("x64", "osx"), "mac-os");
        assert_eq!(cle_plateforme("ia32", "linux"), "linux-i386");
        let mac = Systeme { nom: "osx", arch: "arm64", version: String::new() };
        let ancienne = serde_json::json!({ "libraries": [{ "name": "org.lwjgl:lwjgl:3.2.2:natives-macos" }] });
        let recente = serde_json::json!({ "libraries": [{ "name": "org.lwjgl:lwjgl:3.3.1:natives-macos-arm64" }] });
        let classifieur =
            serde_json::json!({ "libraries": [{ "name": "a:b:1", "downloads": { "classifiers": { "natives-macos-arm64": {} } } }] });
        assert!(rosetta_necessaire(&ancienne, &mac));
        assert!(!rosetta_necessaire(&recente, &mac));
        assert!(!rosetta_necessaire(&classifieur, &mac));
        assert!(!rosetta_necessaire(&ancienne, &Systeme { arch: "x64", ..mac }));
    }

    #[test]
    fn noms_des_java_du_pc() {
        assert_eq!(nom_dossier_java(r"C:\Program Files\Java\jdk-21\bin\java.exe"), "jdk-21");
        assert_eq!(nom_dossier_java("/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java"), "temurin-21");
        assert_eq!(nom_dossier_java("/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java"), "openjdk@21");
        assert_eq!(nom_dossier_java("/usr/bin/java"), "usr");
    }

    #[test]
    fn candidats_selon_le_systeme() {
        let env = |v: &str| match v {
            "ProgramFiles" => Some(r"C:\PF".into()),
            "ProgramW6432" => Some(r"C:\PF".into()),
            "JAVA_HOME" => Some(r"C:\jh".into()),
            "Path" => Some(r"C:\a;;C:\b".into()),
            _ => None,
        };
        let sous = |d: &Path| if d.ends_with("Eclipse Adoptium") { vec!["jdk-21.0.7".into()] } else { vec![] };
        let w = candidats("windows", Path::new(r"C:\Users\x"), &env, &sous);
        assert_eq!(
            w,
            [
                Path::new(r"C:\PF").join("Eclipse Adoptium").join("jdk-21.0.7").join("bin").join("java.exe"),
                Path::new(r"C:\jh").join("bin").join("java.exe"),
                Path::new(r"C:\a").join("java.exe"),
                Path::new(r"C:\b").join("java.exe"),
            ]
        );
        let brew = |d: &Path| if d == Path::new("/opt/homebrew/opt") { vec!["openjdk@21".into(), "python".into()] } else { vec![] };
        let m = candidats("osx", Path::new("/Users/x"), &|_| None, &brew);
        let attendu = ["openjdk@21", "libexec", "openjdk.jdk", "Contents", "Home", "bin", "java"]
            .iter()
            .fold(Path::new("/opt/homebrew/opt").to_path_buf(), |p, s| p.join(s));
        assert_eq!(m, [attendu]);
    }
}
