//! Pack Performances (mods Modrinth), comme la deuxième moitié de core/performance.js : état de chaque mod pour une
//! instance, installation un par un, nombre de mods du pack déjà présents, shaders actifs.

use crate::contenu::{Contenu, Corbeille, Installe, loaders_pour};
use crate::erreur::Resultat;
use crate::i18n::{t, tv};
use crate::modrinth::choisir_version;
use commun::Instance;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::Path;

/// Mod proposé : `ids` reconnaît un mod déjà présent (même sans Internet), `rivaux` les mods qui font le même
/// travail, `remplacant` le mod proposé quand celui-ci n'existe pas pour l'instance.
pub struct ModPack {
    pub slug: &'static str,
    pub titre: Option<&'static str>,
    pub cle_titre: Option<&'static str>,
    pub impact: &'static str,
    pub cle_quoi: &'static str,
    pub ids: &'static [&'static str],
    pub rivaux: &'static [&'static str],
    pub remplacant: Option<&'static str>,
    pub remplacant_seulement: bool,
    pub optionnel: bool,
}

const fn m(slug: &'static str, titre: &'static str, impact: &'static str, quoi: &'static str, ids: &'static [&'static str]) -> ModPack {
    ModPack { slug, titre: Some(titre), cle_titre: None, impact, cle_quoi: quoi, ids, rivaux: &[], remplacant: None, remplacant_seulement: false, optionnel: false }
}

pub const PACK: [ModPack; 10] = [
    ModPack {
        rivaux: &["embeddium", "rubidium", "optifine"],
        remplacant: Some("embeddium"),
        ..m("sodium", "Sodium", "fps", "performance.nouveau_moteur_de_rendu_du", &["sodium"])
    },
    ModPack {
        rivaux: &["sodium", "rubidium", "optifine"],
        remplacant_seulement: true,
        ..m("embeddium", "Embeddium", "fps", "performance.la_version_forge_de_sodium", &["embeddium"])
    },
    m("entityculling", "Entity Culling", "fps2", "performance.ne_dessine_pas_les_entites", &["entityculling"]),
    ModPack { rivaux: &["optifine"], ..m("moreculling", "More Culling", "fps2", "performance.ne_dessine_pas_les_faces", &["moreculling"]) },
    m("immediatelyfast", "ImmediatelyFast", "fps2", "performance.accelere_interface_les_textes_les", &["immediatelyfast"]),
    ModPack { rivaux: &["canary", "radium"], ..m("lithium", "Lithium", "tick", "performance.accelere_la_logique_du_monde", &["lithium"]) },
    m("ferrite-core", "FerriteCore", "ram", "performance.reduit_la_memoire_utilisee_donc", &["ferritecore"]),
    m("modernfix", "ModernFix", "start", "performance.demarrage_plus_rapide_et_moins", &["modernfix"]),
    m("dynamic-fps", "Dynamic FPS", "eco", "performance.baisse_les_fps_quand_la", &["dynamic_fps", "dynamicfps"]),
    ModPack { titre: None, cle_titre: Some("performance.c2me_avance"), optionnel: true, ..m("c2me-fabric", "", "tick", "performance.genere_les_chunks_sur_plusieurs", &["c2me"]) },
];

impl ModPack {
    pub fn titre(&self) -> String {
        self.titre.map(String::from).unwrap_or_else(|| t(self.cle_titre.unwrap_or("")))
    }
}

/// Une instance vanilla est montrée comme si elle passait en Fabric.
fn nom_loader(l: &str) -> &'static str {
    match l {
        "quilt" => "Quilt",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        _ => "Fabric",
    }
}

struct Present {
    mod_id: String,
    fichier: String,
    actif: bool,
}

fn chercher<'a>(installes: &'a [Present], ids: &[&str]) -> Option<&'a Present> {
    installes.iter().find(|m| ids.contains(&m.mod_id.as_str()) || (ids.contains(&"optifine") && m.fichier.contains("optifine")))
}

