//! Téléchargements vérifiés (core/download.js) : écrits au fil de l'eau dans un « .part », SHA-1 / SHA-512 et taille
//! contrôlés au passage, reprise des gros fichiers coupés, plusieurs fichiers en parallèle.
//! Les requêtes (HTTPS, essais, délais, limites) passent par net.

use crate::erreur::{Erreur, Resultat};
use crate::i18n::tv;
use crate::net::{Options, Reseau, annulee, hote};
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use sha1::Digest;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

/// Taille à partir de laquelle un fichier coupé reprend où il s'était arrêté (en dessous, il recommence).
pub const REPRISE_MIN: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Tache {
    pub url: String,
    pub chemin: PathBuf,
    pub sha1: Option<String>,
    pub sha512: Option<String>,
    pub taille: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Progression {
    pub fait: usize,
    pub total: usize,
    pub octets_faits: u64,
    pub octets_total: u64,
    /// Octets par seconde.
    pub vitesse: Option<f64>,
    /// Secondes restantes (None si une taille manque).
    pub reste: Option<u64>,
}

fn nom(chemin: &Path) -> String {
    chemin.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn hex(octets: &[u8]) -> String {
    octets.iter().map(|b| format!("{b:02x}")).collect()
}

/// Empreinte d'un fichier, lu par morceaux (sha1 ou sha512).
pub fn empreinte_fichier(chemin: &Path, sha512: bool) -> std::io::Result<String> {
    let mut f = std::fs::File::open(chemin)?;
    let mut b = vec![0u8; 256 * 1024];
    let (mut h1, mut h5) = (sha1::Sha1::new(), sha2::Sha512::new());
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        if sha512 { h5.update(&b[..n]) } else { h1.update(&b[..n]) }
    }
    Ok(if sha512 { hex(&h5.finalize()) } else { hex(&h1.finalize()) })
}

pub fn sha1(octets: &[u8]) -> String {
    hex(&sha1::Sha1::digest(octets))
}

/// Un fichier déjà présent est gardé si sa taille est bonne (rapide). Avec `verifier`, ou si seule l'empreinte
/// est connue, l'empreinte est recalculée (SHA-512 si connue, sinon SHA-1).
async fn est_valide(t: &Tache, verifier: bool) -> bool {
    let Ok(m) = tokio::fs::metadata(&t.chemin).await else { return false };
    if t.taille.is_some_and(|n| n != m.len()) {
        return false;
    }
    if verifier || t.taille.is_none() {
        let (chemin, attendu, sha512) = match (&t.sha512, &t.sha1) {
            (Some(h), _) => (t.chemin.clone(), h.clone(), true),
            (None, Some(h)) => (t.chemin.clone(), h.clone(), false),
            _ => return m.len() > 0,
        };
        return tokio::task::spawn_blocking(move || empreinte_fichier(&chemin, sha512).is_ok_and(|h| h == attendu)).await.unwrap_or(false);
    }
    m.len() > 0
}

/// Fichier reçu mais faux (taille ou empreinte) : le « .part » est jeté et le fichier recommence une fois de zéro.
fn faux(message: String) -> Erreur {
    Erreur::code(message, "DOWNLOAD_BAD")
}

/// Renommage final ; sous Windows, un antivirus peut tenir le fichier un instant.
async fn renommer(de: &Path, vers: &Path) -> Resultat<()> {
    let mut essai = 1;
    loop {
        match tokio::fs::rename(de, vers).await {
            Ok(()) => return Ok(()),
            Err(e) if essai < 5 && (e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32)) => {
                tokio::time::sleep(std::time::Duration::from_millis(100 * essai)).await;
                essai += 1;
            }
            Err(e) => return Err(e.into()),
        }
    }
}

type Rappel = Arc<dyn Fn(u64) + Send + Sync>;

