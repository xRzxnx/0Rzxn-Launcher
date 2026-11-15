//! Mémoire du PC et mesures du processus du jeu (mémoire, pic, temps processeur), comme platform/*/process-metrics.js.
//! Windows : API du système (plus de PowerShell). Linux : /proc. macOS : `ps`, le pic est retenu par l'appelant.

/// Mesure d'un processus : octets en mémoire, pic connu, temps processeur cumulé (ms).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mesure {
    pub memoire: u64,
    pub pic: u64,
    pub cpu_ms: f64,
}

/// Linux : mémoire (VmRSS), pic (VmHWM) et temps processeur (utime + stime) d'après /proc/<pid>/status et stat.
pub fn lire_proc(status: &str, stat: &str) -> Option<Mesure> {
    let ko = |champ: &str| -> Option<u64> {
        let l = status.lines().find_map(|l| l.strip_prefix(champ)?.strip_prefix(':'))?;
        Some(l.trim().strip_suffix("kB")?.trim().parse::<u64>().ok()? * 1024)
    };
    // Le nom du programme (2e champ) peut contenir des espaces et des parenthèses : on coupe après la dernière « ) ».
    let champs: Vec<&str> = stat.get(stat.rfind(')')? + 2..)?.split(' ').collect();
    let battements: u64 = champs.get(11)?.parse::<u64>().ok()? + champs.get(12)?.parse::<u64>().ok()?;
    // 100 battements par seconde sur toutes les distributions courantes.
    Some(Mesure { memoire: ko("VmRSS")?, pic: ko("VmHWM")?, cpu_ms: battements as f64 * 10.0 })
}

/// macOS : « rss temps » de `ps -o rss=,time=` (Ko ; temps [[jj-]hh:]mm:ss.cc). Le pic vaut la mémoire du moment.
pub fn lire_ps(ligne: &str) -> Option<Mesure> {
    let mut morceaux = ligne.split_whitespace();
    let rss: u64 = morceaux.next()?.parse().ok()?;
    let temps = morceaux.next()?;
    if morceaux.next().is_some() {
        return None;
    }
    let (jours, reste) = match temps.split_once('-') {
        Some((j, r)) => (j.parse::<f64>().ok()?, r),
        None => (0.0, temps),
    };
    let parts: Vec<f64> = reste.split(':').map(|p| p.parse::<f64>().ok()).collect::<Option<_>>()?;
    let (h, m, s) = match parts[..] {
        [m, s] => (0.0, m, s),
        [h, m, s] => (h, m, s),
        _ => return None,
    };
    let cpu_ms = ((((jours * 24.0 + h) * 60.0 + m) * 60.0 + s) * 1000.0).round();
    Some(Mesure { memoire: rss * 1024, pic: rss * 1024, cpu_ms })
}

