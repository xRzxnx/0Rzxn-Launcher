//! Images du menu Cristal, dessinées sans dépendance d'image, comme core/title-art.js : panorama à 6 faces, verre,
//! boutons et logo. Mêmes calculs et même hasard (mulberry32) : même graine, même décor qu'avec la version Electron.

use commun::decor::hasard;
use flate2::Compression;
use flate2::write::ZlibEncoder;
use std::io::Write;

type Rgb = [u8; 3];

/// Math.round de JavaScript (moitié vers le haut, aussi pour les négatifs).
fn rond(v: f64) -> i64 {
    (v + 0.5).floor() as i64
}

fn hex(c: &str) -> Rgb {
    let o = |i: usize| u8::from_str_radix(&c[i..i + 2], 16).unwrap_or(0);
    [o(1), o(3), o(5)]
}

/// Dégradé de n couleurs entre quelques teintes.
fn rampe(teintes: &[&str], n: usize) -> Vec<Rgb> {
    let rgb: Vec<Rgb> = teintes.iter().map(|c| hex(c)).collect();
    (0..n)
        .map(|i| {
            let t = (i as f64 / (n - 1) as f64) * (rgb.len() - 1) as f64;
            let k = (rgb.len() - 2).min(t.floor() as usize);
            let u = t - k as f64;
            std::array::from_fn(|j| rond(rgb[k][j] as f64 * (1.0 - u) + rgb[k + 1][j] as f64 * u) as u8)
        })
        .collect()
}

const CIEL: [&str; 14] = [
    "#151129", "#1a1331", "#20163a", "#271943", "#2f1c4b", "#3a2053", "#47245a", "#562860", "#672d63", "#7a3363", "#8e3a60", "#a3445b",
    "#b65255", "#c6634f",
];

struct Palette {
    ciel: Vec<Rgb>,
    soleil: Vec<Rgb>,
    etoile: Rgb,
    nuages: Vec<Rgb>,
    collines: Vec<Rgb>,
}

fn liste(c: &[&str]) -> Vec<Rgb> {
    c.iter().map(|c| hex(c)).collect()
}

fn palette(theme: &str) -> Palette {
    match theme {
        "night" => Palette {
            ciel: rampe(&["#05070f", "#0d1530", "#1a2a57", "#2b4478"], CIEL.len()),
            soleil: liste(&["#fbfbf2", "#f4f4e6", "#ecedde", "#e2e6dc", "#d8dfdc", "#cdd7dc", "#c3cfdc", "#bac8dc", "#b0c0dc"]),
            etoile: hex("#f2f5ff"),
            nuages: liste(&["#0f1936", "#27407a", "#1a2c58"]),
            collines: liste(&["#16244a", "#0d1634", "#060b1c"]),
        },
        "forest" => Palette {
            ciel: rampe(&["#0b1f17", "#1c4a33", "#3f8050", "#a8c46b"], CIEL.len()),
            soleil: liste(&["#fbf6c4", "#f6f0b0", "#f0e99e", "#e9e18c", "#e1d97c", "#d8d06e", "#cfc762", "#c5bd58", "#bab34f"]),
            etoile: hex("#e4f7d0"),
            nuages: liste(&["#14352a", "#4e8f5c", "#2c6a43"]),
            collines: liste(&["#245238", "#17382a", "#0a2016"]),
        },
        _ => Palette {
            ciel: liste(&CIEL),
            soleil: liste(&["#ffe6a3", "#ffdc93", "#ffd083", "#ffc274", "#ffb366", "#ffa45c", "#ff9853", "#ff8c4c", "#f98048"]),
            etoile: hex("#e9dcff"),
            nuages: liste(&["#2c1c4b", "#7a3363", "#562860"]),
            collines: liste(&["#3a1f4d", "#251536", "#140c22"]),
        },
    }
}

