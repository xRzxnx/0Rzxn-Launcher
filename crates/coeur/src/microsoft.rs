//! Connexion Microsoft → Xbox Live → XSTS → Minecraft (méthode officielle avec une application Azure), comme
//! core/microsoft.js. Référence : https://minecraft.wiki/w/Microsoft_authentication

use crate::coffre::aleatoire;
use crate::comptes::SessionMs;
use crate::erreur::{Erreur, Resultat};
use crate::i18n::{t, tv};
use crate::net::{Options, Reseau};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use reqwest::Method;
use serde_json::{Value, json};
use sha2::Digest;
use std::time::Duration;

/// Application (client) ID de l'application Azure du launcher (pas un secret). LAUNCHER_MS_CLIENT_ID le remplace.
const CLIENT_ID: &str = "133282a2-2e6b-487f-8610-62f0aebd464f";
pub const REDIRECT_NATIF: &str = "https://login.microsoftonline.com/common/oauth2/nativeclient";
/// Connexion dans le navigateur : adresse locale, dont Microsoft ignore le port (inscrite « http://localhost » dans Azure).
pub const REDIRECT_LOCAL: &str = "http://localhost";
const SCOPE: &str = "XboxLive.signin offline_access";
const DELAI: Duration = Duration::from_secs(20);

pub fn client_id() -> String {
    std::env::var("LAUNCHER_MS_CLIENT_ID").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| CLIENT_ID.into())
}

/// Adresses des services, remplaçables pour les tests (LAUNCHER_MC_API pour Minecraft, comme la version Electron).
#[derive(Debug, Clone)]
pub struct Points {
    pub oauth: String,
    pub xbl: String,
    pub xsts: String,
    pub mc: String,
}

impl Default for Points {
    fn default() -> Self {
        let mc = std::env::var("LAUNCHER_MC_API").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        Self {
            oauth: "https://login.microsoftonline.com/consumers/oauth2/v2.0".into(),
            xbl: "https://user.auth.xboxlive.com/user/authenticate".into(),
            xsts: "https://xsts.auth.xboxlive.com/xsts/authorize".into(),
            mc: mc.unwrap_or_else(|| "https://api.minecraftservices.com".into()),
        }
    }
}

/// Adresse de retour d'un compte : « loopback » (navigateur) ou, par défaut, la fenêtre intégrée.
pub fn redirect_pour(redirect: &str) -> &'static str {
    if redirect == "loopback" { REDIRECT_LOCAL } else { REDIRECT_NATIF }
}

fn erreur(message: String, code: &'static str) -> Erreur {
    Erreur::code(message, code)
}

pub struct ReponseMs {
    pub statut: u16,
    pub corps: Value,
    pub attendre_s: u64,
}

impl ReponseMs {
    fn ok(&self) -> bool {
        (200..300).contains(&self.statut)
    }
}

pub enum Corps {
    Rien,
    Json(Value),
    Formulaire(Vec<(&'static str, String)>),
    /// Type (avec la frontière) et octets.
    Multipart(String, Vec<u8>),
}

pub fn encoder_formulaire(champs: &[(&str, String)]) -> String {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| match b {
                b' ' => "+".into(),
                b if b.is_ascii_alphanumeric() || b"*-._".contains(&b) => (b as char).to_string(),
                b => format!("%{b:02X}"),
            })
            .collect()
    };
    champs.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&")
}

/// Appel simple (pas de nouvel essai) ; un échec réseau a le code NETWORK.
pub async fn appeler(reseau: &Reseau, url: &str, methode: Method, corps: Corps, jeton: Option<&str>) -> Resultat<ReponseMs> {
    let mut entetes = vec![("Accept".to_string(), "application/json".to_string())];
    if let Some(j) = jeton {
        entetes.push(("Authorization".into(), format!("Bearer {j}")));
    }
    let octets = match corps {
        Corps::Rien => None,
        Corps::Json(v) => {
            entetes.push(("Content-Type".into(), "application/json".into()));
            Some(v.to_string().into_bytes())
        }
        Corps::Formulaire(f) => {
            entetes.push(("Content-Type".into(), "application/x-www-form-urlencoded".into()));
            Some(encoder_formulaire(&f).into_bytes())
        }
        Corps::Multipart(genre, o) => {
            entetes.push(("Content-Type".into(), genre));
            Some(o)
        }
    };
    let o = Options { methode, entetes, corps: octets, inactivite: DELAI, essais: 1, ..Options::default() };
    let hote = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let reseau_ko = |e: Erreur| erreur(tv("microsoft.pas_de_reponse_de", &[("host", &hote), ("code", &e.message)]), "NETWORK");
    let r = reseau.envoyer(url, &o).await.map_err(reseau_ko)?;
    let statut = r.statut;
    let attendre_s = r.entete("retry-after").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    let corps = r.tout().await.map_err(reseau_ko)?;
    Ok(ReponseMs { statut, corps: serde_json::from_slice(&corps).unwrap_or(Value::Null), attendre_s })
}

