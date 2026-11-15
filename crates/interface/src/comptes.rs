//! Comptes : fenêtre « Comptes », connexion Microsoft (bloc d'attente du navigateur) et têtes de skin,
//! comme accountsDialog de views/modals.js, les actions de compte de actions.js et skinHead de skin-view.js.

use crate::icones::{icone, icone_taille};
use crate::partie::toast;
use crate::texte::{t, tv};
use crate::{Etat, appeler, ecouter};
use commun::Compte;
use leptos::html::Input;
use leptos::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

/// Connexion en cours (accounts:loginState) : starting | browser | checking | window | expired.
#[derive(Clone, Debug, PartialEq, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Connexion {
    pub phase: String,
    pub url: Option<String>,
    pub expires_at: Option<f64>,
    #[serde(skip)]
    pub copie: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Liste {
    active_id: Option<String>,
    accounts: Vec<Compte>,
}

/// Adresse d'une texture du cache : protocole skin://, servi par le moteur (http://skin.localhost sous Windows).
pub fn url_texture(hash: &str) -> String {
    let windows = document().document_element().is_some_and(|e| e.class_list().contains("os-windows"));
    if windows { format!("http://skin.localhost/texture/{hash}") } else { format!("skin://texture/{hash}") }
}

/// Style d'une zone (x, y, l, h) de la texture, en gros pixels.
fn zone(url: &str, x: u32, y: u32, l: u32, h: u32, echelle: f64) -> String {
    format!(
        "width:{}px;height:{}px;background-image:url(\"{url}\");background-position:{}px {}px;background-size:{}px auto;background-repeat:no-repeat;image-rendering:pixelated",
        l as f64 * echelle,
        h as f64 * echelle,
        -(x as f64) * echelle,
        -(y as f64) * echelle,
        64.0 * echelle
    )
}

/// Tête d'un compte : la face et le calque du chapeau ; l'avatar reste dessous si la texture ne se charge pas.
pub fn tete(compte: &Compte, taille: u32) -> AnyView {
    let secours = crate::chrome::avatar(if compte.kind == "microsoft" { "a" } else { "b" }, taille);
    let hash = compte
        .look
        .as_ref()
        .and_then(|l| l.pointer("/skin/hash"))
        .and_then(Value::as_str)
        .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()));
    let Some(hash) = hash else { return secours.into_any() };
    let url = url_texture(hash);
    let echelle = taille as f64 / 8.0;
    view! {
        <span class="skin-head" aria-hidden="true" style=format!("width:{taille}px;height:{taille}px")>
            {secours}
            <span class="skin-head__layer" style=zone(&url, 8, 8, 8, 8, echelle)></span>
            <span class="skin-head__layer" style=zone(&url, 40, 8, 8, 8, echelle)></span>
        </span>
    }
    .into_any()
}

fn appliquer_liste(etat: Etat, l: Liste) {
    etat.comptes.set(l.accounts);
    etat.compte_actif.set(l.active_id);
}

pub fn rafraichir(etat: Etat) {
    leptos::task::spawn_local(async move {
        if let Ok(l) = appeler::<Liste>("comptes_liste", ()).await {
            appliquer_liste(etat, l);
        }
    });
}

/// Têtes des comptes depuis Mojang (en arrière-plan, sans rien bloquer).
pub fn rafraichir_apparences(etat: Etat) {
    leptos::task::spawn_local(async move {
        if let Ok(l) = appeler::<Liste>("rafraichir_apparences", ()).await {
            appliquer_liste(etat, l);
        }
    });
}

/// Suit l'état de la connexion envoyé par le moteur ; redessine chaque demi-minute le temps restant.
pub fn suivre(etat: Etat) {
    ecouter::<Connexion>("accounts:loginState", move |c| {
        etat.connexion.update(|l| {
            if c.phase == "idle" {
                if l.as_ref().is_none_or(|x| x.phase != "expired") {
                    *l = None;
                }
            } else {
                *l = Some(c);
            }
        });
    });
    set_interval(move || etat.horloge.update(|n| *n += 1), Duration::from_secs(30));
    rafraichir_apparences(etat);
}

