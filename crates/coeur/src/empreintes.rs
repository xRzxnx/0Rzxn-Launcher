//! Empreintes et métadonnées des jars gardées entre deux ouvertures du launcher (table file_hashes de launcher.db),
//! comme core/hash-cache.js. Un fichier n'est relu que si sa taille ou sa date a changé. Chaque lecteur garde sa partie
//! des métadonnées (`content` pour l'onglet Mods, `check:<loader>` pour le contrôle avant lancement) sans écraser l'autre.

use crate::base::Base;
use serde_json::{Map, Value};

/// Taille et date de modification (millisecondes) d'un fichier, comme fs.Stats.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Etat {
    pub taille: i64,
    pub mtime_ms: f64,
}

impl Etat {
    pub fn de(m: &std::fs::Metadata) -> Self {
        let mtime_ms =
            m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
        Self { taille: m.len() as i64, mtime_ms }
    }
}

/// Partie `partie` des métadonnées gardées pour ce fichier, si elle existe et que le fichier n'a pas changé : (sha1, valeur).
pub fn rappeler(base: &Base, fichier: &str, etat: Etat, partie: &str) -> Option<(String, Value)> {
    let (sha1, meta) = base.empreinte(fichier, etat.taille, etat.mtime_ms)?;
    let valeur = meta?.get(partie)?.clone();
    Some((sha1, valeur))
}

/// Garde la partie `partie` des métadonnées de ce fichier, avec son empreinte SHA-1.
pub fn retenir(base: &Base, fichier: &str, etat: Etat, sha1: &str, partie: &str, valeur: Value) {
    let mut meta = match base.empreinte(fichier, etat.taille, etat.mtime_ms) {
        Some((s, Some(Value::Object(m)))) if s == sha1 => m,
        _ => Map::new(),
    };
    meta.insert(partie.into(), valeur);
    base.noter_empreinte(fichier, etat.taille, etat.mtime_ms, sha1, Some(&Value::Object(meta)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai::Dossier;
    use serde_json::json;

    #[test]
    fn chaque_lecteur_garde_sa_partie() {
        let d = Dossier::nouveau("empreintes");
        let b = Base::ouvrir(&d.0.join("launcher.db"));
        let e = Etat { taille: 10, mtime_ms: 1.5 };
        assert_eq!(rappeler(&b, "a.jar", e, "content"), None);
        retenir(&b, "a.jar", e, "sha", "content", json!({ "name": "A" }));
        retenir(&b, "a.jar", e, "sha", "check:fabric", json!({ "mainIds": ["a"] }));
        assert_eq!(rappeler(&b, "a.jar", e, "content"), Some(("sha".into(), json!({ "name": "A" }))));
        assert_eq!(rappeler(&b, "a.jar", e, "check:fabric"), Some(("sha".into(), json!({ "mainIds": ["a"] }))));
        assert_eq!(rappeler(&b, "a.jar", e, "check:forge"), None);
        assert_eq!(rappeler(&b, "a.jar", Etat { taille: 11, ..e }, "content"), None);
        // Contenu changé (autre empreinte) : l'ancienne partie des métadonnées est oubliée.
        let e2 = Etat { taille: 12, mtime_ms: 2.0 };
        retenir(&b, "a.jar", e2, "autre", "content", json!({ "name": "B" }));
        assert_eq!(rappeler(&b, "a.jar", e2, "check:fabric"), None);
        b.fermer();
    }
}