// ---------- 1. OAuth Microsoft (code d'autorisation + PKCE) ----------

/// Valeur « state » d'une connexion : relie la réponse de Microsoft à la connexion lancée.
pub fn nouvel_etat() -> String {
    B64URL.encode(aleatoire::<16>())
}

pub struct Autorisation {
    pub url: String,
    pub verificateur: String,
    pub etat: String,
}

/// Adresse de la page de connexion Microsoft, avec l'adresse de retour choisie.
pub fn autorisation(points: &Points, client: &str, redirect: &str, etat: String) -> Autorisation {
    let verificateur = B64URL.encode(aleatoire::<48>());
    let defi = B64URL.encode(sha2::Sha256::digest(verificateur.as_bytes()));
    let parametres = [
        ("client_id", client.to_string()),
        ("response_type", "code".into()),
        ("redirect_uri", redirect.into()),
        ("response_mode", "query".into()),
        ("scope", SCOPE.into()),
        ("state", etat.clone()),
        ("code_challenge", defi),
        ("code_challenge_method", "S256".into()),
        ("prompt", "select_account".into()),
    ];
    Autorisation { url: format!("{}/authorize?{}", points.oauth, encoder_formulaire(&parametres)), verificateur, etat }
}

/// Paramètres de retour (fenêtre intégrée ou adresse locale) : le code, ou une erreur DENIED, STATE, NO_CODE…
pub fn lire_retour(parametres: &[(String, String)], etat_attendu: &str) -> Resultat<String> {
    let p = |n: &str| parametres.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str());
    if let Some(e) = p("error") {
        if e == "access_denied" {
            return Err(erreur(t("microsoft.connexion_refusee"), "DENIED"));
        }
        let description = p("error_description").unwrap_or(e);
        return Err(erreur(tv("microsoft.microsoft_refuse_la_connexion", &[("description", description)]), "OAUTH"));
    }
    if p("state") != Some(etat_attendu) {
        return Err(erreur(t("microsoft.reponse_de_connexion_inattendue_reessaie"), "STATE"));
    }
    p("code")
        .filter(|c| !c.is_empty())
        .map(String::from)
        .ok_or_else(|| erreur(t("microsoft.reponse_de_connexion_incomplete_reessaie"), "NO_CODE"))
}

/// Paramètres d'une adresse (« ?a=1&b=2 »), décodés.
pub fn parametres(url: &str) -> Vec<(String, String)> {
    reqwest::Url::parse(url).map(|u| u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect()).unwrap_or_default()
}

/// Retour de la fenêtre intégrée : None si l'adresse n'est pas l'adresse de retour.
pub fn lire_redirection(url: &str, etat_attendu: &str) -> Option<Resultat<String>> {
    url.starts_with(REDIRECT_NATIF).then(|| lire_retour(&parametres(url), etat_attendu))
}

fn erreur_jeton(r: &ReponseMs) -> Erreur {
    match r.corps.get("error").and_then(Value::as_str) {
        Some("invalid_grant") => erreur(t("microsoft.la_session_microsoft_expire_reconnecte"), "EXPIRED"),
        Some("invalid_client" | "unauthorized_client") => erreur(t("microsoft.application_azure_du_launcher_est"), "CLIENT"),
        _ => {
            let d = r.corps.get("error_description").and_then(Value::as_str).map(String::from).unwrap_or_else(|| r.statut.to_string());
            erreur(tv("microsoft.microsoft_refuse_le_jeton", &[("error_description", &d)]), "TOKEN")
        }
    }
}

struct JetonsMs {
    acces: String,
    renouvellement: String,
}

