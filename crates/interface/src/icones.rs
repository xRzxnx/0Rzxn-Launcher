//! Icônes SVG statiques (copie de icons.js), insérées telles quelles : aucun texte venant des données n'y passe.

use leptos::prelude::*;

macro_rules! svg {
    ($corps:literal) => {
        concat!(r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" >"#, $corps, "</svg>")
    };
    ($corps:literal, $extra:literal) => {
        concat!(r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" "#, $extra, ">", $corps, "</svg>")
    };
}

pub fn svg(nom: &str) -> &'static str {
    match nom {
        "home" => svg!(r#"<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>"#, r#"stroke-linejoin="round""#),
        "mods" => svg!(r#"<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>"#, r#"stroke-linejoin="round""#),
        "versions" => svg!(r#"<rect x="3" y="4" width="18" height="5"/><path d="M5 9v11h14V9M10 13h4"/>"#),
        "settings" => svg!(
            r#"<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><rect x="13" y="4" width="4" height="4"/><rect x="7" y="10" width="4" height="4"/><rect x="15" y="16" width="4" height="4"/>"#,
            r#"stroke-linecap="square""#
        ),
        "worlds" => svg!(
            r#"<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>"#,
            r#"stroke-linejoin="round""#
        ),
        "activity" => svg!(r#"<path d="M3 12h4l3-8 4 16 3-8h4"/>"#, r#"stroke-linejoin="round""#),
        "console" => svg!(r#"<path d="M4 17l6-5-6-5M12 19h8"/>"#),
        "folder" => svg!(r#"<path d="M3 6h6l2 2h10v11H3z"/>"#, r#"stroke-linejoin="round""#),
        "plus" => svg!(r#"<path d="M12 4v16M4 12h16"/>"#, r#"stroke-width="2.5""#),
        "play" => svg!(r#"<path d="M7 4v16l12-8z"/>"#, r#"stroke-width="2.5""#),
        "chevron" => svg!(r#"<path d="M6 9l6 6 6-6"/>"#),
        "check" => svg!(r#"<path d="M4 12.5l5 5L20 6.5"/>"#, r#"stroke-width="3""#),
        "close" => svg!(r#"<path d="M6 6l12 12M18 6L6 18"/>"#, r#"stroke-width="2.5""#),
        "alert" => svg!(r#"<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17v1"/>"#, r#"stroke-width="2.5""#),
        "info" => svg!(r#"<rect x="4" y="4" width="16" height="16"/><path d="M12 11v6M12 7.5v.5"/>"#),
        "search" => svg!(r#"<rect x="4" y="4" width="12" height="12"/><path d="M16 16l5 5"/>"#),
        "download" => svg!(r#"<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>"#, r#"stroke-width="2.5""#),
        "trash" => svg!(r#"<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>"#),
        "copy" => svg!(r#"<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>"#),
        "upload" => svg!(r#"<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>"#, r#"stroke-width="2.5""#),
        "edit" => svg!(r#"<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4"/>"#, r#"stroke-linejoin="round""#),
        "link" => svg!(
            r#"<path d="M10 14l-2 2a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M14 10l2-2a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0"/>"#,
            r#"stroke-linecap="round""#
        ),
        "shield" => {
            svg!(r#"<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>"#, r#"stroke-linejoin="round""#)
        }
        // Boutons de la fenêtre : traits fins de 1 px sur 10 × 10, comme ceux du système.
        "fenetre-reduire" => r#"<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><path d="M0 5.5h10"/></svg>"#,
        "fenetre-agrandir" => {
            r#"<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><rect x="0.5" y="0.5" width="9" height="9"/></svg>"#
        }
        "fenetre-fermer" => {
            r#"<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><path d="M0 0l10 10M10 0L0 10"/></svg>"#
        }
        _ => "",
    }
}

/// `<span class="icon">` comme icon() de dom.js.
pub fn icone(nom: &'static str) -> impl IntoView {
    view! { <span class="icon" aria-hidden="true" inner_html=svg(nom)></span> }
}
