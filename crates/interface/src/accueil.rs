//! Onglet Accueil (portage de views/home.js). R0 : lecture seule, aucun bouton n'agit encore.

use crate::chrome::tete;
use crate::icones::icone;
use crate::texte::{
    arrondi, cle_du_jour, format_court, format_date, format_derniere_partie, format_go, format_memoire, format_secondes,
    format_temps_de_jeu, t, tv,
};
use crate::{Etat, Statut, statut};
use commun::{Instance, loader_name};
use leptos::prelude::*;

fn java_label(instance: &Instance) -> String {
    instance.java_major.map_or_else(|| "Java".into(), |j| format!("Java {j}"))
}

/// « Fabric 0.19.5 », « Forge 66.1.0 »… (sans le numéro de Minecraft répété).
fn loader_label(instance: &Instance) -> String {
    if instance.loader == "vanilla" {
        return "Vanilla".into();
    }
    let v = instance.loader_version.clone().unwrap_or_default();
    let court = v.strip_prefix(&format!("{}-", instance.version)).unwrap_or(&v);
    let court = court.strip_suffix(&format!("-{}", instance.version)).unwrap_or(court);
    format!("{} {court}", loader_name(&instance.loader))
}

fn bouton_jouer(etat: Etat, instance: &Instance) -> AnyView {
    if etat.compte_actif().is_none() {
        return view! { <button class="play play--disabled" disabled>{t("common.aucun_compte")}</button> }.into_any();
    }
    if !instance.installed {
        return view! { <button class="play play--install">{icone("download")}{tv("home.installer", &[("version", &instance.version)])}</button> }.into_any();
    }
    view! { <button class="play">{icone("play")}{t("common.jouer")}</button> }.into_any()
}

fn hero(etat: Etat, instance: &Instance, st: &Statut) -> impl IntoView {
    let pastille = if st.kind == "ready" { t("common.prete") } else { t("common.installer") };
    let derniere = format_derniere_partie(instance.last_played_at);
    let sous_titre = format!(
        "{} · {} · {}{}",
        loader_label(instance),
        java_label(instance),
        format_temps_de_jeu(instance.playtime),
        if instance.playtime > 0.0 { t("home.de_jeu") } else { String::new() }
    );
    let version = format!(
        "Minecraft {}{}",
        instance.version,
        if instance.loader != "vanilla" { format!(" · {}", loader_name(&instance.loader)) } else { String::new() }
    );
    let compte_fixe = instance.account_id.as_ref().and_then(|id| etat.comptes.get().into_iter().find(|c| &c.id == id)).map(|c| {
        view! { <span class="hero__account">{tete(&c, 28)}<span>{tv("home.toujours_avec", &[("name", &c.name)])}</span></span> }
    });
    // shortcut: le bouton « Reprendre » (mondes récents) arrive avec le lancement, en R4.
    view! {
        <section class="hero" aria-label=tv("common.instance_2", &[("name", &instance.name)])>
            <div class="hero__info">
                <div class="hero__meta">
                    <span class="status-pill">{version}</span>
                    <span class=format!("status-pill status-pill--{}", st.kind)>
                        <span class="status-pill__dot" aria-hidden="true"></span>
                        <span class="status-pill__state">{pastille}</span>
                    </span>
                    {derniere.map(|d| view! { <span class="status-pill">{tv("home.derniere_partie", &[("lastPlayed", &d)])}</span> })}
                </div>
                <h1 class="hero__title">{instance.name.clone()}</h1>
                <p class="hero__sub">{sous_titre}</p>
            </div>
            <div class="hero__bar">
                {bouton_jouer(etat, instance)}
                <div class="version-box">
                    <span class="version-box__body">
                        <span class="label">{t("common.version")}</span>
                        <span class="version-box__value">{instance.version.clone()}</span>
                    </span>
                </div>
                {compte_fixe}
                <button class="btn btn--ghost">{icone("folder")}{t("home.ouvrir_le_dossier")}</button>
            </div>
        </section>
    }
}

