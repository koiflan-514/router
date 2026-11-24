//! 服务页：状态矩阵 + 操作键位。
//!
//! 保留原有键位与危险操作确认；这里只重排视觉，把「开关 / 进程 / 客户端」
//! 三个维度并排展示，漂移行用警告色。

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Row, Table, TableState};
use ratatui::Frame;

use crate::app::App;
use crate::domain::Provider;

use crate::ui::common::{
    drift_description, process_label, process_tone, provider_stats, safe_inline,
};
use crate::ui::layout::Breakpoint;
use crate::ui::theme::{fit_width, Theme, Tone};
use crate::ui::widgets;

pub fn render(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    let show_summary = area.height >= 14;
    let chunks = if show_summary {
        Layout::vertical([Constraint::Min(6), Constraint::Length(3)]).split(area)
    } else {
        Layout::vertical([Constraint::Min(4), Constraint::Length(0)]).split(area)
    };
    render_table(frame, chunks[0], app, theme, breakpoint);
    if show_summary {
        render_selection(frame, chunks[1], app, theme);
    }
}

fn render_table(frame: &mut Frame, area: Rect, app: &App, theme: Theme, breakpoint: Breakpoint) {
    let stats = provider_stats(app);
    let block = theme.panel_with_metric(
        "服务",
        Some(format!(
            "启用 {}/{} · 运行 {}/{}",
            stats.enabled, stats.managed, stats.up, stats.total
        )),
    );
    let Some(snapshot) = app.providers.data.as_ref() else {
        let message = if app.providers.refreshing {
            "正在读取 provider 状态…"
        } else if let Some(error) = app.providers.error.as_ref() {
            error.as_str()
        } else {
            "尚未加载 provider 状态；按 r 重试。"
        };
        frame.render_widget(widgets::placeholder(theme, message).block(block), area);
        return;
    };

    let (headers, widths) = columns_for(area.width, breakpoint);
    let rows = snapshot
        .providers
        .iter()
        .map(|provider| row(app, provider, area.width, breakpoint, theme))
        .collect::<Vec<_>>();
    let table = Table::new(rows, widths)
        .header(Row::new(
            headers
                .into_iter()
                .map(|header| Cell::from(header).style(theme.table_header())),
        ))
        .block(block)
        .column_spacing(1)
        .highlight_symbol(theme.highlight_symbol())
        .row_highlight_style(theme.selected());
    let mut state = TableState::default().with_selected(Some(app.provider_cursor));
    frame.render_stateful_widget(table, area, &mut state);
}

fn columns_for(width: u16, breakpoint: Breakpoint) -> (Vec<&'static str>, Vec<Constraint>) {
    if breakpoint.is_wide() || width >= 100 {
        (
            vec![
                "Provider",
                "开关",
                "进程",
                "客户端",
                "认证",
                "PID",
                "端口",
                "模型",
                "状态",
            ],
            vec![
                Constraint::Min(18),
                Constraint::Length(4),
                Constraint::Length(7),
                Constraint::Length(8),
                Constraint::Length(11),
                Constraint::Length(7),
                Constraint::Length(5),
                Constraint::Length(4),
                Constraint::Min(14),
            ],
        )
    } else if breakpoint.is_compact() {
        (
            vec!["Provider", "开关", "进程", "认证"],
            vec![
                Constraint::Min(10),
                Constraint::Length(4),
                Constraint::Length(7),
                Constraint::Length(9),
            ],
        )
    } else {
        (
            vec!["Provider", "开关", "进程", "客户端", "认证", "模型"],
            vec![
                Constraint::Min(12),
                Constraint::Length(4),
                Constraint::Length(7),
                Constraint::Length(7),
                Constraint::Length(10),
                Constraint::Length(4),
            ],
        )
    }
}

