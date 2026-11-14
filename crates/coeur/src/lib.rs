//! Logique du launcher, sans Tauri : testable avec `cargo test`.

pub mod arguments;
pub mod base;
pub mod chemins;
pub mod comptes;
pub mod crashes;
pub mod empreintes;
pub mod erreur;
pub mod fichiers;
pub mod i18n;
pub mod installation;
pub mod instances;
pub mod java;
pub mod jeu;
pub mod journal;
pub mod lancement;
pub mod loaders;
pub mod mesures;
pub mod nbt;
pub mod net;
pub mod performances;
pub mod reglages;
pub mod regles;
pub mod sortie_jeu;
pub mod taches;
pub mod telechargement;
pub mod temporaires;
pub mod versions;
pub mod zip;

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

#[cfg(test)]
pub(crate) mod essai_http;