const LARGEURS_SOLEIL: [f64; 9] = [6.0, 10.0, 12.0, 14.0, 16.0, 16.0, 18.0, 18.0, 20.0];

/// Encode une image RGBA (largeur × hauteur × 4 octets).
pub fn png(largeur: usize, hauteur: usize, rgba: &[u8]) -> Vec<u8> {
    let ligne = largeur * 4;
    let mut brut = Vec::with_capacity((ligne + 1) * hauteur);
    for y in 0..hauteur {
        brut.push(0);
        brut.extend_from_slice(&rgba[y * ligne..(y + 1) * ligne]);
    }
    let mut z = ZlibEncoder::new(vec![], Compression::best());
    let _ = z.write_all(&brut);
    let donnees = z.finish().unwrap_or_default();
    let morceau = |genre: &[u8], corps: &[u8]| {
        let mut m = (corps.len() as u32).to_be_bytes().to_vec();
        let mut crc = crc32fast::Hasher::new();
        crc.update(genre);
        crc.update(corps);
        m.extend_from_slice(genre);
        m.extend_from_slice(corps);
        m.extend_from_slice(&crc.finalize().to_be_bytes());
        m
    };
    let mut entete = vec![];
    entete.extend_from_slice(&(largeur as u32).to_be_bytes());
    entete.extend_from_slice(&(hauteur as u32).to_be_bytes());
    entete.extend_from_slice(&[8, 6, 0, 0, 0]); // 8 bits par canal, RGBA
    [b"\x89PNG\r\n\x1a\n".to_vec(), morceau(b"IHDR", &entete), morceau(b"IDAT", &donnees), morceau(b"IEND", &[])].concat()
}

/// Bruit doux qui reboucle, pour que le relief se raccorde après un tour complet.
fn bruit_boucle(rnd: &mut impl FnMut() -> f64, colonnes: usize, bloc: i64, pas: i64, min: f64, max: f64) -> Vec<i64> {
    let n = rond(colonnes as f64 / pas as f64).max(1) as usize;
    let points: Vec<f64> = (0..n).map(|_| min + rnd() * (max - min)).collect();
    (0..colonnes as i64)
        .map(|i| {
            let k = (i / pas) as usize;
            let u = (1.0 - (((i % pas) as f64 / pas as f64) * std::f64::consts::PI).cos()) / 2.0;
            rond((points[k % n] * (1.0 - u) + points[(k + 1) % n] * u) / bloc as f64) * bloc
        })
        .collect()
}

