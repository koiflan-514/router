use std::time::Instant;

use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Block, BorderType, Cell, Clear, Paragraph, Row, Sparkline, Table, TableState, Wrap,
};
use ratatui::Frame;

use crate::app::{App, Modal, Page};
use crate::cli::Appearance;
use crate::domain::{
    format_compact, format_percent, format_quota_remaining, AuthState, HealthLevel, ModelUsage,
    PlatformCapability, Provider, UsageSnapshot,
};
use crate::redact::sanitize_text;

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    color: bool,
    ascii: bool,
    dark: bool,
}

impl Theme {
    fn new(app: &App) -> Self {
        Self {
            color: !app.info.no_color,
            ascii: app.info.ascii,
            dark: app.info.appearance == Appearance::Dark,
        }
    }

    fn fg(self, color: Color) -> Style {
        if self.color {
            Style::default().fg(color)
        } else {
            Style::default()
        }
    }

    fn bold(self, color: Color) -> Style {
        self.fg(color).add_modifier(Modifier::BOLD)
    }

    fn muted(self) -> Style {
        if self.color {
            Style::default().fg(if self.dark {
                Color::Gray
            } else {
                Color::DarkGray
            })
        } else {
            Style::default()
        }
    }

    fn accent(self) -> Style {
        self.bold(if self.dark { Color::Cyan } else { Color::Blue })
    }

    fn success(self) -> Style {
        self.fg(Color::Green)
    }

    fn warning(self) -> Style {
        self.fg(Color::Yellow)
    }

    fn error(self) -> Style {
        self.fg(Color::Red)
    }

    fn selected(self) -> Style {
        if self.color {
            Style::default()
                .fg(Color::Cyan)
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
                .add_modifier(Modifier::REVERSED)
                .add_modifier(Modifier::BOLD)
        }
    }

    fn table_header(self) -> Style {
        if self.color {
            Style::default()
                .fg(Color::Cyan)
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().add_modifier(Modifier::BOLD)
        }
    }

    fn auth(self, state: AuthState) -> Style {
        match state {
            AuthState::Valid => self.success(),
            AuthState::Expiring | AuthState::Unknown => self.warning(),
            AuthState::Expired | AuthState::Missing => self.error(),
        }
    }

