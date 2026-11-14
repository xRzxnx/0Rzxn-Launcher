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