/// Six faces carrées, dans l'ordre attendu par Minecraft : 0 à 3 font le tour de l'horizon, 4 le haut, 5 le bas.
pub fn faces_panorama(graine: u32, theme: &str, taille: usize) -> Vec<Vec<u8>> {
    let pal = palette(theme);
    let mut rnd = hasard(graine);
    let t = taille as f64;
    let ti = taille as i64;
    let bloc = 2.max(rond(t / 170.0));
    let unite = t / 80.0;
    let cale = |v: f64| bloc.max(rond(v / bloc as f64) * bloc);
    let pas = |part: f64| 2.max(rond(t * part / bloc as f64));
    let tour = ti * 4;
    let colonnes = (tour as f64 / bloc as f64).ceil() as usize;
    let mut anneau = vec![0u8; (tour * ti * 4) as usize];

    let mut rect = |x: i64, y: i64, w: i64, h: i64, c: Rgb, alpha: f64| {
        for b in 0..h {
            let yy = y + b;
            if yy < 0 || yy >= ti {
                continue;
            }
            for a in 0..w {
                let i = ((yy * tour + (x + a).rem_euclid(tour)) * 4) as usize;
                for j in 0..3 {
                    anneau[i + j] = rond(c[j] as f64 * alpha + anneau[i + j] as f64 * (1.0 - alpha)) as u8;
                }
                anneau[i + 3] = 255;
            }
        }
    };

    // Ciel en bandes tramées, jusqu'à l'horizon.
    let horizon = rond(t * 0.74);
    let bande = horizon as f64 / pal.ciel.len() as f64;
    for (i, c) in pal.ciel.iter().enumerate() {
        let y = rond(i as f64 * bande);
        rect(0, y, tour, bande.ceil() as i64 + 1, *c, 1.0);
        if i > 0 {
            for x in (0..tour).step_by(bloc as usize * 2) {
                rect(x, y, bloc, bloc, pal.ciel[i - 1], 1.0);
            }
        }
    }
    rect(0, horizon, tour, ti - horizon, pal.ciel[pal.ciel.len() - 1], 1.0);

    // Étoiles.
    let etoile = 2.max(rond(bloc as f64 / 2.0));
    for _ in 0..70 {
        let x = (rnd() * tour as f64 / etoile as f64).floor() as i64 * etoile;
        let y = (rnd() * t * 0.3 / etoile as f64).floor() as i64 * etoile;
        let a = 0.35 + rnd() * 0.5;
        rect(x, y, etoile, etoile, pal.etoile, a);
    }

    // Nuages.
    for i in 0..16 {
        let x = (rnd() * colonnes as f64).floor() as i64 * bloc;
        let y = (((0.12 + rnd() * 0.34) * t) / bloc as f64).floor() as i64 * bloc;
        let w = cale((8.0 + (rnd() * 14.0).floor()) * unite);
        let h = cale(unite);
        rect(x, y, w, 2 * h, pal.nuages[i % 3], 1.0);
        rect(x + cale(3.0 * unite), y - h, cale(w as f64 * 0.45), h, pal.nuages[i % 3], 1.0);
    }

    // Soleil ou lune, sur la première face ; deux rayures, comme la bannière.
    let bas_soleil = rond(t * 0.66);
    for (i, w) in LARGEURS_SOLEIL.iter().enumerate() {
        if i == 5 || i == 7 {
            continue;
        }
        let largeur = cale(w * unite * 1.5);
        let rangee = cale(unite * 1.4);
        rect(
            rond(t * 0.5 - largeur as f64 / 2.0),
            bas_soleil - (LARGEURS_SOLEIL.len() - i) as i64 * rangee,
            largeur,
            rangee,
            pal.soleil[i],
            1.0,
        );
    }

    // Reliefs, du plus lointain au plus proche, puis arbres.
    let proche = bruit_boucle(&mut rnd, colonnes, bloc, pas(0.09), t * 0.7, t * 0.78);
    let loin = bruit_boucle(&mut rnd, colonnes, bloc, pas(0.2), t * 0.52, t * 0.64);
    let milieu = bruit_boucle(&mut rnd, colonnes, bloc, pas(0.13), t * 0.6, t * 0.7);
    for (sommets, c) in [(&loin, pal.collines[0]), (&milieu, pal.collines[1]), (&proche, pal.collines[2])] {
        for (i, haut) in sommets.iter().enumerate() {
            rect(i as i64 * bloc, *haut, bloc, ti - haut, c, 1.0);
        }
    }
    for _ in 0..46 {
        let col = (rnd() * colonnes as f64).floor() as usize;
        let x = (col as i64 - 1) * bloc;
        let base = proche[col];
        let s = cale(if rnd() < 0.5 { 0.6 } else { 1.1 } * unite);
        let c = pal.collines[2];
        rect(x + s, base - 7 * s, s, s, c, 1.0);
        rect(x, base - 6 * s, 3 * s, 3 * s, c, 1.0);
        rect(x + s, base - 3 * s, s, 3 * s, c, 1.0);
    }

    // Découpe du tour en quatre faces.
    let mut faces = vec![];
    for n in 0..4 {
        let mut face = Vec::with_capacity(taille * taille * 4);
        for y in 0..taille {
            let debut = (y * tour as usize + n * taille) * 4;
            face.extend_from_slice(&anneau[debut..debut + taille * 4]);
        }
        faces.push(png(taille, taille, &face));
    }

    // Haut étoilé et bas sombre.
    let uni = |c: Rgb| [c[0], c[1], c[2], 255].repeat(taille * taille);
    let mut haut = uni(pal.ciel[0]);
    let e = etoile as usize;
    for _ in 0..40 {
        let x = (rnd() * (taille - e) as f64 / e as f64).floor() as usize * e;
        let y = (rnd() * (taille - e) as f64 / e as f64).floor() as usize * e;
        for b in 0..e {
            for a in 0..e {
                let i = ((y + b) * taille + x + a) * 4;
                haut[i..i + 4].copy_from_slice(&[pal.etoile[0], pal.etoile[1], pal.etoile[2], 255]);
            }
        }
    }
    faces.push(png(taille, taille, &haut));
    faces.push(png(taille, taille, &uni(pal.collines[2])));
    faces
}

