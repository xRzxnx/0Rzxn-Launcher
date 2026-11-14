//! Messages du moteur (erreurs montrées à l'interface, dialogues, zone de notification), comme src/main/i18n.
//! La langue est choisie au démarrage par l'app ; ce module ne connaît ni Tauri ni le système.

use commun::i18n::{Dictionnaire, format_nombre, langue_connue};
use std::sync::{LazyLock, RwLock};

fn source(lang: &str) -> &'static str {
    match lang {
        "fr" => include_str!("../locales/fr.json"),
        "es" => include_str!("../locales/es.json"),
        _ => include_str!("../locales/en.json"),
    }
}

/// Dictionnaire du moteur d'une langue (contrôle des traductions, tests).
pub fn dictionnaire(lang: &str) -> Dictionnaire {
    let lang = langue_connue(lang);
    Dictionnaire::depuis_json(lang, source(lang))
}

static DICT: LazyLock<RwLock<Dictionnaire>> = LazyLock::new(|| RwLock::new(dictionnaire("fr")));

pub fn choisir(lang: &str) {
    let mut d = DICT.write().unwrap_or_else(|e| e.into_inner());
    if d.lang() != langue_connue(lang) {
        *d = dictionnaire(lang);
    }
}

pub fn langue() -> &'static str {
    DICT.read().unwrap_or_else(|e| e.into_inner()).lang()
}

pub fn t(cle: &str) -> String {
    tv(cle, &[])
}

pub fn tv(cle: &str, vars: &[(&str, &str)]) -> String {
    DICT.read().unwrap_or_else(|e| e.into_inner()).t(cle, vars)
}

pub fn num(n: f64) -> String {
    format_nombre(langue(), n)
}

/// « 4 Go », « 4,5 Go ».
pub fn go(valeur: f64) -> String {
    format!("{} {}", num(valeur), t("unit.gb"))
}
