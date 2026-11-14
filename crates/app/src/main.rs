// Pas de console noire derrière la fenêtre sous Windows (sauf en debug, pour lire les erreurs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use commun::Demarrage;
use tauri::WebviewWindow;

/// Langues préférées de l'utilisateur, comme app.getPreferredSystemLanguages() d'Electron.
/// Windows : la liste « Langues » des paramètres (fr-FR, es-ES…), pas la langue d'affichage du système,
/// que donnent sys-locale et la WebView.
fn langues_systeme() -> Vec<String> {
    #[cfg(windows)]
    {
        use winreg::{RegKey, enums::HKEY_CURRENT_USER};
        let liste: Option<Vec<String>> = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Control Panel\International\User Profile")
            .and_then(|k| k.get_value("Languages"))
            .ok();
        if let Some(liste) = liste.filter(|l| !l.is_empty()) {
            return liste;
        }
    }
    sys_locale::get_locales().collect()
}

/// Tout ce que l'accueil affiche au démarrage. R0 : lecture seule.
#[tauri::command]
fn demarrage() -> Demarrage {
    let (racine, donnees) = (coeur::chemins::racine_jeu(), coeur::chemins::donnees());
    let reglages = coeur::reglages::lire(&donnees);
    let (accounts, active_account_id) = coeur::comptes::lire(&donnees);
    Demarrage {
        app_version: env!("CARGO_PKG_VERSION").into(),
        lang: commun::i18n::choisir_langue(
            reglages.launcher.language.as_deref().unwrap_or("auto"),
            langues_systeme().iter().map(String::as_str),
        )
        .into(),
        platform: std::env::consts::OS.into(),
        instances: coeur::instances::lister(&racine),
        accounts,
        active_account_id,
        selected_id: reglages.ui.selected_id,
        collapsed_groups: reglages.ui.collapsed_groups,
    }
}

/// Boutons de la barre de titre (la fenêtre n'a pas de cadre du système).
#[tauri::command]
fn fenetre(window: WebviewWindow, action: &str) -> Result<(), String> {
    match action {
        "reduire" => window.minimize(),
        "agrandir" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "fermer" => window.close(),
        _ => return Err(format!("action inconnue : {action}")),
    }
    .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![demarrage, fenetre])
        .run(tauri::generate_context!())
        .expect("le launcher n'a pas pu démarrer");
}
