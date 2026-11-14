//! Lecture du format NBT de Minecraft (big-endian), pour level.dat (core/nbt.js). Le launcher ne réécrit jamais
//! ces fichiers. Référence : https://minecraft.wiki/w/NBT_format

use crate::erreur::{Erreur, Resultat};
use flate2::read::GzDecoder;
use std::io::Read;

// Minecraft accepte 512 niveaux ; 128 suffit largement à level.dat et évite de déborder la pile (récursion).
const PROFONDEUR_MAX: usize = 128;
const GZIP_MAX: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<u8>),
    String(String),
    List(Vec<Tag>),
    Compound(Vec<(String, Tag)>),
    /// Tableaux d'entiers : sautés, jamais utiles ici.
    Ignore,
}

impl Tag {
    /// Valeur d'une entrée d'un compound.
    pub fn get(&self, nom: &str) -> Option<&Tag> {
        match self {
            Tag::Compound(e) => e.iter().find(|(n, _)| n == nom).map(|(_, v)| v),
            _ => None,
        }
    }
    /// Nombre entier, quel que soit son type NBT.
    pub fn entier(&self) -> Option<i64> {
        match *self {
            Tag::Byte(n) => Some(n as i64),
            Tag::Short(n) => Some(n as i64),
            Tag::Int(n) => Some(n as i64),
            Tag::Long(n) => Some(n),
            _ => None,
        }
    }
    pub fn texte(&self) -> Option<&str> {
        match self {
            Tag::String(s) => Some(s),
            _ => None,
        }
    }
}

fn erreur(quoi: &str) -> Erreur {
    Erreur::new(format!("NBT {quoi}"))
}

struct Lecteur<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> Lecteur<'a> {
    fn prendre(&mut self, n: i64) -> Resultat<&'a [u8]> {
        if n < 0 || self.o as i64 + n > self.b.len() as i64 {
            return Err(erreur("truncated"));
        }
        let debut = self.o;
        self.o += n as usize;
        Ok(&self.b[debut..self.o])
    }
    fn tableau<const N: usize>(&mut self) -> Resultat<[u8; N]> {
        Ok(self.prendre(N as i64)?.try_into().unwrap_or([0; N]))
    }
    fn octet(&mut self) -> Resultat<i8> {
        Ok(i8::from_be_bytes(self.tableau()?))
    }
    fn int(&mut self) -> Resultat<i32> {
        Ok(i32::from_be_bytes(self.tableau()?))
    }
    fn chaine(&mut self) -> Resultat<String> {
        let n = u16::from_be_bytes(self.tableau()?);
        Ok(String::from_utf8_lossy(self.prendre(n as i64)?).into_owned())
    }

    fn valeur(&mut self, kind: i8, profondeur: usize) -> Resultat<Tag> {
        if profondeur > PROFONDEUR_MAX {
            return Err(erreur("too deep"));
        }
        Ok(match kind {
            1 => Tag::Byte(self.octet()?),
            2 => Tag::Short(i16::from_be_bytes(self.tableau()?)),
            3 => Tag::Int(self.int()?),
            4 => Tag::Long(i64::from_be_bytes(self.tableau()?)),
            5 => Tag::Float(f32::from_be_bytes(self.tableau()?)),
            6 => Tag::Double(f64::from_be_bytes(self.tableau()?)),
            7 => {
                let n = self.int()?;
                Tag::ByteArray(self.prendre(n as i64)?.to_vec())
            }
            8 => Tag::String(self.chaine()?),
            9 => {
                let item = self.octet()?;
                let n = self.int()?;
                let mut l = Vec::new();
                for _ in 0..n.max(0) {
                    l.push(self.valeur(item, profondeur + 1)?);
                }
                Tag::List(l)
            }
            10 => {
                let mut e = vec![];
                loop {
                    let k = self.octet()?;
                    if k == 0 {
                        break;
                    }
                    let nom = self.chaine()?;
                    e.push((nom, self.valeur(k, profondeur + 1)?));
                }
                Tag::Compound(e)
            }
            11 => {
                let n = self.int()?;
                self.prendre(n as i64 * 4)?;
                Tag::Ignore
            }
            12 => {
                let n = self.int()?;
                self.prendre(n as i64 * 8)?;
                Tag::Ignore
            }
            k => return Err(erreur(&format!("type {k}"))),
        })
    }
}