const FACES: [&str; 6] = ["front", "back", "left", "right", "top", "bottom"];
const TOUR_MS: u64 = 950;

fn mouvement_reduit() -> bool {
    window().match_media("(prefers-reduced-motion: reduce)").ok().flatten().is_some_and(|m| m.matches())
}

/// Bloc de l'instance en 3D : suit la souris, tourne au clic.
fn bloc_instance(etat: Etat, instance: &Instance) -> impl IntoView {
    let pose = RwSignal::new((0.0_f64, 0.0_f64, 0_u32));
    let tourne = RwSignal::new(false);
    let suivre = !mouvement_reduit();
    let transform = move || {
        let (x, y, tours) = pose.get();
        format!("transform:rotateX({}deg) rotateY({}deg)", -24.0 - y * 14.0, -38.0 + x * 22.0 + tours as f64 * 360.0)
    };
    let tourner = move |_| {
        if mouvement_reduit() {
            return;
        }
        pose.update(|p| p.2 += 1);
        tourne.set(true);
        set_timeout(move || tourne.set(false), std::time::Duration::from_millis(TOUR_MS));
    };
    let viser = move |e: web_sys::PointerEvent| {
        if !suivre {
            return;
        }
        let Some(cible) = e.current_target().and_then(|c| wasm_bindgen::JsCast::dyn_into::<web_sys::Element>(c).ok()) else { return };
        let r = cible.get_bounding_client_rect();
        let x = ((e.client_x() as f64 - r.left()) / r.width()) * 2.0 - 1.0;
        let y = ((e.client_y() as f64 - r.top()) / r.height()) * 2.0 - 1.0;
        pose.update(|p| (p.0, p.1) = (x, y));
    };
    let quitter = move |_| {
        if suivre {
            pose.update(|p| (p.0, p.1) = (0.0, 0.0));
        }
    };

    let mods = match instance.mods_actifs {
        None | Some(0) => t("home.aucun"),
        Some(n) => tv("home.mods_active", &[("count", &n.to_string())]),
    };
    let java = if instance.settings.java == "custom" && !instance.settings.java_path.is_empty() {
        t("common.personnalise")
    } else {
        java_label(instance)
    };
    let ram = RwSignal::new(instance.settings.ram);
    let pic = instance.last_launch.as_ref().and_then(|l| l.peak_memory);
    let ram_max = 2.0_f64.max(instance.settings.ram).max(16.0);
    let action = |nom: &'static str, cle: &str, desactive: bool| {
        view! { <button class="block-action" disabled=desactive>{icone(nom)}{t(cle)}</button> }
    };
    let _ = etat;
    view! {
        <section class="instance-block" aria-label=t("common.instance") on:pointermove=viser on:pointerleave=quitter>
            <button class=format!("cube-stage loader--{}", instance.loader) aria-label=t("home.faire_tourner_le_bloc") on:click=tourner>
                <span class="cube-stage__halo" aria-hidden="true"></span>
                <span class="cube-stage__float">
                    <span class=format!("cube cube--{}", instance.icon) class:cube--spin=move || tourne.get() style=transform>
                        {FACES.iter().map(|f| view! { <i class=format!("cube__face cube__face--{f}")></i> }).collect_view()}
                    </span>
                </span>
            </button>
            <div class="instance-block__specs">
                <button class="spec-tile">
                    <span class="spec-tile__label">"Mods"</span>
                    <span class="spec-tile__value">{mods}</span>
                </button>
                // shortcut: sans le conseiller de mémoire (R4) : pas de verdict ni de zones, et le réglage n'est pas enregistré.
                <div class="spec-tile spec-tile--ram">
                    <div class="ram-row">
                        <label class="spec-tile__label" for="home-ram">{t("common.memoire")}</label>
                        <span class="ram-badge"></span>
                    </div>
                    <div class="ram-row">
                        <span class="spec-tile__value">{move || format_go(ram.get())}</span>
                    </div>
                    <input
                        id="home-ram"
                        class="range-zones"
                        type="range"
                        min="1"
                        max=ram_max.to_string()
                        step="0.5"
                        prop:value=move || ram.get().to_string()
                        on:input=move |e| ram.set(event_target_value(&e).parse().unwrap_or(4.0))
                    />
                    <p class="ram-advice"></p>
                    // Pic de mémoire de la dernière partie (mesuré) : aide à juger le réglage.
                    {pic.map(|p| view! { <p class="ram-pc">{tv("home.derniere_partie_pic", &[("peak", &format_memoire(p as f64))])}</p> })}
                </div>
                <button class="spec-tile">
                    <span class="spec-tile__label">"Java"</span>
                    <span class="spec-tile__value">{java}</span>
                </button>
            </div>
            <div class="instance-block__actions">
                {action("edit", "home.modifier", false)}
                {action("copy", "home.dupliquer", false)}
                {action("upload", "home.exporter", false)}
                {action("link", "home.raccourci", false)}
                {action("shield", "home.verifier", !instance.installed)}
                <button class="block-action block-action--danger">{icone("trash")}{t("common.supprimer")}</button>
            </div>
        </section>
    }
}

