//! Dossiers du launcher, identiques à la version Electron (platform/chemins.js) pour reprendre les mêmes données.

use std::env;
use std::path::PathBuf;

/// Nom du dossier des réglages : celui qu'Electron dérivait du productName.
const NOM_APP: &str = "0Rzxn_ Launcher";

fn maison() -> PathBuf {
    env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_default()
}

fn xdg(var: &str, defaut: &str) -> PathBuf {
    env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| maison().join(defaut))
}

/// Dossier « appData » d'Electron : %APPDATA%, ~/Library/Application Support, $XDG_CONFIG_HOME.
fn app_data() -> PathBuf {
    if cfg!(windows) {
        env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| maison().join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        maison().join("Library").join("Application Support")
    } else {
        xdg("XDG_CONFIG_HOME", ".config")
    }
}

/// Racine des jeux (versions, bibliothèques, instances) : %APPDATA%\.0rzxn, ~/.local/share/0rzxn sous Linux.
/// `ORZXN_RACINE` la remplace (essais).
pub fn racine_jeu() -> PathBuf {
    if let Some(r) = env::var_os("ORZXN_RACINE") {
        return r.into();
    }
    if cfg!(any(windows, target_os = "macos")) { app_data().join(".0rzxn") } else { xdg("XDG_DATA_HOME", ".local/share").join("0rzxn") }
}

/// Dossier des réglages (settings.json, accounts.json, launcher.db). `ORZXN_DONNEES` le remplace (essais).
pub fn donnees() -> PathBuf {
    env::var_os("ORZXN_DONNEES").map(PathBuf::from).unwrap_or_else(|| app_data().join(NOM_APP))
}

/// Dossiers du jeu sous la racine, comme gameDirs (core/store.js).
#[derive(Debug, Clone, PartialEq)]
pub struct Dossiers {
    pub racine: PathBuf,
    pub versions: PathBuf,
    pub libraries: PathBuf,
    pub assets: PathBuf,
    pub runtime: PathBuf,
    pub instances: PathBuf,
    pub cache: PathBuf,
}

impl Dossiers {
    /// La racine est créée puis résolue (liens, dossier virtualisé de Windows) : Java reçoit des chemins réels.
    pub fn new(demandee: &std::path::Path) -> Self {
        let _ = std::fs::create_dir_all(demandee);
        let racine = std::fs::canonicalize(demandee).map(sans_prefixe_long).unwrap_or_else(|_| demandee.to_path_buf());
        let d = |n: &str| racine.join(n);
        Self {
            versions: d("versions"),
            libraries: d("libraries"),
            assets: d("assets"),
            runtime: d("runtime"),
            instances: d("instances"),
            cache: d("cache"),
            racine,
        }
    }
}

/// « \\?\C:\… » (canonicalize sous Windows) → « C:\… », que Java et les classpaths comprennent.
fn sans_prefixe_long(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(reste) if reste.as_bytes().get(1) == Some(&b':') => PathBuf::from(reste),
        _ => p,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn racine_sans_prefixe_long() {
        assert_eq!(sans_prefixe_long(PathBuf::from(r"\\?\C:\jeu")), PathBuf::from(r"C:\jeu"));
        assert_eq!(sans_prefixe_long(PathBuf::from(r"\\?\UNC\serveur\jeu")), PathBuf::from(r"\\?\UNC\serveur\jeu"));
        let d = Dossiers::new(&std::env::temp_dir().join("coeur-essai-racine"));
        assert!(!d.racine.to_string_lossy().starts_with(r"\\"), "{}", d.racine.display());
        assert!(d.racine.is_absolute());
    }
}
