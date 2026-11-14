//! Traductions fr / en / es : mêmes clés et même format que les dictionnaires de l'interface Electron.
//! Variables {nom} ; une entrée { one, other } est un pluriel choisi selon `count`.

use serde::Deserialize;
use std::collections::HashMap;

pub const LANGUES: [&str; 3] = ["fr", "en", "es"];

#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum Entree {
    Texte(String),
    Pluriel { one: Option<String>, other: String },
}

pub struct Dictionnaire {
    lang: &'static str,
    entrees: HashMap<String, Entree>,
}

/// Langue retenue : la préférence si connue, sinon la première langue du système que le launcher parle, sinon l'anglais.
pub fn choisir_langue<'a>(pref: &str, systeme: impl IntoIterator<Item = &'a str>) -> &'static str {
    let base = |tag: &str| tag.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
    let connue = |code: String| LANGUES.into_iter().find(|l| *l == code);
    connue(base(pref)).or_else(|| systeme.into_iter().find_map(|tag| connue(base(tag)))).unwrap_or("en")
}

/// Langue connue la plus proche de `lang` (l'anglais par défaut).
pub fn langue_connue(lang: &str) -> &'static str {
    LANGUES.into_iter().find(|l| *l == lang).unwrap_or("en")
}

impl Dictionnaire {
    /// Dictionnaire de l'interface.
    pub fn charger(lang: &str) -> Self {
        let lang = langue_connue(lang);
        Self::depuis_json(
            lang,
            match lang {
                "fr" => include_str!("../locales/fr.json"),
                "es" => include_str!("../locales/es.json"),
                _ => include_str!("../locales/en.json"),
            },
        )
    }

    /// Dictionnaire à partir d'un JSON embarqué (celui du moteur vit dans coeur, pour ne pas alourdir l'interface).
    pub fn depuis_json(lang: &'static str, source: &str) -> Self {
        let entrees = serde_json::from_str(source).expect("embedded dictionary must be valid JSON");
        Self { lang, entrees }
    }

    /// Clés du dictionnaire (contrôle des traductions).
    pub fn cles(&self) -> impl Iterator<Item = &str> {
        self.entrees.keys().map(String::as_str)
    }

    /// Variables {nom} de chaque forme d'une entrée, triées (contrôle des traductions).
    pub fn variables(&self, cle: &str) -> Option<Vec<Vec<String>>> {
        let noms = |texte: &str| {
            let mut v: Vec<String> = texte.split('{').skip(1).filter_map(|m| m.split_once('}').map(|(n, _)| n.to_string())).collect();
            v.sort();
            v
        };
        Some(match self.entrees.get(cle)? {
            Entree::Texte(t) => vec![noms(t)],
            Entree::Pluriel { one, other } => vec![one.as_deref().map(noms).unwrap_or_default(), noms(other)],
        })
    }

    pub fn lang(&self) -> &'static str {
        self.lang
    }

    /// Texte de `cle` avec ses variables ; la clé elle-même si elle manque (comme l'interface Electron).
    pub fn t(&self, cle: &str, vars: &[(&str, &str)]) -> String {
        let Some(entree) = self.entrees.get(cle) else { return cle.to_string() };
        // count : choisit le pluriel et s'affiche au format de la langue, comme num() côté Electron.
        let n = vars.iter().find(|(k, _)| *k == "count").and_then(|(_, v)| v.parse::<f64>().ok());
        let texte = match (entree, n) {
            (Entree::Texte(texte), _) => texte,
            (Entree::Pluriel { one: Some(one), .. }, Some(n)) if singulier(self.lang, n) => one,
            (Entree::Pluriel { other, .. }, _) => other,
        };
        let compte = n.map(|n| format_nombre(self.lang, n));
        let vars: Vec<(&str, &str)> =
            vars.iter().map(|&(k, v)| if k == "count" { (k, compte.as_deref().unwrap_or(v)) } else { (k, v) }).collect();
        remplir(texte, &vars)
    }
}