async fn jeton_ms(reseau: &Reseau, points: &Points, formulaire: Vec<(&'static str, String)>, ancien: Option<&str>) -> Resultat<JetonsMs> {
    let r = appeler(reseau, &format!("{}/token", points.oauth), Method::POST, Corps::Formulaire(formulaire), None).await?;
    let acces = r.corps.get("access_token").and_then(Value::as_str).filter(|_| r.ok()).ok_or_else(|| erreur_jeton(&r))?;
    let renouvellement = r.corps.get("refresh_token").and_then(Value::as_str).or(ancien).unwrap_or("").to_string();
    Ok(JetonsMs { acces: acces.into(), renouvellement })
}

// ---------- 2. Xbox Live, XSTS, Minecraft ----------

fn erreur_xsts(xerr: Option<u64>) -> Erreur {
    let cle = match xerr {
        Some(2148916227) => Some("microsoft.ce_compte_est_banni_du"),
        Some(2148916233) => Some("microsoft.ce_compte_microsoft_pas_encore"),
        Some(2148916235) => Some("microsoft.le_xbox_live_est_pas"),
        Some(2148916236 | 2148916237) => Some("microsoft.une_verification_de_age_est"),
        Some(2148916238) => Some("microsoft.est_un_compte_enfant_un"),
        _ => None,
    };
    let message =
        cle.map(t).unwrap_or_else(|| tv("microsoft.acces_xbox_refuse_code", &[("xerr", &xerr.map_or("401".into(), |x| x.to_string()))]));
    erreur(message, "XSTS")
}

async fn minecraft_depuis_microsoft(reseau: &Reseau, points: &Points, ms: JetonsMs, redirect: &str) -> Resultat<SessionMs> {
    let corps = json!({
        "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={}", ms.acces) },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT",
    });
    let xbl = appeler(reseau, &points.xbl, Method::POST, Corps::Json(corps), None).await?;
    let jeton_xbl = xbl.corps.get("Token").and_then(Value::as_str).filter(|_| xbl.ok());
    let jeton_xbl =
        jeton_xbl.ok_or_else(|| erreur(tv("microsoft.connexion_xbox_live_refusee", &[("status", &xbl.statut.to_string())]), "XBL"))?;
    let hash_xbl = xbl.corps.pointer("/DisplayClaims/xui/0/uhs").and_then(Value::as_str).map(String::from);

    let corps = json!({ "Properties": { "SandboxId": "RETAIL", "UserTokens": [jeton_xbl] }, "RelyingParty": "rp://api.minecraftservices.com/", "TokenType": "JWT" });
    let x = appeler(reseau, &points.xsts, Method::POST, Corps::Json(corps), None).await?;
    if x.statut == 401 {
        return Err(erreur_xsts(x.corps.get("XErr").and_then(Value::as_u64)));
    }
    let jeton_xsts = x.corps.get("Token").and_then(Value::as_str).filter(|_| x.ok());
    let jeton_xsts =
        jeton_xsts.ok_or_else(|| erreur(tv("microsoft.autorisation_xbox_refusee", &[("status", &x.statut.to_string())]), "XSTS"))?;
    let hash = x.corps.pointer("/DisplayClaims/xui/0/uhs").and_then(Value::as_str).map(String::from).or(hash_xbl).unwrap_or_default();
    let xuid = x.corps.pointer("/DisplayClaims/xui/0/xid").and_then(Value::as_str).unwrap_or("0").to_string();

    let corps = json!({ "identityToken": format!("XBL3.0 x={hash};{jeton_xsts}") });
    let mc = appeler(reseau, &format!("{}/authentication/login_with_xbox", points.mc), Method::POST, Corps::Json(corps), None).await?;
    match mc.statut {
        403 => return Err(erreur(t("microsoft.mojang_pas_encore_approuve_application"), "APP_NOT_APPROVED")),
        429 => return Err(erreur(t("microsoft.trop_de_connexions_en_peu"), "RATE_LIMIT")),
        _ => {}
    }
    let jeton_mc = mc.corps.get("access_token").and_then(Value::as_str).filter(|_| mc.ok());
    let jeton_mc =
        jeton_mc.ok_or_else(|| erreur(tv("microsoft.connexion_minecraft_refusee", &[("status", &mc.statut.to_string())]), "MC_LOGIN"))?;
    let expire = crate::base::maintenant() + mc.corps.get("expires_in").and_then(Value::as_i64).unwrap_or(86400) * 1000;

    let p = appeler(reseau, &format!("{}/minecraft/profile", points.mc), Method::GET, Corps::Rien, Some(jeton_mc)).await?;
    if p.statut == 404 {
        return Err(erreur(t("microsoft.ce_compte_ne_possede_pas"), "NOT_OWNED"));
    }
    let uuid = p.corps.get("id").and_then(Value::as_str).filter(|_| p.ok());
    let uuid = uuid.ok_or_else(|| erreur(tv("microsoft.profil_minecraft_introuvable", &[("status", &p.statut.to_string())]), "PROFILE"))?;
    Ok(SessionMs {
        name: p.corps.get("name").and_then(Value::as_str).unwrap_or("").into(),
        uuid: uuid.into(),
        xuid,
        refresh_token: ms.renouvellement,
        access_token: jeton_mc.into(),
        expires_at: expire,
        redirect: redirect.into(),
    })
}

