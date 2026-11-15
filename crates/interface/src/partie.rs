//! Partie en cours côté interface (listenToLaunches et handleLaunchStatus de actions.js) et notifications.

use crate::icones::icone;
use crate::texte::{t, tv};
use crate::{Etat, appeler, ecouter};
use commun::{Instance, MesuresJeu, Partie};
use leptos::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

pub const NOMBRE_ETAPES: usize = 9;
pub const ETAPE_FICHIERS: usize = 2;
pub const ETAPE_JAVA: usize = 3;
pub const ETAPE_LOADER: usize = 4;
pub const ETAPE_MEMOIRE: usize = 6;

/// Nom et détail par défaut de chaque étape (LAUNCH_STEPS de data.js).
pub fn etape(i: usize) -> (String, String) {
    match i {
        0 => (t("data.compte"), t("data.verification_du_compte")),
        1 => (t("data.composants"), t("data.fichier_de_version_mojang")),
        2 => (t("data.fichiers_du_jeu"), t("data.bibliotheques_et_assets")),
        3 => ("Java".into(), t("data.runtime_mojang_adapte")),
        4 => (t("common.loader_de_mods"), t("data.vanilla_rien_installer")),
        5 => (t("data.verification_de_java"), "java -version".into()),
        6 => (t("data.memoire_disponible"), t("data.ram_libre")),
        7 => (t("data.natives"), t("data.bibliotheques_natives")),
        _ => (t("common.lancement"), t("data.demarrage_de_minecraft")),
    }
}

