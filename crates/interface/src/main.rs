//! Interface du launcher (Leptos, compilée en WebAssembly). R0 : accueil en lecture seule.

mod accueil;
mod banniere;
mod chrome;
mod icones;
mod texte;

use commun::{Compte, Demarrage, Instance};
use leptos::prelude::*;
use serde::{Serialize, de::DeserializeOwned};
use texte::t;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["window", "__TAURI__", "core"], catch)]
    async fn invoke(cmd: &str, args: JsValue) -> Result<JsValue, JsValue>;
}

/// Appelle une commande du moteur (crates/app) ; les types sont ceux de `commun`.
pub async fn appeler<T: DeserializeOwned>(cmd: &str, args: impl Serialize) -> Result<T, String> {
    let args = serde_wasm_bindgen::to_value(&args).map_err(|e| e.to_string())?;
    let v = invoke(cmd, args).await.map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))?;
    serde_wasm_bindgen::from_value(v).map_err(|e| e.to_string())
}

/// État de l'interface : des signaux, copiables, partagés par contexte.
#[derive(Clone, Copy)]
pub struct Etat {
    pub pret: RwSignal<bool>,
    pub erreur: RwSignal<Option<String>>,
    pub app_version: RwSignal<String>,
    pub vue: RwSignal<&'static str>,
    pub instances: RwSignal<Vec<Instance>>,
    pub choisie: RwSignal<Option<String>>,
    pub comptes: RwSignal<Vec<Compte>>,
    pub compte_actif: RwSignal<Option<String>>,
    pub recherche: RwSignal<String>,
    pub replies: RwSignal<Vec<String>>,
}

impl Etat {
    pub fn instance_choisie(&self) -> Option<Instance> {
        let id = self.choisie.get()?;
        self.instances.with(|l| l.iter().find(|i| i.id == id).cloned())
    }
    pub fn compte_actif(&self) -> Option<Compte> {
        let id = self.compte_actif.get()?;
        self.comptes.with(|l| l.iter().find(|c| c.id == id).cloned())
    }
}

/// État d'une instance (instanceStatus de state.js ; pas encore de partie en cours en R0).
pub struct Statut {
    pub kind: &'static str,
    pub label: String,
}

pub fn statut(instance: &Instance) -> Statut {
    if instance.installed {
        Statut { kind: "ready", label: t("common.prete") }
    } else {
        Statut { kind: "idle", label: t("common.installer") }
    }
}

/// État de départ. La langue et le système sont posés avant le premier rendu, comme dans la version Electron.
fn etat_initial(depart: Result<Demarrage, String>) -> Etat {
    let (d, erreur) = match depart {
        Ok(d) => (d, None),
        Err(e) => (Demarrage::default(), Some(e)),
    };
    texte::choisir(if d.lang.is_empty() { "auto" } else { &d.lang });
    let os = match d.platform.as_str() {
        "macos" => "mac",
        "linux" => "linux",
        _ => "windows",
    };
    let _ = document().document_element().unwrap().class_list().add_1(&format!("os-{os}"));
    let choisie = d.selected_id.filter(|id| d.instances.iter().any(|i| &i.id == id)).or_else(|| d.instances.first().map(|i| i.id.clone()));
    Etat {
        pret: RwSignal::new(erreur.is_none()),
        erreur: RwSignal::new(erreur),
        app_version: RwSignal::new(d.app_version),
        vue: RwSignal::new("home"),
        instances: RwSignal::new(d.instances),
        choisie: RwSignal::new(choisie),
        comptes: RwSignal::new(d.accounts),
        compte_actif: RwSignal::new(d.active_account_id),
        recherche: RwSignal::new(String::new()),
        replies: RwSignal::new(d.collapsed_groups),
    }
}

#[component]
fn Principal() -> impl IntoView {
    let etat = expect_context::<Etat>();
    let plat = move || etat.pret.get() && matches!(etat.vue.get(), "versions" | "mods" | "worlds");
    view! {
        <main class="main" class:main--flush=plat>
            {move || {
                if let Some(e) = etat.erreur.get() {
                    return view! {
                        <div class="empty">
                            <h1 class="empty__title">{t("main.le_launcher_pas_pu_demarrer")}</h1>
                            <p class="empty__text">{e}</p>
                        </div>
                    }
                    .into_any();
                }
                if !etat.pret.get() {
                    return view! { <div class="empty"><p class="empty__text">{t("common.chargement")}</p></div> }.into_any();
                }
                match etat.vue.get() {
                    "home" => view! { <accueil::Accueil /> }.into_any(),
                    // shortcut: écrans pas encore portés, texte en dur ; retiré en R5 quand ils arrivent.
                    _ => view! { <div class="empty"><p class="empty__text">"Écran pas encore porté en Rust (phase R5)."</p></div> }.into_any(),
                }
            }}
        </main>
    }
}

#[component]
fn App(etat: Etat) -> impl IntoView {
    provide_context(etat);
    // Mêmes enfants de <body>, dans le même ordre, que index.html de la version Electron (la grille en dépend).
    view! {
        <chrome::Scene />
        <chrome::BarreDeTitre />
        <chrome::BarreLaterale />
        <chrome::BarreDuHaut />
        <Principal />
        <div id="modal-root"></div>
        <div class="toasts" id="toasts" aria-live="polite"></div>
    }
}

fn main() {
    console_error_panic_hook::set_once();
    // Avant le montage, l'exécuteur de Leptos n'existe pas encore : celui de wasm-bindgen.
    wasm_bindgen_futures::spawn_local(async {
        let depart = appeler::<Demarrage>("demarrage", ()).await;
        leptos::mount::mount_to_body(move || {
            let etat = etat_initial(depart);
            view! { <App etat /> }
        });
    });
}
