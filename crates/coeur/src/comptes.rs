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
    let f: Fichier = crate::fichiers::lire_json(&donnees.join("accounts.json")).unwrap_or_default();
    let actif = f.active_id.filter(|id| f.accounts.iter().any(|c| &c.id == id));
    (f.accounts, actif)
}

/// Compte prêt pour une partie : nom, UUID et jeton passés au jeu.
#[derive(Debug, Clone, PartialEq)]
pub struct CompteJeu {
    pub name: String,
    pub uuid: String,
    pub access_token: String,
    /// legacy (hors-ligne) | msa
    pub user_type: &'static str,
    pub xuid: String,
    /// offline | microsoft
    pub genre: &'static str,
}

/// Compte à utiliser : celui demandé s'il existe encore, sinon le compte actif.
pub fn choisir(donnees: &Path, voulu: Option<&str>) -> Option<String> {
    let (comptes, actif) = lire(donnees);
    voulu.filter(|v| comptes.iter().any(|c| c.id == *v)).map(String::from).or(actif)
}

/// Compte de lancement. Hors-ligne : jeton jetable, comme le launcher officiel.
pub fn compte_de_jeu(donnees: &Path, id: &str) -> crate::erreur::Resultat<CompteJeu> {
    use crate::erreur::Erreur;
    use crate::i18n::t;
    let brut: serde_json::Value = crate::fichiers::lire_json(&donnees.join("accounts.json")).unwrap_or_default();
    let compte = brut
        .get("accounts")
        .and_then(serde_json::Value::as_array)
        .and_then(|l| l.iter().find(|c| c.get("id").and_then(serde_json::Value::as_str) == Some(id)))
        .ok_or_else(|| Erreur::new(t("common.ajoute_un_compte_avant_de")))?;
    let champ = |n: &str| compte.get(n).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if champ("type") != "offline" {
        // shortcut: les comptes Microsoft (renouvellement de session, jetons protégés) arrivent en R3.
        return Err(Erreur::new(t("accounts.microsoft_pas_encore")));
    }
    let jeton: String = (0..16).map(|_| format!("{:02x}", fastrand::u8(..))).collect();
    Ok(CompteJeu { name: champ("name"), uuid: champ("uuid"), access_token: jeton, user_type: "legacy", xuid: "0".into(), genre: "offline" })
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
    #[test]
    fn compte_de_lancement() {
        let d = Dossier::nouveau("comptes-jeu");
        d.ecrire(
            "accounts.json",
            r#"{"activeId":"m","accounts":[{"id":"m","type":"microsoft","name":"Rz","uuid":"u1"},{"id":"o","type":"offline","name":"Steve","uuid":"u2"}]}"#,
        );
        assert_eq!(super::choisir(&d.0, Some("o")).as_deref(), Some("o"));
        assert_eq!(super::choisir(&d.0, Some("disparu")).as_deref(), Some("m"));
        let c = super::compte_de_jeu(&d.0, "o").unwrap();
        assert_eq!((c.name.as_str(), c.uuid.as_str(), c.user_type, c.access_token.len()), ("Steve", "u2", "legacy", 32));
        assert!(super::compte_de_jeu(&d.0, "m").is_err());
        assert!(super::compte_de_jeu(&d.0, "x").is_err());
    }
}
