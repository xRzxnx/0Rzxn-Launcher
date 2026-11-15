//! Modpacks au format Modrinth (.mrpack) : installation, mise à jour et export, comme core/modpacks.js.
//! Format : https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack

use crate::contenu::{Corbeille, GENRES, genre};
use crate::erreur::{Erreur, Resultat};
use crate::gestion_instances::{changer_modpack, creer, modifier};
use crate::i18n::{t, tv};
use crate::instances::{dossier, lire};
use crate::jeu::Jeu;
use crate::loaders::version_pour_pack;
use crate::modrinth::Modrinth;
use crate::telechargement::{Progression, Tache, sha1};
use crate::zip;
use commun::{Instance, Reglages};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Digest;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Seules sources autorisées par le format .mrpack.
const HOTES: [&str; 4] = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];

fn loader_de_cle(c: &str) -> Option<&'static str> {
    match c {
        "fabric-loader" => Some("fabric"),
        "quilt-loader" => Some("quilt"),
        "forge" => Some("forge"),
        "neoforge" => Some("neoforge"),
        _ => None,
    }
}

fn cle_de_loader(l: &str) -> &'static str {
    match l {
        "fabric" => "fabric-loader",
        "quilt" => "quilt-loader",
        "forge" => "forge",
        _ => "neoforge",
    }
}

/// À la mise à jour, on ne remplace jamais les réglages ni les mondes du joueur.
fn garder_a_la_mise_a_jour(rel: &str) -> bool {
    rel == "options.txt" || rel.starts_with("saves/")
}

/// Chemin dans le dossier du jeu, en refusant toute sortie du dossier (« ../ », chemin absolu, lettre de lecteur).
pub fn cible_sure(dossier_jeu: &Path, rel: &str) -> Resultat<PathBuf> {
    let refuse = || Erreur::new(tv("modpacks.chemin_refuse_dans_le_modpack", &[("rel", rel)]));
    let propre = rel.replace('\\', "/");
    let lecteur = propre.as_bytes().get(1) == Some(&b':') && propre.as_bytes()[0].is_ascii_alphabetic();
    if propre.is_empty() || propre.starts_with('/') || lecteur {
        return Err(refuse());
    }
    let mut parts: Vec<&str> = vec![];
    for p in propre.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop().ok_or_else(refuse)?;
            }
            p => parts.push(p),
        }
    }
    if parts.is_empty() {
        return Err(refuse());
    }
    Ok(parts.iter().fold(dossier_jeu.to_path_buf(), |c, p| c.join(p)))
}

pub struct Pack {
    pub octets: Vec<u8>,
    pub entrees: Vec<zip::Entree>,
    pub index: Value,
    pub mc: String,
    pub loader: String,
    pub version_loader_pack: Option<String>,
}

pub fn lire_pack(octets: Vec<u8>) -> Resultat<Pack> {
    let entrees = zip::lister_entrees(&octets).map_err(|_| Erreur::new(t("modpacks.ce_fichier_est_pas_une")))?;
    let brut = entrees.iter().find(|e| e.name == "modrinth.index.json").and_then(|e| zip::lire_entree(&octets, e).ok());
    let brut = brut.ok_or_else(|| Erreur::new(t("modpacks.ce_fichier_est_pas_un")))?;
    let index: Value = serde_json::from_slice(&brut).map_err(|_| Erreur::new(t("modpacks.ce_fichier_est_pas_un")))?;
    let mc = index.pointer("/dependencies/minecraft").and_then(Value::as_str).filter(|_| index["game"] == "minecraft");
    let mc = mc.ok_or_else(|| Erreur::new(t("modpacks.modpack_invalide_version_de_minecraft")))?.to_string();
    let cles: Vec<&String> =
        index["dependencies"].as_object().map(|o| o.keys().filter(|k| *k != "minecraft").collect()).unwrap_or_default();
    let inconnues: Vec<&str> = cles.iter().filter(|k| loader_de_cle(k).is_none()).map(|k| k.as_str()).collect();
    if !inconnues.is_empty() {
        return Err(Erreur::new(tv("modpacks.loader_non_pris_en_charge", &[("unknown", &inconnues.join(", "))])));
    }
    let cle = cles.first().map(|k| k.to_string());
    let loader = cle.as_deref().and_then(loader_de_cle).unwrap_or("vanilla").to_string();
    let version_loader_pack = cle.and_then(|k| index["dependencies"][&k].as_str().map(String::from));
    Ok(Pack { octets, entrees, index, mc, loader, version_loader_pack })
}

