//! Versions de Minecraft (manifeste officiel Mojang), comme core/versions.js.

use crate::erreur::{Erreur, Resultat};
use crate::fichiers::{ecrire_json, lire_json};
use crate::i18n::tv;
use crate::jeu::Jeu;
use crate::net::Options;
use crate::telechargement::Tache;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::PathBuf;
use std::sync::Arc;

const URL_MANIFESTE: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/// Types Mojang → noms du launcher.
pub fn genre(t: &str) -> &str {
    match t {
        "old_beta" => "beta",
        "old_alpha" => "alpha",
        autre => autre,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionListee {
    pub id: String,
    #[serde(rename = "type")]
    pub genre: String,
    pub release_time: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Liste {
    pub latest: Value,
    pub offline: bool,
    pub versions: Vec<VersionListee>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub id: String,
    #[serde(rename = "type")]
    pub genre: String,
    pub release_time: Option<String>,
    pub java: u64,
    pub java_component: String,
    pub installed: bool,
}

pub struct Fichiers {
    pub json: PathBuf,
    pub jar: PathBuf,
}

fn texte(v: &Value, cle: &str) -> Option<String> {
    v.get(cle).and_then(Value::as_str).map(String::from)
}

/// Fichier enfant (loader) posé sur son parent : l'enfant l'emporte, ses bibliothèques passent en premier,
/// les arguments du parent viennent avant les siens.
pub fn fusionner(parent: &Value, enfant: &Value) -> Value {
    let mut f: Map<String, Value> = parent.as_object().cloned().unwrap_or_default();
    for (k, v) in enfant.as_object().into_iter().flatten() {
        f.insert(k.clone(), v.clone());
    }
    // Le jar du jeu est rangé sous le nom de la version enfant (copie du jar vanilla), sauf si elle en désigne un.
    f.insert("jar".into(), enfant.get("jar").or_else(|| enfant.get("id")).cloned().unwrap_or(Value::Null));
    let liste = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_array).cloned().unwrap_or_default();
    f.insert("libraries".into(), Value::Array([liste(enfant, "/libraries"), liste(parent, "/libraries")].concat()));
    if parent.get("arguments").is_some() || enfant.get("arguments").is_some() {
        let game = [liste(parent, "/arguments/game"), liste(enfant, "/arguments/game")].concat();
        let jvm = [liste(parent, "/arguments/jvm"), liste(enfant, "/arguments/jvm")].concat();
        f.insert("arguments".into(), json!({ "game": game, "jvm": jvm }));
    }
    f.remove("inheritsFrom");
    Value::Object(f)
}

impl Jeu {
    pub fn fichiers_version(&self, id: &str) -> Fichiers {
        let d = self.dossiers.versions.join(id);
        Fichiers { json: d.join(format!("{id}.json")), jar: d.join(format!("{id}.jar")) }
    }

    pub fn version_installee(&self, id: &str) -> bool {
        let f = self.fichiers_version(id);
        f.json.is_file() && f.jar.is_file()
    }

    /// Manifeste des versions, gardé sur le disque pour fonctionner hors connexion (champ « offline »).
    pub async fn manifeste(&self, rafraichir: bool) -> Resultat<Arc<Value>> {
        if !rafraichir && let Some(m) = self.manifeste.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return Ok(m);
        }
        let cache = self.dossiers.cache.join("version_manifest_v2.json");
        let (mut donnees, hors_ligne) = match self.reseau().json::<Value>(URL_MANIFESTE, &Options::default()).await {
            Ok(d) => {
                let _ = ecrire_json(&cache, &d);
                (d, false)
            }
            Err(e) => match lire_json::<Value>(&cache) {
                Some(d) => (d, true),
                None => return Err(Erreur::new(tv("versions.impossible_de_recuperer_la_liste", &[("message", &e.message)]))),
            },
        };
        if let Some(o) = donnees.as_object_mut() {
            o.insert("offline".into(), hors_ligne.into());
        }
        let m = Arc::new(donnees);
        *self.manifeste.lock().unwrap_or_else(|e| e.into_inner()) = Some(m.clone());
        Ok(m)
    }

    pub async fn lister_versions(&self) -> Resultat<Liste> {
        let m = self.manifeste(false).await?;
        let connues: Vec<&Value> = m.get("versions").and_then(Value::as_array).into_iter().flatten().collect();
        let mut versions: Vec<VersionListee> = connues
            .iter()
            .map(|v| {
                let id = texte(v, "id").unwrap_or_default();
                VersionListee {
                    installed: self.version_installee(&id),
                    genre: genre(v.get("type").and_then(Value::as_str).unwrap_or("")).into(),
                    release_time: texte(v, "releaseTime"),
                    id,
                }
            })
            .collect();
        // Versions présentes sur le disque mais absentes du manifeste. Les loaders (inheritsFrom) se choisissent
        // dans l'instance, pas dans cette liste.
        if let Ok(it) = std::fs::read_dir(&self.dossiers.versions) {
            for e in it.flatten() {
                let id = e.file_name().to_string_lossy().into_owned();
                if connues.iter().any(|v| v.get("id").and_then(Value::as_str) == Some(&id)) {
                    continue;
                }
                if let Some(j) = lire_json::<Value>(&self.fichiers_version(&id).json).filter(|j| j.get("inheritsFrom").is_none()) {
                    let genre = j.get("type").and_then(Value::as_str).map(genre).unwrap_or("custom").into();
                    versions.push(VersionListee { id, genre, release_time: texte(&j, "releaseTime"), installed: true });
                }
            }
        }
        Ok(Liste {
            latest: m.get("latest").cloned().unwrap_or(Value::Null),
            offline: m.get("offline") == Some(&Value::Bool(true)),
            versions,
        })
    }

    /// Fichier d'une seule version (vérifié par SHA-1 s'il est au manifeste), sans héritage.
    async fn version_seule(&self, id: &str) -> Resultat<Value> {
        let f = self.fichiers_version(id);
        // Hors connexion sans cache : on tente le fichier local.
        let entree = match self.manifeste(false).await {
            Ok(m) => m
                .get("versions")
                .and_then(Value::as_array)
                .and_then(|l| l.iter().find(|v| v.get("id").and_then(Value::as_str) == Some(id)).cloned()),
            Err(_) => None,
        };
        if let Some(e) = entree {
            let t =
                Tache { url: texte(&e, "url").unwrap_or_default(), chemin: f.json.clone(), sha1: texte(&e, "sha1"), ..Default::default() };
            if let Err(err) = self.telechargeur.fichier(t, false, None, None).await
                && !f.json.is_file()
            {
                return Err(Erreur::new(tv("versions.impossible_de_telecharger_la_version", &[("id", id), ("message", &err.message)])));
            }
        }
        lire_json(&f.json).ok_or_else(|| Erreur::new(tv("versions.la_version_est_introuvable", &[("id", id)])))
    }

    /// Fichier de version complet, avec l'héritage « inheritsFrom » des loaders de mods.
    pub async fn version_json(&self, id: &str) -> Resultat<Value> {
        let mut enfants = vec![];
        let mut courant = id.to_string();
        loop {
            let json = self.version_seule(&courant).await?;
            match texte(&json, "inheritsFrom") {
                // Une boucle d'héritage ne doit pas tourner sans fin.
                Some(parent) if enfants.len() < 8 => {
                    enfants.push(json);
                    courant = parent;
                }
                _ => return Ok(enfants.iter().rev().fold(json, |v, enfant| fusionner(&v, enfant))),
            }
        }
    }

    pub async fn details_version(&self, id: &str) -> Resultat<Details> {
        let j = self.version_json(id).await?;
        Ok(Details {
            id: id.into(),
            genre: genre(j.get("type").and_then(Value::as_str).unwrap_or("")).into(),
            release_time: texte(&j, "releaseTime"),
            java: j.pointer("/javaVersion/majorVersion").and_then(Value::as_u64).unwrap_or(8),
            java_component: j.pointer("/javaVersion/component").and_then(Value::as_str).unwrap_or("jre-legacy").into(),
            installed: self.version_installee(id),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chemins::Dossiers;
    use crate::essai::Dossier;
    use crate::essai_http::{Corps, Reponse, servir};
    use crate::net::Reseau;

    fn vanilla() -> Value {
        json!({
            "id": "1.21.1", "type": "release", "mainClass": "net.minecraft.client.main.Main",
            "javaVersion": { "majorVersion": 21 },
            "libraries": [{ "name": "com.mojang:brigadier:1.3.10" }],
            "arguments": { "game": ["--username", "${auth_player_name}"], "jvm": ["-cp", "${classpath}"] },
            "downloads": { "client": { "url": "https://exemple/client.jar" } },
        })
    }

    fn fabric() -> Value {
        json!({
            "id": "fabric-loader-0.17.2-1.21.1", "inheritsFrom": "1.21.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries": [{ "name": "net.fabricmc:fabric-loader:0.17.2" }],
            "arguments": { "game": [], "jvm": ["-DFabricMcEmu= net.minecraft.client.main.Main "] },
        })
    }

    fn noms(v: &Value) -> Vec<&str> {
        v["libraries"].as_array().unwrap().iter().map(|l| l["name"].as_str().unwrap()).collect()
    }

    #[test]
    fn l_enfant_l_emporte() {
        let f = fusionner(&vanilla(), &fabric());
        assert_eq!(f["id"], fabric()["id"]);
        assert_eq!(f["mainClass"], fabric()["mainClass"]);
        assert_eq!(f["javaVersion"]["majorVersion"], 21);
        assert_eq!(f["downloads"], vanilla()["downloads"]);
        assert_eq!(noms(&f), ["net.fabricmc:fabric-loader:0.17.2", "com.mojang:brigadier:1.3.10"]);
        assert!(f.get("inheritsFrom").is_none());
        assert_eq!(f["arguments"]["game"], json!(["--username", "${auth_player_name}"]));
        assert_eq!(f["arguments"]["jvm"], json!(["-cp", "${classpath}", "-DFabricMcEmu= net.minecraft.client.main.Main "]));
    }

    #[test]
    fn nom_du_jar() {
        assert_eq!(fusionner(&vanilla(), &fabric())["jar"], fabric()["id"]);
        let mut avec_jar = fabric();
        avec_jar["jar"] = "1.21.1".into();
        assert_eq!(fusionner(&vanilla(), &avec_jar)["jar"], "1.21.1");
    }

    #[test]
    fn format_ancien_sans_tableau_d_arguments() {
        let parent = json!({ "id": "1.12.2", "minecraftArguments": "--username ${auth_player_name}", "libraries": [{ "name": "a:b:1" }] });
        let enfant = json!({ "id": "1.12.2-forge", "inheritsFrom": "1.12.2", "minecraftArguments": "--tweakClass x", "libraries": [{ "name": "c:d:2" }] });
        let f = fusionner(&parent, &enfant);
        assert!(f.get("arguments").is_none());
        assert_eq!(f["minecraftArguments"], "--tweakClass x");
        assert_eq!(noms(&f), ["c:d:2", "a:b:1"]);
    }

    #[tokio::test]
    async fn heritage_telechargement_et_hors_connexion() {
        let d = Dossier::nouveau("versions");
        let corps = serde_json::to_vec(&vanilla()).unwrap();
        let sha1 = crate::telechargement::sha1(&corps);
        let serveur = servir(move |_, _| Reponse { corps: Corps::Entier(corps.clone()), ..Reponse::simple(200, "") }).await;
        let reseau = Arc::new(Reseau::new());
        reseau.pour_essais(&["127.0.0.1"], 1);
        let jeu = Jeu::new(Dossiers::new(&d.0), reseau);
        let manifeste = json!({ "latest": { "release": "1.21.1" }, "offline": false, "versions": [
            { "id": "1.21.1", "type": "release", "url": format!("{}/1.21.1.json", serveur.base), "sha1": sha1, "releaseTime": "2024-08-08" },
            { "id": "b1.7.3", "type": "old_beta", "url": "https://exemple/b.json", "sha1": "0" },
        ]});
        *jeu.manifeste.lock().unwrap() = Some(Arc::new(manifeste));
        d.ecrire("versions/fabric-loader-0.17.2-1.21.1/fabric-loader-0.17.2-1.21.1.json", &fabric().to_string());
        d.ecrire("versions/perso/perso.json", r#"{ "id": "perso", "releaseTime": "2020" }"#);

        let v = jeu.version_json("fabric-loader-0.17.2-1.21.1").await.unwrap();
        assert_eq!(v["mainClass"], fabric()["mainClass"]);
        assert!(jeu.fichiers_version("1.21.1").json.is_file());
        let det = jeu.details_version("1.21.1").await.unwrap();
        assert_eq!((det.java, det.java_component.as_str(), det.installed), (21, "jre-legacy", false));

        let liste = jeu.lister_versions().await.unwrap();
        let resume: Vec<(&str, &str, bool)> = liste.versions.iter().map(|v| (v.id.as_str(), v.genre.as_str(), v.installed)).collect();
        assert_eq!(resume, [("1.21.1", "release", false), ("b1.7.3", "beta", false), ("perso", "custom", true)]);

        // Fichier déjà là et juste : pas de nouveau téléchargement.
        assert_eq!(jeu.version_json("1.21.1").await.unwrap()["id"], "1.21.1");
        assert_eq!(serveur.nombre(), 1);
        let erreur = jeu.version_json("absente").await.unwrap_err();
        assert!(erreur.message.contains("absente"), "{}", erreur.message);
    }
}
