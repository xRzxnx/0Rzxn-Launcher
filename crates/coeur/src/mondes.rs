//! Mondes d'une instance, comme core/worlds.js et services/backups.js : lecture de level.dat, sauvegardes .zip (dans
//! backups\<instance>), rotation des sauvegardes automatiques et restauration. Une restauration n'écrase jamais rien :
//! extraction dans un dossier temporaire, puis renommage ; un monde remplacé part à la corbeille.

use crate::contenu::Corbeille;
use crate::erreur::{Erreur, Resultat};
use crate::fichiers::{ecrire_json, lire_json};
use crate::i18n::{t, tv};
use crate::import::lister_fichiers;
use crate::nbt;
use crate::zip::{self, AEcrire, ArchiveZip};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use commun::Reglages;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MODES: [&str; 4] = ["survival", "creative", "adventure", "spectator"];
const RAISONS: [&str; 5] = ["manual", "modpack", "version", "loader", "launch"];
pub const PREFIXE_TEMP: &str = ".restauration-";

/// Déjà compressés (régions, images, archives) : rangés tels quels, la sauvegarde va bien plus vite.
fn deja_compresse(rel: &Path) -> bool {
    rel.extension().is_some_and(|e| ["mca", "mcc", "png", "jpg", "zip", "jar", "gz"].contains(&e.to_string_lossy().to_lowercase().as_str()))
}

fn verrou(rel: &Path) -> bool {
    rel.file_name().is_some_and(|f| f == "session.lock")
}

pub fn saves(dossier_jeu: &Path) -> PathBuf {
    dossier_jeu.join("saves")
}

fn sans_mise_en_forme(texte: &str) -> String {
    let mut s = String::new();
    let mut c = texte.chars();
    while let Some(x) = c.next() {
        if x == '\u{a7}' {
            c.next();
        } else {
            s.push(x);
        }
    }
    s
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monde {
    pub folder: String,
    pub name: String,
    pub version: Option<String>,
    pub last_played: Option<i64>,
    pub hardcore: bool,
    pub mode: Option<&'static str>,
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Lit un monde (dossier avec level.dat). None si ce n'est pas un monde lisible.
pub fn lire_monde(d: &Path) -> Option<Monde> {
    let racine = nbt::lire(&std::fs::read(d.join("level.dat")).ok()?).ok()?;
    let data = racine.get("Data")?;
    if !matches!(data, nbt::Tag::Compound(_)) {
        return None;
    }
    let dossier = d.file_name()?.to_string_lossy().into_owned();
    let icone = std::fs::read(d.join("icon.png"))
        .ok()
        .filter(|p| p.len() < 256 * 1024 && p.get(1..4) == Some(b"PNG"))
        .map(|p| format!("data:image/png;base64,{}", B64.encode(p)));
    let nom = data
        .get("LevelName")
        .and_then(nbt::Tag::texte)
        .map(sans_mise_en_forme)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| dossier.clone());
    Some(Monde {
        name: nom,
        version: data.get("Version").and_then(|v| v.get("Name")).and_then(nbt::Tag::texte).map(String::from),
        last_played: data.get("LastPlayed").and_then(nbt::Tag::entier),
        hardcore: data.get("hardcore").and_then(nbt::Tag::entier) == Some(1),
        mode: data.get("GameType").and_then(nbt::Tag::entier).and_then(|g| MODES.get(g as usize).copied()),
        icon: icone,
        size: None,
        folder: dossier,
    })
}

/// Nom de dossier de monde reçu de l'interface : un seul segment, jamais un chemin.
pub fn dossier_monde(dossier_jeu: &Path, nom: &str) -> Resultat<PathBuf> {
    if nom.is_empty() || nom.contains(['/', '\\']) || nom == "." || nom == ".." || nom.starts_with(PREFIXE_TEMP) {
        return Err(Erreur::new(t("worlds.monde_invalide")));
    }
    let d = saves(dossier_jeu).join(nom);
    if !d.join("level.dat").is_file() {
        return Err(Erreur::new(t("worlds.monde_introuvable")));
    }
    Ok(d)
}

fn taille_dossier(d: &Path) -> u64 {
    lister_fichiers(d, &|_| false).unwrap_or_default().iter().filter_map(|r| std::fs::metadata(d.join(r)).ok()).map(|m| m.len()).sum()
}

/// Mondes du dossier saves (sans leur taille), du plus récemment joué au plus ancien.
pub fn mondes(dossier_jeu: &Path) -> Vec<Monde> {
    let Ok(it) = std::fs::read_dir(saves(dossier_jeu)) else { return vec![] };
    let mut l: Vec<Monde> = it
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with(PREFIXE_TEMP))
        .filter_map(|e| lire_monde(&e.path()))
        .collect();
    l.sort_by_key(|m| std::cmp::Reverse(m.last_played.unwrap_or(0)));
    l
}

