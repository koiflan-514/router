use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};

#[test]
fn demo_starts_in_a_pty_and_quits_cleanly() {
    let output = run_tui(
        &["--demo", "--read-only", "--no-color"],
        &[b"Router Control"],
    );
    assert!(!output.is_empty());
}

#[test]
#[ignore = "requires OpenCode CLI and local session statistics"]
fn live_usage_page_reads_real_model_stats() {
    let root = std::env::var("ROUTER_TUI_TEST_ROOT")
        .expect("set ROUTER_TUI_TEST_ROOT to the router checkout for this ignored test");
    let output = run_tui_with_page(
        &["--router-root", &root, "--read-only", "--no-color"],
        b'7',
        &[b"Model", b"Steps", b"codearts"],
    );
    assert!(!output.is_empty());
}

#[test]
#[ignore = "requires a local router checkout and Node.js"]
fn live_readonly_starts_in_a_pty_and_reads_providers() {
    let root = std::env::var("ROUTER_TUI_TEST_ROOT")
        .expect("set ROUTER_TUI_TEST_ROOT to the router checkout for this ignored test");
    let output = run_tui(
        &["--router-root", &root, "--read-only", "--no-color"],
        &[b"Router Control", b"Qoder"],
    );
    assert!(!output.is_empty());
}

fn run_tui(args: &[&str], expected: &[&[u8]]) -> Vec<u8> {
    run_tui_internal(args, expected, None)
}

fn run_tui_with_page(args: &[&str], page: u8, expected: &[&[u8]]) -> Vec<u8> {
    run_tui_internal(args, expected, Some(page))
}

fn run_tui_internal(args: &[&str], expected: &[&[u8]], page: Option<u8>) -> Vec<u8> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open pty");

    let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_router-tui"));
    command.args(args);
    let mut child = pair.slave.spawn_command(command).expect("spawn TUI");
    drop(pair.slave);

    let master = pair.master;
    let mut writer = master.take_writer().expect("pty writer");
    let mut reader = master.try_clone_reader().expect("pty reader");
    let (sender, receiver) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if sender.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut answered_cursor_query = false;
    let mut sent_navigation = false;
    let mut sent_quit = false;
    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(chunk) => {
                output.extend_from_slice(&chunk);
                if !answered_cursor_query
                    && output
                        .windows(b"\x1b[6n".len())
                        .any(|window| window == b"\x1b[6n")
                {
                    // portable-pty is a pty, not a terminal emulator. Answer
                    // Ratatui/Crossterm's cursor-position query with row 1, col 1.
                    writer.write_all(b"\x1b[1;1R").expect("answer cursor query");
                    writer.flush().expect("flush cursor query");
                    answered_cursor_query = true;
                }
                if !sent_navigation {
                    if let Some(page) = page {
                        if output
                            .windows(b"Router Control".len())
                            .any(|window| window == b"Router Control")
                        {
                            writer.write_all(&[page]).expect("open usage page");
                            writer.flush().expect("flush page key");
                            sent_navigation = true;
                        }
                    }
                }
                if !sent_quit
                    && expected
                        .iter()
                        .all(|needle| output.windows(needle.len()).any(|window| window == *needle))
                {
                    sent_quit = true;
                    writer.write_all(b"q").expect("send quit");
                    writer.flush().expect("flush quit");
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if sent_quit {
            if let Ok(Some(status)) = child.try_wait() {
                assert!(
                    status.success(),
                    "TUI exited with failure status: {status:?}"
                );
                assert!(!output.is_empty());
                return output;
            }
        }
    }

    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            assert!(
                status.success(),
                "TUI exited with failure status: {status:?}"
            );
            return output;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let _ = child.kill();
    if args.contains(&"--demo") {
        panic!(
            "TUI did not render expected content and exit cleanly within the timeout. Demo output:\n{}",
            String::from_utf8_lossy(&output)
        );
    }
    panic!("TUI did not render expected content and exit cleanly within the timeout");
}