    fn running(self) -> &'static str {
        if self.ascii {
            "RUN"
        } else {
            "● 运行"
        }
    }

    fn stopped(self) -> &'static str {
        if self.ascii {
            "STOP"
        } else {
            "○ 停止"
        }
    }

    fn border(self) -> Style {
        self.fg(if self.dark {
            Color::DarkGray
        } else {
            Color::Gray
        })
    }
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    if area.width < 40 || area.height < 12 {
        let message = format!(
            "终端过小（{}×{}）\n至少需要 40×12；请调整窗口后继续。\n\nq 退出",
            area.width, area.height
        );
        frame.render_widget(Paragraph::new(message).wrap(Wrap { trim: false }), area);
        return;
    }

    let theme = Theme::new(app);
    let chunks = Layout::vertical([
        Constraint::Length(2),
        Constraint::Length(1),
        Constraint::Min(5),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .split(area);

    render_header(frame, chunks[0], app, theme);
    render_tabs(frame, chunks[1], app, theme);
    render_page(frame, chunks[2], app, theme);
    render_info(frame, chunks[3], app, theme);
    render_footer(frame, chunks[4], app, theme);
    render_modal(frame, area, app, theme);
}

fn render_header(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let mode_style = if app.info.demo {
        theme.warning()
    } else {
        theme.success()
    };
    let mut first = vec![
        Span::styled(" Router Control ", theme.accent()),
        Span::styled(format!(" {} ", app.info.backend_label), mode_style),
        Span::raw("  "),
    ];
    if app.info.read_only {
        first.push(Span::styled(" READ-ONLY ", theme.warning()));
        first.push(Span::raw(" "));
    }
    first.push(Span::styled(safe_inline(&app.info.root), theme.muted()));

    let task = app
        .active_task
        .as_ref()
        .map(|task| {
            format!(
                "任务: {} {}s",
                task.action.title(),
                task.started.elapsed().as_secs()
            )
        })
        .unwrap_or_else(|| format!("刷新: {}s", app.info.refresh_secs));
    let mut second = vec![
        Span::styled("状态 ", theme.muted()),
        Span::styled(
            resource_age(&app.providers),
            resource_style(&app.providers, theme),
        ),
        Span::raw("  "),
        Span::styled("账号 ", theme.muted()),
        Span::styled(
            resource_age(&app.accounts),
            resource_style(&app.accounts, theme),
        ),
        Span::raw("  "),
        Span::styled("额度 ", theme.muted()),
        Span::styled(
            resource_age(&app.credits),
            resource_style(&app.credits, theme),
        ),
        Span::raw("  "),
        Span::styled(
            task,
            if app.active_task.is_some() {
                theme.warning()
            } else {
                theme.muted()
            },
        ),
    ];
    if app.page == Page::Usage {
        second.push(Span::raw("  "));
        second.push(Span::styled("用量 ", theme.muted()));
        second.push(Span::styled(
            resource_age(&app.usage),
            resource_style(&app.usage, theme),
        ));
    }

    frame.render_widget(
        Paragraph::new(vec![Line::from(first), Line::from(second)]),
        area,
    );
}

fn resource_style<T>(resource: &crate::app::Resource<T>, theme: Theme) -> Style {
    if resource.error.is_some() {
        theme.warning()
    } else if resource.refreshing {
        theme.accent()
    } else {
        theme.muted()
    }
}

fn resource_age<T>(resource: &crate::app::Resource<T>) -> String {
    if resource.error.is_some() {
        format!("{} stale", age(resource.last_success))
    } else if resource.refreshing {
        "刷新中".to_string()
    } else {
        age(resource.last_success)
    }
}

fn render_tabs(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let mut spans = Vec::new();
    for (index, page) in Page::ALL.iter().enumerate() {
        let active = app.page == *page;
        let style = if active {
            theme.selected()
        } else {
            theme.muted()
        };
        spans.push(Span::styled(
            format!(" {} {} ", index + 1, page.title()),
            style,
        ));
        spans.push(Span::raw(" "));
    }
    spans.push(Span::styled("  ? 帮助", theme.muted()));
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_page(frame: &mut Frame, area: Rect, app: &mut App, theme: Theme) {
    match app.page {
        Page::Overview => render_overview(frame, area, app, theme),
        Page::Providers => render_providers(frame, area, app, theme),
        Page::Credits => render_credits(frame, area, app, theme),
        Page::Accounts => render_accounts(frame, area, app, theme),
        Page::Logs => render_logs(frame, area, app, theme),
        Page::Diagnostics => render_diagnostics(frame, area, app, theme),
        Page::Usage => render_usage(frame, area, app, theme),
    }
}

fn render_overview(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let summary = provider_summary(app);
    let title = if summary.is_empty() {
        "服务状态 · 开关、进程与客户端配置分别判断".to_string()
    } else {
        format!("服务状态 · {summary}")
    };
    let table = provider_table(app, area.width, false, theme, &title);
    let mut state = TableState::default().with_selected(Some(app.provider_cursor));
    if area.height >= 15 {
        let chunks = Layout::vertical([Constraint::Length(4), Constraint::Min(5)]).split(area);
        render_usage_cards(frame, chunks[0], app.usage.data.as_ref(), theme);
        frame.render_stateful_widget(table, chunks[1], &mut state);
    } else {
        frame.render_stateful_widget(table, area, &mut state);
    }
}

fn render_providers(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let title = "服务 · u 启动 / d 停止 / R 重启 / o 仅启用 / x 关闭".to_string();
    let table = provider_table(app, area.width, true, theme, &title);
    let mut state = TableState::default().with_selected(Some(app.provider_cursor));
    frame.render_stateful_widget(table, area, &mut state);
}

fn render_usage_cards(
    frame: &mut Frame,
    area: Rect,
    snapshot: Option<&UsageSnapshot>,
    theme: Theme,
) {
    let widths = [
        Constraint::Ratio(1, 4),
        Constraint::Ratio(1, 4),
        Constraint::Ratio(1, 4),
        Constraint::Ratio(1, 4),
    ];
    let chunks = Layout::horizontal(widths).split(area);
    let sessions = snapshot.map(|usage| usage.sessions);
    let prompts = snapshot.map(|usage| usage.prompts);
    let steps = snapshot.map(|usage| usage.steps);
    let active_days = snapshot.map(|usage| usage.active_days);
    let tokens = snapshot.map(|usage| usage.tokens.visible_total());
    let input = snapshot.map(|usage| usage.tokens.input);
    let reasoning = snapshot.map(|usage| usage.tokens.reasoning);
    let success = snapshot.and_then(|usage| usage.tools.totals.success_rate());
    let calls = snapshot.map(|usage| usage.tools.totals.calls);
    let succeeded = snapshot.map(|usage| usage.tools.totals.succeeded);

    let cards = [
        (
            "会话 / 提示",
            sessions.map_or_else(|| "—".into(), |value| value.to_string()),
            prompts.map_or_else(
                || "等待 OpenCode 统计".into(),
                |value| format!("{value} prompts"),
            ),
            theme.accent(),
        ),
        (
            "会话步骤",
            steps.map_or_else(|| "—".into(), format_compact),
            active_days.map_or_else(
                || "steps ≠ HTTP 请求".into(),
                |value| format!("{value} 个活跃日"),
            ),
            theme.accent(),
        ),
        (
            "Token 构成",
            tokens.map_or_else(|| "—".into(), format_compact),
            match (input, reasoning) {
                (Some(input), Some(reasoning)) => format!(
                    "输入 {} · 推理 {}",
                    format_compact(input),
                    format_compact(reasoning)
                ),
                _ => "输入 / 输出 / 推理".into(),
            },
            theme.accent(),
        ),
        (
            "工具成功率",
            format_percent(success),
            match (succeeded, calls) {
                (Some(succeeded), Some(calls)) => format!("{succeeded}/{calls} 次成功"),
                _ => "尚无工具调用统计".into(),
            },
            if success.is_some_and(|value| value < 0.95) {
                theme.warning()
            } else {
                theme.success()
            },
        ),
    ];
    for (index, (label, value, detail, style)) in cards.into_iter().enumerate() {
        let block = Block::bordered()
            .border_style(theme.border())
            .border_type(BorderType::Rounded)
            .title(Span::styled(format!(" {label} "), theme.muted()));
        let text = vec![
            Line::from(Span::styled(value, style.add_modifier(Modifier::BOLD))),
            Line::from(Span::styled(detail, theme.muted())),
        ];
        frame.render_widget(
            Paragraph::new(text)
                .alignment(Alignment::Center)
                .block(block),
            chunks[index],
        );
    }
}

fn provider_summary(app: &App) -> String {
    let Some(snapshot) = app.providers.data.as_ref() else {
        return String::new();
    };
    // 网关是叠加层，没有独立的开关，不能算进「启用 x/y」的分母。
    let managed: Vec<&Provider> = snapshot
        .providers
        .iter()
        .filter(|provider| !provider.overlay())
        .collect();
    // 「启用」只统计参与开关的 provider；「运行」是进程数，网关也是进程，
    // 所以两个比率的分母分别用「参与开关的家数」和「全部进程数」。
    let enabled = managed.iter().filter(|provider| provider.on).count();
    let up = snapshot
        .providers
        .iter()
        .filter(|provider| provider.up)
        .count();
    let auth = snapshot
        .providers
        .iter()
        .filter(|provider| provider.auth.effective_state().is_problem())
        .count();
    let drift = snapshot
        .providers
        .iter()
        .filter(|provider| provider.drift())
        .count();
    let gateway = snapshot
        .providers
        .iter()
        .find(|provider| provider.overlay())
        .map(|provider| provider.up);
    let claimable = app.credits.data.as_ref().map_or(0, |credits| {
        credits.rows.iter().map(|row| row.claimable_count()).sum()
    });
    let gateway_label = match gateway {
        Some(true) => " · 网关在线",
        Some(false) => " · 网关已停",
        None => "",
    };
    format!(
        "启用 {enabled}/{} · 运行 {up}/{} · 认证提醒 {auth} · 配置漂移 {drift} · 可领取 {claimable}{gateway_label}",
        managed.len(),
        snapshot.providers.len()
    )
}

fn provider_table<'a>(
    app: &App,
    width: u16,
    detailed: bool,
    theme: Theme,
    title: &str,
) -> Table<'a> {
    let headers;
    let widths;
    let mut include_quota = true;
    if !detailed {
        if width >= 100 {
            headers = vec![
                "Provider",
                "开关",
                "进程",
                "认证",
                "客户端",
                "端口",
                "模型",
                "额度",
            ];
            widths = vec![
                Constraint::Min(18),
                Constraint::Length(5),
                Constraint::Length(9),
                Constraint::Length(12),
                Constraint::Length(9),
                Constraint::Length(6),
                Constraint::Length(6),
                Constraint::Min(10),
            ];
        } else if width >= 78 {
            headers = vec!["Provider", "开关", "进程", "认证", "客户端", "模型", "额度"];
            widths = vec![
                Constraint::Min(15),
                Constraint::Length(5),
                Constraint::Length(9),
                Constraint::Length(11),
                Constraint::Length(8),
                Constraint::Length(5),
                Constraint::Min(8),
            ];
        } else {
            headers = vec!["Provider", "开关", "进程", "认证", "额度"];
            widths = vec![
                Constraint::Min(14),
                Constraint::Length(5),
                Constraint::Length(8),
                Constraint::Length(10),
                Constraint::Min(8),
            ];
            include_quota = false;
        }
    } else if width >= 90 {
        headers = vec![
            "Provider",
            "开关",
            "进程",
            "PID",
            "客户端",
            "认证",
            "端口",
            "模型",
        ];
        widths = vec![
            Constraint::Min(16),
            Constraint::Length(5),
            Constraint::Length(9),
            Constraint::Length(8),
            Constraint::Length(9),
            Constraint::Length(12),
            Constraint::Length(6),
            Constraint::Length(5),
        ];
        include_quota = false;
    } else {
        headers = vec!["Provider", "开关", "进程", "客户端", "认证", "模型"];
        widths = vec![
            Constraint::Min(14),
            Constraint::Length(5),
            Constraint::Length(8),
            Constraint::Length(8),
            Constraint::Length(11),
            Constraint::Length(5),
        ];
        include_quota = false;
    }

    let rows = app
        .providers
        .data
        .as_ref()
        .map(|snapshot| {
            snapshot
                .providers
                .iter()
                .map(|provider| {
                    let auth_state = provider.auth.effective_state();
                    let mut cells = vec![
                        cell(provider.title.clone(), provider_style(&provider.id, theme)),
                        cell(
                            provider.switch_label(),
                            if provider.overlay() {
                                theme.muted()
                            } else if provider.on {
                                theme.success()
                            } else {
                                theme.muted()
                            },
                        ),
                        cell(
                            if provider.up {
                                theme.running()
                            } else {
                                theme.stopped()
                            },
                            if provider.up {
                                theme.success()
                            } else {
                                theme.warning()
                            },
                        ),
                    ];
                    if detailed && width >= 90 {
                        cells.push(cell(
                            provider
                                .pids
                                .iter()
                                .map(ToString::to_string)
                                .collect::<Vec<_>>()
                                .join(",")
                                .if_empty("—"),
                            theme.muted(),
                        ));
                        cells.push(cell(provider.client_label(), theme.muted()));
                        cells.push(cell(auth_state.label(), theme.auth(auth_state)));
                        cells.push(cell(provider.port.to_string(), theme.muted()));
                        cells.push(cell(
                            provider
                                .models
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "—".into()),
                            theme.muted(),
                        ));
                    } else if detailed {
                        cells.push(cell(provider.client_label(), theme.muted()));
                        cells.push(cell(auth_state.label(), theme.auth(auth_state)));
                        cells.push(cell(
                            provider
                                .models
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "—".into()),
                            theme.muted(),
                        ));
                    } else if width >= 100 {
                        cells.push(cell(auth_state.label(), theme.auth(auth_state)));
                        cells.push(cell(provider.client_label(), theme.muted()));
                        cells.push(cell(provider.port.to_string(), theme.muted()));
                        cells.push(cell(
                            provider
                                .models
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "—".into()),
                            theme.muted(),
                        ));
                        cells.push(cell(compact_quota(app, &provider.id), theme.muted()));
                    } else if width >= 78 {
                        cells.push(cell(auth_state.label(), theme.auth(auth_state)));
                        cells.push(cell(provider.client_label(), theme.muted()));
                        cells.push(cell(
                            provider
                                .models
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "—".into()),
                            theme.muted(),
                        ));
                        cells.push(cell(compact_quota(app, &provider.id), theme.muted()));
                    } else {
                        cells.push(cell(auth_state.label(), theme.auth(auth_state)));
                        if include_quota {
                            cells.push(cell(compact_quota(app, &provider.id), theme.muted()));
                        }
                    }
                    Row::new(cells)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let block = Block::bordered()
        .border_style(theme.border())
        .border_type(BorderType::Rounded)
        .title(Span::styled(format!(" {title} "), theme.accent()));
    Table::new(rows, widths)
        .header(Row::new(
            headers
                .into_iter()
                .map(|header| Cell::from(header).style(theme.table_header())),
        ))
        .block(block)
        .column_spacing(1)
        .highlight_symbol("> ")
        .row_highlight_style(theme.selected())
}

