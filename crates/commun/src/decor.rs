//! Calculs du décor pixel art (sans dessin) : testables hors du navigateur.

/// mulberry32, bit pour bit comme random() de banner.js : même graine, même décor.
pub fn hasard(seed: u32) -> impl FnMut() -> f64 {
    let mut s = seed.wrapping_mul(2_654_435_761);
    move || {
        s = s.wrapping_add(0x6d2b_79f5);
        let mut t = s;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4_294_967_296.0
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn comme_javascript() {
        // random(120) de banner.js, calculé dans Node.
        let mut r = super::hasard(120);
        assert_eq!([r(), r(), r()], [0.389869972364977, 0.8794992701150477, 0.40743282018229365]);
    }
}
