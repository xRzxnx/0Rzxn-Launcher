//! accounts.json, sans les jetons : seuls id, type et nom sont lus.

use commun::Compte;
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Fichier {
    active_id: Option<String>,
    accounts: Vec<Compte>,
}

/// (comptes, compte actif). Le compte actif doit exister dans la liste.
pub fn lire(donnees: &Path) -> (Vec<Compte>, Option<String>) {
    let f: Fichier = crate::lire_json(&donnees.join("accounts.json")).unwrap_or_default();
    let actif = f.active_id.filter(|id| f.accounts.iter().any(|c| &c.id == id));
    (f.accounts, actif)
}

#[cfg(test)]
mod tests {
    use crate::essai::Dossier;

    #[test]
    fn jetons_ignores_et_actif_verifie() {
        let d = Dossier::nouveau("comptes");
        d.ecrire(
            "accounts.json",
            r#"{"activeId":"b","accounts":[{"id":"a","type":"microsoft","name":"Rz","uuid":"u","secret":"enc:xyz"}]}"#,
        );
        let (comptes, actif) = super::lire(&d.0);
        assert_eq!((comptes.len(), comptes[0].kind.as_str(), actif), (1, "microsoft", None));
    }
}
