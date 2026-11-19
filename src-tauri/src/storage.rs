use crate::util::{home, mounts, run, statvfs};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone)]
pub struct Layer {
    pub kind: String,
    pub name: String,
    pub detail: String,
}

#[derive(Serialize, Clone)]
pub struct Volume {
    pub mount: String,
    pub label: String,
    pub role: String,
    pub device: String,
    pub fstype: String,
    pub size: u64,
    pub used: u64,
    pub avail: u64,
    pub reserved: u64,
    pub encryption: Option<String>,
    pub layers: Vec<Layer>,
    pub disk: Option<String>,
    pub backed_by: Option<String>,
    pub removable: bool,
    pub can_reduce_reserved: bool,
}

#[derive(Serialize, Clone)]
pub struct Partition {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub fstype: String,
    pub label: String,
    pub mounts: Vec<String>,
    pub role: String,
    pub depth: u32,
}

#[derive(Serialize, Clone)]
pub struct PhysDisk {
    pub name: String,
    pub model: String,
    pub size: u64,
    pub kind: String,
    pub removable: bool,
    pub parts: Vec<Partition>,
}

#[derive(Serialize, Clone)]
pub struct RamDisk {
    pub mount: String,
    pub size: u64,
    pub used: u64,
}

#[derive(Serialize, Clone)]
pub struct StorageInfo {
    pub disks: Vec<PhysDisk>,
    pub volumes: Vec<Volume>,
    pub ram_disks: Vec<RamDisk>,
}

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn n(v: &Value, k: &str) -> u64 {
    match v.get(k) {
        Some(Value::Number(x)) => x.as_u64().unwrap_or(0),
        Some(Value::String(x)) => x.parse().unwrap_or(0),
        _ => 0,
    }
}

fn b(v: &Value, k: &str) -> bool {
    match v.get(k) {
        Some(Value::Bool(x)) => *x,
        Some(Value::String(x)) => x == "1" || x == "true",
        Some(Value::Number(x)) => x.as_u64() == Some(1),
        _ => false,
    }
}

fn mountpoints(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(Value::Array(a)) = v.get("mountpoints") {
        for m in a {
            if let Value::String(x) = m {
                out.push(x.clone());
            }
        }
    } else if let Some(Value::String(x)) = v.get("mountpoint") {
        out.push(x.clone());
    }
    out
}

fn disk_kind(name: &str, tran: &str, rota: bool, rm: bool) -> String {
    if tran == "usb" || rm {
        return if rota { "External hard drive (USB)".into() } else { "External drive (USB)".into() };
    }
    if name.starts_with("nvme") || tran == "nvme" {
        return "NVMe SSD".into();
    }
    if name.starts_with("mmcblk") {
        return "Memory card".into();
    }
    if rota {
        "Hard drive".into()
    } else {
        "SSD".into()
    }
}

fn friendly(mount: &str, label: &str) -> (String, String) {
    let h = home();
    let hs = h.to_string_lossy();
    match mount {
        "/" => ("System".into(), "system".into()),
        "/boot" => ("Boot files".into(), "boot".into()),
        "/boot/efi" => ("Boot partition (EFI)".into(), "boot".into()),
        "/home" => ("Home folders".into(), "home".into()),
        m if m == hs => ("Your home folder".into(), "home".into()),
        m if m.starts_with("/media/") || m.starts_with("/run/media/") || m.starts_with("/mnt/") => {
            let name = if label.is_empty() { m.rsplit('/').next().unwrap_or(m).to_string() } else { label.to_string() };
            (name, "external".into())
        }
        m => (if label.is_empty() { m.to_string() } else { label.to_string() }, "data".into()),
    }
}

