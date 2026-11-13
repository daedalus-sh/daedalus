//! The telemetry document's types: the machine and its parts as the status
//! page, the link and `/nodes/metrics` carry them (`Telemetry` and everything in it, and
//! `public()`, the open page's view of it), and the three halves a
//! collector hands back (`Static`, `Slow`, `Sample`) before `assemble`
//! joins them.

use serde::{Deserialize, Serialize};

/// The machine as hardware: what it is, who made it, what firmware it runs.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Machine {
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    /// The chip a Mac is built on ("Apple M3 Pro", or the Intel CPU type
    /// `system_profiler` states). None on Windows.
    pub chip: Option<String>,
    pub bios_vendor: Option<String>,
    pub bios_version: Option<String>,
    /// As the firmware states it, e.g. "2025-03-11" or "03/11/2025".
    pub bios_date: Option<String>,
    pub board_manufacturer: Option<String>,
    pub board_product: Option<String>,
    /// What shape the machine is: "laptop" | "desktop" | "tower" | "mini" |
    /// "all-in-one" | "server" | "tablet" | "phone", from the chassis type
    /// (SMBIOS type 3 on Windows, the model name on a Mac, the device idiom
    /// on iOS). None when not stated.
    pub form: Option<String>,
    /// Apple's board target (`hw.target`, "J516sAP"): the name Apple's own
    /// software catalogue lists supported machines by, which the model
    /// identifier is not. None on Windows.
    pub target: Option<String>,
}

/// The operating system, beyond the name and version facts.rs already carries.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Os {
    /// The kernel: Darwin's `uname -r` on a Mac, the NT build on Windows.
    pub kernel: Option<String>,
    /// The OS's build string: `sw_vers`'s ("23G93") on a Mac, `BuildLabEx`
    /// on Windows.
    pub build: Option<String>,
    /// When the OS was installed, RFC 3339, when known.
    pub installed_at: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Cpu {
    pub model: Option<String>,
    pub cores: Option<u32>,
    pub threads: Option<u32>,
    /// Base or current frequency, whichever the OS states.
    pub frequency_mhz: Option<u64>,
    /// 0–100 across all logical processors, since the previous sample.
    pub usage_pct: Option<f64>,
    /// 1, 5 and 15 minute load averages, where the OS has them (macOS).
    pub load: Option<[f64; 3]>,
    /// Package temperature, where readable.
    pub temperature_c: Option<f64>,
}

/// One stick, as the firmware describes it (SMBIOS type 17; on Apple
/// Silicon the memory is on the package and is reported as one module).
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MemoryModule {
    /// The slot's name as the board labels it: "DIMM_A1", "Controller0-ChannelA".
    pub locator: Option<String>,
    pub size_bytes: Option<u64>,
    pub speed_mts: Option<u32>,
    /// "DDR5", "LPDDR5"…
    pub kind: Option<String>,
    pub manufacturer: Option<String>,
    pub part_number: Option<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Memory {
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    /// File cache the OS would drop under pressure: `SystemCache` on
    /// Windows (the standby list plus the system working set), file-backed
    /// pages on a Mac.
    pub cached_bytes: Option<u64>,
    /// Memory held compressed rather than swapped (both OSes do this).
    pub compressed_bytes: Option<u64>,
    /// Windows: the commit charge and its limit (RAM plus pagefile).
    pub committed_bytes: Option<u64>,
    pub commit_limit_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
    /// The slots on the board and the ceiling the firmware states, static.
    pub slots: Option<u32>,
    pub max_capacity_bytes: Option<u64>,
    pub modules: Vec<MemoryModule>,
}

/// A mounted volume: what the OS shows as a drive letter or a mount point.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Disk {
    /// "C:" or "/".
    pub mount: String,
    /// The volume's name, when it has one ("Macintosh HD", a Windows label).
    pub name: Option<String>,
    pub fs: Option<String>,
    pub total_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    /// "nvme" (Windows only) | "ssd" | "hdd", when known.
    pub kind: Option<String>,
}

