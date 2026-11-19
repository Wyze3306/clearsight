use std::ffi::CString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn read(path: impl AsRef<Path>) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

pub fn uid() -> u32 {
    unsafe { libc::getuid() }
}

pub fn host_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    if std::env::var_os("APPIMAGE").is_some() || std::env::var_os("APPDIR").is_some() {
        for key in [
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "GDK_PIXBUF_MODULE_FILE",
            "GDK_PIXBUF_MODULEDIR",
            "GIO_MODULE_DIR",
            "GIO_EXTRA_MODULES",
            "GTK_PATH",
            "GTK_EXE_PREFIX",
            "GTK_DATA_PREFIX",
            "GTK_IM_MODULE_FILE",
            "GSETTINGS_SCHEMA_DIR",
            "PYTHONHOME",
            "PYTHONPATH",
            "PERLLIB",
            "QT_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "WEBKIT_EXEC_PATH",
            "APPDIR",
            "APPIMAGE",
            "OWD",
            "ARGV0",
        ] {
            cmd.env_remove(key);
        }
        if let Ok(path) = std::env::var("PATH") {
            let cleaned: Vec<&str> = path.split(':').filter(|p| !p.contains("/tmp/.mount_")).collect();
            cmd.env("PATH", cleaned.join(":"));
        }
        if let Ok(xdg) = std::env::var("XDG_DATA_DIRS") {
            let cleaned: Vec<&str> = xdg.split(':').filter(|p| !p.contains("/tmp/.mount_")).collect();
            cmd.env("XDG_DATA_DIRS", cleaned.join(":"));
        }
    }
    cmd
}

pub fn which(program: &str) -> bool {
    std::env::var("PATH")
        .unwrap_or_else(|_| "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into())
        .split(':')
        .chain(["/usr/sbin", "/sbin", "/usr/bin"])
        .any(|dir| Path::new(dir).join(program).is_file())
}

pub fn run(program: &str, args: &[&str]) -> Option<Output> {
    host_command(program).args(args).output().ok()
}

pub fn run_privileged(script: &str) -> Result<String, String> {
    if !which("pkexec") {
        return Err("pkexec is not installed, so administrator actions are unavailable.".into());
    }
    let out = host_command("pkexec")
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .output()
        .map_err(|e| format!("Could not start pkexec: {e}"))?;
    match out.status.code() {
        Some(0) => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
        Some(126) | Some(127) if out.stdout.is_empty() => {
            Err("Authentication was cancelled. Nothing was changed.".into())
        }
        _ => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() { "The administrator action failed.".into() } else { err })
        }
    }
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub struct FsStat {
    pub size: u64,
    pub used: u64,
    pub avail: u64,
    pub free: u64,
}

pub fn statvfs(path: &str) -> Option<FsStat> {
    let c = CString::new(path).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    let f = st.f_frsize as u64;
    Some(FsStat {
        size: st.f_blocks as u64 * f,
        used: (st.f_blocks as u64).saturating_sub(st.f_bfree as u64) * f,
        avail: st.f_bavail as u64 * f,
        free: st.f_bfree as u64 * f,
    })
}

pub fn unescape_mount(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 4 <= bytes.len() {
            let digits = std::str::from_utf8(&bytes[i + 1..i + 4]).unwrap_or("x");
            if let Ok(v) = u8::from_str_radix(digits, 8) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

pub struct MountEntry {
    pub source: String,
    pub target: String,
    pub fstype: String,
}

pub fn mounts() -> Vec<MountEntry> {
    read("/proc/self/mounts")
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some(MountEntry {
                source: unescape_mount(it.next()?),
                target: unescape_mount(it.next()?),
                fstype: it.next()?.to_string(),
            })
        })
        .collect()
}

pub fn dir_size(path: &Path) -> (u64, u64) {
    use rayon::prelude::*;
    use std::os::unix::fs::MetadataExt;
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return (0, 0),
    };
    if !meta.is_dir() {
        return (meta.blocks() * 512, 1);
    }
    let entries: Vec<_> = match fs::read_dir(path) {
        Ok(rd) => rd.flatten().collect(),
        Err(_) => return (meta.blocks() * 512, 0),
    };
    let (s, c) = entries
        .par_iter()
        .map(|e| {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_dir() => dir_size(&p),
                _ => match fs::symlink_metadata(&p) {
                    Ok(m) => (m.blocks() * 512, 1),
                    Err(_) => (0, 0),
                },
            }
        })
        .reduce(|| (0, 0), |a, b| (a.0 + b.0, a.1 + b.1));
    (s + meta.blocks() * 512, c)
}

pub fn remove_path(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        make_writable(path);
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn make_writable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.is_dir() {
            let mode = meta.permissions().mode();
            if mode & 0o700 != 0o700 {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode | 0o700));
            }
            if let Ok(rd) = fs::read_dir(path) {
                for e in rd.flatten() {
                    if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        make_writable(&e.path());
                    }
                }
            }
        }
    }
}

pub fn clear_dir_contents(path: &Path) -> (u64, Vec<String>) {
    let mut errors = Vec::new();
    let mut count = 0;
    if let Ok(rd) = fs::read_dir(path) {
        for e in rd.flatten() {
            match remove_path(&e.path()) {
                Ok(_) => count += 1,
                Err(err) => errors.push(format!("{}: {err}", e.path().display())),
            }
        }
    }
    (count, errors)
}

pub fn is_protected(path: &Path) -> bool {
    let p = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => path.to_path_buf(),
    };
    let s = p.to_string_lossy();
    let home = home();
    if p == home || home.starts_with(&p) {
        return true;
    }
    const ROOTS: &[&str] = &[
        "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/media", "/mnt",
        "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var", "/home", "/tmp",
        "/snap", "/usr/bin", "/usr/lib", "/usr/share", "/usr/local", "/var/lib", "/var/log", "/boot/efi",
    ];
    if ROOTS.contains(&s.as_ref()) {
        return true;
    }
    for sys in ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/", "/etc/", "/boot/", "/proc/", "/sys/", "/dev/"] {
        if s.starts_with(sys) {
            return true;
        }
    }
    if let Ok(rel) = p.strip_prefix(&home) {
        let first = rel.components().next().map(|c| c.as_os_str().to_string_lossy().to_string());
        if rel.components().count() == 1 {
            if let Some(f) = first {
                return matches!(f.as_str(), ".config" | ".local" | ".ssh" | ".gnupg" | ".Private" | ".ecryptfs");
            }
        }
    }
    false
}
