//! Instances : un dossier par instance (instance.json + dossier du jeu « minecraft »), comme core/instances.js.

use crate::fichiers::lire_json;
use commun::{Instance, LOADERS};
use serde::Deserialize;
use serde_json::{Value, json};
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
    let mut brut: serde_json::Value = lire_json(&dossier.join("instance.json"))?;
    // Réglages vérifiés un par un (une valeur fausse ne fait pas disparaître l'instance).
    let reglages = crate::reglages::nettoyer_instance(&brut["settings"], &commun::Reglages::default());
    brut["settings"] = serde_json::to_value(reglages).ok()?;
    let sup: Supplement = serde_json::from_value(brut.clone()).ok()?;
    let mut instance: Instance = serde_json::from_value(brut).ok()?;
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
    instance.java_major = lire_json::<VersionJava>(&racine.join("versions").join(v).join(format!("{v}.json")))
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

pub fn dossier(racine: &Path, id: &str) -> std::path::PathBuf {
    racine.join("instances").join(id)
}

/// Modifie instance.json en gardant les champs que ce code ne connaît pas. Sans effet si l'instance n'existe plus.
fn modifier(racine: &Path, id: &str, f: impl FnOnce(&mut serde_json::Map<String, Value>)) -> std::io::Result<()> {
    if !id_valide(id) {
        return Ok(());
    }
    let fichier = dossier(racine, id).join("instance.json");
    let Some(Value::Object(mut m)) = lire_json::<Value>(&fichier) else { return Ok(()) };
    f(&mut m);
    crate::fichiers::ecrire_json(&fichier, &m)
}

/// Le loader de mods de l'instance est installé sous cette version.
pub fn marquer_loader_installe(racine: &Path, id: &str, version_id: &str) -> std::io::Result<()> {
    modifier(racine, id, |m| {
        let v = json!({ "loader": m.get("loader"), "loaderVersion": m.get("loaderVersion"), "versionId": version_id });
        m.insert("loaderInstalled".into(), v);
    })
}

/// Partie finie : temps de jeu, dernière partie et statistiques par jour (un peu plus d'un an gardé).
pub fn noter_partie(racine: &Path, id: &str, minutes: u64, fin_ms: i64) -> std::io::Result<()> {
    modifier(racine, id, |m| {
        let jeu = m.get("playtime").and_then(Value::as_f64).unwrap_or(0.0) + minutes as f64;
        m.insert("playtime".into(), json!(jeu));
        m.insert("lastPlayedAt".into(), json!(fin_ms));
        if minutes == 0 {
            return;
        }
        let debut = fin_ms - minutes as i64 * 60_000;
        let mut stats = json!({ "days": {}, "sessions": 0, "longest": 0, "since": debut });
        if let Some(Value::Object(anciennes)) = m.get("stats") {
            for (k, v) in anciennes {
                stats[k] = v.clone();
            }
        }
        let mut curseur = debut;
        while curseur < fin_ms {
            let jour = chrono::DateTime::from_timestamp_millis(curseur).unwrap_or_default().with_timezone(&chrono::Local);
            let minuit = (jour.date_naive() + chrono::Days::new(1)).and_hms_opt(0, 0, 0).unwrap_or_default();
            let lendemain = minuit.and_local_timezone(chrono::Local).earliest().map_or(fin_ms, |t| t.timestamp_millis());
            let tranche = fin_ms.min(lendemain) - curseur;
            let cle = jour.format("%Y-%m-%d").to_string();
            let avant = stats["days"].get(&cle).and_then(Value::as_f64).unwrap_or(0.0);
            stats["days"][&cle] = json!(((avant + tranche as f64 / 60_000.0) * 10.0).round() / 10.0);
            curseur += tranche.max(1);
        }
        if let Some(jours) = stats["days"].as_object_mut() {
            let mut cles: Vec<String> = jours.keys().cloned().collect();
            cles.sort();
            for k in &cles[..cles.len().saturating_sub(400)] {
                jours.remove(k);
            }
        }
        stats["sessions"] = json!(stats["sessions"].as_u64().unwrap_or(0) + 1);
        stats["longest"] = json!(stats["longest"].as_f64().unwrap_or(0.0).max(minutes as f64));
        m.insert("stats".into(), stats);
    })
}