/// A physical drive, as opposed to a volume: the object you would replace.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Drive {
    /// The model string, as the drive reports it.
    pub name: String,
    /// Stripped from the open page (`Telemetry::public`).
    pub serial: Option<String>,
    pub firmware: Option<String>,
    pub size_bytes: Option<u64>,
    /// "nvme" | "sata" | "usb" | "thunderbolt" | "sd" | …, lowercase.
    pub bus: Option<String>,
    /// "ssd" | "hdd" (Windows also "scm"), when the OS says.
    pub kind: Option<String>,
    /// The OS's own verdict: "healthy" | "warning" | "unhealthy" on Windows,
    /// "verified" | "failing" | "not supported" from SMART on a Mac;
    /// "verified" | "failing" | "asleep" (in standby, left unwoken) on Linux.
    pub health: Option<String>,
    pub temperature_c: Option<f64>,
    pub power_on_hours: Option<u64>,
    /// Endurance spent, 0–100, where the drive reports it.
    pub wear_pct: Option<f64>,
    pub read_errors: Option<u64>,
    pub write_errors: Option<u64>,
    pub removable: Option<bool>,
    /// The mounts that live on it ("C:", "D:", "/").
    pub volumes: Vec<String>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Gpu {
    pub name: String,
    pub vendor: Option<String>,
    /// The driver version as the OS states it ("32.0.31041.1004").
    pub driver: Option<String>,
    /// The version the vendor markets it as, where derivable: "Adrenalin
    /// 25.9.2" from the value AMD's driver writes beside its own, "GeForce
    /// 566.14" from the last five digits of NVIDIA's. None elsewhere.
    pub driver_brand: Option<String>,
    /// When the driver was built, "YYYY-MM-DD", where stated.
    pub driver_date: Option<String>,
    pub vram_total_bytes: Option<u64>,
    pub vram_used_bytes: Option<u64>,
    /// 0–100, since the previous sample.
    pub usage_pct: Option<f64>,
    pub temperature_c: Option<f64>,
    /// Watts drawn, where readable.
    pub power_w: Option<f64>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Temperature {
    /// "CPU", "GPU", "SSD", "Battery"…
    pub label: String,
    pub celsius: f64,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Network {
    pub interface: String,
    /// Counters since boot, bytes.
    pub rx_bytes: Option<u64>,
    pub tx_bytes: Option<u64>,
    /// Bytes per second since the previous sample.
    pub rx_bps: Option<f64>,
    pub tx_bps: Option<f64>,
}

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Battery {
    pub percent: Option<f64>,
    pub charging: Option<bool>,
    /// Design capacity that remains, 0–100, where readable.
    pub health_pct: Option<f64>,
    /// Charge cycles completed, where the OS counts them (a Mac does).
    pub cycles: Option<u64>,
    /// The OS's own verdict on the battery, as it words it: "Normal",
    /// "Service Recommended".
    pub condition: Option<String>,
    /// Low Power Mode is on: a phone's or a tablet's word (a light node).
    /// None where the OS has no such switch or nobody reads it.
    pub low_power: Option<bool>,
}

/// What kind of thing an accessory is. `unknown`: a newer app's word.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessoryKind {
    /// An Apple Watch, as its paired iPhone reports it.
    Watch,
    #[default]
    #[serde(other)]
    Unknown,
}

impl AccessoryKind {
    /// The word on the wire, for a metric's label.
    pub fn as_str(self) -> &'static str {
        match self {
            AccessoryKind::Watch => "watch",
            AccessoryKind::Unknown => "unknown",
        }
    }
}

/// A device that is not a node — it holds no key and no link — and that a
/// light node reports inside its own sample: an Apple Watch, read by its
/// watchOS app and handed to the paired iPhone. An agent reports none.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Accessory {
    pub kind: AccessoryKind,
    /// What its owner called it: "Santiago’s Apple Watch".
    pub name: Option<String>,
    /// The device identifier: "Watch7,5".
    pub model: Option<String>,
    /// "watchOS".
    pub os_name: Option<String>,
    /// "26.1".
    pub os_version: Option<String>,
    /// "23S37".
    pub os_build: Option<String>,
    /// `percent`, `charging` and `low_power`; the rest is not a watch's to say.
    pub battery: Option<Battery>,
    pub storage_total_bytes: Option<u64>,
    pub storage_free_bytes: Option<u64>,
    /// When the accessory itself read this, RFC 3339: older than the
    /// document's `sampled_at` whenever the phone repeats its last word.
    pub sampled_at: Option<String>,
}

/// The most accessories the controller keeps of one sample.
pub const MAX_ACCESSORIES: usize = 4;
/// The longest text an accessory may carry in one field, in bytes.
pub const MAX_ACCESSORY_TEXT: usize = 256;

