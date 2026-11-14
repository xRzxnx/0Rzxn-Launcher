//! Requêtes HTTP du launcher (core/net.js) : HTTPS obligatoire, redirections contrôlées, délai d'inactivité,
//! nouveaux essais avec attente croissante, Retry-After, limites globale et par serveur, pause annoncée par le serveur.

use crate::erreur::{Erreur, Resultat};
use crate::i18n::{t, tv};
use bytes::Bytes;
use reqwest::header::HeaderMap;
use reqwest::{Method, Url};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const REDIRECTIONS_MAX: u32 = 5;
pub const ESSAIS: u32 = 4;
pub const INACTIVITE: Duration = Duration::from_secs(30);
const RETRY_AFTER_MAX_MS: u64 = 60_000;
const ATTENTE_PLAFOND_MS: f64 = 10_000.0;
const STATUTS_A_REESSAYER: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];

pub fn annulee() -> Erreur {
    Erreur::code(t("net.annule"), "CANCELLED")
}

/// Attend `duree`, ou s'arrête à l'annulation.
pub async fn dormir(duree: Duration, annule: Option<&CancellationToken>) -> Resultat<()> {
    match annule {
        Some(a) => tokio::select! {
            _ = tokio::time::sleep(duree) => Ok(()),
            _ = a.cancelled() => Err(annulee()),
        },
        None => {
            tokio::time::sleep(duree).await;
            Ok(())
        }
    }
}

/// Exécute `f`, ou s'arrête à l'annulation.
async fn sauf_annulation<T>(annule: Option<&CancellationToken>, f: impl Future<Output = Resultat<T>>) -> Resultat<T> {
    match annule {
        Some(a) => tokio::select! {
            r = f => r,
            _ = a.cancelled() => Err(annulee()),
        },
        None => f.await,
    }
}

// ---------- Limites ----------

/// Compteur de places ; la limite est relue à chaque fois (réglage changé à chaud).
#[derive(Default)]
struct Places {
    prises: Mutex<usize>,
    liberee: Notify,
}

/// Place prise ; rendue quand elle est lâchée.
pub struct Place(Arc<Places>);

impl Drop for Place {
    fn drop(&mut self) {
        if let Ok(mut n) = self.0.prises.lock() {
            *n = n.saturating_sub(1);
        }
        self.0.liberee.notify_one();
    }
}

async fn prendre(places: &Arc<Places>, limite: &AtomicU32, annule: Option<&CancellationToken>) -> Resultat<Place> {
    loop {
        let attente = places.liberee.notified();
        tokio::pin!(attente);
        attente.as_mut().enable();
        {
            let mut n = places.prises.lock().map_err(|_| annulee())?;
            if *n < limite.load(Ordering::Relaxed) as usize {
                *n += 1;
                return Ok(Place(places.clone()));
            }
        }
        sauf_annulation(annule, async {
            attente.await;
            Ok(())
        })
        .await?;
    }
}

// ---------- Réseau ----------

pub struct Reseau {
    client: reqwest::Client,
    total: AtomicU32,
    par_serveur: AtomicU32,
    agent: RwLock<String>,
    /// Base de l'attente entre deux essais (ms) ; très courte dans les tests.
    attente_base: AtomicU64,
    /// Tests seulement : serveurs locaux joignables en clair.
    en_clair: RwLock<HashSet<String>>,
    toutes: Arc<Places>,
    serveurs: Mutex<HashMap<String, Arc<Places>>>,
    /// Serveur qui a annoncé sa limite atteinte (X-Ratelimit-Remaining: 0) : pas de requête avant cette date.
    pause: Mutex<HashMap<String, Instant>>,
}

pub struct Options<'a> {
    pub methode: Method,
    pub entetes: Vec<(String, String)>,
    pub corps: Option<Vec<u8>>,
    pub annule: Option<&'a CancellationToken>,
    pub inactivite: Duration,
    pub essais: u32,
}

impl Default for Options<'_> {
    fn default() -> Self {
        Self { methode: Method::GET, entetes: vec![], corps: None, annule: None, inactivite: INACTIVITE, essais: ESSAIS }
    }
}

impl<'a> Options<'a> {
    pub fn annulable(annule: Option<&'a CancellationToken>) -> Self {
        Self { annule, ..Self::default() }
    }
}

