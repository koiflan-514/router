use std::io::{self, Stdout};

use anyhow::{Context, Result};
use crossterm::cursor::{Hide, Show};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

pub struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
    active: bool,
}

impl TerminalSession {
    pub fn new() -> Result<Self> {
        let mut stdout = io::stdout();
        enable_raw_mode().context("无法进入终端 raw mode")?;
        if let Err(error) = execute!(stdout, EnterAlternateScreen, Hide) {
            let _ = disable_raw_mode();
            return Err(error).context("无法进入 alternate screen");
        }
        let backend = CrosstermBackend::new(io::stdout());
        let terminal = match Terminal::new(backend) {
            Ok(terminal) => terminal,
            Err(error) => {
                restore_best_effort();
                return Err(error).context("无法初始化终端");
            }
        };
        Ok(Self {
            terminal,
            active: true,
        })
    }

    pub fn terminal_mut(&mut self) -> &mut Terminal<CrosstermBackend<Stdout>> {
        &mut self.terminal
    }

    pub fn suspend(&mut self) {
        if !self.active {
            return;
        }
        let _ = execute!(io::stdout(), Show, LeaveAlternateScreen);
        let _ = disable_raw_mode();
        self.active = false;
    }

    pub fn resume(&mut self) -> Result<()> {
        if self.active {
            return Ok(());
        }
        let result = (|| -> Result<()> {
            enable_raw_mode().context("无法恢复终端 raw mode")?;
            execute!(io::stdout(), EnterAlternateScreen, Hide)
                .context("无法恢复 alternate screen")?;
            self.terminal.clear().context("无法清空恢复后的终端")?;
            Ok(())
        })();
        if result.is_err() {
            restore_best_effort();
            self.active = false;
        } else {
            self.active = true;
        }
        result
    }

    pub fn restore(&mut self) {
        self.suspend();
        let _ = execute!(io::stdout(), Show);
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.restore();
    }
}

pub fn install_panic_hook() {
    let _ = std::panic::take_hook();
    std::panic::set_hook(Box::new(|info| {
        restore_best_effort();
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown".to_string());
        eprintln!("router-tui 发生内部错误（{location}）。终端状态已尽力恢复。");
    }));
}

pub fn restore_best_effort() {
    let _ = execute!(io::stdout(), Show, LeaveAlternateScreen);
    let _ = disable_raw_mode();
}