/// An application installed on the machine, from wherever the OS records
/// installs: the Uninstall registry keys, the Store and the game launchers
/// on Windows; the Applications folders on a Mac. Read with the slow facts.
/// Stripped from the open page: what a person has installed is theirs.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct App {
    pub name: String,
    pub version: Option<String>,
    pub publisher: Option<String>,
    /// "YYYY-MM-DD" where the OS records it.
    pub installed_at: Option<String>,
    pub size_bytes: Option<u64>,
    /// "app" | "game" | "launcher" | "runtime" | "driver"
    pub kind: String,
    /// Where it was found: "registry" | "store" | "steam" | "epic" on
    /// Windows; "applications" | "app-store" | "homebrew" | "setapp" |
    /// "apple" on a Mac.
    pub source: Option<String>,
    /// Install location. Stripped from the open page.
    pub path: Option<String>,
}

/// One of the heaviest processes. Stripped from the open page.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Process {
    /// The image name, without its path: "chrome.exe", "WindowServer".
    pub name: String,
    pub pid: u32,
    /// Resident memory (working set / RSS).
    pub memory_bytes: Option<u64>,
    /// Percent of one core (above 100 on several cores), where measured:
    /// since the previous sample on Windows, `ps`'s decaying average on a Mac.
    pub cpu_pct: Option<f64>,
}

/// A Chromium-based browser installed on the machine.
///
/// Read every ten minutes with the drives and services: the version moves
/// when the browser updates itself, and whether it is running comes from a
/// process list the slow read takes for itself. Chrome, Edge, Brave, Arc,
/// Vivaldi, Opera and a bare Chromium are the kinds looked for; Firefox and
/// Safari are not Chromium and are not here.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Browser {
    /// "Google Chrome", "Microsoft Edge", "Brave", "Arc", "Chromium", "Vivaldi", "Opera".
    pub name: String,
    /// "chrome" | "edge" | "brave" | "arc" | "chromium" | "vivaldi" | "opera".
    pub kind: String,
    /// The browser's own version, "128.0.6613.120".
    pub version: Option<String>,
    /// "stable" | "beta" | "dev" | "canary", where the install says.
    pub channel: Option<String>,
    /// Where it is installed. Stripped from the open page: a per-user
    /// install path carries the user's name.
    pub path: Option<String>,
    /// Whether any of its processes is running right now.
    pub running: bool,
    /// Whether it is the console user's default browser for http.
    pub default_browser: bool,
}

/// A service that should be running and is not. Stripped from the open page.
///
/// Windows: an Automatic service that is not running, with an exit code
/// other than 0 or 1077 (never started). macOS: a launchd job in the system
/// domain that is not running and whose last exit status was non-zero,
/// Apple's own excluded.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Service {
    pub name: String,
    pub display: Option<String>,
    /// "stopped" | "start pending" | "exited"…
    pub state: String,
    pub exit_code: Option<i64>,
}

/// One update the OS has pending.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Update {
    pub title: String,
    /// "KB5043076" on Windows, the label on a Mac.
    pub id: Option<String>,
    pub size_bytes: Option<u64>,
    /// "critical" | "important" | "moderate" | "low" | "recommended"…
    pub severity: Option<String>,
    /// Whether installing it restarts the machine, where stated.
    pub restart: Option<bool>,
}

/// One update the OS installed.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Installed {
    pub title: String,
    /// RFC 3339, or the date as the OS states it.
    pub at: Option<String>,
}

/// What the OS's own updater says. Stripped from the open page.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Updates {
    /// When the search ran, RFC 3339.
    pub checked_at: Option<String>,
    pub pending: Vec<Update>,
    /// The most recent few, newest first.
    pub installed: Vec<Installed>,
    /// Whether the OS is waiting for a restart to finish an install.
    pub reboot_pending: Option<bool>,
    /// Why the search did not answer, when it did not.
    pub error: Option<String>,
}

/// The whole document.
#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Telemetry {
    pub sampled_at: String,
    pub machine: Machine,
    pub os: Os,
    pub cpu: Cpu,
    pub memory: Memory,
    pub disks: Vec<Disk>,
    pub drives: Vec<Drive>,
    pub gpus: Vec<Gpu>,
    pub temperatures: Vec<Temperature>,
    pub network: Vec<Network>,
    pub battery: Option<Battery>,
    /// What the device reports beside itself: a light node's paired watch.
    /// Absent from the wire when there is none, as an agent's always is.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    #[cfg_attr(test, ts(as = "Option<Vec<Accessory>>", optional))]
    pub accessories: Vec<Accessory>,
    /// The heaviest by memory, at most `TOP_PROCESSES`.
    pub processes: Vec<Process>,
    pub process_count: Option<u32>,
    pub services: Vec<Service>,
    /// How many services the OS has in total, for the page's "of N installed".
    pub service_count: Option<u32>,
    /// The Chromium-based browsers installed, read with the slow facts.
    pub browsers: Vec<Browser>,
    /// What is installed, read with the slow facts; empty on the open page.
    pub apps: Vec<App>,
    /// How many, which the open page keeps: a count is not a list.
    pub app_count: Option<usize>,
    /// None until the first search lands.
    pub updates: Option<Updates>,
    /// What could not be read, one line each, so the page says "not
    /// readable on this OS" rather than showing a dash without a reason.
    pub errors: Vec<String>,
}