#[cfg(windows)]
mod systeme {
    use super::Mesure;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        ABOVE_NORMAL_PRIORITY_CLASS, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
        SetPriorityClass,
    };

    struct Poignee(HANDLE);
    impl Drop for Poignee {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    fn ouvrir(pid: u32, droits: u32) -> Option<Poignee> {
        let h = unsafe { OpenProcess(droits, 0, pid) };
        (!h.is_null()).then_some(Poignee(h))
    }
    fn ms(f: FILETIME) -> f64 {
        ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 10_000.0
    }

    pub fn mesurer(pid: u32) -> Option<Mesure> {
        let p = ouvrir(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
        let mut m: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        m.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        if unsafe { GetProcessMemoryInfo(p.0, &mut m, m.cb) } == 0 {
            return None;
        }
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut creation, mut fin, mut noyau, mut utilisateur) = (zero, zero, zero, zero);
        if unsafe { GetProcessTimes(p.0, &mut creation, &mut fin, &mut noyau, &mut utilisateur) } == 0 {
            return None;
        }
        Some(Mesure { memoire: m.WorkingSetSize as u64, pic: m.PeakWorkingSetSize as u64, cpu_ms: ms(noyau) + ms(utilisateur) })
    }

    fn etat_memoire() -> Option<MEMORYSTATUSEX> {
        let mut s: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        s.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        (unsafe { GlobalMemoryStatusEx(&mut s) } != 0).then_some(s)
    }
    pub fn memoire_totale() -> u64 {
        etat_memoire().map_or(0, |s| s.ullTotalPhys)
    }
    pub fn memoire_libre() -> u64 {
        etat_memoire().map_or(0, |s| s.ullAvailPhys)
    }

    pub fn priorite_haute(pid: u32) -> Result<(), String> {
        let p = ouvrir(pid, PROCESS_SET_INFORMATION).ok_or_else(|| std::io::Error::last_os_error().to_string())?;
        if unsafe { SetPriorityClass(p.0, ABOVE_NORMAL_PRIORITY_CLASS) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod systeme {
    use super::{Mesure, lire_proc};

    pub fn mesurer(pid: u32) -> Option<Mesure> {
        lire_proc(
            &std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?,
            &std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?,
        )
    }
    fn meminfo(champ: &str) -> u64 {
        let texte = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        texte
            .lines()
            .find_map(|l| l.strip_prefix(champ)?.strip_prefix(':'))
            .and_then(|v| v.trim().strip_suffix("kB")?.trim().parse::<u64>().ok())
            .map_or(0, |k| k * 1024)
    }
    pub fn memoire_totale() -> u64 {
        meminfo("MemTotal")
    }
    pub fn memoire_libre() -> u64 {
        meminfo("MemAvailable")
    }
    pub fn priorite_haute(pid: u32) -> Result<(), String> {
        super::renice(pid)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod systeme {
    use super::{Mesure, lire_ps};
    use std::process::Command;

    fn sortie(programme: &str, args: &[&str]) -> Option<String> {
        let o = Command::new(programme).args(args).output().ok()?;
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
    }
    pub fn mesurer(pid: u32) -> Option<Mesure> {
        lire_ps(sortie("/bin/ps", &["-o", "rss=,time=", "-p", &pid.to_string()])?.trim())
    }
    pub fn memoire_totale() -> u64 {
        sortie("/usr/sbin/sysctl", &["-n", "hw.memsize"]).and_then(|s| s.trim().parse().ok()).unwrap_or(0)
    }
    /// Pages libres de `vm_stat`, comme os.freemem() de Node.
    pub fn memoire_libre() -> u64 {
        let Some(t) = sortie("/usr/bin/vm_stat", &[]) else { return 0 };
        let page = t.split("page size of ").nth(1).and_then(|r| r.split_whitespace().next()?.parse::<u64>().ok()).unwrap_or(4096);
        let libres = t.lines().find_map(|l| l.strip_prefix("Pages free:")).and_then(|v| v.trim().trim_end_matches('.').parse::<u64>().ok());
        libres.map_or(0, |n| n * page)
    }
    pub fn priorite_haute(pid: u32) -> Result<(), String> {
        super::renice(pid)
    }
}

/// Priorité « au-dessus de la normale » hors Windows (comme os.setPriority : nice -7).
#[cfg(unix)]
fn renice(pid: u32) -> Result<(), String> {
    let s = std::process::Command::new("renice").args(["-n", "-7", "-p", &pid.to_string()]).output().map_err(|e| e.to_string())?;
    if s.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&s.stderr).trim().to_string()) }
}

pub use systeme::{memoire_libre, memoire_totale, mesurer, priorite_haute};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_linux() {
        let status = "Name:\tjava\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\n";
        let stat = "4242 (java (le jeu)) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0";
        assert_eq!(lire_proc(status, stat), Some(Mesure { memoire: 1024 * 1024, pic: 2048 * 1024, cpu_ms: 3000.0 }));
        assert_eq!(lire_proc("Name: java", stat), None);
    }

    #[test]
    fn ps_macos() {
        assert_eq!(lire_ps("  2048   1:02.50"), Some(Mesure { memoire: 2048 * 1024, pic: 2048 * 1024, cpu_ms: 62_500.0 }));
        assert_eq!(lire_ps("10 1-02:03:04.00").map(|m| m.cpu_ms), Some(((26.0 * 60.0 + 3.0) * 60.0 + 4.0) * 1000.0));
        assert_eq!(lire_ps("abc 1:00"), None);
        assert_eq!(lire_ps(""), None);
    }

    #[test]
    fn ce_processus() {
        let m = mesurer(std::process::id()).expect("mesure");
        assert!(m.memoire > 0 && m.pic >= m.memoire && m.cpu_ms >= 0.0, "{m:?}");
        assert!(memoire_totale() > memoire_libre() && memoire_libre() > 0);
        assert_eq!(mesurer(u32::MAX - 1), None);
    }
}