/// Première connexion, après la page Microsoft. La session porte « loopback » (navigateur) ou « native ».
pub async fn se_connecter(
    reseau: &Reseau,
    points: &Points,
    client: &str,
    code: &str,
    verificateur: &str,
    redirect_uri: &str,
) -> Resultat<SessionMs> {
    let local = redirect_uri == REDIRECT_LOCAL || redirect_uri.starts_with(&format!("{REDIRECT_LOCAL}:"));
    let formulaire = vec![
        ("client_id", client.to_string()),
        ("grant_type", "authorization_code".into()),
        ("code", code.into()),
        ("redirect_uri", redirect_uri.into()),
        ("code_verifier", verificateur.into()),
        ("scope", SCOPE.into()),
    ];
    let ms = jeton_ms(reseau, points, formulaire, None).await?;
    minecraft_depuis_microsoft(reseau, points, ms, if local { "loopback" } else { "native" }).await
}

/// Renouvellement silencieux, avec la même sorte d'adresse de retour que la connexion du compte.
pub async fn renouveler(reseau: &Reseau, points: &Points, client: &str, renouvellement: &str, redirect: &str) -> Resultat<SessionMs> {
    let genre = if redirect == "loopback" { "loopback" } else { "native" };
    let formulaire = vec![
        ("client_id", client.to_string()),
        ("grant_type", "refresh_token".into()),
        ("refresh_token", renouvellement.into()),
        ("redirect_uri", redirect_pour(genre).into()),
        ("scope", SCOPE.into()),
    ];
    let ms = jeton_ms(reseau, points, formulaire, Some(renouvellement)).await?;
    minecraft_depuis_microsoft(reseau, points, ms, genre).await
}

// ---------- 3. Skins et capes (avec un jeton Minecraft) ----------

/// Toutes ces routes renvoient le profil complet : skins, capes et leur état.
async fn appel_profil(
    reseau: &Reseau,
    points: &Points,
    chemin: &str,
    quoi: &str,
    methode: Method,
    corps: Corps,
    jeton: &str,
) -> Resultat<Value> {
    let r = appeler(reseau, &format!("{}{chemin}", points.mc), methode, corps, Some(jeton)).await?;
    match r.statut {
        401 => Err(erreur(t("microsoft.la_session_minecraft_expire"), "UNAUTHORIZED")),
        429 => {
            Err(Erreur { attendre_ms: Some(r.attendre_s * 1000), ..erreur(t("microsoft.mojang_limite_les_changements_de"), "RATE_LIMIT") })
        }
        403 => Err(erreur(tv("microsoft.mojang_refuse_de_compte_suspendu", &[("what", quoi)]), "FORBIDDEN")),
        404 => Err(erreur(t("microsoft.ce_compte_pas_de_profil"), "NOT_OWNED")),
        s if !(200..300).contains(&s) => {
            let raison = r
                .corps
                .get("errorMessage")
                .or_else(|| r.corps.pointer("/details/status"))
                .map(|v| v.as_str().map_or(v.to_string(), String::from));
            Err(erreur(
                tv("microsoft.mojang_refuse_de", &[("what", quoi), ("reason", &raison.unwrap_or_else(|| s.to_string()))]),
                "SKIN_REJECTED",
            ))
        }
        _ => Ok(r.corps),
    }
}

