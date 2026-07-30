//! Real native watcher contract exercised only through the supervised repository command.

use std::{
    env,
    error::Error,
    fs,
    path::PathBuf,
    sync::mpsc,
    time::{Duration, Instant},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

const EVENT_DEADLINE: Duration = Duration::from_secs(5);
const WATCHER_COUNT: usize = 4;

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os();
    let _executable = arguments.next();
    let root = arguments
        .next()
        .ok_or("native watcher probe requires one supervisor-owned root path")?;
    if arguments.next().is_some() {
        return Err("native watcher probe accepts exactly one root path".into());
    }
    let root = PathBuf::from(root).canonicalize()?;
    let mut probes = Vec::with_capacity(WATCHER_COUNT);
    for index in 0..WATCHER_COUNT {
        let watch_root = root.join(format!("project-{index}"));
        fs::create_dir(&watch_root)?;
        let (event_sender, event_receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = event_sender.send(event);
        })?;
        watcher.watch(&watch_root, RecursiveMode::Recursive)?;
        probes.push(ProbeWatch {
            _watcher: watcher,
            event_receiver,
            changed_path: watch_root.join("changed.txt"),
        });
    }

    for probe in &probes {
        fs::write(&probe.changed_path, "changed")?;
    }
    let deadline = Instant::now() + EVENT_DEADLINE;
    for probe in &probes {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match probe.event_receiver.recv_timeout(remaining) {
                Ok(Ok(event)) if event.paths.iter().any(|path| path == &probe.changed_path) => {
                    break;
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => return Err(error.into()),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!(
                        "native watcher did not report {} before its deadline",
                        probe.changed_path.display()
                    )
                    .into());
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("native watcher event channel disconnected".into());
                }
            }
        }
    }

    drop(probes);
    println!("native Project watcher probe passed with {WATCHER_COUNT} watchers");
    Ok(())
}

struct ProbeWatch {
    _watcher: RecommendedWatcher,
    event_receiver: mpsc::Receiver<notify::Result<notify::Event>>,
    changed_path: PathBuf,
}
