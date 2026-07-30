//! Real native watcher contract exercised only through the supervised repository command.

use std::{env, error::Error, path::PathBuf};

use debrute_runtime::project::run_native_project_watcher_probe;

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
    let watcher_count = run_native_project_watcher_probe(&root)?;
    println!("native Project watcher probe passed with {watcher_count} watchers");
    Ok(())
}
