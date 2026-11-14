// Pas de console noire derrière la fenêtre sous Windows (sauf en debug, pour lire les erreurs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use coeur::base::{Base, Tache};
use coeur::net::Reseau;
use commun::Demarrage;
use std::sync::Arc;
use tauri::{Manager, State, WebviewWindow};

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

/// Fichiers temporaires abandonnés retirés en arrière-plan au démarrage, noté comme tâche cachée (comme Electron).
fn nettoyer_temporaires(base: Arc<Base>) {
    std::thread::spawn(move || {
        let debut = coeur::base::maintenant();
        let annule = std::sync::atomic::AtomicBool::new(false);
        let (nombre, octets) = coeur::temporaires::nettoyer(&coeur::chemins::racine_jeu(), std::time::SystemTime::now(), &annule);
        if nombre > 0 {
            coeur::journal::info(&format!("Temporary files removed: {nombre} ({octets} bytes)"));
        }
        base.enregistrer_tache(&Tache {
            id: format!("temp-cleanup-{debut}"),
            kind: "temp-cleanup".into(),
            label: Some(coeur::i18n::t("ipc.nettoyage_des_fichiers_temporaires")),
            state: "done".into(),
            created_at: Some(debut),
            started_at: Some(debut),
            ended_at: Some(coeur::base::maintenant()),
            hidden: true,
            ..Tache::default()
        });
    });
}

/// Tout ce que l'accueil affiche au démarrage.
#[tauri::command]
fn demarrage(base: State<Arc<Base>>) -> Demarrage {
    let (racine, donnees) = (coeur::chemins::racine_jeu(), coeur::chemins::donnees());
    let ui = coeur::reglages::Magasin::new(&donnees).interface();
    let (accounts, active_account_id) = coeur::comptes::lire(&donnees);
    Demarrage {
        app_version: env!("CARGO_PKG_VERSION").into(),
        lang: coeur::i18n::langue().into(),
        platform: std::env::consts::OS.into(),
        instances: coeur::instances::lister(&racine)
            .into_iter()
            .map(|i| commun::Instance { last_launch: base.dernier_lancement(&i.id), ..i })
            .collect(),
        accounts,
        active_account_id,
        selected_id: ui.selected_id,
        collapsed_groups: ui.collapsed_groups,
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
        _ => return Err(format!("unknown window action: {action}")),
    }
    .map_err(|e| e.to_string())
}

fn main() {
    let donnees = coeur::chemins::donnees();
    let journal = coeur::journal::ouvrir_global(coeur::journal::Options::new(donnees.join("logs")));
    let reglages = coeur::reglages::Magasin::new(&donnees).launcher();
    coeur::i18n::choisir(commun::i18n::choisir_langue(&reglages.language, langues_systeme().iter().map(String::as_str)));
    coeur::journal::info(&format!(
        "0Rzxn_ Launcher {} starting ({} {}), language {}, log {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        coeur::i18n::langue(),
        journal.map(|j| j.fichier().display().to_string()).unwrap_or_default()
    ));
    let base = Arc::new(Base::ouvrir(&donnees.join("launcher.db")));
    let reseau = Arc::new(Reseau::new());
    reseau.version(env!("CARGO_PKG_VERSION"));
    reseau.limiter(Some(reglages.downloads.concurrency), Some(reglages.downloads.per_host));
    nettoyer_temporaires(base.clone());
    tauri::Builder::default()
        .manage(base)
        .manage(reseau)
        .invoke_handler(tauri::generate_handler![demarrage, fenetre])
        .build(tauri::generate_context!())
        .expect("the launcher could not start")
        .run(|app, evenement| {
            // Une fermeture propre de la base retire ses fichiers -wal et -shm.
            if let tauri::RunEvent::Exit = evenement {
                app.state::<Arc<Base>>().fermer();
                coeur::journal::info("Quit");
            }
        });
}