fn compact_quota(app: &App, provider_id: &str) -> String {
    let Some(row) = app
        .credits
        .data
        .as_ref()
        .and_then(|credits| credits.rows.iter().find(|row| row.provider == provider_id))
    else {
        return "—".into();
    };
    if !row.available {
        return "不可用".into();
    }
    if !row.accounts.is_empty() {
        return format!("{} 账号", row.accounts.len());
    }
    if !row.buckets.is_empty() {
        let first = &row.buckets[0];
        let mut value = format_quota_remaining(first.remaining, &first.unit);
        if row.buckets.len() > 1 {
            value.push_str(&format!(" +{}", row.buckets.len() - 1));
        }
        return value;
    }
    // 这里是一列窄表格，不要把上游的长句（签到说明等）整段塞进来。
    if row.quota_exhausted {
        return "额度已耗尽".into();
    }
    match row.status_summary().chars().count() {
        0 => "—".into(),
        count if count > 14 => format!(
            "{}…",
            row.status_summary().chars().take(13).collect::<String>()
        ),
        _ => row.status_summary(),
    }
}

fn render_credits(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let lines = app.quota_lines();
    let rows = lines
        .iter()
        .map(|line| {
            let status_style = if line.status.starts_with("不可用")
                || line.status.contains("失败")
                || line.status.contains("已过期")
            {
                theme.error()
            } else if line.status.contains("可领取")
                || line.status.contains("即将过期")
                || line.status.contains("未运行")
            {
                theme.warning()
            } else {
                theme.muted()
            };
            Row::new(vec![
                cell(
                    line.title.clone(),
                    theme.bold(if theme.dark {
                        Color::White
                    } else {
                        Color::Black
                    }),
                ),
                cell(line.source.clone(), theme.muted()),
                cell(
                    line.remaining
                        .map(crate::domain::format_number)
                        .unwrap_or_else(|| "—".into()),
                    theme.success(),
                ),
                cell(
                    line.total
                        .map(crate::domain::format_number)
                        .unwrap_or_else(|| "—".into()),
                    theme.muted(),
                ),
                cell(line.unit.clone().if_empty("—"), theme.muted()),
                cell(line.status.clone(), status_style),
            ])
        })
        .collect::<Vec<_>>();
    let header = Row::new(
        ["Provider", "来源/账号", "剩余", "总量", "单位", "状态"]
            .into_iter()
            .map(|name| Cell::from(name).style(theme.table_header())),
    );
    let claimable: usize = lines
        .iter()
        .filter(|line| line.status.contains("可领取"))
        .count();
    let claimable_note = if claimable > 0 {
        format!(" · 可领取 {claimable} 处")
    } else {
        String::new()
    };
    // 标题栏只放「数据多新 + 不汇总 + 可领取数」；WorkBuddy 是凭证天数的说明
    // 放在行内单位列（天）和详情里，不在这里重复。
    let note = app
        .credits
        .last_success
        .map(|time| format!("数据 {} · 不跨厂商汇总{claimable_note}", age(Some(time))))
        .unwrap_or_else(|| format!("尚未取得额度 · 不跨厂商汇总{claimable_note}"));
    let block = Block::bordered()
        .border_style(theme.border())
        .border_type(BorderType::Rounded)
        .title(Span::styled(format!(" 额度 · {note} "), theme.accent()));
    let table = Table::new(
        rows,
        [
            Constraint::Min(16),
            Constraint::Min(14),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(8),
            Constraint::Min(12),
        ],
    )
    .header(header)
    .block(block)
    .column_spacing(1)
    .highlight_symbol("> ")
    .row_highlight_style(theme.selected());
    let mut state = TableState::default()
        .with_selected(Some(app.quota_cursor.min(lines.len().saturating_sub(1))));
    frame.render_stateful_widget(table, area, &mut state);
}

fn render_usage(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    if area.height >= 17 {
        let chunks = Layout::vertical([
            Constraint::Length(4),
            Constraint::Length(5),
            Constraint::Min(6),
        ])
        .split(area);
        render_usage_cards(frame, chunks[0], app.usage.data.as_ref(), theme);
        render_activity(frame, chunks[1], app, theme);
        render_model_usage(frame, chunks[2], app, theme);
    } else {
        let chunks = Layout::vertical([Constraint::Length(4), Constraint::Min(6)]).split(area);
        render_usage_cards(frame, chunks[0], app.usage.data.as_ref(), theme);
        render_model_usage(frame, chunks[1], app, theme);
    }
}

