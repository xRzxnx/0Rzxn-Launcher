//! Contenu d'une instance : mods, packs de ressources et shaders, fichiers locaux + Modrinth, comme core/content.js.

use crate::base::Base;
use crate::empreintes::{Etat, rappeler, retenir};
use crate::erreur::{Erreur, Resultat};
use crate::i18n::{t, tv};
use crate::jeu::Jeu;
use crate::modrinth::{Modrinth, Version, choisir_version};
use crate::telechargement::{Tache, sha1};
use crate::zip;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use commun::Instance;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

const DESACTIVE: &str = ".disabled";
const ICONE_MAX: usize = 300 * 1024;

/// Type de contenu : dossier, type de projet Modrinth, extension, dossiers acceptés.
pub struct Genre {
    pub dossier: &'static str,
    pub projet: &'static str,
    pub extension: &'static str,
    pub dossiers: bool,
}

pub const GENRES: [&str; 3] = ["mods", "resourcepacks", "shaders"];

pub fn genre(g: &str) -> Resultat<Genre> {
    match g {
        "mods" => Ok(Genre { dossier: "mods", projet: "mod", extension: ".jar", dossiers: false }),
        "resourcepacks" => Ok(Genre { dossier: "resourcepacks", projet: "resourcepack", extension: ".zip", dossiers: true }),
        "shaders" => Ok(Genre { dossier: "shaderpacks", projet: "shader", extension: ".zip", dossiers: true }),
        _ => Err(Erreur::new(t("content.type_de_contenu_inconnu"))),
    }
}

/// Loaders Modrinth compatibles avec l'instance pour ce type de contenu.
pub fn loaders_pour(g: &str, instance: &Instance) -> Vec<String> {
    match g {
        "resourcepacks" => vec!["minecraft".into()],
        "shaders" => vec!["iris".into(), "optifine".into()],
        _ if instance.loader == "vanilla" || instance.loader.is_empty() => vec![],
        _ if instance.loader == "quilt" => vec!["quilt".into(), "fabric".into()],
        _ => vec![instance.loader.clone()],
    }
}

pub fn dossier_contenu(dossier_jeu: &Path, g: &str) -> Resultat<PathBuf> {
    Ok(dossier_jeu.join(genre(g)?.dossier))
}

/// Nom de fichier sûr, présent dans le dossier (pas de « ../ »).
pub fn chemin_sur(dossier: &Path, nom: &str) -> Resultat<PathBuf> {
    if nom.is_empty() || nom.contains(['/', '\\']) || nom == "." || nom == ".." {
        return Err(Erreur::new(t("content.nom_de_fichier_invalide")));
    }
    let f = dossier.join(nom);
    if !f.exists() {
        return Err(Erreur::new(t("content.fichier_introuvable")));
    }
    Ok(f)
}

pub use crate::texte::comparer as comparer_texte;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MiseAJour {
    pub version_id: String,
    pub number: String,
}

/// Fichier de contenu, avec ses métadonnées locales et, en ligne, son projet Modrinth.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub file: String,
    pub enabled: bool,
    pub size: u64,
    pub is_folder: bool,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub mod_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_versions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<MiseAJour>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct ListeContenu {
    pub kind: String,
    pub folder: PathBuf,
    pub online: bool,
    pub items: Vec<Element>,
}

/// Métadonnées lues dans une archive : (modId, nom, version, description, icône).
#[derive(Debug, Default, PartialEq)]
pub struct Meta {
    pub mod_id: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub description: Option<String>,
    pub icon: Option<String>,
}

fn icone(octets: &[u8], entrees: &[zip::Entree], chemin: Option<&str>) -> Option<String> {
    let chemin = chemin?.trim_start_matches('/');
    let e = entrees.iter().find(|e| e.name == chemin)?;
    let d = zip::lire_entree(octets, e).ok()?;
    if d.len() > ICONE_MAX {
        return None;
    }
    let genre = if chemin.to_lowercase().ends_with(".webp") { "image/webp" } else { "image/png" };
    Some(format!("data:{genre};base64,{}", B64.encode(d)))
}