/// Pavé à coins arrondis, prévu pour être étiré en 9 parties.
fn pave(taille: usize, rayon: i64, fond: [u8; 4], bord: [u8; 4]) -> Vec<u8> {
    let mut d = vec![0u8; taille * taille * 4];
    let s = taille as i64;
    let dedans = |x: i64, y: i64, r: i64, retrait: i64| {
        let (a, b) = (retrait + r, s - 1 - retrait - r);
        let dx = if x < a {
            a - x
        } else if x > b {
            x - b
        } else {
            0
        };
        let dy = if y < a {
            a - y
        } else if y > b {
            y - b
        } else {
            0
        };
        x >= retrait && y >= retrait && x <= s - 1 - retrait && y <= s - 1 - retrait && (dx * dx + dy * dy) as f64 <= (r * r) as f64 + 0.5
    };
    for y in 0..s {
        for x in 0..s {
            if dedans(x, y, rayon, 0) {
                let i = ((y * s + x) * 4) as usize;
                d[i..i + 4].copy_from_slice(if dedans(x, y, rayon - 1, 1) { &fond } else { &bord });
            }
        }
    }
    png(taille, taille, &d)
}

pub fn verre() -> Vec<u8> {
    pave(24, 5, [22, 15, 44, 190], [255, 255, 255, 64])
}
pub fn bouton() -> Vec<u8> {
    pave(16, 3, [255, 255, 255, 34], [255, 255, 255, 86])
}
pub fn bouton_survol() -> Vec<u8> {
    pave(16, 3, [255, 255, 255, 64], [255, 255, 255, 230])
}
pub fn bouton_principal() -> Vec<u8> {
    pave(16, 3, [109, 79, 240, 245], [168, 146, 255, 255])
}
pub fn bouton_principal_survol() -> Vec<u8> {
    pave(16, 3, [127, 100, 245, 255], [255, 255, 255, 255])
}

fn glyphe(c: char) -> &'static str {
    match c {
        '0' => "01110 10001 10011 10101 11001 10001 01110",
        'R' => "11110 10001 10001 11110 10100 10010 10001",
        'Z' => "11111 00001 00010 00100 01000 10000 11111",
        'X' => "10001 10001 01010 00100 01010 10001 10001",
        'N' => "10001 11001 10101 10101 10011 10001 10001",
        _ => "00000 00000 00000 00000 00000 00000 11111",
    }
}

