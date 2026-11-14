//! Traductions et formats de l'interface (portage de i18n.js, dom.js et data.js).

use commun::i18n::{Dictionnaire, choisir_langue, format_nombre};
use std::cell::RefCell;

thread_local! {
    static DICT: RefCell<Dictionnaire> = RefCell::new(Dictionnaire::charger(&langue_systeme("auto")));
}

/// Langue d'après la préférence du launcher, sinon celles du système (navigator.languages).
fn langue_systeme(pref: &str) -> String {
    let langues: Vec<String> =
        web_sys::window().map(|w| w.navigator().languages().iter().filter_map(|v| v.as_string()).collect()).unwrap_or_default();
    choisir_langue(pref, langues.iter().map(String::as_str)).to_string()
}

pub fn choisir(pref: &str) {
    let lang = langue_systeme(pref);
    DICT.with(|d| {
        if d.borrow().lang() != lang {
            *d.borrow_mut() = Dictionnaire::charger(&lang);
        }
    });
    if let Some(html) = web_sys::window().and_then(|w| w.document()).and_then(|d| d.document_element()) {
        let _ = html.set_attribute("lang", &lang);
    }
}

pub fn lang() -> &'static str {
    DICT.with(|d| d.borrow().lang())
}

pub fn t(cle: &str) -> String {
    DICT.with(|d| d.borrow().t(cle, &[]))
}

pub fn tv(cle: &str, vars: &[(&str, &str)]) -> String {
    DICT.with(|d| d.borrow().t(cle, vars))
}

pub fn num(n: f64) -> String {
    format_nombre(lang(), n)
}

/// JS Math.round : la moitié va vers +∞.
pub fn arrondi(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// « 4 Go », « 4,5 Go ».
pub fn format_go(valeur: f64) -> String {
    format!("{} {}", num(valeur), t("unit.gb"))
}

/// « 25 h 30 min », ou « jamais lancée ».
pub fn format_temps_de_jeu(minutes: f64) -> String {
    if minutes == 0.0 {
        return t("time.never_played");
    }
    let h = (minutes / 60.0).floor();
    let m = format!("{:0>2}", format!("{}", minutes % 60.0));
    if h > 0.0 { tv("dom.min", &[("h_", &format!("{h}")), ("m", &m)]) } else { format!("{} min", minutes % 60.0) }
}

/// Durée compacte des tuiles : « 25 h 30 », ou « 12 min » sous une heure.
pub fn format_court(minutes: f64) -> String {
    if minutes == 0.0 {
        return t("dom.min_2");
    }
    let total = arrondi(minutes);
    let heures = (total / 60.0).floor();
    if heures > 0.0 { format!("{heures} h {:02}", (total % 60.0) as u32) } else { format!("{total} min") }
}

/// Date au format de la langue (Intl.DateTimeFormat), par exemple { day: 'numeric', month: 'short' }.
pub fn format_date(ms: f64, champs: &[(&str, &str)]) -> String {
    let options = js_sys::Object::new();
    for (k, v) in champs {
        let _ = js_sys::Reflect::set(&options, &(*k).into(), &(*v).into());
    }
    let langues = js_sys::Array::of1(&lang().into());
    let format = js_sys::Intl::DateTimeFormat::new(&langues, &options);
    let date = js_sys::Date::new(&ms.into());
    format.format().call1(&format, &date).ok().and_then(|v| v.as_string()).unwrap_or_default()
}

const DATE_COMPLETE: [(&str, &str); 3] = [("day", "numeric"), ("month", "short"), ("year", "numeric")];

fn debut_du_jour(ms: f64) -> f64 {
    let d = js_sys::Date::new(&ms.into());
    js_sys::Date::new_with_year_month_day(d.get_full_year(), d.get_month() as i32, d.get_date() as i32).get_time()
}

/// Suite de « Dernière partie » : aujourd'hui, hier, il y a 3 jours…
pub fn format_derniere_partie(ms: Option<i64>) -> Option<String> {
    let ms = ms.filter(|&m| m > 0)? as f64;
    let jours = arrondi((debut_du_jour(js_sys::Date::now()) - debut_du_jour(ms)) / 86_400_000.0);
    Some(match jours {
        j if j <= 0.0 => t("played.today"),
        1.0 => t("played.yesterday"),
        j if j < 30.0 => tv("played.days_ago", &[("count", &j.to_string())]),
        _ => tv("played.on_date", &[("date", &format_date(ms, &DATE_COMPLETE))]),
    })
}

/// Clé « 2026-11-03 » d'un jour local décalé de `decalage` jours par rapport à aujourd'hui.
pub fn cle_du_jour(decalage: i32) -> String {
    let now = js_sys::Date::new_0();
    let d = js_sys::Date::new_with_year_month_day(now.get_full_year(), now.get_month() as i32, now.get_date() as i32 + decalage);
    format!("{}-{:02}-{:02}", d.get_full_year(), d.get_month() + 1, d.get_date())
}

/// Comparaison « naturelle » (1.21.11 après 1.21.2), comme localeCompare(…, { numeric: true }).
pub fn comparer_naturel(a: &str, b: &str) -> std::cmp::Ordering {
    fn morceaux(s: &str) -> Vec<(bool, String)> {
        let mut v: Vec<(bool, String)> = vec![];
        for c in s.chars() {
            let chiffre = c.is_ascii_digit();
            match v.last_mut() {
                Some((d, m)) if *d == chiffre => m.push(c),
                _ => v.push((chiffre, c.to_string())),
            }
        }
        v
    }
    let (ma, mb) = (morceaux(a), morceaux(b));
    for ((da, a), (db, b)) in ma.iter().zip(&mb) {
        let ordre = if *da && *db {
            a.trim_start_matches('0')
                .len()
                .cmp(&b.trim_start_matches('0').len())
                .then_with(|| a.trim_start_matches('0').cmp(b.trim_start_matches('0')))
        } else {
            a.to_lowercase().cmp(&b.to_lowercase())
        };
        if ordre.is_ne() {
            return ordre;
        }
    }
    ma.len().cmp(&mb.len())
}

/// Mémoire en octets → « 5,2 Go » (une décimale au plus).
pub fn format_memoire(octets: f64) -> String {
    format_go(arrondi(octets / 1024f64.powi(3) * 10.0) / 10.0)
}

/// « 1,4 s » : toujours une décimale.
pub fn format_secondes(ms: f64) -> String {
    let valeur = format!("{:.1}", ms / 1000.0);
    tv("home.secondes", &[("value", &if lang() == "en" { valeur } else { valeur.replace('.', ",") })])
}