fn tuile(label: String, valeur: String, pied: impl IntoView, extra: impl IntoView) -> impl IntoView {
    view! {
        <div class="stat-tile">
            <span class="stat-tile__label">{label}</span>
            <span class="stat-tile__value">{valeur}</span>
            {pied}
            {extra}
        </div>
    }
}

fn note(texte: String) -> impl IntoView {
    view! { <span class="stat-tile__foot">{texte}</span> }
}

/// Après une partie : temps du dernier lancement et mémoire utilisée au plus (launcher.db).
fn tuiles_lancement(instance: &Instance) -> Option<impl IntoView + use<>> {
    let l = instance.last_launch.clone().filter(|l| l.prepare_ms.is_some() || l.peak_memory.is_some())?;
    let total = match (l.prepare_ms, l.menu_ms) {
        (Some(p), Some(m)) => Some(p + m),
        (p, _) => p,
    };
    let s = |ms: i64| format_secondes(ms as f64);
    let duree = total.map(|total| {
        let pied = match (l.prepare_ms, l.menu_ms) {
            (Some(p), Some(m)) => tv("home.preparation_plus_jeu", &[("prepare", &s(p)), ("game", &s(m))]),
            (p, _) => tv("home.de_preparation", &[("time", &s(p.unwrap_or(0)))]),
        };
        tuile(t("home.dernier_lancement"), s(total), note(pied), ())
    });
    let ram = instance.settings.ram;
    let memoire = l.peak_memory.map(|pic| {
        tuile(
            t("home.memoire_derniere_partie"),
            format_memoire(pic as f64),
            note(tv("home.au_plus_sur_alloues", &[("allocated", &format_go(ram))])),
            (),
        )
    });
    Some(view! { <section class="stat-tiles stat-tiles--launch" aria-label=t("home.dernier_lancement")>{duree}{memoire}</section> })
}