/// Lit un fichier NBT (gzip ou non) : le compound racine.
pub fn lire(octets: &[u8]) -> Resultat<Tag> {
    let decompresse;
    let donnees = if octets.starts_with(&[0x1f, 0x8b]) {
        let mut v = vec![];
        GzDecoder::new(octets).take(GZIP_MAX).read_to_end(&mut v).map_err(|_| erreur("gzip"))?;
        decompresse = v;
        &decompresse[..]
    } else {
        octets
    };
    let mut l = Lecteur { b: donnees, o: 0 };
    if l.octet()? != 10 {
        return Err(erreur("root"));
    }
    l.chaine()?;
    l.valeur(10, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    fn chaine(s: &str) -> Vec<u8> {
        [(s.len() as u16).to_be_bytes().to_vec(), s.as_bytes().to_vec()].concat()
    }
    fn tag(kind: u8, nom: &str, contenu: Vec<u8>) -> Vec<u8> {
        [vec![kind], chaine(nom), contenu].concat()
    }
    fn compound(tags: Vec<Vec<u8>>) -> Vec<u8> {
        [tags.concat(), vec![0]].concat()
    }
    fn niveau() -> Vec<u8> {
        let data = compound(vec![
            tag(8, "LevelName", chaine("Mundo 2")),
            tag(3, "DataVersion", 4189i32.to_be_bytes().to_vec()),
            tag(4, "LastPlayed", 1_762_700_000_000i64.to_be_bytes().to_vec()),
            tag(1, "hardcore", vec![1]),
            tag(6, "BorderSize", 59_999_968f64.to_be_bytes().to_vec()),
            tag(10, "Version", compound(vec![tag(8, "Name", chaine("1.21.4")), tag(1, "Snapshot", vec![0])])),
            tag(9, "ServerBrands", [vec![8], 2i32.to_be_bytes().to_vec(), chaine("vanilla"), chaine("fabric")].concat()),
            tag(11, "Ids", [2i32, 1, 2].iter().flat_map(|n| n.to_be_bytes()).collect()),
            tag(7, "Octets", [3i32.to_be_bytes().to_vec(), vec![1, 2, 3]].concat()),
        ]);
        [vec![10], chaine(""), compound(vec![tag(10, "Data", data)])].concat()
    }

    #[test]
    fn level_dat_compresse_ou_non() {
        let mut gz = GzEncoder::new(vec![], Compression::default());
        gz.write_all(&niveau()).unwrap();
        for octets in [gz.finish().unwrap(), niveau()] {
            let racine = lire(&octets).unwrap();
            let d = racine.get("Data").unwrap();
            assert_eq!(d.get("LevelName").and_then(Tag::texte), Some("Mundo 2"));
            assert_eq!(d.get("DataVersion").and_then(Tag::entier), Some(4189));
            assert_eq!(d.get("LastPlayed").and_then(Tag::entier), Some(1_762_700_000_000));
            assert_eq!(d.get("hardcore").and_then(Tag::entier), Some(1));
            assert_eq!(d.get("BorderSize"), Some(&Tag::Double(59_999_968.0)));
            assert_eq!(d.get("Version").and_then(|v| v.get("Name")).and_then(Tag::texte), Some("1.21.4"));
            assert_eq!(d.get("ServerBrands"), Some(&Tag::List(vec![Tag::String("vanilla".into()), Tag::String("fabric".into())])));
            assert_eq!(d.get("Ids"), Some(&Tag::Ignore));
            assert_eq!(d.get("Octets"), Some(&Tag::ByteArray(vec![1, 2, 3])));
            assert_eq!(racine.get("Absent"), None);
        }
    }

    #[test]
    fn fichiers_abimes_refuses() {
        let n = niveau();
        let message = |r: Resultat<Tag>| r.unwrap_err().message;
        assert!(message(lire(&n[..n.len() - 10])).contains("truncated"));
        assert!(message(lire(&[vec![8], chaine(""), chaine("x")].concat())).contains("root"));
        assert!(message(lire(&[vec![10], chaine(""), tag(99, "x", vec![])].concat())).contains("type"));
        assert!(lire(&[vec![10], chaine(""), tag(7, "x", (-1i32).to_be_bytes().to_vec()), vec![0]].concat()).is_err());
    }

    #[test]
    fn imbrication_trop_profonde() {
        let mut profond = vec![0u8];
        for _ in 0..600 {
            profond = [tag(10, "x", profond), vec![0]].concat();
        }
        assert!(lire(&[vec![10], chaine(""), profond].concat()).unwrap_err().message.contains("deep"));
    }
}
