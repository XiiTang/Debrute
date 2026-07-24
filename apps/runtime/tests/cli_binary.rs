use std::process::Command;

#[test]
fn rust_cli_local_commands_use_the_stable_agent_protocol() {
    let executable = env!("CARGO_BIN_EXE_debrute");
    let version = Command::new(executable)
        .arg("--version")
        .output()
        .expect("CLI should run");
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8(version.stdout).unwrap().trim(),
        env!("CARGO_PKG_VERSION")
    );

    let commands = Command::new(executable)
        .arg("commands")
        .output()
        .expect("CLI should run");
    assert!(commands.status.success());
    let stdout = String::from_utf8(commands.stdout).unwrap();
    assert!(stdout.starts_with("debrute/1 ok cmd=commands\ncommand name=update"));
    assert!(stdout.contains("command name=generate.image-batch"));
    assert!(stdout.ends_with("count=35\n"));
}

#[test]
fn rust_cli_parse_failures_are_agent_records_with_exit_two() {
    let output = Command::new(env!("CARGO_BIN_EXE_debrute"))
        .args(["workbench", "start", "--next", "/settings"])
        .output()
        .expect("CLI should run");
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        concat!(
            "debrute/1 error cmd=workbench.start code=invalid_argument\n",
            "message=\"Unknown option for workbench.start: --next\""
        )
    );
}
