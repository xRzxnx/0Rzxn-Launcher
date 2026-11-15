//! Installe les dépendances qui manquent aux mods d'une instance, quelle que soit leur origine, comme core/mod-deps.js.
//! Les jars annoncent un identifiant de mod, pas un projet Modrinth : chaque candidat est téléchargé, ouvert, et n'est
//! gardé que s'il fournit vraiment l'identifiant demandé.

use crate::contenu::{Contenu, Corbeille, Installe, loaders_pour};
use crate::controle_mods::{Controle, Probleme, identifiants};
use crate::erreur::{Erreur, Resultat};
use crate::i18n::tv;
use crate::modrinth::{Modrinth, Recherche, Version, choisir_version};
use crate::net::Options;
use crate::telechargement::sha1;
use commun::Instance;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Une dépendance peut avoir ses propres dépendances.
const TOURS_MAX: usize = 5;
/// Téléchargements d'essai par identifiant, hors projets connus.
const ESSAIS_RECHERCHE: usize = 4;
const OUBLI_INTROUVABLE: Duration = Duration::from_secs(10 * 60);

/// identifiant|version|loader → dernier échec.
static INTROUVABLES: LazyLock<Mutex<HashMap<String, Instant>>> = LazyLock::new(Mutex::default);

fn tasser(texte: &str) -> String {
    texte.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Fragments de Fabric API : l'identifiant vise un module livré dans le jar de Fabric API.
fn module_fabric(id: &str) -> bool {
    id == "fabric" || id.starts_with("fabric-")
}

/// Écritures probables du nom d'un mod : « yet_another_config_lib_v3 », « puzzleslib »…
pub fn requetes(id: &str) -> Vec<String> {
    static SUFFIXE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)[-_]v?\d+$").unwrap());
    static LIB: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)([a-z])(lib|api)$").unwrap());
    let mots = SUFFIXE.replace(id, "").replace(['-', '_'], " ").split_whitespace().collect::<Vec<_>>().join(" ");
    let separe = LIB.replace(&mots, "$1 $2").into_owned();
    let mut l: Vec<String> = vec![];
    for r in [mots, separe, id.to_string()] {
        if !l.contains(&r) {
            l.push(r);
        }
    }
    l
}

struct Candidat {
    projet: String,
    version: Version,
    octets: Vec<u8>,
    ids: Vec<String>,
}

struct Contexte<'a> {
    m: Modrinth<'a>,
    recherche: Recherche,
    declares: Vec<String>,
    loaders: Vec<String>,
    version_jeu: String,
    cache: HashMap<String, Option<std::sync::Arc<Candidat>>>,
    hors_ligne: bool,
}

