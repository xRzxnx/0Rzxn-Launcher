//! Connexion Microsoft, comme microsoft-login.js. Par défaut dans le navigateur habituel : la page officielle renvoie
//! le navigateur vers une adresse locale du launcher. En secours, la même page dans une fenêtre intégrée isolée. Dans
//! les deux cas, le launcher ne voit jamais le mot de passe : seulement le code renvoyé à la fin. Une seule à la fois.

use coeur::comptes::{Comptes, SessionMs};
use coeur::erreur::{Erreur, Resultat};
use coeur::i18n::t;
use coeur::microsoft::{self, Points, REDIRECT_NATIF};
use coeur::net::Reseau;
use coeur::retour_local::{ATTENTE, GARDE, Issue, RetourLocal};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

/// Connexion en cours : ce que les boutons du bloc d'attente peuvent faire.
#[derive(Default)]
pub struct EnCours {
    actif: bool,
    url: Option<String>,
    fenetre: Option<oneshot::Sender<()>>,
    retour: Option<Arc<RetourLocal>>,
    mode_fenetre: bool,
}

#[derive(Default)]
pub struct Connexion(Mutex<EnCours>);

impl Connexion {
    fn etat(&self) -> std::sync::MutexGuard<'_, EnCours> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn envoyer(app: &AppHandle, charge: Value) {
    let _ = app.emit("accounts:loginState", charge);
}

/// Ramène la fenêtre du launcher au premier plan.
fn au_premier_plan(app: &AppHandle) {
    if let Some(f) = app.get_webview_window("principale") {
        let _ = f.unminimize();
        let _ = f.show();
        let _ = f.set_focus();
    }
}

fn ouvrir_navigateur(app: &AppHandle, url: &str) -> Resultat<()> {
    app.opener().open_url(url, None::<&str>).map_err(|e| Erreur::new(e.to_string()))
}

/// Connexion dans le navigateur. Ok(None) : passer à la fenêtre intégrée (demandé, ou navigateur indisponible).
async fn par_navigateur(app: &AppHandle, reseau: &Reseau) -> Resultat<Option<SessionMs>> {
    let etat = microsoft::nouvel_etat();
    let retour = match RetourLocal::ouvrir(&etat, ATTENTE, GARDE).await {
        Ok(r) => Arc::new(r),
        Err(e) => {
            coeur::journal::warn(&format!("Microsoft login: loopback unavailable, using the embedded window: {e}"));
            return Ok(None);
        }
    };
    let points = Points::default();
    let a = microsoft::autorisation(&points, &microsoft::client_id(), &retour.redirect_uri, etat);
    if let Err(e) = ouvrir_navigateur(app, &a.url) {
        coeur::journal::warn(&format!("Microsoft login: browser did not open, using the embedded window: {e}"));
        retour.fermer().await;
        return Ok(None);
    }
    let (tx, rx) = oneshot::channel();
    {
        let c = app.state::<Connexion>();
        let mut e = c.etat();
        e.url = Some(a.url.clone());
        e.fenetre = Some(tx);
        e.retour = Some(retour.clone());
    }
    let expire = coeur::base::maintenant() + ATTENTE.as_millis() as i64;
    envoyer(app, json!({ "phase": "browser", "url": a.url, "expiresAt": expire }));
    let code = tokio::select! {
        r = retour.attendre() => r,
        _ = rx => {
            retour.fermer().await;
            return Ok(None);
        }
    };
    {
        let c = app.state::<Connexion>();
        let mut e = c.etat();
        e.url = None;
        e.fenetre = None;
        e.retour = None;
    }
    // Code reçu : la page du navigateur attend le vrai résultat (Xbox, Minecraft, profil).
    let session = match code {
        Ok(code) => {
            envoyer(app, json!({ "phase": "checking" }));
            microsoft::se_connecter(reseau, &points, &microsoft::client_id(), &code, &a.verificateur, &retour.redirect_uri).await
        }
        Err(e) => Err(e),
    };
    match &session {
        Ok(s) => {
            retour.repondre(Issue::Reussie(s.name.clone())).await;
            au_premier_plan(app);
        }
        Err(e) => {
            retour.repondre(Issue::Echec { code: e.code.map(String::from), message: e.message.clone() }).await;
            if !e.a_le_code("CANCELLED") && !e.a_le_code("TIMEOUT") {
                au_premier_plan(app);
            }
        }
    }
    session.map(Some)
}

