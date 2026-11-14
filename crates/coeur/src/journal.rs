//! Journal général du launcher (technique, jamais affiché), comme core/journal.js : un fichier par démarrage
//! dans <données>/logs, les précédents gardés (launcher.log, launcher-1.log … launcher-4.log), un nouveau fichier
//! quand celui-ci devient trop gros. Les secrets sont masqués avant l'écriture. Écriture synchrone : une erreur
//! juste avant un plantage est quand même notée. Le journal ne doit jamais gêner le launcher.

use chrono::{Local, NaiveDateTime};
use regex::Regex;
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Niveau {
    Debug = 10,
    Info = 20,
    Warn = 30,
    Error = 40,
}

impl Niveau {
    fn nom(self) -> &'static str {
        match self {
            Niveau::Debug => "DEBUG",
            Niveau::Info => "INFO",
            Niveau::Warn => "WARN",
            Niveau::Error => "ERROR",
        }
    }
}

const MASQUE: &str = "••••••••";

/// Jetons repérés à leur forme, même s'ils n'ont pas été déclarés.
static MOTIFS: LazyLock<[(Regex, String); 3]> = LazyLock::new(|| {
    [
        (Regex::new(r"eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}").unwrap(), MASQUE.to_string()),
        (Regex::new(r"(--accessToken|--xuid|--clientId)(\s+)\S+").unwrap(), format!("${{1}}${{2}}{MASQUE}")),
        (Regex::new(r#"(?i)("?(?:access_?token|refresh_?token|id_?token)"?\s*[:=]\s*"?)[^"\s,}&]+"#).unwrap(), format!("${{1}}{MASQUE}")),
    ]
});

/// Remplace les secrets (jeton de connexion…) par des points ; les secrets de moins de 8 caractères restent.
pub fn censurer<'a>(texte: &str, secrets: impl IntoIterator<Item = &'a str>) -> String {
    let mut sortie = texte.to_string();
    for s in secrets {
        if s.chars().count() >= 8 {
            sortie = sortie.replace(s, MASQUE);
        }
    }
    sortie
}

/// « 2026-11-09 14:03:12.345 », heure locale.
pub fn horodatage(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

pub struct Options {
    pub dossier: PathBuf,
    pub nom: String,
    pub garder: usize,
    pub max_octets: u64,
    pub niveau: Niveau,
    pub horloge: fn() -> NaiveDateTime,
}

impl Options {
    pub fn new(dossier: impl Into<PathBuf>) -> Self {
        Self {
            dossier: dossier.into(),
            nom: "launcher.log".into(),
            garder: 5,
            max_octets: 4 * 1024 * 1024,
            niveau: Niveau::Info,
            horloge: || Local::now().naive_local(),
        }
    }
}

struct Etat {
    taille: u64,
    secrets: HashSet<String>,
}

pub struct Journal {
    options: Options,
    fichier: PathBuf,
    etat: Mutex<Etat>,
}

impl Journal {
    pub fn ouvrir(options: Options) -> Self {
        let fichier = options.dossier.join(&options.nom);
        let j = Self { fichier, options, etat: Mutex::new(Etat { taille: 0, secrets: HashSet::new() }) };
        j.tourner();
        j
    }

    pub fn fichier(&self) -> &Path {
        &self.fichier
    }

    fn archive(&self, n: usize) -> PathBuf {
        let base = self.options.nom.strip_suffix(".log").unwrap_or(&self.options.nom);
        self.options.dossier.join(format!("{base}-{n}.log"))
    }

    /// Décale les anciens fichiers ; en cas d'échec (fichier ouvert ailleurs), on continue dans le fichier actuel.
    fn tourner(&self) {
        let _ = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&self.options.dossier)?;
            if self.options.garder <= 1 {
                let _ = std::fs::remove_file(&self.fichier);
                return Ok(());
            }
            let _ = std::fs::remove_file(self.archive(self.options.garder - 1));
            for n in (1..=self.options.garder.saturating_sub(2)).rev() {
                if self.archive(n).exists() {
                    std::fs::rename(self.archive(n), self.archive(n + 1))?;
                }
            }
            if self.fichier.exists() {
                std::fs::rename(&self.fichier, self.archive(1))?;
            }
            Ok(())
        })();
        if let Ok(mut e) = self.etat.lock() {
            e.taille = 0;
        }
    }

    pub fn ajouter_secret(&self, secret: &str) {
        if !secret.is_empty()
            && let Ok(mut e) = self.etat.lock()
        {
            e.secrets.insert(secret.to_string());
        }
    }

    pub fn masquer(&self, texte: &str) -> String {
        let mut sortie = match self.etat.lock() {
            Ok(e) => censurer(texte, e.secrets.iter().map(String::as_str)),
            Err(_) => texte.to_string(),
        };
        for (motif, remplacement) in MOTIFS.iter() {
            sortie = motif.replace_all(&sortie, remplacement.as_str()).into_owned();
        }
        sortie
    }

    pub fn ecrire(&self, niveau: Niveau, message: &str) {
        if niveau < self.options.niveau {
            return;
        }
        let ligne = format!("{} {:<5} {}\n", horodatage((self.options.horloge)()), niveau.nom(), self.masquer(message));
        let octets = ligne.len() as u64;
        let trop = self.etat.lock().map(|e| e.taille > 0 && e.taille + octets > self.options.max_octets).unwrap_or(false);
        if trop {
            self.tourner();
        }
        // Disque plein, dossier protégé… : le journal se tait.
        let ok = OpenOptions::new().create(true).append(true).open(&self.fichier).and_then(|mut f| f.write_all(ligne.as_bytes())).is_ok();
        if ok && let Ok(mut e) = self.etat.lock() {
            e.taille += octets;
        }
    }
}