async fn installes(c: &Contenu, dossier_jeu: &Path, instance: &Instance) -> Resultat<Vec<Present>> {
    Ok(c.lister(dossier_jeu, "mods", instance, false)
        .await?
        .items
        .into_iter()
        .map(|i| Present { mod_id: i.mod_id.unwrap_or_default().to_lowercase(), fichier: i.file.to_lowercase(), actif: i.enabled })
        .collect())
}

fn loaders_pack(instance: &Instance) -> Vec<String> {
    if instance.loader == "vanilla" { vec!["fabric".into()] } else { loaders_pour("mods", instance) }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ligne {
    pub slug: &'static str,
    pub title: String,
    pub what: String,
    pub impact: &'static str,
    /// installed | available | unavailable | conflict
    pub state: &'static str,
    pub note: Option<String>,
    pub checked: bool,
    pub version: Option<String>,
}

/// État du pack pour une instance.
pub async fn etat(c: &Contenu, dossier_jeu: &Path, instance: &Instance) -> Resultat<Value> {
    let loaders = loaders_pack(instance);
    let presents = if instance.loader == "vanilla" { vec![] } else { installes(c, dossier_jeu, instance).await? };
    let modrinth = c.modrinth();
    let versions = futures_util::future::join_all(PACK.iter().map(|p| {
        let (m, l, v) = (&modrinth, &loaders, &instance.version);
        async move { m.versions(p.slug, l, Some(v)).await.ok().and_then(|l| choisir_version(&l).cloned()) }
    }))
    .await;
    let trouve = |slug: &str| PACK.iter().position(|p| p.slug == slug).and_then(|i| versions[i].clone());
    let mut lignes = vec![];
    for (p, v) in PACK.iter().zip(&versions) {
        // Embeddium n'apparaît qu'à la place de Sodium.
        if p.remplacant_seulement && (trouve("sodium").is_some() || v.is_none()) {
            continue;
        }
        if p.remplacant.is_some_and(|r| v.is_none() && trouve(r).is_some()) {
            continue;
        }
        let present = chercher(&presents, p.ids);
        let rival = (!p.rivaux.is_empty()).then(|| chercher(&presents, p.rivaux)).flatten();
        let (state, note) = if let Some(x) = present {
            ("installed", Some(t(if x.actif { "performance.deja_installe" } else { "performance.installe_mais_desactive" })))
        } else if let Some(r) = rival {
            let nom = if r.mod_id == "optifine" || r.fichier.contains("optifine") { "OptiFine".to_string() } else { r.mod_id.clone() };
            ("conflict", Some(tv("performance.fait_deja_ce_travail", &[("value", &nom)])))
        } else if v.is_none() {
            ("unavailable", Some(tv("performance.pas_de_version_pour", &[("LOADER_LABELS", nom_loader(&instance.loader)), ("version", &instance.version)])))
        } else {
            ("available", None)
        };
        lignes.push(Ligne {
            slug: p.slug,
            title: p.titre(),
            what: t(p.cle_quoi),
            impact: p.impact,
            state,
            note,
            checked: state == "available" && !p.optionnel,
            version: v.as_ref().map(|v| v.number.clone()),
        });
    }
    Ok(json!({ "loader": instance.loader, "version": instance.version, "mods": lignes }))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallationPack {
    pub installed: Vec<Installe>,
    pub failed: Vec<Value>,
}

/// Installe les mods choisis (avec leurs dépendances), un par un. Un échec n'arrête pas les suivants.
pub async fn installer(
    c: &Contenu,
    dossier_jeu: &Path,
    instance: &Instance,
    slugs: &[String],
    corbeille: Corbeille<'_>,
    progres: &(dyn Fn(usize, usize) + Send + Sync),
) -> InstallationPack {
    let choisis: Vec<&ModPack> = slugs.iter().filter_map(|s| PACK.iter().find(|p| p.slug == s)).collect();
    let mut faits = vec![];
    let mut echecs = vec![];
    for (i, p) in choisis.iter().enumerate() {
        progres(i, choisis.len());
        match c.installer(dossier_jeu, "mods", instance, p.slug, None, corbeille).await {
            // Le mod demandé est désigné par son slug : on lui donne son nom du pack.
            Ok(r) => faits.extend(r.installed.into_iter().map(|m| if m.dependency { m } else { Installe { title: p.titre(), ..m } })),
            Err(e) => echecs.push(json!({ "slug": p.slug, "title": p.titre(), "message": e.message })),
        }
    }
    progres(choisis.len(), choisis.len());
    InstallationPack { installed: faits, failed: echecs }
}

/// Nombre de mods du pack déjà présents et de mods actifs (carte des paramètres de l'instance).
pub async fn compte(c: &Contenu, dossier_jeu: &Path, instance: &Instance) -> Resultat<Value> {
    if instance.loader == "vanilla" {
        return Ok(json!({ "installed": 0, "mods": 0 }));
    }
    let l = installes(c, dossier_jeu, instance).await?;
    let n = PACK
        .iter()
        .filter(|p| !p.remplacant_seulement)
        .filter(|p| {
            let mut ids: Vec<&str> = p.ids.to_vec();
            if let Some(r) = p.remplacant.and_then(|r| PACK.iter().find(|x| x.slug == r)) {
                ids.extend(r.ids);
            }
            chercher(&l, &ids).is_some()
        })
        .count();
    Ok(json!({ "installed": n, "mods": l.iter().filter(|m| m.actif).count() }))
}

/// Shaders présents et actifs (une instance vanilla ne peut pas en charger).
pub async fn shaders_actifs(c: &Contenu, dossier_jeu: &Path, instance: &Instance) -> Resultat<usize> {
    if instance.loader == "vanilla" {
        return Ok(0);
    }
    Ok(c.lister(dossier_jeu, "shaders", instance, false).await?.items.iter().filter(|i| i.enabled).count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::base::Base;
    use crate::chemins::Dossiers;
    use crate::essai::Dossier;
    use crate::jeu::Jeu;
    use crate::net::Reseau;
    use crate::zip;
    use std::sync::Arc;

    #[tokio::test]
    async fn presents_et_rivaux_hors_ligne() {
        let d = Dossier::nouveau("pack-perf");
        let c = Contenu::new(Jeu::new(Dossiers::new(&d.0.join("r")), Arc::new(Reseau::new())), Arc::new(Base::ouvrir(&d.0.join("l.db"))));
        let jeu = d.0.join("jeu");
        std::fs::create_dir_all(jeu.join("mods")).unwrap();
        let jar = |id: &str| zip::creer_zip(&[("fabric.mod.json", format!(r#"{{"id":"{id}"}}"#).as_bytes())]);
        std::fs::write(jeu.join("mods/lithium.jar"), jar("lithium")).unwrap();
        std::fs::write(jeu.join("mods/embeddium.jar.disabled"), jar("embeddium")).unwrap();
        std::fs::write(jeu.join("mods/x.jar"), jar("x")).unwrap();
        let instance = Instance { loader: "fabric".into(), version: "1.21.11".into(), ..Default::default() };
        // Sodium absent, Embeddium (son remplaçant) présent : le pack le compte.
        assert_eq!(compte(&c, &jeu, &instance).await.unwrap(), json!({ "installed": 2, "mods": 2 }));
        assert_eq!(compte(&c, &jeu, &Instance { loader: "vanilla".into(), ..instance.clone() }).await.unwrap(), json!({ "installed": 0, "mods": 0 }));
        assert_eq!(PACK.iter().filter(|p| p.optionnel).count(), 1);
        assert!(!PACK[9].titre().is_empty());
    }
}
