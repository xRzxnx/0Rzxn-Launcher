//! ZIP minimal (core/zip.js) : en mémoire (natives, mods, modpacks, export de modpacks) et archives sur disque
//! avec ZIP64 (sauvegardes de mondes), écrites et lues fichier par fichier. Même format que la version Electron :
//! les sauvegardes de l'une se lisent avec l'autre.

use crate::erreur::{Erreur, Resultat};
use crate::i18n::{t, tv};
use flate2::Compression;
use flate2::read::{DeflateDecoder, DeflateEncoder};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const LOCAL: u32 = 0x0403_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const EOCD: u32 = 0x0605_4b50;
const ZIP64_EOCD: u32 = 0x0606_4b50;
const ZIP64_LOCATOR: u32 = 0x0706_4b50;
const MAX32: u64 = 0xffff_ffff;
/// Recherche de la fin d'archive : 22 octets + commentaire de 65 535 octets au plus.
const QUEUE: usize = 65_557;

fn u16_le(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn u32_le(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn u64_le(b: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
}

fn invalide() -> Erreur {
    Erreur::new(t("zip.archive_zip_invalide"))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entree {
    pub name: String,
    pub method: u16,
    pub compressed_size: u64,
    pub size: u64,
    pub local_offset: u64,
}

fn chercher_fin(queue: &[u8]) -> Option<usize> {
    (0..=queue.len().checked_sub(22)?).rev().find(|&i| u32_le(queue, i) == Some(EOCD))
}

/// Entrées du répertoire central (ZIP64 compris).
fn lire_central(central: &[u8], nombre: u64) -> Vec<Entree> {
    let mut entrees = vec![];
    let mut at = 0;
    while (entrees.len() as u64) < nombre && u32_le(central, at) == Some(CENTRAL) && at + 46 <= central.len() {
        let lu = (|| {
            let flags = u16_le(central, at + 8)?;
            let (nom_l, extra_l, comm_l) =
                (u16_le(central, at + 28)? as usize, u16_le(central, at + 30)? as usize, u16_le(central, at + 32)? as usize);
            let octets = central.get(at + 46..at + 46 + nom_l)?;
            // Sans le drapeau UTF-8, les noms sont en CP437 ; latin1 comme la version Electron.
            let name = if flags & 0x0800 != 0 {
                String::from_utf8_lossy(octets).into_owned()
            } else {
                octets.iter().map(|&c| c as char).collect()
            };
            let mut e = Entree {
                name,
                method: u16_le(central, at + 10)?,
                compressed_size: u32_le(central, at + 20)? as u64,
                size: u32_le(central, at + 24)? as u64,
                local_offset: u32_le(central, at + 42)? as u64,
            };
            // Champ ZIP64 : seules les valeurs saturées y figurent, dans cet ordre.
            let mut x = at + 46 + nom_l;
            let fin_extra = x + extra_l;
            while x + 4 <= fin_extra {
                let (id, long) = (u16_le(central, x)?, u16_le(central, x + 2)? as usize);
                if id == 0x0001 {
                    let mut p = x + 4;
                    for champ in [&mut e.size, &mut e.compressed_size, &mut e.local_offset] {
                        if *champ == MAX32 && p + 8 <= x + 4 + long {
                            *champ = u64_le(central, p)?;
                            p += 8;
                        }
                    }
                }
                x += 4 + long;
            }
            Some((e, fin_extra + comm_l))
        })();
        let Some((e, suivant)) = lu else { break };
        entrees.push(e);
        at = suivant;
    }
    entrees
}

fn decompresser(entree: &Entree, donnees: &[u8]) -> Resultat<Vec<u8>> {
    match entree.method {
        0 => Ok(donnees.to_vec()),
        8 => {
            let mut sortie = Vec::with_capacity(entree.size.min(1 << 30) as usize);
            DeflateDecoder::new(donnees)
                .read_to_end(&mut sortie)
                .map_err(|_| Erreur::new(tv("zip.archive_abimee", &[("name", &entree.name)])))?;
            Ok(sortie)
        }
        m => Err(Erreur::new(tv("zip.compression_zip_non_geree_pour", &[("method", &m.to_string()), ("name", &entree.name)]))),
    }
}

// ---------- En mémoire ----------

/// Entrées d'une archive en mémoire.
pub fn lister_entrees(archive: &[u8]) -> Resultat<Vec<Entree>> {
    let debut = archive.len().saturating_sub(QUEUE);
    let fin = chercher_fin(&archive[debut..]).map(|i| debut + i).ok_or_else(invalide)?;
    let nombre = u16_le(archive, fin + 10).ok_or_else(invalide)? as u64;
    let central = u32_le(archive, fin + 16).ok_or_else(invalide)? as usize;
    Ok(lire_central(archive.get(central..).ok_or_else(invalide)?, nombre))
}

pub fn lire_entree(archive: &[u8], e: &Entree) -> Resultat<Vec<u8>> {
    let local = e.local_offset as usize;
    let abimee = || Erreur::new(tv("zip.archive_abimee", &[("name", &e.name)]));
    let debut =
        local + 30 + u16_le(archive, local + 26).ok_or_else(abimee)? as usize + u16_le(archive, local + 28).ok_or_else(abimee)? as usize;
    let donnees = archive.get(debut..debut + e.compressed_size as usize).ok_or_else(abimee)?;
    decompresser(e, donnees)
}

/// Contenu d'un fichier de l'archive par son nom, ou None s'il n'existe pas.
pub fn lire_fichier(archive: &[u8], nom: &str) -> Resultat<Option<Vec<u8>>> {
    let entrees = lister_entrees(archive)?;
    entrees.iter().find(|e| e.name == nom).map(|e| lire_entree(archive, e)).transpose()
}

fn deflate(donnees: &[u8]) -> Vec<u8> {
    let mut sortie = vec![];
    let _ = DeflateEncoder::new(donnees, Compression::default()).read_to_end(&mut sortie);
    sortie
}

/// Corps rangé : compressé si ça gagne de la place, sinon tel quel.
fn corps(donnees: &[u8], ranger: bool) -> (bool, Vec<u8>) {
    if ranger {
        return (true, donnees.to_vec());
    }
    let c = deflate(donnees);
    if c.len() >= donnees.len() { (true, donnees.to_vec()) } else { (false, c) }
}

/// En-tête local de 30 octets.
fn en_tete_local(range: bool, quand: (u16, u16), crc: u32, compresse: u32, taille: u32, nom: usize) -> Vec<u8> {
    let mut h = Vec::with_capacity(30);
    h.extend(LOCAL.to_le_bytes());
    h.extend(20u16.to_le_bytes()); // version nécessaire
    h.extend(0x0800u16.to_le_bytes()); // noms en UTF-8
    h.extend((if range { 0u16 } else { 8 }).to_le_bytes());
    h.extend(quand.0.to_le_bytes());
    h.extend(quand.1.to_le_bytes());
    h.extend(crc.to_le_bytes());
    h.extend(compresse.to_le_bytes());
    h.extend(taille.to_le_bytes());
    h.extend((nom as u16).to_le_bytes());
    h.extend(0u16.to_le_bytes());
    h
}

struct Central {
    nom: Vec<u8>,
    range: bool,
    quand: (u16, u16),
    crc: u32,
    compresse: u64,
    taille: u64,
    position: u64,
}

fn en_tete_central(c: &Central) -> Vec<u8> {
    let loin = c.position >= MAX32;
    let version: u16 = if loin { 45 } else { 20 };
    let mut h = Vec::with_capacity(58);
    h.extend(CENTRAL.to_le_bytes());
    h.extend(version.to_le_bytes());
    h.extend(version.to_le_bytes());
    h.extend(0x0800u16.to_le_bytes());
    h.extend((if c.range { 0u16 } else { 8 }).to_le_bytes());
    h.extend(c.quand.0.to_le_bytes());
    h.extend(c.quand.1.to_le_bytes());
    h.extend(c.crc.to_le_bytes());
    h.extend((c.compresse as u32).to_le_bytes());
    h.extend((c.taille as u32).to_le_bytes());
    h.extend((c.nom.len() as u16).to_le_bytes());
    h.extend((if loin { 12u16 } else { 0 }).to_le_bytes());
    h.extend([0u8; 10]); // commentaire, disque, attributs
    h.extend((if loin { MAX32 as u32 } else { c.position as u32 }).to_le_bytes());
    h.extend(&c.nom);
    if loin {
        h.extend(0x0001u16.to_le_bytes());
        h.extend(8u16.to_le_bytes());
        h.extend(c.position.to_le_bytes());
    }
    h
}

/// Fin d'archive (avec les enregistrements ZIP64 si besoin).
fn fin_archive(nombre: u64, debut_central: u64, taille_central: u64) -> Vec<u8> {
    let mut h = vec![];
    if nombre >= 0xffff || debut_central >= MAX32 || taille_central >= MAX32 {
        let zip64 = debut_central + taille_central;
        h.extend(ZIP64_EOCD.to_le_bytes());
        h.extend(44u64.to_le_bytes());
        h.extend(45u16.to_le_bytes());
        h.extend(45u16.to_le_bytes());
        h.extend([0u8; 8]);
        h.extend(nombre.to_le_bytes());
        h.extend(nombre.to_le_bytes());
        h.extend(taille_central.to_le_bytes());
        h.extend(debut_central.to_le_bytes());
        h.extend(ZIP64_LOCATOR.to_le_bytes());
        h.extend(0u32.to_le_bytes());
        h.extend(zip64.to_le_bytes());
        h.extend(1u32.to_le_bytes());
    }
    h.extend(EOCD.to_le_bytes());
    h.extend([0u8; 4]);
    h.extend((nombre.min(0xffff) as u16).to_le_bytes());
    h.extend((nombre.min(0xffff) as u16).to_le_bytes());
    h.extend((taille_central.min(MAX32) as u32).to_le_bytes());
    h.extend((debut_central.min(MAX32) as u32).to_le_bytes());
    h.extend(0u16.to_le_bytes());
    h
}

/// Crée une archive en mémoire à partir de (nom, contenu).
pub fn creer_zip(fichiers: &[(&str, &[u8])]) -> Vec<u8> {
    let mut sortie = vec![];
    let mut centraux = vec![];
    for (nom, donnees) in fichiers {
        let (range, b) = corps(donnees, false);
        let crc = crc32fast::hash(donnees);
        let c = Central {
            nom: nom.as_bytes().to_vec(),
            range,
            quand: (0, 0),
            crc,
            compresse: b.len() as u64,
            taille: donnees.len() as u64,
            position: sortie.len() as u64,
        };
        sortie.extend(en_tete_local(range, (0, 0), crc, b.len() as u32, donnees.len() as u32, c.nom.len()));
        sortie.extend(&c.nom);
        sortie.extend(&b);
        centraux.push(c);
    }
    let debut = sortie.len() as u64;
    for c in &centraux {
        sortie.extend(en_tete_central(c));
    }
    let taille = sortie.len() as u64 - debut;
    sortie.extend(fin_archive(centraux.len() as u64, debut, taille));
    sortie
}

// ---------- Sur disque, avec ZIP64 ----------

/// Date et heure au format MS-DOS (celui des en-têtes ZIP), heure locale : (heure, date).
fn heure_dos(quand: std::time::SystemTime) -> (u16, u16) {
    use chrono::{Datelike, Timelike};
    let d: chrono::DateTime<chrono::Local> = quand.into();
    let annee = d.year().max(1980) as u16;
    (
        ((d.hour() as u16) << 11) | ((d.minute() as u16) << 5) | (d.second() as u16 / 2),
        ((annee - 1980) << 9) | ((d.month() as u16) << 5) | d.day() as u16,
    )
}

pub struct AEcrire {
    pub nom: String,
    pub chemin: PathBuf,
    /// Rangé sans compression (fichiers déjà compressés, comme les régions .mca).
    pub ranger: bool,
}

/// Écrit une archive fichier par fichier, sans tout charger en mémoire. Écrit d'abord un « .part », renommé à la fin.
/// `progression(fait, total)` au début, puis au plus toutes les 100 ms et à la fin. Renvoie (fichiers, octets).
pub fn ecrire_zip_fichier(
    cible: &Path,
    entrees: &[AEcrire],
    annule: &AtomicBool,
    mut progression: impl FnMut(usize, usize),
) -> Resultat<(usize, u64)> {
    let part = PathBuf::from(format!("{}.part", cible.display()));
    let resultat = (|| -> Resultat<(usize, u64)> {
        let mut f = BufWriter::new(File::create(&part)?);
        let mut position = 0u64;
        let mut centraux = vec![];
        let mut dernier = std::time::Instant::now();
        progression(0, entrees.len());
        for (i, e) in entrees.iter().enumerate() {
            if annule.load(Ordering::Relaxed) {
                return Err(Erreur::code(t("zip.sauvegarde_annulee"), "CANCELLED"));
            }
            let donnees = std::fs::read(&e.chemin)?;
            let quand = heure_dos(std::fs::metadata(&e.chemin)?.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH));
            if donnees.len() as u64 >= MAX32 {
                return Err(Erreur::new(tv("zip.fichier_trop_gros", &[("name", &e.nom)])));
            }
            let (range, b) = corps(&donnees, e.ranger);
            let crc = crc32fast::hash(&donnees);
            let nom = e.nom.as_bytes().to_vec();
            f.write_all(&en_tete_local(range, quand, crc, b.len() as u32, donnees.len() as u32, nom.len()))?;
            f.write_all(&nom)?;
            f.write_all(&b)?;
            centraux.push(Central { nom, range, quand, crc, compresse: b.len() as u64, taille: donnees.len() as u64, position });
            position += 30 + centraux.last().map_or(0, |c| c.nom.len() as u64) + b.len() as u64;
            if i == entrees.len() - 1 || dernier.elapsed().as_millis() > 100 {
                dernier = std::time::Instant::now();
                progression(i + 1, entrees.len());
            }
        }
        let debut = position;
        for c in &centraux {
            let h = en_tete_central(c);
            f.write_all(&h)?;
            position += h.len() as u64;
        }
        let fin = fin_archive(centraux.len() as u64, debut, position - debut);
        f.write_all(&fin)?;
        position += fin.len() as u64;
        f.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        std::fs::rename(&part, cible)?;
        Ok((centraux.len(), position))
    })();
    if resultat.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    resultat
}

/// Archive ouverte sur disque : ne lit que ce qui est demandé.
pub struct ArchiveZip {
    fichier: File,
    pub entrees: Vec<Entree>,
}

fn lire_a(f: &mut File, position: u64, longueur: usize) -> Resultat<Vec<u8>> {
    f.seek(SeekFrom::Start(position))?;
    let mut b = Vec::with_capacity(longueur);
    f.take(longueur as u64).read_to_end(&mut b)?;
    Ok(b)
}

impl ArchiveZip {
    pub fn ouvrir(chemin: &Path) -> Resultat<Self> {
        let mut f = File::open(chemin)?;
        let taille = f.metadata()?.len();
        let debut_queue = taille.saturating_sub(QUEUE as u64);
        let queue = lire_a(&mut f, debut_queue, (taille - debut_queue) as usize)?;
        let fin = chercher_fin(&queue).ok_or_else(invalide)?;
        let mut nombre = u16_le(&queue, fin + 10).ok_or_else(invalide)? as u64;
        let mut taille_central = u32_le(&queue, fin + 12).ok_or_else(invalide)? as u64;
        let mut debut_central = u32_le(&queue, fin + 16).ok_or_else(invalide)? as u64;
        if fin >= 20 && u32_le(&queue, fin - 20) == Some(ZIP64_LOCATOR) {
            let position = u64_le(&queue, fin - 12).ok_or_else(invalide)?;
            let r = lire_a(&mut f, position, 56)?;
            if u32_le(&r, 0) == Some(ZIP64_EOCD) {
                nombre = u64_le(&r, 32).ok_or_else(invalide)?;
                taille_central = u64_le(&r, 40).ok_or_else(invalide)?;
                debut_central = u64_le(&r, 48).ok_or_else(invalide)?;
            }
        }
        if debut_central + taille_central > taille {
            return Err(invalide());
        }
        let central = lire_a(&mut f, debut_central, taille_central as usize)?;
        Ok(Self { entrees: lire_central(&central, nombre), fichier: f })
    }

    pub fn lire(&mut self, e: &Entree) -> Resultat<Vec<u8>> {
        let local = lire_a(&mut self.fichier, e.local_offset, 30)?;
        if u32_le(&local, 0) != Some(LOCAL) {
            return Err(Erreur::new(tv("zip.archive_abimee", &[("name", &e.name)])));
        }
        let debut = e.local_offset + 30 + u16_le(&local, 26).unwrap_or(0) as u64 + u16_le(&local, 28).unwrap_or(0) as u64;
        let donnees = lire_a(&mut self.fichier, debut, e.compressed_size as usize)?;
        decompresser(e, &donnees)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;

    fn texte() -> Vec<u8> {
        "bonjour ".repeat(500).into_bytes()
    }
    /// Octets incompressibles (rangés sans compression).
    fn hasard() -> Vec<u8> {
        let mut x = 0x2545_f491_u32;
        (0..2048)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }

    #[test]
    fn creation_puis_lecture_en_memoire() {
        let (t, h) = (texte(), hasard());
        let archive = creer_zip(&[("texte.txt", &t), ("dossier/aléatoire.bin", &h), ("vide.txt", &[])]);
        let e = lister_entrees(&archive).unwrap();
        assert_eq!(e.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["texte.txt", "dossier/aléatoire.bin", "vide.txt"]);
        assert_eq!((e[0].method, e[1].method), (8, 0));
        assert!(e[0].compressed_size < t.len() as u64);
        assert_eq!(lire_fichier(&archive, "texte.txt").unwrap().unwrap(), t);
        assert_eq!(lire_entree(&archive, &e[1]).unwrap(), h);
        assert!(lire_fichier(&archive, "vide.txt").unwrap().unwrap().is_empty());
        assert_eq!(lire_fichier(&archive, "absent.txt").unwrap(), None);
    }

    #[test]
    fn archive_invalide_et_methode_inconnue() {
        assert!(lister_entrees("ceci n’est pas une archive zip, vraiment pas".as_bytes()).is_err());
        let archive = creer_zip(&[("a.txt", &texte())]);
        let e = lister_entrees(&archive).unwrap().remove(0);
        assert!(lire_entree(&archive, &Entree { method: 14, ..e }).is_err());
    }

    #[test]
    fn ecriture_puis_lecture_sur_disque() {
        let d = Dossier::nouveau("zip-disque");
        let (t, h) = (texte(), hasard());
        d.ecrire("level.dat", std::str::from_utf8(&t).unwrap());
        std::fs::write(d.0.join("r.0.0.mca"), &h).unwrap();
        let cible = d.0.join("sauvegarde.zip");
        let mut suivi = vec![];
        let entrees = [
            AEcrire { nom: "Monde/level.dat".into(), chemin: d.0.join("level.dat"), ranger: false },
            AEcrire { nom: "Monde/region/r.0.0.mca".into(), chemin: d.0.join("r.0.0.mca"), ranger: true },
        ];
        let (n, _) = ecrire_zip_fichier(&cible, &entrees, &AtomicBool::new(false), |f, tot| suivi.push((f, tot))).unwrap();
        assert_eq!(n, 2);
        assert!(!PathBuf::from(format!("{}.part", cible.display())).exists());
        assert_eq!((suivi[0], *suivi.last().unwrap()), ((0, 2), (2, 2)));
        let mut a = ArchiveZip::ouvrir(&cible).unwrap();
        assert_eq!(a.entrees.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["Monde/level.dat", "Monde/region/r.0.0.mca"]);
        assert_eq!(a.entrees[1].method, 0);
        let (e0, e1) = (a.entrees[0].clone(), a.entrees[1].clone());
        assert_eq!(a.lire(&e0).unwrap(), t);
        assert_eq!(a.lire(&e1).unwrap(), h);
        // L'archive sur disque se lit aussi en mémoire.
        assert_eq!(lire_fichier(&std::fs::read(&cible).unwrap(), "Monde/level.dat").unwrap().unwrap(), t);
        // Contrôle croisé avec la version Electron : ZIP_CONTROLE=<dossier> garde une copie de l'archive.
        if let Some(dossier) = std::env::var_os("ZIP_CONTROLE") {
            std::fs::copy(&cible, PathBuf::from(dossier).join("rust.zip")).unwrap();
        }
        // Et une archive écrite par la version Electron (ZIP_CONTROLE/electron.zip) se lit ici.
        if let Some(f) = std::env::var_os("ZIP_CONTROLE").map(|d| PathBuf::from(d).join("electron.zip")).filter(|f| f.exists()) {
            let mut a = ArchiveZip::ouvrir(&f).unwrap();
            let e = a.entrees.iter().find(|e| e.name == "Monde/level.dat").unwrap().clone();
            assert_eq!(a.lire(&e).unwrap(), t);
        }
    }

    #[test]
    fn zip64_lu_et_ecrit() {
        // Plus de 65 535 entrées : enregistrements ZIP64 écrits, puis relus.
        let fichiers: Vec<(String, Vec<u8>)> = (0..70_000).map(|i| (format!("f{i}"), vec![])).collect();
        let refs: Vec<(&str, &[u8])> = fichiers.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        let archive = creer_zip(&refs);
        let d = Dossier::nouveau("zip64");
        std::fs::write(d.0.join("gros.zip"), &archive).unwrap();
        let a = ArchiveZip::ouvrir(&d.0.join("gros.zip")).unwrap();
        assert_eq!(a.entrees.len(), 70_000);
        assert_eq!(a.entrees[69_999].name, "f69999");
    }

    #[test]
    fn annulation_sans_fichier_laisse() {
        let d = Dossier::nouveau("zip-annule");
        d.ecrire("a.txt", "a");
        let cible = d.0.join("annulee.zip");
        let r = ecrire_zip_fichier(
            &cible,
            &[AEcrire { nom: "a.txt".into(), chemin: d.0.join("a.txt"), ranger: false }],
            &AtomicBool::new(true),
            |_, _| {},
        );
        assert!(r.is_err());
        assert!(!cible.exists() && !PathBuf::from(format!("{}.part", cible.display())).exists());
    }

    #[test]
    fn faux_fichier_refuse() {
        let d = Dossier::nouveau("zip-faux");
        d.ecrire("faux.zip", "rien à voir");
        assert!(ArchiveZip::ouvrir(&d.0.join("faux.zip")).is_err());
    }
}
