//! Contrôle des traductions (scripts/check-i18n.js, côté Rust) : `cargo test` refuse les clés inconnues, les clés
//! qui manquent dans une langue ou ont d'autres variables, et tout texte français resté dans le code (hors
//! commentaires et tests, qui restent en français).

use commun::i18n::Dictionnaire;
use std::path::{Path, PathBuf};

const LANGUES: [&str; 3] = ["fr", "en", "es"];
const ACCENTS: &str = "àâçéèêëîïôöùûœ«»’ÀÂÇÉÈÊËÎÏÔÖÙÛŒ";

fn racine() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn sources(dossier: &Path, sortie: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dossier).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            sources(&p, sortie);
        } else if p.extension().is_some_and(|x| x == "rs") {
            sortie.push(p);
        }
    }
}

/// Code d'un fichier sans commentaires ni module de tests, ligne par ligne (numéro, texte).
fn code(fichier: &Path) -> Vec<(usize, String)> {
    let texte = std::fs::read_to_string(fichier).unwrap();
    let mut lignes = vec![];
    for (i, l) in texte.lines().enumerate() {
        let t = l.trim_start();
        if t.starts_with("#[cfg(test)]") {
            break; // les tests sont toujours en fin de fichier
        }
        if t.starts_with("//") {
            continue;
        }
        let sans_fin = l.find(" // ").map_or(l, |p| &l[..p]);
        lignes.push((i + 1, sans_fin.to_string()));
    }
    lignes
}

/// Clés passées à t("…"), tv("…" ou i18n::t("…") dans un texte de code.
fn cles_utilisees(texte: &str) -> Vec<String> {
    let mut cles = vec![];
    for appel in ["t(\"", "tv(\""] {
        let mut reste = texte;
        while let Some(p) = reste.find(appel) {
            let avant = reste[..p].chars().last();
            reste = &reste[p + appel.len()..];
            if avant.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue; // une autre fonction qui finit par t(
            }
            if let Some(fin) = reste.find('"') {
                let cle = &reste[..fin];
                if cle.contains('.') && cle.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') {
                    cles.push(cle.to_string());
                }
            }
        }
    }
    cles
}

fn verifier_dictionnaires(nom: &str, charger: impl Fn(&str) -> Dictionnaire, erreurs: &mut Vec<String>) -> Vec<String> {
    let dicts: Vec<Dictionnaire> = LANGUES.iter().map(|l| charger(l)).collect();
    let mut cles: Vec<String> = dicts[0].cles().map(str::to_string).collect();
    cles.sort();
    for (l, d) in LANGUES.iter().zip(&dicts).skip(1) {
        for cle in &cles {
            match (dicts[0].variables(cle), d.variables(cle)) {
                (_, None) => erreurs.push(format!("{nom} : {cle} manque en {l}")),
                (Some(fr), Some(autre)) if fr.len() != autre.len() => erreurs.push(format!("{nom} : {cle} n'a pas la même forme en {l}")),
                (Some(fr), Some(autre)) if fr != autre => erreurs.push(format!("{nom} : variables différentes pour {cle} en {l}")),
                _ => {}
            }
        }
        for cle in d.cles().filter(|c| dicts[0].variables(c).is_none()) {
            erreurs.push(format!("{nom} : {cle} en trop en {l}"));
        }
    }
    cles
}

#[test]
fn traductions_completes() {
    let mut erreurs = vec![];
    let interface = verifier_dictionnaires("interface", Dictionnaire::charger, &mut erreurs);
    let moteur = verifier_dictionnaires("moteur", coeur::i18n::dictionnaire, &mut erreurs);

    // shortcut: les clés inutilisées ne sont pas encore refusées : la plupart des écrans ne sont pas portés (R5).
    for (crate_, cles) in [("interface", &interface), ("coeur", &moteur), ("app", &moteur), ("commun", &interface)] {
        let mut fichiers = vec![];
        sources(&racine().join("crates").join(crate_).join("src"), &mut fichiers);
        for f in fichiers {
            let nom = f.strip_prefix(racine()).unwrap_or(&f).display().to_string();
            for (n, ligne) in code(&f) {
                for cle in cles_utilisees(&ligne) {
                    if !cles.contains(&cle) {
                        erreurs.push(format!("{nom}:{n} : clé inconnue {cle}"));
                    }
                }
                if ligne.chars().any(|c| ACCENTS.contains(c)) {
                    erreurs.push(format!("{nom}:{n} : texte français dans le code : {}", ligne.trim()));
                }
            }
        }
    }
    assert!(erreurs.is_empty(), "\n{}\n\n{} problème(s).", erreurs.join("\n"), erreurs.len());
}