fn row(
    app: &App,
    provider: &Provider,
    width: u16,
    breakpoint: Breakpoint,
    theme: Theme,
) -> Row<'static> {
    let glyphs = theme.glyphs();
    let auth = provider.auth.effective_state();
    let mut cells = vec![cell(
        fit_width(&safe_inline(&provider.title), 16, glyphs.ellipsis()),
        theme.provider(&provider.id),
    )];
    cells.push(cell(
        provider.switch_label(),
        if provider.overlay() {
            theme.muted()
        } else if provider.on {
            theme.fg(Tone::Success)
        } else {
            theme.muted()
        },
    ));
    cells.push(cell(
        process_label(theme, provider.up),
        theme.fg(process_tone(provider.up)),
    ));
    if !breakpoint.is_compact() {
        cells.push(cell(provider.client_short(), theme.muted()));
    }
    cells.push(cell(
        fit_width(auth.label(), 11, glyphs.ellipsis()),
        theme.fg(crate::ui::common::auth_tone(auth)),
    ));
    if breakpoint.is_wide() || width >= 100 {
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
        cells.push(cell(format!("{:>5}", provider.port), theme.muted()));
        cells.push(cell(
            provider
                .models
                .map(|value| format!("{value:>3}"))
                .unwrap_or_else(|| "  —".into()),
            theme.muted(),
        ));
    } else if !breakpoint.is_compact() {
        cells.push(cell(
            provider
                .models
                .map(|value| value.to_string())
                .unwrap_or_else(|| "—".into()),
            theme.muted(),
        ));
    }
    if breakpoint.is_wide() || width >= 100 {
        let tone = if provider.drift() {
            Tone::Warning
        } else {
            Tone::Muted
        };
        cells.push(cell(
            fit_width(&compact_drift(provider), 26, glyphs.ellipsis()),
            theme.fg(tone),
        ));
    }
    let _ = app;
    Row::new(cells)
}

fn render_selection(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let block = theme.panel("选中项");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(provider) = app.selected_provider() else {
        frame.render_widget(widgets::placeholder(theme, "未选中 provider"), inner);
        return;
    };
    let glyphs = theme.glyphs();
    let drift = drift_description(provider);
    let drift_tone = if provider.drift() {
        Tone::Warning
    } else {
        Tone::Muted
    };
    let auth = provider.auth.effective_state();
    let line = Line::from(vec![
        Span::styled(
            fit_width(&safe_inline(&provider.title), 20, glyphs.ellipsis()),
            theme.provider(&provider.id),
        ),
        Span::raw("  "),
        Span::styled(
            format!(
                "开关 {} · 进程 {} · 客户端 {}",
                provider.switch_label(),
                if provider.up { "运行" } else { "停止" },
                provider.client_label()
            ),
            theme.muted(),
        ),
        Span::raw("  "),
        Span::styled(
            format!("认证 {}", auth.label()),
            theme.fg(crate::ui::common::auth_tone(auth)),
        ),
        Span::raw("  "),
        Span::styled(
            format!(
                "{} 漂移：{drift}",
                crate::ui::common::check_glyph(theme, drift_tone)
            ),
            theme.fg(drift_tone),
        ),
    ]);
    frame.render_widget(ratatui::widgets::Paragraph::new(line), inner);
}

/// 表格里的漂移短标签：详情弹窗仍用完整描述。
fn compact_drift(provider: &Provider) -> String {
    if provider.overlay() {
        return "叠加层".into();
    }
    if !provider.drift() {
        return "一致".into();
    }
    let mut parts = Vec::new();
    if provider.on != provider.up {
        parts.push(if provider.on {
            "开≠进程"
        } else {
            "关≠进程"
        });
    }
    if provider.on != provider.oc && !provider.oc_user_owned {
        parts.push(if provider.oc {
            "关≠客户端"
        } else {
            "开≠客户端"
        });
    }
    parts.join(" · ")
}

fn cell(text: impl Into<String>, style: ratatui::style::Style) -> Cell<'static> {
    Cell::from(text.into()).style(style)
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