fn render_activity(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let snapshot = app.usage.data.as_ref();
    let values: Vec<u64> = snapshot
        .map(|usage| {
            usage
                .activity
                .iter()
                .rev()
                .take(30)
                .map(|day| day.steps)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        })
        .unwrap_or_default();
    let stale = if app.usage.error.is_some() {
        " · STALE"
    } else {
        ""
    };
    let cost = snapshot.map(|usage| usage.cost).unwrap_or(0.0);
    let block = Block::bordered()
        .border_style(theme.border())
        .border_type(BorderType::Rounded)
        .title(Span::styled(
            format!(
                " 每日活动 · {} · 上报成本 ${cost:.2}{stale} ",
                app.usage_range.label()
            ),
            theme.accent(),
        ));
    if values.is_empty() {
        let message = if app.usage.refreshing {
            "正在读取 OpenCode 会话统计…"
        } else if snapshot.is_some() {
            "当前时间范围没有活动记录。"
        } else if let Some(error) = &app.usage.error {
            error.as_str()
        } else {
            "OpenCode 统计尚未返回。"
        };
        frame.render_widget(
            Paragraph::new(safe_inline(message))
                .block(block)
                .alignment(Alignment::Center),
            area,
        );
    } else {
        let peak = values.iter().copied().max().unwrap_or(1).max(1);
        frame.render_widget(
            Sparkline::default()
                .block(block)
                .data(&values)
                .max(peak)
                .style(theme.accent()),
            area,
        );
    }
}

fn render_model_usage(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let Some(snapshot) = app.usage.data.as_ref() else {
        let block = Block::bordered()
            .border_style(theme.border())
            .border_type(BorderType::Rounded)
            .title(Span::styled(" 模型 / Provider 用量 ", theme.accent()));
        let message = if app.usage.refreshing {
            "正在加载 OpenCode 模型统计…"
        } else if let Some(error) = &app.usage.error {
            error.as_str()
        } else {
            "尚无 OpenCode 用量数据。按 r 重试。"
        };
        frame.render_widget(
            Paragraph::new(safe_inline(message))
                .block(block)
                .alignment(Alignment::Center),
            area,
        );
        return;
    };

    let selected = app
        .usage_model_cursor
        .min(snapshot.models.len().saturating_sub(1));
    let visible_rows = area.height.saturating_sub(4).max(1) as usize;
    let start = selected.saturating_sub(visible_rows.saturating_sub(1));
    let end = (start + visible_rows).min(snapshot.models.len());
    let wide = area.width >= 110;
    let headers: Vec<&str> = if wide {
        vec![
            "Model",
            "Provider",
            "Steps",
            "输入",
            "输出",
            "推理",
            "缓存读",
            "成本",
        ]
    } else {
        vec!["Model", "Provider", "Steps", "输出", "缓存读", "成本"]
    };
    let widths: Vec<Constraint> = if wide {
        vec![
            Constraint::Min(20),
            Constraint::Length(15),
            Constraint::Length(7),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(10),
            Constraint::Length(11),
            Constraint::Length(9),
        ]
    } else {
        vec![
            Constraint::Min(20),
            Constraint::Length(14),
            Constraint::Length(7),
            Constraint::Length(10),
            Constraint::Length(11),
            Constraint::Length(9),
        ]
    };
    let rows = snapshot.models[start..end]
        .iter()
        .map(|model| model_usage_row(model, wide, theme))
        .collect::<Vec<_>>();
    let block = Block::bordered()
        .border_style(theme.border())
        .border_type(BorderType::Rounded)
        .title(Span::styled(
            format!(
                " 模型 / Provider · {}-{} / {} · t 切换 {} ",
                if snapshot.models.is_empty() {
                    0
                } else {
                    start + 1
                },
                end,
                snapshot.models.len(),
                app.usage_range.label()
            ),
            theme.accent(),
        ));
    let table = Table::new(rows, widths)
        .header(Row::new(
            headers
                .into_iter()
                .map(|name| Cell::from(name).style(theme.table_header())),
        ))
        .block(block)
        .column_spacing(1)
        .highlight_symbol("> ")
        .row_highlight_style(theme.selected());
    let mut state = TableState::default().with_selected(Some(selected.saturating_sub(start)));
    frame.render_stateful_widget(table, area, &mut state);
}

fn model_usage_row(model: &ModelUsage, wide: bool, theme: Theme) -> Row<'static> {
    let mut cells = vec![
        cell(model.model.id.clone(), theme.accent()),
        cell(
            model.model.provider_id.clone(),
            provider_style(&model.model.provider_id, theme),
        ),
        cell(model.steps.to_string(), theme.muted()),
    ];
    if wide {
        cells.push(cell(format_compact(model.tokens.input), theme.muted()));
    }
    cells.push(cell(format_compact(model.tokens.output), theme.success()));
    if wide {
        cells.push(cell(format_compact(model.tokens.reasoning), theme.muted()));
    }
    cells.push(cell(format_compact(model.tokens.cache.read), theme.muted()));
    cells.push(cell(format!("${:.2}", model.cost), theme.muted()));
    Row::new(cells)
}

fn provider_style(provider_id: &str, theme: Theme) -> Style {
    let color = match provider_id {
        "codearts" => Color::Magenta,
        "qoder-cn" => Color::Cyan,
        "qoder" => Color::Blue,
        "trae-local" => Color::Green,
        "workbuddy" => Color::Yellow,
        "workbuddy-global" => Color::LightMagenta,
        "zcode" => Color::LightCyan,
        "loomy" => Color::LightBlue,
        "raccoon" => Color::LightRed,
        "qwenwork" => Color::LightGreen,
        "gateway" => Color::LightYellow,
        "opencode" => Color::Gray,
        _ => Color::White,
    };
    theme.fg(color).add_modifier(Modifier::BOLD)
}

