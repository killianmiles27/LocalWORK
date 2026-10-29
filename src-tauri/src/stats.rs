//! Machine stats for composer status items (`host:system_stats`). One background sampler fills a cache
//! while someone is asking for it and goes quiet after a short idle, so the command itself never blocks.
//! Every field is optional: a sensor this machine cannot read stays null and the UI shows "—".
//! Windows exposes no CPU temperature on many desktops (no ACPI thermal zone; AMD Tctl needs a kernel
//! driver), so there the CPU temperature stays null rather than depending on extra software.
//!
//! `host:power_stats` estimates electricity use: the GPU's measured draw (nvidia-smi) plus the CPU's rated
//! watts scaled by its load plus a fixed amount for the rest of the machine. The sampler integrates that
//! over time, per agent turn ("task") and per app session, and the plugin's price per kWh turns it into cost.
use crate::sync::LockExt;
use crate::supervisor;
use serde_json::{json, Value};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{Components, CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};

struct Cache {
    value: Value,
    last_ask: Instant,
    running: bool,
    power: Power,
}

#[derive(Default)]
struct Power {
    cpu_watts: f64,
    base_watts: f64,
    watts: Option<f64>,
    gpu_watts: Option<f64>,
    session_wh: f64,
    task_wh: f64,
    task_start: Option<Instant>,
    task_secs: f64,
    tasks: u64,
}

fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache { value: Value::Null, last_ask: Instant::now(), running: false, power: Power { cpu_watts: 65.0, base_watts: 40.0, ..Default::default() } }))
}

const IDLE: Duration = Duration::from_secs(15);
const PERIOD: Duration = Duration::from_millis(1500);

pub fn get() -> Value {
    wake();
    cache().guard().value.clone()
}

/// Keep the sampler running (it stops itself after IDLE without a request and without a task).
fn wake() {
    let start = {
        let mut c = cache().guard();
        c.last_ask = Instant::now();
        let start = !c.running;
        c.running = true;
        start
    };
    if start {
        std::thread::spawn(sampler);
    }
}

/// An agent turn started: energy from now on counts toward this task.
pub fn task_begin() {
    {
        let mut c = cache().guard();
        c.power.task_wh = 0.0;
        c.power.task_secs = 0.0;
        c.power.task_start = Some(Instant::now());
        c.power.tasks += 1;
    }
    wake();
}

pub fn task_end() {
    let mut c = cache().guard();
    if let Some(t) = c.power.task_start.take() { c.power.task_secs = t.elapsed().as_secs_f64(); }
}

/// Electricity estimate for the power-cost plugin. `settings` are that plugin's settings:
/// pricePerKwh, cpuWatts (rated CPU power at full load) and baseWatts (the rest of the machine).
pub fn power(settings: &Value) -> Value {
    let num = |k: &str, d: f64| settings.get(k).and_then(Value::as_f64).filter(|x| x.is_finite() && *x >= 0.0).unwrap_or(d);
    let price = num("pricePerKwh", 0.17);
    wake();
    let mut c = cache().guard();
    c.power.cpu_watts = num("cpuWatts", 65.0);
    c.power.base_watts = num("baseWatts", 40.0);
    let p = &c.power;
    let cost = |wh: f64| round_to(wh / 1000.0 * price, 5);
    let running = p.task_start.is_some();
    let secs = p.task_start.map(|t| t.elapsed().as_secs_f64()).unwrap_or(p.task_secs);
    json!({
        "watts": p.watts.map(|w| w.round()), "gpu_watts": p.gpu_watts.map(|w| w.round()),
        "cost_per_hour": p.watts.map(|w| round_to(w / 1000.0 * price, 4)),
        "task": if p.tasks == 0 { Value::Null } else { json!({"cost": cost(p.task_wh), "wh": round_to(p.task_wh, 3), "seconds": secs.round(), "running": running}) },
        "session": {"cost": cost(p.session_wh), "wh": round_to(p.session_wh, 2)},
        "price_per_kwh": price,
    })
}

fn round_to(x: f64, places: i32) -> f64 {
    let m = 10f64.powi(places);
    (x * m).round() / m
}

fn sampler() {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing().with_cpu_usage()).with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
    let mut comps = Components::new_with_refreshed_list();
    let mut gpu_ok = true;
    let mut last = Instant::now();
    loop {
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        comps.refresh(false);
        let cpu_temp = comps
            .iter()
            .filter(|c| {
                let l = c.label().to_ascii_lowercase();
                l.contains("cpu") || l.contains("tctl") || l.contains("package") || l.contains("thermal") || l.contains("acpi")
            })
            .filter_map(|c| c.temperature())
            .filter(|t| t.is_finite() && *t > 5.0 && *t < 125.0)
            .fold(None, |m: Option<f32>, t| Some(m.map_or(t, |m| m.max(t))));
        let gpu = if gpu_ok { nvidia() } else { None };
        if gpu.is_none() { gpu_ok = false; }
        let total = sys.total_memory() as f64 / 1073741824.0;
        let used = sys.used_memory() as f64 / 1073741824.0;
        let v = json!({
            "cpu": {"load": round1(sys.global_cpu_usage() as f64), "temp": cpu_temp.map(|t| round1(t as f64))},
            "ram": {"used_gib": round1(used), "total_gib": round1(total), "pct": if total > 0.0 { round1(used / total * 100.0) } else { 0.0 }},
            "gpu": gpu,
        });
        let gpu_w = v["gpu"]["power_w"].as_f64();
        let cpu_load = sys.global_cpu_usage() as f64 / 100.0;
        {
            let mut c = cache().guard();
            c.value = v;
            let dt_h = last.elapsed().as_secs_f64().min(10.0) / 3600.0;
            last = Instant::now();
            let p = &mut c.power;
            let w = gpu_w.unwrap_or(0.0) + p.cpu_watts * cpu_load + p.base_watts;
            p.watts = Some(w);
            p.gpu_watts = gpu_w;
            p.session_wh += w * dt_h;
            if p.task_start.is_some() { p.task_wh += w * dt_h; }
            if c.last_ask.elapsed() > IDLE && c.power.task_start.is_none() {
                c.running = false;
                return;
            }
        }
        std::thread::sleep(PERIOD);
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// First NVIDIA GPU via nvidia-smi; None when there is none (then it is not asked again this run).
fn nvidia() -> Option<Value> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args(["--query-gpu=temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw", "--format=csv,noheader,nounits"]);
    supervisor::hidden(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() { return None; }
    let line = String::from_utf8_lossy(&out.stdout).lines().next()?.to_string();
    let p: Vec<f64> = line.split(',').map(|s| s.trim().parse::<f64>().unwrap_or(f64::NAN)).collect();
    if p.len() < 4 { return None; }
    let n = |x: f64| if x.is_finite() { json!(x) } else { Value::Null };
    Some(json!({
        "temp": n(p[0]), "load": n(p[1]),
        "vram_used_gib": n(round1(p[2] / 1024.0)), "vram_total_gib": n(round1(p[3] / 1024.0)),
        "vram_pct": if p[3] > 0.0 { n(round1(p[2] / p[3] * 100.0)) } else { Value::Null },
        "power_w": p.get(4).map_or(Value::Null, |w| n(round1(*w))),
    }))
}
