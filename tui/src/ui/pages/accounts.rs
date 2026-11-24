//! 账号页：slot / 当前 / 健康 / 有效期，状态色与图标。

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Row, Table, TableState};
use ratatui::Frame;

use crate::app::App;
use crate::domain::HealthLevel;

use crate::ui::common::{health_glyph, health_tone, safe_inline, yes_no};
use crate::ui::layout::Breakpoint;
use crate::ui::theme::{fit_width, Theme, Tone};
use crate::ui::widgets;

pub fn render(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    let show_summary = area.height >= 16 && !breakpoint.is_compact();
    let chunks = if show_summary {
        Layout::vertical([Constraint::Min(6), Constraint::Length(3)]).split(area)
    } else {
        Layout::vertical([Constraint::Min(4), Constraint::Length(0)]).split(area)
    };
    render_table(frame, chunks[0], app, theme, breakpoint);
    if show_summary {
        render_selected(frame, chunks[1], app, theme);
    }
}

fn render_table(frame: &mut Frame, area: Rect, app: &App, theme: Theme, breakpoint: Breakpoint) {
    let total = app.selectable_account_count();
    let block = theme.panel_with_metric("账号", Some(format!("{total} 个 slot")));
    let Some(snapshot) = app.accounts.data.as_ref() else {
        let message = if app.accounts.refreshing {
            "正在读取账号…"
        } else if let Some(error) = app.accounts.error.as_ref() {
            error.as_str()
        } else {
            "尚未加载账号；按 r 重试。"
        };
        frame.render_widget(widgets::placeholder(theme, message).block(block), area);
        return;
    };

    let (headers, widths) = columns_for(area.width, breakpoint);
    let mut rows = Vec::new();
    for group in &snapshot.providers {
        for account in &group.accounts {
            rows.push(account_row(
                &group.title,
                &group.id,
                account,
                area.width,
                breakpoint,
                theme,
            ));
        }
    }
    if rows.is_empty() {
        frame.render_widget(
            widgets::placeholder(theme, "没有账号记录").block(block),
            area,
        );
        return;
    }
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
    let selected = if total == 0 {
        0
    } else {
        app.account_cursor.min(total - 1)
    };
    let mut state = TableState::default().with_selected(Some(selected));
    frame.render_stateful_widget(table, area, &mut state);
}

fn columns_for(width: u16, breakpoint: Breakpoint) -> (Vec<&'static str>, Vec<Constraint>) {
    if breakpoint.is_wide() || width >= 100 {
        (
            vec!["Provider", "Slot", "名称", "轮询", "当前", "健康", "说明"],
            vec![
                Constraint::Min(13),
                Constraint::Length(12),
                Constraint::Min(10),
                Constraint::Length(5),
                Constraint::Length(7),
                Constraint::Length(7),
                Constraint::Min(12),
            ],
        )
    } else if breakpoint.is_compact() {
        (
            vec!["Provider", "Slot", "轮询", "当前", "健康"],
            vec![
                Constraint::Min(10),
                Constraint::Length(10),
                Constraint::Length(4),
                Constraint::Length(5),
                Constraint::Length(5),
            ],
        )
    } else {
        (
            vec!["Provider", "Slot", "轮询", "当前", "健康", "说明"],
            vec![
                Constraint::Min(12),
                Constraint::Length(10),
                Constraint::Length(4),
                Constraint::Length(6),
                Constraint::Length(6),
                Constraint::Min(10),
            ],
        )
    }
}

fn account_row(
    group_title: &str,
    group_id: &str,
    account: &crate::domain::Account,
    width: u16,
    breakpoint: Breakpoint,
    theme: Theme,
) -> Row<'static> {
    let glyphs = theme.glyphs();
    let marker_tone = if account.active {
        Tone::Success
    } else if account.enabled {
        Tone::Info
    } else {
        Tone::Muted
    };
    let marker = if account.active {
        glyphs.on()
    } else if account.enabled {
        glyphs.bullet()
    } else {
        glyphs.off()
    };
    let health_tone = health_tone(account.health.level);
    // 未知健康只显示破折号：后端没给结论时不要伪造「未知」占宽。
    let health = if account.health.level == HealthLevel::Unknown {
        "—".to_string()
    } else {
        health_glyph(theme, account.health.level)
    };
    let detail = detail_text(account);

    let mut cells = vec![
        cell(
            fit_width(&safe_inline(group_title), 13, glyphs.ellipsis()),
            theme.provider(group_id),
        ),
        cell(
            fit_width(&safe_inline(&account.key), 11, glyphs.ellipsis()),
            theme.fg(marker_tone),
        ),
    ];
    if !breakpoint.is_compact() {
        cells.push(cell(
            fit_width(&safe_inline(&account.name), 14, glyphs.ellipsis()),
            theme.muted(),
        ));
    }
    cells.push(cell(
        if account.enabled { "参与" } else { "停用" },
        if account.enabled {
            theme.fg(Tone::Success)
        } else {
            theme.muted()
        },
    ));
    cells.push(cell(
        if account.active {
            format!("{marker}生效")
        } else {
            "—".into()
        },
        theme.fg(marker_tone),
    ));
    cells.push(cell(
        fit_width(&health, 6, glyphs.ellipsis()),
        theme.fg(health_tone),
    ));
    if breakpoint.is_wide() || width >= 100 {
        cells.push(cell(
            fit_width(&detail, 24, glyphs.ellipsis()),
            if account.health.level.is_problem() {
                theme.fg(health_tone)
            } else {
                theme.muted()
            },
        ));
    } else if !breakpoint.is_compact() {
        cells.push(cell(
            fit_width(&detail, 18, glyphs.ellipsis()),
            theme.muted(),
        ));
    }
    Row::new(cells)
}

fn detail_text(account: &crate::domain::Account) -> String {
    match (account.health.summary(), account.health.level) {
        (Some(note), HealthLevel::Error) => {
            format!("{note} · {}", account.detail.clone().unwrap_or_default())
        }
        (Some(note), HealthLevel::Warn) => format!(
            "{} · {note}",
            account.detail.clone().unwrap_or_else(|| "—".into())
        ),
        _ => account.detail.clone().unwrap_or_else(|| "—".into()),
    }
}

fn render_selected(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let block = theme.panel("选中账号");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let Some(selected) = app.selected_account() else {
        frame.render_widget(widgets::placeholder(theme, "未选中账号"), inner);
        return;
    };
    let glyphs = theme.glyphs();
    let account = selected.account;
    let line = Line::from(vec![
        Span::styled(
            fit_width(&safe_inline(&selected.group.title), 16, glyphs.ellipsis()),
            theme.provider(&selected.group.id),
        ),
        Span::raw("  "),
        Span::styled(safe_inline(&account.key), theme.bold(Tone::Accent)),
        Span::raw("  "),
        Span::styled(
            format!(
                "轮询 {} · 当前 {} · 可切换 {}",
                yes_no(account.enabled),
                yes_no(account.active),
                yes_no(selected.group.switchable)
            ),
            theme.muted(),
        ),
        Span::raw("  "),
        Span::styled(
            health_glyph(theme, account.health.level),
            theme.fg(health_tone(account.health.level)),
        ),
    ]);
    frame.render_widget(ratatui::widgets::Paragraph::new(line), inner);
}

fn cell(text: impl Into<String>, style: ratatui::style::Style) -> Cell<'static> {
    Cell::from(text.into()).style(style)
}
