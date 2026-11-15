// Pas de console noire derrière la fenêtre sous Windows (sauf en debug, pour lire les erreurs).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connexion;

use coeur::base::{Base, Tache};
use coeur::comptes::{Comptes, Liste};
use coeur::jeu::Jeu;
use coeur::microsoft;
use coeur::net::Reseau;
use coeur::partie::{Fenetre, Parties};
use coeur::skins::{Bibliotheque, GardeRobe, Mojang};
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
fn demarrage(base: State<Arc<Base>>, comptes: State<Arc<Comptes>>) -> Demarrage {
    let ui = coeur::reglages::Magasin::new(&coeur::chemins::donnees()).interface();
    let coeur::comptes::Liste { accounts, active_id: active_account_id } = comptes.liste();
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

// ---------- Comptes ----------

fn texte_erreur(e: coeur::erreur::Erreur) -> String {
    e.message
}

#[tauri::command]
fn comptes_liste(comptes: State<Arc<Comptes>>) -> Liste {
    comptes.liste()
}

#[tauri::command]
fn ajouter_hors_ligne(comptes: State<Arc<Comptes>>, nom: String) -> Result<Liste, String> {
    comptes.ajouter_hors_ligne(&nom).map_err(texte_erreur)
}

/// Connexion Microsoft (navigateur par défaut, « window » : fenêtre intégrée).
#[tauri::command]
async fn ajouter_microsoft(app: tauri::AppHandle, mode: Option<String>) -> Result<Value, String> {
    connexion::ajouter_microsoft(&app, mode.as_deref().unwrap_or("browser")).await.map_err(texte_erreur)
}

#[tauri::command]
fn connexion_rouvrir(app: tauri::AppHandle) -> bool {
    connexion::rouvrir(&app)
}

#[tauri::command]
fn connexion_fenetre(app: tauri::AppHandle) -> bool {
    connexion::utiliser_fenetre(&app)
}

#[tauri::command]
async fn connexion_annuler(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(connexion::annuler(&app).await)
}

#[tauri::command]
fn retirer_compte(comptes: State<Arc<Comptes>>, id: String) -> Result<Liste, String> {
    comptes.retirer(&id).map_err(texte_erreur)
}

#[tauri::command]
fn activer_compte(comptes: State<Arc<Comptes>>, id: String) -> Result<Liste, String> {
    comptes.activer(&id).map_err(texte_erreur)
}

/// Têtes des comptes depuis l'API publique de Mojang.
#[tauri::command]
async fn rafraichir_apparences(garde: State<'_, Arc<GardeRobe>>) -> Result<Liste, String> {
    Ok(garde.rafraichir().await)
}

// ---------- Skins et capes ----------
// shortcut: l'import d'un PNG (sélecteur de fichier) et l'écran « Skin et cape » arrivent avec les écrans (R5).

#[tauri::command]
async fn skins_etat(garde: State<'_, Arc<GardeRobe>>, id: String) -> Result<Value, String> {
    garde.etat(&id).await.map_err(texte_erreur)
}

#[tauri::command]
fn skins_bibliotheque(biblio: State<Arc<Bibliotheque>>) -> Vec<Value> {
    biblio.liste()
}

#[tauri::command]
async fn skins_copier_joueur(garde: State<'_, Arc<GardeRobe>>, nom: String) -> Result<Value, String> {
    let (item, ajoute) = garde.copier_joueur(&nom).await.map_err(texte_erreur)?;
    Ok(serde_json::json!({ "id": item.id, "name": item.name, "added": ajoute, "library": garde.biblio.liste() }))
}

#[tauri::command]
fn skins_variante(biblio: State<Arc<Bibliotheque>>, id: String, variante: String) -> Result<Vec<Value>, String> {
    biblio.changer_variante(&id, &variante).map_err(texte_erreur)?;
    Ok(biblio.liste())
}

#[tauri::command]
fn skins_retirer(biblio: State<Arc<Bibliotheque>>, id: String) -> Result<Vec<Value>, String> {
    biblio.retirer(&id).map_err(texte_erreur)?;
    Ok(biblio.liste())
}

/// Un refus de Mojang revient dans l'état (avec son code) : ce qui a déjà été appliqué reste à jour à l'écran.
#[tauri::command]
async fn skins_appliquer(garde: State<'_, Arc<GardeRobe>>, id: String, changement: Value) -> Result<Value, String> {
    Ok(garde.appliquer(&id, &changement).await.unwrap_or_else(|e| garde.instantane(&id, Some(&e))))
}

#[tauri::command]
async fn skins_par_defaut(garde: State<'_, Arc<GardeRobe>>, id: String) -> Result<Value, String> {
    Ok(garde.par_defaut(&id).await.unwrap_or_else(|e| garde.instantane(&id, Some(&e))))
}

/// Images des skins : skin://texture/<empreinte> (cache de Mojang) et skin://library/<id> (« Mes skins ») seulement.
async fn image_skin(biblio: Arc<Bibliotheque>, uri: String) -> tauri::http::Response<Vec<u8>> {
    let sans = uri.split(['?', '#']).next().unwrap_or("");
    let (genre, id) = sans.trim_end_matches('/').rsplit_once('/').map(|(a, b)| (a.rsplit('/').next().unwrap_or(""), b)).unwrap_or(("", ""));
    let fichier = match genre {
        "library" => biblio.fichier_skin(id),
        "texture" => biblio.texture(id).await,
        _ => Err(coeur::erreur::Erreur::new("unknown")),
    };
    match fichier.ok().and_then(|f| std::fs::read(f).ok()) {
        Some(png) => tauri::http::Response::builder().header("Content-Type", "image/png").body(png).unwrap_or_default(),
        None => tauri::http::Response::builder().status(404).body(vec![]).unwrap_or_default(),
    }
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
    // Renouvellement des sessions Microsoft avant une partie ou un appel à Mojang.
    let r = reseau.clone();
    let renouveler: coeur::comptes::Renouveler = Arc::new(move |jeton, redirect| {
        let r = r.clone();
        Box::pin(async move { microsoft::renouveler(&r, &microsoft::Points::default(), &microsoft::client_id(), &jeton, &redirect).await })
    });
    let comptes = Arc::new(Comptes::new(&donnees, coeur::coffre::du_systeme(&donnees), Some(renouveler)));
    let biblio = Arc::new(Bibliotheque::new(&jeu.dossiers.skins, &jeu.dossiers.cache, reseau.clone(), Mojang::default()));
    let garde = Arc::new(GardeRobe::new(comptes.clone(), biblio.clone(), reseau.clone(), microsoft::Points::default()));
    let biblio_images = biblio.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("skin", move |_ctx, requete, reponse| {
            let (b, uri) = (biblio_images.clone(), requete.uri().to_string());
            tauri::async_runtime::spawn(async move { reponse.respond(image_skin(b, uri).await) });
        })
        .manage(connexion::Connexion::default())
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
                comptes: comptes.clone(),
                version_launcher: env!("CARGO_PKG_VERSION").into(),
                envoyer: emettre,
                fenetre: Some(Arc::new(FenetrePrincipale(app.handle().clone()))),
            });
            let _ = parties_lien.set(Arc::downgrade(&parties));
            app.manage(comptes);
            app.manage(biblio);
            app.manage(garde);
            app.manage(base);
            app.manage(reseau);
            app.manage(taches);
            app.manage(parties);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            demarrage,
            instances,
            lancer,
            arreter,
            etat_partie,
            taches,
            annuler_tache,
            fenetre,
            comptes_liste,
            ajouter_hors_ligne,
            ajouter_microsoft,
            connexion_rouvrir,
            connexion_fenetre,
            connexion_annuler,
            retirer_compte,
            activer_compte,
            rafraichir_apparences,
            skins_etat,
            skins_bibliotheque,
            skins_copier_joueur,
            skins_variante,
            skins_retirer,
            skins_appliquer,
            skins_par_defaut
        ])
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
