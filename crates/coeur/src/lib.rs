//! Logique du launcher, sans Tauri : testable avec `cargo test`.
//! R0 : lecture seule. Aucune fonction de ce crate n'écrit sur le disque.

pub mod chemins;
pub mod comptes;
pub mod instances;
pub mod reglages;

use serde::de::DeserializeOwned;
use std::path::Path;

/// Lit un fichier JSON ; None s'il manque ou est illisible (comme readJson côté Electron).
pub fn lire_json<T: DeserializeOwned>(fichier: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(fichier).ok()?).ok()
}

#[cfg(test)]
pub(crate) mod essai {
    use std::path::PathBuf;

    /// Dossier temporaire propre à un test, effacé à la fin.
    pub struct Dossier(pub PathBuf);
    impl Dossier {
        pub fn nouveau(nom: &str) -> Self {
            let d = std::env::temp_dir().join(format!("coeur-essai-{nom}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
        pub fn ecrire(&self, chemin: &str, contenu: &str) {
            let f = self.0.join(chemin);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, contenu).unwrap();
        }
    }
    impl Drop for Dossier {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
