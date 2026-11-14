//! Décor « coucher de soleil » en pixel art, généré à partir d'une graine (portage exact de banner.js :
//! même générateur, mêmes appels au canvas, donc la même image).

use std::cell::RefCell;
use std::collections::HashMap;
use wasm_bindgen::JsCast;
use web_sys::{CanvasRenderingContext2d, HtmlCanvasElement};

const B: f64 = 10.0;
const SKY: [&str; 14] = [
    "#151129", "#1a1331", "#20163a", "#271943", "#2f1c4b", "#3a2053", "#47245a", "#562860", "#672d63", "#7a3363", "#8e3a60", "#a3445b",
    "#b65255", "#c6634f",
];
const SUN_WIDTHS: [f64; 9] = [6.0, 10.0, 12.0, 14.0, 16.0, 16.0, 18.0, 18.0, 20.0];
const SUN_COLORS: [&str; 9] = ["#ffe6a3", "#ffdc93", "#ffd083", "#ffc274", "#ffb366", "#ffa45c", "#ff9853", "#ff8c4c", "#f98048"];
const CLOUDS: [(f64, f64, f64, f64, usize); 6] = [
    (0.14, 0.16, 14.0, 2.0, 0),
    (0.19, 0.1, 7.0, 1.0, 0),
    (0.56, 0.3, 18.0, 2.0, 1),
    (0.6, 0.25, 9.0, 1.0, 1),
    (0.8, 0.18, 15.0, 2.0, 2),
    (0.84, 0.13, 6.0, 1.0, 2),
];

