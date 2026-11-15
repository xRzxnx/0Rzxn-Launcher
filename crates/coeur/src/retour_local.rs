//! Adresse de retour locale de la connexion Microsoft dans le navigateur (RFC 8252), comme core/loopback.js et
//! core/login-page.js. Un petit serveur écoute sur 127.0.0.1 et ::1 (même port) ; seule « GET / » avec un code ou une
//! erreur et le bon « state » est prise, tout le reste reçoit 404. La page du navigateur attend le vrai résultat de la
//! connexion (30 s au plus), puis le serveur se ferme. Sans réponse au bout de 10 minutes, la connexion est annulée.

use crate::erreur::{Erreur, Resultat};
use crate::i18n::{langue, t, tv};
use crate::microsoft::{REDIRECT_LOCAL, lire_retour};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub const ATTENTE: Duration = Duration::from_secs(10 * 60);
pub const GARDE: Duration = Duration::from_secs(30);

/// Politique de sécurité de la page (aussi envoyée en en-tête).
pub const CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/// Issue montrée dans le navigateur.
#[derive(Debug, Clone, PartialEq)]
pub enum Issue {
    Reussie(String),
    Echec { code: Option<String>, message: String },
    EnAttente,
}

pub fn echapper(texte: &str) -> String {
    texte.chars().fold(String::new(), |mut s, c| {
        match c {
            '&' => s.push_str("&amp;"),
            '<' => s.push_str("&lt;"),
            '>' => s.push_str("&gt;"),
            '"' => s.push_str("&quot;"),
            '\'' => s.push_str("&#39;"),
            c => s.push(c),
        }
        s
    })
}

const LOGO: &str = r##"<svg width="17" height="17" viewBox="0 0 256 256" aria-hidden="true"><path fill="#fff" fill-rule="evenodd" d="M68 34H182L218 70V98L182 134H169L225 190H180L140 150V190H68L32 154V70ZM140 66V102H172L186 88V80L172 66ZM108 66H81L64 83V141L81 158H108Z"/></svg>"##;
const ICONE_OK: &str = r#"<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>"#;
const ICONE_KO: &str = r#"<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>"#;
const ICONE_ATTENTE: &str = r#"<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>"#;