/// Fichier du pack à télécharger, avec son chemin relatif (« mods/sodium.jar »).
pub struct FichierPack {
    pub tache: Tache,
    pub rel: String,
}

pub fn taches_fichiers(dossier_jeu: &Path, index: &Value) -> Resultat<Vec<FichierPack>> {
    let mut l = vec![];
    for f in index["files"].as_array().into_iter().flatten() {
        if f.pointer("/env/client").and_then(Value::as_str) == Some("unsupported") {
            continue;
        }
        let chemin = f["path"].as_str().unwrap_or("");
        let url = f["downloads"].as_array().into_iter().flatten().filter_map(Value::as_str).find(|u| {
            reqwest::Url::parse(u)
                .is_ok_and(|p| p.scheme() == "https" && p.host_str().is_some_and(|h| HOTES.contains(&h)) && p.port().is_none())
        });
        let url = url.ok_or_else(|| Erreur::new(tv("modpacks.source_de_telechargement_non_autorisee", &[("path", chemin)])))?;
        l.push(FichierPack {
            tache: Tache {
                url: url.into(),
                chemin: cible_sure(dossier_jeu, chemin)?,
                sha1: f.pointer("/hashes/sha1").and_then(Value::as_str).map(String::from),
                sha512: f.pointer("/hashes/sha512").and_then(Value::as_str).map(String::from),
                taille: f["fileSize"].as_u64(),
            },
            rel: chemin.replace('\\', "/"),
        });
    }
    Ok(l)
}

fn appliquer_overrides(p: &Pack, dossier_jeu: &Path, mise_a_jour: bool) -> Resultat<usize> {
    let mut n = 0;
    for prefixe in ["overrides/", "client-overrides/"] {
        for e in p.entrees.iter().filter(|e| e.name.starts_with(prefixe) && !e.name.ends_with('/')) {
            let rel = &e.name[prefixe.len()..];
            let cible = cible_sure(dossier_jeu, rel)?;
            if mise_a_jour && garder_a_la_mise_a_jour(rel) && cible.exists() {
                continue;
            }
            if let Some(d) = cible.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::write(&cible, zip::lire_entree(&p.octets, e)?)?;
            n += 1;
        }
    }
    Ok(n)
}

pub type Suivi = Option<Arc<dyn Fn(Progression) + Send + Sync>>;

/// Télécharge le .mrpack d'une version Modrinth (vérifié) et renvoie son contenu et la version.
pub async fn telecharger_pack(jeu: &Jeu, version: &str, annule: Option<CancellationToken>) -> Resultat<(Vec<u8>, Value)> {
    let m = Modrinth::new(jeu.reseau());
    let v = m.version(version).await?;
    let f = v.files.iter().find(|f| f.filename.ends_with(".mrpack")).or(v.file.as_ref()).filter(|f| f.filename.ends_with(".mrpack"));
    let f = f.ok_or_else(|| Erreur::new(t("modpacks.cette_version_est_pas_un")))?;
    let nom = f.filename.rsplit(['/', '\\']).next().unwrap_or("pack.mrpack");
    let cible = jeu.dossiers.cache.join("modpacks").join(nom);
    let tache = Tache {
        url: f.url.clone(),
        chemin: cible.clone(),
        sha1: Some(f.sha1.clone()),
        sha512: Some(f.sha512.clone()).filter(|s| !s.is_empty()),
        taille: Some(f.size),
    };
    jeu.telechargeur.fichier(tache, false, annule, None).await?;
    Ok((std::fs::read(cible)?, serde_json::to_value(v).unwrap_or_default()))
}

