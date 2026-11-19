#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod analyzer;
mod apps;
mod cleanup;
mod storage;
mod system;
mod util;

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

struct AppState {
    sampler: Arc<Mutex<system::Sampler>>,
    apps: Arc<Mutex<apps::AppDirectory>>,
    scanner: Arc<analyzer::Scanner>,
    cleanup: Arc<CleanupStore>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn snapshot(state: State<'_, AppState>) -> Result<system::Snapshot, String> {
    let s = state.sampler.clone();
    blocking(move || s.lock().unwrap().sample()).await
}

#[tauri::command]
async fn app_info(state: State<'_, AppState>, keys: Vec<String>) -> Result<HashMap<String, apps::AppInfo>, String> {
    let a = state.apps.clone();
    blocking(move || {
        let mut dir = a.lock().unwrap();
        keys.into_iter().map(|k| { let info = dir.lookup(&k); (k, info) }).collect()
    })
    .await
}

#[derive(Serialize)]
struct SignalResult {
    ok: Vec<i32>,
    denied: Vec<i32>,
    gone: Vec<i32>,
}

fn signal_number(sig: &str) -> Result<i32, String> {
    Ok(match sig {
        "term" => libc::SIGTERM,
        "kill" => libc::SIGKILL,
        "stop" => libc::SIGSTOP,
        "cont" => libc::SIGCONT,
        _ => return Err("Unknown action.".into()),
    })
}

#[tauri::command]
async fn signal(pids: Vec<i32>, sig: String) -> Result<SignalResult, String> {
    let n = signal_number(&sig)?;
    let me = std::process::id() as i32;
    let mut res = SignalResult { ok: vec![], denied: vec![], gone: vec![] };
    for pid in pids {
        if pid <= 1 || pid == me {
            res.denied.push(pid);
            continue;
        }
        let r = unsafe { libc::kill(pid, n) };
        if r == 0 {
            res.ok.push(pid);
        } else {
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::ESRCH) => res.gone.push(pid),
                _ => res.denied.push(pid),
            }
        }
    }
    Ok(res)
}

#[tauri::command]
async fn signal_as_admin(pids: Vec<i32>, sig: String) -> Result<(), String> {
    let flag = match sig.as_str() {
        "term" => "TERM",
        "kill" => "KILL",
        "stop" => "STOP",
        "cont" => "CONT",
        _ => return Err("Unknown action.".into()),
    };
    let list: Vec<String> = pids.iter().filter(|p| **p > 1).map(|p| p.to_string()).collect();
    if list.is_empty() {
        return Err("This process cannot be stopped.".into());
    }
    blocking(move || util::run_privileged(&format!("kill -{flag} {}", list.join(" "))).map(|_| ())).await?
}

#[tauri::command]
async fn set_priority(pids: Vec<i32>, nice: i32) -> Result<(), String> {
    let nice = nice.clamp(-20, 19);
    let mut failed = Vec::new();
    for pid in &pids {
        let r = unsafe { libc::setpriority(libc::PRIO_PROCESS, *pid as libc::id_t, nice) };
        if r != 0 {
            failed.push(pid.to_string());
        }
    }
    if failed.is_empty() {
        return Ok(());
    }
    blocking(move || util::run_privileged(&format!("renice -n {nice} -p {}", failed.join(" "))).map(|_| ())).await?
}

#[tauri::command]
async fn storage() -> Result<storage::StorageInfo, String> {
    blocking(storage::storage_info).await
}

#[tauri::command]
async fn reduce_reserved(device: String) -> Result<(), String> {
    let info = blocking(storage::storage_info).await?;
    let vol = info
        .volumes
        .iter()
        .find(|v| v.device == device && v.can_reduce_reserved)
        .ok_or("This drive does not support this change.")?;
    let dev = util::shell_quote(&vol.device);
    blocking(move || util::run_privileged(&format!("tune2fs -m 1 {dev}")).map(|_| ())).await?
}