fn walk(
    node: &Value,
    chain: &[Layer],
    disk_name: &str,
    disk_rm: bool,
    depth: u32,
    parts: &mut Vec<Partition>,
    volumes: &mut Vec<Volume>,
) {
    let typ = s(node, "type");
    let name = s(node, "name");
    let fstype = s(node, "fstype");
    let size = n(node, "size");
    let mps = mountpoints(node);
    let label = s(node, "label");

    let mut chain = chain.to_vec();
    match typ.as_str() {
        "part" => chain.push(Layer { kind: "part".into(), name: name.clone(), detail: "Partition".into() }),
        "lvm" => {
            let (vg, lv) = split_lvm(&name);
            chain.push(Layer {
                kind: "lvm".into(),
                name: lv,
                detail: format!("LVM logical volume in group \"{vg}\""),
            });
        }
        "crypt" => chain.push(Layer {
            kind: "crypt".into(),
            name: name.clone(),
            detail: "Encrypted container (LUKS), unlocked".into(),
        }),
        "raid0" | "raid1" | "raid5" | "raid6" | "raid10" => {
            chain.push(Layer { kind: "raid".into(), name: name.clone(), detail: format!("Software RAID ({typ})") })
        }
        _ => {}
    }

    let role = if mps.iter().any(|m| m == "[SWAP]") || fstype == "swap" {
        "Swap space".to_string()
    } else if fstype == "crypto_LUKS" {
        "Encrypted container (LUKS)".to_string()
    } else if fstype == "LVM2_member" {
        "LVM physical volume".to_string()
    } else if fstype == "vfat" && mps.iter().any(|m| m.starts_with("/boot")) {
        "Boot partition (EFI)".to_string()
    } else if !mps.is_empty() {
        format!("Mounted at {}", mps.join(", "))
    } else if fstype.is_empty() {
        "Unformatted or reserved".to_string()
    } else {
        format!("{fstype}, not mounted")
    };

    if typ != "disk" {
        parts.push(Partition {
            name: name.clone(),
            path: s(node, "path"),
            size,
            fstype: fstype.clone(),
            label: label.clone(),
            mounts: mps.iter().filter(|m| *m != "[SWAP]").cloned().collect(),
            role,
            depth,
        });
    }

    if let Some(mount) = mps.iter().find(|m| !m.starts_with('[') && !m.starts_with("/snap/")) {
        if let Some(st) = statvfs(mount) {
            let encryption = if chain.iter().any(|l| l.kind == "crypt") {
                Some("LUKS full-disk encryption".to_string())
            } else if fstype == "crypto_LUKS" {
                Some("LUKS".into())
            } else {
                None
            };
            let (flabel, frole) = friendly(mount, &label);
            let reserved = st.free.saturating_sub(st.avail);
            let mut layers = chain.clone();
            layers.push(Layer {
                kind: "fs".into(),
                name: mount.clone(),
                detail: format!("{} file system", fs_name(&fstype)),
            });
            volumes.push(Volume {
                mount: mount.clone(),
                label: flabel,
                role: frole,
                device: s(node, "path"),
                fstype: fstype.clone(),
                size: st.size,
                used: st.used,
                avail: st.avail,
                reserved,
                encryption,
                layers,
                disk: Some(disk_name.to_string()),
                backed_by: None,
                removable: disk_rm,
                can_reduce_reserved: fstype.starts_with("ext")
                    && st.size > 30 * 1024 * 1024 * 1024
                    && reserved as f64 > st.size as f64 * 0.015,
            });
        }
    }

    if let Some(Value::Array(children)) = node.get("children") {
        for c in children {
            walk(c, &chain, disk_name, disk_rm, depth + 1, parts, volumes);
        }
    }
}

fn split_lvm(name: &str) -> (String, String) {
    let bytes: Vec<char> = name.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '-' {
            if i + 1 < bytes.len() && bytes[i + 1] == '-' {
                i += 2;
                continue;
            }
            let vg: String = bytes[..i].iter().collect();
            let lv: String = bytes[i + 1..].iter().collect();
            return (vg.replace("--", "-"), lv.replace("--", "-"));
        }
        i += 1;
    }
    (name.to_string(), name.to_string())
}

pub fn fs_name(fstype: &str) -> String {
    match fstype {
        "ext4" => "ext4".into(),
        "ext3" => "ext3".into(),
        "btrfs" => "Btrfs".into(),
        "xfs" => "XFS".into(),
        "ntfs" | "ntfs3" | "fuseblk" => "NTFS (Windows)".into(),
        "vfat" => "FAT32".into(),
        "exfat" => "exFAT".into(),
        "ecryptfs" => "eCryptfs (encrypted)".into(),
        "zfs" => "ZFS".into(),
        "f2fs" => "F2FS".into(),
        "nfs" | "nfs4" => "NFS network".into(),
        "cifs" | "smb3" => "Windows network share".into(),
        other => other.to_string(),
    }
}

