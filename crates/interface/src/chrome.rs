//! Éléments toujours visibles : décor, barre de titre, barre des instances, onglets et compte (portage de chrome.js).

use crate::icones::{icone, svg};
use crate::texte::{comparer_naturel, t, tv};
use crate::{Etat, appeler, statut};
use commun::{Compte, Instance, LOADERS, loader_name};
use leptos::prelude::*;

const DECOR_PAR_DEFAUT: u32 = 120;
const VOILE_MAX: f64 = 0.8;

/// Décor de la fenêtre : coucher de soleil, ou le fond choisi pour l'instance sélectionnée (scene.js).
#[component]
pub fn Scene() -> impl IntoView {
    let etat = expect_context::<Etat>();
    // shortcut: les fonds « image » (protocole fond://) arrivent en R4 ; d'ici là, le décor Coucher, comme une image manquante.
    let reglage = move || {
        let instance = etat.instance_choisie();
        let seed = instance.as_ref().and_then(|i| i.seed).unwrap_or(DECOR_PAR_DEFAUT);
        match instance.and_then(|i| i.background).filter(|b| b.kind != "image") {
            Some(b) => (seed, b.kind, b.dim),
            None => (seed, "sunset".to_string(), 0.0),
        }
    };
    let src = move || {
        etat.pret.get().then(|| {
            let (seed, theme, _) = reglage();
            crate::banniere::scene(seed, &theme)
        })
    };
    let voile = move || etat.pret.get().then(|| format!("--scene-dim: {}", reglage().2.clamp(0.0, 100.0) / 100.0 * VOILE_MAX));
    view! {
        <div class="scene" aria-hidden="true" style=voile>
            <img class="scene__art" id="scene-art" alt="" src=src />
        </div>
    }
}

fn bouton_fenetre(action: &'static str, classe: &'static str, cle: &'static str) -> impl IntoView {
    let clic = move |_| {
        leptos::task::spawn_local(async move {
            let _ = appeler::<()>("fenetre", serde_json_args(action)).await;
        })
    };
    view! {
        <button class=classe aria-label=t(cle) on:click=clic inner_html=svg(match action {
            "reduire" => "fenetre-reduire",
            "agrandir" => "fenetre-agrandir",
            _ => "fenetre-fermer",
        })></button>
    }
}

#[derive(serde::Serialize)]
struct ArgsFenetre {
    action: &'static str,
}
fn serde_json_args(action: &'static str) -> ArgsFenetre {
    ArgsFenetre { action }
}

#[component]
pub fn BarreDeTitre() -> impl IntoView {
    view! {
        <div class="titlebar" data-tauri-drag-region="">
            <span class="titlebar__brand" data-tauri-drag-region="">
                <span class="logo logo--xs" aria-hidden="true"></span>
                "0Rzxn_ Launcher"
            </span>
            <div class="titlebar__update" id="titlebar-update"></div>
            <div class="fenetre-boutons">
                {bouton_fenetre("reduire", "fenetre-bouton", "fenetre.reduire")}
                {bouton_fenetre("agrandir", "fenetre-bouton", "fenetre.agrandir")}
                {bouton_fenetre("fermer", "fenetre-bouton fenetre-bouton--fermer", "fenetre.fermer")}
            </div>
        </div>
    }
}

const TABS: [(&str, &str); 4] = [("home", "home"), ("mods", "mods"), ("worlds", "worlds"), ("versions", "versions")];

fn nom_onglet(id: &str) -> String {
    match id {
        "home" => t("chrome.accueil"),
        "mods" => "Mods".into(),
        "worlds" => t("chrome.mondes"),
        _ => t("common.versions"),
    }
}

/// Avatar pixel en attendant les vraies têtes de skin (avatar() de dom.js).
fn avatar(variante: &str, taille: u32) -> impl IntoView + use<> {
    const A: [&str; 8] = ["HHHHHHHH", "HHHHHHHH", "GHSSSSHG", "GSSSSSSG", "SWPSSPWS", "SSSSSSSS", "SSSMMSSS", "SSSSSSSS"];
    const B: [&str; 8] = ["OOOOOOOO", "OOOOOOOO", "OOSSSSOO", "OSSSSSSO", "OSESSESO", "OSSSSSSO", "OSSmmSSO", "OOSSSSOO"];
    let couleur = |c: char| match c {
        'H' => "#1b1b22",
        'G' => "#7c5cff",
        'S' => "#e0ac85",
        'W' => "#f5f5f5",
        'P' => "#2b3a67",
        'M' => "#9c5b4a",
        'O' => "#5b6475",
        'E' => "#1f2937",
        _ => "#a0644f",
    };
    let lignes = if variante == "b" { B } else { A };
    view! {
        <span class="avatar" aria-hidden="true" style=format!("width:{taille}px;height:{taille}px")>
            {lignes.concat().chars().map(|c| view! { <span style=format!("background:{}", couleur(c))></span> }).collect_view()}
        </span>
    }
}