fn lire(octets: &[u8], entrees: &[zip::Entree], nom: &str) -> Option<Vec<u8>> {
    entrees.iter().find(|e| e.name == nom).and_then(|e| zip::lire_entree(octets, e).ok())
}

fn valeur_toml(texte: &str, cle: &str) -> Option<String> {
    let r = Regex::new(&format!(r#"(?m)^\s*{cle}\s*=\s*["']([^"'\n]*)["']"#)).ok()?;
    r.captures(texte).map(|c| c[1].to_string())
}

fn texte_json(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(l) => l.iter().map(texte_json).collect(),
        Value::Object(_) => {
            format!("{}{}", texte_json(v.get("text").unwrap_or(&Value::Null)), texte_json(v.get("extra").unwrap_or(&Value::Null)))
        }
        _ => String::new(),
    }
}

/// Nom, version, description et icône lus dans un jar de mod (Fabric, Quilt, Forge, NeoForge, ancien Forge).
pub fn meta_mod(octets: &[u8], entrees: &[zip::Entree]) -> Meta {
    let json = |nom: &str| lire(octets, entrees, nom).and_then(|o| serde_json::from_slice::<Value>(&o).ok());
    let s = |v: &Value, c: &str| v.get(c).and_then(Value::as_str).map(String::from);
    if let Some(f) = json("fabric.mod.json") {
        let chemin_icone = match f.get("icon") {
            Some(Value::Object(m)) => {
                m.iter().max_by_key(|(k, _)| k.parse::<u32>().unwrap_or(0)).and_then(|(_, v)| v.as_str()).map(String::from)
            }
            v => v.and_then(Value::as_str).map(String::from),
        };
        return Meta {
            mod_id: s(&f, "id"),
            name: s(&f, "name").or_else(|| s(&f, "id")),
            version: s(&f, "version"),
            description: s(&f, "description"),
            icon: icone(octets, entrees, chemin_icone.as_deref()),
        };
    }
    if let Some(q) = json("quilt.mod.json").and_then(|q| q.get("quilt_loader").cloned()) {
        let m = q.get("metadata").cloned().unwrap_or_default();
        return Meta {
            mod_id: s(&q, "id"),
            name: s(&m, "name").or_else(|| s(&q, "id")),
            version: s(&q, "version"),
            description: s(&m, "description"),
            icon: icone(octets, entrees, m.get("icon").and_then(Value::as_str)),
        };
    }
    let toml = lire(octets, entrees, "META-INF/neoforge.mods.toml").or_else(|| lire(octets, entrees, "META-INF/mods.toml"));
    if let Some(toml) = toml.map(|o| String::from_utf8_lossy(&o).into_owned()) {
        let section = toml.find("[[mods]]").map_or(toml.as_str(), |i| &toml[i..]);
        let mut version = valeur_toml(section, "version");
        if version.as_deref() == Some("${file.jarVersion}") {
            let manifeste =
                lire(octets, entrees, "META-INF/MANIFEST.MF").map(|o| String::from_utf8_lossy(&o).into_owned()).unwrap_or_default();
            if let Some(v) = manifeste.lines().find_map(|l| l.strip_prefix("Implementation-Version:")) {
                version = Some(v.trim().to_string());
            }
        }
        let logo = valeur_toml(section, "logoFile").or_else(|| valeur_toml(&toml, "logoFile"));
        return Meta {
            mod_id: valeur_toml(section, "modId"),
            name: valeur_toml(section, "displayName"),
            version,
            description: valeur_toml(section, "description"),
            icon: icone(octets, entrees, logo.as_deref()),
        };
    }
    let mcmod = json("mcmod.info");
    let info = match &mcmod {
        Some(Value::Array(l)) => l.first().cloned(),
        Some(v) => v.pointer("/modList/0").cloned(),
        None => None,
    };
    match info {
        Some(i) => Meta {
            mod_id: s(&i, "modid"),
            name: s(&i, "name"),
            version: s(&i, "version"),
            description: s(&i, "description"),
            icon: icone(octets, entrees, i.get("logoFile").and_then(Value::as_str)),
        },
        None => Meta::default(),
    }
}

pub fn meta_pack(octets: &[u8], entrees: &[zip::Entree]) -> Meta {
    static SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new("§.").unwrap());
    let description = lire(octets, entrees, "pack.mcmeta")
        .and_then(|o| serde_json::from_slice::<Value>(&o).ok())
        .map(|v| texte_json(v.pointer("/pack/description").unwrap_or(&Value::Null)))
        .map(|d| SECTION.replace_all(&d, "").into_owned());
    Meta { description, icon: icone(octets, entrees, Some("pack.png")), ..Meta::default() }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Garde {
    name: String,
    version: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    mod_id: Option<String>,
}

/// Une ancienne version remplacée part à la corbeille (fournie par l'app).
pub type Corbeille<'a> = &'a (dyn Fn(&Path) -> Resultat<()> + Send + Sync);

pub struct Contenu {
    pub jeu: Arc<Jeu>,
    pub base: Arc<Base>,
    cache: Mutex<HashMap<PathBuf, (Etat, Element)>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installe {
    pub project_id: String,
    pub version: String,
    pub file: String,
    pub dependency: bool,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub installed: Vec<Installe>,
    pub missing_dependencies: usize,
}

impl Contenu {
    pub fn new(jeu: Arc<Jeu>, base: Arc<Base>) -> Self {
        Self { jeu, base, cache: Mutex::default() }
    }

    pub fn modrinth(&self) -> Modrinth<'_> {
        Modrinth::new(self.jeu.reseau())
    }

    fn lire_element(&self, dossier: &Path, nom: &str, est_dossier: bool, g: &str) -> Option<Element> {
        let f = dossier.join(nom);
        let m = std::fs::metadata(&f).ok()?;
        let etat = Etat::de(&m);
        let enabled = !nom.ends_with(DESACTIVE);
        let affiche = nom.replace(DESACTIVE, "");
        let affiche =
            ["jar", "zip", "JAR", "ZIP"].iter().fold(affiche, |a, x| a.strip_suffix(&format!(".{x}")).map(String::from).unwrap_or(a));
        let base =
            Element { file: nom.into(), enabled, size: m.len(), is_folder: est_dossier, name: affiche.clone(), ..Default::default() };
        if est_dossier {
            return Some(base);
        }
        let complet = |e: &Element| Element { file: base.file.clone(), enabled, size: m.len(), is_folder: false, ..e.clone() };
        if let Some((k, e)) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).get(&f)
            && *k == etat
        {
            return Some(complet(e));
        }
        // Déjà lu lors d'une ouverture précédente du launcher (launcher.db) : pas besoin de relire le jar.
        let cle = f.to_string_lossy().into_owned();
        if let Some((s, v)) = rappeler(&self.base, &cle, etat, "content")
            && let Ok(g) = serde_json::from_value::<Garde>(v)
        {
            let e = Element {
                sha1: Some(s),
                name: g.name,
                version: g.version,
                description: g.description,
                icon: g.icon,
                mod_id: g.mod_id,
                ..base.clone()
            };
            self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(f, (etat, e.clone()));
            return Some(e);
        }
        let octets = std::fs::read(&f).ok()?;
        let empreinte = sha1(&octets);
        let meta = zip::lister_entrees(&octets)
            .map(|l| if g == "mods" { meta_mod(&octets, &l) } else { meta_pack(&octets, &l) })
            .unwrap_or_default();
        let e = Element {
            sha1: Some(empreinte.clone()),
            name: meta.name.filter(|n| !n.is_empty()).unwrap_or(affiche),
            version: meta.version,
            description: meta.description,
            icon: meta.icon,
            mod_id: meta.mod_id,
            ..base
        };
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).insert(f, (etat, e.clone()));
        let garde = Garde {
            name: e.name.clone(),
            version: e.version.clone(),
            description: e.description.clone(),
            icon: e.icon.clone(),
            mod_id: e.mod_id.clone(),
        };
        retenir(&self.base, &cle, etat, &empreinte, "content", serde_json::to_value(garde).unwrap_or_default());
        Some(e)
    }

    /// Contenu installé. Avec `en_ligne`, chaque fichier est identifié sur Modrinth et comparé à la dernière version.
    pub async fn lister(&self, dossier_jeu: &Path, g: &str, instance: &Instance, en_ligne: bool) -> Resultat<ListeContenu> {
        let info = genre(g)?;
        let dossier = dossier_jeu.join(info.dossier);
        std::fs::create_dir_all(&dossier)?;
        let mut items = vec![];
        for e in std::fs::read_dir(&dossier)?.flatten() {
            let nom = e.file_name().to_string_lossy().into_owned();
            let Ok(t) = e.file_type() else { continue };
            let garde =
                if t.is_dir() { info.dossiers } else { t.is_file() && nom.replace(DESACTIVE, "").to_lowercase().ends_with(info.extension) };
            // Fichier en cours d'écriture ou supprimé entre-temps : ignoré.
            if garde && let Some(el) = self.lire_element(&dossier, &nom, t.is_dir(), g) {
                items.push(el);
            }
        }
        let mut identifie = false;
        if en_ligne {
            identifie = self.identifier(&mut items, g, instance).await.is_ok();
        }
        items.sort_by(|a, b| comparer_texte(a.title.as_ref().unwrap_or(&a.name), b.title.as_ref().unwrap_or(&b.name)));
        Ok(ListeContenu { kind: g.into(), folder: dossier, online: identifie, items })
    }

    async fn identifier(&self, items: &mut [Element], g: &str, instance: &Instance) -> Resultat<()> {
        let m = self.modrinth();
        let empreintes: Vec<String> = items.iter().filter_map(|i| i.sha1.clone()).collect();
        let connues = m.versions_par_empreinte(&empreintes).await?;
        let ids: Vec<String> = connues.values().map(|v| v.project_id.clone()).collect::<HashSet<_>>().into_iter().collect();
        let projets: HashMap<String, _> = m.projets(&ids).await?.into_iter().map(|p| (p.id.clone(), p)).collect();
        let cles: Vec<String> = connues.keys().cloned().collect();
        let dernieres = m.dernieres_par_empreinte(&cles, &loaders_pour(g, instance), &instance.version).await?;
        for item in items.iter_mut() {
            let Some(v) = item.sha1.as_ref().and_then(|s| connues.get(s)) else { continue };
            let p = projets.get(&v.project_id);
            item.project_id = Some(v.project_id.clone());
            item.version_id = Some(v.id.clone());
            item.version = Some(v.number.clone());
            item.slug = p.map(|p| p.slug.clone());
            item.title = Some(p.map_or(item.name.clone(), |p| p.title.clone()));
            if let Some(i) = p.and_then(|p| p.icon.clone()) {
                item.icon = Some(i);
            }
            item.game_versions = Some(v.game_versions.clone());
            // Une bêta n'est proposée qu'à qui utilise déjà une bêta.
            if let Some(n) = item.sha1.as_ref().and_then(|s| dernieres.get(s))
                && n.id != v.id
                && n.file.is_some()
                && (v.genre != "release" || n.genre == "release")
            {
                item.update = Some(MiseAJour { version_id: n.id.clone(), number: n.number.clone() });
            }
        }
        Ok(())
    }

    /// Avant de passer l'instance en `cible` : pour chaque fichier actif, ce qui arrivera (same, update, missing, unknown).
    /// `differents` : jars (mods) qui annoncent une autre version de Minecraft.
    pub async fn plan_de_version(
        &self,
        dossier_jeu: &Path,
        instance: &Instance,
        cible: &str,
        differents: &HashSet<String>,
    ) -> Resultat<Vec<Value>> {
        let mut plan = vec![];
        let m = self.modrinth();
        for g in GENRES {
            let loaders = loaders_pour(g, instance);
            if g == "mods" && loaders.is_empty() {
                continue;
            }
            let l = self.lister(dossier_jeu, g, instance, false).await?;
            let actifs: Vec<&Element> = l.items.iter().filter(|i| i.enabled && i.sha1.is_some()).collect();
            if actifs.is_empty() {
                continue;
            }
            let connues = m.versions_par_empreinte(&actifs.iter().filter_map(|i| i.sha1.clone()).collect::<Vec<_>>()).await?;
            let dernieres = m.dernieres_par_empreinte(&connues.keys().cloned().collect::<Vec<_>>(), &loaders, cible).await?;
            for item in actifs {
                let s = item.sha1.as_deref().unwrap_or("");
                let v = connues.get(s);
                let (sort, numero) = match v {
                    None if g == "mods" && differents.contains(&item.file) => ("missing", None),
                    None => ("unknown", None),
                    Some(v) if v.game_versions.iter().any(|x| x == cible) => ("same", None),
                    Some(_) => match dernieres.get(s).filter(|d| d.file.is_some()) {
                        Some(d) => ("update", Some(d.number.clone())),
                        None => ("missing", None),
                    },
                };
                plan.push(json!({ "kind": g, "file": item.file, "name": item.name, "fate": sort, "number": numero, "known": v.is_some() }));
            }
        }
        Ok(plan)
    }

    pub fn basculer(&self, dossier_jeu: &Path, g: &str, fichier: &str) -> Resultat<()> {
        let dossier = dossier_contenu(dossier_jeu, g)?;
        let source = chemin_sur(&dossier, fichier)?;
        let cible = match fichier.strip_suffix(DESACTIVE) {
            Some(actif) => dossier.join(actif),
            None => dossier.join(format!("{fichier}{DESACTIVE}")),
        };
        Ok(std::fs::rename(source, cible)?)
    }

    /// Installe un projet Modrinth (et, pour les mods, ses dépendances obligatoires). Une ancienne version du même
    /// projet part à la corbeille.
    pub async fn installer(
        &self,
        dossier_jeu: &Path,
        g: &str,
        instance: &Instance,
        projet: &str,
        version: Option<&str>,
        corbeille: Corbeille<'_>,
    ) -> Resultat<Installation> {
        let info = genre(g)?;
        let dossier = dossier_jeu.join(info.dossier);
        let loaders = loaders_pour(g, instance);
        if g == "mods" && loaders.is_empty() {
            return Err(Erreur::new(t("content.cette_instance_est_vanilla_ajoute")));
        }
        let actuel = self.lister(dossier_jeu, g, instance, true).await?;
        let m = self.modrinth();
        let mut faits: Vec<(String, String, String, bool)> = vec![];
        let mut ignores = 0usize;
        let mut vus: HashSet<String> = HashSet::new();
        // File de projets à installer : (projet, version, dépendance).
        let mut file: Vec<(Option<String>, Option<String>, bool)> = vec![(Some(projet.into()), version.map(String::from), false)];
        while let Some((pid, vid, dependance)) = file.pop() {
            let pid = match (pid, &vid) {
                (Some(p), _) => p,
                (None, Some(v)) => m.version(v).await?.project_id,
                (None, None) => continue,
            };
            if !vus.insert(pid.clone()) {
                continue;
            }
            let existants: Vec<&Element> = actuel.items.iter().filter(|i| i.project_id.as_deref() == Some(pid.as_str())).collect();
            // Dépendance déjà présente, éventuellement à réactiver.
            if dependance && !existants.is_empty() {
                if !existants.iter().any(|i| i.enabled) {
                    self.basculer(dossier_jeu, g, &existants[0].file)?;
                }
                continue;
            }
            let v: Option<Version> = match &vid {
                Some(v) => Some(m.version(v).await?),
                None => choisir_version(&m.versions(&pid, &loaders, Some(&instance.version)).await?).cloned(),
            };
            let Some(v) = v.filter(|v| v.file.is_some()) else {
                if dependance {
                    ignores += 1;
                    continue;
                }
                let cle = if !loaders.is_empty() && g == "mods" { "content.no_version_loader" } else { "content.no_version" };
                return Err(Erreur::code(tv(cle, &[("version", &instance.version), ("loader", &instance.loader)]), "NO_VERSION"));
            };
            let f = v.file.clone().unwrap_or_default();
            if !existants.iter().any(|i| i.version_id.as_deref() == Some(v.id.as_str())) {
                let nom = f.filename.rsplit(['/', '\\']).next().unwrap_or("").to_string();
                if !nom.to_lowercase().ends_with(info.extension) {
                    return Err(Erreur::new(tv("content.fichier_inattendu", &[("filename", &nom)])));
                }
                let tache = Tache {
                    url: f.url.clone(),
                    chemin: dossier.join(&nom),
                    sha1: Some(f.sha1.clone()).filter(|s| !s.is_empty()),
                    sha512: Some(f.sha512.clone()).filter(|s| !s.is_empty()),
                    taille: Some(f.size).filter(|t| *t > 0),
                };
                self.jeu.telechargeur.fichier(tache, false, None, None).await?;
                for ancien in existants.iter().filter(|e| e.file != nom) {
                    corbeille(&dossier.join(&ancien.file))?;
                }
                faits.push((pid.clone(), v.number.clone(), nom, dependance));
            }
            if g == "mods" {
                for dep in v.dependencies.iter().filter(|d| d.get("dependency_type").and_then(Value::as_str) == Some("required")) {
                    let p = dep.get("project_id").and_then(Value::as_str).map(String::from);
                    let vd = dep.get("version_id").and_then(Value::as_str).map(String::from);
                    if p.is_none() && vd.is_none() {
                        ignores += 1; // fichier hors de Modrinth
                    } else {
                        file.push((p, vd, true));
                    }
                }
            }
        }
        let titres: HashMap<String, String> = m
            .projets(&faits.iter().map(|f| f.0.clone()).collect::<Vec<_>>())
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.id, p.title))
            .collect();
        let installed = faits
            .into_iter()
            .map(|(p, version, file, dependency)| Installe {
                title: titres.get(&p).cloned().unwrap_or_else(|| file.clone()),
                project_id: p,
                version,
                file,
                dependency,
            })
            .collect();
        Ok(Installation { installed, missing_dependencies: ignores })
    }

    /// Met à jour les fichiers indiqués (ou tous ceux qui ont une mise à jour).
    pub async fn mettre_a_jour(
        &self,
        dossier_jeu: &Path,
        g: &str,
        instance: &Instance,
        fichiers: Option<&[String]>,
        corbeille: Corbeille<'_>,
    ) -> Resultat<Vec<Installe>> {
        let actuel = self.lister(dossier_jeu, g, instance, true).await?;
        if !actuel.online {
            return Err(Erreur::new(t("content.modrinth_est_injoignable_mise_jour")));
        }
        let mut faits = vec![];
        for item in actuel.items.iter().filter(|i| i.update.is_some() && fichiers.is_none_or(|f| f.contains(&i.file))) {
            let (Some(p), Some(u)) = (&item.project_id, &item.update) else { continue };
            let r = self.installer(dossier_jeu, g, instance, p, Some(&u.version_id), corbeille).await?;
            faits.extend(r.installed.into_iter().filter(|d| !d.dependency));
        }
        Ok(faits)
    }

    /// Copie des fichiers glissés dans la fenêtre.
    pub fn importer(&self, dossier_jeu: &Path, g: &str, chemins: &[PathBuf]) -> Resultat<Vec<String>> {
        let info = genre(g)?;
        let dossier = dossier_jeu.join(info.dossier);
        std::fs::create_dir_all(&dossier)?;
        let mut copies = vec![];
        for source in chemins {
            let nom = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !nom.to_lowercase().ends_with(info.extension) || !source.is_file() {
                continue;
            }
            std::fs::copy(source, dossier.join(&nom))?;
            copies.push(nom);
        }
        Ok(copies)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chemins::Dossiers;
    use crate::essai::Dossier;
    use crate::net::Reseau;

    fn jar(fichiers: &[(&str, &[u8])]) -> Vec<u8> {
        zip::creer_zip(fichiers)
    }

    fn meta(o: &[u8], m: bool) -> Meta {
        let l = zip::lister_entrees(o).unwrap();
        if m { meta_mod(o, &l) } else { meta_pack(o, &l) }
    }

    #[test]
    fn metadonnees_des_jars_et_des_packs() {
        let fabric = jar(&[
            (
                "fabric.mod.json",
                br#"{"id":"sodium","name":"Sodium","version":"0.6","description":"Rapide","icon":{"16":"a.png","128":"b.png"}}"#.as_slice(),
            ),
            ("b.png", b"PNG".as_slice()),
        ]);
        let m = meta(&fabric, true);
        assert_eq!((m.mod_id.as_deref(), m.name.as_deref(), m.version.as_deref()), (Some("sodium"), Some("Sodium"), Some("0.6")));
        assert_eq!(m.icon.as_deref(), Some("data:image/png;base64,UE5H"));

        let neo = jar(&[
            (
                "META-INF/neoforge.mods.toml",
                b"modLoader=\"javafml\"\n[[mods]]\nmodId=\"jei\"\nversion=\"${file.jarVersion}\"\ndisplayName='Just Enough Items'\n"
                    .as_slice(),
            ),
            ("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\r\nImplementation-Version: 19.1\r\n".as_slice()),
        ]);
        let m = meta(&neo, true);
        assert_eq!((m.mod_id.as_deref(), m.name.as_deref(), m.version.as_deref()), (Some("jei"), Some("Just Enough Items"), Some("19.1")));

        let ancien = jar(&[("mcmod.info", br#"[{"modid":"ic2","name":"IC2","version":"2.8"}]"#.as_slice())]);
        assert_eq!(meta(&ancien, true).mod_id.as_deref(), Some("ic2"));
        let pack = jar(&[("pack.mcmeta", r#"{"pack":{"description":[{"text":"§aFaithful"},{"text":" 32x"}]}}"#.as_bytes())]);
        assert_eq!(meta(&pack, false).description.as_deref(), Some("Faithful 32x"));
        assert_eq!(meta(&jar(&[("rien", b"".as_slice())]), true), Meta::default());
    }

    #[tokio::test]
    async fn liste_bascule_et_import_hors_ligne() {
        let d = Dossier::nouveau("contenu");
        let jeu = Jeu::new(Dossiers::new(&d.0.join("racine")), Arc::new(Reseau::new()));
        let base = Arc::new(Base::ouvrir(&d.0.join("launcher.db")));
        let c = Contenu::new(jeu, base);
        let dj = d.0.join("jeu");
        std::fs::create_dir_all(dj.join("mods")).unwrap();
        std::fs::write(dj.join("mods/b.jar"), jar(&[("fabric.mod.json", br#"{"id":"b","name":"Bravo"}"#.as_slice())])).unwrap();
        std::fs::write(dj.join("mods/a.jar.disabled"), jar(&[("fabric.mod.json", br#"{"id":"a","name":"Alpha"}"#.as_slice())])).unwrap();
        std::fs::write(dj.join("mods/notes.txt"), "x").unwrap();
        let instance = Instance { loader: "fabric".into(), version: "1.21.11".into(), ..Default::default() };
        let l = c.lister(&dj, "mods", &instance, false).await.unwrap();
        assert_eq!(l.items.iter().map(|i| (i.name.as_str(), i.enabled)).collect::<Vec<_>>(), [("Alpha", false), ("Bravo", true)]);
        c.basculer(&dj, "mods", "a.jar.disabled").unwrap();
        assert!(dj.join("mods/a.jar").is_file());
        assert!(c.basculer(&dj, "mods", "../x.jar").is_err());
        // Relu depuis launcher.db par un nouveau lecteur.
        let c2 = Contenu::new(c.jeu.clone(), c.base.clone());
        assert_eq!(c2.lister(&dj, "mods", &instance, false).await.unwrap().items[0].name, "Alpha");
        std::fs::write(d.0.join("pack.zip"), b"zip").unwrap();
        std::fs::write(d.0.join("pas-un-pack.txt"), b"x").unwrap();
        assert_eq!(c.importer(&dj, "resourcepacks", &[d.0.join("pack.zip"), d.0.join("pas-un-pack.txt")]).unwrap(), ["pack.zip"]);
        assert!(
            c.installer(&dj, "mods", &Instance { loader: "vanilla".into(), ..instance.clone() }, "p", None, &|_| Ok(())).await.is_err()
        );
        assert_eq!(comparer_texte("Étoile", "etoile"), std::cmp::Ordering::Equal);
    }
}