/// Origine d'un pack venu de Modrinth : { projectId, versionId, title, icon }.
pub async fn installer_pack(
    jeu: &Jeu,
    octets: Vec<u8>,
    defauts: &Reglages,
    source: Option<&Value>,
    annule: Option<CancellationToken>,
    suivi: Suivi,
    journal: &(dyn Fn(&str) + Send + Sync),
) -> Resultat<Instance> {
    let racine = &jeu.dossiers.racine;
    let p = lire_pack(octets)?;
    let version_loader = if p.loader == "vanilla" {
        None
    } else {
        Some(jeu.version_loader_du_pack(&p.loader, &p.mc, p.version_loader_pack.as_deref().unwrap_or("")).await?)
    };
    let nom = source.and_then(|s| s["title"].as_str()).or_else(|| p.index["name"].as_str()).unwrap_or("Modpack");
    let instance = creer(
        racine,
        &json!({ "name": nom, "icon": "grass", "version": p.mc, "loader": p.loader, "loaderVersion": version_loader }),
        defauts,
    )?;
    let dossier_jeu = dossier(racine, &instance.id).join("minecraft");
    let resultat: Resultat<Vec<FichierPack>> = async {
        let fichiers = taches_fichiers(&dossier_jeu, &p.index)?;
        let mc = match &version_loader {
            Some(v) => format!("{}, {} {v}", p.mc, p.loader),
            None => p.mc.clone(),
        };
        let nb = fichiers.len().to_string();
        journal(&tv(
            "modpacks.summary",
            &[
                ("name", p.index["name"].as_str().unwrap_or("")),
                ("version", p.index["versionId"].as_str().unwrap_or("")),
                ("files", &nb),
                ("mc", &mc),
            ],
        ));
        jeu.telechargeur.tous(fichiers.iter().map(|f| f.tache.clone()).collect(), 16, false, annule, suivi).await?;
        let n = appliquer_overrides(&p, &dossier_jeu, false)?;
        journal(&tv("modpacks.fichiers_de_configuration_copies", &[("overrides", &n.to_string())]));
        Ok(fichiers)
    }
    .await;
    let fichiers = match resultat {
        Ok(f) => f,
        Err(e) => {
            // Instance incomplète : on la retire (elle vient d'être créée, rien d'autre dedans).
            let _ = std::fs::remove_dir_all(dossier(racine, &instance.id));
            return Err(e);
        }
    };
    let s = |c: &str| source.and_then(|s| s.get(c)).cloned().unwrap_or(Value::Null);
    let info = json!({
        "projectId": s("projectId"), "versionId": s("versionId"), "name": p.index["name"], "version": p.index["versionId"], "icon": s("icon"),
        "files": fichiers.iter().map(|f| f.rel.clone()).collect::<Vec<_>>(),
    });
    changer_modpack(racine, &instance.id, info)?;
    lire(racine, &instance.id).ok_or_else(|| Erreur::new(t("instances.instance_introuvable")))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MiseAJourPack {
    pub instance: Instance,
    pub removed: usize,
    pub files: usize,
}

/// Met à jour une instance issue d'un modpack : fichiers retirés du pack → corbeille, nouveaux fichiers téléchargés.
pub async fn mettre_a_jour_pack(
    jeu: &Jeu,
    instance: &Instance,
    octets: Vec<u8>,
    source: Option<&Value>,
    corbeille: Corbeille<'_>,
    annule: Option<CancellationToken>,
    suivi: Suivi,
) -> Resultat<MiseAJourPack> {
    let racine = &jeu.dossiers.racine;
    let p = lire_pack(octets)?;
    let version_loader = if p.loader == "vanilla" {
        None
    } else {
        Some(jeu.version_loader_du_pack(&p.loader, &p.mc, p.version_loader_pack.as_deref().unwrap_or("")).await?)
    };
    let dossier_jeu = dossier(racine, &instance.id).join("minecraft");
    let fichiers = taches_fichiers(&dossier_jeu, &p.index)?;
    let gardes: Vec<&String> = fichiers.iter().map(|f| &f.rel).collect();
    let mut retires = 0;
    let anciens: Vec<String> = instance
        .modpack
        .as_ref()
        .and_then(|m| m["files"].as_array())
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(String::from)
        .collect();
    for rel in anciens.iter().filter(|r| !gardes.contains(r)) {
        let cible = cible_sure(&dossier_jeu, rel)?;
        if cible.exists() {
            corbeille(&cible)?;
            retires += 1;
        }
    }
    jeu.telechargeur.tous(fichiers.iter().map(|f| f.tache.clone()).collect(), 16, false, annule, suivi).await?;
    appliquer_overrides(&p, &dossier_jeu, true)?;
    modifier(racine, &instance.id, &json!({ "version": p.mc, "loader": p.loader, "loaderVersion": version_loader }))?;
    let mut info = instance.modpack.clone().filter(Value::is_object).unwrap_or_else(|| json!({}));
    let s = |c: &str| source.and_then(|s| s.get(c)).cloned().filter(|v| !v.is_null());
    info["projectId"] = s("projectId").or_else(|| info.get("projectId").cloned()).unwrap_or(Value::Null);
    info["versionId"] = s("versionId").unwrap_or(Value::Null);
    info["name"] = p.index["name"].clone();
    info["version"] = p.index["versionId"].clone();
    info["files"] = json!(fichiers.iter().map(|f| f.rel.clone()).collect::<Vec<_>>());
    changer_modpack(racine, &instance.id, info)?;
    let instance = lire(racine, &instance.id).ok_or_else(|| Erreur::new(t("instances.instance_introuvable")))?;
    Ok(MiseAJourPack { instance, removed: retires, files: fichiers.len() })
}

/// Dernière version Modrinth d'un modpack installé, si elle est différente. Une bêta n'est proposée qu'à qui en a une.
pub async fn verifier_mise_a_jour(jeu: &Jeu, instance: &Instance) -> Resultat<Option<Value>> {
    let Some(pack) = instance.modpack.as_ref() else { return Ok(None) };
    let Some(projet) = pack["projectId"].as_str() else { return Ok(None) };
    let l = Modrinth::new(jeu.reseau()).versions(projet, &[], None).await?;
    let i = l.iter().position(|v| pack["versionId"].as_str() == Some(v.id.as_str()));
    let plus_recentes = match i {
        Some(i) => &l[..i],
        None => &l[..],
    };
    let genre_installe = i.map_or("release", |i| l[i].genre.as_str());
    let suivante = if genre_installe == "release" { plus_recentes.iter().find(|v| v.genre == "release") } else { plus_recentes.first() };
    Ok(suivante.map(|v| json!({ "versionId": v.id, "number": v.number, "type": v.genre })))
}

fn parcourir(d: &Path, base: &Path, sortie: &mut Vec<String>) {
    let Ok(it) = std::fs::read_dir(d) else { return };
    for e in it.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => parcourir(&p, base, sortie),
            Ok(t) if t.is_file() => {
                if let Ok(r) = p.strip_prefix(base) {
                    sortie.push(r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
                }
            }
            _ => {}
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Export {
    #[serde(skip)]
    pub octets: Vec<u8>,
    pub referenced: usize,
    pub embedded: usize,
}

/// Exporte une instance en .mrpack : les fichiers connus de Modrinth sont référencés (le pack reste léger), les
/// autres (mods locaux, configuration) sont copiés dans « overrides/ ».
pub async fn exporter_pack(jeu: &Jeu, instance: &Instance, dossier_jeu: &Path, nom: &str, version: &str, resume: &str) -> Resultat<Export> {
    let mut candidats: Vec<(&str, String, bool)> = vec![];
    for g in GENRES {
        let d = genre(g)?.dossier;
        let mut l = vec![];
        parcourir(&dossier_jeu.join(d), &dossier_jeu.join(d), &mut l);
        // Désactivé : pas dans le pack.
        for rel in l.into_iter().filter(|r| !r.ends_with(".disabled")) {
            candidats.push((g, format!("{d}/{rel}"), !rel.contains('/')));
        }
    }
    let mut lus = vec![];
    for (g, rel, haut) in candidats {
        let octets = std::fs::read(crate::installation::sous(dossier_jeu, &rel))?;
        let s1 = sha1(&octets);
        let s512: String = sha2::Sha512::digest(&octets).iter().map(|b| format!("{b:02x}")).collect();
        lus.push((g, rel, haut, octets, s1, s512));
    }
    // Hors connexion : tout part dans overrides/.
    let connues = Modrinth::new(jeu.reseau())
        .versions_par_empreinte(&lus.iter().filter(|f| f.2).map(|f| f.4.clone()).collect::<Vec<_>>())
        .await
        .unwrap_or_default();
    let mut fichiers = vec![];
    let mut archive: Vec<(String, Vec<u8>)> = vec![];
    for (g, rel, haut, octets, s1, s512) in lus {
        let distant = connues.get(&s1).filter(|_| haut).and_then(|v| v.files.iter().find(|x| x.sha1 == s1));
        match distant {
            Some(d) => fichiers.push(json!({
                "path": rel,
                "hashes": { "sha1": s1, "sha512": if d.sha512.is_empty() { s512 } else { d.sha512.clone() } },
                "env": { "client": "required", "server": if g == "mods" { "required" } else { "unsupported" } },
                "downloads": [d.url],
                "fileSize": octets.len(),
            })),
            None => archive.push((format!("overrides/{rel}"), octets)),
        }
    }
    let mut config = vec![];
    parcourir(&dossier_jeu.join("config"), &dossier_jeu.join("config"), &mut config);
    for rel in config {
        archive.push((format!("overrides/config/{rel}"), std::fs::read(crate::installation::sous(&dossier_jeu.join("config"), &rel))?));
    }
    let n = fichiers.len();
    let mut dependances = serde_json::Map::new();
    dependances.insert("minecraft".into(), instance.version.clone().into());
    if instance.loader != "vanilla" {
        let v = version_pour_pack(&instance.loader, &instance.version, instance.loader_version.as_deref().unwrap_or(""));
        dependances.insert(cle_de_loader(&instance.loader).into(), v.into());
    }
    let mut index = json!({ "formatVersion": 1, "game": "minecraft", "versionId": version, "name": nom, "files": fichiers, "dependencies": dependances });
    if !resume.is_empty() {
        index["summary"] = resume.into();
    }
    let texte = serde_json::to_vec_pretty(&index).map_err(|e| Erreur::new(e.to_string()))?;
    let mut entrees: Vec<(&str, &[u8])> = vec![("modrinth.index.json", &texte)];
    entrees.extend(archive.iter().map(|(n, o)| (n.as_str(), o.as_slice())));
    Ok(Export { octets: zip::creer_zip(&entrees), referenced: n, embedded: archive.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jeu_() -> PathBuf {
        PathBuf::from("C:/instances/pack/minecraft")
    }

    #[test]
    fn chemins_dans_le_dossier_du_jeu() {
        let g = jeu_();
        assert_eq!(cible_sure(&g, "mods/sodium.jar").unwrap(), g.join("mods").join("sodium.jar"));
        assert_eq!(cible_sure(&g, "config\\iris.properties").unwrap(), g.join("config").join("iris.properties"));
        assert_eq!(cible_sure(&g, "mods/../config/a.txt").unwrap(), g.join("config").join("a.txt"));
        for rel in [
            "../evil.jar",
            "mods/../../evil.jar",
            "..\\..\\evil.dll",
            "/etc/passwd",
            "C:/Windows/evil.dll",
            "",
            ".",
            "mods/..",
            "../minecraft-evil/x.jar",
        ] {
            assert!(cible_sure(&g, rel).is_err(), "{rel}");
        }
    }

    #[test]
    fn sources_autorisees_et_fichiers_serveur() {
        let g = jeu_();
        let f = |p: &str, url: &str, env: Value| json!({ "path": p, "downloads": [url], "hashes": { "sha1": "a".repeat(40) }, "fileSize": 10, "env": env });
        let t = taches_fichiers(
            &g,
            &json!({ "files": [
                f("mods/sodium.jar", "https://cdn.modrinth.com/data/AANobbMI/versions/x/sodium.jar", Value::Null),
                f("mods/serveur.jar", "https://cdn.modrinth.com/data/x/serveur.jar", json!({ "client": "unsupported", "server": "required" })),
            ]}),
        )
        .unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!((t[0].tache.chemin.clone(), t[0].rel.as_str()), (g.join("mods").join("sodium.jar"), "mods/sodium.jar"));
        for (p, url) in [
            ("mods/a.jar", "https://exemple.com/a.jar"),
            ("mods/a.jar", "http://cdn.modrinth.com/a.jar"),
            ("../a.jar", "https://cdn.modrinth.com/a.jar"),
        ] {
            assert!(taches_fichiers(&g, &json!({ "files": [f(p, url, Value::Null)] })).is_err(), "{p} {url}");
        }
    }

    fn pack(index: Value) -> Vec<u8> {
        zip::creer_zip(&[("modrinth.index.json", index.to_string().as_bytes())])
    }

    fn index() -> Value {
        json!({ "formatVersion": 1, "game": "minecraft", "versionId": "1.0", "name": "Pack", "files": [], "dependencies": { "minecraft": "1.21.1", "fabric-loader": "0.17.2" } })
    }

    #[test]
    fn lecture_de_l_index() {
        let p = lire_pack(pack(index())).unwrap();
        assert_eq!((p.mc.as_str(), p.loader.as_str(), p.version_loader_pack.as_deref()), ("1.21.1", "fabric", Some("0.17.2")));
        let mut vanilla = index();
        vanilla["dependencies"] = json!({ "minecraft": "1.21.1" });
        assert_eq!(lire_pack(pack(vanilla)).unwrap().loader, "vanilla");
        assert!(lire_pack(b"pas un zip".to_vec()).is_err());
        assert!(lire_pack(zip::creer_zip(&[("autre.json", b"{}".as_slice())])).is_err());
        let mut autre = index();
        autre["game"] = "autre".into();
        assert!(lire_pack(pack(autre)).is_err());
        let mut lite = index();
        lite["dependencies"] = json!({ "minecraft": "1.21.1", "liteloader": "1" });
        assert!(lire_pack(pack(lite)).is_err());
    }

    #[tokio::test]
    async fn export_hors_ligne_puis_installation_vanilla() {
        use crate::chemins::Dossiers;
        use crate::essai::Dossier;
        use crate::net::Reseau;
        let d = Dossier::nouveau("modpacks");
        // Modrinth injoignable : tout part dans overrides/.
        unsafe { std::env::set_var("LAUNCHER_MODRINTH_API", "http://127.0.0.1:9/v2") };
        let r = Arc::new(Reseau::new());
        r.pour_essais(&["127.0.0.1"], 1);
        let jeu = Jeu::new(Dossiers::new(&d.0.join("racine")), r);
        let i = creer(&jeu.dossiers.racine, &json!({ "name": "Source", "version": "1.21.1" }), &Reglages::default()).unwrap();
        let dj = dossier(&jeu.dossiers.racine, &i.id).join("minecraft");
        d.ecrire("racine/instances/source/minecraft/resourcepacks/pack.zip", "zip");
        d.ecrire("racine/instances/source/minecraft/resourcepacks/vieux.zip.disabled", "zip");
        d.ecrire("racine/instances/source/minecraft/config/a/b.toml", "x=1");
        let e = exporter_pack(&jeu, &i, &dj, "Mon pack", "1.0", "").await.unwrap();
        assert_eq!((e.referenced, e.embedded), (0, 2));
        let p = lire_pack(e.octets.clone()).unwrap();
        assert_eq!((p.mc.as_str(), p.loader.as_str()), ("1.21.1", "vanilla"));
        assert!(p.entrees.iter().any(|x| x.name == "overrides/config/a/b.toml"));

        let installee = installer_pack(&jeu, e.octets, &Reglages::default(), None, None, None, &|_| {}).await.unwrap();
        assert_eq!((installee.name.as_str(), installee.version.as_str()), ("Mon pack", "1.21.1"));
        let copie = dossier(&jeu.dossiers.racine, &installee.id).join("minecraft");
        assert_eq!(std::fs::read_to_string(copie.join("resourcepacks/pack.zip")).unwrap(), "zip");
        assert_eq!(installee.modpack.as_ref().unwrap()["files"], json!([]));
        unsafe { std::env::remove_var("LAUNCHER_MODRINTH_API") };
    }
}
