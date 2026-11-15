//! Espace disque du launcher et nettoyage de ce qui se retélécharge (Java, versions, bibliothèques, assets, cache que
//! plus aucune instance n'utilise), comme core/storage.js. Uniquement sous la racine du launcher (.0rzxn) : les
//! dossiers des instances et les sauvegardes ne sont jamais touchés.

use crate::chemins::Dossiers;
use crate::fichiers::lire_json;
use crate::i18n::{t, tv};
use crate::installation::bibliotheques;
use crate::jeu::Jeu;
use crate::regles::Systeme;
use crate::versions::fusionner;
use commun::Instance;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Fichiers d'un dossier (récursif, sans suivre les liens) : (chemin, taille).
fn parcourir(d: &Path, sortie: &mut Vec<(PathBuf, u64)>) {
    let Ok(it) = std::fs::read_dir(d) else { return };
    for e in it.flatten() {
        match e.file_type() {
            Ok(t) if t.is_dir() => parcourir(&e.path(), sortie),
            // Fichier disparu entre-temps : ignoré.
            Ok(t) if t.is_file() => {
                if let Ok(m) = e.metadata() {
                    sortie.push((e.path(), m.len()));
                }
            }
            _ => {}
        }
    }
}

fn fichiers(d: &Path) -> Vec<(PathBuf, u64)> {
    let mut l = vec![];
    parcourir(d, &mut l);
    l
}

pub fn taille(d: &Path) -> u64 {
    fichiers(d).iter().map(|f| f.1).sum()
}