fn render_accounts(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let mut rows = Vec::new();
    let mut selected = app.account_cursor;
    let total = app.selectable_account_count();
    if total == 0 {
        selected = 0;
    }
    if let Some(snapshot) = app.accounts.data.as_ref() {
        for group in &snapshot.providers {
            for account in &group.accounts {
                let marker = if account.active {
                    "*"
                } else if account.enabled {
                    "+"
                } else {
                    "-"
                };
                let marker_style = if account.active {
                    theme.success()
                } else if account.enabled {
                    theme.warning()
                } else {
                    theme.muted()
                };
                // 账号健康是后端给的结构化结论（例如「积分为 0，选中会报额度不足」）。
                // error 级把它放前面（这是不该选它的原因），warn 级放在说明之后。
                let detail = match (account.health.summary(), account.health.level) {
                    (Some(note), HealthLevel::Error) => {
                        format!("{note} · {}", account.detail.clone().unwrap_or_default())
                    }
                    (Some(note), HealthLevel::Warn) => format!(
                        "{} · {note}",
                        account.detail.clone().unwrap_or_else(|| "—".into())
                    ),
                    _ => account.detail.clone().unwrap_or_else(|| "—".into()),
                };
                rows.push(Row::new(vec![
                    cell(group.title.clone(), provider_style(&group.id, theme)),
                    cell(marker, marker_style),
                    cell(account.key.clone(), theme.accent()),
                    cell(account.name.clone().if_empty("—"), theme.muted()),
                    cell(
                        if account.enabled { "参与" } else { "停用" },
                        if account.enabled {
                            theme.success()
                        } else {
                            theme.muted()
                        },
                    ),
                    cell(
                        if account.active { "生效" } else { "—" },
                        if account.active {
                            theme.success()
                        } else {
                            theme.muted()
                        },
                    ),
                    cell(
                        detail,
                        if account.health.level.is_problem() {
                            theme.warning()
                        } else {
                            theme.muted()
                        },
                    ),
                ]));
            }
        }
    }
    let block = Block::bordered()
        .border_style(theme.border())
        .border_type(BorderType::Rounded)
        .title(Span::styled(
            " 账号 · * 当前生效 / + 参与轮询 / - 停用 ",
            theme.accent(),
        ));
    let table = Table::new(
        rows,
        [
            Constraint::Min(16),
            Constraint::Length(4),
            Constraint::Length(14),
            Constraint::Min(12),
            Constraint::Length(7),
            Constraint::Length(7),
            Constraint::Min(12),
        ],
    )
    .header(Row::new(
        ["Provider", "标记", "Key", "名称", "轮询", "当前", "说明"]
            .into_iter()
            .map(|value| Cell::from(value).style(theme.table_header())),
    ))
    .block(block)
    .column_spacing(1)
    .highlight_symbol("> ")
    .row_highlight_style(theme.selected());
    let mut state = TableState::default().with_selected(Some(selected));
    frame.render_stateful_widget(table, area, &mut state);
}