/// Tête du compte. shortcut: toujours l'avatar pixel ; les têtes de skin (cache skin://) arrivent en R3.
pub fn tete(compte: &Compte, taille: u32) -> impl IntoView + use<> {
    avatar(if compte.kind == "microsoft" { "a" } else { "b" }, taille)
}

#[component]
pub fn BarreDuHaut() -> impl IntoView {
    let etat = expect_context::<Etat>();
    let onglets = move || {
        TABS.iter()
            .map(|&(id, nom_icone)| {
                view! {
                    <button class="tab" aria-current=move || (etat.vue.get() == id).then_some("page") on:click=move |_| etat.vue.set(id)>
                        {icone(nom_icone)}
                        {nom_onglet(id)}
                    </button>
                }
            })
            .collect_view()
    };
    let compte = move || {
        let compte = etat.compte_actif();
        let label = compte.as_ref().map_or_else(|| t("common.comptes"), |c| tv("chrome.comptes", &[("name", &c.name)]));
        let (nom, kind) = match &compte {
            Some(c) => (c.name.clone(), if c.kind == "microsoft" { t("common.compte_microsoft") } else { t("common.hors_ligne") }),
            None => (t("common.aucun_compte"), t("common.ajouter_un_compte")),
        };
        view! {
            <button class="account-chip" aria-label=label>
                {match &compte {
                    Some(c) => tete(c, 30).into_any(),
                    None => view! { <span class="avatar" style="width:30px;height:30px;background:var(--line-3)"></span> }.into_any(),
                }}
                <span>
                    <span class="account-chip__name">{nom}</span>
                    <span class="account-chip__type">{kind}</span>
                </span>
            </button>
        }
    };
    view! {
        <header class="topbar">
            <nav class="tabs" id="tabs" aria-label=t("chrome.tabs_label")>{onglets}</nav>
            <div class="topbar__right" id="topbar-right">
                {compte}
                <button
                    class="square-btn"
                    aria-label=t("common.parametres")
                    aria-pressed=move || if etat.vue.get() == "settings" { "true" } else { "false" }
                    on:click=move |_| etat.vue.update(|v| *v = if *v == "settings" { "home" } else { "settings" })
                >
                    {icone("settings")}
                </button>
            </div>
        </header>
    }
}

/// Nom, version et loader : « fabric 1.21 » trouve les instances Fabric en 1.21.x.
fn correspond(instance: &Instance, requete: &str) -> bool {
    let botte =
        format!("{} {} {} {}", instance.name, instance.version, loader_name(&instance.loader), instance.group.clone().unwrap_or_default())
            .to_lowercase();
    requete.to_lowercase().split_whitespace().all(|mot| botte.contains(mot))
}