/// Réponse ouverte : les places (globale et serveur) restent prises jusqu'à ce qu'elle soit lâchée.
pub struct Reponse<'a> {
    pub statut: u16,
    /// Adresse finale, après redirections.
    pub url: Url,
    pub entetes: HeaderMap,
    corps: reqwest::Response,
    inactivite: Duration,
    annule: Option<&'a CancellationToken>,
    _places: (Place, Place),
}

impl Reponse<'_> {
    pub fn entete(&self, nom: &str) -> Option<&str> {
        self.entetes.get(nom).and_then(|v| v.to_str().ok())
    }

    fn hote(&self) -> String {
        hote(&self.url)
    }

    /// Morceau suivant du corps (None à la fin) ; le délai d'inactivité repart à chaque morceau.
    pub async fn morceau(&mut self) -> Resultat<Option<Bytes>> {
        let (inactivite, hote) = (self.inactivite, self.hote());
        let lecture = async {
            match tokio::time::timeout(inactivite, self.corps.chunk()).await {
                Err(_) => Err(silence(&hote, inactivite)),
                Ok(r) => r.map_err(|e| Erreur::new(e.to_string())),
            }
        };
        sauf_annulation(self.annule, lecture).await
    }

    /// Corps entier en mémoire.
    pub async fn tout(mut self) -> Resultat<Vec<u8>> {
        let mut v = vec![];
        while let Some(m) = self.morceau().await? {
            v.extend_from_slice(&m);
        }
        Ok(v)
    }

    /// Erreur HTTP (statut non 2xx) avec son statut et l'attente demandée par le serveur.
    fn erreur_http(&self) -> Erreur {
        Erreur {
            statut: Some(self.statut),
            attendre_ms: retry_after_ms(self.entete("retry-after"), std::time::SystemTime::now()),
            ..Erreur::new(tv("download.reponse_de", &[("status", &self.statut.to_string()), ("host", &self.hote())]))
        }
    }
}

fn silence(hote: &str, inactivite: Duration) -> Erreur {
    let secondes = (inactivite.as_millis() as f64 / 1000.0).round().to_string();
    Erreur::code(tv("net.ne_repond_plus", &[("host", hote), ("seconds", &secondes)]), "NET_IDLE")
}

/// « hôte:port » comme URL.host en JavaScript (port seulement s'il n'est pas celui par défaut).
pub fn hote(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => String::new(),
    }
}

/// Retry-After : secondes ou date HTTP, en millisecondes (None si absent ou illisible).
pub fn retry_after_ms(valeur: Option<&str>, maintenant: std::time::SystemTime) -> Option<u64> {
    let v = valeur?.trim();
    if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) {
        return v.parse::<u64>().ok().map(|s| s * 1000);
    }
    let date = httpdate::parse_http_date(v).ok()?;
    Some(date.duration_since(maintenant).map(|d| d.as_millis() as u64).unwrap_or(0))
}

/// Erreur à réessayer : réseau, délai d'inactivité, ou statut 408, 425, 429, 5xx.
fn a_reessayer(e: &Erreur) -> bool {
    if matches!(e.code, Some("NET_INSECURE" | "NET_REDIRECTS" | "CANCELLED")) {
        return false;
    }
    e.statut.is_none_or(|s| STATUTS_A_REESSAYER.contains(&s))
}

impl Default for Reseau {
    fn default() -> Self {
        Self::new()
    }
}

impl Reseau {
    pub fn new() -> Self {
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap_or_default();
        Self {
            client,
            total: AtomicU32::new(16),
            par_serveur: AtomicU32::new(8),
            agent: RwLock::new("0Rzxn_Launcher (+https://github.com/xRzxnx/0Rzxn-Launcher)".into()),
            attente_base: AtomicU64::new(500),
            en_clair: RwLock::new(HashSet::new()),
            toutes: Arc::default(),
            serveurs: Mutex::default(),
            pause: Mutex::default(),
        }
    }

    /// Limites (bornées) des téléchargements simultanés, au total et par serveur.
    pub fn limiter(&self, total: Option<u32>, par_serveur: Option<u32>) {
        if let Some(n) = total {
            self.total.store(n.clamp(1, 64), Ordering::Relaxed);
        }
        if let Some(n) = par_serveur {
            self.par_serveur.store(n.clamp(1, 32), Ordering::Relaxed);
        }
        // Une limite plus haute libère des places tout de suite.
        self.toutes.liberee.notify_waiters();
    }

    pub fn limites(&self) -> (u32, u32) {
        (self.total.load(Ordering::Relaxed), self.par_serveur.load(Ordering::Relaxed))
    }