/// Journal partagé du launcher : silencieux tant que l'app ne l'a pas ouvert.
static GLOBAL: OnceLock<Journal> = OnceLock::new();

pub fn ouvrir_global(options: Options) -> Option<&'static Journal> {
    let _ = GLOBAL.set(Journal::ouvrir(options));
    GLOBAL.get()
}

pub fn ecrire(niveau: Niveau, message: &str) {
    if let Some(j) = GLOBAL.get() {
        j.ecrire(niveau, message);
    }
}

pub fn ajouter_secret(secret: &str) {
    if let Some(j) = GLOBAL.get() {
        j.ajouter_secret(secret);
    }
}

pub fn debug(m: &str) {
    ecrire(Niveau::Debug, m)
}
pub fn info(m: &str) {
    ecrire(Niveau::Info, m)
}
pub fn warn(m: &str) {
    ecrire(Niveau::Warn, m)
}
pub fn error(m: &str) {
    ecrire(Niveau::Error, m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use chrono::NaiveDate;

    fn fixe() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 9).unwrap().and_hms_milli_opt(14, 3, 12, 345).unwrap()
    }
    fn lire(f: &Path) -> String {
        std::fs::read_to_string(f).unwrap_or_default()
    }
    fn options(d: &Path) -> Options {
        Options { horloge: fixe, ..Options::new(d) }
    }

    #[test]
    fn niveaux_et_horodatage() {
        let d = Dossier::nouveau("journal-niveaux");
        let j = Journal::ouvrir(options(&d.0.join("logs")));
        j.ecrire(Niveau::Debug, "hidden");
        j.ecrire(Niveau::Info, "Started");
        j.ecrire(Niveau::Warn, "Slow");
        let texte = lire(j.fichier());
        assert_eq!(j.fichier(), d.0.join("logs").join("launcher.log"));
        assert_eq!(texte, "2026-11-09 14:03:12.345 INFO  Started\n2026-11-09 14:03:12.345 WARN  Slow\n");
        let bavard = Journal::ouvrir(Options { niveau: Niveau::Debug, ..options(&d.0.join("logs")) });
        bavard.ecrire(Niveau::Debug, "shown");
        assert!(lire(bavard.fichier()).contains("DEBUG shown"));
    }

    #[test]
    fn secrets_et_jetons_masques() {
        let d = Dossier::nouveau("journal-secrets");
        let j = Journal::ouvrir(options(&d.0));
        let jwt = format!("eyJ{}.{}.{}", "a".repeat(20), "b".repeat(20), "c".repeat(20));
        j.ajouter_secret("mon-secret-123");
        j.ajouter_secret("court");
        j.ecrire(Niveau::Info, "token mon-secret-123 et court");
        j.ecrire(Niveau::Info, &format!("--accessToken abc.def --username Joueur {jwt}"));
        j.ecrire(Niveau::Info, r#"{"access_token":"xyz789","refresh_token":"r3fr3sh","expires_in":3600}"#);
        j.ecrire(Niveau::Info, "https://login.exemple/?code=1&access_token=qwerty&state=2");
        let texte = lire(j.fichier());
        for secret in ["mon-secret-123", "abc.def", &jwt, "xyz789", "r3fr3sh", "qwerty"] {
            assert!(!texte.contains(secret), "{secret}");
        }
        assert!(texte.contains("court") && texte.contains("--username Joueur") && texte.contains("\"expires_in\":3600"));
    }

    #[test]
    fn un_fichier_par_demarrage() {
        let d = Dossier::nouveau("journal-rotation");
        for n in 1..=7 {
            Journal::ouvrir(Options { garder: 3, ..options(&d.0) }).ecrire(Niveau::Info, &format!("run {n}"));
        }
        let mut noms: Vec<String> = std::fs::read_dir(&d.0).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        noms.sort();
        assert_eq!(noms, ["launcher-1.log", "launcher-2.log", "launcher.log"]);
        assert!(lire(&d.0.join("launcher.log")).contains("run 7"));
        assert!(lire(&d.0.join("launcher-1.log")).contains("run 6"));
        assert!(lire(&d.0.join("launcher-2.log")).contains("run 5"));
    }

    #[test]
    fn nouveau_fichier_quand_trop_gros() {
        let d = Dossier::nouveau("journal-taille");
        let j = Journal::ouvrir(Options { garder: 2, max_octets: 200, ..options(&d.0) });
        for i in 0..10 {
            j.ecrire(Niveau::Info, &format!("line {i} {}", "x".repeat(40)));
        }
        let mut noms: Vec<String> = std::fs::read_dir(&d.0).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        noms.sort();
        assert_eq!(noms, ["launcher-1.log", "launcher.log"]);
        for n in &noms {
            assert!(std::fs::metadata(d.0.join(n)).unwrap().len() <= 200);
        }
        assert!(lire(&d.0.join("launcher.log")).contains("line 9"));
    }

    #[test]
    fn dossier_impossible_aucune_panique() {
        let d = Dossier::nouveau("journal-bloque");
        d.ecrire("fichier", "");
        Journal::ouvrir(options(&d.0.join("fichier").join("logs"))).ecrire(Niveau::Error, "nowhere");
    }

    #[test]
    fn censure_des_secrets_courts() {
        assert_eq!(censurer("a 12345678 b 1234", ["12345678", "1234"]), "a •••••••• b 1234");
    }
}