/// Temps de jeu : quatre tuiles compactes (total, semaine, parties, record).
fn tuiles_temps(etat: Etat, instance: &Instance) -> impl IntoView {
    let stats = instance.stats.clone().unwrap_or_default();
    let semaine: Vec<f64> = (0..7).map(|i| stats.days.get(&cle_du_jour(i - 6)).copied().unwrap_or(0.0)).collect();
    let total_semaine: f64 = semaine.iter().sum();
    let pic = semaine.iter().copied().fold(30.0, f64::max);
    let suivi: f64 = stats.days.values().sum();
    let hors_suivi = arrondi(instance.playtime - suivi).max(0.0);
    let (total, joueuses) =
        etat.instances.with(|l| (l.iter().map(|i| i.playtime).sum::<f64>(), l.iter().filter(|i| i.playtime > 0.0).count()));
    let part = if total > 0.0 { arrondi(instance.playtime / total * 100.0) } else { 0.0 };
    let seule = joueuses < 2;
    let titre = (hors_suivi > 0.0).then(|| {
        let cle = if instance.imported_from.is_some() { "home.untracked_imported" } else { "home.untracked" };
        tv(cle, &[("time", &format_temps_de_jeu(hors_suivi))])
    });
    let barres = semaine
        .iter()
        .enumerate()
        .map(|(i, &m)| {
            let classe = format!(
                "stat-tile__bar{}{}",
                if m > 0.0 { "" } else { " stat-tile__bar--empty" },
                if i == 6 { " stat-tile__bar--today" } else { "" }
            );
            view! { <span class=classe style=format!("height:{}%", arrondi(m / pic * 100.0).max(8.0))></span> }
        })
        .collect_view();
    let pied_parties = match stats.since {
        Some(ms) => tv("home.depuis_le", &[("value", &format_date(ms as f64, &[("day", "numeric"), ("month", "short")]))]),
        None if stats.sessions > 0 => t("home.au_total"),
        None => t("home.aucune_suivie"),
    };
    let pied_record = if stats.sessions > 0 {
        tv("home.average", &[("time", &format_court(suivi / stats.sessions as f64))])
    } else {
        t("home.pas_encore_de_moyenne")
    };
    view! {
        <section class="stat-tiles" aria-label=t("home.temps_de_jeu")>
            <div class="stat-tile" title=titre>
                <span class="stat-tile__label">{t("home.temps_de_jeu_au_total")}</span>
                <button class="stat-tile__link" title=t("home.voir_le_bilan_du_mois")>{t("common.bilan_du_mois")}</button>
                <span class="stat-tile__row">
                    <span class="stat-tile__value">{format_court(instance.playtime)}</span>
                    {(!seule).then(|| view! { <span class="stat-tile__share">{format!("{part} %")}</span> })}
                </span>
                {if seule {
                    note(t("home.sur_cette_instance")).into_any()
                } else {
                    view! {
                        <span class="stat-tile__meter" role="img" aria-label=tv("home.de_ton_temps_total", &[("share", &part.to_string())])>
                            <i style=format!("width:{part}%")></i>
                        </span>
                    }
                    .into_any()
                }}
            </div>
            {tuile(t("home.derniers_jours"), format_court(total_semaine), note(t("home.par_jour")), view! {
                <span class="stat-tile__bars" aria-hidden="true">{barres}</span>
            })}
            {tuile(
                if stats.sessions > 1 { t("home.parties") } else { t("home.partie") },
                stats.sessions.to_string(),
                note(pied_parties),
                (),
            )}
            {tuile(t("home.plus_longue_partie"), format_court(stats.longest), note(pied_record), ())}
        </section>
    }
}

#[component]
pub fn Accueil() -> impl IntoView {
    let etat = expect_context::<Etat>();
    move || {
        let Some(instance) = etat.instance_choisie() else {
            return view! {
                <div class="empty">
                    <h1 class="empty__title">{t("common.aucune_instance")}</h1>
                    <p class="empty__text">{t("home.une_instance_est_une_installation")}</p>
                    <button class="btn btn--primary btn--lg">{icone("plus")}{t("common.nouvelle_instance")}</button>
                </div>
            }
            .into_any();
        };
        let st = statut(&instance);
        // shortcut: la carte modpack arrive en R4.
        view! {
            <div>
                {hero(etat, &instance, &st)}
                <div class="home__content">
                    {bloc_instance(etat, &instance)}
                    {tuiles_lancement(&instance)}
                    {(instance.playtime > 0.0).then(|| tuiles_temps(etat, &instance))}
                </div>
            </div>
        }
        .into_any()
    }
}
