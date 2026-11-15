//! Ensembles de mods d'une instance : des groupes de mods actifs, sans rien désinstaller, comme core/mod-sets.js.
//! Un mod est repéré par un identifiant stable (id du mod lu dans le jar, sinon nom de fichier sans « .disabled »).

use crate::contenu::{Contenu, Element};
use crate::erreur::{Erreur, Resultat};
use crate::gestion_instances::enregistrer_ensembles;
use crate::i18n::{t, tv};
use commun::Instance;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;

const ENSEMBLES_MAX: usize = 20;

/// Identifiant stable d'un mod listé.
pub fn id_stable(e: &Element) -> String {
    match e.mod_id.as_deref().filter(|m| !m.is_empty()) {
        Some(m) => format!("m:{}", m.to_lowercase()),
        None => format!("f:{}", e.file.strip_suffix(".disabled").unwrap_or(&e.file).to_lowercase()),
    }
}

fn exiger_loader(instance: &Instance) -> Resultat<()> {
    if instance.loader == "vanilla" {
        return Err(Erreur::new(t("mod_sets.les_ensembles_de_mods_demandent")));
    }
    Ok(())
}

async fn mods(c: &Contenu, dossier_jeu: &Path, instance: &Instance) -> Resultat<Vec<Element>> {
    Ok(c.lister(dossier_jeu, "mods", instance, false).await?.items.into_iter().filter(|i| !i.is_folder).collect())
}

fn nom_propre(v: &str) -> String {
    v.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(30).collect()
}

fn nom_unique(ensembles: &[Value], nom: &str, sauf: Option<&str>) -> Resultat<String> {
    let propre = nom_propre(nom);
    if propre.is_empty() {
        return Err(Erreur::new(t("mod_sets.donne_un_nom_ton_ensemble")));
    }
    let pris =
        ensembles.iter().any(|s| s["id"].as_str() != sauf && s["name"].as_str().is_some_and(|n| n.to_lowercase() == propre.to_lowercase()));
    if pris {
        return Err(Erreur::new(t("mod_sets.un_ensemble_porte_deja_ce")));
    }
    Ok(propre)
}

fn introuvable() -> Erreur {
    Erreur::new(t("mod_sets.ensemble_introuvable"))
}

