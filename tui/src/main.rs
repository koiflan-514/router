mod app;
mod backend;
mod cli;
mod domain;
mod redact;
mod terminal;
mod ui;

use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use crossterm::event::{Event, EventStream};
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio::time::{interval_at, Instant};

use app::{App, AppEffect, AppInfo, AppMessage, RefreshRequest};
use backend::fixture::FixtureBackend;
use backend::node::NodeBackend;
use backend::Backend;
use cli::{Cli, RuntimeConfig};
use terminal::{install_panic_hook, TerminalSession};

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if let Err(error) = run(cli).await {
        eprintln!("router-tui: {error:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    let config = RuntimeConfig::from_cli(cli)?;
    install_panic_hook();

    let backend = if config.demo {
        Backend::Fixture(FixtureBackend::new(config.read_only))
    } else {
        Backend::Node(NodeBackend::new(
            config
                .router_root
                .clone()
                .context("真实后端缺少 router root")?,
            config.node.clone(),
            config.read_only,
        ))
    };

    let mut terminal = TerminalSession::new()?;
    let mut app = App::new(AppInfo {
        backend_label: backend.label(),
        root: backend.root_label(),
        node: backend.node_label(),
        demo: backend.is_demo(),
        read_only: backend.is_read_only(),
        ascii: config.ascii,
        no_color: config.no_color,
        appearance: config.appearance,
        refresh_secs: config.refresh_secs,
    });

    let (sender, mut receiver) = mpsc::channel::<AppMessage>(64);
    dispatch_requests(&mut app, &backend, &sender);
    let mut event_stream = EventStream::new();

    let interrupt_sender = sender.clone();
    tokio::spawn(async move {
        loop {
            if tokio::signal::ctrl_c().await.is_err() {
                break;
            }
            if interrupt_sender.send(AppMessage::Interrupt).await.is_err() {
                break;
            }
        }
    });

    let now = Instant::now();
    let refresh = Duration::from_secs(config.refresh_secs.max(1));
    let mut status_tick = interval_at(now + refresh, refresh);
    let mut credits_tick = interval_at(now + Duration::from_secs(120), Duration::from_secs(120));
    let mut usage_tick = interval_at(now + Duration::from_secs(120), Duration::from_secs(120));
    let mut logs_tick = interval_at(now + Duration::from_secs(1), Duration::from_secs(1));

    'main: loop {
        dispatch_requests(&mut app, &backend, &sender);
        terminal
            .terminal_mut()
            .draw(|frame| ui::draw(frame, &mut app))
            .context("绘制终端界面失败")?;

        tokio::select! {
            maybe_event = event_stream.next() => {
                match maybe_event {
                    Some(Ok(Event::Key(key))) => app.handle_key(key),
                    Some(Ok(Event::Resize(_, _))) => {},
                    Some(Ok(_)) => {},
                    Some(Err(error)) => app.set_notice(format!("终端事件读取失败：{error}"), true),
                    None => {
                        app.set_notice("终端事件流已结束（非交互环境）。", true);
                        break 'main;
                    }
                }
            }
            maybe_message = receiver.recv() => {
                if let Some(message) = maybe_message {
                    app.handle_message(message);
                }
            }
            _ = status_tick.tick() => {
                app.queue_provider_refresh();
            }
            _ = credits_tick.tick() => {
                app.queue_credit_refresh();
            }
            _ = usage_tick.tick() => {
                app.queue_usage_refresh();
            }
            _ = logs_tick.tick() => {
                app.expire_notice();
                if app.page == app::Page::Logs && app.log_follow {
                    app.queue_log_refresh();
                }
            }
        }

        let effects = std::mem::take(&mut app.effects);
        for effect in effects {
            match effect {
                AppEffect::Quit => break 'main,
                AppEffect::RunAction { task_id, action } => {
                    let backend = backend.clone();
                    let sender = sender.clone();
                    tokio::spawn(async move {
                        let result = backend.execute(&action).await;
                        let _ = sender
                            .send(AppMessage::ActionDone { task_id, result })
                            .await;
                    });
                }
                AppEffect::RunInteractive { task_id, action } => {
                    terminal.suspend();
                    let result = backend.execute_interactive(&action).await;
                    terminal.resume().context("交互流程结束后恢复终端失败")?;
                    app.finish_interactive_action(task_id, result);
                }
            }
        }
    }

    terminal.restore();
    Ok(())
}

fn dispatch_requests(app: &mut App, backend: &Backend, sender: &mpsc::Sender<AppMessage>) {
    let requests: Vec<RefreshRequest> = std::mem::take(&mut app.pending_requests);
    for request in requests {
        match request {
            RefreshRequest::Providers(request_id) => {
                let backend = backend.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    let result = backend.providers().await;
                    let _ = sender
                        .send(AppMessage::Providers { request_id, result })
                        .await;
                });
            }
            RefreshRequest::Accounts(request_id) => {
                let backend = backend.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    let result = backend.accounts().await;
                    let _ = sender
                        .send(AppMessage::Accounts { request_id, result })
                        .await;
                });
            }
            RefreshRequest::Credits(request_id) => {
                let backend = backend.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    let result = backend.credits().await;
                    let _ = sender
                        .send(AppMessage::Credits { request_id, result })
                        .await;
                });
            }
            RefreshRequest::Usage(request_id) => {
                let backend = backend.clone();
                let sender = sender.clone();
                let range = app.usage_range;
                tokio::spawn(async move {
                    let result = backend.usage(range).await;
                    let _ = sender.send(AppMessage::Usage { request_id, result }).await;
                });
            }
            RefreshRequest::Logs {
                request_id,
                provider_id,
                lines,
            } => {
                let backend = backend.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    let result = backend.logs(&provider_id, lines).await;
                    let _ = sender
                        .send(AppMessage::Logs {
                            request_id,
                            provider_id,
                            result,
                        })
                        .await;
                });
            }
            RefreshRequest::Doctor(request_id) => {
                let backend = backend.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    let result = backend.doctor().await;
                    let _ = sender
                        .send(AppMessage::Diagnostics {
                            request_id,
                            title: "router 自检".into(),
                            result,
                        })
                        .await;
                });
            }
            RefreshRequest::Health {
                request_id,
                provider_id,
            } => {
                let backend = backend.clone();
                let sender = sender.clone();
                let title = provider_id
                    .as_ref()
                    .map(|provider| format!("健康检查 · {provider}"))
                    .unwrap_or_else(|| "健康检查 · 全部来源".into());
                tokio::spawn(async move {
                    let result = backend.health(provider_id, false).await;
                    let _ = sender
                        .send(AppMessage::Diagnostics {
                            request_id,
                            title,
                            result,
                        })
                        .await;
                });
            }
        }
    }
}