/// Monde ou serveur rejoint pendant la partie (liste « Reprendre », 5 au plus, le plus récent d'abord).
pub fn noter_quick_play(racine: &Path, id: &str, genre: &str, cible: &str, nom: &str, quand: i64) -> std::io::Result<()> {
    if (genre != "singleplayer" && genre != "multiplayer") || cible.is_empty() || cible.chars().count() > 260 {
        return Ok(());
    }
    modifier(racine, id, |m| {
        let nom: String = if nom.is_empty() { cible.into() } else { nom.chars().take(100).collect() };
        let mut liste = vec![json!({ "type": genre, "id": cible, "name": nom, "at": quand })];
        for r in m.get("recent").and_then(Value::as_array).into_iter().flatten() {
            let (g, c) = (r.get("type").and_then(Value::as_str), r.get("id").and_then(Value::as_str));
            if matches!(g, Some("singleplayer" | "multiplayer"))
                && c.is_some_and(|c| !c.is_empty())
                && (g != Some(genre) || c != Some(cible))
            {
                liste.push(r.clone());
            }
        }
        liste.truncate(5);
        m.insert("recent".into(), Value::Array(liste));
    })
}

#[cfg(test)]
mod tests {
    use crate::essai::Dossier;
    use serde_json::Value;

    #[test]
    fn parties_et_mondes_rejoints() {
        let d = Dossier::nouveau("instances-parties");
        d.ecrire(
            "instances/survie/instance.json",
            r#"{"id":"survie","name":"S","version":"1.21.11","loader":"fabric","loaderVersion":"0.19.5","perso":1}"#,
        );
        super::marquer_loader_installe(&d.0, "survie", "fabric-loader-0.19.5-1.21.11").unwrap();
        let midi =
            chrono::Local::now().date_naive().and_hms_opt(12, 0, 0).unwrap().and_local_timezone(chrono::Local).unwrap().timestamp_millis();
        super::noter_partie(&d.0, "survie", 30, midi).unwrap();
        super::noter_partie(&d.0, "survie", 0, midi + 1).unwrap();
        for n in 0..6 {
            super::noter_quick_play(&d.0, "survie", "singleplayer", &format!("Monde {n}"), "", n).unwrap();
        }
        super::noter_quick_play(&d.0, "survie", "singleplayer", "Monde 2", "Mon monde", 9).unwrap();
        super::noter_quick_play(&d.0, "survie", "realms", "x", "", 9).unwrap();
        super::noter_partie(&d.0, "absente", 5, midi).unwrap();

        let v: Value = crate::fichiers::lire_json(&d.0.join("instances/survie/instance.json")).unwrap();
        assert_eq!(v["perso"], 1);
        assert_eq!(v["loaderInstalled"]["versionId"], "fabric-loader-0.19.5-1.21.11");
        assert_eq!(v["loaderInstalled"]["loaderVersion"], "0.19.5");
        assert_eq!((v["playtime"].as_f64(), v["lastPlayedAt"].as_i64()), (Some(30.0), Some(midi + 1)));
        let jour = chrono::Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(
            (v["stats"]["days"][&jour].as_f64(), v["stats"]["sessions"].as_u64(), v["stats"]["longest"].as_f64()),
            (Some(30.0), Some(1), Some(30.0))
        );
        let recents: Vec<&str> = v["recent"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(recents, ["Monde 2", "Monde 5", "Monde 4", "Monde 3", "Monde 1"]);
        assert_eq!(v["recent"][0]["name"], "Mon monde");
    }

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