/// Avancement global en pour cent (runPercent de state.js).
pub fn pourcentage(r: &Partie) -> u32 {
    let dans_etape = if r.total > 0 { r.done as f64 / r.total as f64 } else { 0.0 };
    (((r.step as f64 + dans_etape) / NOMBRE_ETAPES as f64 * 100.0).round() as u32).min(100)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Toast {
    pub id: u32,
    /// info | success | error
    pub kind: &'static str,
    pub title: String,
    pub text: Option<String>,
}

/// Notification en bas à droite ; 4 au plus, retirée après `delai` (0 : reste affichée).
// shortcut: sans boutons d'action (Voir la console, Repasser en Java automatique…) : ils arrivent avec les écrans (R5).
pub fn toast(etat: Etat, kind: &'static str, title: String, text: Option<String>, delai: u64) {
    static SUIVANT: AtomicU32 = AtomicU32::new(1);
    let id = SUIVANT.fetch_add(1, Ordering::Relaxed);
    etat.toasts.update(|l| {
        l.push(Toast { id, kind, title, text });
        if l.len() > 4 {
            l.remove(0);
        }
    });
    if delai > 0 {
        set_timeout(move || etat.toasts.update(|l| l.retain(|x| x.id != id)), Duration::from_millis(delai));
    }
}

#[component]
pub fn Toasts() -> impl IntoView {
    let etat = expect_context::<Etat>();
    view! {
        <For each=move || etat.toasts.get() key=|x| x.id let:x>
            <div class=format!("toast toast--{}", x.kind) role=if x.kind == "error" { "alert" } else { "status" }>
                <span class="toast__icon">{icone(match x.kind { "success" => "check", "error" => "alert", _ => "info" })}</span>
                <span class="toast__body">
                    <span class="toast__title">{x.title.clone()}</span>
                    {x.text.clone().map(|t| view! { <span class="toast__text">{t}</span> })}
                </span>
                <button
                    class="dialog__close"
                    style="width:28px;height:28px"
                    aria-label=t("modals.fermer_la_notification")
                    on:click=move |_| etat.toasts.update(|l| l.retain(|y| y.id != x.id))
                >
                    {icone("close")}
                </button>
            </div>
        </For>
    }
}

/// launch:status : état de la partie et ce qui vient de se passer.
#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
struct Statut {
    run: Option<Partie>,
    instance_id: Option<String>,
    error: Option<String>,
    error_code: Option<String>,
    prepared: bool,
    exited: bool,
    crashed: bool,
    code: Option<i32>,
    crash: Option<serde::de::IgnoredAny>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct EtatPartie {
    run: Option<Partie>,
    metrics: Option<MesuresJeu>,
}

pub fn rafraichir_instances(etat: Etat) {
    leptos::task::spawn_local(async move {
        if let Ok(l) = appeler::<Vec<Instance>>("instances", ()).await {
            etat.instances.set(l);
        }
    });
}

fn changement(etat: Etat, s: Statut) {
    let fini = s.run.is_none();
    etat.run.set(s.run.clone());
    if fini {
        etat.mesures.set(None);
    }
    let id = s.instance_id.clone().or_else(|| s.run.as_ref().map(|r| r.instance_id.clone()));
    let instance = id.and_then(|id| etat.instances.with_untracked(|l| l.iter().find(|i| i.id == id).cloned()));
    let nom = instance.as_ref().map_or_else(|| "L'instance".into(), |i| i.name.clone());
    if let Some(e) = &s.error {
        let titre = match s.error_code.as_deref() {
            Some("JAVA_32_BIT") => t("actions.lancement_arrete_java_32"),
            Some("ROSETTA_MISSING") => {
                tv("actions.besoin_de_rosetta", &[("version", instance.as_ref().map_or("", |i| i.version.as_str()))])
            }
            _ => t("actions.le_lancement_echoue"),
        };
        toast(etat, "error", titre, Some(e.clone()), if s.error_code.is_some() { 0 } else { 12_000 });
    }
    if s.prepared {
        toast(etat, "success", tv("actions.est_prete", &[("name", &nom)]), Some(t("actions.tous_les_fichiers_ont_ete")), 6000);
    }
    if s.crashed {
        let code = s.code.map_or_else(|| "?".into(), |c| c.to_string());
        let cle = if s.crash.is_some() { "actions.crash_report_read" } else { "actions.crash_report_console" };
        toast(etat, "error", t("actions.le_jeu_plante"), Some(tv(cle, &[("name", &nom), ("code", &code)])), 0);
    }
    let en_jeu = s.run.as_ref().is_some_and(|r| r.phase == "running");
    if en_jeu && let Some(i) = instance.as_ref().filter(|i| !i.installed) {
        toast(
            etat,
            "success",
            tv("actions.est_prete", &[("name", &nom)]),
            Some(tv("actions.minecraft_installe", &[("version", &i.version)])),
            6000,
        );
    }
    if s.exited || s.prepared || en_jeu {
        rafraichir_instances(etat);
    }
}

/// Suit la partie : état au démarrage de la fenêtre, puis les événements du moteur.
pub fn suivre(etat: Etat) {
    ecouter::<Partie>("launch:progress", move |r| etat.run.set(Some(r)));
    ecouter::<MesuresJeu>("launch:metrics", move |m| etat.mesures.set(Some(m)));
    ecouter::<Statut>("launch:status", move |s| changement(etat, s));
    // shortcut: les logs (launch:logs) sont gardés par le moteur ; la console qui les montre arrive avec les écrans (R5).
    leptos::task::spawn_local(async move {
        if let Ok(e) = appeler::<EtatPartie>("etat_partie", ()).await {
            etat.run.set(e.run);
            etat.mesures.set(e.metrics);
        }
    });
}

#[derive(Serialize)]
struct Options {
    verify: bool,
    #[serde(rename = "prepareOnly")]
    prepare_only: bool,
}

#[derive(Serialize)]
struct Lancer {
    id: String,
    options: Options,
}

/// Jouer (ou Vérifier : `verifier` = vérification complète sans lancer le jeu).
// shortcut: sans contrôle des mods ni alerte de mémoire avant la partie : ils arrivent avec le contenu (R4).
pub fn lancer(etat: Etat, id: String, verifier: bool) {
    if etat.run.get_untracked().is_some() {
        return;
    }
    leptos::task::spawn_local(async move {
        let o = Options { verify: verifier, prepare_only: verifier };
        match appeler::<Partie>("lancer", Lancer { id, options: o }).await {
            Ok(r) => etat.run.set(Some(r)),
            Err(e) => toast(etat, "error", t("actions.lancement_impossible"), Some(e), 9000),
        }
    });
}

pub fn arreter(etat: Etat) {
    leptos::task::spawn_local(async move {
        if let Err(e) = appeler::<()>("arreter", ()).await {
            toast(etat, "error", t("actions.impossible_arreter"), Some(e), 9000);
        }
    });
}