/// Logo « 0RZXN_ » en blocs violets.
pub fn logo() -> Vec<u8> {
    const TEXTE: &str = "0RZXN_";
    let (cellule, profondeur) = (14usize, 6usize);
    let largeur = (TEXTE.len() * 6 - 1) * cellule + profondeur;
    let hauteur = 7 * cellule + profondeur;
    let mut d = vec![0u8; largeur * hauteur * 4];
    let mut rnd = hasard(3);
    let mut poser = |x: usize, y: usize, c: Rgb| {
        if x < largeur && y < hauteur {
            let i = (y * largeur + x) * 4;
            d[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
        }
    };
    let mut cases = vec![];
    for (n, ch) in TEXTE.chars().enumerate() {
        for (y, rangee) in glyphe(ch).split(' ').enumerate() {
            for (x, b) in rangee.bytes().enumerate() {
                if b == b'1' {
                    cases.push((n * 6 + x, y));
                }
            }
        }
    }
    let teintes = rampe(&["#ece6ff", "#c4b5ff", "#a892ff", "#7f64f5", "#6d4ff0"], 7);
    let ombre = hex("#2a1a66");
    for &(x, y) in &cases {
        for d in (1..=profondeur).rev().step_by(2) {
            for i in 0..cellule {
                for j in 0..cellule {
                    poser(x * cellule + i + d, y * cellule + j + d, ombre);
                }
            }
        }
    }
    for &(x, y) in &cases {
        let ton = (rnd() - 0.5) * 18.0;
        for i in (0..cellule).step_by(2) {
            for j in (0..cellule).step_by(2) {
                let bord = if i == 0 || j == 0 {
                    9.0
                } else if i >= cellule - 2 || j >= cellule - 2 {
                    -9.0
                } else {
                    0.0
                };
                let bruit = (rnd() - 0.5) * 14.0 + ton + bord;
                let c: Rgb = std::array::from_fn(|k| rond(teintes[y][k] as f64 + bruit).clamp(0, 255) as u8);
                for a in 0..2 {
                    for b in 0..2 {
                        poser(x * cellule + i + a, y * cellule + j + b, c);
                    }
                }
            }
        }
    }
    png(largeur, hauteur, &d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dimensions(p: &[u8]) -> (u32, u32) {
        assert_eq!(&p[..8], b"\x89PNG\r\n\x1a\n");
        (u32::from_be_bytes(p[16..20].try_into().unwrap()), u32::from_be_bytes(p[20..24].try_into().unwrap()))
    }

    #[test]
    fn images() {
        assert_eq!(rond(-0.5), 0);
        assert_eq!(rond(2.5), 3);
        let f = faces_panorama(7, "night", 64);
        assert_eq!(f.len(), 6);
        assert!(f.iter().all(|p| dimensions(p) == (64, 64)));
        assert_eq!(f, faces_panorama(7, "night", 64), "même graine, même décor");
        assert_ne!(f[0], faces_panorama(8, "night", 64)[0]);
        assert_eq!(dimensions(&verre()), (24, 24));
        assert_eq!(dimensions(&logo()), (496, 104));
        assert_eq!(rampe(&["#000000", "#ffffff"], 3)[1], [128, 128, 128]);
    }

    /// Pixels décompressés, comparés à ceux de title-art.js (empreintes calculées dans Node).
    #[test]
    fn comme_electron() {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let pixels = |p: &[u8]| {
            let (mut o, mut idat) = (8, vec![]);
            while o < p.len() {
                let n = u32::from_be_bytes(p[o..o + 4].try_into().unwrap()) as usize;
                if &p[o + 4..o + 8] == b"IDAT" {
                    idat.extend_from_slice(&p[o + 8..o + 8 + n]);
                }
                o += 12 + n;
            }
            let mut brut = vec![];
            flate2::read::ZlibDecoder::new(&idat[..]).read_to_end(&mut brut).unwrap();
            Sha256::digest(&brut).iter().take(8).map(|b| format!("{b:02x}")).collect::<String>()
        };
        let mut images = faces_panorama(7, "night", 96);
        images.extend([logo(), verre()]);
        let l: Vec<String> = images.iter().map(|p| pixels(p)).collect();
        assert_eq!(
            l.join(" "),
            "98bcd2b9c0285e97 113848f9efbb1f42 a75c6ad333956309 6e44f9b27719793e 451e42f675987f35 d36176e1fac9b8af f394d522e81be5b3 4b461796f2c3e8e2"
        );
    }
}