impl Contexte<'_> {
    /// Résultats de recherche, ceux dont le nom ressemble à l'identifiant d'abord.
    async fn chercher(&self, id: &str) -> Resultat<Vec<String>> {
        let cle = tasser(id);
        let mut vus = HashSet::new();
        let mut resultats: Vec<Value> = vec![];
        for q in requetes(id) {
            let page = self.m.rechercher(&Recherche { query: q, limit: 10, ..self.recherche.clone() }).await?;
            for h in page["hits"].as_array().into_iter().flatten() {
                if vus.insert(h["id"].as_str().unwrap_or("").to_string()) {
                    resultats.push(h.clone());
                }
            }
            if resultats.iter().any(|h| tasser(h["slug"].as_str().unwrap_or("")) == cle) {
                break;
            }
        }
        let proche = |h: &Value| {
            ["slug", "title"].iter().any(|c| {
                let v = tasser(h[*c].as_str().unwrap_or(""));
                !v.is_empty() && (v.contains(&cle) || cle.contains(&v))
            })
        };
        let (pres, loin): (Vec<&Value>, Vec<&Value>) = resultats.iter().partition(|h| proche(h));
        Ok(pres.into_iter().chain(loin).take(ESSAIS_RECHERCHE).filter_map(|h| h["id"].as_str().map(String::from)).collect())
    }

    /// Projets à essayer pour un identifiant, du plus sûr au plus incertain.
    async fn candidats(&mut self, id: &str) -> Vec<String> {
        let mut p = self.declares.clone();
        // Nom trop éloigné de l'identifiant pour la recherche.
        if id == "commonnetworking" {
            p.push("common-network".into());
        }
        if let Ok(direct) = self.m.projet(id).await
            && direct["projectType"] == "mod"
            && let Some(i) = direct["id"].as_str()
        {
            p.push(i.into());
        }
        if module_fabric(id) {
            p.push("fabric-api".into());
        }
        match self.chercher(id).await {
            Ok(l) => p.extend(l),
            // Les candidats déjà trouvés restent à essayer.
            Err(_) => self.hors_ligne = true,
        }
        let mut uniques: Vec<String> = vec![];
        for x in p {
            if !uniques.contains(&x) {
                uniques.push(x);
            }
        }
        uniques
    }

    /// Télécharge la version compatible d'un projet et lit ce que son jar fournit, sans rien écrire.
    async fn candidat(&mut self, projet: &str) -> Resultat<Option<std::sync::Arc<Candidat>>> {
        if let Some(c) = self.cache.get(projet) {
            return Ok(c.clone());
        }
        let v = choisir_version(&self.m.versions(projet, &self.loaders, Some(&self.version_jeu)).await?).cloned();
        let mut trouve = None;
        if let Some(v) = v
            && let Some(f) = v.file.clone().filter(|f| f.filename.to_lowercase().ends_with(".jar"))
        {
            let octets = self.m.reseau.octets(&f.url, &Options::default()).await?;
            if sha1(&octets) != f.sha1 {
                return Err(Erreur::new(tv("download.fichier_corrompu_sha", &[("path", &f.filename)])));
            }
            let ids = identifiants(&octets, self.loaders.first().map_or("fabric", String::as_str));
            trouve = Some(std::sync::Arc::new(Candidat { projet: v.project_id.clone(), version: v, octets, ids }));
        }
        self.cache.insert(projet.into(), trouve.clone());
        Ok(trouve)
    }

    async fn fournisseur(&mut self, id: &str) -> Option<std::sync::Arc<Candidat>> {
        for p in self.candidats(id).await {
            match self.candidat(&p).await {
                Ok(Some(c)) if c.ids.iter().any(|x| x == id) => return Some(c),
                Ok(_) => {}
                Err(_) => self.hors_ligne = true,
            }
        }
        None
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Resolution {
    pub installed: Vec<Installe>,
    pub unresolved: Vec<String>,
    pub problems: Vec<Probleme>,
}

/// Dépendances obligatoires annoncées par Modrinth pour les mods installés et encore absentes.
async fn declarees(c: &Contenu, dossier_jeu: &Path, instance: &Instance) -> Resultat<Vec<String>> {
    let l = c.lister(dossier_jeu, "mods", instance, true).await?;
    let installes: HashSet<String> = l.items.iter().filter_map(|i| i.project_id.clone()).collect();
    let empreintes: Vec<String> = l.items.iter().filter(|i| i.enabled).filter_map(|i| i.sha1.clone()).collect();
    let connues = c.modrinth().versions_par_empreinte(&empreintes).await?;
    let mut d: Vec<String> = vec![];
    for v in connues.values() {
        for dep in &v.dependencies {
            if let Some(p) = dep["project_id"].as_str().filter(|_| dep["dependency_type"] == "required")
                && !installes.contains(p)
                && !d.iter().any(|x| x == p)
            {
                d.push(p.into());
            }
        }
    }
    Ok(d)
}

/// Installe ce qui manque, dépendances des dépendances comprises, et remplace une dépendance trop ancienne.
pub async fn resoudre(
    c: &Contenu,
    controle: &Controle,
    dossier_jeu: &Path,
    instance: &Instance,
    corbeille: Corbeille<'_>,
) -> Resultat<Resolution> {
    let loaders = loaders_pour("mods", instance);
    let mut installes: Vec<(String, String, String)> = vec![];
    let mut non_resolus: Vec<String> = vec![];
    let mut traites: HashSet<String> = HashSet::new();
    let dossier = dossier_jeu.join("mods");
    let cle = |id: &str| format!("{id}|{}|{}", instance.version, instance.loader);
    let recherche = Recherche {
        project_type: "mod".into(),
        game_version: Some(instance.version.clone()),
        loaders: loaders.clone(),
        ..Default::default()
    };
    let mut ctx = Contexte {
        m: c.modrinth(),
        recherche,
        declares: vec![],
        loaders: loaders.clone(),
        version_jeu: instance.version.clone(),
        cache: HashMap::new(),
        hors_ligne: false,
    };
    for _ in 0..if loaders.is_empty() { 0 } else { TOURS_MAX } {
        let diag = controle.controler(Some(&c.base), dossier_jeu, instance);
        let voulus: Vec<Value> = diag
            .problems
            .iter()
            .filter_map(|p| p.dependency.clone())
            .filter(|d| !traites.contains(d["id"].as_str().unwrap_or("")))
            .collect();
        if voulus.is_empty() {
            break;
        }
        ctx.declares = declarees(c, dossier_jeu, instance).await.unwrap_or_default();
        for dep in voulus {
            let id = dep["id"].as_str().unwrap_or("").to_string();
            let ancien = dep["outdated"].as_str().map(String::from);
            if !traites.insert(id.clone()) {
                continue;
            }
            // Modrinth ne répond pas : la vérification avant lancement reste valable.
            if ctx.hors_ligne {
                continue;
            }
            let echec = INTROUVABLES.lock().unwrap_or_else(|e| e.into_inner()).get(&cle(&id)).copied();
            if echec.is_some_and(|e| e.elapsed() < OUBLI_INTROUVABLE) {
                non_resolus.push(id);
                continue;
            }
            let Some(trouve) = ctx.fournisseur(&id).await else {
                if !ctx.hors_ligne {
                    INTROUVABLES.lock().unwrap_or_else(|e| e.into_inner()).insert(cle(&id), Instant::now());
                    non_resolus.push(id);
                }
                continue;
            };
            let nom =
                trouve.version.file.as_ref().map(|f| f.filename.rsplit(['/', '\\']).next().unwrap_or("").to_string()).unwrap_or_default();
            // Déjà la dernière version compatible.
            if ancien.as_deref() == Some(nom.as_str()) {
                non_resolus.push(id);
                continue;
            }
            // Une version trop ancienne laisse place à la nouvelle ; un même jar peut régler plusieurs identifiants.
            traites.extend(trouve.ids.iter().cloned());
            std::fs::create_dir_all(&dossier)?;
            std::fs::write(dossier.join(&nom), &trouve.octets)?;
            if let Some(a) = &ancien {
                corbeille(&dossier.join(a))?;
            }
            installes.push((trouve.projet.clone(), trouve.version.number.clone(), nom));
        }
    }
    let titres: HashMap<String, String> = ctx
        .m
        .projets(&installes.iter().map(|i| i.0.clone()).collect::<Vec<_>>())
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|p| (p.id, p.title))
        .collect();
    let fin = controle.controler(Some(&c.base), dossier_jeu, instance);
    let problems = fin
        .problems
        .into_iter()
        .map(|mut p| {
            if p.dependency.as_ref().and_then(|d| d["id"].as_str()).is_some_and(|i| non_resolus.iter().any(|n| n == i)) {
                p.text =
                    format!("{} {}", p.text, tv("mod_deps.introuvable", &[("version", &instance.version), ("loader", &instance.loader)]));
            }
            p
        })
        .collect();
    Ok(Resolution {
        installed: installes
            .into_iter()
            .map(|(p, version, file)| Installe {
                title: titres.get(&p).cloned().unwrap_or_else(|| file.clone()),
                project_id: p,
                version,
                file,
                dependency: true,
            })
            .collect(),
        unresolved: non_resolus,
        problems,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecritures_probables() {
        assert_eq!(requetes("yet_another_config_lib_v3"), ["yet another config lib", "yet_another_config_lib_v3"]);
        assert_eq!(requetes("puzzleslib"), ["puzzleslib", "puzzles lib"]);
        assert_eq!(requetes("cloth-config2"), ["cloth config2", "cloth-config2"]);
        assert!(module_fabric("fabric-api-base") && !module_fabric("fabricloader"));
        assert_eq!(tasser("Fabric API!"), "fabricapi");
    }
}
