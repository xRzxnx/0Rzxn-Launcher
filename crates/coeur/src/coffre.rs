//! Coffre des jetons Microsoft, comme services/vault.js.
//! Windows : le format exact de safeStorage d'Electron (« enc: » + v10, AES-256-GCM, clé du fichier « Local State »
//! protégée par DPAPI) : accounts.json reste lisible par les deux versions du launcher, dans les deux sens.
//! macOS et Linux : le trousseau du système (le format d'Electron n'y est pas repris : reconnexion demandée une fois).

use crate::erreur::{Erreur, Resultat};
use crate::i18n::t;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;

pub trait Coffre: Send + Sync {
    /// Le système protège-t-il vraiment les jetons ? Sinon ils restent en mémoire (comptes.rs).
    fn persistant(&self) -> bool;
    /// `id` : compte auquel appartient le secret (clé du trousseau).
    fn chiffrer(&self, id: &str, texte: &str) -> Resultat<String>;
    fn dechiffrer(&self, id: &str, donnees: &str) -> Resultat<String>;
    /// Compte retiré : son secret quitte le trousseau.
    fn oublier(&self, _id: &str) {}
}

/// Coffre des tests : aucun chiffrement.
pub struct CoffreClair;

impl Coffre for CoffreClair {
    fn persistant(&self) -> bool {
        true
    }
    fn chiffrer(&self, _: &str, texte: &str) -> Resultat<String> {
        Ok(format!("plain:{}", B64.encode(texte)))
    }
    fn dechiffrer(&self, _: &str, donnees: &str) -> Resultat<String> {
        let brut = B64.decode(donnees.trim_start_matches("plain:")).map_err(|_| Erreur::new(t("ipc.session_illisible")))?;
        String::from_utf8(brut).map_err(|_| Erreur::new(t("ipc.session_illisible")))
    }
}

/// Chiffrement v10 de Chromium : « v10 » + nonce (12 octets) + texte chiffré et étiquette (AES-256-GCM).
pub fn chiffrer_v10(cle: &[u8; 32], texte: &[u8], nonce: [u8; 12]) -> Vec<u8> {
    use aes_gcm::aead::{Aead, KeyInit};
    let chiffre = aes_gcm::Aes256Gcm::new(cle.into()).encrypt(&nonce.into(), texte).expect("AES-GCM chiffre toujours");
    [b"v10".as_slice(), &nonce, &chiffre].concat()
}

pub fn dechiffrer_v10(cle: &[u8; 32], donnees: &[u8]) -> Option<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    let reste = donnees.strip_prefix(b"v10")?;
    if reste.len() < 12 + 16 {
        return None;
    }
    let (nonce, chiffre) = reste.split_at(12);
    let nonce: [u8; 12] = nonce.try_into().ok()?;
    aes_gcm::Aes256Gcm::new(cle.into()).decrypt(&nonce.into(), chiffre).ok()
}

pub fn aleatoire<const N: usize>() -> [u8; N] {
    let mut o = [0u8; N];
    getrandom::fill(&mut o).expect("system random source");
    o
}