impl Telemetry {
    /// The document as the open status page carries it: the machine, not
    /// the person using it.
    pub fn public(&self) -> Telemetry {
        let mut t = self.clone();
        for d in &mut t.drives {
            d.serial = None;
        }
        t.processes.clear();
        t.services.clear();
        for b in &mut t.browsers {
            b.path = None;
        }
        t.apps.clear();
        t.updates = None;
        t
    }

    /// The document at `telemetry = "minimal"`: the machine and how it is
    /// doing — make, model, firmware, OS, processor, memory, volumes, GPUs,
    /// temperatures, network, battery, the process COUNT and
    /// what could not be read. Nothing of the slow read (drives with their
    /// serials and SMART, services, browsers, installed applications) and
    /// no OS updates: the sampler never reads those at this level
    /// (telemetry.rs `run_loop`). Processes are sampled — the count needs
    /// them — but their list is dropped here. This is what
    /// makes the document say so whatever a collector handed back.
    pub fn minimal(&self) -> Telemetry {
        let mut t = self.public();
        t.drives.clear();
        t.browsers.clear();
        t.service_count = None;
        t.app_count = None;
        t
    }

    /// The document as the controller keeps a machine's: at most
    /// `MAX_ACCESSORIES` accessories (the first ones), each text cut to
    /// `MAX_ACCESSORY_TEXT` bytes without control characters, and of an
    /// accessory's battery only what a watch says.
    pub fn bounded(mut self) -> Telemetry {
        self.accessories.truncate(MAX_ACCESSORIES);
        for a in &mut self.accessories {
            for s in [
                &mut a.name,
                &mut a.model,
                &mut a.os_name,
                &mut a.os_version,
                &mut a.os_build,
                &mut a.sampled_at,
            ] {
                *s = s.take().map(|v| short_text(&v)).filter(|v| !v.is_empty());
            }
            if let Some(b) = &mut a.battery {
                *b = Battery {
                    percent: b.percent,
                    charging: b.charging,
                    low_power: b.low_power,
                    ..Default::default()
                };
            }
        }
        self
    }
}

/// `s` trimmed, without control characters, cut at a character boundary to
/// at most `MAX_ACCESSORY_TEXT` bytes.
fn short_text(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > MAX_ACCESSORY_TEXT {
            break;
        }
        out.push(c);
    }
    out
}

/// The static half, read rarely.
#[derive(Clone, Debug, Default)]
pub struct Static {
    pub machine: Machine,
    pub os: Os,
    /// Model, cores, threads and frequency; usage and load are sampled.
    pub cpu: Cpu,
    /// Names, vendors, drivers and VRAM totals; usage is sampled.
    pub gpus: Vec<Gpu>,
    pub memory_slots: Option<u32>,
    pub memory_max_capacity_bytes: Option<u64>,
    pub memory_modules: Vec<MemoryModule>,
    pub errors: Vec<String>,
}

/// The slow half: a shell-out or two, every ten minutes.
#[derive(Clone, Debug, Default)]
pub struct Slow {
    pub drives: Vec<Drive>,
    pub services: Vec<Service>,
    pub service_count: Option<u32>,
    /// The Chromium-based browsers installed, read with the slow facts.
    pub browsers: Vec<Browser>,
    /// What is installed, tidied (`tidy_apps`) by the collector.
    pub apps: Vec<App>,
    pub errors: Vec<String>,
}