#[derive(Serialize)]
struct Nom {
    nom: String,
}
#[derive(Serialize)]
struct Id {
    id: String,
}
#[derive(Serialize)]
struct Mode {
    mode: &'static str,
}

async fn ajouter_hors_ligne(etat: Etat, nom: String) -> Result<(), String> {
    let l = appeler::<Liste>("ajouter_hors_ligne", Nom { nom: nom.clone() }).await?;
    appliquer_liste(etat, l);
    rafraichir_apparences(etat);
    etat.modal.set(None);
    toast(etat, "success", tv("actions.bienvenue", &[("name", nom.trim())]), Some(t("actions.compte_hors_ligne_ajoute_et")), 6000);
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Ajout {
    ended: Option<String>,
    name: Option<String>,
    active_id: Option<String>,
    accounts: Vec<Compte>,
}

/// Ouvre la connexion Microsoft ; sert aussi à reconnecter un compte expiré. `fenetre` : fenêtre intégrée.
pub fn ajouter_microsoft(etat: Etat, fenetre: bool) {
    if etat.connexion.get_untracked().is_some_and(|c| c.phase != "expired") {
        return;
    }
    etat.connexion.set(Some(Connexion { phase: if fenetre { "window" } else { "starting" }.into(), ..Default::default() }));
    leptos::task::spawn_local(async move {
        match appeler::<Ajout>("ajouter_microsoft", Mode { mode: if fenetre { "window" } else { "browser" } }).await {
            // Annulé, ou 10 minutes sans réponse du navigateur (bloc « Connexion annulée » avec Réessayer).
            Ok(a) if a.ended.is_some() => {
                let expire = a.ended.as_deref() == Some("TIMEOUT");
                etat.connexion.set(expire.then(|| Connexion { phase: "expired".into(), ..Default::default() }));
            }
            Ok(a) => {
                etat.connexion.set(None);
                let nom = a.name.clone().unwrap_or_default();
                appliquer_liste(etat, Liste { active_id: a.active_id, accounts: a.accounts });
                rafraichir_apparences(etat);
                toast(
                    etat,
                    "success",
                    tv("actions.connecte", &[("name", &nom)]),
                    Some(t("actions.compte_microsoft_ajoute_et_selectionne")),
                    6000,
                );
            }
            Err(e) => {
                etat.connexion.set(None);
                toast(etat, "error", t("actions.connexion_microsoft_impossible"), Some(e), 9000);
            }
        }
    });
}

fn commande(nom: &'static str) {
    leptos::task::spawn_local(async move {
        let _ = appeler::<Value>(nom, ()).await;
    });
}

fn copier_lien(etat: Etat) {
    let Some(url) = etat.connexion.get_untracked().and_then(|c| c.url) else { return };
    leptos::task::spawn_local(async move {
        let promesse = window().navigator().clipboard().write_text(&url);
        if wasm_bindgen_futures::JsFuture::from(promesse).await.is_err() {
            toast(etat, "error", t("common.le_presse_papiers_est_pas"), None, 6000);
            return;
        }
        etat.connexion.update(|c| {
            if let Some(c) = c {
                c.copie = true;
            }
        });
        set_timeout(
            move || {
                etat.connexion.update(|c| {
                    if let Some(c) = c.as_mut().filter(|c| c.url.as_deref() == Some(url.as_str())) {
                        c.copie = false;
                    }
                })
            },
            Duration::from_secs(4),
        );
    });
}

/// Passe à la fenêtre intégrée (la page affiche une erreur, ou le navigateur ne s'ouvre pas).
fn utiliser_fenetre(etat: Etat) {
    if etat.connexion.get_untracked().is_some_and(|c| c.phase == "expired") {
        etat.connexion.set(None);
        ajouter_microsoft(etat, true);
        return;
    }
    commande("connexion_fenetre");
}

fn annuler(etat: Etat) {
    if etat.connexion.get_untracked().is_some_and(|c| c.phase == "expired") {
        etat.connexion.set(None);
        return;
    }
    commande("connexion_annuler");
}

fn retirer(etat: Etat, id: String) {
    leptos::task::spawn_local(async move {
        match appeler::<Liste>("retirer_compte", Id { id }).await {
            Ok(l) => {
                if l.accounts.is_empty() {
                    etat.modal.set(None);
                }
                appliquer_liste(etat, l);
            }
            Err(e) => toast(etat, "error", t("actions.compte_non_retire"), Some(e), 9000),
        }
    });
}

fn activer(etat: Etat, id: String) {
    leptos::task::spawn_local(async move {
        match appeler::<Liste>("activer_compte", Id { id }).await {
            Ok(l) => appliquer_liste(etat, l),
            Err(e) => toast(etat, "error", t("actions.compte_non_selectionne"), Some(e), 9000),
        }
    });
}

/// Connexion dans le navigateur : attente du retour, puis vérification du compte.
fn attente(etat: Etat, c: Connexion) -> AnyView {
    let verification = c.phase == "checking";
    let _ = etat.horloge.get();
    let minutes = ((c.expires_at.unwrap_or_else(js_sys::Date::now) - js_sys::Date::now()) / 60_000.0).ceil().max(1.0);
    let boutons = (!verification).then(|| {
        view! {
            <div class="login-wait__row">
                <button class="btn btn--sm" on:click=|_| commande("connexion_rouvrir")>{t("modals.rouvrir_la_page")}</button>
                <button class=if c.copie { "btn btn--sm btn--done" } else { "btn btn--sm" } on:click=move |_| copier_lien(etat)>
                    {if c.copie { t("modals.lien_copie") } else { t("modals.copier_le_lien") }}
                </button>
                <button class="btn btn--sm" on:click=move |_| annuler(etat)>{t("common.annuler")}</button>
            </div>
            <div class="login-wait__alt">
                {t("modals.la_page_affiche_une_erreur")}
                <button class="btn btn--sm btn--link" on:click=move |_| utiliser_fenetre(etat)>{t("modals.utiliser_la_fenetre_integree")}</button>
            </div>
        }
    });
    view! {
        <div class="login-wait" role="status" aria-live="polite">
            <div class="login-wait__top">
                <span class="login-wait__icon"><span class="login-wait__spin" aria-hidden="true"></span>{icone_taille("browser", 22)}</span>
                <span class="login-wait__body">
                    <b>{if verification { t("modals.verification_du_compte") } else { t("modals.termine_la_connexion_dans_ton") }}</b>
                    <span class="login-wait__text">
                        {if verification { t("modals.microsoft_a_repondu_le_launcher") } else { t("modals.la_page_de_microsoft_est") }}
                    </span>
                    {(!verification).then(|| view! {
                        <span class="login-wait__timer">{icone_taille("clock", 13)}{tv("modals.en_attente_annulee_dans", &[("minutes", &minutes.to_string())])}</span>
                    })}
                </span>
            </div>
            {boutons}
        </div>
    }
    .into_any()
}

/// Dix minutes sans retour du navigateur : la connexion est annulée.
fn expiree(etat: Etat) -> AnyView {
    view! {
        <div class="login-wait login-wait--ko" role="alert">
            <div class="login-wait__top">
                <span class="login-wait__icon">{icone_taille("clock", 22)}</span>
                <span class="login-wait__body">
                    <b>{t("modals.connexion_annulee")}</b>
                    <span class="login-wait__text">{t("modals.aucune_reponse_du_navigateur_depuis")}</span>
                </span>
            </div>
            <div class="login-wait__row">
                <button class="btn btn--sm btn--primary" on:click=move |_| ajouter_microsoft(etat, false)>{t("modals.reessayer")}</button>
                <button class="btn btn--sm" on:click=move |_| utiliser_fenetre(etat)>{t("modals.utiliser_la_fenetre_integree")}</button>
                <button class="btn btn--sm btn--ghost" on:click=move |_| annuler(etat)>{t("common.fermer")}</button>
            </div>
        </div>
    }
    .into_any()
}

fn bouton_microsoft(etat: Etat) -> AnyView {
    let c = etat.connexion.get();
    match c.as_ref().map(|c| c.phase.as_str()) {
        Some("browser" | "checking") => attente(etat, c.unwrap_or_default()),
        Some("expired") => expiree(etat),
        _ => view! {
            <button class="btn btn--microsoft" disabled=c.is_some() on:click=move |_| ajouter_microsoft(etat, false)>
                {icone_taille("microsoft", 18)}
                {if c.is_some() { t("modals.connexion_en_cours") } else { t("modals.se_connecter_avec_microsoft") }}
            </button>
        }
        .into_any(),
    }
}

fn ligne_hors_ligne(c: &Compte) -> String {
    match &c.look {
        None => t("modals.hors_ligne_solo_et_serveurs"),
        Some(l) if l.get("skin").is_some_and(|s| !s.is_null()) => t("modals.hors_ligne_tete_du_skin"),
        Some(_) => t("modals.hors_ligne_ce_pseudo_pas"),
    }
}

fn ligne_compte(etat: Etat, c: Compte) -> impl IntoView {
    let actif = etat.compte_actif.get().as_deref() == Some(c.id.as_str());
    let partie = etat.run.get().is_some();
    let sous_titre = if c.kind == "offline" {
        ligne_hors_ligne(&c)
    } else if c.needs_login {
        t(if c.session_only == Some(true) {
            "modals.reconnecte_toi_session_non_enregistree"
        } else {
            "modals.session_expiree_reconnecte_toi"
        })
    } else if c.session_only == Some(true) {
        t("modals.session_gardee_fermeture")
    } else {
        t("common.compte_microsoft")
    };
    let id = c.id.clone();
    let action = if c.needs_login {
        let occupe = etat.connexion.get().is_some();
        view! { <button class="btn" disabled=occupe on:click=move |_| ajouter_microsoft(etat, false)>{t("modals.se_reconnecter")}</button> }
            .into_any()
    } else if actif {
        view! { <span class="tag tag--ok">{t("modals.actif")}</span> }.into_any()
    } else {
        let id = id.clone();
        view! { <button class="btn" disabled=partie on:click=move |_| activer(etat, id.clone())>{t("modals.utiliser")}</button> }.into_any()
    };
    let retirer_id = id.clone();
    // shortcut: l'écran « Skin et cape » arrive avec les écrans (R5) ; le bouton le signale en attendant.
    let skins = move |_| toast(etat, "info", t("main.ecran_pas_encore_porte"), None, 4000);
    view! {
        <li class=if actif { "account-row account-row--active" } else { "account-row" }>
            {tete(&c, 48)}
            <span class="account-row__body">
                <span class="account-row__name">{c.name.clone()}</span>
                <span class=if c.needs_login { "account-row__type hint--warn" } else { "account-row__type" }>
                    {(c.kind == "microsoft").then(|| icone_taille("microsoft", 12))}
                    {sous_titre}
                </span>
            </span>
            {action}
            <button class="btn" on:click=skins>{t("common.skin_et_cape")}</button>
            <button
                class="dialog__close"
                aria-label=tv("modals.retirer_le_compte", &[("name", &c.name)])
                disabled=partie && actif
                on:click=move |_| retirer(etat, retirer_id.clone())
            >
                {icone("trash")}
            </button>
        </li>
    }
}

/// Fenêtre « Comptes ».
#[component]
pub fn FenetreComptes() -> impl IntoView {
    let etat = expect_context::<Etat>();
    let saisie = NodeRef::<Input>::new();
    let erreur = RwSignal::new(String::new());
    let valider = move || {
        let Some(champ) = saisie.get() else { return };
        let nom = champ.value();
        leptos::task::spawn_local(async move {
            if let Err(e) = ajouter_hors_ligne(etat, nom).await {
                erreur.set(e);
                if let Some(c) = saisie.get_untracked() {
                    let _ = c.focus();
                }
            }
        });
    };
    let fermer = move || etat.modal.set(None);
    view! {
        <div class="overlay" on:click=move |e| {
            if e.target() == e.current_target() {
                fermer()
            }
        }>
            <section class="dialog dialog--accounts" role="dialog" aria-modal="true" aria-labelledby="accounts-title">
                <div class="dialog__head">
                    <h1 class="dialog__title" id="accounts-title">{t("common.comptes")}</h1>
                    <button class="dialog__close" aria-label=t("common.fermer") on:click=move |_| fermer()>{icone("close")}</button>
                </div>
                <div class="dialog__body">
                    {move || {
                        let l = etat.comptes.get();
                        (!l.is_empty()).then(|| view! {
                            <ul class="account-list" style="padding:0">{l.into_iter().map(|c| ligne_compte(etat, c)).collect_view()}</ul>
                        })
                    }}
                    // Linux sans trousseau : la session Microsoft n'est pas écrite sur le disque.
                    {move || etat.comptes.get().iter().any(|c| c.session_only == Some(true)).then(|| view! {
                        <div class="notice notice--warn" style="margin:0">
                            {icone("lock")}
                            <div>
                                <p style="margin:0">{t("modals.pas_de_trousseau")}</p>
                                <details style="margin-top:6px">
                                    <summary>{t("modals.comment_faire")}</summary>
                                    <p style="margin:6px 0 0">{t("modals.installer_un_trousseau")}</p>
                                </details>
                            </div>
                        </div>
                    })}
                    <h2 class="label" style="margin:4px 0 0">{t("common.ajouter_un_compte")}</h2>
                    {move || bouton_microsoft(etat)}
                    {move || {
                        // Un nouveau compte hors-ligne demande d'abord un compte Microsoft qui possède le jeu.
                        if etat.comptes.get().iter().any(|c| c.kind == "microsoft") {
                            view! {
                                <div class="field">
                                    <label for="accounts-offline" style="font-size:13px;font-weight:600">{t("modals.compte_hors_ligne")}</label>
                                    <div class="input-row">
                                        <input
                                            id="accounts-offline"
                                            class="input input--pixel"
                                            type="text"
                                            maxlength="16"
                                            placeholder=t("common.pseudo")
                                            spellcheck="false"
                                            node_ref=saisie
                                            on:input=move |_| erreur.set(String::new())
                                            on:keydown=move |e| {
                                                if e.key() == "Enter" {
                                                    valider()
                                                }
                                            }
                                        />
                                        <button class="btn btn--lg" on:click=move |_| valider()>{t("modals.ajouter")}</button>
                                    </div>
                                    <p class="hint hint--error" role="alert">{move || erreur.get()}</p>
                                    <p class="hint">{t("modals.16_caracteres_lettres_chiffres_et")}</p>
                                </div>
                            }
                            .into_any()
                        } else {
                            view! {
                                <div class="field">
                                    <span style="font-size:13px;font-weight:600">{t("modals.compte_hors_ligne")}</span>
                                    <p class="hint">{t("modals.les_comptes_hors_ligne_se")}</p>
                                </div>
                            }
                            .into_any()
                        }
                    }}
                    <p class="trust" style="margin:0">{icone("lock")}{t("modals.ton_mot_de_passe_reste")}</p>
                </div>
            </section>
        </div>
    }
}