fn render_logs(frame: &mut Frame, area: Rect, app: &mut App, theme: Theme) {
    let provider = app
        .selected_provider()
        .map(|provider| format!("{} · :{}", provider.title, provider.port))
        .unwrap_or_else(|| "无 provider".into());
    let follow = if app.log_follow { "跟随" } else { "暂停" };
    let last = age(app.log_last_success);
    let filter = if app.log_filter.is_empty() {
        "无".to_string()
    } else {
        format!("\"{}\"", app.log_filter)
    };
    let header = Line::from(vec![
        Span::styled(
            safe_inline(&provider),
            theme.bold(if theme.dark {
                Color::White
            } else {
                Color::Black
            }),
        ),
        Span::raw("  "),
        Span::styled(
            safe_inline(app.loaded_log_provider.as_deref().unwrap_or("—")),
            theme.muted(),
        ),
        Span::raw("  "),
        Span::styled(
            follow,
            if app.log_follow {
                theme.success()
            } else {
                theme.warning()
            },
        ),
        Span::raw("  "),
        Span::styled(
            format!("{last} · {} 行/次", app.log_lines_per_fetch),
            theme.muted(),
        ),
        Span::raw("  "),
        Span::styled(format!("过滤: {}", safe_inline(&filter)), theme.muted()),
    ]);
    let status = if let Some(error) = &app.log_error {
        Line::from(Span::styled(
            format!("! {}", safe_inline(error)),
            theme.error(),
        ))
    } else if app.log_refreshing {
        Line::from(Span::styled("正在读取日志…", theme.accent()))
    } else {
        Line::from(Span::styled(
            "空格、ANSI 与常见凭据会在显示前清理。",
            theme.muted(),
        ))
    };
    let top = Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).split(area);
    frame.render_widget(Paragraph::new(vec![header, status]), top[0]);

    let visible = app.visible_log_lines();
    let inner_height = top[1].height.saturating_sub(2).max(1) as usize;
    let max_scroll = visible.len().saturating_sub(inner_height) as u16;
    app.log_max_scroll = max_scroll;
    app.log_view_height = inner_height as u16;
    if app.log_follow {
        app.log_scroll = max_scroll;
        app.log_match = None;
    }
    let scroll = app.log_scroll.min(max_scroll);
    let match_count = app.log_match_count();
    let body = if visible.is_empty() {
        "没有已加载日志。进入本页会读取日志；按 r 重试。".to_string()
    } else if match_count == 0 {
        visible.join("\n")
    } else {
        // 过滤后列表本身只包含命中行，所以只把「当前 n/N 落点」标出来；
        // 每行都加标记的话，长日志里根本看不出跳到了哪里。
        visible
            .iter()
            .enumerate()
            .map(|(index, line)| {
                if app.log_match == Some(index) {
                    format!("» {line}")
                } else {
                    format!("  {line}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    let block = Block::bordered()
        .border_style(theme.border())
        .border_type(BorderType::Rounded)
        .title(Span::styled(
            format!(
                " 日志 · {}/{} 行 · 过滤命中 {}{} ",
                visible.len(),
                app.log_lines.len(),
                match_count,
                app.log_match
                    .filter(|_| match_count > 0)
                    .map(|index| format!(" · 第 {}/{} 处", index + 1, match_count))
                    .unwrap_or_default()
            ),
            theme.accent(),
        ));
    frame.render_widget(
        Paragraph::new(body).block(block).scroll((scroll, 0)),
        top[1],
    );
}

fn render_diagnostics(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let provider = app
        .selected_provider()
        .map(|provider| {
            format!(
                "{}（{}）· 认证: {}",
                provider.title,
                provider.id,
                provider.auth.effective_state().label()
            )
        })
        .unwrap_or_else(|| "未选中 provider".into());
    let term = std::env::var("TERM").unwrap_or_else(|_| "unknown".into());
    let colorterm = std::env::var("COLORTERM").unwrap_or_else(|_| "unknown".into());
    let login = capability_label(PlatformCapability::login());
    let autostart = capability_label(PlatformCapability::autostart());
    let provider_wire = app
        .providers
        .data
        .as_ref()
        .map(|snapshot| {
            format!(
                "provider JSON: schema={} generated={} 告警={}",
                snapshot
                    .schema_version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "legacy".into()),
                snapshot.generated_at.as_deref().unwrap_or("—"),
                snapshot.warnings.len()
            )
        })
        .unwrap_or_else(|| "provider JSON: 尚未加载".into());
    let account_wire = app
        .accounts
        .data
        .as_ref()
        .map(|snapshot| {
            format!(
                "account JSON: schema={} generated={} 告警={}",
                snapshot
                    .schema_version
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "legacy".into()),
                snapshot.generated_at.as_deref().unwrap_or("—"),
                snapshot.warnings.len()
            )
        })
        .unwrap_or_else(|| "account JSON: 尚未加载".into());
    let mut text = format!(
        "环境\nOS: {} {}\n后端: {}  只读: {}\nroot: {}\nnode: {}\nTERM: {}  COLORTERM: {}\n{}\n{}\n\n平台能力\n登录: {}\n自启: {}\n\n当前 provider\n{}\n\n--- {} ---\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
        app.info.backend_label,
        yes_no(app.info.read_only),
        app.info.root,
        app.info.node,
        term,
        colorterm,
        provider_wire,
        account_wire,
        login,
        autostart,
        provider,
        app.diag_title
    );
    if app.diag.refreshing {
        text.push_str("正在运行…\n");
    }
    if let Some(error) = &app.diag.error {
        text.push_str(&format!("! {error}\n"));
    }
    if let Some(result) = app.diag.data.as_ref() {
        text.push_str(&result.text);
        if result.truncated {
            text.push_str("\n[输出已截断]\n");
        }
        if let Some(code) = result.exit_code {
            text.push_str(&format!("\n退出码: {code}\n"));
        }
    } else if !app.diag.refreshing && app.diag.error.is_none() {
        text.push_str("按 d 运行 doctor，按 h 进行无试打健康检查，按 P 发起经确认的真实试打。\n");
    }
    let block = Block::bordered()
        .border_style(theme.border())
        .border_type(BorderType::Rounded)
        .title(Span::styled(
            " 诊断 · 无试打检查不会发送真实对话 ",
            theme.accent(),
        ));
    frame.render_widget(
        Paragraph::new(safe_block(&text))
            .block(block)
            .scroll((app.diag_scroll, 0)),
        area,
    );
}

fn render_info(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    if app.page == Page::Usage {
        render_usage_info(frame, area, app, theme);
        return;
    }
    let mut lines = Vec::new();
    if let Some(provider) = app.selected_provider() {
        let auth = provider.auth.effective_state();
        lines.push(Line::from(vec![
            Span::styled(
                format!("{}  ", safe_inline(&provider.title)),
                theme.bold(if theme.dark {
                    Color::White
                } else {
                    Color::Black
                }),
            ),
            Span::styled(format!(":{}", provider.port), theme.muted()),
            Span::raw("  "),
            Span::styled(
                format!(
                    "开关={} 进程={} 客户端={}",
                    provider.switch_label(),
                    yes_no(provider.up),
                    provider.client_label()
                ),
                if provider.drift() {
                    theme.warning()
                } else {
                    theme.muted()
                },
            ),
            Span::raw("  "),
            Span::styled(
                format!(
                    "认证={} · {}",
                    auth.label(),
                    safe_inline(&provider.auth.display_label())
                ),
                theme.auth(auth),
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled("状态组合: ", theme.muted()),
            Span::styled(
                drift_description(provider),
                if provider.drift() {
                    theme.warning()
                } else {
                    theme.muted()
                },
            ),
        ]));
    } else {
        lines.push(Line::from(Span::styled(
            "尚未加载 provider 状态；真实后端需要 Node.js 与 router root。",
            theme.warning(),
        )));
    }

    if let Some(task) = &app.active_task {
        lines.push(Line::from(vec![
            Span::styled("运行中: ", theme.warning()),
            Span::styled(
                format!(
                    "{} · {}s · 写任务期间不能退出",
                    task.action.title(),
                    task.started.elapsed().as_secs()
                ),
                theme.warning(),
            ),
        ]));
    } else if let Some(notice) = &app.notice {
        let style = if notice.error {
            theme.error()
        } else {
            theme.success()
        };
        lines.push(Line::from(Span::styled(
            format!("! {}", safe_inline(&notice.text)),
            style,
        )));
    } else if let Some(result) = &app.last_action_result {
        lines.push(Line::from(vec![
            Span::styled("最近操作: ", theme.muted()),
            Span::styled(result.title.clone(), theme.accent()),
            Span::styled(" · 按 O 查看输出", theme.muted()),
        ]));
    } else {
        lines.push(Line::from(Span::styled(
            "提示: ? 打开帮助；Enter 查看详情；O 查看操作输出；q 退出。",
            theme.muted(),
        )));
    }
    while lines.len() < 3 {
        lines.push(Line::default());
    }
    lines.truncate(3);
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_usage_info(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let mut lines = Vec::new();
    if let Some(task) = &app.active_task {
        lines.push(Line::from(Span::styled(
            format!(
                "运行中: {} · {}s",
                task.action.title(),
                task.started.elapsed().as_secs()
            ),
            theme.warning(),
        )));
    } else if let Some(notice) = &app.notice {
        lines.push(Line::from(Span::styled(
            format!("! {}", safe_inline(&notice.text)),
            if notice.error {
                theme.error()
            } else {
                theme.success()
            },
        )));
    } else if let Some(model) = app.selected_usage_model() {
        lines.push(Line::from(vec![
            Span::styled(
                safe_inline(&model.model.id),
                provider_style(&model.model.provider_id, theme),
            ),
            Span::styled(
                format!(
                    "  {} · {} steps",
                    safe_inline(&model.model.provider_id),
                    model.steps
                ),
                theme.muted(),
            ),
        ]));
    } else {
        lines.push(Line::from(Span::styled(
            "OpenCode 用量尚未加载。",
            theme.warning(),
        )));
    }
    if let Some(snapshot) = app.usage.data.as_ref() {
        lines.push(Line::from(Span::styled(
            format!(
                "范围: {} · 会话 {} · 提示 {} · 输入 {} · 输出 {} · 推理 {} · 缓存读 {}",
                app.usage_range.label(),
                snapshot.sessions,
                snapshot.prompts,
                format_compact(snapshot.tokens.input),
                format_compact(snapshot.tokens.output),
                format_compact(snapshot.tokens.reasoning),
                format_compact(snapshot.tokens.cache.read)
            ),
            theme.muted(),
        )));
    } else {
        lines.push(Line::from(Span::styled(
            format!("范围: {} · 正在等待 OpenCode 统计", app.usage_range.label()),
            theme.muted(),
        )));
    }
    lines.push(Line::from(Span::styled(
        "Enter 模型详情 · t 切换 24h/7d/30d/全部 · steps 不等于 HTTP 请求数",
        theme.muted(),
    )));
    lines.truncate(3);
    frame.render_widget(Paragraph::new(lines), area);
}

fn render_footer(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let common = "r刷新 O输出 ?帮助 q退出";
    let specific = match app.page {
        Page::Overview => "↑↓选择 Enter详情 2服务 5日志",
        Page::Providers => "u启动 d停止 K保留 R重启 o仅启用 x关闭 s同步 A全启 N全关 L日志",
        Page::Credits => "↑↓选择 Enter详情 c签到 4账号",
        Page::Accounts => "↑↓选择 v预览 c切换 a整池 A添加 L登录 3额度",
        Page::Logs => "p跟随 f过滤 n/N命中 +/-行数 c清屏 End底部 ↑↓滚动 ←→来源",
        Page::Diagnostics => "d自检 h健康 P试打 5日志 ←→来源 ↑↓滚动",
        Page::Usage => "↑↓选择模型 Enter详情 t时间范围 r刷新",
    };
    frame.render_widget(
        Paragraph::new(Line::from(Span::styled(
            format!(" {common}  {specific}"),
            theme.muted(),
        ))),
        area,
    );
}

fn render_modal(frame: &mut Frame, area: Rect, app: &mut App, theme: Theme) {
    let Some(modal) = app.modal.as_ref() else {
        return;
    };
    match modal {
        Modal::Confirm(dialog) => {
            let body_lines = dialog.body.lines().count() as u16 + 6;
            let popup = popup_rect(area, 82, body_lines, 88);
            frame.render_widget(Clear, popup);
            let title_style = if dialog.action.risk() == crate::domain::ActionRisk::High {
                theme.error()
            } else {
                theme.accent()
            };
            let block = Block::bordered()
                .border_style(theme.border())
                .border_type(BorderType::Rounded)
                .title(Span::styled(
                    format!(" {} ", safe_inline(&dialog.title)),
                    title_style,
                ));
            frame.render_widget(block.clone(), popup);
            let inner = block.inner(popup);
            let chunks = Layout::vertical([Constraint::Min(3), Constraint::Length(2)]).split(inner);
            frame.render_widget(
                Paragraph::new(safe_block(&dialog.body)).wrap(Wrap { trim: false }),
                chunks[0],
            );
            let cancel_style = if dialog.confirm_focused {
                theme.muted()
            } else {
                theme.selected()
            };
            let confirm_style = if dialog.confirm_focused {
                theme.selected()
            } else {
                theme.muted()
            };
            let buttons = Line::from(vec![
                Span::styled("[ 取消 ]", cancel_style),
                Span::raw("   "),
                Span::styled(format!("[ 确认{} ]", dialog.action.title()), confirm_style),
            ]);
            let hint = Line::from(Span::styled(
                "Esc 取消 · ←/→ 切换 · Enter 执行当前按钮（默认取消）",
                theme.muted(),
            ));
            frame.render_widget(Paragraph::new(vec![buttons, hint]), chunks[1]);
        }
        Modal::Help => {
            let popup = popup_rect(area, 86, area.height.saturating_sub(4), 100);
            frame.render_widget(Clear, popup);
            let block = Block::bordered()
                .border_style(theme.border())
                .border_type(BorderType::Rounded)
                .title(Span::styled(" 帮助 ", theme.accent()));
            let text = safe_block(&help_text(app));
            frame.render_widget(
                Paragraph::new(text).block(block).wrap(Wrap { trim: false }),
                popup,
            );
        }
        Modal::Detail {
            title,
            text,
            scroll,
        } => {
            let popup = popup_rect(area, 88, area.height.saturating_sub(4), 100);
            frame.render_widget(Clear, popup);
            let block = Block::bordered()
                .border_style(theme.border())
                .border_type(BorderType::Rounded)
                .title(Span::styled(
                    format!(" {} ", safe_inline(title)),
                    theme.accent(),
                ));
            let inner = block.inner(popup);
            frame.render_widget(block, popup);
            let chunks = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).split(inner);
            frame.render_widget(
                Paragraph::new(safe_block(text))
                    .scroll((*scroll, 0))
                    .wrap(Wrap { trim: false }),
                chunks[0],
            );
            frame.render_widget(
                Paragraph::new(Span::styled("Esc/q 返回 · j/k 滚动", theme.muted())),
                chunks[1],
            );
        }
        Modal::Input(dialog) => {
            let popup = popup_rect(area, 72, 7, 90);
            frame.render_widget(Clear, popup);
            let block = Block::bordered()
                .border_style(theme.border())
                .border_type(BorderType::Rounded)
                .title(Span::styled(
                    format!(" {} ", safe_inline(&dialog.title)),
                    theme.accent(),
                ));
            let inner = block.inner(popup);
            frame.render_widget(block, popup);
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(vec![
                        Span::styled("> ", theme.accent()),
                        Span::raw(safe_inline(&dialog.value)),
                        Span::styled("_", theme.warning()),
                    ]),
                    Line::default(),
                    Line::from(Span::styled(
                        "Enter 应用 · Esc 取消 · Ctrl+U 清空",
                        theme.muted(),
                    )),
                ]),
                inner,
            );
        }
    }
}