#[tauri::command]
async fn scan_start(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = if path.starts_with('~') { util::home().join(path.trim_start_matches('~').trim_start_matches('/')) } else { PathBuf::from(&path) };
    state.scanner.start(p)
}

#[tauri::command]
fn scan_cancel(state: State<'_, AppState>) {
    state.scanner.cancel();
}

#[tauri::command]
fn scan_status(state: State<'_, AppState>) -> analyzer::Status {
    state.scanner.status()
}

#[tauri::command]
async fn scan_list(state: State<'_, AppState>, path: String) -> Result<analyzer::Listing, String> {
    let s = state.scanner.clone();
    blocking(move || s.list(&path)).await?
}

#[tauri::command]
async fn scan_big_files(state: State<'_, AppState>) -> Result<Vec<analyzer::BigFile>, String> {
    let s = state.scanner.clone();
    blocking(move || s.big_files()).await
}

#[tauri::command]
async fn scan_rebuildable(state: State<'_, AppState>) -> Result<Vec<analyzer::Rebuildable>, String> {
    let s = state.scanner.clone();
    blocking(move || s.rebuildable()).await
}

#[derive(Serialize)]
struct DeleteResult {
    deleted: Vec<String>,
    errors: Vec<String>,
}

#[tauri::command]
async fn delete_paths(state: State<'_, AppState>, paths: Vec<String>, permanent: bool) -> Result<DeleteResult, String> {
    let s = state.scanner.clone();
    blocking(move || {
        let mut res = DeleteResult { deleted: vec![], errors: vec![] };
        for p in paths {
            let path = PathBuf::from(&p);
            if p.is_empty() || !path.is_absolute() || util::is_protected(&path) {
                res.errors.push(format!("{p}: this location is protected and cannot be deleted from here."));
                continue;
            }
            let r = if permanent { util::remove_path(&path).map_err(|e| e.to_string()) } else { trash::delete(&path).map_err(|e| e.to_string()) };
            match r {
                Ok(_) => {
                    s.forget(&p);
                    res.deleted.push(p);
                }
                Err(e) => res.errors.push(format!("{p}: {e}")),
            }
        }
        res
    })
    .await
}

#[derive(Default)]
struct CleanupStore {
    items: Mutex<Vec<cleanup::Item>>,
    generation: AtomicU64,
}

#[derive(Serialize)]
struct CleanupView {
    items: Vec<cleanup::ItemView>,
    pending: usize,
}

fn cleanup_view(store: &CleanupStore) -> CleanupView {
    let items = store.items.lock().unwrap();
    CleanupView { items: cleanup::view(&items), pending: items.iter().filter(|i| i.size.is_none()).count() }
}

#[tauri::command]
async fn cleanup_scan(state: State<'_, AppState>) -> Result<CleanupView, String> {
    let store = state.cleanup.clone();
    blocking(move || {
        let items = cleanup::build();
        let generation = store.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let work = items.clone();
        *store.items.lock().unwrap() = items;
        let bg = store.clone();
        std::thread::spawn(move || {
            use rayon::prelude::*;
            work.par_iter().for_each(|it| {
                if bg.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                let (size, files) = cleanup::compute(it);
                if bg.generation.load(Ordering::SeqCst) != generation {
                    return;
                }
                let mut list = bg.items.lock().unwrap();
                if let Some(slot) = list.iter_mut().find(|x| cleanup::id_of(x) == cleanup::id_of(it)) {
                    cleanup::set_size(slot, size, files);
                }
            });
        });
        cleanup_view(&store)
    })
    .await
}

#[tauri::command]
fn cleanup_items(state: State<'_, AppState>) -> CleanupView {
    cleanup_view(&state.cleanup)
}