/// Du plus récent au plus ancien. shortcut: sans le manifeste de Mojang (R2), les numéros sont comparés entre eux.
fn plus_recentes_d_abord(mut liste: Vec<Instance>) -> Vec<Instance> {
    liste.sort_by(|a, b| {
        comparer_naturel(&b.version, &a.version)
            .then_with(|| b.last_played_at.unwrap_or(0).cmp(&a.last_played_at.unwrap_or(0)))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    liste
}

/// Une catégorie par loader, vides masquées ; une seule liste sans nom pendant une recherche.
fn groupes(etat: Etat) -> Vec<(Option<&'static str>, Vec<Instance>)> {
    let requete = etat.recherche.get();
    let instances = etat.instances.get();
    if !requete.trim().is_empty() {
        return vec![(None, plus_recentes_d_abord(instances.into_iter().filter(|i| correspond(i, requete.trim())).collect()))];
    }
    LOADERS
        .iter()
        .map(|&l| (Some(l), plus_recentes_d_abord(instances.iter().filter(|i| i.loader == l).cloned().collect())))
        .filter(|(_, items)| !items.is_empty())
        .collect()
}

fn ligne_instance(etat: Etat, instance: Instance) -> impl IntoView {
    let st = statut(&instance);
    let id = instance.id.clone();
    let id_actuel = id.clone();
    let actuelle = move || {
        (etat.choisie.get().as_deref() == Some(id_actuel.as_str()) && matches!(etat.vue.get(), "home" | "mods" | "worlds"))
            .then_some("true")
    };
    let choisir = {
        let id = id.clone();
        move |_| {
            etat.choisie.set(Some(id.clone()));
            etat.vue.update(|v| {
                if !matches!(*v, "mods" | "worlds") {
                    *v = "home"
                }
            });
        }
    };
    let badge = (st.kind != "idle").then(|| view! { <span class=format!("block__badge block__badge--{}", st.kind)></span> });
    let texte_statut = format!("{} · {}", instance.version, st.label);
    // R0 : rien ne se lance encore ; le bouton est là pour comparer l'apparence.
    let jouer = etat.compte_actif().is_some().then(|| {
        let titre =
            if instance.installed { t("common.jouer") } else { tv("chrome.installer_puis_jouer", &[("version", &instance.version)]) };
        view! {
            <button class="instance-play" aria-label=tv("chrome.jouer", &[("name", &instance.name)]) title=titre>
                {icone("play")}
            </button>
        }
    });
    view! {
        <div class="instance-row">
            <button class="instance-item" aria-current=actuelle on:click=choisir>
                <span class=format!("block block--{}", instance.icon) aria-hidden="true">{badge}</span>
                <span style="min-width:0">
                    <span class="instance-item__line">
                        <span class="instance-item__name">{instance.name.clone()}</span>
                    </span>
                    <span class=format!("instance-item__status instance-item__status--{}", st.kind)>{texte_statut}</span>
                </span>
            </button>
            {jouer}
        </div>
    }
}

fn liste_instances(etat: Etat) -> AnyView {
    if etat.instances.with(Vec::is_empty) {
        return view! { <p class="hint" style="padding:6px 10px">{t("chrome.aucune_instance_pour_instant_cree")}</p> }.into_any();
    }
    let gs = groupes(etat);
    if gs[0].0.is_none() {
        let trouvees = gs.into_iter().next().unwrap().1;
        if trouvees.is_empty() {
            let requete = etat.recherche.get_untracked();
            return view! { <p class="hint" style="padding:6px 10px">{tv("chrome.aucune_instance_ne_correspond", &[("query", requete.trim())])}</p> }.into_any();
        }
        return trouvees.into_iter().map(|i| ligne_instance(etat, i)).collect_view().into_any();
    }
    gs.into_iter()
        .map(|(loader, items)| {
            let loader = loader.unwrap();
            let nom = loader_name(loader);
            let ouvert = !etat.replies.get().iter().any(|g| g == nom);
            let tient_la_choisie = !ouvert && items.iter().any(|i| Some(&i.id) == etat.choisie.get().as_ref());
            // R0 : le repli n'est pas encore enregistré dans settings.json.
            let basculer = move |_| {
                etat.replies.update(|r| {
                    if let Some(p) = r.iter().position(|g| g == nom) {
                        r.remove(p);
                    } else {
                        r.push(nom.to_string());
                    }
                })
            };
            let compte = items.len();
            view! {
                <div class="sidebar__group" role="group" aria-label=nom>
                    <button class="group-head" aria-expanded=if ouvert { "true" } else { "false" } on:click=basculer>
                        <span class=format!("group-head__pip loader--{loader}") aria-hidden="true"></span>
                        <span class="group-head__name">{nom}</span>
                        {tient_la_choisie.then(|| view! {
                            <span class="group-head__mark" title=t("chrome.instance_selectionnee") aria-label=t("chrome.contient_instance_selectionnee")></span>
                        })}
                        <span class="group-head__count">{compte}</span>
                        {icone("chevron")}
                    </button>
                    {ouvert.then(|| items.into_iter().map(|i| ligne_instance(etat, i)).collect_view())}
                </div>
            }
        })
        .collect_view()
        .into_any()
}

#[component]
pub fn BarreLaterale() -> impl IntoView {
    let etat = expect_context::<Etat>();
    let recherche = move || {
        (etat.instances.with(Vec::len) > 1).then(|| {
            view! {
                <label class="sidebar__search">
                    {icone("search")}
                    <span class="visually-hidden">{t("chrome.rechercher_une_instance")}</span>
                    <input
                        id="instance-search"
                        type="search"
                        placeholder=t("chrome.rechercher")
                        prop:value=move || etat.recherche.get()
                        on:input=move |e| etat.recherche.set(event_target_value(&e))
                        on:keydown=move |e| {
                            if e.key() == "Escape" {
                                etat.recherche.set(String::new());
                            }
                            if e.key() == "Enter" {
                                let requete = etat.recherche.get_untracked();
                                if let Some(i) = etat.instances.get_untracked().into_iter().find(|i| correspond(i, &requete)) {
                                    etat.choisie.set(Some(i.id));
                                }
                            }
                        }
                    />
                    <kbd class="sidebar__kbd">"Ctrl F"</kbd>
                </label>
            }
        })
    };
    view! {
        <aside class="sidebar" id="sidebar" aria-label=t("common.instances")>
            <div class="sidebar__head">
                <h2 class="sidebar__title">{t("common.instances")}</h2>
                <button class="sidebar__add" aria-label=t("common.nouvelle_instance")>{icone("plus")}</button>
            </div>
            {recherche}
            <div class="sidebar__list" data-scroll-key="sidebar">{move || liste_instances(etat)}</div>
            <div class="sidebar__foot">
                <button class="side-link" aria-current=move || (etat.vue.get() == "activity").then_some("page") on:click=move |_| etat.vue.set("activity")>
                    {icone("activity")}
                    {t("chrome.activite")}
                </button>
                <button class="side-link" aria-current=move || (etat.vue.get() == "console").then_some("page") on:click=move |_| etat.vue.set("console")>
                    {icone("console")}
                    {t("common.console")}
                </button>
                <button class="side-link">{icone("folder")} {t("common.dossier_du_launcher")}</button>
            </div>
            <p class="sidebar__version">{move || tv("chrome.version", &[("appVersion", &etat.app_version.get())])}</p>
        </aside>
    }
}