/// Mondes avec leur taille.
pub fn mondes_et_tailles(dossier_jeu: &Path) -> Vec<Monde> {
    mondes(dossier_jeu).into_iter().map(|m| Monde { size: Some(taille_dossier(&saves(dossier_jeu).join(&m.folder))), ..m }).collect()
}

// ---------- Sauvegardes ----------

fn horodatage() -> String {
    chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string()
}

/// « Monde_2026-11-14_12-00-00(-2).zip » → (dossier, date en ms).
fn lire_horodatage(fichier: &str) -> Option<(String, i64)> {
    let base = fichier.strip_suffix(".zip").or_else(|| fichier.strip_suffix(".ZIP"))?;
    let essai = |b: &str| -> Option<(String, i64)> {
        let (dossier, date) = b.split_at(b.len().checked_sub(20)?);
        let t = chrono::NaiveDateTime::parse_from_str(date.strip_prefix('_')?, "%Y-%m-%d_%H-%M-%S").ok()?;
        let ms = t.and_local_timezone(chrono::Local).earliest()?.timestamp_millis();
        (!dossier.is_empty()).then(|| (dossier.to_string(), ms))
    };
    // « …-2.zip » : deuxième sauvegarde de la même seconde.
    essai(base).or_else(|| {
        base.rsplit_once('-').filter(|(_, n)| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())).and_then(|(a, _)| essai(a))
    })
}

fn fichier_index(d: &Path) -> PathBuf {
    d.join("index.json")
}

/// Nom de fichier d'une sauvegarde reçu de l'interface.
pub fn fichier_sauvegarde(d: &Path, fichier: &str) -> Resultat<PathBuf> {
    if fichier.contains(['/', '\\']) || !fichier.to_lowercase().ends_with(".zip") {
        return Err(Erreur::new(t("worlds.sauvegarde_invalide")));
    }
    let f = d.join(fichier);
    if !f.is_file() {
        return Err(Erreur::new(t("worlds.sauvegarde_introuvable")));
    }
    Ok(f)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sauvegarde {
    pub file: String,
    pub folder: String,
    pub name: String,
    pub created_at: i64,
    pub size: u64,
    /// auto | manual
    pub kind: &'static str,
    pub reason: String,
}

/// Sauvegardes d'une instance, les plus récentes d'abord.
pub fn sauvegardes(d: &Path) -> Vec<Sauvegarde> {
    let Ok(it) = std::fs::read_dir(d) else { return vec![] };
    let index: Map<String, Value> = lire_json(&fichier_index(d)).unwrap_or_default();
    let mut l: Vec<Sauvegarde> = it
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            let m = e.metadata().ok().filter(|m| m.is_file() && file.to_lowercase().ends_with(".zip"))?;
            let h = lire_horodatage(&file);
            let date = h.as_ref().map(|x| x.1).unwrap_or_else(|| crate::empreintes::Etat::de(&m).mtime_ms as i64);
            let meta = index.get(&file).cloned().unwrap_or_default();
            let folder = meta["folder"]
                .as_str()
                .map(String::from)
                .or_else(|| h.map(|x| x.0))
                .unwrap_or_else(|| file.trim_end_matches(".zip").into());
            let raison = meta["reason"].as_str().filter(|r| RAISONS.contains(r)).unwrap_or("manual").to_string();
            Some(Sauvegarde {
                name: meta["name"].as_str().map(String::from).unwrap_or_else(|| folder.clone()),
                kind: if meta["kind"] == "auto" { "auto" } else { "manual" },
                reason: raison,
                created_at: date,
                size: m.len(),
                folder,
                file,
            })
        })
        .collect();
    l.sort_by_key(|s| std::cmp::Reverse(s.created_at));
    l
}