    /// Version du launcher dans le User-Agent.
    pub fn version(&self, version: &str) {
        if let Ok(mut a) = self.agent.write() {
            *a = format!("0Rzxn_Launcher/{version} (+https://github.com/xRzxnx/0Rzxn-Launcher)");
        }
    }

    /// Tests seulement : serveurs en clair acceptés et attente entre essais.
    pub fn pour_essais(&self, hotes: &[&str], attente_base_ms: u64) {
        if let Ok(mut h) = self.en_clair.write() {
            *h = hotes.iter().map(|s| s.to_string()).collect();
        }
        self.attente_base.store(attente_base_ms, Ordering::Relaxed);
    }

    fn clair_permis(&self, url: &Url) -> bool {
        url.host_str().is_some_and(|h| self.en_clair.read().is_ok_and(|s| s.contains(h)))
    }

    /// HTTPS obligatoire : http:// est réécrit en https:// (jamais de repli en clair).
    pub fn url_sure(&self, brut: &str) -> Resultat<Url> {
        let refus = || Erreur::code(tv("net.adresse_refusee", &[("url", brut)]), "NET_INSECURE");
        let mut url = Url::parse(brut).map_err(|_| refus())?;
        if url.scheme() == "http" && !self.clair_permis(&url) {
            url.set_scheme("https").map_err(|_| refus())?;
        }
        if url.scheme() == "https" || (url.scheme() == "http" && self.clair_permis(&url)) { Ok(url) } else { Err(refus()) }
    }

    /// Attente avant l'essai `essai` (1, 2, 3…) : au hasard entre 0 et min(10 s, base × 2^(essai-1)).
    pub fn attente_ms(&self, essai: u32) -> f64 {
        let base = self.attente_base.load(Ordering::Relaxed) as f64;
        fastrand::f64() * ATTENTE_PLAFOND_MS.min(base * 2f64.powi(essai.saturating_sub(1) as i32))
    }

    fn places_du_serveur(&self, hote: &str) -> Arc<Places> {
        let mut s = self.serveurs.lock().unwrap_or_else(|e| e.into_inner());
        s.entry(hote.to_string()).or_default().clone()
    }

