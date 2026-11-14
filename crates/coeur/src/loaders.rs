//! Loaders de mods : Fabric, Quilt, Forge, NeoForge, comme core/loaders.js. Chacun produit un fichier de version
//! qui « hérite » (inheritsFrom) de la version vanilla, exactement comme avec le launcher officiel.

use crate::erreur::{Erreur, Resultat};
use crate::fichiers::{ecrire_json, lire_json};
use crate::i18n::{t, tv};
use crate::installation::sous;
use crate::java::commande;
use crate::jeu::Jeu;
use crate::net::Options;
use crate::regles::chemin_maven;
use crate::telechargement::{Progression, Tache, empreinte_fichier};
use crate::zip;
use commun::loader_name;
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio_util::sync::CancellationToken;

pub const LOADERS: [&str; 4] = ["fabric", "quilt", "forge", "neoforge"];
const FABRIC: &str = "https://meta.fabricmc.net/v2";
const QUILT: &str = "https://meta.quiltmc.org/v3";
const FORGE_MAVEN: &str = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const NEOFORGE_MAVEN: &str = "https://maven.neoforged.net/releases/net/neoforged";
const MARQUE: &str = ".0rzxn-loader";
const GARDE: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersionLoader {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub stable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListeLoader {
    pub versions: Vec<VersionLoader>,
    pub recommended: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn stable(v: &str) -> bool {
    static INSTABLE: LazyLock<Regex> = LazyLock::new(|| Regex::new("(?i)(alpha|beta|rc|pre)").unwrap());
    !INSTABLE.is_match(v)
}

fn liste(versions: Vec<VersionLoader>, recommandee: Option<String>) -> ListeLoader {
    let recommended = recommandee.or_else(|| versions.iter().find(|v| v.stable).or(versions.first()).map(|v| v.id.clone()));
    ListeLoader { versions, recommended, error: None }
}

fn echapper(mc: &str) -> String {
    regex::escape(mc)
}

/// Numéro court d'une version Forge (« 1.20.1-47.4.0 » → « 47.4.0 », « 1.7.10-10.13.4.1614-1.7.10 » → « 10.13.4.1614 »).
pub fn libelle_forge(mc: &str, id: &str) -> String {
    let court = id.get(mc.len() + 1..).unwrap_or("");
    court.strip_suffix(&format!("-{mc}")).unwrap_or(court).to_string()
}

/// Versions Forge d'un Minecraft d'après le dépôt Maven, avec la version promue (recommandée, sinon dernière).
pub fn versions_forge(mc: &str, xml: &str, promos: &Value) -> ListeLoader {
    static VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new("<version>([^<]+)</version>").unwrap());
    let prefixe = format!("{mc}-");
    let ids: Vec<&str> = VERSION.captures_iter(xml).map(|c| c.get(1).unwrap().as_str()).filter(|v| v.starts_with(&prefixe)).collect();
    let ids: Vec<&str> = ids.into_iter().rev().collect();
    let promo = |genre: &str| {
        let p = promos.pointer(&format!("/promos/{mc}-{genre}")).and_then(Value::as_str)?;
        ids.iter().find(|id| libelle_forge(mc, id) == p).map(|id| id.to_string())
    };
    let recommandee = promo("recommended").or_else(|| promo("latest"));
    liste(
        ids.iter().map(|id| VersionLoader { id: id.to_string(), label: Some(libelle_forge(mc, id)), stable: true }).collect(),
        recommandee,
    )
}

/// NeoForge numérote ses versions d'après Minecraft : 1.21.11 → 21.11.x, 26.3 → 26.3.0.x. None : version inconnue.
pub fn prefixe_neoforge(mc: &str) -> Option<String> {
    static ANCIEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^1\.(\d+)(?:\.(\d+))?$").unwrap());
    static DEUX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\d+$").unwrap());
    static TROIS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\d+\.\d+$").unwrap());
    if let Some(c) = ANCIEN.captures(mc) {
        return Some(format!("{}.{}.", &c[1], c.get(2).map_or("0", |m| m.as_str())));
    }
    if DEUX.is_match(mc) {
        return Some(format!("{mc}.0."));
    }
    TROIS.is_match(mc).then(|| format!("{mc}."))
}

pub fn versions_neoforge(prefixe: &str, publiees: &Value) -> ListeLoader {
    let ids: Vec<&str> = publiees
        .get("versions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|v| v.starts_with(prefixe) && v[prefixe.len()..].split('.').count() <= 2)
        .collect();
    liste(ids.into_iter().rev().map(|id| VersionLoader { id: id.into(), label: None, stable: stable(id) }).collect(), None)
}

/// Adresse de l'installeur Forge ou NeoForge (1.20.1 : ancien artefact « forge » de NeoForge).
pub fn url_installeur(loader: &str, version: &str) -> String {
    if loader == "forge" {
        format!("{FORGE_MAVEN}/{version}/forge-{version}-installer.jar")
    } else if version.starts_with("1.20.1-") {
        format!("{NEOFORGE_MAVEN}/forge/{version}/forge-{version}-installer.jar")
    } else {
        format!("{NEOFORGE_MAVEN}/neoforge/{version}/neoforge-{version}-installer.jar")
    }
}

/// Inverse de la résolution des modpacks, pour l'export : « 1.20.1-47.4.22 » → « 47.4.22 ».
pub fn version_pour_pack(loader: &str, mc: &str, version: &str) -> String {
    if loader == "forge" || (loader == "neoforge" && mc == "1.20.1") {
        let e = echapper(mc);
        let debut = Regex::new(&format!("^{e}-")).unwrap();
        let fin = Regex::new(&format!("-{e}$")).unwrap();
        return fin.replace(&debut.replace(version, ""), "").into_owned();
    }
    version.into()
}

pub type Journal<'a> = &'a (dyn Fn(&str, &str) + Send + Sync);

/// Demande d'installation d'un loader. `java` lance les processeurs de Forge et NeoForge.
pub struct Demande<'a> {
    pub mc: &'a str,
    pub loader: &'a str,
    pub version: &'a str,
    pub java: &'a Path,
    pub annule: Option<CancellationToken>,
    pub progression: Option<Arc<dyn Fn(Progression) + Send + Sync>>,
    pub journal: Journal<'a>,
}

impl Jeu {
    async fn garder<F, Fut>(&self, cle: &str, charger: F) -> Resultat<Value>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Resultat<Value>>,
    {
        if let Some((quand, v)) = self.listes.lock().unwrap_or_else(|e| e.into_inner()).get(cle)
            && quand.elapsed() < GARDE
        {
            return Ok(v.clone());
        }
        let v = charger().await?;
        self.listes.lock().unwrap_or_else(|e| e.into_inner()).insert(cle.into(), (Instant::now(), v.clone()));
        Ok(v)
    }

    async fn json_simple(&self, url: &str) -> Resultat<Value> {
        self.reseau().json(url, &Options::default()).await
    }

    /// Réponse JSON, ou None si le service répond « version inconnue » (400/404).
    async fn json_ou_rien(&self, url: &str) -> Resultat<Option<Value>> {
        match self.reseau().json(url, &Options::default()).await {
            Ok(v) => Ok(Some(v)),
            Err(e) if matches!(e.statut, Some(400 | 404)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn fabric_ou_quilt(&self, base: &str, mc: &str) -> Resultat<ListeLoader> {
        let donnees = self.json_ou_rien(&format!("{base}/versions/loader/{}", encoder(mc))).await?;
        let versions = donnees
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|d| {
                let id = d.pointer("/loader/version")?.as_str()?;
                Some(VersionLoader {
                    id: id.into(),
                    label: None,
                    stable: d.pointer("/loader/stable").and_then(Value::as_bool).unwrap_or_else(|| stable(id)),
                })
            })
            .collect();
        Ok(liste(versions, None))
    }

    async fn forge(&self, mc: &str) -> Resultat<ListeLoader> {
        let xml = self
            .garder("forge-maven", || async {
                let o = self.reseau().octets(&format!("{FORGE_MAVEN}/maven-metadata.xml"), &Options::default()).await?;
                Ok(Value::String(String::from_utf8_lossy(&o).into_owned()))
            })
            .await?;
        let promos = self
            .garder("forge-promos", || self.json_simple("https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"))
            .await?;
        Ok(versions_forge(mc, xml.as_str().unwrap_or(""), &promos))
    }

    async fn neoforge(&self, mc: &str) -> Resultat<ListeLoader> {
        if mc == "1.20.1" {
            let d = self
                .garder("neoforge-legacy", || {
                    self.json_simple("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge")
                })
                .await?;
            let ids: Vec<&str> = d
                .get("versions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|v| v.starts_with("1.20.1-"))
                .collect();
            let versions =
                ids.into_iter().rev().map(|id| VersionLoader { id: id.into(), label: Some(id[7..].into()), stable: stable(id) }).collect();
            return Ok(liste(versions, None));
        }
        let Some(prefixe) = prefixe_neoforge(mc) else { return Ok(liste(vec![], None)) };
        let d = self
            .garder("neoforge", || self.json_simple("https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge"))
            .await?;
        Ok(versions_neoforge(&prefixe, &d))
    }

    /// Versions disponibles pour chaque loader et une version de Minecraft (un loader en panne n'empêche pas les autres).
    pub async fn loaders_disponibles(&self, mc: &str) -> Map<String, Value> {
        let un = |loader: &'static str| async move {
            let cle = format!("{loader}:{mc}");
            let r = self
                .garder(&cle, || async {
                    let l = match loader {
                        "fabric" => self.fabric_ou_quilt(FABRIC, mc).await?,
                        "quilt" => self.fabric_ou_quilt(QUILT, mc).await?,
                        "forge" => self.forge(mc).await?,
                        _ => self.neoforge(mc).await?,
                    };
                    Ok(serde_json::to_value(l).unwrap_or_default())
                })
                .await;
            let v = r.unwrap_or_else(|e| json!({ "versions": [], "recommended": null, "error": e.message }));
            (loader.to_string(), v)
        };
        futures_util::future::join_all(LOADERS.map(un)).await.into_iter().collect()
    }

    /// Format .mrpack → format du launcher : les modpacks écrivent « forge: 47.4.22 », le launcher « 1.20.1-47.4.22 ».
    pub async fn version_loader_du_pack(&self, loader: &str, mc: &str, valeur: &str) -> Resultat<String> {
        if loader == "forge" {
            let l = self.forge(mc).await?;
            return l
                .versions
                .into_iter()
                .find(|v| v.label.as_deref() == Some(valeur) || v.id == valeur)
                .map(|v| v.id)
                .ok_or_else(|| Erreur::new(tv("loaders.forge_introuvable_pour_minecraft", &[("packValue", valeur), ("mc", mc)])));
        }
        if loader == "neoforge" && mc == "1.20.1" && !valeur.starts_with("1.20.1-") {
            return Ok(format!("1.20.1-{valeur}"));
        }
        Ok(valeur.into())
    }

    fn deja_installe(&self, cle: &str) -> Option<String> {
        lire_json::<Map<String, Value>>(&self.dossiers.cache.join("loaders.json"))?.get(cle)?.as_str().map(String::from)
    }

    fn retenir(&self, cle: &str, id: &str) -> Resultat<()> {
        let fichier = self.dossiers.cache.join("loaders.json");
        let mut m: Map<String, Value> = lire_json(&fichier).unwrap_or_default();
        m.insert(cle.into(), id.into());
        Ok(ecrire_json(&fichier, &m)?)
    }

    /// Installe le loader et renvoie l'identifiant de version à lancer (ex. « fabric-loader-0.20.1-26.3 »).
    pub async fn installer_loader(&self, d: &Demande<'_>) -> Resultat<String> {
        match d.loader {
            "fabric" => self.installer_fabric_ou_quilt(d, FABRIC).await,
            "quilt" => self.installer_fabric_ou_quilt(d, QUILT).await,
            "forge" | "neoforge" => self.installer_avec_installeur(d).await,
            autre => Err(Erreur::new(tv("loaders.loader_inconnu", &[("loader", autre)]))),
        }
    }

    async fn installer_fabric_ou_quilt(&self, d: &Demande<'_>, base: &str) -> Resultat<String> {
        let url = format!("{base}/versions/loader/{}/{}/profile/json", encoder(d.mc), encoder(d.version));
        if let Some(id) = self.deja_installe(&url).filter(|id| self.fichiers_version(id).json.is_file()) {
            return Ok(id);
        }
        let profil: Value = self.reseau().json(&url, &Options::annulable(d.annule.as_ref())).await?;
        let id = profil.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        ecrire_json(&self.fichiers_version(&id).json, &profil)?;
        self.retenir(&url, &id)?;
        (d.journal)(&tv("loaders.profil_installe", &[("id", &id)]), "LAUNCHER");
        Ok(id)
    }

    async fn installer_avec_installeur(&self, d: &Demande<'_>) -> Resultat<String> {
        let url = url_installeur(d.loader, d.version);
        if let Some(id) = self
            .deja_installe(&url)
            .filter(|id| self.dossiers.versions.join(id).join(MARQUE).is_file() && self.fichiers_version(id).json.is_file())
        {
            return Ok(id);
        }
        let nom = loader_name(d.loader);
        (d.journal)(&tv("loaders.telechargement_de_installeur", &[("LOADER_NAMES", nom), ("loaderVersion", d.version)]), "LAUNCHER");
        let installeur = self.dossiers.cache.join("installers").join(url.rsplit('/').next().unwrap_or("installer.jar"));
        let o = Options::annulable(d.annule.as_ref());
        // Certains anciens installeurs n'ont pas d'empreinte publiée.
        let sha1 = match self.reseau().octets(&format!("{url}.sha1"), &o).await {
            Ok(s) => Some(String::from_utf8_lossy(&s).trim().chars().take(40).collect::<String>())
                .filter(|s| s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())),
            Err(e) if e.a_le_code("CANCELLED") => return Err(e),
            Err(_) => None,
        };
        let tache = Tache { url: url.clone(), chemin: installeur.clone(), sha1: sha1.map(|s| s.to_lowercase()), ..Default::default() };
        self.telechargeur.fichier(tache, false, d.annule.clone(), None).await?;

        let octets = std::fs::read(&installeur)?;
        let profil: Value = zip::lire_fichier(&octets, "install_profile.json")?
            .and_then(|p| serde_json::from_slice(&p).ok())
            .ok_or_else(|| Erreur::new(t("loaders.installeur_invalide_install_profile_json")))?;
        let id = if profil.get("versionInfo").is_some() {
            self.installer_ancien_forge(&profil, &octets)?
        } else {
            self.installer_moderne(d, &profil, &octets, &installeur).await?
        };
        std::fs::write(self.dossiers.versions.join(&id).join(MARQUE), &url)?;
        self.retenir(&url, &id)?;
        (d.journal)(&tv("loaders.installe", &[("LOADER_NAMES", nom), ("loaderVersion", d.version), ("id", &id)]), "LAUNCHER");
        Ok(id)
    }

    /// Forge 1.5 → 1.12 (ancien format) : le fichier de version est dans install_profile.json.
    fn installer_ancien_forge(&self, profil: &Value, installeur: &[u8]) -> Resultat<String> {
        let mut json = profil["versionInfo"].clone();
        let universel =
            sous(&self.dossiers.libraries, &chemin_maven(profil.pointer("/install/path").and_then(Value::as_str).unwrap_or("")));
        if !universel.is_file() {
            let interne = profil.pointer("/install/filePath").and_then(Value::as_str).unwrap_or("");
            let donnees = zip::lire_fichier(installeur, interne)?
                .ok_or_else(|| Erreur::new(t("loaders.installeur_forge_incomplet_jar_universel")))?;
            if let Some(p) = universel.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::write(&universel, donnees)?;
        }
        let libs: Vec<Value> = json
            .get("libraries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|l| l.get("clientreq") != Some(&Value::Bool(false))) // marquées « serveur uniquement »
            .map(|l| {
                let mut l = l.as_object().cloned().unwrap_or_default();
                for c in ["checksums", "clientreq", "serverreq"] {
                    l.remove(c);
                }
                if let Some(u) = l.get("url").and_then(Value::as_str) {
                    static ANCIEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^https?://files\.minecraftforge\.net/maven/?").unwrap());
                    let u = ANCIEN.replace(u, "https://maven.minecraftforge.net/").into_owned();
                    l.insert("url".into(), u.into());
                }
                Value::Object(l)
            })
            .collect();
        json["libraries"] = Value::Array(libs);
        let id = json.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        ecrire_json(&self.fichiers_version(&id).json, &json)?;
        Ok(id)
    }

    /// Forge 1.13+ (et 1.12.2 récent) et NeoForge : bibliothèques + processeurs Java.
    async fn installer_moderne(&self, d: &Demande<'_>, profil: &Value, installeur: &[u8], chemin_installeur: &Path) -> Resultat<String> {
        let interne = profil.get("json").and_then(Value::as_str).unwrap_or("").trim_start_matches('/');
        let version: Value = zip::lire_fichier(installeur, interne)?
            .and_then(|j| serde_json::from_slice(&j).ok())
            .ok_or_else(|| Erreur::new(t("loaders.installeur_invalide_install_profile_json")))?;
        let id = version.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        ecrire_json(&self.fichiers_version(&id).json, &version)?;

        // Bibliothèques : téléchargées, ou fournies dans le dossier maven/ de l'installeur.
        let mut taches = vec![];
        let libs = [profil, &version].into_iter().flat_map(|v| v.get("libraries").and_then(Value::as_array).cloned().unwrap_or_default());
        for lib in libs {
            let a = lib.pointer("/downloads/artifact");
            let rel = a
                .and_then(|a| a.get("path"))
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| chemin_maven(lib["name"].as_str().unwrap_or("")));
            let cible = sous(&self.dossiers.libraries, &rel);
            match a.and_then(|a| a.get("url")).and_then(Value::as_str).filter(|u| !u.is_empty()) {
                Some(url) => taches.push(Tache {
                    url: url.into(),
                    chemin: cible,
                    sha1: a.and_then(|a| a.get("sha1")).and_then(Value::as_str).map(String::from),
                    taille: a.and_then(|a| a.get("size")).and_then(Value::as_u64),
                    ..Default::default()
                }),
                // Sinon : fichier produit par un processeur (ex. le jeu patché).
                None if !cible.is_file() => {
                    if let Some(donnees) = zip::lire_fichier(installeur, &format!("maven/{rel}"))? {
                        if let Some(p) = cible.parent() {
                            std::fs::create_dir_all(p)?;
                        }
                        std::fs::write(&cible, donnees)?;
                    }
                }
                None => {}
            }
        }
        self.telechargeur.tous(taches, 16, false, d.annule.clone(), d.progression.clone()).await?;

        let travail = std::env::temp_dir().join(format!("0rzxn-loader-{}-{}", std::process::id(), fastrand::u32(..)));
        std::fs::create_dir_all(&travail)?;
        let r = self.processeurs(d, profil, installeur, chemin_installeur, &travail).await;
        let _ = std::fs::remove_dir_all(&travail);
        r?;
        Ok(id)
    }

    async fn processeurs(
        &self,
        d: &Demande<'_>,
        profil: &Value,
        installeur: &[u8],
        chemin_installeur: &Path,
        travail: &Path,
    ) -> Resultat<()> {
        let lib = |coords: &str| sous(&self.dossiers.libraries, &chemin_maven(coords));
        let chemin = |p: &Path| p.to_string_lossy().into_owned();
        let mut donnees: Vec<(String, String)> = vec![
            ("SIDE".into(), "client".into()),
            ("MINECRAFT_JAR".into(), chemin(&self.fichiers_version(d.mc).jar)),
            ("MINECRAFT_VERSION".into(), d.mc.into()),
            ("ROOT".into(), chemin(&self.dossiers.racine)),
            ("INSTALLER".into(), chemin(chemin_installeur)),
            ("LIBRARY_DIR".into(), chemin(&self.dossiers.libraries)),
        ];
        for (cle, v) in profil.get("data").and_then(Value::as_object).into_iter().flatten() {
            let Some(brut) = v.get("client").and_then(Value::as_str) else { continue };
            let valeur = if let Some(c) = entre(brut, '[', ']') {
                chemin(&lib(c))
            } else if let Some(l) = entre(brut, '\'', '\'') {
                l.into()
            } else if let Some(interne) = brut.strip_prefix('/') {
                let f = sous(travail, interne);
                if let Some(p) = f.parent() {
                    std::fs::create_dir_all(p)?;
                }
                std::fs::write(&f, zip::lire_fichier(installeur, interne)?.unwrap_or_default())?;
                chemin(&f)
            } else {
                brut.into()
            };
            donnees.push((cle.clone(), valeur));
        }
        let resoudre = |texte: &str| -> String {
            if let Some(c) = entre(texte, '[', ']') {
                return chemin(&lib(c));
            }
            static CLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{(\w+)\}").unwrap());
            let r = CLE.replace_all(texte, |c: &regex::Captures| {
                donnees.iter().rev().find(|(k, _)| k == &c[1]).map_or(c[0].to_string(), |(_, v)| v.clone())
            });
            entre(&r, '\'', '\'').map(String::from).unwrap_or_else(|| r.into_owned())
        };

        let liste: Vec<&Value> = profil
            .get("processors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|p| p.get("sides").and_then(Value::as_array).is_none_or(|s| s.iter().any(|x| x == "client")))
            .collect();
        let separateur = if cfg!(windows) { ";" } else { ":" };
        for (i, p) in liste.iter().enumerate() {
            if d.annule.as_ref().is_some_and(CancellationToken::is_cancelled) {
                return Err(Erreur::code(t("loaders.installation_annulee"), "CANCELLED"));
            }
            let sorties: Vec<(PathBuf, String)> = p
                .get("outputs")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .map(|(f, h)| (PathBuf::from(resoudre(f)), resoudre(h.as_str().unwrap_or(""))))
                .collect();
            if !sorties.is_empty() && sorties.iter().all(|(f, h)| meme_sha1(f, h)) {
                continue;
            }
            let coords = p.get("jar").and_then(Value::as_str).unwrap_or("");
            let jar = lib(coords);
            let principale = classe_principale(&std::fs::read(&jar)?)?;
            let mut cp = vec![chemin(&jar)];
            cp.extend(
                p.get("classpath").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(|c| chemin(&lib(c))),
            );
            let mut args = vec!["-cp".to_string(), cp.join(separateur), principale];
            args.extend(p.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(&resoudre));
            let n = (i + 1).to_string();
            let total = liste.len().to_string();
            (d.journal)(
                &tv("loaders.processeur", &[("index", &n), ("processors", &total), ("jar", coords.split(':').nth(1).unwrap_or(""))]),
                "LAUNCHER",
            );
            lancer_java(d.java, &args, travail, d.annule.as_ref(), d.journal).await?;
            for (f, h) in &sorties {
                if !meme_sha1(f, h) {
                    let nom = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    return Err(Erreur::new(tv("loaders.le_processeur_produit_un_fichier", &[("jar", coords), ("file", &nom)])));
                }
            }
        }
        Ok(())
    }
}

/// Contenu entre deux délimiteurs qui ouvrent et ferment tout le texte (« [a:b:c] », « 'texte' »).
fn entre(texte: &str, ouvre: char, ferme: char) -> Option<&str> {
    texte.strip_prefix(ouvre)?.strip_suffix(ferme).filter(|c| ouvre == '\'' || !c.is_empty())
}

fn meme_sha1(fichier: &Path, attendu: &str) -> bool {
    empreinte_fichier(fichier, false).is_ok_and(|h| h == attendu)
}

fn encoder(texte: &str) -> String {
    texte
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

pub fn classe_principale(jar: &[u8]) -> Resultat<String> {
    let manifeste = zip::lire_fichier(jar, "META-INF/MANIFEST.MF")?.map(|m| String::from_utf8_lossy(&m).into_owned()).unwrap_or_default();
    manifeste
        .lines()
        .find_map(|l| l.strip_prefix("Main-Class:"))
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .ok_or_else(|| Erreur::new(t("loaders.processeur_sans_classe_principale")))
}

async fn garder_fin(flux: impl AsyncRead + Unpin, fin: Arc<Mutex<VecDeque<String>>>) {
    let mut lignes = BufReader::new(flux).lines();
    while let Ok(Some(l)) = lignes.next_line().await {
        if l.trim().is_empty() {
            continue;
        }
        let mut f = fin.lock().unwrap_or_else(|e| e.into_inner());
        f.push_back(l);
        if f.len() > 30 {
            f.pop_front();
        }
    }
}

/// Lance un processeur Java ; en cas d'échec, ses 10 dernières lignes vont dans la console.
async fn lancer_java(
    java: &Path,
    args: &[String],
    dossier: &Path,
    annule: Option<&CancellationToken>,
    journal: Journal<'_>,
) -> Resultat<()> {
    let mut enfant = commande(java)
        .args(args)
        .current_dir(dossier)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Erreur::new(tv("loaders.java_ne_demarre_pas_pour", &[("message", &e.to_string())])))?;
    let fin = Arc::new(Mutex::new(VecDeque::new()));
    let lecteurs = [
        tokio::spawn(garder_fin(enfant.stdout.take().expect("stdout"), fin.clone())),
        tokio::spawn(garder_fin(enfant.stderr.take().expect("stderr"), fin.clone())),
    ];
    let jamais = CancellationToken::new();
    let statut = tokio::select! {
        s = enfant.wait() => s?,
        _ = annule.unwrap_or(&jamais).cancelled() => {
            let _ = enfant.kill().await;
            return Err(Erreur::code(t("loaders.installation_annulee"), "CANCELLED"));
        }
    };
    for l in lecteurs {
        let _ = l.await;
    }
    if statut.success() {
        return Ok(());
    }
    let lignes: Vec<String> = fin.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect();
    for l in &lignes[lignes.len().saturating_sub(10)..] {
        journal(l, "LAUNCHER/ERROR");
    }
    let code = statut.code().map_or_else(|| "?".into(), |c| c.to_string());
    Err(Erreur::new(tv("loaders.installation_du_loader_echoue_code", &[("code", &code)])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listes_forge() {
        let xml = "<versions><version>1.20.1-47.4.0</version><version>1.20.1-47.4.10</version><version>1.21-51.0.1</version>\
                   <version>1.7.10-10.13.4.1614-1.7.10</version></versions>";
        let promos = json!({ "promos": { "1.20.1-recommended": "47.4.0", "1.20.1-latest": "47.4.10", "1.7.10-latest": "10.13.4.1614" } });
        let l = versions_forge("1.20.1", xml, &promos);
        assert_eq!(l.versions.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), ["1.20.1-47.4.10", "1.20.1-47.4.0"]);
        assert_eq!(l.versions[0].label.as_deref(), Some("47.4.10"));
        assert_eq!(l.recommended.as_deref(), Some("1.20.1-47.4.0"));
        let ancien = versions_forge("1.7.10", xml, &promos);
        assert_eq!(
            (ancien.versions[0].label.as_deref(), ancien.recommended.as_deref()),
            (Some("10.13.4.1614"), Some("1.7.10-10.13.4.1614-1.7.10"))
        );
        assert_eq!(versions_forge("1.12.2", xml, &promos).recommended, None);
    }

    #[test]
    fn listes_neoforge() {
        assert_eq!(prefixe_neoforge("1.21.11").as_deref(), Some("21.11."));
        assert_eq!(prefixe_neoforge("1.21").as_deref(), Some("21.0."));
        assert_eq!(prefixe_neoforge("26.3").as_deref(), Some("26.3.0."));
        assert_eq!(prefixe_neoforge("26.3.1").as_deref(), Some("26.3.1."));
        assert_eq!(prefixe_neoforge("25w14a"), None);
        let publiees = json!({ "versions": ["21.11.1-beta", "21.11.2", "21.11.3", "21.1.5", "21.11.2.1.9"] });
        let l = versions_neoforge("21.11.", &publiees);
        assert_eq!(
            l.versions.iter().map(|v| (v.id.as_str(), v.stable)).collect::<Vec<_>>(),
            [("21.11.3", true), ("21.11.2", true), ("21.11.1-beta", false)]
        );
        assert_eq!(l.recommended.as_deref(), Some("21.11.3"));
    }

    #[test]
    fn installeurs_et_versions_de_pack() {
        assert_eq!(
            url_installeur("forge", "1.12.2-14.23.5.2860"),
            format!("{FORGE_MAVEN}/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar")
        );
        assert_eq!(
            url_installeur("neoforge", "1.20.1-47.1.106"),
            format!("{NEOFORGE_MAVEN}/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar")
        );
        assert_eq!(url_installeur("neoforge", "21.11.3"), format!("{NEOFORGE_MAVEN}/neoforge/21.11.3/neoforge-21.11.3-installer.jar"));
        assert_eq!(version_pour_pack("forge", "1.20.1", "1.20.1-47.4.22"), "47.4.22");
        assert_eq!(version_pour_pack("forge", "1.7.10", "1.7.10-10.13.4.1614-1.7.10"), "10.13.4.1614");
        assert_eq!(version_pour_pack("neoforge", "1.20.1", "1.20.1-47.1.106"), "47.1.106");
        assert_eq!(version_pour_pack("neoforge", "1.21.11", "21.11.3"), "21.11.3");
        assert_eq!(version_pour_pack("fabric", "1.21.11", "0.17.2"), "0.17.2");
    }

    #[test]
    fn manifestes_et_delimiteurs() {
        let jar = zip::creer_zip(&[(
            "META-INF/MANIFEST.MF",
            b"Manifest-Version: 1.0\r\nMain-Class: net.minecraftforge.Installer\r\n".as_slice(),
        )]);
        assert_eq!(classe_principale(&jar).unwrap(), "net.minecraftforge.Installer");
        assert!(classe_principale(&zip::creer_zip(&[("a", b"".as_slice())])).is_err());
        assert_eq!(entre("[a:b:1]", '[', ']'), Some("a:b:1"));
        assert_eq!(entre("'texte'", '\'', '\''), Some("texte"));
        assert_eq!(entre("''", '\'', '\''), Some(""));
        assert_eq!(entre("{X}", '[', ']'), None);
        assert_eq!(encoder("1.21.11"), "1.21.11");
        assert_eq!(encoder("a b/c"), "a%20b%2Fc");
    }
}