pub async fn profil_complet(reseau: &Reseau, points: &Points, jeton: &str) -> Resultat<Value> {
    appel_profil(reseau, points, "/minecraft/profile", &t("microsoft.lire_le_profil"), Method::GET, Corps::Rien, jeton).await
}

pub async fn envoyer_skin(reseau: &Reseau, points: &Points, jeton: &str, png: &[u8], variante: &str) -> Resultat<Value> {
    let frontiere = format!("----0rzxn{}", nouvel_etat().replace(['-', '_'], "x"));
    let mut corps = format!("--{frontiere}\r\nContent-Disposition: form-data; name=\"variant\"\r\n\r\n{variante}\r\n").into_bytes();
    corps.extend(
        format!("--{frontiere}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\nContent-Type: image/png\r\n\r\n")
            .as_bytes(),
    );
    corps.extend_from_slice(png);
    corps.extend(format!("\r\n--{frontiere}--\r\n").as_bytes());
    let genre = format!("multipart/form-data; boundary={frontiere}");
    appel_profil(
        reseau,
        points,
        "/minecraft/profile/skins",
        &t("microsoft.changer_le_skin"),
        Method::POST,
        Corps::Multipart(genre, corps),
        jeton,
    )
    .await
}

pub async fn skin_par_defaut(reseau: &Reseau, points: &Points, jeton: &str) -> Resultat<Value> {
    appel_profil(
        reseau,
        points,
        "/minecraft/profile/skins/active",
        &t("microsoft.remettre_le_skin_par_defaut"),
        Method::DELETE,
        Corps::Rien,
        jeton,
    )
    .await
}

pub async fn montrer_cape(reseau: &Reseau, points: &Points, jeton: &str, cape: &str) -> Resultat<Value> {
    let corps = Corps::Json(json!({ "capeId": cape }));
    appel_profil(reseau, points, "/minecraft/profile/capes/active", &t("microsoft.changer_la_cape"), Method::PUT, corps, jeton).await
}