#[cfg(windows)]
mod windows {
    use super::*;
    use serde_json::{Value, json};
    use std::path::PathBuf;
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData};

    fn dpapi(entree: &[u8], proteger: bool) -> Option<Vec<u8>> {
        let blob = CRYPT_INTEGER_BLOB { cbData: entree.len() as u32, pbData: entree.as_ptr() as *mut u8 };
        let mut sortie = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = unsafe {
            if proteger {
                CryptProtectData(&blob, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut sortie)
            } else {
                CryptUnprotectData(&blob, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut sortie)
            }
        };
        if ok == 0 || sortie.pbData.is_null() {
            return None;
        }
        let v = unsafe { std::slice::from_raw_parts(sortie.pbData, sortie.cbData as usize) }.to_vec();
        unsafe { LocalFree(sortie.pbData as _) };
        Some(v)
    }

    /// Clé de safeStorage, rangée dans « Local State » du dossier des réglages (créée au premier besoin).
    pub struct CoffreWindows {
        local_state: PathBuf,
        cle: Mutex<Option<[u8; 32]>>,
    }

    impl CoffreWindows {
        pub fn new(donnees: &std::path::Path) -> Self {
            Self { local_state: donnees.join("Local State"), cle: Mutex::default() }
        }

        fn lire_cle(&self) -> Option<[u8; 32]> {
            let etat: Value = serde_json::from_slice(&std::fs::read(&self.local_state).ok()?).ok()?;
            let brut = B64.decode(etat.pointer("/os_crypt/encrypted_key")?.as_str()?).ok()?;
            dpapi(brut.strip_prefix(b"DPAPI")?, false)?.try_into().ok()
        }

        fn cle(&self, creer: bool) -> Resultat<[u8; 32]> {
            let mut c = self.cle.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(k) = *c {
                return Ok(k);
            }
            if let Some(k) = self.lire_cle() {
                *c = Some(k);
                return Ok(k);
            }
            if !creer {
                return Err(Erreur::new(t("ipc.session_illisible")));
            }
            // Comme Chromium : clé aléatoire protégée par DPAPI, les autres réglages du fichier sont gardés.
            let k: [u8; 32] = aleatoire();
            let protegee = dpapi(&k, true).ok_or_else(|| Erreur::new(t("ipc.le_chiffrement_de_windows_est")))?;
            let mut etat: Value =
                std::fs::read(&self.local_state).ok().and_then(|o| serde_json::from_slice(&o).ok()).unwrap_or_else(|| json!({}));
            if !etat.is_object() {
                etat = json!({});
            }
            etat["os_crypt"] = json!({ "encrypted_key": B64.encode([b"DPAPI".as_slice(), &protegee].concat()) });
            crate::fichiers::ecrire_json(&self.local_state, &etat)?;
            *c = Some(k);
            Ok(k)
        }
    }

    impl Coffre for CoffreWindows {
        fn persistant(&self) -> bool {
            true
        }
        fn chiffrer(&self, _: &str, texte: &str) -> Resultat<String> {
            let k = self.cle(true)?;
            Ok(format!("enc:{}", B64.encode(chiffrer_v10(&k, texte.as_bytes(), aleatoire()))))
        }
        fn dechiffrer(&self, _: &str, donnees: &str) -> Resultat<String> {
            let illisible = || Erreur::new(t("ipc.session_illisible"));
            let brut = B64.decode(donnees.strip_prefix("enc:").ok_or_else(illisible)?).map_err(|_| illisible())?;
            let k = self.cle(false)?;
            String::from_utf8(dechiffrer_v10(&k, &brut).ok_or_else(illisible)?).map_err(|_| illisible())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::essai::Dossier;

        #[test]
        fn cle_creee_puis_relue_et_autres_reglages_gardes() {
            let d = Dossier::nouveau("coffre-windows");
            d.ecrire("Local State", r#"{"browser":{"x":1}}"#);
            let c = CoffreWindows::new(&d.0);
            let enc = c.chiffrer("a", "jetons secrets").unwrap();
            assert!(enc.starts_with("enc:"));
            // Un autre coffre (nouveau démarrage) relit la clé du fichier.
            assert_eq!(CoffreWindows::new(&d.0).dechiffrer("a", &enc).unwrap(), "jetons secrets");
            let etat: Value = crate::fichiers::lire_json(&d.0.join("Local State")).unwrap();
            assert_eq!(etat["browser"]["x"], 1);
            assert!(CoffreWindows::new(&d.0).dechiffrer("a", "enc:AAAA").is_err());
            assert!(CoffreWindows::new(&Dossier::nouveau("coffre-vide").0).dechiffrer("a", &enc).is_err());
        }

        /// Échange avec Electron (lancé à part) : ORZXN_ESSAI_COFFRE = son dossier, ORZXN_ESSAI_ENC = son texte chiffré.
        #[test]
        #[ignore]
        fn compatible_avec_electron() {
            let d = PathBuf::from(std::env::var("ORZXN_ESSAI_COFFRE").unwrap());
            let c = CoffreWindows::new(&d);
            println!("electron -> rust : {}", c.dechiffrer("a", &std::env::var("ORZXN_ESSAI_ENC").unwrap()).unwrap());
            std::fs::write(d.join("venu-de-rust.txt"), c.chiffrer("a", "bonjour depuis rust").unwrap()).unwrap();
        }
    }
}

#[cfg(windows)]
pub use windows::CoffreWindows;

/// Trousseau du système (macOS, Linux avec GNOME Keyring ou KWallet) : accounts.json ne garde qu'un repère « kc: ».
#[cfg(not(windows))]
pub struct CoffreTrousseau {
    persistant: std::sync::OnceLock<bool>,
}

#[cfg(not(windows))]
const SERVICE: &str = "0Rzxn_ Launcher";

#[cfg(not(windows))]
impl CoffreTrousseau {
    pub fn new() -> Self {
        Self { persistant: std::sync::OnceLock::new() }
    }
    fn entree(id: &str) -> Resultat<keyring::Entry> {
        keyring::Entry::new(SERVICE, id).map_err(|e| Erreur::new(e.to_string()))
    }
}

#[cfg(not(windows))]
impl Default for CoffreTrousseau {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(not(windows))]
impl Coffre for CoffreTrousseau {
    /// Linux sans trousseau : l'écriture d'essai échoue, la session reste en mémoire.
    fn persistant(&self) -> bool {
        *self.persistant.get_or_init(|| {
            let Ok(e) = Self::entree("essai") else { return false };
            let ok = e.set_password("essai").is_ok() && e.get_password().is_ok_and(|p| p == "essai");
            let _ = e.delete_credential();
            ok
        })
    }
    fn chiffrer(&self, id: &str, texte: &str) -> Resultat<String> {
        Self::entree(id)?.set_password(texte).map_err(|_| Erreur::new(t("ipc.le_chiffrement_de_windows_est")))?;
        Ok(format!("kc:{id}"))
    }
    fn dechiffrer(&self, id: &str, donnees: &str) -> Resultat<String> {
        if !donnees.starts_with("kc:") {
            return Err(Erreur::new(t("ipc.session_illisible")));
        }
        Self::entree(id)?.get_password().map_err(|_| Erreur::new(t("ipc.session_illisible")))
    }
    fn oublier(&self, id: &str) {
        if let Ok(e) = Self::entree(id) {
            let _ = e.delete_credential();
        }
    }
}

/// Coffre du système.
pub fn du_systeme(donnees: &std::path::Path) -> std::sync::Arc<dyn Coffre> {
    #[cfg(windows)]
    return std::sync::Arc::new(CoffreWindows::new(donnees));
    #[cfg(not(windows))]
    {
        let _ = donnees;
        std::sync::Arc::new(CoffreTrousseau::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_v10_de_chromium() {
        let cle = [7u8; 32];
        let enc = chiffrer_v10(&cle, b"bonjour", [1u8; 12]);
        assert_eq!(&enc[..3], b"v10");
        assert_eq!(enc.len(), 3 + 12 + 7 + 16);
        assert_eq!(dechiffrer_v10(&cle, &enc).unwrap(), b"bonjour");
        assert_eq!(dechiffrer_v10(&[8u8; 32], &enc), None);
        assert_eq!(dechiffrer_v10(&cle, b"v11abc"), None);
        assert_ne!(aleatoire::<16>(), aleatoire::<16>());
        let c = CoffreClair;
        assert_eq!(c.dechiffrer("x", &c.chiffrer("x", "é").unwrap()).unwrap(), "é");
    }
}
