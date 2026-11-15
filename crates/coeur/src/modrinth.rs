//! Client de l'API Modrinth v2 (sans clé), comme core/modrinth.js : https://docs.modrinth.com/api/
//! Les requêtes passent par net.rs : User-Agent du projet, essais, Retry-After et limite par serveur.
//! LAUNCHER_MODRINTH_API pointe le launcher vers un faux serveur pour les tests.

use crate::erreur::{Erreur, Resultat};
use crate::i18n::{t, tv};
use crate::net::{Options, Reseau};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::Duration;

const SORTS: [&str; 5] = ["relevance", "downloads", "follows", "newest", "updated"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Fichier {
    pub url: String,
    pub filename: String,
    pub sha1: String,
    pub sha512: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub number: String,
    #[serde(rename = "type")]
    pub genre: String,
    pub published: String,
    pub loaders: Vec<String>,
    pub game_versions: Vec<String>,
    pub dependencies: Vec<Value>,
    pub file: Option<Fichier>,
    pub files: Vec<Fichier>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjetCourt {
    pub id: String,
    pub slug: String,
    pub title: String,
    pub icon: Option<String>,
    pub project_type: String,
}

pub struct Modrinth<'a> {
    pub reseau: &'a Reseau,
    pub api: String,
}

fn s(v: &Value, c: &str) -> String {
    v.get(c).and_then(Value::as_str).unwrap_or("").to_string()
}

fn icone(v: &Value) -> Option<String> {
    v.get("icon_url").and_then(Value::as_str).filter(|u| !u.is_empty()).map(String::from)
}

fn fichier(f: &Value) -> Fichier {
    Fichier {
        url: s(f, "url"),
        filename: s(f, "filename"),
        sha1: f.pointer("/hashes/sha1").and_then(Value::as_str).unwrap_or("").into(),
        sha512: f.pointer("/hashes/sha512").and_then(Value::as_str).unwrap_or("").into(),
        size: f.get("size").and_then(Value::as_u64).unwrap_or(0),
    }
}

pub fn simplifier(v: &Value) -> Version {
    let fichiers: Vec<&Value> = v.get("files").and_then(Value::as_array).into_iter().flatten().collect();
    let principal = fichiers.iter().find(|f| f.get("primary") == Some(&json!(true))).or(fichiers.first());
    let liste = |c: &str| v.get(c).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
    Version {
        id: s(v, "id"),
        project_id: s(v, "project_id"),
        name: s(v, "name"),
        number: s(v, "version_number"),
        genre: s(v, "version_type"),
        published: s(v, "date_published"),
        loaders: liste("loaders"),
        game_versions: liste("game_versions"),
        dependencies: v.get("dependencies").and_then(Value::as_array).cloned().unwrap_or_default(),
        file: principal.map(|f| fichier(f)),
        files: fichiers.iter().map(|f| fichier(f)).collect(),
    }
}

/// Préfère la dernière version stable, sinon la plus récente (mods encore en bêta pour une nouvelle version).
pub fn choisir_version(liste: &[Version]) -> Option<&Version> {
    liste.iter().find(|v| v.genre == "release").or(liste.first())
}

pub fn encoder(texte: &str) -> String {
    texte
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

fn q(v: &Value) -> String {
    encoder(&v.to_string())
}

impl<'a> Modrinth<'a> {
    pub fn new(reseau: &'a Reseau) -> Self {
        let api = std::env::var("LAUNCHER_MODRINTH_API").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        Self { reseau, api: api.unwrap_or_else(|| "https://api.modrinth.com/v2".into()) }
    }

    /// Appel avec les messages de la version Electron ; 404 → None.
    async fn appel(&self, chemin: &str, corps: Option<Value>) -> Resultat<Option<Value>> {
        let mut entetes = vec![("Accept".to_string(), "application/json".to_string())];
        if corps.is_some() {
            entetes.push(("Content-Type".into(), "application/json".into()));
        }
        let o = Options {
            methode: if corps.is_some() { Method::POST } else { Method::GET },
            entetes,
            corps: corps.map(|c| c.to_string().into_bytes()),
            inactivite: Duration::from_secs(20),
            ..Options::default()
        };
        match self.reseau.octets(&format!("{}{chemin}", self.api), &o).await {
            Ok(o) => Ok(serde_json::from_slice(&o).ok()),
            Err(e) => match e.statut {
                Some(404) => Ok(None),
                Some(429) => Err(Erreur::new(t("modrinth.trop_de_requetes_vers_modrinth"))),
                Some(s) => Err(Erreur::new(tv("modrinth.modrinth_repondu", &[("status", &s.to_string())]))),
                None if e.a_le_code("NET_INSECURE") || e.a_le_code("NET_REDIRECTS") || e.a_le_code("CANCELLED") => Err(e),
                None => {
                    Err(Erreur::new(tv("modrinth.modrinth_ne_repond_pas", &[("code", &e.code.map_or(e.message.clone(), String::from))])))
                }
            },
        }
    }

    /// Recherche filtrée par type, version de Minecraft et loaders compatibles.
    pub async fn rechercher(&self, r: &Recherche) -> Resultat<Value> {
        let mut facettes = vec![json!([format!("project_type:{}", r.project_type)])];
        if let Some(v) = r.game_version.as_ref().filter(|v| !v.is_empty()) {
            facettes.push(json!([format!("versions:{v}")]));
        }
        if !r.loaders.is_empty() && r.project_type == "mod" {
            facettes.push(json!(r.loaders.iter().map(|l| format!("categories:{l}")).collect::<Vec<_>>()));
        }
        let tri = if SORTS.contains(&r.sort.as_str()) { r.sort.as_str() } else { "relevance" };
        let chemin = format!(
            "/search?query={}&facets={}&index={tri}&offset={}&limit={}",
            encoder(&r.query),
            q(&Value::Array(facettes)),
            r.offset,
            r.limit.clamp(1, 50)
        );
        let d = self.appel(&chemin, None).await?.unwrap_or_default();
        let hits: Vec<Value> = d
            .get("hits")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|h| {
                json!({
                    "id": h["project_id"], "slug": h["slug"], "title": h["title"], "description": h["description"], "author": h["author"],
                    "icon": icone(h), "downloads": h["downloads"], "follows": h["follows"],
                    "categories": h.get("display_categories").filter(|c| !c.is_null()).unwrap_or(&h["categories"]),
                    "updated": h["date_modified"], "projectType": h["project_type"],
                })
            })
            .collect();
        Ok(json!({ "total": d["total_hits"], "offset": d["offset"], "hits": hits }))
    }

    pub async fn projet(&self, id: &str) -> Resultat<Value> {
        let p = self
            .appel(&format!("/project/{}", encoder(id)), None)
            .await?
            .ok_or_else(|| Erreur::new(t("modrinth.projet_introuvable_sur_modrinth")))?;
        let mut galerie: Vec<Value> = p.get("gallery").and_then(Value::as_array).cloned().unwrap_or_default();
        let vrai = |g: &Value| g.get("featured").and_then(Value::as_bool).unwrap_or(false);
        let ordre = |g: &Value| g.get("ordering").and_then(Value::as_i64).unwrap_or(0);
        galerie.sort_by(|a, b| vrai(b).cmp(&vrai(a)).then(ordre(a).cmp(&ordre(b))));
        let licence = p.pointer("/license/name").or_else(|| p.pointer("/license/id")).cloned().unwrap_or(Value::Null);
        Ok(json!({
            "id": p["id"], "slug": p["slug"], "title": p["title"], "description": p["description"], "icon": icone(&p),
            "downloads": p["downloads"], "follows": p["followers"], "categories": p["categories"], "projectType": p["project_type"],
            "license": licence, "updated": p["updated"],
            "gallery": galerie.iter().map(|g| json!({ "url": g["url"], "title": g["title"] })).collect::<Vec<_>>(),
            "links": { "source": p["source_url"], "issues": p["issues_url"], "wiki": p["wiki_url"], "discord": p["discord_url"] },
        }))
    }

    /// Versions compatibles (les plus récentes d'abord).
    pub async fn versions(&self, projet: &str, loaders: &[String], version_jeu: Option<&str>) -> Resultat<Vec<Version>> {
        let mut p = vec![];
        if !loaders.is_empty() {
            p.push(format!("loaders={}", q(&json!(loaders))));
        }
        if let Some(v) = version_jeu {
            p.push(format!("game_versions={}", q(&json!([v]))));
        }
        let l = self.appel(&format!("/project/{}/version?{}", encoder(projet), p.join("&")), None).await?.unwrap_or_default();
        Ok(l.as_array().into_iter().flatten().map(simplifier).collect())
    }

    pub async fn version(&self, id: &str) -> Resultat<Version> {
        let v = self
            .appel(&format!("/version/{}", encoder(id)), None)
            .await?
            .ok_or_else(|| Erreur::new(t("modrinth.version_introuvable_sur_modrinth")))?;
        Ok(simplifier(&v))
    }

    /// Versions Modrinth correspondant à des fichiers (par empreinte SHA-1).
    pub async fn versions_par_empreinte(&self, empreintes: &[String]) -> Resultat<HashMap<String, Version>> {
        if empreintes.is_empty() {
            return Ok(HashMap::new());
        }
        let d = self.appel("/version_files", Some(json!({ "hashes": empreintes, "algorithm": "sha1" }))).await?.unwrap_or_default();
        Ok(d.as_object().into_iter().flatten().map(|(h, v)| (h.clone(), simplifier(v))).collect())
    }

    /// Dernière version compatible pour chaque fichier.
    pub async fn dernieres_par_empreinte(
        &self,
        empreintes: &[String],
        loaders: &[String],
        version_jeu: &str,
    ) -> Resultat<HashMap<String, Version>> {
        if empreintes.is_empty() {
            return Ok(HashMap::new());
        }
        let corps = json!({ "hashes": empreintes, "algorithm": "sha1", "loaders": loaders, "game_versions": [version_jeu] });
        let d = self.appel("/version_files/update", Some(corps)).await?.unwrap_or_default();
        Ok(d.as_object().into_iter().flatten().map(|(h, v)| (h.clone(), simplifier(v))).collect())
    }

    pub async fn projets(&self, ids: &[String]) -> Resultat<Vec<ProjetCourt>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let l = self.appel(&format!("/projects?ids={}", q(&json!(ids))), None).await?.unwrap_or_default();
        Ok(l.as_array()
            .into_iter()
            .flatten()
            .map(|p| ProjetCourt {
                id: s(p, "id"),
                slug: s(p, "slug"),
                title: s(p, "title"),
                icon: icone(p),
                project_type: s(p, "project_type"),
            })
            .collect())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Recherche {
    pub query: String,
    pub project_type: String,
    pub game_version: Option<String>,
    pub loaders: Vec<String>,
    pub sort: String,
    pub offset: u32,
    pub limit: u32,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai_http::{Reponse, servir};
    use std::sync::{Arc, Mutex};

    fn version_brute() -> Value {
        json!({
            "id": "v1", "project_id": "p1", "name": "Sodium 1", "version_number": "1.0", "version_type": "release", "date_published": "2026-01-01",
            "loaders": ["fabric"], "game_versions": ["1.21.11"], "dependencies": [],
            "files": [{ "url": "https://cdn.modrinth.com/a.jar", "filename": "a.jar", "primary": true, "size": 10, "hashes": { "sha1": "a".repeat(40), "sha512": "b".repeat(128) } }],
        })
    }

    async fn essai(reponses: Vec<(u16, String)>) -> (Reseau, String, crate::essai_http::Serveur) {
        let file = Arc::new(Mutex::new(reponses));
        let serveur = servir(move |_, _| {
            let mut f = file.lock().unwrap();
            let (statut, corps) = if f.is_empty() { (500, String::new()) } else { f.remove(0) };
            Reponse::simple(statut, &corps).avec("Retry-After", "0")
        })
        .await;
        let r = Reseau::new();
        r.pour_essais(&["127.0.0.1"], 1);
        r.version("1.2.3");
        let api = format!("{}/v2", serveur.base);
        (r, api, serveur)
    }

    #[tokio::test]
    async fn version_empreintes_et_agent() {
        let (r, api, s) = essai(vec![(200, version_brute().to_string())]).await;
        let m = Modrinth { reseau: &r, api };
        let v = m.version("v1").await.unwrap();
        assert_eq!(
            v.file.unwrap(),
            Fichier {
                url: "https://cdn.modrinth.com/a.jar".into(),
                filename: "a.jar".into(),
                sha1: "a".repeat(40),
                sha512: "b".repeat(128),
                size: 10
            }
        );
        assert_eq!(s.requetes()[0].chemin, "/v2/version/v1");
        assert!(s.requetes()[0].entete("user-agent").unwrap().starts_with("0Rzxn_Launcher/1.2.3 "));
    }

    #[tokio::test]
    async fn erreurs_passageres_et_messages() {
        let (r, api, s) = essai(vec![(502, String::new()), (503, String::new()), (200, version_brute().to_string())]).await;
        let m = Modrinth { reseau: &r, api };
        assert_eq!(m.version("v1").await.unwrap().id, "v1");
        assert_eq!(s.nombre(), 3);

        let (r, api, s) = essai(vec![(429, String::new()); 4].into_iter().chain([(403, String::new())]).collect()).await;
        let m = Modrinth { reseau: &r, api };
        assert_eq!(m.version("v1").await.unwrap_err().message, t("modrinth.trop_de_requetes_vers_modrinth"));
        assert_eq!(s.nombre(), 4);
        assert_eq!(m.version("v1").await.unwrap_err().message, tv("modrinth.modrinth_repondu", &[("status", "403")]));
        assert_eq!(s.nombre(), 5, "403 : pas de nouvel essai");
    }

    #[tokio::test]
    async fn introuvable_et_injoignable() {
        let (r, api, s) = essai(vec![(404, String::new())]).await;
        let m = Modrinth { reseau: &r, api };
        assert!(m.versions_par_empreinte(&["c".repeat(40)]).await.unwrap().is_empty());
        assert_eq!((s.nombre(), s.requetes()[0].methode.as_str()), (1, "POST"));
        let ferme = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let m = Modrinth { reseau: &r, api: format!("http://127.0.0.1:{ferme}/v2") };
        let debut = tv("modrinth.modrinth_ne_repond_pas", &[("code", "X")]);
        assert!(m.version("v1").await.unwrap_err().message.starts_with(debut.split('X').next().unwrap()));
    }

    #[test]
    fn choix_de_version() {
        let v = |id: &str, g: &str| Version { id: id.into(), genre: g.into(), ..Default::default() };
        assert_eq!(choisir_version(&[v("b", "beta"), v("r", "release")]).unwrap().id, "r");
        assert_eq!(choisir_version(&[v("b", "beta")]).unwrap().id, "b");
        assert!(choisir_version(&[]).is_none());
    }
}
