// Pas de console noire derrière la fenêtre sous Windows (sauf en debug, pour lire les erreurs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use coeur::base::{Base, Tache};
use coeur::jeu::Jeu;
use coeur::net::Reseau;
use coeur::partie::{Fenetre, Parties};
use coeur::taches::Gestionnaire;
use commun::{Demarrage, Instance};
use serde_json::Value;
use std::sync::{Arc, OnceLock, Weak};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

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

fn liste_instances(base: &Base) -> Vec<Instance> {
    coeur::instances::lister(&coeur::chemins::racine_jeu())
        .into_iter()
        .map(|i| Instance { last_launch: base.dernier_lancement(&i.id), ..i })
        .collect()
}

/// Tout ce que l'accueil affiche au démarrage.
#[tauri::command]
fn demarrage(base: State<Arc<Base>>) -> Demarrage {
    let donnees = coeur::chemins::donnees();
    let ui = coeur::reglages::Magasin::new(&donnees).interface();
    let (accounts, active_account_id) = coeur::comptes::lire(&donnees);
    Demarrage {
        app_version: env!("CARGO_PKG_VERSION").into(),
        lang: coeur::i18n::langue().into(),
        platform: std::env::consts::OS.into(),
        instances: liste_instances(&base),
        accounts,
        active_account_id,
        selected_id: ui.selected_id,
        collapsed_groups: ui.collapsed_groups,
    }
}

/// Instances relues après une partie (temps de jeu, dernier lancement, loader installé).
#[tauri::command]
fn instances(base: State<Arc<Base>>) -> Vec<Instance> {
    liste_instances(&base)
}

/// Lance une instance (options : verify, prepareOnly, quickPlay). Les commandes qui démarrent du travail sont
/// asynchrones : elles tournent dans le runtime tokio de Tauri.
#[tauri::command]
async fn lancer(parties: State<'_, Arc<Parties>>, id: String, options: Option<Value>) -> Result<commun::Partie, String> {
    let o = options.unwrap_or_default();
    let vrai = |c: &str| o.get(c).and_then(Value::as_bool) == Some(true);
    let preparer = vrai("prepareOnly");
    // shortcut: la sauvegarde des mondes avant la partie (réglage « Sauvegarde au lancement ») arrive avec les mondes (R4).
    let quick_play = if preparer { None } else { parties.cible_quick_play(&id, o.get("quickPlay")).map_err(|e| e.message)? };
    parties.demarrer(&id, vrai("verify"), preparer, quick_play).map_err(|e| e.message)
}

#[tauri::command]
async fn arreter(parties: State<'_, Arc<Parties>>) -> Result<(), String> {
    parties.arreter();
    Ok(())
}

/// État de la partie pour une interface qui s'ouvre (run, logs, mesures).
#[tauri::command]
fn etat_partie(parties: State<Arc<Parties>>) -> Value {
    parties.etat_courant()
}

#[tauri::command]
fn taches(taches: State<Arc<Gestionnaire>>) -> Vec<coeur::taches::Vue> {
    taches.liste()
}

#[tauri::command]
async fn annuler_tache(taches: State<'_, Arc<Gestionnaire>>, id: Option<String>) -> Result<bool, String> {
    Ok(taches.annuler(id.as_deref()))
}

/// La fenêtre principale autour de la partie : réduite ou cachée au lancement, rendue à la fin.
struct FenetrePrincipale(AppHandle);

impl FenetrePrincipale {
    fn fenetre(&self) -> Option<WebviewWindow> {
        self.0.get_webview_window("principale")
    }
}

impl Fenetre for FenetrePrincipale {
    fn minimiser(&self) {
        if let Some(f) = self.fenetre() {
            let _ = f.minimize();
        }
    }
    fn masquer(&self) {
        // shortcut: sans icône près de l'horloge (R6), « Masquer » réduit la fenêtre pour qu'elle reste accessible.
        self.minimiser();
    }
    fn montrer(&self) {
        if let Some(f) = self.fenetre() {
            let _ = f.show();
            let _ = f.unminimize();
            let _ = f.set_focus();
        }
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
    let jeu = Jeu::new(coeur::chemins::Dossiers::new(&coeur::chemins::racine_jeu()), reseau.clone());
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let emettre: coeur::partie::Envoi = Arc::new(move |canal, charge| {
                let _ = handle.emit(canal, charge);
            });
            // Les tâches d'une instance en partie attendent la fin : le gestionnaire demande aux parties.
            let parties_lien: Arc<OnceLock<Weak<Parties>>> = Arc::default();
            let lien = parties_lien.clone();
            let taches = Gestionnaire::new(coeur::taches::Options {
                envoyer: emettre.clone(),
                historique: Some(base.clone()),
                en_jeu: Box::new(move |id| lien.get().and_then(Weak::upgrade).and_then(|p| p.instance_en_jeu()).as_deref() == Some(id)),
                ..Default::default()
            });
            let parties = Parties::new(coeur::partie::Options {
                jeu,
                base: base.clone(),
                taches: taches.clone(),
                donnees: donnees.clone(),
                version_launcher: env!("CARGO_PKG_VERSION").into(),
                envoyer: emettre,
                fenetre: Some(Arc::new(FenetrePrincipale(app.handle().clone()))),
            });
            let _ = parties_lien.set(Arc::downgrade(&parties));
            app.manage(base);
            app.manage(reseau);
            app.manage(taches);
            app.manage(parties);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![demarrage, instances, lancer, arreter, etat_partie, taches, annuler_tache, fenetre])
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
