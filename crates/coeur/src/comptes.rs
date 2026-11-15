//! Comptes hors-ligne et Microsoft (accounts.json), comme core/accounts.js. Les jetons Microsoft passent par le
//! coffre du système ; sans vraie protection (Linux sans trousseau), ils restent en mémoire jusqu'à la fermeture.

use crate::coffre::Coffre;
use crate::erreur::{Erreur, Resultat};
use crate::fichiers::{ecrire_json, lire_json};
use crate::i18n::{t, tv};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures_util::future::BoxFuture;
use md5::Digest;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MARGE_RENOUVELLEMENT_MS: i64 = 10 * 60 * 1000;
/// Session gardée en mémoire seulement : jamais écrite sur le disque.
const MEMOIRE: &str = "mem:";

/// UUID hors-ligne calculé comme Minecraft : UUID v3 de « OfflinePlayer:<pseudo> ».
pub fn uuid_hors_ligne(nom: &str) -> String {
    let mut h: [u8; 16] = md5::Md5::digest(format!("OfflinePlayer:{nom}").as_bytes()).into();
    h[6] = (h[6] & 0x0f) | 0x30;
    h[8] = (h[8] & 0x3f) | 0x80;
    h.iter().map(|b| format!("{b:02x}")).collect()
}

fn pseudo_valide(nom: &str) -> bool {
    (3..=16).contains(&nom.len()) && nom.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Session Microsoft complète (connexion ou renouvellement).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionMs {
    pub name: String,
    pub uuid: String,
    pub xuid: String,
    pub refresh_token: String,
    pub access_token: String,
    pub expires_at: i64,
    /// loopback (navigateur) | native (fenêtre intégrée)
    pub redirect: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Secrets {
    refresh_token: String,
    access_token: String,
    expires_at: i64,
}

/// Renouvelle une session à partir du jeton de renouvellement et de la sorte d'adresse de retour du compte.
pub type Renouveler = Arc<dyn Fn(String, String) -> BoxFuture<'static, Resultat<SessionMs>> + Send + Sync>;

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

/// Liste pour l'interface (sans les jetons).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Liste {
    pub active_id: Option<String>,
    pub accounts: Vec<commun::Compte>,
}

pub struct Comptes {
    fichier: PathBuf,
    coffre: Arc<dyn Coffre>,
    renouveler: Option<Renouveler>,
    donnees: Mutex<Map<String, Value>>,
}

fn texte(c: &Value, cle: &str) -> String {
    c.get(cle).and_then(Value::as_str).unwrap_or("").to_string()
}

impl Comptes {
    pub fn new(dossier: &Path, coffre: Arc<dyn Coffre>, renouveler: Option<Renouveler>) -> Self {
        let fichier = dossier.join("accounts.json");
        let mut donnees: Map<String, Value> = lire_json(&fichier).unwrap_or_default();
        if !donnees.get("accounts").is_some_and(Value::is_array) {
            donnees.insert("accounts".into(), json!([]));
        }
        donnees.entry("activeId").or_insert(Value::Null);
        Self { fichier, coffre, renouveler, donnees: Mutex::new(donnees) }
    }

    fn d(&self) -> std::sync::MutexGuard<'_, Map<String, Value>> {
        self.donnees.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Les jetons ne peuvent pas être protégés sur le disque : ils restent en mémoire.
    pub fn memoire_seulement(&self) -> bool {
        !self.coffre.persistant()
    }

    fn enregistrer(&self, d: &Map<String, Value>) -> Resultat<()> {
        if !self.memoire_seulement() {
            return Ok(ecrire_json(&self.fichier, d)?);
        }
        let mut copie = d.clone();
        if let Some(Value::Array(l)) = copie.get_mut("accounts") {
            for c in l.iter_mut().filter_map(Value::as_object_mut) {
                c.remove("secrets");
                if c.get("type").and_then(Value::as_str) == Some("microsoft") {
                    c.insert("needsLogin".into(), true.into());
                }
            }
        }
        Ok(ecrire_json(&self.fichier, &copie)?)
    }

    fn comptes(d: &Map<String, Value>) -> &[Value] {
        d.get("accounts").and_then(Value::as_array).map_or(&[], Vec::as_slice)
    }

    fn comptes_mut(d: &mut Map<String, Value>) -> &mut Vec<Value> {
        if !d.get("accounts").is_some_and(Value::is_array) {
            d.insert("accounts".into(), json!([]));
        }
        d.get_mut("accounts").and_then(Value::as_array_mut).expect("tableau")
    }

    pub fn liste(&self) -> Liste {
        let d = self.d();
        let seulement = self.memoire_seulement();
        let accounts = Self::comptes(&d)
            .iter()
            .map(|c| {
                let microsoft = texte(c, "type") == "microsoft";
                commun::Compte {
                    id: texte(c, "id"),
                    kind: texte(c, "type"),
                    name: texte(c, "name"),
                    uuid: texte(c, "uuid"),
                    needs_login: c.get("needsLogin").and_then(Value::as_bool).unwrap_or(false),
                    look: c.get("look").cloned().filter(|l| !l.is_null()),
                    session_only: (seulement && microsoft).then_some(true),
                }
            })
            .collect();
        Liste { active_id: d.get("activeId").and_then(Value::as_str).map(String::from), accounts }
    }

    fn chiffrer(&self, id: &str, texte: &str) -> Resultat<String> {
        if self.memoire_seulement() {
            return Ok(format!("{MEMOIRE}{}", B64.encode(texte)));
        }
        self.coffre.chiffrer(id, texte)
    }

    fn dechiffrer(&self, id: &str, donnees: &str) -> Resultat<String> {
        match donnees.strip_prefix(MEMOIRE) {
            _ if donnees.is_empty() => Err(Erreur::new(t("ipc.session_illisible"))),
            Some(b) => B64.decode(b).ok().and_then(|o| String::from_utf8(o).ok()).ok_or_else(|| Erreur::new(t("ipc.session_illisible"))),
            None => self.coffre.dechiffrer(id, donnees),
        }
    }

    /// Compte brut (avec ses secrets chiffrés).
    pub fn compte(&self, id: &str) -> Resultat<Value> {
        Self::comptes(&self.d()).iter().find(|c| texte(c, "id") == id).cloned().ok_or_else(|| Erreur::new(t("accounts.compte_introuvable")))
    }

    pub fn tous(&self) -> Vec<Value> {
        Self::comptes(&self.d()).to_vec()
    }

    fn modifier(&self, id: &str, f: impl FnOnce(&mut Map<String, Value>)) -> Resultat<()> {
        let mut d = self.d();
        let c = Self::comptes_mut(&mut d)
            .iter_mut()
            .filter_map(Value::as_object_mut)
            .find(|c| c.get("id").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| Erreur::new(t("accounts.compte_introuvable")))?;
        f(c);
        self.enregistrer(&d)
    }

    /// Apparence d'un compte (skin, cape, capes possédées).
    pub fn changer_apparence(&self, id: &str, look: Value) -> Resultat<()> {
        self.modifier(id, |c| {
            c.insert("look".into(), look);
        })
    }

    /// Le compte choisi pour une instance s'il existe encore, sinon le compte actif.
    pub fn choisir(&self, voulu: Option<&str>) -> Option<String> {
        let d = self.d();
        let existe = |id: &str| Self::comptes(&d).iter().any(|c| texte(c, "id") == id);
        voulu
            .filter(|v| existe(v))
            .map(String::from)
            .or_else(|| d.get("activeId").and_then(Value::as_str).filter(|a| existe(a)).map(String::from))
    }

    /// Un nouveau compte hors-ligne demande d'abord un compte Microsoft (preuve que le jeu a été acheté).
    pub fn hors_ligne_possible(&self) -> bool {
        Self::comptes(&self.d()).iter().any(|c| texte(c, "type") == "microsoft")
    }

    pub fn ajouter_hors_ligne(&self, brut: &str) -> Resultat<Liste> {
        if !self.hors_ligne_possible() {
            return Err(Erreur::new(t("accounts.connecte_abord_un_compte_microsoft")));
        }
        let nom = brut.trim();
        if !pseudo_valide(nom) {
            return Err(Erreur::new(t("accounts.16_caracteres_lettres_chiffres_et")));
        }
        {
            let mut d = self.d();
            if Self::comptes(&d).iter().any(|c| texte(c, "type") == "offline" && texte(c, "name").eq_ignore_ascii_case(nom)) {
                return Err(Erreur::new(t("accounts.ce_pseudo_existe_deja")));
            }
            let uuid = uuid_hors_ligne(nom);
            let id = format!("offline-{uuid}");
            Self::comptes_mut(&mut d).push(json!({ "id": id, "type": "offline", "name": nom, "uuid": uuid }));
            d.insert("activeId".into(), id.into());
            self.enregistrer(&d)?;
        }
        Ok(self.liste())
    }

    /// Ajoute (ou reconnecte) un compte Microsoft. `activer` faux : un renouvellement ne change pas le compte actif.
    pub fn ajouter_microsoft(&self, s: &SessionMs, activer: bool) -> Resultat<Liste> {
        let id = format!("microsoft-{}", s.uuid);
        let secrets = Secrets { refresh_token: s.refresh_token.clone(), access_token: s.access_token.clone(), expires_at: s.expires_at };
        let chiffre = self.chiffrer(&id, &serde_json::to_string(&secrets).map_err(|e| Erreur::new(e.to_string()))?)?;
        {
            let mut d = self.d();
            let mut compte = json!({ "id": id, "type": "microsoft", "name": s.name, "uuid": s.uuid, "xuid": s.xuid });
            // Connexion faite dans le navigateur : le renouvellement utilise la même adresse de retour.
            if s.redirect == "loopback" {
                compte["redirect"] = "loopback".into();
            }
            compte["secrets"] = chiffre.into();
            let l = Self::comptes_mut(&mut d);
            match l.iter_mut().find(|c| texte(c, "id") == id) {
                Some(ancien) => {
                    if let Some(look) = ancien.get("look").cloned() {
                        compte["look"] = look;
                    }
                    *ancien = compte;
                }
                None => l.push(compte),
            }
            if activer {
                d.insert("activeId".into(), id.into());
            }
            self.enregistrer(&d)?;
        }
        Ok(self.liste())
    }

    pub fn retirer(&self, id: &str) -> Resultat<Liste> {
        {
            let mut d = self.d();
            Self::comptes_mut(&mut d).retain(|c| texte(c, "id") != id);
            if d.get("activeId").and_then(Value::as_str) == Some(id) {
                let premier = Self::comptes(&d).first().map(|c| texte(c, "id"));
                d.insert("activeId".into(), premier.map_or(Value::Null, Value::String));
            }
            self.enregistrer(&d)?;
        }
        self.coffre.oublier(id);
        Ok(self.liste())
    }

    pub fn activer(&self, id: &str) -> Resultat<Liste> {
        {
            let mut d = self.d();
            if !Self::comptes(&d).iter().any(|c| texte(c, "id") == id) {
                return Err(Erreur::new(t("accounts.compte_introuvable")));
            }
            d.insert("activeId".into(), id.into());
            self.enregistrer(&d)?;
        }
        Ok(self.liste())
    }

    fn a_reconnecter(&self, id: &str) {
        let _ = self.modifier(id, |c| {
            c.insert("needsLogin".into(), true.into());
        });
    }

    /// Jetons d'un compte Microsoft, renouvelés s'ils expirent dans moins de 10 minutes (ou tout de suite avec `forcer`).
    async fn jetons(&self, id: &str, log: &(dyn Fn(&str) + Send + Sync), forcer: bool) -> Resultat<Secrets> {
        let compte = self.compte(id)?;
        let lus = self.dechiffrer(id, &texte(&compte, "secrets")).ok().and_then(|s| serde_json::from_str::<Secrets>(&s).ok());
        let Some(mut secrets) = lus else {
            self.a_reconnecter(id);
            return Err(Erreur::new(tv("accounts.impossible_de_lire_la_session", &[("name", &texte(&compte, "name"))])));
        };
        if forcer || crate::base::maintenant() > secrets.expires_at - MARGE_RENOUVELLEMENT_MS {
            let Some(renouveler) = &self.renouveler else { return Err(Erreur::new(t("accounts.la_connexion_microsoft_est_pas"))) };
            log(&t("accounts.renouvellement_de_la_session_microsoft"));
            let redirect = compte.get("redirect").and_then(Value::as_str).unwrap_or("native").to_string();
            match renouveler(secrets.refresh_token.clone(), redirect).await {
                Ok(s) => {
                    // Remplace l'entrée (et efface « à reconnecter »).
                    self.ajouter_microsoft(&s, false)?;
                    secrets = Secrets { refresh_token: s.refresh_token, access_token: s.access_token, expires_at: s.expires_at };
                }
                // Hors connexion : le dernier jeton suffit pour jouer en solo.
                Err(e) if e.a_le_code("NETWORK") => log(&tv("accounts.session_non_renouvelee_le_multijoueur", &[("message", &e.message)])),
                Err(e) => {
                    self.a_reconnecter(id);
                    return Err(e);
                }
            }
        }
        Ok(secrets)
    }

    /// Lance `action(jeton)` pour un compte Microsoft. Si Minecraft refuse le jeton (401), une seule reprise avec un jeton neuf.
    pub async fn avec_jeton<T, F, Fut>(&self, id: &str, action: F) -> Resultat<T>
    where
        F: Fn(String) -> Fut,
        Fut: Future<Output = Resultat<T>>,
    {
        if texte(&self.compte(id)?, "type") != "microsoft" {
            return Err(Erreur::new(t("accounts.il_faut_un_compte_microsoft")));
        }
        let rien = |_: &str| {};
        let s = self.jetons(id, &rien, false).await?;
        match action(s.access_token).await {
            Err(e) if e.a_le_code("UNAUTHORIZED") => {
                let s = self.jetons(id, &rien, true).await?;
                action(s.access_token).await
            }
            r => r,
        }
    }

    /// Compte prêt pour le lancement. Hors-ligne : jeton jetable, comme le launcher officiel.
    pub async fn compte_de_jeu(&self, id: &str, log: &(dyn Fn(&str) + Send + Sync)) -> Resultat<CompteJeu> {
        let c = self.compte(id).map_err(|_| Erreur::new(t("common.ajoute_un_compte_avant_de")))?;
        if texte(&c, "type") == "offline" {
            let jeton: String = crate::coffre::aleatoire::<16>().iter().map(|b| format!("{b:02x}")).collect();
            return Ok(CompteJeu {
                name: texte(&c, "name"),
                uuid: texte(&c, "uuid"),
                access_token: jeton,
                user_type: "legacy",
                xuid: "0".into(),
                genre: "offline",
            });
        }
        let s = self.jetons(id, log, false).await?;
        let xuid = Some(texte(&c, "xuid")).filter(|x| !x.is_empty()).unwrap_or_else(|| "0".into());
        Ok(CompteJeu {
            name: texte(&c, "name"),
            uuid: texte(&c, "uuid"),
            access_token: s.access_token,
            user_type: "msa",
            xuid,
            genre: "microsoft",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coffre::CoffreClair;
    use crate::essai::Dossier;
    use futures_util::FutureExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn session(jeton: &str, expire: i64) -> SessionMs {
        SessionMs {
            name: "Ana".into(),
            uuid: "0123456789abcdef0123456789abcdef".into(),
            xuid: "42".into(),
            refresh_token: format!("r-{jeton}"),
            access_token: jeton.into(),
            expires_at: expire,
            redirect: "loopback".into(),
        }
    }

    #[test]
    fn uuid_comme_minecraft() {
        assert_eq!(uuid_hors_ligne("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
        let u = uuid_hors_ligne("0Rzxn_");
        assert_eq!((u.len(), &u[12..13]), (32, "3"));
        assert!("89ab".contains(&u[16..17]));
        assert_ne!(uuid_hors_ligne("notch"), uuid_hors_ligne("Notch"));
    }

    #[test]
    fn hors_ligne_apres_un_compte_microsoft_et_pseudos() {
        let d = Dossier::nouveau("comptes-hl");
        let c = Comptes::new(&d.0, Arc::new(CoffreClair), None);
        assert!(c.ajouter_hors_ligne("Joueur").is_err());
        d.ecrire(
            "accounts.json",
            &json!({ "activeId": "ms-1", "accounts": [{ "id": "ms-1", "type": "microsoft", "name": "Officiel", "uuid": "f".repeat(32) }] })
                .to_string(),
        );
        let c = Comptes::new(&d.0, Arc::new(CoffreClair), None);
        let l = c.ajouter_hors_ligne("  Joueur_2 ").unwrap();
        let ajoute = l.accounts.iter().find(|a| a.kind == "offline").unwrap().clone();
        assert_eq!((ajoute.name.as_str(), ajoute.uuid.clone()), ("Joueur_2", uuid_hors_ligne("Joueur_2")));
        assert_eq!(l.active_id, Some(format!("offline-{}", ajoute.uuid)));
        assert_eq!(Comptes::new(&d.0, Arc::new(CoffreClair), None).liste().accounts.len(), 2);
        for nom in ["ab", &"a".repeat(17), "avec espace", "accentué", ""] {
            assert!(c.ajouter_hors_ligne(nom).is_err(), "{nom}");
        }
        assert!(c.ajouter_hors_ligne("JOUEUR_2").is_err());
        assert_eq!(c.choisir(Some("disparu")), Some(format!("offline-{}", ajoute.uuid)));
        // Retrait du compte actif : le premier restant devient actif.
        let l = c.retirer(&format!("offline-{}", ajoute.uuid)).unwrap();
        assert_eq!(l.active_id.as_deref(), Some("ms-1"));
    }

    #[tokio::test]
    async fn renouvellement_avant_expiration_et_reprise_sur_401() {
        let d = Dossier::nouveau("comptes-ms");
        let appels = Arc::new(AtomicUsize::new(0));
        let a = appels.clone();
        let renouveler: Renouveler = Arc::new(move |refresh: String, redirect: String| {
            let n = a.fetch_add(1, Ordering::SeqCst) + 1;
            async move {
                assert_eq!(redirect, "loopback");
                assert!(refresh.starts_with("r-"));
                Ok(session(&format!("neuf{n}"), crate::base::maintenant() + 3_600_000))
            }
            .boxed()
        });
        let c = Comptes::new(&d.0, Arc::new(CoffreClair), Some(renouveler));
        let l = c.ajouter_microsoft(&session("ancien", crate::base::maintenant() + 3_600_000), true).unwrap();
        let id = l.active_id.clone().unwrap();
        let rien = |_: &str| {};
        // Jeton encore valide : pas de renouvellement.
        assert_eq!(c.compte_de_jeu(&id, &rien).await.unwrap().access_token, "ancien");
        // Jeton refusé par Minecraft : un seul nouvel essai avec un jeton neuf.
        let r = c
            .avec_jeton(&id, |j| async move { if j == "ancien" { Err(Erreur::code("401", "UNAUTHORIZED")) } else { Ok(j) } })
            .await
            .unwrap();
        assert_eq!((r.as_str(), appels.load(Ordering::SeqCst)), ("neuf1", 1));
        // Expiré : renouvelé avant la partie, message dans la console.
        c.ajouter_microsoft(&session("vieux", 0), true).unwrap();
        let messages = Mutex::new(vec![]);
        let log = |m: &str| messages.lock().unwrap().push(m.to_string());
        let j = c.compte_de_jeu(&id, &log).await.unwrap();
        assert_eq!((j.access_token.as_str(), j.user_type, j.xuid.as_str()), ("neuf2", "msa", "42"));
        assert_eq!(messages.lock().unwrap().len(), 1);
        let disque = std::fs::read_to_string(d.0.join("accounts.json")).unwrap();
        assert!(disque.contains("\"redirect\": \"loopback\"") && disque.contains("plain:") && !disque.contains("neuf2"));
    }

    #[tokio::test]
    async fn session_illisible_et_refus_marquent_a_reconnecter() {
        let d = Dossier::nouveau("comptes-refus");
        let renouveler: Renouveler = Arc::new(|_, _| async { Err(Erreur::code("expirée", "EXPIRED")) }.boxed());
        let c = Comptes::new(&d.0, Arc::new(CoffreClair), Some(renouveler));
        let id = c.ajouter_microsoft(&session("x", 0), true).unwrap().active_id.unwrap();
        assert!(c.compte_de_jeu(&id, &|_| {}).await.is_err());
        assert!(c.liste().accounts[0].needs_login);
        // Hors connexion : l'ancien jeton sert quand même.
        let reseau: Renouveler = Arc::new(|_, _| async { Err(Erreur::code("hors ligne", "NETWORK")) }.boxed());
        let c = Comptes::new(&d.0, Arc::new(CoffreClair), Some(reseau));
        c.ajouter_microsoft(&session("x", 0), true).unwrap();
        assert_eq!(c.compte_de_jeu(&id, &|_| {}).await.unwrap().access_token, "x");
    }

    struct SansTrousseau;
    impl Coffre for SansTrousseau {
        fn persistant(&self) -> bool {
            false
        }
        fn chiffrer(&self, _: &str, _: &str) -> Resultat<String> {
            panic!("jamais")
        }
        fn dechiffrer(&self, _: &str, _: &str) -> Resultat<String> {
            panic!("jamais")
        }
    }

    #[tokio::test]
    async fn sans_trousseau_jetons_en_memoire() {
        let d = Dossier::nouveau("comptes-memoire");
        let c = Comptes::new(&d.0, Arc::new(SansTrousseau), None);
        let l = c.ajouter_microsoft(&session("a1", crate::base::maintenant() + 3_600_000), true).unwrap();
        assert_eq!((l.accounts[0].needs_login, l.accounts[0].session_only), (false, Some(true)));
        let id = l.active_id.unwrap();
        assert_eq!(c.compte_de_jeu(&id, &|_| {}).await.unwrap().access_token, "a1");
        let disque = std::fs::read_to_string(d.0.join("accounts.json")).unwrap();
        assert!(!disque.contains("a1") && !disque.contains("secrets"), "{disque}");
        c.ajouter_hors_ligne("Bob").unwrap();
        let relu = Comptes::new(&d.0, Arc::new(SansTrousseau), None);
        let ana = relu.liste().accounts.into_iter().find(|a| a.kind == "microsoft").unwrap();
        assert_eq!((ana.name.as_str(), ana.needs_login, ana.session_only), ("Ana", true, Some(true)));
        assert!(relu.compte_de_jeu(&id, &|_| {}).await.is_err());
    }
}
