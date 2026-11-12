//! A phone without a phone: start the library from a config file on this
//! machine, the way the app does, and watch it.
//!
//!     cargo run --example probe -- config.json [--report telemetry.json]
//!
//! `config.json` is `daedalus_start`'s config (src/config.rs). It prints the
//! proxy as a URL — `curl --proxy http://USER:PASS@127.0.0.1:PORT
//! https://<the box's LAN address>:<proxy_port>/…` goes through the tunnel —
//! and the status every five seconds. With `--report` the file's telemetry
//! sample is handed to the link at the start and whenever the file changes.
//! Ctrl-C ends it.

use std::time::{Duration, SystemTime};

use daedalus_ios::config::Config;
use daedalus_ios::Node;

fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_max_level(tracing::Level::DEBUG)
        .init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (config, report) = match args.as_slice() {
        [config] => (config, None),
        [config, flag, report] if flag == "--report" => (config, Some(report)),
        _ => {
            eprintln!("usage: probe <config.json> [--report <telemetry.json>]");
            std::process::exit(2);
        }
    };
    let fail = |why: String| -> ! {
        eprintln!("probe: {why}");
        std::process::exit(1);
    };
    let text = std::fs::read_to_string(config).unwrap_or_else(|e| fail(format!("{config}: {e}")));
    let checked = Config::from_json(&text)
        .and_then(|c| c.checked())
        .unwrap_or_else(|e| fail(e));
    let node = Node::start(checked).unwrap_or_else(|e| fail(e));
    let p = node.proxy();
    println!("http://{}:{}@127.0.0.1:{}", p.username, p.password, p.port);

    let mut reported: Option<SystemTime> = None;
    loop {
        if let Some(path) = report {
            let changed = std::fs::metadata(path).and_then(|m| m.modified()).ok();
            if changed.is_some() && changed != reported {
                reported = changed;
                let sample = std::fs::read_to_string(path)
                    .map_err(|e| e.to_string())
                    .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
                    .and_then(|v| node.report(&v));
                match sample {
                    Ok(()) => eprintln!("probe: handed the link {path}"),
                    Err(e) => eprintln!("probe: {path}: {e}"),
                }
            }
        }
        println!(
            "{}",
            serde_json::to_string(&node.status()).unwrap_or_default()
        );
        std::thread::sleep(Duration::from_secs(5));
    }
}
