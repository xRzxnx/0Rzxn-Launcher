//! Fichiers temporaires abandonnés (core/temp-files.js) : téléchargements interrompus (« .part ») et anciens « .tmp »
//! d'avant la phase 4. Seuls les dossiers où le launcher télécharge sont parcourus ; jamais les mondes (« saves »).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

const HEURE: Duration = Duration::from_secs(3600);
const JOUR: Duration = Duration::from_secs(24 * 3600);
const DOSSIERS_DE_CONTENU: [&str; 3] = ["mods", "resourcepacks", "shaderpacks"];

/// Âge au-delà duquel un fichier de ce nom est retiré (None : jamais).
type Regle = fn(&str) -> Option<Duration>;

/// Ancien fichier temporaire « nom.<pid>.<n>.tmp ».
fn ancien_tmp(nom: &str) -> bool {
    let Some(base) = nom.strip_suffix(".tmp") else { return false };
    let mut parts = base.rsplitn(3, '.');
    let (n, pid) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    parts.next().is_some() && [n, pid].iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Téléchargements : « .part » gardés 7 jours (reprise possible), « .tmp » des anciennes versions retirés après 1 heure.
fn age_max_telechargement(nom: &str) -> Option<Duration> {
    if nom.ends_with(".part") {
        Some(7 * JOUR)
    } else if ancien_tmp(nom) {
        Some(HEURE)
    } else {
        None
    }
}

/// Sauvegardes de mondes : un « .part » de plus d'un jour est une sauvegarde qui ne finira jamais.
fn age_max_sauvegarde(nom: &str) -> Option<Duration> {
    nom.ends_with(".part").then_some(JOUR)
}

/// Fichiers d'un dossier (et de ses sous-dossiers si `profond`) ; les liens ne sont pas suivis.
fn fichiers(dossier: &Path, profond: bool, sortie: &mut Vec<PathBuf>) {
    let Ok(it) = std::fs::read_dir(dossier) else { return };
    for e in it.flatten() {
        match e.file_type() {
            Ok(t) if t.is_file() => sortie.push(e.path()),
            Ok(t) if t.is_dir() && profond => fichiers(&e.path(), profond, sortie),
            _ => {}
        }
    }
}

/// Retire les fichiers temporaires abandonnés sous la racine du jeu. Renvoie (nombre, octets).
pub fn nettoyer(racine: &Path, maintenant: SystemTime, annule: &AtomicBool) -> (u64, u64) {
    let mut lieux: Vec<(PathBuf, bool, Regle)> = ["versions", "libraries", "assets", "runtime", "cache"]
        .iter()
        .map(|d| (racine.join(d), true, age_max_telechargement as Regle))
        .collect();
    if let Ok(it) = std::fs::read_dir(racine.join("instances")) {
        for e in it.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())) {
            for d in DOSSIERS_DE_CONTENU {
                lieux.push((e.path().join("minecraft").join(d), false, age_max_telechargement));
            }
        }
    }
    lieux.push((racine.join("backups"), true, age_max_sauvegarde));

    let (mut nombre, mut octets) = (0, 0);
    for (dossier, profond, regle) in lieux {
        let mut liste = vec![];
        fichiers(&dossier, profond, &mut liste);
        for f in liste {
            if annule.load(Ordering::Relaxed) {
                return (nombre, octets);
            }
            let Some(age_max) = f.file_name().and_then(|n| regle(&n.to_string_lossy())) else { continue };
            // Fichier disparu ou verrouillé : il sera retiré une autre fois.
            let Ok(m) = std::fs::metadata(&f) else { continue };
            let age = m.modified().ok().and_then(|t| maintenant.duration_since(t).ok()).unwrap_or_default();
            if age < age_max {
                continue;
            }
            if std::fs::remove_file(&f).is_ok() {
                nombre += 1;
                octets += m.len();
            }
        }
    }
    (nombre, octets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;

    #[test]
    fn nettoyage_selon_l_age_et_le_lieu() {
        let d = Dossier::nouveau("temporaires");
        let maintenant = SystemTime::now();
        let fichiers = [
            ("versions/1.21.11/1.21.11.jar.part", 8 * JOUR, false),
            ("libraries/org/a/a.jar.part", 2 * JOUR, true),
            ("assets/objects/ab/abcdef.4242.1.tmp", 2 * HEURE, false),
            ("runtime/java/bin/java.dll.4242.2.tmp", Duration::from_secs(600), true),
            ("cache/modpacks/pack.mrpack.part", 30 * JOUR, false),
            ("instances/survie/minecraft/mods/sodium.jar.part", 9 * JOUR, false),
            ("instances/survie/minecraft/saves/Monde/region.part", 90 * JOUR, true),
            ("instances/survie/minecraft/mods/sous/x.jar.part", 90 * JOUR, true),
            ("backups/survie/Monde_2026.zip.part", 2 * JOUR, false),
            ("backups/survie/Monde_2026-2.zip.part", 2 * HEURE, true),
            ("libraries/org/a/a.jar", 400 * JOUR, true),
            ("versions/notes.tmp", 400 * JOUR, true),
        ];
        for (chemin, age, _) in fichiers {
            d.ecrire(chemin, "0123456789");
            std::fs::File::options().write(true).open(d.0.join(chemin)).unwrap().set_modified(maintenant - age).unwrap();
        }
        assert_eq!(nettoyer(&d.0, maintenant, &AtomicBool::new(false)), (5, 50));
        for (chemin, _, garde) in fichiers {
            assert_eq!(d.0.join(chemin).exists(), garde, "{chemin}");
        }
    }

    #[test]
    fn dossiers_absents() {
        assert_eq!(nettoyer(Path::new("Z:/0rzxn-absent"), SystemTime::now(), &AtomicBool::new(false)), (0, 0));
    }
}