pub fn storage_info() -> StorageInfo {
    let mut disks = Vec::new();
    let mut volumes = Vec::new();
    let out = run(
        "lsblk",
        &["-J", "-b", "-o", "NAME,PATH,TYPE,SIZE,FSTYPE,MOUNTPOINTS,LABEL,MODEL,TRAN,ROTA,RM"],
    );
    if let Some(out) = out {
        if let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) {
            if let Some(Value::Array(devs)) = v.get("blockdevices") {
                for d in devs {
                    let name = s(d, "name");
                    let typ = s(d, "type");
                    if typ != "disk" || name.starts_with("zram") || name.starts_with("loop") || name.starts_with("ram") {
                        continue;
                    }
                    let model = s(d, "model");
                    let tran = s(d, "tran");
                    let rota = b(d, "rota");
                    let rm = b(d, "rm") || tran == "usb";
                    let disk_layer = Layer {
                        kind: "disk".into(),
                        name: name.clone(),
                        detail: format!(
                            "{}{}",
                            disk_kind(&name, &tran, rota, rm),
                            if model.is_empty() { String::new() } else { format!(", {model}") }
                        ),
                    };
                    let mut parts = Vec::new();
                    walk(d, &[disk_layer], &name, rm, 0, &mut parts, &mut volumes);
                    disks.push(PhysDisk {
                        name: name.clone(),
                        model: if model.is_empty() { name.clone() } else { model },
                        size: n(d, "size"),
                        kind: disk_kind(&name, &tran, rota, rm),
                        removable: rm,
                        parts,
                    });
                }
            }
        }
    }

    let all_mounts = mounts();
    let mut ram_disks = Vec::new();
    for m in &all_mounts {
        let networked = matches!(m.fstype.as_str(), "nfs" | "nfs4" | "cifs" | "smb3" | "fuse.sshfs" | "fuse.rclone");
        if m.fstype == "ecryptfs" || networked {
            if volumes.iter().any(|v| v.mount == m.target) {
                continue;
            }
            let st = match statvfs(&m.target) {
                Some(s) => s,
                None => continue,
            };
            let mut source = m.source.clone();
            if m.fstype == "ecryptfs" {
                source = crate::util::ecryptfs_lower(m);
            }
            let backing = if m.fstype == "ecryptfs" {
                volumes
                    .iter()
                    .filter(|v| source.starts_with(&v.mount) && (v.mount == "/" || source[v.mount.len()..].starts_with('/')))
                    .max_by_key(|v| v.mount.len())
                    .cloned()
            } else {
                None
            };
            let (label, role) = friendly(&m.target, "");
            let mut layers = backing.as_ref().map(|b| b.layers.clone()).unwrap_or_default();
            if m.fstype == "ecryptfs" {
                layers.push(Layer {
                    kind: "crypt".into(),
                    name: source.clone(),
                    detail: "Encrypted folder (eCryptfs), unlocked when you log in".into(),
                });
            }
            layers.push(Layer {
                kind: "fs".into(),
                name: m.target.clone(),
                detail: format!("{} file system", fs_name(&m.fstype)),
            });
            volumes.push(Volume {
                mount: m.target.clone(),
                label,
                role: if networked { "network".into() } else { role },
                device: source,
                fstype: m.fstype.clone(),
                size: st.size,
                used: st.used,
                avail: st.avail,
                reserved: st.free.saturating_sub(st.avail),
                encryption: if m.fstype == "ecryptfs" { Some("eCryptfs encrypted folder".into()) } else { None },
                layers,
                disk: backing.as_ref().and_then(|b| b.disk.clone()),
                backed_by: backing.map(|b| b.mount),
                removable: false,
                can_reduce_reserved: false,
            });
        } else if m.fstype == "tmpfs" && (m.target == "/tmp" || m.target == "/dev/shm" || m.target.starts_with("/run/user/")) {
            if let Some(st) = statvfs(&m.target) {
                if st.used > 1024 * 1024 {
                    ram_disks.push(RamDisk { mount: m.target.clone(), size: st.size, used: st.used });
                }
            }
        }
    }

    let rank = |v: &Volume| match v.role.as_str() {
        "system" => 0,
        "home" => 1,
        "data" => 2,
        "external" => 3,
        "network" => 4,
        _ => 5,
    };
    volumes.sort_by(|a, b| rank(a).cmp(&rank(b)).then(a.mount.cmp(&b.mount)));
    StorageInfo { disks, volumes, ram_disks }
}
