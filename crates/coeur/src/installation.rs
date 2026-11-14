//! Fichiers du jeu : jar client, bibliothèques, natives, assets et configuration des logs, comme core/install.js.

use crate::erreur::{Erreur, Resultat};
use crate::fichiers::lire_json;
use crate::i18n::tv;
use crate::jeu::Jeu;
use crate::regles::{Systeme, autorise, chemin_maven, maven, natives_de_ce_processeur};
use crate::telechargement::Tache;
use crate::zip;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const URL_BIBLIOTHEQUES: &str = "https://libraries.minecraft.net/";
const URL_RESSOURCES: &str = "https://resources.download.minecraft.net/";

/// `base` + chemin relatif écrit avec des « / » (Maven, index des assets), avec les séparateurs du système.
pub fn sous(base: &Path, relatif: &str) -> PathBuf {
    relatif.split('/').filter(|s| !s.is_empty()).fold(base.to_path_buf(), |p, s| p.join(s))
}

fn texte<'a>(v: &'a Value, p: &str) -> Option<&'a str> {
    v.pointer(p).and_then(Value::as_str)
}

fn tache(v: Option<&Value>, url: String, chemin: PathBuf) -> Tache {
    Tache {
        url,
        chemin,
        sha1: v.and_then(|v| texte(v, "/sha1")).map(String::from),
        taille: v.and_then(|v| v.pointer("/size")).and_then(Value::as_u64),
        ..Default::default()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Native {
    pub fichier: PathBuf,
    pub exclure: Vec<String>,
}

#[derive(Debug, Default)]
pub struct Bibliotheques {
    pub classpath: Vec<PathBuf>,
    pub natives: Vec<Native>,
    pub taches: Vec<Tache>,
}

fn base_url(lib: &Value) -> String {
    let url = texte(lib, "/url").unwrap_or(URL_BIBLIOTHEQUES);
    if url.ends_with('/') { url.into() } else { format!("{url}/") }
}

/// Bibliothèques autorisées sur ce système : classpath, jars de natives et fichiers à télécharger.
pub fn bibliotheques(version: &Value, dossier: &Path, s: &Systeme) -> Bibliotheques {
    let bits = if s.arch == "ia32" { "32" } else { "64" };
    let mut b = Bibliotheques::default();
    let mut cles: Vec<String> = vec![];
    for lib in version.get("libraries").and_then(Value::as_array).into_iter().flatten() {
        if !autorise(lib.get("rules"), &[], s) {
            continue;
        }
        let Some(nom) = texte(lib, "/name") else { continue };
        let m = maven(nom);
        if !natives_de_ce_processeur(m.classifieur, s.arch) {
            continue;
        }
        let exclure: Vec<String> = lib
            .pointer("/extract/exclude")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect();

        let artefact = lib.pointer("/downloads/artifact");
        if artefact.is_some() || lib.get("natives").is_none() {
            let rel = artefact.and_then(|a| texte(a, "/path")).map(String::from).unwrap_or_else(|| chemin_maven(nom));
            let fichier = sous(dossier, &rel);
            let url = match artefact {
                Some(a) => texte(a, "/url").unwrap_or("").to_string(),
                None => format!("{}{}", base_url(lib), chemin_maven(nom)),
            };
            if !url.is_empty() {
                b.taches.push(tache(artefact, url, fichier.clone()));
            }
            // Les bibliothèques du loader (listées en premier) l'emportent sur celles de la version vanilla.
            let cle = format!("{}:{}:{}", m.groupe, m.artefact, m.classifieur.unwrap_or(""));
            if !cles.contains(&cle) {
                cles.push(cle);
                b.classpath.push(fichier.clone());
            }
            if m.classifieur.is_some_and(|c| c.starts_with("natives-")) {
                b.natives.push(Native { fichier, exclure: exclure.clone() });
            }
        }

        // Ancien format (avant 1.19) : natives dans un « classifieur » séparé.
        if let Some(cle) = lib.get("natives").and_then(|n| n.get(s.nom)).and_then(Value::as_str).map(|c| c.replace("${arch}", bits)) {
            let telechargement = lib.pointer("/downloads/classifiers").and_then(|c| c.get(&cle));
            let rel =
                telechargement.and_then(|t| texte(t, "/path")).map(String::from).unwrap_or_else(|| chemin_maven(&format!("{nom}:{cle}")));
            let fichier = sous(dossier, &rel);
            let url = telechargement.and_then(|t| texte(t, "/url")).map(String::from).unwrap_or_else(|| format!("{}{rel}", base_url(lib)));
            b.taches.push(tache(telechargement, url, fichier.clone()));
            b.natives.push(Native { fichier, exclure });
        }
    }
    b
}

pub struct Assets {
    pub index: Value,
    pub taches: Vec<Tache>,
}

impl Jeu {
    pub fn jar_client(&self, version: &Value) -> PathBuf {
        let id = texte(version, "/jar").or_else(|| texte(version, "/id")).unwrap_or("");
        self.fichiers_version(id).jar
    }

    pub fn tache_client(&self, version: &Value) -> Option<Tache> {
        let c = version.pointer("/downloads/client")?;
        Some(tache(Some(c), texte(c, "/url")?.into(), self.jar_client(version)))
    }

    pub fn tache_logs(&self, version: &Value) -> Option<Tache> {
        let f = version.pointer("/logging/client/file")?;
        let chemin = self.dossiers.assets.join("log_configs").join(texte(f, "/id")?);
        Some(tache(Some(f), texte(f, "/url")?.into(), chemin))
    }

    /// Télécharge l'index des assets puis renvoie la liste des objets (sons, textures, langues…).
    pub async fn preparer_assets(&self, version: &Value, verifier: bool, annule: Option<CancellationToken>) -> Resultat<Assets> {
        let info = version.get("assetIndex").cloned().unwrap_or(Value::Null);
        let id = texte(&info, "/id").unwrap_or("");
        let fichier = self.dossiers.assets.join("indexes").join(format!("{id}.json"));
        let t = tache(Some(&info), texte(&info, "/url").unwrap_or("").into(), fichier.clone());
        if let Err(e) = self.telechargeur.fichier(t, verifier, annule, None).await
            && !fichier.is_file()
        {
            return Err(e);
        }
        let index: Value = lire_json(&fichier)
            .filter(|i: &Value| i.get("objects").is_some_and(Value::is_object))
            .ok_or_else(|| Erreur::new(tv("install.index_des_assets_illisible", &[("id", id)])))?;
        let objets = self.dossiers.assets.join("objects");
        let taches = index["objects"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(_, o)| {
                let h = texte(o, "/hash")?;
                let debut = h.get(..2)?;
                Some(Tache {
                    url: format!("{URL_RESSOURCES}{debut}/{h}"),
                    chemin: objets.join(debut).join(h),
                    sha1: Some(h.into()),
                    taille: o.get("size").and_then(Value::as_u64),
                    ..Default::default()
                })
            })
            .collect();
        Ok(Assets { index, taches })
    }

    /// Versions d'avant 1.7 : les assets sont recopiés sous leur vrai nom. Renvoie le dossier à utiliser.
    pub fn reconstruire_assets(&self, index: &Value, id_assets: &str, dossier_jeu: &Path) -> Resultat<Option<PathBuf>> {
        let vrai = |c: &str| index.get(c).and_then(Value::as_bool).unwrap_or(false);
        if !vrai("virtual") && !vrai("map_to_resources") {
            return Ok(None);
        }
        let cible =
            if vrai("map_to_resources") { dossier_jeu.join("resources") } else { self.dossiers.assets.join("virtual").join(id_assets) };
        for (nom, o) in index["objects"].as_object().into_iter().flatten() {
            let (Some(h), Some(taille)) = (texte(o, "/hash"), o.get("size").and_then(Value::as_u64)) else { continue };
            let dest = sous(&cible, nom);
            if std::fs::metadata(&dest).is_ok_and(|m| m.len() == taille) {
                continue;
            }
            if let Some(d) = dest.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::copy(self.dossiers.assets.join("objects").join(&h[..2.min(h.len())]).join(h), &dest)?;
        }
        Ok(Some(cible))
    }
}

/// Fichier encore ouvert par une partie en cours (Windows : partage refusé, accès refusé).
fn occupe(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32)
}

/// Extrait les DLL des natives à plat dans `cible` (vidé avant). Renvoie le nombre de fichiers.
pub fn extraire_natives(natives: &[Native], cible: &Path) -> Resultat<usize> {
    let _ = std::fs::remove_dir_all(cible);
    std::fs::create_dir_all(cible)?;
    let mut nombre = 0;
    for n in natives {
        let octets = std::fs::read(&n.fichier)?;
        for e in zip::lister_entrees(&octets)? {
            let nom = e.name.as_str();
            let natif = [".dll", ".so", ".dylib", ".jnilib"].iter().any(|x| nom.to_ascii_lowercase().ends_with(x));
            if nom.ends_with('/') || nom.starts_with("META-INF/") || n.exclure.iter().any(|p| nom.starts_with(p.as_str())) || !natif {
                continue;
            }
            let base = nom.rsplit('/').next().unwrap_or(nom);
            match std::fs::write(cible.join(base), zip::lire_entree(&octets, &e)?) {
                Ok(()) => nombre += 1,
                // DLL encore utilisée par une partie en cours : la copie existante convient.
                Err(err) if occupe(&err) => {}
                Err(err) => return Err(err.into()),
            }
        }
    }
    Ok(nombre)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chemins::Dossiers;
    use crate::essai::Dossier;
    use crate::net::Reseau;
    use serde_json::json;
    use std::sync::Arc;

    fn sys(nom: &'static str, arch: &'static str) -> Systeme {
        Systeme { nom, arch, version: "10.0".into() }
    }

    fn version() -> Value {
        json!({ "id": "1.21.1", "libraries": [
            { "name": "net.fabricmc:fabric-loader:0.17.2", "url": "https://maven.fabricmc.net" },
            { "name": "com.mojang:brigadier:1.3.10", "downloads": { "artifact": { "path": "com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar", "url": "https://l/b.jar", "sha1": "ab", "size": 3 } } },
            { "name": "com.mojang:brigadier:1.0.0", "downloads": { "artifact": { "path": "com/mojang/brigadier/1.0.0/brigadier-1.0.0.jar", "url": "https://l/old.jar" } } },
            { "name": "org.lwjgl:lwjgl:3.3.3:natives-windows", "rules": [{ "action": "allow", "os": { "name": "windows" } }],
              "downloads": { "artifact": { "path": "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar", "url": "https://l/n.jar" } } },
            { "name": "org.lwjgl:lwjgl:3.3.3:natives-windows-arm64", "rules": [{ "action": "allow", "os": { "name": "windows" } }],
              "downloads": { "artifact": { "path": "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows-arm64.jar", "url": "https://l/a.jar" } } },
            { "name": "org.lwjgl.lwjgl:lwjgl-platform:2.9.4", "natives": { "windows": "natives-windows-${arch}", "osx": "natives-osx" },
              "extract": { "exclude": ["META-INF/"] },
              "downloads": { "classifiers": { "natives-windows-64": { "path": "org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-windows-64.jar", "url": "https://l/p.jar" } } } },
            { "name": "forge:genere:1", "downloads": { "artifact": { "path": "forge/genere.jar", "url": "" } } },
        ]})
    }

    #[test]
    fn bibliotheques_selon_le_systeme() {
        let base = Path::new("L");
        let b = bibliotheques(&version(), base, &sys("windows", "x64"));
        let cp: Vec<PathBuf> = b.classpath.clone();
        assert_eq!(
            cp,
            [
                sous(base, "net/fabricmc/fabric-loader/0.17.2/fabric-loader-0.17.2.jar"),
                sous(base, "com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar"),
                sous(base, "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"),
                sous(base, "forge/genere.jar"),
            ]
        );
        assert_eq!(b.taches[0].url, "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.17.2/fabric-loader-0.17.2.jar");
        assert_eq!((b.taches[1].sha1.as_deref(), b.taches[1].taille), (Some("ab"), Some(3)));
        // Jar produit par un processeur (url vide) : dans le classpath, pas téléchargé.
        assert!(!b.taches.iter().any(|t| t.url.is_empty()));
        assert_eq!(b.taches.len(), 5);
        assert_eq!(b.natives.len(), 2);
        assert_eq!(
            b.natives[1],
            Native {
                fichier: sous(base, "org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-windows-64.jar"),
                exclure: vec!["META-INF/".into()]
            }
        );

        let mac = bibliotheques(&version(), base, &sys("osx", "arm64"));
        assert!(!mac.classpath.iter().any(|p| p.to_string_lossy().contains("natives-windows")));
        assert_eq!(mac.natives[0].fichier, sous(base, "org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-osx.jar"));
        assert_eq!(
            mac.taches.last().unwrap().url,
            "https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-osx.jar"
        );
    }

    #[test]
    fn natives_et_assets_anciens() {
        let d = Dossier::nouveau("installation");
        let jar = zip::creer_zip(&[
            ("lwjgl64.dll", b"dll".as_slice()),
            ("META-INF/x.dll", b"non".as_slice()),
            ("sous/OpenAL64.DLL", b"al".as_slice()),
            ("org/lwjgl/Classe.class", b"non".as_slice()),
            ("ignore/y.dll", b"non".as_slice()),
        ]);
        std::fs::write(d.0.join("n.jar"), jar).unwrap();
        let cible = d.0.join("natives");
        d.ecrire("natives/ancien.dll", "x");
        let n = extraire_natives(&[Native { fichier: d.0.join("n.jar"), exclure: vec!["ignore/".into()] }], &cible).unwrap();
        assert_eq!(n, 2);
        assert_eq!(std::fs::read(cible.join("OpenAL64.DLL")).unwrap(), b"al");
        assert!(!cible.join("ancien.dll").exists());

        let jeu = Jeu::new(Dossiers::new(&d.0.join("racine")), Arc::new(Reseau::new()));
        d.ecrire("racine/assets/objects/ab/abcd", "son");
        let index = json!({ "virtual": true, "objects": { "sound/a.ogg": { "hash": "abcd", "size": 3 } } });
        let dossier = jeu.reconstruire_assets(&index, "legacy", &d.0.join("jeu")).unwrap().unwrap();
        assert_eq!(std::fs::read(sous(&dossier, "sound/a.ogg")).unwrap(), b"son");
        let ressources = json!({ "map_to_resources": true, "objects": { "x.ogg": { "hash": "abcd", "size": 3 } } });
        assert_eq!(jeu.reconstruire_assets(&ressources, "pre-1.6", &d.0.join("jeu")).unwrap(), Some(d.0.join("jeu").join("resources")));
        assert_eq!(jeu.reconstruire_assets(&json!({ "objects": {} }), "17", &d.0).unwrap(), None);
    }
}
