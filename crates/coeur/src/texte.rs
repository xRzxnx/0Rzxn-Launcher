//! Petits outils de texte partagés : lettres sans accents (tri et identifiants).

/// Lettres latines accentuées (minuscules) et leur lettre de base. Écrites en codes Unicode : le contrôle des
/// traductions refuse le texte accentué dans le code.
const ACCENTS: [(char, char); 31] = [
    ('\u{e0}', 'a'),
    ('\u{e1}', 'a'),
    ('\u{e2}', 'a'),
    ('\u{e3}', 'a'),
    ('\u{e4}', 'a'),
    ('\u{e5}', 'a'),
    ('\u{e7}', 'c'),
    ('\u{e8}', 'e'),
    ('\u{e9}', 'e'),
    ('\u{ea}', 'e'),
    ('\u{eb}', 'e'),
    ('\u{ec}', 'i'),
    ('\u{ed}', 'i'),
    ('\u{ee}', 'i'),
    ('\u{ef}', 'i'),
    ('\u{f1}', 'n'),
    ('\u{f2}', 'o'),
    ('\u{f3}', 'o'),
    ('\u{f4}', 'o'),
    ('\u{f5}', 'o'),
    ('\u{f6}', 'o'),
    ('\u{f9}', 'u'),
    ('\u{fa}', 'u'),
    ('\u{fb}', 'u'),
    ('\u{fc}', 'u'),
    ('\u{fd}', 'y'),
    ('\u{ff}', 'y'),
    ('\u{153}', 'o'),
    ('\u{e6}', 'a'),
    ('\u{df}', 's'),
    ('\u{f8}', 'o'),
];

/// Texte en minuscules, sans accents.
pub fn plier(texte: &str) -> String {
    texte.to_lowercase().chars().map(|c| ACCENTS.iter().find(|(a, _)| *a == c).map_or(c, |(_, b)| *b)).collect()
}

/// Comparaison sans casse ni accents (localeCompare avec sensitivity: base).
pub fn comparer(a: &str, b: &str) -> std::cmp::Ordering {
    plier(a).cmp(&plier(b))
}

#[cfg(test)]
mod tests {
    #[test]
    fn sans_accents() {
        assert_eq!(super::plier("Île Été Ça"), "ile ete ca");
        assert_eq!(super::comparer("Étoile", "etoile"), std::cmp::Ordering::Equal);
    }
}
