//! Lecture et écriture des fichiers JSON du launcher, comme core/store.js.

use serde::{Serialize, de::DeserializeOwned};
use std::io;
use std::path::Path;

/// Lit un fichier JSON ; None s'il manque ou est illisible.
pub fn lire_json<T: DeserializeOwned>(fichier: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(fichier).ok()?).ok()
}

/// Écrit un fichier JSON de façon atomique : fichier temporaire, puis renommage. Indentation de 2 espaces, comme Electron.
pub fn ecrire_json<T: Serialize + ?Sized>(fichier: &Path, donnees: &T) -> io::Result<()> {
    if let Some(dossier) = fichier.parent() {
        std::fs::create_dir_all(dossier)?;
    }
    let mut nom = fichier.file_name().unwrap_or_default().to_os_string();
    nom.push(format!(".{}.tmp", std::process::id()));
    let tmp = fichier.with_file_name(nom);
    std::fs::write(&tmp, serde_json::to_vec_pretty(donnees)?)?;
    std::fs::rename(&tmp, fichier).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use crate::essai::Dossier;
    use serde_json::{Value, json};

    #[test]
    fn ecriture_atomique_et_ordre_des_cles_garde() {
        let d = Dossier::nouveau("fichiers");
        let f = d.0.join("sous/reglages.json");
        super::ecrire_json(&f, &json!({ "z": 1, "a": { "b": [1, 2] } })).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\n  \"z\": 1,\n  \"a\": {\n    \"b\": [\n      1,\n      2\n    ]\n  }\n}");
        assert_eq!(super::lire_json::<Value>(&f).unwrap()["a"]["b"][1], 2);
        assert!(super::lire_json::<Value>(&d.0.join("absent.json")).is_none());
        assert_eq!(std::fs::read_dir(f.parent().unwrap()).unwrap().count(), 1, "pas de fichier temporaire laissé");
    }
}