    /// Envoie une requête (redirections suivies à la main) et prend ses places. Pas de nouvel essai ici.
    pub async fn envoyer<'a>(&self, brut: &str, o: &Options<'a>) -> Resultat<Reponse<'a>> {
        let mut url = self.url_sure(brut)?;
        let premier = hote(&url);
        let pause = self.pause.lock().ok().and_then(|p| p.get(&premier).copied());
        if let Some(fin) = pause.filter(|f| *f > Instant::now()) {
            dormir(fin - Instant::now(), o.annule).await?;
        }
        let place_totale = prendre(&self.toutes, &self.total, o.annule).await?;
        let place_serveur = prendre(&self.places_du_serveur(&premier), &self.par_serveur, o.annule).await?;
        let agent = self.agent.read().map(|a| a.clone()).unwrap_or_default();

        let mut saut = 0;
        let reponse = loop {
            let mut req = self.client.request(o.methode.clone(), url.clone()).header("User-Agent", &agent);
            for (n, v) in &o.entetes {
                req = req.header(n, v);
            }
            if let Some(c) = &o.corps {
                req = req.body(c.clone());
            }
            let hote_actuel = hote(&url);
            let envoi = async {
                match tokio::time::timeout(o.inactivite, req.send()).await {
                    Err(_) => Err(silence(&hote_actuel, o.inactivite)),
                    Ok(r) => r.map_err(|e| Erreur::new(e.to_string())),
                }
            };
            let r = sauf_annulation(o.annule, envoi).await?;
            let destination = if r.status().is_redirection() {
                r.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string)
            } else {
                None
            };
            let Some(destination) = destination else { break r };
            if saut >= REDIRECTIONS_MAX {
                return Err(Erreur::code(tv("net.trop_de_redirections", &[("host", &hote(&url))]), "NET_REDIRECTS"));
            }
            let suivante = url.join(&destination).map_err(|e| Erreur::new(e.to_string()))?;
            if suivante.scheme() != "https" && !(suivante.scheme() == "http" && self.clair_permis(&suivante)) {
                let h = suivante.host_str().map(str::to_string).unwrap_or_else(|| format!("{}:", suivante.scheme()));
                return Err(Erreur::code(tv("net.redirection_refusee", &[("host", &h)]), "NET_INSECURE"));
            }
            url = suivante;
            saut += 1;
        };
        let entetes = reponse.headers().clone();
        let restant = entetes.get("x-ratelimit-remaining").and_then(|v| v.to_str().ok());
        let remise = entetes.get("x-ratelimit-reset").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<f64>().ok());
        if let (Some("0"), Some(s)) = (restant, remise)
            && let Ok(mut p) = self.pause.lock()
        {
            p.insert(premier, Instant::now() + Duration::from_secs_f64(s.max(0.0)));
        }
        Ok(Reponse {
            statut: reponse.status().as_u16(),
            url,
            entetes,
            corps: reponse,
            inactivite: o.inactivite,
            annule: o.annule,
            _places: (place_totale, place_serveur),
        })
    }

    /// Exécute `travail` (une requête et sa lecture) avec plusieurs essais.
    pub async fn avec_essais<T, F, Fut>(
        &self,
        hote: &str,
        essais: u32,
        annule: Option<&CancellationToken>,
        reessayer_si: impl Fn(&Erreur) -> bool,
        mut travail: F,
    ) -> Resultat<T>
    where
        F: FnMut(u32) -> Fut,
        Fut: Future<Output = Resultat<T>>,
    {
        let mut essai = 1;
        loop {
            match travail(essai).await {
                Ok(v) => return Ok(v),
                Err(e) => {
                    if annule.is_some_and(CancellationToken::is_cancelled) {
                        return Err(annulee());
                    }
                    if essai >= essais || !a_reessayer(&e) || !reessayer_si(&e) {
                        return Err(e);
                    }
                    let attente = e.attendre_ms.map(|m| m as f64).unwrap_or_else(|| self.attente_ms(essai));
                    if attente > RETRY_AFTER_MAX_MS as f64 {
                        let secondes = (attente / 1000.0).ceil().to_string();
                        return Err(Erreur {
                            statut: e.statut,
                            ..Erreur::new(tv("net.attendre_avant_de_reessayer", &[("host", hote), ("seconds", &secondes)]))
                        });
                    }
                    dormir(Duration::from_secs_f64(attente / 1000.0), annule).await?;
                    essai += 1;
                }
            }
        }
    }

    /// Requête avec nouveaux essais, réponse 2xx ouverte : l'appelant lit le corps puis la lâche.
    pub async fn requete<'a>(&self, url: &str, o: &Options<'a>) -> Resultat<Reponse<'a>> {
        let hote = hote(&self.url_sure(url)?);
        self.avec_essais(
            &hote,
            o.essais,
            o.annule,
            |_| true,
            |_| async {
                let r = self.envoyer(url, o).await?;
                if (200..300).contains(&r.statut) { Ok(r) } else { Err(r.erreur_http()) }
            },
        )
        .await
    }

    /// Corps entier en mémoire (petites réponses : manifestes, API).
    pub async fn octets(&self, url: &str, o: &Options<'_>) -> Resultat<Vec<u8>> {
        let hote = hote(&self.url_sure(url)?);
        self.avec_essais(
            &hote,
            o.essais,
            o.annule,
            |_| true,
            |_| async {
                let r = self.envoyer(url, o).await?;
                if !(200..300).contains(&r.statut) {
                    return Err(r.erreur_http());
                }
                r.tout().await
            },
        )
        .await
    }

    pub async fn json<T: serde::de::DeserializeOwned>(&self, url: &str, o: &Options<'_>) -> Resultat<T> {
        serde_json::from_slice(&self.octets(url, o).await?).map_err(|e| Erreur::new(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai_http::{Corps, Reponse as R, servir};
    use std::time::SystemTime;

    fn reseau() -> Reseau {
        let r = Reseau::new();
        r.pour_essais(&["127.0.0.1"], 1);
        r
    }
    fn o() -> Options<'static> {
        Options::default()
    }

    #[test]
    fn url_sure() {
        let r = reseau();
        assert_eq!(r.url_sure("http://libraries.minecraft.net/a.jar").unwrap().as_str(), "https://libraries.minecraft.net/a.jar");
        assert_eq!(r.url_sure("https://cdn.modrinth.com/x").unwrap().scheme(), "https");
        assert_eq!(r.url_sure("http://127.0.0.1:8080/x").unwrap().scheme(), "http");
        assert_eq!(r.url_sure("ftp://example.org/a").unwrap_err().message, tv("net.adresse_refusee", &[("url", "ftp://example.org/a")]));
        assert!(r.url_sure("file:///C:/a").unwrap_err().a_le_code("NET_INSECURE"));
    }

    #[test]
    fn retry_after() {
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(10);
        assert_eq!(retry_after_ms(Some("3"), t0), Some(3000));
        assert_eq!(retry_after_ms(Some(" 0 "), t0), Some(0));
        assert_eq!(retry_after_ms(Some(&httpdate::fmt_http_date(t0 + Duration::from_secs(5))), t0), Some(5000));
        assert_eq!(retry_after_ms(None, t0), None);
        assert_eq!(retry_after_ms(Some("demain"), t0), None);
    }

    #[test]
    fn attente_croissante_et_plafonnee() {
        let r = Reseau::new();
        for _ in 0..200 {
            assert!(r.attente_ms(1) <= 500.0 && r.attente_ms(3) <= 2000.0 && r.attente_ms(10) <= 10_000.0);
        }
    }

    #[tokio::test]
    async fn corps_et_user_agent() {
        let s = servir(|_, q| R::simple(200, &format!("{{\"ok\":true,\"path\":\"{}\"}}", q.chemin))).await;
        let r = reseau();
        r.version("9.9.9");
        let v: serde_json::Value = r.json(&format!("{}/a", s.base), &o()).await.unwrap();
        assert_eq!(v, serde_json::json!({ "ok": true, "path": "/a" }));
        assert_eq!(r.octets(&format!("{}/b", s.base), &o()).await.unwrap(), br#"{"ok":true,"path":"/b"}"#);
        assert_eq!(s.requetes()[0].entete("user-agent"), Some("0Rzxn_Launcher/9.9.9 (+https://github.com/xRzxnx/0Rzxn-Launcher)"));
    }

    #[tokio::test]
    async fn erreurs_passageres_puis_succes() {
        let s = servir(|n, _| if n < 4 { R::simple(if n == 1 { 503 } else { 500 }, "") } else { R::simple(200, "enfin") }).await;
        assert_eq!(reseau().octets(&format!("{}/x", s.base), &o()).await.unwrap(), b"enfin");
        assert_eq!(s.nombre(), 4);
    }

    #[tokio::test]
    async fn erreur_durable_et_404() {
        let s = servir(|_, q| R::simple(if q.chemin == "/absent" { 404 } else { 502 }, "")).await;
        let e = reseau().octets(&format!("{}/x", s.base), &o()).await.unwrap_err();
        assert_eq!((e.message, e.statut), (tv("download.reponse_de", &[("status", "502"), ("host", &s.hote())]), Some(502)));
        assert_eq!(s.nombre(), 4);
        assert_eq!(reseau().octets(&format!("{}/absent", s.base), &o()).await.unwrap_err().statut, Some(404));
        assert_eq!(s.nombre(), 5);
    }

    #[tokio::test]
    async fn retry_after_respecte_ou_trop_long() {
        let s = servir(|n, q| match (q.chemin.as_str(), n) {
            ("/long", _) => R::simple(503, "").avec("Retry-After", "120"),
            (_, 1) => R::simple(429, "").avec("Retry-After", "1"),
            _ => R::simple(200, "ok"),
        })
        .await;
        let debut = Instant::now();
        assert_eq!(reseau().octets(&format!("{}/x", s.base), &o()).await.unwrap(), b"ok");
        assert!(debut.elapsed() >= Duration::from_millis(950));
        let debut = Instant::now();
        let e = reseau().octets(&format!("{}/long", s.base), &o()).await.unwrap_err();
        assert_eq!(e.message, tv("net.attendre_avant_de_reessayer", &[("host", &s.hote()), ("seconds", "120")]));
        assert!(debut.elapsed() < Duration::from_secs(1));
        assert_eq!(s.nombre(), 3);
    }

    #[tokio::test]
    async fn redirections() {
        let s = servir(|_, q| match q.chemin.as_str() {
            "/ok" => R::simple(302, "").avec("Location", "/fin"),
            "/fin" => R::simple(200, "arrivé"),
            "/clair" => R::simple(301, "").avec("Location", "http://localhost/secret"),
            c => {
                let n: u32 = c[1..].parse().unwrap_or(0);
                R::simple(302, "").avec("Location", &format!("/{}", n + 1))
            }
        })
        .await;
        let r = reseau();
        assert_eq!(r.octets(&format!("{}/ok", s.base), &o()).await.unwrap(), "arrivé".as_bytes());
        assert_eq!(
            r.octets(&format!("{}/clair", s.base), &o()).await.unwrap_err().message,
            tv("net.redirection_refusee", &[("host", "localhost")])
        );
        assert_eq!(
            r.octets(&format!("{}/1", s.base), &o()).await.unwrap_err().message,
            tv("net.trop_de_redirections", &[("host", &s.hote())])
        );
    }

    #[tokio::test]
    async fn inactivite_et_serveur_lent() {
        let s = servir(|_, q| R {
            statut: 200,
            entetes: vec![],
            corps: if q.chemin == "/muet" {
                Corps::Muet(b"a".to_vec())
            } else {
                Corps::Lent { donnees: b"bbbbbbbb".to_vec(), morceau: 1, delai: Duration::from_millis(60) }
            },
            avant: Duration::ZERO,
        })
        .await;
        let r = reseau();
        let lent = Options { inactivite: Duration::from_millis(200), ..o() };
        assert_eq!(r.octets(&format!("{}/lent", s.base), &lent).await.unwrap(), b"bbbbbbbb");
        let avant = s.nombre();
        let muet = Options { inactivite: Duration::from_millis(150), ..o() };
        assert!(r.octets(&format!("{}/muet", s.base), &muet).await.unwrap_err().a_le_code("NET_IDLE"));
        assert_eq!(s.nombre() - avant, 4);
    }

    #[tokio::test]
    async fn limites_par_serveur_et_au_total() {
        let lent = |_: usize, _: &crate::essai_http::Requete| R { avant: Duration::from_millis(40), ..R::simple(200, "x") };
        let (un, deux) = (servir(lent).await, servir(lent).await);
        let r = reseau();
        r.limiter(Some(5), Some(3));
        let urls: Vec<String> = (0..12).flat_map(|i| [format!("{}/{i}", un.base), format!("{}/{i}", deux.base)]).collect();
        let options = o();
        futures_util::future::join_all(urls.iter().map(|u| r.octets(u, &options))).await.into_iter().for_each(|x| assert!(x.is_ok()));
        let (m1, m2) = (un.stats.lock().unwrap().max_actives, deux.stats.lock().unwrap().max_actives);
        assert_eq!(un.nombre(), 12);
        assert!(m1 <= 3 && m2 <= 3, "par serveur : {m1}, {m2}");
        assert!(m1 + m2 >= 4, "les deux serveurs travaillent en même temps");
    }

    #[tokio::test]
    async fn pause_annoncee_par_le_serveur() {
        let s = servir(|n, _| {
            if n == 1 { R::simple(200, "x").avec("X-Ratelimit-Remaining", "0").avec("X-Ratelimit-Reset", "1") } else { R::simple(200, "x") }
        })
        .await;
        let r = reseau();
        r.octets(&format!("{}/1", s.base), &o()).await.unwrap();
        let debut = Instant::now();
        r.octets(&format!("{}/2", s.base), &o()).await.unwrap();
        assert!(debut.elapsed() >= Duration::from_millis(900));
    }

    #[tokio::test]
    async fn annulation_pendant_l_attente_et_la_lecture() {
        let s = servir(|_, q| {
            if q.chemin == "/attente" {
                R::simple(503, "").avec("Retry-After", "30")
            } else {
                R { corps: Corps::Muet(b"a".to_vec()), ..R::simple(200, "") }
            }
        })
        .await;
        let r = reseau();
        for chemin in ["/attente", "/lecture"] {
            let jeton = CancellationToken::new();
            let j = jeton.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                j.cancel();
            });
            let debut = Instant::now();
            let e = r.octets(&format!("{}{chemin}", s.base), &Options::annulable(Some(&jeton))).await.unwrap_err();
            assert!(e.a_le_code("CANCELLED"), "{chemin} : {e:?}");
            assert!(debut.elapsed() < Duration::from_secs(2));
        }
    }

    #[tokio::test]
    async fn reponse_ouverte_et_places_rendues() {
        let s = servir(|_, _| R::simple(200, "abc")).await;
        let r = reseau();
        r.limiter(None, Some(1));
        let mut rep = r.requete(&format!("{}/a", s.base), &o()).await.unwrap();
        let mut corps = vec![];
        while let Some(m) = rep.morceau().await.unwrap() {
            corps.extend_from_slice(&m);
        }
        assert_eq!(corps, b"abc");
        drop(rep);
        // Avec une seule place par serveur, la deuxième requête n'aboutit que si la première l'a rendue.
        assert_eq!(r.octets(&format!("{}/b", s.base), &o()).await.unwrap(), b"abc");
    }
}