fn popup_rect(area: Rect, width_percent: u16, height_lines: u16, max_width: u16) -> Rect {
    let width = area
        .width
        .saturating_mul(width_percent)
        .saturating_div(100)
        .min(max_width)
        .min(area.width.saturating_sub(2))
        .max(30);
    let height = height_lines
        .saturating_add(2)
        .min(area.height.saturating_sub(2))
        .max(7);
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

fn help_text(app: &App) -> String {
    let page_help = match app.page {
        Page::Overview => {
            "总览\n↑↓/jk 选择 provider · Enter 详情 · 2 服务 · 3 额度 · 5 日志 · 6 诊断"
        }
        Page::Providers => {
            "服务\nu 启动 · d 停止 · K 停止但保留客户端 · R 重启\no 仅启用此家（会关闭其他已启用项）\nx 关闭此家 · s 同步 · A 全部启用 · N 全部关闭\nL 日志 · Enter 详情\n网关是叠加层：不参与 on/off，用 node router.mjs gateway up/down"
        }
        Page::Credits => {
            "额度\n↑↓ 选择额度行 · Enter 详情 · r 刷新\nc 签到（当前后端未统一接入，只展示状态）\n4 转到相同 provider 的账号页"
        }
        Page::Accounts => {
            "账号\n↑↓ 选择 · Enter 详情 · v 预览切换 · c 正式切换\na 恢复整池 · A 添加账号 · L 登录 · 3 额度"
        }
        Page::Logs => {
            "日志\np 暂停/跟随 · f 过滤 · n/N 跳到下一个/上一个命中\n+/- 调整尾部行数 · c 清除视图（不删文件）\nEnd 底部 · Home 顶部 · ↑↓ 滚动 · ←→ 切换 provider"
        }
        Page::Diagnostics => {
            "诊断\nd 运行 doctor · h 无试打健康检查 · P 真实试打（需确认）\n←→ 切换 provider · ↑↓ 滚动 · 5 日志"
        }
        Page::Usage => {
            "用量分析\n↑↓/jk 选择模型 · Enter 查看 Token/成本详情\nt 切换近 24 小时、近 7 天、近 30 天和全部历史\n数据来自 OpenCode experimental.session.stats；steps 是会话步骤，不等于 HTTP 请求数"
        }
    };
    let mode = if app.info.demo {
        "DEMO：只使用匿名内存数据，不启动 Node，不改变真实状态。"
    } else if app.info.read_only {
        "LIVE + READ-ONLY：可以读取真实状态，所有写操作和消耗型操作被禁用。"
    } else {
        "LIVE：写操作需弹窗确认；刷新不会自动启动、登录、签到或试打。"
    };
    format!(
        "{page_help}\n\n全局\n1–7 页面 · r 当前页刷新 · O 最近操作输出\n? 帮助 · q/Ctrl+C 退出 · Esc 关闭弹窗\n\n模式\n{mode}\n\n状态图例\n●/RUN 运行 · ○/STOP 停止 · * 当前账号 · + 轮询 · - 停用\n— 表示未知/缺失，不等于数值 0；stale 表示保留了旧数据。\n\n安全\n高风险操作默认取消；写任务执行期间不能退出；登录暂时交还终端。\n\n{backend}\n{root}",
        backend = app.info.backend_label,
        root = app.info.root,
    )
}

fn age(last: Option<Instant>) -> String {
    let Some(last) = last else {
        return "—".into();
    };
    let seconds = last.elapsed().as_secs();
    if seconds < 2 {
        "刚刚".into()
    } else if seconds < 60 {
        format!("{seconds}s 前")
    } else if seconds < 3600 {
        format!("{}m 前", seconds / 60)
    } else {
        format!("{}h 前", seconds / 3600)
    }
}

fn cell(text: impl Into<String>, style: Style) -> Cell<'static> {
    Cell::from(safe_inline(&text.into())).style(style)
}