/// Place libre sur le disque d'un dossier (None si inconnue).
pub fn place_libre(d: &Path) -> Option<u64> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let large: Vec<u16> = d.as_os_str().encode_wide().chain([0]).collect();
        let mut libre = 0u64;
        let ok = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
                large.as_ptr(),
                &mut libre,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(libre)
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(d.as_os_str().as_bytes()).ok()?;
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then(|| s.f_bavail as u64 * s.f_frsize as u64)
    }
}

fn pas_de_place(nom: &str, libre: u64, besoin: f64) -> Erreur {
    let go = |o: f64| format!("{:.1}", o / 1024f64.powi(3));
    Erreur::code(tv("worlds.pas_assez_de_place", &[("name", nom), ("free", &go(libre as f64)), ("needed", &go(besoin))]), "NO_SPACE")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Archive {
    pub file: String,
    pub name: String,
    pub folder: String,
    pub size: u64,
    pub files: usize,
}

struct Plan {
    monde: Monde,
    dossier: PathBuf,
    fichiers: Vec<PathBuf>,
}

fn archiver(
    p: &Plan,
    d: &Path,
    genre: &str,
    raison: &str,
    annule: &AtomicBool,
    progres: &mut dyn FnMut(usize, usize),
) -> Resultat<Archive> {
    std::fs::create_dir_all(d)?;
    let base = format!("{}_{}", p.monde.folder, horodatage());
    let mut fichier = format!("{base}.zip");
    let mut n = 2;
    while d.join(&fichier).exists() {
        fichier = format!("{base}-{n}.zip");
        n += 1;
    }
    let entrees: Vec<AEcrire> = p
        .fichiers
        .iter()
        .map(|rel| AEcrire {
            nom: format!(
                "{}/{}",
                p.monde.folder,
                rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
            ),
            chemin: p.dossier.join(rel),
            ranger: deja_compresse(rel),
        })
        .collect();
    let (fichiers, taille) = zip::ecrire_zip_fichier(&d.join(&fichier), &entrees, annule, progres)?;
    let mut index: Map<String, Value> = lire_json(&fichier_index(d)).unwrap_or_default();
    index.insert(fichier.clone(), json!({ "name": p.monde.name, "folder": p.monde.folder, "kind": genre, "reason": raison }));
    ecrire_json(&fichier_index(d), &index)?;
    Ok(Archive { file: fichier, name: p.monde.name.clone(), folder: p.monde.folder.clone(), size: taille, files: fichiers })
}

fn plan(dossier_jeu: &Path, m: Monde) -> Resultat<Plan> {
    let dossier = saves(dossier_jeu).join(&m.folder);
    let fichiers = lister_fichiers(&dossier, &verrou)?;
    Ok(Plan { monde: m, dossier, fichiers })
}

/// Sauvegarde un monde (à la main).
pub fn sauvegarder(
    dossier_jeu: &Path,
    nom: &str,
    d: &Path,
    annule: &AtomicBool,
    progres: &mut dyn FnMut(usize, usize),
) -> Resultat<Archive> {
    let dossier = dossier_monde(dossier_jeu, nom)?;
    let m = lire_monde(&dossier).unwrap_or(Monde {
        folder: nom.into(),
        name: nom.into(),
        version: None,
        last_played: None,
        hardcore: false,
        mode: None,
        icon: None,
        size: None,
    });
    let besoin = taille_dossier(&dossier) as f64 * 1.05;
    std::fs::create_dir_all(d)?;
    if let Some(libre) = place_libre(d).filter(|l| (*l as f64) < besoin) {
        return Err(pas_de_place(&m.name, libre, besoin));
    }
    archiver(&plan(dossier_jeu, m)?, d, "manual", "manual", annule, progres)
}

/// Sauvegarde automatique de plusieurs mondes (ceux que `filtre` garde), puis rotation des sauvegardes automatiques.
/// Rien n'est écrit si la place manque. `(raison, garder)` : pourquoi, et combien en garder par monde.
/// `progres(fait, total, monde)`.
pub fn sauvegarder_tous(
    dossier_jeu: &Path,
    d: &Path,
    (raison, garder): (&str, u32),
    corbeille: Corbeille<'_>,
    filtre: &dyn Fn(&Monde) -> bool,
    annule: &AtomicBool,
    progres: &mut dyn FnMut(usize, usize, &str),
) -> Resultat<Vec<Archive>> {
    let plans: Vec<Plan> = mondes(dossier_jeu).into_iter().filter(|m| filtre(m)).map(|m| plan(dossier_jeu, m)).collect::<Resultat<_>>()?;
    let total: usize = plans.iter().map(|p| p.fichiers.len()).sum();
    if total == 0 {
        return Ok(vec![]);
    }
    std::fs::create_dir_all(d)?;
    let besoin = plans.iter().map(|p| taille_dossier(&p.dossier)).sum::<u64>() as f64 * 1.05;
    if let Some(libre) = place_libre(d).filter(|l| (*l as f64) < besoin) {
        let noms: Vec<&str> = plans.iter().map(|p| p.monde.name.as_str()).collect();
        return Err(pas_de_place(&noms.join(", "), libre, besoin));
    }
    let mut faits = vec![];
    let mut avant = 0;
    progres(0, total, "");
    for p in &plans {
        let nom = p.monde.name.clone();
        let r = archiver(p, d, "auto", raison, annule, &mut |f, _| progres(avant + f, total, &nom))?;
        avant += p.fichiers.len();
        faits.push(r);
    }
    let dossiers: Vec<String> = plans.iter().map(|p| p.monde.folder.clone()).collect();
    tailler(d, garder, corbeille, Some(&dossiers))?;
    Ok(faits)
}

/// Rotation : au-delà de `garder` sauvegardes automatiques par monde, les plus anciennes vont à la corbeille.
pub fn tailler(d: &Path, garder: u32, corbeille: Corbeille<'_>, dossiers: Option<&[String]>) -> Resultat<Vec<String>> {
    let limite = garder.clamp(1, 50) as usize;
    let mut vus: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut retirees = vec![];
    for s in sauvegardes(d).into_iter().filter(|s| s.kind == "auto" && dossiers.is_none_or(|l| l.contains(&s.folder))) {
        let n = vus.entry(s.folder.clone()).or_insert(0);
        *n += 1;
        if *n > limite {
            corbeille(&d.join(&s.file))?;
            retirees.push(s.file);
        }
    }
    if !retirees.is_empty() {
        oublier(d, &retirees)?;
    }
    Ok(retirees)
}

fn oublier(d: &Path, fichiers: &[String]) -> Resultat<()> {
    let mut index: Map<String, Value> = lire_json(&fichier_index(d)).unwrap_or_default();
    for f in fichiers {
        index.remove(f);
    }
    Ok(ecrire_json(&fichier_index(d), &index)?)
}

/// Met une sauvegarde à la corbeille.
pub fn supprimer_sauvegarde(d: &Path, fichier: &str, corbeille: Corbeille<'_>) -> Resultat<()> {
    corbeille(&fichier_sauvegarde(d, fichier)?)?;
    oublier(d, &[fichier.to_string()])
}

/// Met un monde à la corbeille.
pub fn supprimer_monde(dossier_jeu: &Path, nom: &str, corbeille: Corbeille<'_>) -> Resultat<()> {
    corbeille(&dossier_monde(dossier_jeu, nom)?)
}

/// Mondes à sauvegarder avant une opération risquée (reason : modpack, version, loader, launch). None : aucun.
pub fn filtre_auto(r: &Reglages, raison: &str) -> Option<fn(&Monde) -> bool> {
    if raison == "launch" {
        return match r.backup_launch.as_str() {
            "never" => None,
            "hardcore" => Some(|m| m.hardcore),
            _ => Some(|_| true),
        };
    }
    r.backup_auto.then_some(|_| true)
}

// ---------- Restauration ----------

/// Nom de dossier valide sous Windows.
pub fn nom_dossier_sur(nom: &str) -> String {
    let propre: String = nom.chars().map(|c| if "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
    let propre = propre.trim_end_matches(['.', ' ']).trim().to_string();
    let reserve = {
        let l = propre.to_lowercase();
        ["con", "prn", "aux", "nul"].contains(&l.as_str())
            || ((l.starts_with("com") || l.starts_with("lpt")) && l.len() > 3 && l[3..].bytes().all(|b| b.is_ascii_digit()))
    };
    if propre.is_empty() || propre.starts_with(PREFIXE_TEMP) || reserve { "World".into() } else { propre.chars().take(80).collect() }
}

/// Nom de dossier libre dans saves (« Survie », « Survie (2) »…), comme le fait le jeu.
pub fn dossier_libre(saves: &Path, nom: &str) -> String {
    let mut n = 2;
    let mut s = nom.to_string();
    while saves.join(&s).exists() {
        s = format!("{nom} ({n})");
        n += 1;
    }
    s
}

/// Dossier du monde dans l'archive : celui du level.dat le moins profond. Chaque chemin est vérifié (pas de « .. »).
/// Dossier du monde et fichiers de l'archive (entrée, chemin relatif en morceaux).
type Disposition = (String, Vec<(zip::Entree, Vec<String>)>);

fn disposition(entrees: &[zip::Entree], archive: &Path) -> Resultat<Disposition> {
    let mut fichiers = vec![];
    for e in entrees {
        let nom = e.name.replace('\\', "/");
        if nom.ends_with('/') {
            continue;
        }
        let parts: Vec<String> = nom.split('/').map(String::from).collect();
        if parts.iter().any(|p| p.is_empty() || p == "." || p == ".." || p.contains(':')) {
            return Err(Erreur::new(tv("worlds.chemin_refuse", &[("name", &e.name)])));
        }
        fichiers.push((e.clone(), parts));
    }
    let niveau = fichiers.iter().filter(|(_, p)| p.last().is_some_and(|x| x == "level.dat")).min_by_key(|(_, p)| p.len());
    let (_, p) = niveau.ok_or_else(|| Erreur::new(t("worlds.archive_sans_monde")))?;
    let prefixe: Vec<String> = p[..p.len() - 1].to_vec();
    let nom_fichier = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let depuis = lire_horodatage(&nom_fichier).map(|h| h.0).unwrap_or_else(|| nom_fichier.trim_end_matches(".zip").to_string());
    let dossier = nom_dossier_sur(prefixe.last().map_or(depuis.as_str(), String::as_str));
    let dedans = fichiers
        .into_iter()
        .filter(|(_, p)| p.len() > prefixe.len() && p.starts_with(&prefixe))
        .map(|(e, p)| (e, p[prefixe.len()..].to_vec()))
        .filter(|(_, r)| r.last().is_some_and(|x| x != "session.lock"))
        .collect();
    Ok((dossier, dedans))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Restauration {
    pub folder: String,
    pub name: String,
    pub replaced: bool,
    pub files: usize,
}

/// Restaure un monde depuis un .zip. `remplacer` : le monde du même nom va à la corbeille, seulement une fois la copie
/// complète et lisible ; sinon nouveau dossier à côté.
pub fn restaurer(
    archive: &Path,
    dossier_jeu: &Path,
    remplacer: bool,
    corbeille: Corbeille<'_>,
    annule: &AtomicBool,
    progres: &mut dyn FnMut(usize, usize),
) -> Resultat<Restauration> {
    let mut a = ArchiveZip::ouvrir(archive)?;
    let s = saves(dossier_jeu);
    let temp = s.join(format!("{PREFIXE_TEMP}{}", crate::coffre::aleatoire::<4>().iter().map(|b| format!("{b:02x}")).collect::<String>()));
    let resultat = (|| -> Resultat<Restauration> {
        let (dossier, fichiers) = disposition(&a.entrees.clone(), archive)?;
        std::fs::create_dir_all(&temp)?;
        let total = fichiers.len();
        progres(0, total);
        let mut dernier = std::time::Instant::now();
        for (i, (e, rel)) in fichiers.iter().enumerate() {
            if annule.load(Ordering::Relaxed) {
                return Err(Erreur::code(t("worlds.restauration_annulee"), "CANCELLED"));
            }
            let cible = rel.iter().fold(temp.clone(), |c, p| c.join(p));
            if let Some(p) = cible.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::OpenOptions::new().write(true).create_new(true).open(&cible)?;
            std::fs::write(&cible, a.lire(e)?)?;
            if i + 1 == total || dernier.elapsed().as_millis() > 100 {
                dernier = std::time::Instant::now();
                progres(i + 1, total);
            }
        }
        let monde = lire_monde(&temp).ok_or_else(|| Erreur::new(t("worlds.level_dat_illisible")))?;
        let pris = s.join(&dossier).exists();
        let remplace = pris && remplacer;
        let final_ = if remplace || !pris { dossier.clone() } else { dossier_libre(&s, &dossier) };
        if remplace {
            corbeille(&s.join(&dossier))?;
        }
        std::fs::rename(&temp, s.join(&final_))?;
        Ok(Restauration { folder: final_, name: monde.name, replaced: remplace, files: total })
    })();
    if resultat.is_err() {
        let _ = std::fs::remove_dir_all(&temp);
    }
    resultat
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;

    /// level.dat minimal : Data { LevelName, LastPlayed, hardcore, GameType, Version { Name } } (non compressé).
    fn level_dat(nom: &str, dernier: i64, hardcore: bool) -> Vec<u8> {
        let mut o = vec![10, 0, 0];
        let chaine = |o: &mut Vec<u8>, n: &str, v: &str| {
            o.push(8);
            o.extend((n.len() as u16).to_be_bytes());
            o.extend(n.as_bytes());
            o.extend((v.len() as u16).to_be_bytes());
            o.extend(v.as_bytes());
        };
        o.extend([10, 0, 4]);
        o.extend(b"Data");
        chaine(&mut o, "LevelName", nom);
        o.extend([4, 0, 10]);
        o.extend(b"LastPlayed");
        o.extend(dernier.to_be_bytes());
        o.extend([1, 0, 8]);
        o.extend(b"hardcore");
        o.push(u8::from(hardcore));
        o.extend([3, 0, 8]);
        o.extend(b"GameType");
        o.extend(1i32.to_be_bytes());
        o.extend([10, 0, 7]);
        o.extend(b"Version");
        chaine(&mut o, "Name", "1.21.11");
        o.extend([0, 0, 0]);
        o
    }

    fn monde(d: &Dossier, dossier: &str, nom: &str, dernier: i64, hardcore: bool) {
        let p = d.0.join("jeu/saves").join(dossier);
        std::fs::create_dir_all(p.join("region")).unwrap();
        std::fs::write(p.join("level.dat"), level_dat(nom, dernier, hardcore)).unwrap();
        std::fs::write(p.join("region/r.0.0.mca"), vec![7u8; 1000]).unwrap();
        std::fs::write(p.join("session.lock"), "x").unwrap();
    }

    #[test]
    fn lecture_et_noms() {
        let d = Dossier::nouveau("mondes-lecture");
        monde(&d, "Survie", "\u{a7}aSurvie", 5, true);
        monde(&d, "Plat", "Plat", 9, false);
        let l = mondes(&d.0.join("jeu"));
        assert_eq!(l.iter().map(|m| m.folder.as_str()).collect::<Vec<_>>(), ["Plat", "Survie"]);
        let s = &l[1];
        assert_eq!(
            (s.name.as_str(), s.hardcore, s.mode, s.version.as_deref(), s.last_played),
            ("Survie", true, Some("creative"), Some("1.21.11"), Some(5))
        );
        assert!(dossier_monde(&d.0.join("jeu"), "../x").is_err());
        assert!(dossier_monde(&d.0.join("jeu"), "Absent").is_err());
        assert_eq!(nom_dossier_sur("a:b?. "), "a_b_");
        assert_eq!(nom_dossier_sur("CON"), "World");
        assert_eq!(lire_horodatage("Mon_monde_2026-11-14_12-30-05-2.zip").unwrap().0, "Mon_monde");
        assert!(lire_horodatage("pas-de-date.zip").is_none());
    }

    #[test]
    fn sauvegardes_rotation_et_restauration() {
        let d = Dossier::nouveau("mondes-sauvegardes");
        monde(&d, "Survie", "Survie", 5, true);
        monde(&d, "Plat", "Plat", 9, false);
        let jeu = d.0.join("jeu");
        let b = d.0.join("backups");
        let corbeille = |p: &Path| -> Resultat<()> {
            if p.is_dir() {
                std::fs::remove_dir_all(p)?
            } else {
                std::fs::remove_file(p)?
            };
            Ok(())
        };
        let non = AtomicBool::new(false);
        let r = filtre_auto(&Reglages::default(), "launch").unwrap();
        let mut vu = vec![];
        let faites = sauvegarder_tous(&jeu, &b, ("launch", 2), &corbeille, &r, &non, &mut |_, _, n| vu.push(n.to_string())).unwrap();
        assert_eq!(faites.len(), 1, "réglage par défaut : mondes hardcore seulement");
        for _ in 0..2 {
            std::thread::sleep(std::time::Duration::from_millis(10));
            sauvegarder_tous(&jeu, &b, ("launch", 2), &corbeille, &|_| true, &non, &mut |_, _, _| {}).unwrap();
        }
        let l = sauvegardes(&b);
        assert_eq!(l.iter().filter(|s| s.folder == "Survie").count(), 2, "rotation : 2 gardées");
        assert!(l.iter().all(|s| s.kind == "auto" && s.reason == "launch"));
        let manuelle = sauvegarder(&jeu, "Plat", &b, &non, &mut |_, _| {}).unwrap();
        assert_eq!(manuelle.files, 2, "session.lock n'est pas sauvegardé");

        // Restauration à côté, puis à la place (l'ancien part à la corbeille).
        let zip_plat = b.join(&manuelle.file);
        let a = restaurer(&zip_plat, &jeu, false, &corbeille, &non, &mut |_, _| {}).unwrap();
        assert_eq!((a.folder.as_str(), a.replaced), ("Plat (2)", false));
        let r = restaurer(&zip_plat, &jeu, true, &corbeille, &non, &mut |_, _| {}).unwrap();
        assert_eq!((r.folder.as_str(), r.replaced, r.files), ("Plat", true, 2));
        assert!(jeu.join("saves/Plat/region/r.0.0.mca").is_file());
        assert!(
            !std::fs::read_dir(jeu.join("saves")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with(PREFIXE_TEMP))
        );
        supprimer_sauvegarde(&b, &manuelle.file, &corbeille).unwrap();
        assert!(fichier_sauvegarde(&b, &manuelle.file).is_err());
        assert!(place_libre(&d.0).is_some_and(|p| p > 0));
    }

    #[test]
    fn archive_dangereuse_refusee() {
        let d = Dossier::nouveau("mondes-dangereux");
        let z = d.0.join("x.zip");
        std::fs::write(&z, zip::creer_zip(&[("../evil/level.dat", b"x".as_slice())])).unwrap();
        let corbeille = |_: &Path| -> Resultat<()> { Ok(()) };
        assert!(restaurer(&z, &d.0.join("jeu"), false, &corbeille, &AtomicBool::new(false), &mut |_, _| {}).is_err());
        std::fs::write(&z, zip::creer_zip(&[("rien.txt", b"x".as_slice())])).unwrap();
        assert!(restaurer(&z, &d.0.join("jeu"), false, &corbeille, &AtomicBool::new(false), &mut |_, _| {}).is_err());
    }
}