pub async fn masquer_cape(reseau: &Reseau, points: &Points, jeton: &str) -> Resultat<Value> {
    appel_profil(reseau, points, "/minecraft/profile/capes/active", &t("microsoft.masquer_la_cape"), Method::DELETE, Corps::Rien, jeton)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::essai_http::{Reponse, servir};
    use std::sync::{Arc, Mutex};

    fn reseau() -> Reseau {
        let r = Reseau::new();
        r.pour_essais(&["127.0.0.1"], 1);
        r
    }

    #[test]
    fn adresse_d_autorisation_pkce_et_etat() {
        let p = Points::default();
        let a = autorisation(&p, "client", "http://localhost:53817", nouvel_etat());
        let q = parametres(&a.url);
        let v = |n: &str| q.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(v("redirect_uri"), "http://localhost:53817");
        assert_eq!(v("code_challenge_method"), "S256");
        assert_eq!(v("code_challenge"), B64URL.encode(sha2::Sha256::digest(a.verificateur.as_bytes())));
        assert_eq!(v("state"), a.etat);
        assert_eq!(v("scope"), SCOPE);
        assert!(a.verificateur.len() >= 43);
        assert_ne!(nouvel_etat(), nouvel_etat());
    }

    #[test]
    fn retours_de_connexion() {
        let p = |s: &str| parametres(&format!("http://localhost/?{s}"));
        assert_eq!(lire_retour(&p("code=abc&state=e"), "e").unwrap(), "abc");
        assert_eq!(lire_retour(&p("error=access_denied&state=e"), "e").unwrap_err().code, Some("DENIED"));
        assert_eq!(lire_retour(&p("code=abc&state=autre"), "e").unwrap_err().code, Some("STATE"));
        assert_eq!(lire_retour(&p("state=e"), "e").unwrap_err().code, Some("NO_CODE"));
        assert!(lire_retour(&p("error=server_error&error_description=panne"), "e").unwrap_err().message.contains("panne"));
        assert!(lire_redirection("https://exemple.org/?code=1", "e").is_none());
        assert_eq!(lire_redirection(&format!("{REDIRECT_NATIF}?code=1&state=e"), "e").unwrap().unwrap(), "1");
    }

    #[tokio::test]
    async fn meme_adresse_de_retour_que_la_connexion() {
        let formulaires = Arc::new(Mutex::new(vec![]));
        let f = formulaires.clone();
        let serveur = servir(move |_, r| {
            f.lock().unwrap().push(r.corps.clone());
            Reponse::simple(400, r#"{"error":"invalid_grant"}"#)
        })
        .await;
        let points = Points { oauth: serveur.base.clone(), ..Points::default() };
        let r = reseau();
        assert_eq!(renouveler(&r, &points, "client", "r1", "loopback").await.unwrap_err().code, Some("EXPIRED"));
        assert_eq!(renouveler(&r, &points, "client", "r2", "native").await.unwrap_err().code, Some("EXPIRED"));
        assert_eq!(se_connecter(&r, &points, "client", "code", "v", "http://localhost:5000").await.unwrap_err().code, Some("EXPIRED"));
        let f = formulaires.lock().unwrap();
        let champ = |i: usize, n: &str| {
            parametres(&format!("http://x/?{}", String::from_utf8_lossy(&f[i]))).into_iter().find(|(k, _)| k == n).unwrap().1
        };
        assert_eq!(champ(0, "redirect_uri"), "http://localhost");
        assert_eq!(champ(1, "redirect_uri"), REDIRECT_NATIF);
        assert_eq!((champ(2, "redirect_uri").as_str(), champ(2, "grant_type").as_str()), ("http://localhost:5000", "authorization_code"));
    }

    #[tokio::test]
    async fn chaine_complete_jusqu_au_profil() {
        let serveur = servir(|_, r| match r.chemin.as_str() {
            "/token" => Reponse::simple(200, r#"{"access_token":"ms","refresh_token":"rt"}"#),
            "/xbl" => Reponse::simple(200, r#"{"Token":"xbl","DisplayClaims":{"xui":[{"uhs":"h"}]}}"#),
            "/xsts" => Reponse::simple(200, r#"{"Token":"xsts","DisplayClaims":{"xui":[{"uhs":"h","xid":"77"}]}}"#),
            "/authentication/login_with_xbox" => Reponse::simple(200, r#"{"access_token":"mc","expires_in":3600}"#),
            "/minecraft/profile" => Reponse::simple(200, r#"{"id":"abcd","name":"Steve_42"}"#),
            _ => Reponse::simple(404, ""),
        })
        .await;
        let b = serveur.base.clone();
        let points = Points { oauth: b.clone(), xbl: format!("{b}/xbl"), xsts: format!("{b}/xsts"), mc: b };
        let s = se_connecter(&reseau(), &points, "c", "code", "v", "http://localhost:4242").await.unwrap();
        assert_eq!((s.name.as_str(), s.uuid.as_str(), s.xuid.as_str(), s.redirect.as_str()), ("Steve_42", "abcd", "77", "loopback"));
        assert_eq!((s.access_token.as_str(), s.refresh_token.as_str()), ("mc", "rt"));
        assert!(s.expires_at > crate::base::maintenant() + 3_500_000);
        let methodes: Vec<String> = serveur.requetes().into_iter().map(|r| r.methode).collect();
        assert_eq!(methodes, ["POST", "POST", "POST", "POST", "GET"]);
        let corps = serveur.requetes().into_iter().find(|r| r.chemin == "/authentication/login_with_xbox").unwrap().corps;
        assert_eq!(serde_json::from_slice::<Value>(&corps).unwrap()["identityToken"], "XBL3.0 x=h;xsts");
    }

    #[tokio::test]
    async fn refus_xsts_et_jeu_non_possede() {
        let serveur = servir(|_, r| match r.chemin.as_str() {
            "/xsts" => Reponse::simple(401, r#"{"XErr":2148916238}"#),
            _ => Reponse::simple(404, ""),
        })
        .await;
        let b = serveur.base.clone();
        let points = Points { oauth: b.clone(), xbl: format!("{b}/xbl"), xsts: format!("{b}/xsts"), mc: b };
        let r = reseau();
        let ms = || JetonsMs { acces: "a".into(), renouvellement: "r".into() };
        // XBL renvoie 404 ici : refus Xbox Live.
        assert_eq!(minecraft_depuis_microsoft(&r, &points, ms(), "native").await.unwrap_err().code, Some("XBL"));
        assert_eq!(erreur_xsts(Some(2148916233)).code, Some("XSTS"));
        assert_eq!(profil_complet(&r, &points, "j").await.unwrap_err().code, Some("NOT_OWNED"));
    }
}