fn safe_inline(input: &str) -> String {
    sanitize_text(input)
        .text
        .replace('\n', " ")
        .trim_end()
        .to_string()
}

fn safe_block(input: &str) -> String {
    sanitize_text(input).text
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "是"
    } else {
        "否"
    }
}

fn drift_description(provider: &Provider) -> String {
    if provider.overlay() {
        return "叠加层".into();
    }
    if !provider.drift() {
        return "一致".into();
    }
    let mut parts = Vec::new();
    if provider.on != provider.up {
        parts.push(if provider.on {
            "已启用但未运行"
        } else {
            "已停用但仍在运行"
        });
    }
    if provider.on != provider.oc && !provider.oc_user_owned {
        parts.push(if provider.oc {
            "开关关闭但客户端仍存在"
        } else {
            "开关开启但客户端未写入"
        });
    }
    parts.join("；")
}

fn capability_label(capability: PlatformCapability) -> String {
    match capability {
        PlatformCapability::Supported => "可用（实际结果以 Node 后端为准）".into(),
        PlatformCapability::Unsupported(reason) => format!("受限：{reason}"),
    }
}

trait StringExt {
    fn if_empty(self, fallback: &'static str) -> String;
}

impl StringExt for String {
    fn if_empty(self, fallback: &'static str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use futures_util::FutureExt;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    use super::*;
    use crate::app::{App, AppInfo};
    use crate::cli::Appearance;

    fn test_app() -> App {
        let mut app = App::new(AppInfo {
            backend_label: "DEMO",
            root: "anonymous-demo".into(),
            node: "demo".into(),
            demo: true,
            read_only: false,
            ascii: false,
            no_color: true,
            appearance: Appearance::Dark,
            refresh_secs: 5,
        });
        app.handle_message(crate::app::AppMessage::Providers {
            request_id: app.providers.request_id,
            result: Ok(crate::backend::fixture::FixtureBackend::new(false)
                .providers()
                .now_or_never()
                .expect("fixture providers resolve immediately")
                .unwrap()),
        });
        app.handle_message(crate::app::AppMessage::Accounts {
            request_id: app.accounts.request_id,
            result: Ok(crate::backend::fixture::FixtureBackend::new(false)
                .accounts()
                .now_or_never()
                .expect("fixture accounts resolve immediately")
                .unwrap()),
        });
        app.handle_message(crate::app::AppMessage::Credits {
            request_id: app.credits.request_id,
            result: Ok(crate::backend::fixture::FixtureBackend::new(false)
                .credits()
                .now_or_never()
                .expect("fixture credits resolve immediately")
                .unwrap()),
        });
        app.handle_message(crate::app::AppMessage::Usage {
            request_id: app.usage.request_id,
            result: Ok(crate::backend::fixture::FixtureBackend::new(false)
                .usage(crate::domain::UsageRange::Week)
                .now_or_never()
                .expect("fixture usage resolves immediately")
                .unwrap()),
        });
        app
    }

    fn render(app: &mut App, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| draw(frame, app))
            .expect("render should work");
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer.cell((x, y)).map_or(" ", |cell| cell.symbol()))
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn overview_renders_at_80x24() {
        let mut app = test_app();
        let output = render(&mut app, 80, 24);
        let compact: String = output.chars().filter(|ch| !ch.is_whitespace()).collect();
        assert!(compact.contains("RouterControl"));
        assert!(compact.contains("总览"));
        assert!(compact.contains("Qoder"));
    }

    #[test]
    fn all_pages_render_without_panic() {
        let mut app = test_app();
        for page in Page::ALL {
            app.page = page;
            let output = render(&mut app, 80, 24);
            assert!(!output.trim().is_empty());
        }
    }

    #[test]
    fn usage_page_renders_real_metric_cards_and_model_table() {
        let mut app = test_app();
        app.page = Page::Usage;
        let output = render(&mut app, 100, 30);
        let compact: String = output.chars().filter(|ch| !ch.is_whitespace()).collect();
        assert!(compact.contains("会话步骤"));
        assert!(compact.contains("工具成功率"));
        assert!(compact.contains("codearts"));
        assert!(compact.contains("demo-code-model"));
        assert!(compact.contains("每日活动"));
    }

    #[test]
    fn overview_includes_usage_cards_at_standard_size() {
        let mut app = test_app();
        let output = render(&mut app, 100, 30);
        let compact: String = output.chars().filter(|ch| !ch.is_whitespace()).collect();
        assert!(compact.contains("Token构成"));
        assert!(compact.contains("服务状态"));
    }

    #[test]
    fn gateway_row_is_shown_as_an_overlay() {
        let mut app = test_app();
        let output = render(&mut app, 110, 32);
        let compact: String = output.chars().filter(|ch| !ch.is_whitespace()).collect();
        // 网关行必须出现，开关列是「叠加」而不是「开」。
        assert!(compact.contains("统一网关"));
        assert!(compact.contains("叠加"));
        // 启用比率的分母不含网关：演示数据是 9 家反代全开。
        assert!(compact.contains("启用9/9"), "{compact}");
        // 演示数据里 CodeArts 故意停着，漂移应该是 1（只有它），网关不计入。
        assert!(compact.contains("配置漂移1"), "{compact}");
        // 网关在线会单独标出来。
        assert!(compact.contains("网关在线"), "{compact}");
    }

    #[test]
    fn credits_page_shows_exhausted_and_compact_status() {
        let mut app = test_app();
        app.credits.data.as_mut().unwrap().rows[1].available = true;
        app.credits.data.as_mut().unwrap().rows[1].quota_exhausted = true;
        app.page = Page::Credits;
        let output = render(&mut app, 110, 30);
        let compact: String = output.chars().filter(|ch| !ch.is_whitespace()).collect();
        assert!(compact.contains("额度已耗尽"), "{compact}");
        // 窄列不放大段上游文案。
        assert!(!compact.contains("该区域没有签到接口"), "{compact}");
    }

    #[test]
    fn dynamic_backend_fields_cannot_emit_terminal_escapes() {
        let mut app = test_app();
        app.providers.data.as_mut().unwrap().providers[0].title =
            "bad \x1b]0;owned\x07 title".into();
        app.providers.data.as_mut().unwrap().providers[0].auth.label = "auth \x1b[2J clear".into();
        app.accounts.data.as_mut().unwrap().providers[0].title = "account \x1b[31m red".into();
        app.accounts.data.as_mut().unwrap().providers[0].accounts[0].name =
            "name \x1b]52;c;x\x07".into();
        app.credits.data.as_mut().unwrap().rows[0].title = "quota \x1b[2J".into();
        for page in Page::ALL {
            app.page = page;
            let output = render(&mut app, 80, 24);
            assert!(!output.contains('\x1b'), "escape leaked on {page:?}");
            assert!(!output.contains("owned"), "OSC payload leaked on {page:?}");
        }
    }

    #[test]
    fn confirm_defaults_to_cancel_visual() {
        let mut app = test_app();
        app.page = Page::Providers;
        app.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('u'),
            crossterm::event::KeyModifiers::NONE,
        ));
        let output = render(&mut app, 100, 30);
        let compact: String = output.chars().filter(|ch| !ch.is_whitespace()).collect();
        assert!(compact.contains("确认"));
        assert!(compact.contains("取消"));
    }
}
