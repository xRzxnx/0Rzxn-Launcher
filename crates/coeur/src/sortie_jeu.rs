//! Lecture de la sortie du jeu, comme core/logs.js. Avec la configuration de logs de Mojang, Minecraft écrit des
//! événements XML (<log4j:Event>) : on les transforme en lignes lisibles.

use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

const DEBUT: &str = "<log4j:Event";
const FIN: &str = "</log4j:Event>";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LigneJeu {
    pub time: String,
    pub tag: String,
    pub msg: String,
    /// Ligne du launcher mise en avant (menu atteint).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub mark: bool,
}

impl LigneJeu {
    pub fn new(time: String, tag: impl Into<String>, msg: impl Into<String>) -> Self {
        Self { time, tag: tag.into(), msg: msg.into(), mark: false }
    }
}

/// Heure locale « HH:MM:SS ».
pub fn horloge() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

fn heure_de(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&chrono::Local).format("%H:%M:%S").to_string())
        .unwrap_or_else(horloge)
}

fn attribut<'a>(xml: &'a str, nom: &str) -> Option<&'a str> {
    let debut = xml.find(&format!("{nom}=\""))? + nom.len() + 2;
    let fin = xml[debut..].find('"')?;
    Some(&xml[debut..debut + fin])
}

fn cdata<'a>(xml: &'a str, balise: &str) -> Option<&'a str> {
    let ouverture = format!("<log4j:{balise}><![CDATA[");
    let debut = xml.find(&ouverture)? + ouverture.len();
    let fin = xml[debut..].find(&format!("]]></log4j:{balise}>"))?;
    Some(&xml[debut..debut + fin])
}

/// Découpe la sortie du jeu en lignes ; `tag_brut` sert aux lignes sans format connu.
pub struct LecteurSortie {
    tampon: String,
    tag_brut: &'static str,
}

impl LecteurSortie {
    pub fn new(tag_brut: &'static str) -> Self {
        Self { tampon: String::new(), tag_brut }
    }

    pub fn pousser(&mut self, morceau: &str, sortie: &mut Vec<LigneJeu>) {
        self.tampon.push_str(morceau);
        loop {
            let Some(debut) = self.tampon.find(DEBUT) else {
                if let Some(fin_ligne) = self.tampon.rfind('\n') {
                    let texte: String = self.tampon.drain(..=fin_ligne).collect();
                    self.brut(&texte[..texte.len() - 1], sortie);
                }
                return;
            };
            if debut > 0 {
                let texte: String = self.tampon.drain(..debut).collect();
                self.brut(&texte, sortie);
                continue;
            }
            let Some(fin) = self.tampon.find(FIN) else { return };
            let xml: String = self.tampon.drain(..fin + FIN.len()).collect();
            evenement(&xml, sortie);
        }
    }

    pub fn vider(&mut self, sortie: &mut Vec<LigneJeu>) {
        if !self.tampon.trim().is_empty() {
            let texte = std::mem::take(&mut self.tampon);
            self.brut(&texte, sortie);
        }
        self.tampon.clear();
    }

    fn brut(&self, texte: &str, sortie: &mut Vec<LigneJeu>) {
        // « [12:00:00] [Render thread/INFO]: message », ou avec le logger comme Forge : « … [minecraft/SoundEngine]: message ».
        static LIGNE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^\[(\d{2}:\d{2}:\d{2})\] \[([^\]]+)\](?: \[([^\]]+)\])?: ?(.*)$").unwrap());
        // Forge colore sa sortie (codes ANSI) et Java peut écrire « \r\r\n » sous Windows : on nettoie.
        static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new("\x1b\\[[0-9;]*m").unwrap());
        let propre = ANSI.replace_all(texte, "").replace('\r', "");
        for ligne in propre.split('\n').filter(|l| !l.trim().is_empty()) {
            sortie.push(match LIGNE.captures(ligne) {
                Some(c) => {
                    let msg = match c.get(3) {
                        Some(logger) => format!("[{}] {}", logger.as_str(), &c[4]),
                        None => c[4].to_string(),
                    };
                    LigneJeu::new(c[1].into(), &c[2], msg)
                }
                None => LigneJeu::new(horloge(), self.tag_brut, ligne),
            });
        }
    }
}

fn evenement(xml: &str, sortie: &mut Vec<LigneJeu>) {
    let time = attribut(xml, "timestamp").and_then(|t| t.parse().ok()).map(heure_de).unwrap_or_else(horloge);
    let tag = format!("{}/{}", attribut(xml, "thread").unwrap_or("main"), attribut(xml, "level").unwrap_or("INFO"));
    let texte: Vec<&str> = [cdata(xml, "Message"), cdata(xml, "Throwable")].into_iter().flatten().filter(|t| !t.is_empty()).collect();
    for msg in texte.join("\n").lines().filter(|l| !l.trim().is_empty()) {
        sortie.push(LigneJeu::new(time.clone(), &tag, msg));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lire(morceaux: &[&str]) -> Vec<(String, String)> {
        let mut l = LecteurSortie::new("sortie/INFO");
        let mut sortie = vec![];
        for m in morceaux {
            l.pousser(m, &mut sortie);
        }
        l.vider(&mut sortie);
        sortie.into_iter().map(|x| (x.tag, x.msg)).collect()
    }

    #[test]
    fn evenements_xml_coupes_en_morceaux() {
        let xml = r#"<log4j:Event logger="a" timestamp="1700000000000" level="WARN" thread="Render thread">
<log4j:Message><![CDATA[Bonjour]]></log4j:Message>
<log4j:Throwable><![CDATA[java.lang.Error: x
	at a.b(c)]]></log4j:Throwable>
</log4j:Event>
"#;
        let (a, b) = xml.split_at(40);
        let lignes = lire(&["avant\n", a, b]);
        assert_eq!(
            lignes,
            [
                ("sortie/INFO".into(), "avant".into()),
                ("Render thread/WARN".into(), "Bonjour".into()),
                ("Render thread/WARN".into(), "java.lang.Error: x".into()),
                ("Render thread/WARN".into(), "\tat a.b(c)".into()),
            ]
        );
    }

    #[test]
    fn lignes_simples_forge_et_ansi() {
        let lignes = lire(&[
            "[12:00:00] [Render thread/INFO]: Prêt\r\r\n",
            "\x1b[32m[12:00:01] [main/INFO] [minecraft/SoundEngine]: Sound engine started\x1b[m\n",
            "brut sans fin",
        ]);
        assert_eq!(
            lignes,
            [
                ("Render thread/INFO".into(), "Prêt".into()),
                ("main/INFO".into(), "[minecraft/SoundEngine] Sound engine started".into()),
                ("sortie/INFO".into(), "brut sans fin".into()),
            ]
        );
    }
}