/// Un essai : reprend `part` là où il s'est arrêté (gros fichier dont la taille et l'empreinte sont connues), sinon
/// recommence. Le corps est écrit au fil de l'eau, empreintes et taille calculées au passage.
async fn vers_part(
    reseau: &Reseau,
    t: &Tache,
    part: &Path,
    annule: Option<&CancellationToken>,
    recu: Option<&Rappel>,
    reprise: bool,
) -> Resultat<()> {
    let peut_reprendre = reprise && t.taille.is_some_and(|n| n >= REPRISE_MIN) && (t.sha1.is_some() || t.sha512.is_some());
    let mut debut = 0u64;
    if peut_reprendre {
        debut = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);
        if t.taille.is_some_and(|n| debut >= n) {
            debut = 0; // « .part » complet mais jamais renommé : on recommence
        }
    }
    // Un seul essai ici : avec_essais (dans telecharger) refait tout l'échange, corps compris.
    let une_fois = |entetes| Options { annule, essais: 1, entetes, ..Options::default() };
    let plage = if debut > 0 { vec![("Range".to_string(), format!("bytes={debut}-"))] } else { vec![] };
    let mut rep = reseau.requete(&t.url, &une_fois(plage)).await?;
    if debut > 0 {
        let depart = rep
            .entete("content-range")
            .and_then(|v| v.strip_prefix("bytes "))
            .and_then(|v| v.split('-').next())
            .and_then(|v| v.parse::<u64>().ok());
        if rep.statut != 206 || depart != Some(debut) {
            // Le serveur renvoie le fichier entier (ou un autre morceau) : on repart de zéro.
            drop(rep);
            debut = 0;
            rep = reseau.requete(&t.url, &une_fois(vec![])).await?;
        }
    }

    let (mut h1, mut h5) = (t.sha1.as_ref().map(|_| sha1::Sha1::new()), t.sha512.as_ref().map(|_| sha2::Sha512::new()));
    if debut > 0 {
        let mut f = std::fs::File::open(part)?.take(debut);
        let mut b = vec![0u8; 256 * 1024];
        loop {
            let n = f.read(&mut b)?;
            if n == 0 {
                break;
            }
            h1.iter_mut().for_each(|h| h.update(&b[..n]));
            h5.iter_mut().for_each(|h| h.update(&b[..n]));
        }
    }
    let mut recus = debut;
    if let Some(r) = recu {
        r(recus);
    }
    let fichier =
        if debut > 0 { tokio::fs::OpenOptions::new().append(true).open(part).await? } else { tokio::fs::File::create(part).await? };
    let mut sortie = tokio::io::BufWriter::with_capacity(256 * 1024, fichier);
    let taille_fausse = || faux(tv("download.taille_inattendue_pour", &[("path", &nom(&t.chemin))]));
    while let Some(m) = rep.morceau().await? {
        h1.iter_mut().for_each(|h| h.update(&m));
        h5.iter_mut().for_each(|h| h.update(&m));
        recus += m.len() as u64;
        if t.taille.is_some_and(|n| recus > n) {
            return Err(taille_fausse());
        }
        sortie.write_all(&m).await?;
        if let Some(r) = recu {
            r(recus);
        }
    }
    sortie.flush().await?;
    drop(sortie);
    drop(rep);
    if t.taille.is_some_and(|n| recus != n) {
        return Err(taille_fausse());
    }
    if let (Some(h), Some(attendu)) = (h5, &t.sha512)
        && hex(&h.finalize()) != *attendu
    {
        return Err(faux(tv("download.fichier_corrompu_sha512", &[("path", &nom(&t.chemin))])));
    }
    if let (Some(h), Some(attendu)) = (h1, &t.sha1)
        && hex(&h.finalize()) != *attendu
    {
        return Err(faux(tv("download.fichier_corrompu_sha", &[("path", &nom(&t.chemin))])));
    }
    Ok(())
}

