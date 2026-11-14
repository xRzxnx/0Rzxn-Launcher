//! Instances : un dossier par instance (instance.json + dossier du jeu « minecraft »), comme core/instances.js.

use commun::{Instance, LOADERS};
use serde::Deserialize;
use std::path::Path;

fn id_valide(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Fichiers d'une version installée : versions/<id>/<id>.json et .jar.
fn version_installee(racine: &Path, id: &str) -> bool {
    let d = racine.join("versions").join(id);
    d.join(format!("{id}.json")).is_file() && d.join(format!("{id}.jar")).is_file()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoaderInstalle {
    loader: Option<String>,
    loader_version: Option<String>,
    version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Supplement {
    loader_installed: Option<LoaderInstalle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionJava {
    java_version: Option<JavaVersion>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JavaVersion {
    major_version: u32,
}

pub fn lire(racine: &Path, id: &str) -> Option<Instance> {
    if !id_valide(id) {
        return None;
    }
    let dossier = racine.join("instances").join(id);
    let fichier = dossier.join("instance.json");
    let mut instance: Instance = crate::lire_json(&fichier)?;
    let sup: Supplement = crate::lire_json(&fichier)?;
    if !LOADERS.contains(&instance.loader.as_str()) {
        instance.loader = "vanilla".into();
    }
    let vanilla = instance.loader == "vanilla";
    if vanilla {
        instance.loader_version = None;
    }
    let loader_pret = vanilla
        || sup.loader_installed.is_some_and(|l| {
            l.loader.as_deref() == Some(instance.loader.as_str())
                && l.loader_version == instance.loader_version
                && racine.join("versions").join(&l.version_id).join(format!("{}.json", l.version_id)).is_file()
        });
    instance.installed = version_installee(racine, &instance.version) && loader_pret;
    let v = &instance.version;
    instance.java_major = crate::lire_json::<VersionJava>(&racine.join("versions").join(v).join(format!("{v}.json")))
        .and_then(|j| j.java_version)
        .map(|j| j.major_version);
    instance.mods_actifs = (!vanilla).then(|| compter_jars(&dossier.join("minecraft").join("mods")));
    Some(instance)
}

fn compter_jars(dossier: &Path) -> u32 {
    std::fs::read_dir(dossier)
        .map(|it| it.flatten().filter(|e| e.file_name().to_string_lossy().to_ascii_lowercase().ends_with(".jar")).count() as u32)
        .unwrap_or(0)
}

/// Toutes les instances lisibles, dernière partie (ou création) d'abord.
pub fn lister(racine: &Path) -> Vec<Instance> {
    let Ok(it) = std::fs::read_dir(racine.join("instances")) else { return vec![] };
    let mut liste: Vec<Instance> = it
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| lire(racine, &e.file_name().to_string_lossy()))
        .collect();
    liste.sort_by_key(|i| std::cmp::Reverse(i.last_played_at.or(i.created_at).unwrap_or(0)));
    liste
}

#[cfg(test)]
mod tests {
    use crate::essai::Dossier;

    #[test]
    fn installee_seulement_avec_version_et_loader() {
        let d = Dossier::nouveau("instances");
        d.ecrire("instances/vanille/instance.json", r#"{"id":"vanille","name":"V","version":"1.21.11","createdAt":1}"#);
        d.ecrire(
            "instances/fab/instance.json",
            r#"{"id":"fab","name":"F","version":"1.21.11","loader":"fabric","loaderVersion":"0.19.5","lastPlayedAt":5,
                "loaderInstalled":{"loader":"fabric","loaderVersion":"0.19.5","versionId":"fabric-1.21.11"}}"#,
        );
        d.ecrire("instances/fab/minecraft/mods/a.jar", "");
        d.ecrire("instances/fab/minecraft/mods/b.jar.disabled", "");
        d.ecrire("instances/Mauvais/instance.json", r#"{"id":"x","name":"X","version":"1"}"#);
        d.ecrire("versions/1.21.11/1.21.11.json", r#"{"javaVersion":{"majorVersion":21}}"#);
        d.ecrire("versions/1.21.11/1.21.11.jar", "");

        let l = super::lister(&d.0);
        assert_eq!(l.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["fab", "vanille"]);
        assert!(!l[0].installed, "le loader n'a pas son fichier de version");
        assert_eq!((l[0].mods_actifs, l[1].installed, l[1].java_major, l[1].mods_actifs), (Some(1), true, Some(21), None));

        d.ecrire("versions/fabric-1.21.11/fabric-1.21.11.json", "{}");
        assert!(super::lire(&d.0, "fab").unwrap().installed);
    }
}