struct Palette {
    sky: Vec<String>,
    sun: Vec<String>,
    star: &'static str,
    clouds: [&'static str; 3],
    hills: [&'static str; 3],
}

fn arrondi(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Dégradé de n couleurs entre quelques teintes « #rrggbb ».
fn ramp(stops: &[&str], n: usize) -> Vec<String> {
    let rgb: Vec<[f64; 3]> = stops.iter().map(|c| [1, 3, 5].map(|i| u8::from_str_radix(&c[i..i + 2], 16).unwrap() as f64)).collect();
    (0..n)
        .map(|i| {
            let t = (i as f64 / (n - 1) as f64) * (rgb.len() - 1) as f64;
            let k = (rgb.len() - 2).min(t.floor() as usize);
            let u = t - k as f64;
            let c: Vec<String> = (0..3).map(|j| format!("{:02x}", arrondi(rgb[k][j] * (1.0 - u) + rgb[k + 1][j] * u) as u32)).collect();
            format!("#{}", c.concat())
        })
        .collect()
}

fn palette(theme: &str) -> Palette {
    let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match theme {
        "night" => Palette {
            sky: ramp(&["#05070f", "#0d1530", "#1a2a57", "#2b4478"], SKY.len()),
            sun: v(&["#fbfbf2", "#f4f4e6", "#ecedde", "#e2e6dc", "#d8dfdc", "#cdd7dc", "#c3cfdc", "#bac8dc", "#b0c0dc"]),
            star: "#f2f5ff",
            clouds: ["#0f1936", "#27407a", "#1a2c58"],
            hills: ["#16244a", "#0d1634", "#060b1c"],
        },
        "forest" => Palette {
            sky: ramp(&["#0b1f17", "#1c4a33", "#3f8050", "#a8c46b"], SKY.len()),
            sun: v(&["#fbf6c4", "#f6f0b0", "#f0e99e", "#e9e18c", "#e1d97c", "#d8d06e", "#cfc762", "#c5bd58", "#bab34f"]),
            star: "#e4f7d0",
            clouds: ["#14352a", "#4e8f5c", "#2c6a43"],
            hills: ["#245238", "#17382a", "#0a2016"],
        },
        _ => Palette {
            sky: v(&SKY),
            sun: v(&SUN_COLORS),
            star: "#e9dcff",
            clouds: ["#2c1c4b", "#7a3363", "#562860"],
            hills: ["#3a1f4d", "#251536", "#140c22"],
        },
    }
}

fn smooth_noise(rnd: &mut impl FnMut() -> f64, columns: usize, step: usize, min: f64, max: f64) -> Vec<f64> {
    let points: Vec<f64> = (0..=columns.div_ceil(step) + 1).map(|_| min + rnd() * (max - min)).collect();
    (0..columns)
        .map(|i| {
            let k = i / step;
            let u = (1.0 - (((i % step) as f64 / step as f64) * std::f64::consts::PI).cos()) / 2.0;
            arrondi((points[k] * (1.0 - u) + points[k + 1] * u) / B).max(1.0) * B
        })
        .collect()
}

fn dessiner(seed: u32, width: u32, height: u32, theme: &str) -> String {
    let pal = palette(theme);
    let doc = web_sys::window().unwrap().document().unwrap();
    let canvas: HtmlCanvasElement = doc.create_element("canvas").unwrap().unchecked_into();
    canvas.set_width(width);
    canvas.set_height(height);
    let ctx: CanvasRenderingContext2d = canvas.get_context("2d").unwrap().unwrap().unchecked_into();
    let (w, h) = (width as f64, height as f64);
    let mut rnd = commun::decor::hasard(seed);
    let columns = (w / B).ceil() as usize;
    let fill = |color: &str| ctx.set_fill_style_str(color);

    // Ciel en bandes, avec une rangée tramée entre chaque bande
    let band_h = h / pal.sky.len() as f64;
    for (i, color) in pal.sky.iter().enumerate() {
        let y = arrondi(i as f64 * band_h);
        fill(color);
        ctx.fill_rect(0.0, y, w, band_h.ceil() + 1.0);
        if i > 0 {
            fill(&pal.sky[i - 1]);
            let mut x = 0.0;
            while x < w {
                ctx.fill_rect(x, y, B, B);
                x += B * 2.0;
            }
        }
    }

    // Étoiles
    for _ in 0..14 {
        ctx.set_global_alpha(0.35 + rnd() * 0.5);
        fill(pal.star);
        let x = arrondi(rnd() * w);
        let y = arrondi(rnd() * h * 0.22);
        ctx.fill_rect(x, y, B / 2.0, B / 2.0);
    }
    ctx.set_global_alpha(1.0);

    // Nuages
    for (x, y, cw, ch, c) in CLOUDS {
        fill(pal.clouds[c]);
        ctx.fill_rect(arrondi(x * w), arrondi(y * h), cw * B, ch * B);
    }

    // Soleil (derrière les montagnes, deux rayures horizontales)
    let sun_cx = arrondi(w * 0.72);
    let sun_bottom = arrondi(h * 0.7);
    for (i, sw) in SUN_WIDTHS.iter().enumerate() {
        if i == 5 || i == 7 {
            continue;
        }
        fill(&pal.sun[i]);
        let y = sun_bottom - (SUN_WIDTHS.len() - i) as f64 * B;
        ctx.fill_rect(sun_cx - (sw * B) / 2.0, y, sw * B, B);
    }

    // Reliefs, du plus lointain au plus proche
    let far = smooth_noise(&mut rnd, columns, 12, h * 0.24, h * 0.45);
    let mid = smooth_noise(&mut rnd, columns, 8, h * 0.15, h * 0.33);
    let near = smooth_noise(&mut rnd, columns, 6, h * 0.06, h * 0.18);
    for (hauteurs, color) in [(&far, pal.hills[0]), (&mid, pal.hills[1]), (&near, pal.hills[2])] {
        fill(color);
        for (i, hh) in hauteurs.iter().enumerate() {
            ctx.fill_rect(i as f64 * B, h - hh, B, *hh);
        }
    }

    // Arbres sur les collines proches
    fill(pal.hills[2]);
    for ratio in [0.075, 0.17, 0.21, 0.36, 0.57, 0.65] {
        let col = (ratio * columns as f64).floor() as usize;
        let x = (col as f64 - 1.0) * B;
        let base = h - near[col];
        ctx.fill_rect(x + B, base - 7.0 * B, B, B);
        ctx.fill_rect(x, base - 6.0 * B, 3.0 * B, 3.0 * B);
        ctx.fill_rect(x + B, base - 3.0 * B, B, 3.0 * B);
    }

    canvas.to_data_url_with_type("image/png").unwrap_or_default()
}

thread_local! {
    static CACHE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

pub fn banniere(seed: u32, width: u32, height: u32, theme: &str) -> String {
    let cle = format!("{theme}:{seed}:{width}x{height}");
    if let Some(url) = CACHE.with(|c| c.borrow().get(&cle).cloned()) {
        return url;
    }
    let url = dessiner(seed, width, height, theme);
    CACHE.with(|c| c.borrow_mut().insert(cle, url.clone()));
    url
}

/// Décor de toute la fenêtre (1600 × 760, calé en haut).
pub fn scene(seed: u32, theme: &str) -> String {
    banniere(seed, 1600, 760, theme)
}