async fn telecharger(
    reseau: Arc<Reseau>,
    t: Tache,
    verifier: bool,
    annule: Option<CancellationToken>,
    recu: Option<Rappel>,
) -> Resultat<bool> {
    if est_valide(&t, verifier).await {
        return Ok(false);
    }
    if let Some(d) = t.chemin.parent() {
        tokio::fs::create_dir_all(d).await?;
    }
    let part = PathBuf::from(format!("{}.part", t.chemin.display()));
    let hote = reseau.url_sure(&t.url).map(|u| hote(&u)).unwrap_or_default();
    let annule = annule.as_ref();
    // Une coupure est réessayée (en reprenant si possible) ; un fichier faux recommence une fois de zéro.
    for neuf in 0..2 {
        let r = reseau
            .avec_essais(
                &hote,
                crate::net::ESSAIS,
                annule,
                |e| !e.a_le_code("DOWNLOAD_BAD") && !e.a_le_code("IO"),
                |_| vers_part(&reseau, &t, &part, annule, recu.as_ref(), neuf == 0),
            )
            .await;
        match r {
            Ok(()) => {
                renommer(&part, &t.chemin).await?;
                return Ok(true);
            }
            Err(_) if annule.is_some_and(CancellationToken::is_cancelled) => return Err(annulee()),
            Err(e) if e.a_le_code("DOWNLOAD_BAD") => {
                let _ = tokio::fs::remove_file(&part).await;
                if neuf == 1 {
                    return Err(e);
                }
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("la boucle rend toujours un résultat")
}

type EnCours = Shared<BoxFuture<'static, Resultat<bool>>>;

/// Téléchargements partagés : deux demandes du même fichier attendent le même téléchargement.
pub struct Telechargeur {
    pub reseau: Arc<Reseau>,
    en_cours: Mutex<HashMap<String, EnCours>>,
}

impl Telechargeur {
    pub fn new(reseau: Arc<Reseau>) -> Arc<Self> {
        Arc::new(Self { reseau, en_cours: Mutex::default() })
    }

    /// Télécharge `t` si besoin. Renvoie true si un téléchargement a eu lieu.
    /// `recu(octets)` : octets du fichier déjà reçus (reprise comprise), à chaque morceau.
    pub async fn fichier(
        self: &Arc<Self>,
        t: Tache,
        verifier: bool,
        annule: Option<CancellationToken>,
        recu: Option<Rappel>,
    ) -> Resultat<bool> {
        let cle = std::path::absolute(&t.chemin).unwrap_or_else(|_| t.chemin.clone()).to_string_lossy().to_lowercase();
        let futur = {
            let mut en_cours = self.en_cours.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(f) = en_cours.get(&cle) {
                f.clone()
            } else {
                let moi = self.clone();
                let c = cle.clone();
                let f = async move {
                    let r = telecharger(moi.reseau.clone(), t, verifier, annule, recu).await;
                    moi.en_cours.lock().unwrap_or_else(|e| e.into_inner()).remove(&c);
                    r
                }
                .boxed()
                .shared();
                en_cours.insert(cle, f.clone());
                f
            }
        };
        futur.await
    }

    /// Télécharge une liste de fichiers (`concurrence` à la fois ; net applique aussi ses limites).
    /// `progression` au plus toutes les 100 ms : octets comptés à leur arrivée, vitesse, temps restant.
    pub async fn tous(
        self: &Arc<Self>,
        taches: Vec<Tache>,
        concurrence: usize,
        verifier: bool,
        annule: Option<CancellationToken>,
        progression: Option<Arc<dyn Fn(Progression) + Send + Sync>>,
    ) -> Resultat<()> {
        let mut vues = std::collections::HashSet::new();
        let uniques: Vec<Tache> = taches
            .into_iter()
            .rev()
            .filter(|t| vues.insert(t.chemin.to_string_lossy().to_lowercase()))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let total = uniques.len();
        let octets_total: u64 = uniques.iter().filter_map(|t| t.taille).sum();
        let tailles_connues = uniques.iter().all(|t| t.taille.is_some());

        struct Suivi {
            fait: usize,
            finis: u64,
            transferes: u64,
            courants: HashMap<usize, u64>,
            dernier: Option<Instant>,
            vitesse: Option<f64>,
            compteur: Compteur,
        }
        let suivi = Arc::new(Mutex::new(Suivi {
            fait: 0,
            finis: 0,
            transferes: 0,
            courants: HashMap::new(),
            dernier: None,
            vitesse: None,
            compteur: Compteur::new(),
        }));
        let rapport = {
            let suivi = suivi.clone();
            move |force: bool| {
                let Some(p) = &progression else { return };
                let mut s = suivi.lock().unwrap_or_else(|e| e.into_inner());
                if !force && s.dernier.is_some_and(|d| d.elapsed().as_millis() < 100) {
                    return;
                }
                s.dernier = Some(Instant::now());
                let transferes = s.transferes;
                s.vitesse = s.compteur.mesurer(transferes).or(s.vitesse);
                let octets_faits = s.finis + s.courants.values().sum::<u64>();
                let reste = match (tailles_connues, s.vitesse) {
                    (true, Some(v)) if v > 0.0 => Some(((octets_total.saturating_sub(octets_faits)) as f64 / v).round() as u64),
                    _ => None,
                };
                let etat = Progression { fait: s.fait, total, octets_faits, octets_total, vitesse: s.vitesse, reste };
                drop(s);
                p(etat);
            }
        };
        let rapport = Arc::new(rapport);
        rapport(true);
        let erreurs = Arc::new(Mutex::new(Vec::<(Tache, Erreur)>::new()));
        let futurs = uniques.into_iter().enumerate().map(|(i, t)| {
            let (suivi, rapport, erreurs, annule, moi) = (suivi.clone(), rapport.clone(), erreurs.clone(), annule.clone(), self.clone());
            async move {
                let vu = Arc::new(Mutex::new(None::<u64>));
                suivi.lock().unwrap_or_else(|e| e.into_inner()).courants.insert(i, 0);
                let recu: Rappel = {
                    let (vu, suivi, rapport) = (vu.clone(), suivi.clone(), rapport.clone());
                    Arc::new(move |n| {
                        {
                            let mut v = vu.lock().unwrap_or_else(|e| e.into_inner());
                            let mut s = suivi.lock().unwrap_or_else(|e| e.into_inner());
                            // Une reprise compte comme déjà reçu ; seuls les nouveaux octets font la vitesse.
                            if let Some(avant) = *v
                                && n > avant
                            {
                                s.transferes += n - avant;
                            }
                            *v = Some(n);
                            s.courants.insert(i, n);
                        }
                        rapport(false);
                    })
                };
                let r = moi.fichier(t.clone(), verifier, annule, Some(recu)).await;
                {
                    let mut s = suivi.lock().unwrap_or_else(|e| e.into_inner());
                    s.courants.remove(&i);
                    s.fait += 1;
                    s.finis += t.taille.or(*vu.lock().unwrap_or_else(|e| e.into_inner())).unwrap_or(0);
                }
                rapport(false);
                if let Err(e) = r {
                    erreurs.lock().unwrap_or_else(|e| e.into_inner()).push((t, e));
                }
            }
        });
        let flux = futures_util::stream::iter(futurs);
        futures_util::StreamExt::for_each_concurrent(flux, concurrence.max(1), |f| f).await;
        if annule.as_ref().is_some_and(CancellationToken::is_cancelled) {
            return Err(annulee());
        }
        rapport(true);
        let erreurs = std::mem::take(&mut *erreurs.lock().unwrap_or_else(|e| e.into_inner()));
        if let Some((t, e)) = erreurs.first() {
            let n = erreurs.len().to_string();
            return Err(Erreur::code(
                tv("download.failed", &[("count", &n), ("file", &nom(&t.chemin)), ("error", &e.message)]),
                "DOWNLOAD_FAILED",
            ));
        }
        Ok(())
    }
}

/// Vitesse : moyenne glissante sur les 3 dernières secondes (None tant qu'il n'y a pas une demi-seconde de mesures).
pub struct Compteur {
    mesures: std::collections::VecDeque<(f64, u64)>,
    debut: Instant,
    horloge: Option<Box<dyn FnMut() -> f64 + Send>>,
}

impl Compteur {
    pub fn new() -> Self {
        Self { mesures: Default::default(), debut: Instant::now(), horloge: None }
    }
    /// Horloge en millisecondes fournie par le test.
    pub fn avec_horloge(horloge: impl FnMut() -> f64 + Send + 'static) -> Self {
        Self { horloge: Some(Box::new(horloge)), ..Self::new() }
    }
    /// `transferes` : octets reçus depuis le début ; renvoie des octets par seconde.
    pub fn mesurer(&mut self, transferes: u64) -> Option<f64> {
        let a = match &mut self.horloge {
            Some(h) => h(),
            None => self.debut.elapsed().as_secs_f64() * 1000.0,
        };
        self.mesures.push_back((a, transferes));
        while self.mesures.len() > 2 && a - self.mesures[1].0 >= 3000.0 {
            self.mesures.pop_front();
        }
        let (t0, o0) = self.mesures[0];
        let ecoule = a - t0;
        (ecoule >= 500.0).then(|| (transferes.saturating_sub(o0)) as f64 * 1000.0 / ecoule)
    }
}

impl Default for Compteur {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use crate::essai_http::{Corps, Reponse as R, Requete, Serveur, servir};
    use std::time::Duration;

    fn gros() -> Vec<u8> {
        let mut x = 0x9e37_79b9_u32;
        (0..5 * 1024 * 1024 + 123)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }
    fn sha512(d: &[u8]) -> String {
        hex(&sha2::Sha512::digest(d))
    }
    fn outil() -> Arc<Telechargeur> {
        let r = Reseau::new();
        r.pour_essais(&["127.0.0.1"], 1);
        Telechargeur::new(Arc::new(r))
    }

    /// Serveur qui sert `donnees` (Range compris sauf `ignorer_range`) ; `couper(n)` : octets envoyés avant de couper.
    async fn serveur(
        donnees: Vec<u8>,
        couper: impl Fn(usize) -> Option<usize> + Send + Sync + 'static,
        ignorer_range: bool,
        statut: u16,
    ) -> Serveur {
        let donnees = Arc::new(donnees);
        servir(move |n, q: &Requete| {
            if statut != 200 {
                return R::simple(statut, "");
            }
            let debut = q
                .entete("range")
                .filter(|_| !ignorer_range)
                .and_then(|r| r.strip_prefix("bytes=")?.strip_suffix('-')?.parse::<usize>().ok());
            let corps = donnees[debut.unwrap_or(0)..].to_vec();
            let mut r = match couper(n) {
                Some(apres) => R { corps: Corps::Coupe { longueur: corps.len(), donnees: corps, apres }, ..R::simple(200, "") },
                None => R { corps: Corps::Entier(corps), ..R::simple(200, "") },
            };
            if let Some(d) = debut {
                r.statut = 206;
                r = r.avec("Content-Range", &format!("bytes {d}-{}/{}", donnees.len() - 1, donnees.len()));
            }
            r
        })
        .await
    }
    fn plages(s: &Serveur) -> Vec<Option<String>> {
        s.requetes().iter().map(|q| q.entete("range").map(str::to_string)).collect()
    }
    fn tache(s: &Serveur, chemin: PathBuf) -> Tache {
        Tache { url: format!("{}/fichier", s.base), chemin, ..Tache::default() }
    }

    #[tokio::test]
    async fn petit_fichier_ecrit_puis_garde() {
        let d = Dossier::nouveau("dl-petit");
        let petit = b"petit fichier de test".to_vec();
        let s = serveur(petit.clone(), |_| None, false, 200).await;
        let t = Tache { sha1: Some(sha1(&petit)), taille: Some(petit.len() as u64), ..tache(&s, d.0.join("a/petit.txt")) };
        let vus = Arc::new(Mutex::new(vec![]));
        let v = vus.clone();
        let o = outil();
        assert!(o.fichier(t.clone(), false, None, Some(Arc::new(move |n| v.lock().unwrap().push(n)))).await.unwrap());
        assert_eq!(std::fs::read(&t.chemin).unwrap(), petit);
        assert!(!d.0.join("a/petit.txt.part").exists());
        assert_eq!(vus.lock().unwrap().last(), Some(&(petit.len() as u64)));
        assert!(!o.fichier(t, false, None, None).await.unwrap());
        assert_eq!(s.nombre(), 1);
    }

    #[tokio::test]
    async fn empreintes_verifiees() {
        let d = Dossier::nouveau("dl-empreintes");
        let petit = b"petit fichier de test".to_vec();
        let s = serveur(petit.clone(), |_| None, false, 200).await;
        let o = outil();
        let cible = d.0.join("faux.txt");
        let e = o.fichier(Tache { sha512: Some(sha512(b"autre")), ..tache(&s, cible.clone()) }, false, None, None).await.unwrap_err();
        assert_eq!(e.message, tv("download.fichier_corrompu_sha512", &[("path", "faux.txt")]));
        assert_eq!(s.nombre(), 2);
        let e = o
            .fichier(Tache { sha1: Some("f".repeat(40)), sha512: Some(sha512(&petit)), ..tache(&s, cible.clone()) }, false, None, None)
            .await
            .unwrap_err();
        assert_eq!(e.message, tv("download.fichier_corrompu_sha", &[("path", "faux.txt")]));
        assert!(!cible.exists() && !d.0.join("faux.txt.part").exists());
        assert!(
            o.fichier(Tache { sha1: Some(sha1(&petit)), sha512: Some(sha512(&petit)), ..tache(&s, cible) }, false, None, None)
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn taille_inattendue() {
        let d = Dossier::nouveau("dl-taille");
        let petit = b"petit fichier de test".to_vec();
        let s = serveur(petit.clone(), |_| None, false, 200).await;
        let e = outil()
            .fichier(Tache { taille: Some(petit.len() as u64 - 3), ..tache(&s, d.0.join("x.txt")) }, false, None, None)
            .await
            .unwrap_err();
        assert_eq!(e.message, tv("download.taille_inattendue_pour", &[("path", "x.txt")]));
    }

    #[tokio::test]
    async fn gros_fichier_coupe_reprend() {
        let d = Dossier::nouveau("dl-reprise");
        let g = gros();
        let s = serveur(g.clone(), |n| (n == 1).then_some(2 * 1024 * 1024), false, 200).await;
        let t = Tache { sha1: Some(sha1(&g)), taille: Some(g.len() as u64), ..tache(&s, d.0.join("gros.bin")) };
        let vus = Arc::new(Mutex::new(vec![]));
        let v = vus.clone();
        assert!(outil().fichier(t.clone(), false, None, Some(Arc::new(move |n| v.lock().unwrap().push(n)))).await.unwrap());
        assert_eq!(sha1(&std::fs::read(&t.chemin).unwrap()), sha1(&g));
        let p = plages(&s);
        assert_eq!((p.len(), p[0].is_none()), (2, true));
        let reprise: u64 = p[1].as_deref().unwrap().trim_start_matches("bytes=").trim_end_matches('-').parse().unwrap();
        assert!((1024 * 1024..=2 * 1024 * 1024).contains(&reprise), "reprise à {reprise}");
        assert_eq!(vus.lock().unwrap().last(), Some(&(g.len() as u64)));
    }

    #[tokio::test]
    async fn range_ignore_repart_de_zero() {
        let d = Dossier::nouveau("dl-sans-range");
        let g = gros();
        let cible = d.0.join("gros.bin");
        std::fs::write(d.0.join("gros.bin.part"), &g[..3 * 1024 * 1024]).unwrap();
        let s = serveur(g.clone(), |_| None, true, 200).await;
        assert!(
            outil()
                .fichier(Tache { sha1: Some(sha1(&g)), taille: Some(g.len() as u64), ..tache(&s, cible.clone()) }, false, None, None)
                .await
                .unwrap()
        );
        assert_eq!(sha1(&std::fs::read(&cible).unwrap()), sha1(&g));
        let p = plages(&s);
        assert!(p.len() == 2 && p[0].is_some() && p[1].is_none());
    }

    #[tokio::test]
    async fn part_abime_repart_de_zero() {
        let d = Dossier::nouveau("dl-part-abime");
        let g = gros();
        let cible = d.0.join("gros.bin");
        std::fs::write(d.0.join("gros.bin.part"), vec![7u8; 1024 * 1024]).unwrap();
        let s = serveur(g.clone(), |_| None, false, 200).await;
        assert!(
            outil()
                .fichier(Tache { sha512: Some(sha512(&g)), taille: Some(g.len() as u64), ..tache(&s, cible.clone()) }, false, None, None)
                .await
                .unwrap()
        );
        assert_eq!(sha1(&std::fs::read(&cible).unwrap()), sha1(&g));
        assert_eq!(plages(&s).iter().map(Option::is_some).collect::<Vec<_>>(), [true, false]);
    }

    #[tokio::test]
    async fn petit_fichier_coupe_recommence() {
        let d = Dossier::nouveau("dl-petit-coupe");
        let donnees: Vec<u8> = (0..512 * 1024).map(|i| (i * 7) as u8).collect();
        let s = serveur(donnees.clone(), |n| (n == 1).then_some(100 * 1024), false, 200).await;
        assert!(
            outil()
                .fichier(
                    Tache { sha1: Some(sha1(&donnees)), taille: Some(donnees.len() as u64), ..tache(&s, d.0.join("p.bin")) },
                    false,
                    None,
                    None
                )
                .await
                .unwrap()
        );
        assert_eq!(plages(&s), [None, None]);
    }

    #[tokio::test]
    async fn introuvable_sans_nouvel_essai() {
        let d = Dossier::nouveau("dl-404");
        let s = serveur(vec![], |_| None, false, 404).await;
        let cible = d.0.join("absent.txt");
        assert_eq!(outil().fichier(tache(&s, cible.clone()), false, None, None).await.unwrap_err().statut, Some(404));
        assert_eq!(s.nombre(), 1);
        assert!(!cible.exists());
    }

    #[tokio::test]
    async fn annulation_pendant_l_ecriture() {
        let d = Dossier::nouveau("dl-annule");
        let g = gros();
        let s = serveur(g.clone(), |_| Some(1024 * 1024), false, 200).await;
        let cible = d.0.join("gros.bin");
        let jeton = CancellationToken::new();
        let j = jeton.clone();
        let r = outil()
            .fichier(
                Tache { sha1: Some(sha1(&g)), taille: Some(g.len() as u64), ..tache(&s, cible.clone()) },
                false,
                Some(jeton),
                Some(Arc::new(move |n| {
                    if n > 0 {
                        j.cancel()
                    }
                })),
            )
            .await;
        assert!(r.unwrap_err().a_le_code("CANCELLED"));
        assert!(!cible.exists());
    }

    #[tokio::test]
    async fn meme_fichier_deux_fois_un_seul_telechargement() {
        let d = Dossier::nouveau("dl-double");
        let petit = b"petit fichier de test".to_vec();
        let s = servir({
            let p = petit.clone();
            move |_, _| R { avant: Duration::from_millis(100), corps: Corps::Entier(p.clone()), ..R::simple(200, "") }
        })
        .await;
        let t = Tache { sha1: Some(sha1(&petit)), taille: Some(petit.len() as u64), ..tache(&s, d.0.join("double.txt")) };
        let o = outil();
        let (a, b) = tokio::join!(o.fichier(t.clone(), false, None, None), o.fichier(t, false, None, None));
        assert_eq!((a.unwrap(), b.unwrap(), s.nombre()), (true, true, 1));
    }

    #[test]
    fn compteur_de_vitesse() {
        let maintenant = Arc::new(Mutex::new(0.0));
        let m = maintenant.clone();
        let mut c = Compteur::avec_horloge(move || *m.lock().unwrap());
        assert_eq!(c.mesurer(0), None);
        *maintenant.lock().unwrap() = 400.0;
        assert_eq!(c.mesurer(400_000), None);
        *maintenant.lock().unwrap() = 1000.0;
        assert_eq!(c.mesurer(1_000_000), Some(1_000_000.0));
        *maintenant.lock().unwrap() = 5000.0;
        assert_eq!(c.mesurer(1_000_000), Some(0.0));
    }

    #[tokio::test]
    async fn liste_avec_progression() {
        let d = Dossier::nouveau("dl-liste");
        let donnees: Vec<u8> = (0..256 * 1024).map(|i| (i * 13 + 5) as u8).collect();
        let s = servir({
            let p = donnees.clone();
            move |_, _| R {
                corps: Corps::Lent { donnees: p.clone(), morceau: 32 * 1024, delai: Duration::from_millis(100) },
                ..R::simple(200, "")
            }
        })
        .await;
        let present = d.0.join("deja.bin");
        std::fs::write(&present, &donnees).unwrap();
        let t = |c: PathBuf| Tache {
            url: format!("{}/f", s.base),
            chemin: c,
            sha1: Some(sha1(&donnees)),
            taille: Some(donnees.len() as u64),
            ..Tache::default()
        };
        let rapports = Arc::new(Mutex::new(vec![]));
        let r = rapports.clone();
        outil()
            .tous(
                vec![t(present), t(d.0.join("a.bin")), t(d.0.join("b.bin"))],
                2,
                false,
                None,
                Some(Arc::new(move |p| r.lock().unwrap().push(p))),
            )
            .await
            .unwrap();
        let rapports = rapports.lock().unwrap();
        let n = donnees.len() as u64;
        let dernier = rapports.last().unwrap();
        assert_eq!((dernier.fait, dernier.total, dernier.octets_faits, dernier.octets_total), (3, 3, 3 * n, 3 * n));
        assert!(
            rapports.iter().filter(|p| p.octets_faits > n && p.octets_faits < 3 * n).count() >= 3,
            "des octets arrivent avant la fin des fichiers"
        );
        let avec_vitesse: Vec<f64> = rapports.iter().filter_map(|p| p.vitesse).collect();
        assert!(!avec_vitesse.is_empty(), "vitesse mesurée");
        assert!(avec_vitesse.iter().all(|&v| v < 3.0 * n as f64), "vitesse : {avec_vitesse:?}");
        assert!(rapports.iter().any(|p| p.reste.is_some()));
        assert!(rapports.windows(2).all(|w| w[1].octets_faits >= w[0].octets_faits));
    }
}