/// Clé de comparaison des chemins (Windows ignore la casse).
fn cle(p: &Path) -> String {
    let s = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()).to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Part {
    pub id: &'static str,
    pub label: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Utilisation {
    pub total: u64,
    pub parts: Vec<Part>,
}

fn parts(d: &Dossiers) -> [(&'static str, String, &Path); 7] {
    [
        ("instances", t("storage.instances"), &d.instances),
        ("assets", t("storage.assets"), &d.assets),
        ("libraries", t("storage.bibliotheques"), &d.libraries),
        ("backups", t("storage.sauvegardes"), &d.backups),
        ("runtime", "Java".into(), &d.runtime),
        ("versions", t("storage.versions"), &d.versions),
        ("cache", t("storage.cache"), &d.cache),
    ]
}

/// Répartition de l'espace utilisé sous la racine du launcher.
pub fn utilisation(d: &Dossiers) -> Utilisation {
    let mut l: Vec<Part> = parts(d).into_iter().map(|(id, label, p)| Part { id, label, size: taille(p) }).collect();
    let connus: HashSet<String> = parts(d).iter().map(|(_, _, p)| cle(p)).collect();
    let mut autres = 0;
    for e in std::fs::read_dir(&d.racine).into_iter().flatten().flatten() {
        if connus.contains(&cle(&e.path())) {
            continue;
        }
        autres += if e.file_type().is_ok_and(|t| t.is_dir()) { taille(&e.path()) } else { e.metadata().map_or(0, |m| m.len()) };
    }
    if autres > 0 {
        l.push(Part { id: "other", label: t("storage.autres"), size: autres });
    }
    Utilisation { total: l.iter().map(|p| p.size).sum(), parts: l }
}

/// Fichiers de version d'une chaîne d'héritage, lus sur le disque seulement (enfant d'abord).
fn chaine(jeu: &Jeu, id: &str) -> Vec<Value> {
    let mut l = vec![];
    let mut vus = HashSet::new();
    let mut courant = Some(id.to_string());
    while let Some(c) = courant.filter(|c| vus.insert(c.clone())) {
        let Some(j) = lire_json::<Value>(&jeu.fichiers_version(&c).json) else { break };
        courant = j["inheritsFrom"].as_str().map(String::from);
        l.push(j);
    }
    l
}

fn fusionnee(c: &[Value]) -> Option<Value> {
    let (dernier, reste) = c.split_last()?;
    Some(reste.iter().rev().fold(dernier.clone(), |v, enfant| fusionner(&v, enfant)))
}

fn version_haute(i: &Instance) -> String {
    let installe = i.loader_installed.as_ref().and_then(|l| l["versionId"].as_str()).map(String::from);
    if i.loader != "vanilla" { installe.unwrap_or_else(|| i.version.clone()) } else { i.version.clone() }
}

struct Utilises {
    versions: HashSet<String>,
    composants: HashSet<String>,
    bibliotheques: HashSet<String>,
    index_assets: HashSet<String>,
    forge: bool,
}

/// Versions, Java, index d'assets et bibliothèques dont les instances ont besoin.
fn utilises(jeu: &Jeu, instances: &[Instance]) -> Utilises {
    let mut u = Utilises {
        versions: HashSet::new(),
        composants: HashSet::new(),
        bibliotheques: HashSet::new(),
        index_assets: HashSet::new(),
        forge: false,
    };
    let mut racines = vec![];
    for i in instances {
        let installe = i.loader_installed.as_ref().and_then(|l| l["versionId"].as_str()).map(String::from);
        for id in [Some(i.version.clone()), installe].into_iter().flatten() {
            for j in chaine(jeu, &id) {
                u.versions.insert(j["id"].as_str().map(String::from).unwrap_or_else(|| id.clone()));
            }
            u.versions.insert(id);
        }
        let Some(v) = fusionnee(&chaine(jeu, &version_haute(i))) else { continue };
        let perso = i.settings.java == "custom" && !i.settings.java_path.is_empty();
        if !perso {
            u.composants.insert(v.pointer("/javaVersion/component").and_then(Value::as_str).unwrap_or("jre-legacy").into());
        }
        racines.push(v);
    }
    for v in &racines {
        let b = bibliotheques(v, &jeu.dossiers.libraries, Systeme::actuel());
        for f in b.classpath.iter().chain(b.natives.iter().map(|n| &n.fichier)).chain(b.taches.iter().map(|t| &t.chemin)) {
            u.bibliotheques.insert(cle(f));
        }
        if let Some(a) = v.pointer("/assetIndex/id").and_then(Value::as_str) {
            u.index_assets.insert(a.into());
        }
    }
    u.forge = instances.iter().any(|i| i.loader == "forge" || i.loader == "neoforge");
    u
}

fn liste(noms: &[String]) -> String {
    if noms.len() <= 3 {
        noms.join(", ")
    } else {
        tv("storage.names_more", &[("names", &noms[..3].join(", ")), ("count", &(noms.len() - 3).to_string())])
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Categorie {
    pub id: &'static str,
    pub label: String,
    pub detail: String,
    pub count: usize,
    pub size: u64,
    /// Jamais envoyé à l'interface : recalculé avant chaque nettoyage.
    #[serde(skip)]
    pub paths: Vec<PathBuf>,
}

/// Ce qui peut partir. Recalculé avant chaque nettoyage, l'interface ne reçoit jamais de chemins à supprimer.
pub fn plan(jeu: &Jeu, instances: &[Instance]) -> Vec<Categorie> {
    let d = &jeu.dossiers;
    let u = utilises(jeu, instances);
    let mut l = vec![];

    let runtimes: Vec<_> = jeu.runtimes().into_iter().filter(|r| !u.composants.contains(&r.component)).collect();
    let noms: Vec<String> = runtimes.iter().map(|r| r.major.map_or_else(|| r.component.clone(), |m| format!("Java {m}"))).collect();
    l.push(Categorie {
        id: "runtimes",
        label: t("storage.java_inutilises"),
        detail: if runtimes.is_empty() {
            t("storage.chaque_java_sert_au_moins")
        } else {
            tv("storage.java_unused", &[("list", &liste(&noms)), ("count", &runtimes.len().to_string())])
        },
        count: runtimes.len(),
        size: runtimes.iter().map(|r| taille(&r.dir)).sum(),
        paths: runtimes.iter().map(|r| r.dir.clone()).collect(),
    });

    let versions: Vec<String> = std::fs::read_dir(&d.versions)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !u.versions.contains(n))
        .collect();
    l.push(Categorie {
        id: "versions",
        label: t("storage.versions_sans_instance"),
        detail: if versions.is_empty() { t("storage.chaque_version_sert_une_instance") } else { liste(&versions) },
        count: versions.len(),
        size: versions.iter().map(|n| taille(&d.versions.join(n))).sum(),
        paths: versions.iter().map(|n| d.versions.join(n)).collect(),
    });

    // Les processeurs de Forge et NeoForge écrivent ici des jars qu'aucun fichier de version ne cite : on n'y touche
    // pas tant qu'une instance Forge ou NeoForge existe.
    let proteges: Vec<String> = if u.forge {
        ["net/minecraftforge", "net/neoforged", "net/minecraft"]
            .iter()
            .map(|p| format!("{}{}", cle(&crate::installation::sous(&d.libraries, p)), std::path::MAIN_SEPARATOR))
            .collect()
    } else {
        vec![]
    };
    let libs: Vec<(PathBuf, u64)> = fichiers(&d.libraries)
        .into_iter()
        .filter(|(f, _)| {
            let k = cle(f);
            !u.bibliotheques.contains(&k) && !proteges.iter().any(|p| k.starts_with(p))
        })
        .collect();
    l.push(Categorie {
        id: "libraries",
        label: t("storage.bibliotheques_orphelines"),
        detail: if libs.is_empty() {
            t("storage.toutes_servent_encore")
        } else {
            tv("storage.fichiers_que_plus_aucune_version", &[("count", &libs.len().to_string())])
        },
        count: libs.len(),
        size: libs.iter().map(|f| f.1).sum(),
        paths: libs.into_iter().map(|f| f.0).collect(),
    });

    let mut objets = HashSet::new();
    let mut lisibles = true;
    for id in &u.index_assets {
        match lire_json::<Value>(&d.assets.join("indexes").join(format!("{id}.json"))).filter(|i| i["objects"].is_object()) {
            Some(i) => {
                objets.extend(i["objects"].as_object().into_iter().flatten().filter_map(|(_, o)| o["hash"].as_str().map(String::from)))
            }
            None => lisibles = false,
        }
    }
    // Un index manquant : on ne sait pas quels fichiers il demande, on ne propose rien.
    let assets: Vec<(PathBuf, u64)> = if lisibles {
        let nom = |f: &Path| f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        fichiers(&d.assets.join("objects"))
            .into_iter()
            .filter(|(f, _)| !objets.contains(&nom(f)))
            .chain(
                fichiers(&d.assets.join("indexes")).into_iter().filter(|(f, _)| !u.index_assets.contains(nom(f).trim_end_matches(".json"))),
            )
            .collect()
    } else {
        vec![]
    };
    l.push(Categorie {
        id: "assets",
        label: t("storage.assets_inutilises"),
        detail: if assets.is_empty() { t("storage.tous_servent_encore") } else { t("storage.sons_textures_et_langues_de") },
        count: assets.len(),
        size: assets.iter().map(|f| f.1).sum(),
        paths: assets.into_iter().map(|f| f.0).collect(),
    });

    // Fichiers du cache inutiles une fois l'installation finie (installateurs Forge, modpacks téléchargés).
    let cache: Vec<(PathBuf, u64)> = ["installers", "modpacks"].iter().flat_map(|c| fichiers(&d.cache.join(c))).collect();
    l.push(Categorie {
        id: "cache",
        label: t("storage.cache_de_telechargement"),
        detail: if cache.is_empty() { t("storage.rien_vider") } else { t("storage.installateurs_forge_et_modpacks_deja") },
        count: cache.len(),
        size: cache.iter().map(|f| f.1).sum(),
        paths: cache.into_iter().map(|f| f.0).collect(),
    });
    l
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Nettoyage {
    pub freed: u64,
    pub failed: usize,
    pub done: Vec<&'static str>,
}

/// Dossiers vides laissés par le nettoyage (le dossier de départ reste).
fn retirer_vides(d: &Path, racine: bool) {
    let Ok(it) = std::fs::read_dir(d) else { return };
    for e in it.flatten() {
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            retirer_vides(&e.path(), false);
        }
    }
    if !racine && std::fs::read_dir(d).is_ok_and(|mut it| it.next().is_none()) {
        let _ = std::fs::remove_dir(d);
    }
}

/// Supprime les catégories choisies (définitivement : tout se retélécharge). Renvoie les octets libérés.
pub fn nettoyer(jeu: &Jeu, instances: &[Instance], ids: &[String]) -> Nettoyage {
    let racine = format!("{}{}", cle(&jeu.dossiers.racine), std::path::MAIN_SEPARATOR);
    let choisies: Vec<Categorie> = plan(jeu, instances).into_iter().filter(|c| ids.iter().any(|i| i == c.id)).collect();
    let mut libere = 0;
    let mut echecs = 0;
    for c in &choisies {
        for p in &c.paths {
            // Garde-fou : jamais hors de .0rzxn.
            if !cle(p).starts_with(&racine) {
                continue;
            }
            let r = if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) };
            if r.is_err() && p.exists() {
                echecs += 1;
            }
        }
        match c.id {
            "libraries" => retirer_vides(&jeu.dossiers.libraries, true),
            "assets" => retirer_vides(&jeu.dossiers.assets.join("objects"), true),
            _ => {}
        }
        libere += c.size;
    }
    Nettoyage { freed: libere, failed: echecs, done: choisies.iter().map(|c| c.id).collect() }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeUtilise {
    #[serde(flatten)]
    pub runtime: crate::java::Runtime,
    pub size: u64,
    pub used_by: Vec<String>,
}

/// Java du launcher avec leur taille et les instances qui s'en servent.
pub fn runtimes_utilises(jeu: &Jeu, instances: &[Instance]) -> Vec<RuntimeUtilise> {
    let mut par: HashMap<String, Vec<String>> = HashMap::new();
    for i in instances {
        let perso = i.settings.java == "custom" && !i.settings.java_path.is_empty();
        let Some(v) = fusionnee(&chaine(jeu, &version_haute(i))).filter(|_| !perso) else { continue };
        let c = v.pointer("/javaVersion/component").and_then(Value::as_str).unwrap_or("jre-legacy").to_string();
        par.entry(c).or_default().push(i.name.clone());
    }
    jeu.runtimes()
        .into_iter()
        .map(|r| RuntimeUtilise { size: taille(&r.dir), used_by: par.get(&r.component).cloned().unwrap_or_default(), runtime: r })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use crate::net::Reseau;
    use std::sync::Arc;

    #[test]
    fn plan_et_nettoyage() {
        let d = Dossier::nouveau("stockage");
        let r = d.0.join("r");
        let jeu = Jeu::new(Dossiers::new(&r), Arc::new(Reseau::new()));
        let v = serde_json::json!({
            "id": "1.21.11", "javaVersion": { "component": "java-runtime-delta", "majorVersion": 21 }, "assetIndex": { "id": "29" },
            "libraries": [{ "name": "a:b:1", "downloads": { "artifact": { "path": "a/b/1/b-1.jar", "url": "https://x/b.jar" } } }],
        });
        d.ecrire("r/versions/1.21.11/1.21.11.json", &v.to_string());
        d.ecrire("r/versions/1.8.9/1.8.9.json", "{}");
        d.ecrire("r/libraries/a/b/1/b-1.jar", "garde");
        d.ecrire("r/libraries/vieux/c.jar", "orpheline");
        d.ecrire("r/assets/indexes/29.json", r#"{"objects":{"x":{"hash":"aa11","size":1}}}"#);
        d.ecrire("r/assets/indexes/5.json", "{}");
        d.ecrire("r/assets/objects/aa/aa11", "s");
        d.ecrire("r/assets/objects/bb/bb22", "orphelin");
        d.ecrire("r/runtime/java-runtime-delta/release", "JAVA_VERSION=\"21.0.7\"");
        d.ecrire("r/runtime/jre-legacy/release", "JAVA_VERSION=\"1.8.0_51\"");
        d.ecrire("r/cache/installers/forge.jar", "x");
        d.ecrire("r/fichier-perdu.txt", "123");
        let i = Instance { id: "a".into(), name: "A".into(), version: "1.21.11".into(), loader: "vanilla".into(), ..Default::default() };
        let p = plan(&jeu, std::slice::from_ref(&i));
        let n = |id: &str| p.iter().find(|c| c.id == id).unwrap().count;
        assert_eq!((n("runtimes"), n("versions"), n("libraries"), n("assets"), n("cache")), (1, 1, 1, 2, 1));
        assert!(p.iter().find(|c| c.id == "runtimes").unwrap().detail.contains("Java 8"));
        let u = utilisation(&jeu.dossiers);
        assert_eq!(u.parts.last().unwrap().id, "other");
        let fait = nettoyer(&jeu, std::slice::from_ref(&i), &["libraries".into(), "assets".into(), "versions".into()]);
        assert_eq!((fait.failed, fait.done.len()), (0, 3));
        assert!(r.join("libraries/a/b/1/b-1.jar").is_file() && !r.join("libraries/vieux").exists());
        assert!(r.join("assets/objects/aa/aa11").is_file() && !r.join("assets/objects/bb").exists());
        assert!(!r.join("versions/1.8.9").exists() && r.join("versions/1.21.11").exists());
        let rt = runtimes_utilises(&jeu, &[i]);
        assert_eq!(rt.iter().find(|x| x.runtime.component == "java-runtime-delta").unwrap().used_by, ["A"]);
    }
}