/// The sampled half.
#[derive(Clone, Debug, Default)]
pub struct Sample {
    pub cpu_usage_pct: Option<f64>,
    pub load: Option<[f64; 3]>,
    pub cpu_temperature_c: Option<f64>,
    /// Everything but the static slots/ceiling/modules, which `assemble` fills.
    pub memory: Memory,
    pub disks: Vec<Disk>,
    /// Indexed like `Static::gpus`; a shorter list leaves the rest unsampled.
    pub gpu_usage: Vec<GpuSample>,
    pub temperatures: Vec<Temperature>,
    pub network: Vec<Network>,
    pub battery: Option<Battery>,
    pub processes: Vec<Process>,
    pub process_count: Option<u32>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct GpuSample {
    pub vram_used_bytes: Option<u64>,
    pub usage_pct: Option<f64>,
    pub temperature_c: Option<f64>,
    pub power_w: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch() -> serde_json::Value {
        serde_json::json!({
            "kind": "watch",
            "name": "Santiago’s Apple Watch",
            "model": "Watch7,5",
            "os_name": "watchOS",
            "os_version": "26.1",
            "os_build": "23S37",
            "battery": {"percent": 64.0, "charging": false, "low_power": false},
            "storage_total_bytes": 64_000_000_000u64,
            "storage_free_bytes": 41_000_000_000u64,
            "sampled_at": "2026-11-12T09:58:30Z"
        })
    }

    #[test]
    fn accessories_are_absent_when_there_are_none_and_read_back_when_there_are() {
        // An agent's document: no key at all, so nothing it wrote before moves.
        let none = serde_json::to_value(Telemetry::default()).unwrap();
        assert!(none.get("accessories").is_none());
        let t: Telemetry = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(t.accessories.is_empty());

        let t: Telemetry =
            serde_json::from_value(serde_json::json!({"accessories": [watch()]})).unwrap();
        let a = &t.accessories[0];
        assert_eq!(a.kind, AccessoryKind::Watch);
        assert_eq!(a.model.as_deref(), Some("Watch7,5"));
        assert_eq!(
            (
                a.os_name.as_deref(),
                a.os_version.as_deref(),
                a.os_build.as_deref()
            ),
            (Some("watchOS"), Some("26.1"), Some("23S37"))
        );
        let b = a.battery.as_ref().unwrap();
        assert_eq!(
            (b.percent, b.charging, b.low_power),
            (Some(64.0), Some(false), Some(false))
        );
        assert_eq!(
            (a.storage_total_bytes, a.storage_free_bytes),
            (Some(64_000_000_000), Some(41_000_000_000))
        );
        // The wire: every key of an accessory, a battery's every key.
        assert_eq!(
            serde_json::to_string(&t.accessories).unwrap(),
            concat!(
                r#"[{"kind":"watch","name":"Santiago’s Apple Watch","model":"Watch7,5","#,
                r#""os_name":"watchOS","os_version":"26.1","os_build":"23S37","#,
                r#""battery":{"percent":64.0,"charging":false,"health_pct":null,"cycles":null,"#,
                r#""condition":null,"low_power":false},"#,
                r#""storage_total_bytes":64000000000,"storage_free_bytes":41000000000,"#,
                r#""sampled_at":"2026-11-12T09:58:30Z"}]"#
            )
        );
        // A newer app's kind is read, not refused; an accessory that says
        // nothing is one with nothing known.
        let t: Telemetry =
            serde_json::from_value(serde_json::json!({"accessories": [{"kind": "ring"}, {}]}))
                .unwrap();
        assert_eq!(t.accessories[0].kind, AccessoryKind::Unknown);
        assert_eq!(t.accessories[1], Accessory::default());
        assert_eq!(
            serde_json::to_value(AccessoryKind::Unknown).unwrap(),
            "unknown"
        );
    }

    #[test]
    fn the_controller_keeps_four_accessories_and_short_clean_text() {
        let mut long = watch();
        long["name"] = format!("  W\u{7}atch\n{}", "é".repeat(400)).into();
        long["model"] = "   ".into();
        long["battery"] = serde_json::json!({
            "percent": 50.0, "charging": true, "low_power": true,
            "health_pct": 91.0, "cycles": 300, "condition": "x".repeat(5000)
        });
        let many: Vec<serde_json::Value> = std::iter::once(long)
            .chain((0..6).map(|_| watch()))
            .collect();
        let t: Telemetry =
            serde_json::from_value(serde_json::json!({"accessories": many})).unwrap();
        let t = t.bounded();
        assert_eq!(t.accessories.len(), MAX_ACCESSORIES);
        let a = &t.accessories[0];
        let name = a.name.as_deref().unwrap();
        assert!(name.starts_with("Watché"), "{name}");
        assert!(name.len() <= MAX_ACCESSORY_TEXT && name.len() > MAX_ACCESSORY_TEXT - 2);
        assert_eq!(a.model, None);
        assert_eq!(
            a.battery,
            Some(Battery {
                percent: Some(50.0),
                charging: Some(true),
                low_power: Some(true),
                ..Default::default()
            })
        );
        // What was already within bounds is kept as it came.
        assert_eq!(
            t.accessories[1].name.as_deref(),
            Some("Santiago’s Apple Watch")
        );
        // A document without accessories is untouched.
        let plain = Telemetry {
            sampled_at: "t".into(),
            ..Default::default()
        };
        assert_eq!(plain.clone().bounded(), plain);
    }
}