const STYLE: &str = r#"
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:#fff;
background:radial-gradient(1000px 600px at 30% 10%,#3b2a74 0%,rgba(59,42,116,0) 60%),radial-gradient(900px 600px at 80% 90%,#25407a 0%,rgba(37,64,122,0) 60%),#140c22}
main{width:min(540px,100%);border-radius:24px;background:rgba(30,22,58,.7);border:1px solid rgba(255,255,255,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 24px 60px rgba(8,5,20,.5);padding:34px 36px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;color:#ebeaf6}
.logo{width:28px;height:28px;border-radius:8px;background:#6d4ff0;display:flex;align-items:center;justify-content:center}
.mark{width:64px;height:64px;border-radius:20px;display:flex;align-items:center;justify-content:center;margin-top:6px}
.ok .mark{background:rgba(61,220,132,.2);color:#8df0b6}
.ko .mark{background:rgba(255,120,120,.2);color:#ffb3b3}
.wait .mark{background:rgba(168,146,255,.2);color:#d6cbff}
h1{margin:0;font-size:30px;line-height:36px;font-weight:700;letter-spacing:-.01em}
p{margin:0;font-size:15px;line-height:22px;color:#ebeaf6;max-width:440px}
.who{font-size:16px}.who b{color:#fff}
.next{font-size:14px;line-height:20px;color:#fff;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 14px}
.small{font-size:12.5px;line-height:18px;color:#c9c8dc}
.code{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#c9c8dc}
"#;

/// Page HTML complète, sans script ni ressource externe.
pub fn page(issue: &Issue) -> String {
    let e = |cle: &str| echapper(&t(cle));
    let (ton, icone, titre, corps) = match issue {
        Issue::Reussie(nom) => {
            // Le pseudo est mis en gras : la phrase traduite est échappée, puis le marqueur remplacé.
            let qui = echapper(&tv("login_page.connecte_en_tant_que", &[("name", "\u{0}")]))
                .replace('\u{0}', &format!("<b>{}</b>", echapper(nom)));
            let corps = format!(
                r#"<p class="who">{qui}</p><p>{}</p><p class="small">{}</p>"#,
                e("login_page.tu_peux_fermer_cet_onglet"),
                e("login_page.le_launcher_ne_voit_jamais")
            );
            ("ok", ICONE_OK, t("login_page.connexion_reussie"), corps)
        }
        Issue::EnAttente => {
            let corps = format!(
                r#"<p>{}</p><p class="next">{}</p>"#,
                e("login_page.la_connexion_continue_dans_le"),
                e("login_page.tu_peux_fermer_cet_onglet_court")
            );
            ("wait", ICONE_ATTENTE, t("login_page.retourne_au_launcher"), corps)
        }
        Issue::Echec { code, message } => {
            let (titre, texte, suite) = match code.as_deref() {
                Some("DENIED") => {
                    (t("login_page.connexion_refusee"), t("login_page.tu_as_refuse_acces"), t("login_page.ferme_cet_onglet_tu_peux"))
                }
                Some("NOT_OWNED") => (
                    t("login_page.ce_compte_ne_possede_pas"),
                    t("login_page.la_connexion_microsoft_a_reussi"),
                    t("login_page.ferme_cet_onglet_et_reconnecte"),
                ),
                Some("STATE") => (
                    t("login_page.reponse_de_connexion_inattendue"),
                    t("login_page.cette_reponse_ne_correspond_pas"),
                    t("login_page.ferme_cet_onglet_et_relance"),
                ),
                _ => (t("login_page.connexion_impossible"), message.clone(), t("login_page.ferme_cet_onglet_et_reessaie")),
            };
            let code = code.as_ref().map(|c| format!(r#"<p class="code">{}</p>"#, echapper(c))).unwrap_or_default();
            ("ko", ICONE_KO, titre, format!(r#"<p>{}</p><p class="next">{}</p>{code}"#, echapper(&texte), echapper(&suite)))
        }
    };
    let titre = echapper(&titre);
    format!(
        r#"<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{CSP}">
<meta name="referrer" content="no-referrer">
<title>{titre} · 0Rzxn_ Launcher</title>
<style>{STYLE}</style>
</head>
<body>
<main class="{ton}" aria-labelledby="title">
<span class="brand"><span class="logo">{LOGO}</span>0Rzxn_ Launcher</span>
<span class="mark">{icone}</span>
<h1 id="title">{titre}</h1>
{corps}
</main>
</body>
</html>
"#,
        lang = echapper(langue())
    )
}

async fn ecrire_page(mut flux: TcpStream, statut: u16, issue: &Issue) {
    let corps = page(issue);
    let texte = if statut == 200 { "OK" } else { "Bad Request" };
    let tete = format!(
        "HTTP/1.1 {statut} {texte}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: {CSP}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        corps.len()
    );
    let _ = flux.write_all(tete.as_bytes()).await;
    let _ = flux.write_all(corps.as_bytes()).await;
    let _ = flux.shutdown().await;
}

async fn introuvable(mut flux: TcpStream) {
    let _ = flux
        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Type: text/plain; charset=utf-8\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\nContent-Length: 9\r\n\r\nNot found")
        .await;
    let _ = flux.shutdown().await;
}

#[derive(Default)]
struct Interne {
    recu: bool,
    tenue: Option<TcpStream>,
    resultat: Option<oneshot::Sender<Resultat<String>>>,
}

pub struct RetourLocal {
    pub port: u16,
    pub redirect_uri: String,
    attente: Mutex<Option<oneshot::Receiver<Resultat<String>>>>,
    interne: Arc<Mutex<Interne>>,
    fin: CancellationToken,
}

fn annulee() -> Erreur {
    Erreur::code(t("microsoft.connexion_annulee"), "CANCELLED")
}

impl RetourLocal {
    /// Ouvre l'adresse de retour : 127.0.0.1 sur un port libre, puis ::1 sur le même port si IPv6 existe.
    pub async fn ouvrir(etat: &str, attente: Duration, garde: Duration) -> Resultat<Self> {
        let mut ecoutes = vec![];
        for _ in 0..5 {
            let v4 =
                TcpListener::bind("127.0.0.1:0").await.map_err(|_| Erreur::code(t("microsoft.adresse_locale_indisponible"), "LOOPBACK"))?;
            let port = v4.local_addr().map(|a| a.port()).unwrap_or(0);
            match TcpListener::bind(("::1", port)).await {
                Ok(v6) => ecoutes = vec![v4, v6],
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
                Err(_) => ecoutes = vec![v4],
            }
            break;
        }
        let Some(port) = ecoutes.first().and_then(|e| e.local_addr().ok()).map(|a| a.port()) else {
            return Err(Erreur::code(t("microsoft.adresse_locale_indisponible"), "LOOPBACK"));
        };
        let (tx, rx) = oneshot::channel();
        let interne = Arc::new(Mutex::new(Interne { resultat: Some(tx), ..Default::default() }));
        let fin = CancellationToken::new();
        for ecoute in ecoutes {
            let (interne, fin, etat) = (interne.clone(), fin.clone(), etat.to_string());
            tokio::spawn(async move {
                loop {
                    let flux = tokio::select! {
                        r = ecoute.accept() => match r { Ok((f, _)) => f, Err(_) => continue },
                        _ = fin.cancelled() => return,
                    };
                    let (interne, fin, etat) = (interne.clone(), fin.clone(), etat.clone());
                    tokio::spawn(async move { recevoir(flux, port, &etat, interne, fin, garde).await });
                }
            });
        }
        // Sans réponse au bout du délai : la connexion est annulée et le serveur fermé.
        let (i, f) = (interne.clone(), fin.clone());
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep(attente) => {
                    if let Some(tx) = i.lock().unwrap_or_else(|e| e.into_inner()).resultat.take() {
                        let _ = tx.send(Err(Erreur::code(t("microsoft.aucune_reponse_du_navigateur"), "TIMEOUT")));
                        f.cancel();
                    }
                }
                _ = f.cancelled() => {}
            }
        });
        Ok(Self { port, redirect_uri: format!("{REDIRECT_LOCAL}:{port}"), attente: Mutex::new(Some(rx)), interne, fin })
    }

    /// Code renvoyé par Microsoft (une seule fois).
    pub async fn attendre(&self) -> Resultat<String> {
        let rx = self.attente.lock().unwrap_or_else(|e| e.into_inner()).take();
        match rx {
            Some(rx) => rx.await.unwrap_or_else(|_| Err(annulee())),
            None => Err(annulee()),
        }
    }

    /// Écrit la page de fin dans le navigateur (s'il attend encore) et ferme le serveur.
    pub async fn repondre(&self, issue: Issue) {
        let tenue = self.interne.lock().unwrap_or_else(|e| e.into_inner()).tenue.take();
        if let Some(f) = tenue {
            ecrire_page(f, 200, &issue).await;
        }
        self.fin.cancel();
    }

    /// Annule : la connexion en attente échoue (CANCELLED) et le serveur se ferme.
    pub async fn fermer(&self) {
        let (tx, tenue) = {
            let mut i = self.interne.lock().unwrap_or_else(|e| e.into_inner());
            (i.resultat.take(), i.tenue.take())
        };
        if let Some(tx) = tx {
            let _ = tx.send(Err(annulee()));
        }
        if let Some(f) = tenue {
            ecrire_page(f, 200, &Issue::EnAttente).await;
        }
        self.fin.cancel();
    }
}

async fn recevoir(mut flux: TcpStream, port: u16, etat: &str, interne: Arc<Mutex<Interne>>, fin: CancellationToken, garde: Duration) {
    let mut tampon = vec![];
    let mut b = [0u8; 2048];
    while !tampon.windows(4).any(|w| w == b"\r\n\r\n") && tampon.len() < 16 * 1024 {
        match tokio::time::timeout(Duration::from_secs(10), flux.read(&mut b)).await {
            Ok(Ok(n)) if n > 0 => tampon.extend_from_slice(&b[..n]),
            _ => return,
        }
    }
    let texte = String::from_utf8_lossy(&tampon).into_owned();
    let mut lignes = texte.split("\r\n");
    let premiere: Vec<&str> = lignes.next().unwrap_or("").split(' ').collect();
    let (methode, cible) = (premiere.first().copied().unwrap_or(""), premiere.get(1).copied().unwrap_or(""));
    let hote = lignes
        .find_map(|l| l.split_once(':').filter(|(n, _)| n.trim().eq_ignore_ascii_case("host")).map(|(_, v)| v.trim().to_lowercase()))
        .unwrap_or_default();
    let hote_ok = [format!("localhost:{port}"), format!("127.0.0.1:{port}"), format!("[::1]:{port}")].contains(&hote);
    let parametres = crate::microsoft::parametres(&format!("http://localhost{cible}"));
    let (chemin, _) = cible.split_once('?').unwrap_or((cible, ""));
    let a = |n: &str| parametres.iter().any(|(k, _)| k == n);
    if fin.is_cancelled() || methode != "GET" || chemin != "/" || !hote_ok || (!a("code") && !a("error")) {
        introuvable(flux).await;
        return;
    }
    // Réponse d'une autre connexion (vieil onglet) : refusée, on continue d'attendre la bonne.
    if parametres.iter().find(|(k, _)| k == "state").map(|(_, v)| v.as_str()) != Some(etat) {
        ecrire_page(flux, 400, &Issue::Echec { code: Some("STATE".into()), message: String::new() }).await;
        return;
    }
    let mut flux = Some(flux);
    let tx = {
        let mut i = interne.lock().unwrap_or_else(|e| e.into_inner());
        if i.recu {
            None
        } else {
            i.recu = true;
            i.tenue = flux.take();
            i.resultat.take()
        }
    };
    // Onglet rechargé après le retour : le résultat arrive dans le launcher.
    if let Some(f) = flux {
        ecrire_page(f, 200, &Issue::EnAttente).await;
        return;
    }
    if let Some(tx) = tx {
        let _ = tx.send(lire_retour(&parametres, etat));
    }
    // Vérification trop longue : la page invite à revenir au launcher.
    tokio::time::sleep(garde).await;
    let tenue = interne.lock().unwrap_or_else(|e| e.into_inner()).tenue.take();
    if let Some(f) = tenue {
        ecrire_page(f, 200, &Issue::EnAttente).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Requête GET brute ; renvoie (statut, corps).
    async fn get(adresse: &str, chemin: &str, hote: &str, methode: &str) -> std::io::Result<(u16, String, String)> {
        let mut f = TcpStream::connect(adresse).await?;
        f.write_all(format!("{methode} {chemin} HTTP/1.1\r\nHost: {hote}\r\nConnection: close\r\n\r\n").as_bytes()).await?;
        let mut r = String::new();
        f.read_to_string(&mut r).await?;
        let statut = r.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let (tete, corps) = r.split_once("\r\n\r\n").unwrap_or((&r, ""));
        Ok((statut, tete.to_string(), corps.to_string()))
    }

    async fn ouvrir() -> RetourLocal {
        RetourLocal::ouvrir("bon-etat", ATTENTE, GARDE).await.unwrap()
    }

    #[tokio::test]
    async fn le_code_revient_et_la_page_attend_le_resultat() {
        let r = ouvrir().await;
        assert_eq!(r.redirect_uri, format!("http://localhost:{}", r.port));
        let (port, adresse) = (r.port, format!("127.0.0.1:{}", r.port));
        let page = tokio::spawn(async move { get(&adresse, "/?code=abc&state=bon-etat", &format!("localhost:{port}"), "GET").await });
        assert_eq!(r.attendre().await.unwrap(), "abc");
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!page.is_finished());
        r.repondre(Issue::Reussie("Steve_42".into())).await;
        let (statut, tete, corps) = page.await.unwrap().unwrap();
        assert_eq!(statut, 200);
        assert!(tete.contains("text/html; charset=utf-8") && tete.contains("default-src 'none'") && tete.contains("no-referrer"));
        assert!(corps.contains("<b>Steve_42</b>"));
        assert!(!corps.contains("<script") && !corps.contains("http://") && !corps.contains("https://"));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(get(&format!("127.0.0.1:{port}"), "/?code=abc&state=bon-etat", &format!("localhost:{port}"), "GET").await.is_err());
    }

    #[tokio::test]
    async fn requetes_refusees_et_mauvais_etat() {
        let r = ouvrir().await;
        let (p, a) = (r.port, format!("127.0.0.1:{}", r.port));
        let h = format!("localhost:{p}");
        for (chemin, hote, methode) in [
            ("/favicon.ico", h.as_str(), "GET"),
            ("/autre?code=abc&state=bon-etat", h.as_str(), "GET"),
            ("/?code=abc&state=bon-etat", h.as_str(), "POST"),
            ("/?code=abc&state=bon-etat", &format!("evil.example:{p}"), "GET"),
            ("/?code=abc&state=bon-etat", "localhost:1", "GET"),
            ("/", h.as_str(), "GET"),
        ] {
            assert_eq!(get(&a, chemin, hote, methode).await.unwrap().0, 404, "{chemin} {hote} {methode}");
        }
        let (statut, _, corps) = get(&a, "/?code=vieux&state=autre", &h, "GET").await.unwrap();
        assert_eq!(statut, 400);
        assert!(corps.contains("STATE"));
        let a2 = a.clone();
        let page = tokio::spawn(async move { get(&a2, "/?code=ok&state=bon-etat", &format!("127.0.0.1:{p}"), "GET").await });
        assert_eq!(r.attendre().await.unwrap(), "ok");
        r.repondre(Issue::Reussie("A".into())).await;
        assert_eq!(page.await.unwrap().unwrap().0, 200);
    }

    #[tokio::test]
    async fn refus_microsoft_garde_et_delais() {
        let r = ouvrir().await;
        let a = format!("127.0.0.1:{}", r.port);
        let h = format!("localhost:{}", r.port);
        let (a2, h2) = (a.clone(), h.clone());
        let page = tokio::spawn(async move { get(&a2, "/?error=access_denied&error_description=refus&state=bon-etat", &h2, "GET").await });
        assert_eq!(r.attendre().await.unwrap_err().code, Some("DENIED"));
        r.repondre(Issue::Echec { code: Some("DENIED".into()), message: String::new() }).await;
        assert!(page.await.unwrap().unwrap().2.contains("DENIED"));

        // Vérification trop longue : « retourne au launcher », onglet rechargé idem.
        let r = RetourLocal::ouvrir("bon-etat", ATTENTE, Duration::from_millis(40)).await.unwrap();
        let (a, h) = (format!("127.0.0.1:{}", r.port), format!("localhost:{}", r.port));
        let (a2, h2) = (a.clone(), h.clone());
        let page = tokio::spawn(async move { get(&a2, "/?code=abc&state=bon-etat", &h2, "GET").await });
        r.attendre().await.unwrap();
        assert!(page.await.unwrap().unwrap().2.contains(r#"class="wait""#));
        assert!(get(&a, "/?code=abc&state=bon-etat", &h, "GET").await.unwrap().2.contains(r#"class="wait""#));
        r.repondre(Issue::Reussie("A".into())).await;

        let tard = RetourLocal::ouvrir("e", Duration::from_millis(30), GARDE).await.unwrap();
        assert_eq!(tard.attendre().await.unwrap_err().code, Some("TIMEOUT"));
        let annule = ouvrir().await;
        annule.fermer().await;
        assert_eq!(annule.attendre().await.unwrap_err().code, Some("CANCELLED"));
    }

    #[test]
    fn page_echappee_sans_script() {
        let ok = page(&Issue::Reussie("<img src=x>".into()));
        assert!(ok.contains("&lt;img src=x&gt;") && !ok.contains("<img"));
        assert!(ok.contains(&format!(r#"<html lang="{}">"#, langue())));
        let ko = page(&Issue::Echec { code: Some("XSTS_1".into()), message: "<b>non</b>".into() });
        assert!(ko.contains("&lt;b&gt;non&lt;/b&gt;") && ko.contains("XSTS_1"));
        for p in [ok, ko, page(&Issue::EnAttente)] {
            assert!(!p.contains("<script") && !p.contains("src=\"http") && !p.contains("href=\"http"));
        }
    }
}