/// Connexion dans la fenêtre intégrée (secours) : le retour vers l'adresse native est intercepté, jamais chargé.
async fn par_fenetre(app: &AppHandle, reseau: &Reseau) -> Resultat<SessionMs> {
    let points = Points::default();
    let a = microsoft::autorisation(&points, &microsoft::client_id(), REDIRECT_NATIF, microsoft::nouvel_etat());
    let (tx, rx) = oneshot::channel::<Resultat<String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let (t2, etat) = (tx.clone(), a.etat.clone());
    let url = a.url.parse().map_err(|_| Erreur::new("bad url"))?;
    // Profil à part : garde la session Microsoft pour « choisir un compte » la prochaine fois, sans rien partager.
    let profil = coeur::chemins::donnees().join("connexion-microsoft");
    let fenetre = WebviewWindowBuilder::new(app, "connexion", WebviewUrl::External(url))
        .title(t("microsoft.connexion_microsoft"))
        .inner_size(520.0, 700.0)
        .data_directory(profil)
        .on_navigation(move |cible| match microsoft::lire_redirection(cible.as_str(), &etat) {
            Some(r) => {
                if let Some(tx) = t2.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = tx.send(r);
                }
                false
            }
            None => true,
        })
        .build()
        .map_err(|e| Erreur::new(e.to_string()))?;
    let t3 = tx.clone();
    fenetre.on_window_event(move |ev| {
        if let tauri::WindowEvent::Destroyed = ev
            && let Some(tx) = t3.lock().unwrap_or_else(|e| e.into_inner()).take()
        {
            let _ = tx.send(Err(Erreur::code(t("microsoft.connexion_annulee"), "CANCELLED")));
        }
    });
    {
        let c = app.state::<Connexion>();
        c.etat().mode_fenetre = true;
    }
    envoyer(app, json!({ "phase": "window" }));
    let code = rx.await.unwrap_or_else(|_| Err(Erreur::code(t("microsoft.connexion_annulee"), "CANCELLED")));
    let _ = fenetre.close();
    let code = code?;
    envoyer(app, json!({ "phase": "checking" }));
    microsoft::se_connecter(reseau, &points, &microsoft::client_id(), &code, &a.verificateur, REDIRECT_NATIF).await
}

/// Connexion complète jusqu'au profil Minecraft ; annulation et délai dépassé donnent { ended }.
pub async fn ajouter_microsoft(app: &AppHandle, mode: &str) -> Resultat<Value> {
    {
        let c = app.state::<Connexion>();
        let mut e = c.etat();
        if e.actif {
            if e.mode_fenetre
                && let Some(f) = app.get_webview_window("connexion")
            {
                let _ = f.set_focus();
            }
            return Err(Erreur::code(t("microsoft.une_fenetre_de_connexion_est"), "BUSY"));
        }
        *e = EnCours { actif: true, ..Default::default() };
    }
    let reseau = app.state::<Arc<Reseau>>().inner().clone();
    let resultat = async {
        if mode != "window"
            && let Some(s) = par_navigateur(app, &reseau).await?
        {
            return Ok(s);
        }
        par_fenetre(app, &reseau).await
    }
    .await;
    *app.state::<Connexion>().etat() = EnCours::default();
    envoyer(app, json!({ "phase": "idle" }));
    match resultat {
        Ok(s) => {
            let comptes = app.state::<Arc<Comptes>>();
            let mut v = serde_json::to_value(comptes.ajouter_microsoft(&s, true)?).unwrap_or_default();
            v["name"] = s.name.into();
            Ok(v)
        }
        Err(e) if e.a_le_code("CANCELLED") || e.a_le_code("TIMEOUT") => Ok(json!({ "ended": e.code })),
        Err(e) => Err(e),
    }
}

/// Bloc d'attente : rouvre la page dans le navigateur.
pub fn rouvrir(app: &AppHandle) -> bool {
    let url = app.state::<Connexion>().etat().url.clone();
    match url {
        Some(u) => {
            if let Err(e) = ouvrir_navigateur(app, &u) {
                coeur::journal::warn(&format!("Microsoft login: reopen failed: {e}"));
            }
            true
        }
        None => false,
    }
}

/// Bloc d'attente : passe à la fenêtre intégrée.
pub fn utiliser_fenetre(app: &AppHandle) -> bool {
    match app.state::<Connexion>().etat().fenetre.take() {
        Some(tx) => tx.send(()).is_ok(),
        None => false,
    }
}

/// Bloc d'attente : annule.
pub async fn annuler(app: &AppHandle) -> bool {
    let (retour, fenetre) = {
        let c = app.state::<Connexion>();
        let e = c.etat();
        (e.retour.clone(), e.mode_fenetre)
    };
    if let Some(r) = retour {
        r.fermer().await;
        return true;
    }
    if fenetre && let Some(f) = app.get_webview_window("connexion") {
        let _ = f.close();
        return true;
    }
    false
}