fn remplir(texte: &str, vars: &[(&str, &str)]) -> String {
    let mut sortie = String::with_capacity(texte.len());
    let mut reste = texte;
    while let Some(debut) = reste.find('{') {
        sortie.push_str(&reste[..debut]);
        let apres = &reste[debut + 1..];
        let fin = apres.find('}').filter(|&f| f > 0 && apres[..f].chars().all(|c| c.is_alphanumeric() || c == '_'));
        match fin.and_then(|f| vars.iter().find(|(k, _)| *k == &apres[..f]).map(|(_, v)| (f, v))) {
            Some((f, v)) => {
                sortie.push_str(v);
                reste = &apres[f + 1..];
            }
            None => {
                sortie.push('{');
                reste = apres;
            }
        }
    }
    sortie.push_str(reste);
    sortie
}

/// Règles CLDR « one » : français 0 et 1 (partie entière), anglais et espagnol 1.
fn singulier(lang: &str, n: f64) -> bool {
    match lang {
        "fr" => n.trunc() == 0.0 || n.trunc() == 1.0,
        _ => n == 1.0,
    }
}

/// Entier groupé comme Intl.NumberFormat : « 12 345 » (fr, espace fine), « 12,345 » (en), « 12.345 » (es, pas sous 10 000).
pub fn format_nombre(lang: &str, n: f64) -> String {
    if n.fract() != 0.0 {
        let s = format!("{n}");
        return if lang == "en" { s } else { s.replace('.', ",") };
    }
    let chiffres = format!("{}", n.abs() as u64);
    let (sep, min) = match lang {
        "fr" => ('\u{202f}', 4),
        "es" => ('.', 5),
        _ => (',', 4),
    };
    let mut sortie = String::new();
    if chiffres.len() >= min {
        for (i, c) in chiffres.chars().enumerate() {
            if i > 0 && (chiffres.len() - i) % 3 == 0 {
                sortie.push(sep);
            }
            sortie.push(c);
        }
    } else {
        sortie = chiffres;
    }
    if n < 0.0 { format!("-{sortie}") } else { sortie }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn langue() {
        assert_eq!(choisir_langue("auto", ["de-DE", "fr-CA"]), "fr");
        assert_eq!(choisir_langue("es", ["fr-FR"]), "es");
        assert_eq!(choisir_langue("auto", ["de-DE"]), "en");
    }

    #[test]
    fn textes_et_pluriels() {
        let fr = Dictionnaire::charger("fr");
        assert_eq!(fr.t("actions.bienvenue", &[("name", "Rz")]), "Bienvenue, Rz");
        assert_eq!(fr.t("cle.absente", &[]), "cle.absente");
        assert_eq!(fr.t("actions.bienvenue", &[]), "Bienvenue, {name}");
        let en = Dictionnaire::charger("en");
        let cle = en.entrees.iter().find(|(_, e)| matches!(e, Entree::Pluriel { one: Some(_), .. })).unwrap().0.clone();
        let (un, deux) = (en.t(&cle, &[("count", "1")]), en.t(&cle, &[("count", "12345")]));
        assert_ne!(un, deux);
        assert!(deux.contains("12,345"), "{deux}");
    }

    #[test]
    fn nombres() {
        assert_eq!(format_nombre("fr", 12345.0), "12\u{202f}345");
        assert_eq!(format_nombre("en", 1234.0), "1,234");
        assert_eq!(format_nombre("es", 1234.0), "1234");
        assert_eq!(format_nombre("es", 12345.0), "12.345");
        assert_eq!(format_nombre("fr", 1.5), "1,5");
    }

    #[test]
    fn memes_cles_dans_les_trois_langues() {
        let cles = |l| {
            let mut c: Vec<String> = Dictionnaire::charger(l).entrees.into_keys().collect();
            c.sort();
            c
        };
        assert_eq!(cles("fr"), cles("en"));
        assert_eq!(cles("fr"), cles("es"));
    }
}