#[tauri::command]
async fn cleanup_run(state: State<'_, AppState>, ids: Vec<String>) -> Result<cleanup::CleanResult, String> {
    let store = state.cleanup.clone();
    blocking(move || {
        let items = store.items.lock().unwrap().clone();
        cleanup::clean(&items, &ids)
    })
    .await
}

#[tauri::command]
async fn drop_caches() -> Result<u64, String> {
    let before = system::read_memory().available;
    blocking(|| util::run_privileged("sync; echo 3 > /proc/sys/vm/drop_caches")).await??;
    let after = system::read_memory().available;
    Ok(after.saturating_sub(before))
}

#[tauri::command]
async fn reset_swap() -> Result<u64, String> {
    let mem = system::read_memory();
    let needed: u64 = mem.swaps.iter().map(|s| s.used).max().unwrap_or(0);
    if mem.swap_used == 0 {
        return Err("Swap is already empty.".into());
    }
    if mem.available < needed + 768 * 1024 * 1024 {
        return Err("There is not enough free memory to move swap back into RAM. Close some apps first.".into());
    }
    let mut script = String::from("set -e\n");
    for s in &mem.swaps {
        let d = util::shell_quote(&s.device);
        let prio = if s.priority >= 0 { format!("-p {} ", s.priority) } else { String::new() };
        script.push_str(&format!("swapoff {d}\nswapon {prio}{d}\n"));
    }
    let before = mem.swap_used;
    blocking(move || util::run_privileged(&script)).await??;
    let after = system::read_memory().swap_used;
    Ok(before.saturating_sub(after))
}

#[tauri::command]
async fn open_path(path: String, reveal: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let target = if reveal && !p.is_dir() { p.parent().map(|x| x.to_path_buf()).unwrap_or(p) } else { p };
    util::host_command("xdg-open")
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the file manager: {e}"))
}

#[tauri::command]
fn home_dir() -> String {
    util::home().to_string_lossy().to_string()
}

fn main() {
    let state = AppState {
        sampler: Arc::new(Mutex::new(system::Sampler::new())),
        apps: Arc::new(Mutex::new(apps::AppDirectory::load())),
        scanner: Arc::new(analyzer::Scanner::default()),
        cleanup: Arc::new(CleanupStore::default()),
    };
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            snapshot,
            app_info,
            signal,
            signal_as_admin,
            set_priority,
            storage,
            reduce_reserved,
            scan_start,
            scan_cancel,
            scan_status,
            scan_list,
            scan_big_files,
            scan_rebuildable,
            delete_paths,
            cleanup_scan,
            cleanup_items,
            cleanup_run,
            drop_caches,
            reset_swap,
            open_path,
            home_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Clearsight");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_reports_processes_and_memory() {
        let mut s = system::Sampler::new();
        s.sample();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let snap = s.sample();
        assert!(!snap.processes.is_empty());
        assert!(snap.memory.total > 0);
        assert!(!snap.cpu_cores.is_empty());
        assert!(snap.processes.iter().any(|p| p.pid == std::process::id() as i32));
    }

    #[test]
    fn storage_has_a_root_volume() {
        let info = storage::storage_info();
        assert!(info.volumes.iter().any(|v| v.mount == "/") || info.volumes.is_empty());
    }

    #[test]
    fn protected_paths() {
        assert!(util::is_protected(std::path::Path::new("/")));
        assert!(util::is_protected(&util::home()));
        assert!(util::is_protected(&util::home().join(".config")));
        assert!(util::is_protected(std::path::Path::new("/usr/lib/x")));
        assert!(!util::is_protected(&util::home().join("Downloads/file.iso")));
    }

    #[test]
    fn base64_matches_reference() {
        assert_eq!(util::base64(b""), "");
        assert_eq!(util::base64(b"f"), "Zg==");
        assert_eq!(util::base64(b"fo"), "Zm8=");
        assert_eq!(util::base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn mount_paths_are_unescaped() {
        assert_eq!(util::unescape_mount("/media/me/My\\040Drive"), "/media/me/My Drive");
    }
}