/// Crée un ensemble avec les mods actifs du moment, et l'active.
pub async fn creer(c: &Contenu, racine: &Path, instance: &Instance, dossier_jeu: &Path, nom: &str) -> Resultat<Value> {
    exiger_loader(instance)?;
    let ensembles = &instance.mod_sets;
    if ensembles.len() >= ENSEMBLES_MAX {
        return Err(Erreur::new(tv("mod_sets.ensembles_au_maximum", &[("MAX_SETS", &ENSEMBLES_MAX.to_string())])));
    }
    let propre = nom_unique(ensembles, nom, None)?;
    let mut ids: Vec<String> = vec![];
    for e in mods(c, dossier_jeu, instance).await?.iter().filter(|e| e.enabled) {
        let id = id_stable(e);
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let id: String = crate::coffre::aleatoire::<4>().iter().map(|b| format!("{b:02x}")).collect();
    let ensemble = json!({ "id": id, "name": propre, "mods": ids });
    let mut l = ensembles.clone();
    l.push(ensemble.clone());
    enregistrer_ensembles(racine, &instance.id, &Value::Array(l), &json!(id))?;
    Ok(ensemble)
}

pub fn renommer(racine: &Path, instance: &Instance, id: &str, nom: &str) -> Resultat<()> {
    let l = &instance.mod_sets;
    if !l.iter().any(|s| s["id"] == id) {
        return Err(introuvable());
    }
    let propre = nom_unique(l, nom, Some(id))?;
    let suite: Vec<Value> =
        l.iter().map(|s| if s["id"] == id { json!({ "id": id, "name": propre, "mods": s["mods"] }) } else { s.clone() }).collect();
    enregistrer_ensembles(racine, &instance.id, &Value::Array(suite), &json!(instance.active_mod_set))
}

/// Supprime l'ensemble seulement : aucun mod n'est touché.
pub fn supprimer(racine: &Path, instance: &Instance, id: &str) -> Resultat<()> {
    let l = &instance.mod_sets;
    if !l.iter().any(|s| s["id"] == id) {
        return Err(introuvable());
    }
    let suite: Vec<Value> = l.iter().filter(|s| s["id"] != id).cloned().collect();
    let actif = instance.active_mod_set.as_deref().filter(|a| *a != id);
    enregistrer_ensembles(racine, &instance.id, &Value::Array(suite), &json!(actif))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Application {
    pub changed: usize,
    pub failed: Vec<Value>,
}

/// Active un ensemble (ses mods activés, les autres désactivés) ou, sans identifiant, tous les mods. Si des fichiers
/// résistent, l'ensemble n'est plus considéré comme actif et les échecs sont renvoyés.
pub async fn appliquer(c: &Contenu, racine: &Path, instance: &Instance, dossier_jeu: &Path, id: Option<&str>) -> Resultat<Application> {
    exiger_loader(instance)?;
    let ensemble = match id {
        Some(i) => Some(instance.mod_sets.iter().find(|s| s["id"] == i).ok_or_else(introuvable)?),
        None => None,
    };
    let voulus: Option<HashSet<String>> =
        ensemble.map(|s| s["mods"].as_array().into_iter().flatten().filter_map(Value::as_str).map(String::from).collect());
    let mut echecs = vec![];
    let mut changes = 0;
    for e in mods(c, dossier_jeu, instance).await? {
        let actif = voulus.as_ref().is_none_or(|v| v.contains(&id_stable(&e)));
        if e.enabled == actif {
            continue;
        }
        match c.basculer(dossier_jeu, "mods", &e.file) {
            Ok(()) => changes += 1,
            Err(err) => echecs.push(json!({ "file": e.file, "message": err.message })),
        }
    }
    let actif = if echecs.is_empty() { id } else { None };
    enregistrer_ensembles(racine, &instance.id, &Value::Array(instance.mod_sets.clone()), &json!(actif))?;
    Ok(Application { changed: changes, failed: echecs })
}

/// Après un changement du dossier des mods : l'ensemble actif reprend les mods actifs, et les mods supprimés sortent
/// de tous les ensembles.
pub async fn synchroniser(c: &Contenu, racine: &Path, instance: &Instance, dossier_jeu: &Path) -> Resultat<()> {
    if instance.mod_sets.is_empty() {
        return Ok(());
    }
    let tous = mods(c, dossier_jeu, instance).await?;
    let presents: HashSet<String> = tous.iter().map(id_stable).collect();
    let mut actifs: Vec<String> = vec![];
    for e in tous.iter().filter(|e| e.enabled) {
        let id = id_stable(e);
        if !actifs.contains(&id) {
            actifs.push(id);
        }
    }
    let suite: Vec<Value> = instance
        .mod_sets
        .iter()
        .map(|s| {
            let mods: Vec<Value> = if s["id"].as_str() == instance.active_mod_set.as_deref() {
                actifs.iter().map(|m| json!(m)).collect()
            } else {
                s["mods"].as_array().into_iter().flatten().filter(|m| m.as_str().is_some_and(|m| presents.contains(m))).cloned().collect()
            };
            json!({ "id": s["id"], "name": s["name"], "mods": mods })
        })
        .collect();
    if suite != instance.mod_sets {
        enregistrer_ensembles(racine, &instance.id, &Value::Array(suite), &json!(instance.active_mod_set))?;
    }
    Ok(())
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

    fn jar(id: &str) -> Vec<u8> {
        zip::creer_zip(&[("fabric.mod.json", format!(r#"{{"id":"{id}"}}"#).as_bytes())])
    }

    #[tokio::test]
    async fn creer_appliquer_synchroniser() {
        let d = Dossier::nouveau("ensembles");
        let racine = d.0.join("racine");
        let c = Contenu::new(Jeu::new(Dossiers::new(&racine), Arc::new(Reseau::new())), Arc::new(Base::ouvrir(&d.0.join("l.db"))));
        crate::gestion_instances::creer(
            &racine,
            &json!({ "name": "Mods", "version": "1.21.11", "loader": "fabric", "loaderVersion": "0.17.2" }),
            &Default::default(),
        )
        .unwrap();
        let jeu = racine.join("instances/mods/minecraft");
        std::fs::create_dir_all(jeu.join("mods")).unwrap();
        for (n, id) in [("sodium.jar", "sodium"), ("iris.jar", "iris"), ("x.jar.disabled", "x")] {
            std::fs::write(jeu.join("mods").join(n), jar(id)).unwrap();
        }
        let lire = || crate::instances::lire(&racine, "mods").unwrap();
        let s = creer(&c, &racine, &lire(), &jeu, "  PvP ").await.unwrap();
        assert_eq!(s["mods"], json!(["m:iris", "m:sodium"]));
        assert!(creer(&c, &racine, &lire(), &jeu, "pvp").await.is_err());
        assert_eq!(lire().active_mod_set.as_deref(), s["id"].as_str());

        // Tous les mods, puis l'ensemble : x est désactivé, iris et sodium actifs.
        let r = appliquer(&c, &racine, &lire(), &jeu, None).await.unwrap();
        assert_eq!((r.changed, lire().active_mod_set), (1, None));
        appliquer(&c, &racine, &lire(), &jeu, s["id"].as_str()).await.unwrap();
        assert!(jeu.join("mods/x.jar.disabled").is_file());

        // Iris supprimé et x activé : l'ensemble actif suit.
        std::fs::remove_file(jeu.join("mods/iris.jar")).unwrap();
        c.basculer(&jeu, "mods", "x.jar.disabled").unwrap();
        synchroniser(&c, &racine, &lire(), &jeu).await.unwrap();
        assert_eq!(lire().mod_sets[0]["mods"], json!(["m:sodium", "m:x"]));
        renommer(&racine, &lire(), s["id"].as_str().unwrap(), "Solo").unwrap();
        assert_eq!(lire().mod_sets[0]["name"], "Solo");
        supprimer(&racine, &lire(), s["id"].as_str().unwrap()).unwrap();
        assert!(lire().mod_sets.is_empty());
    }
}
