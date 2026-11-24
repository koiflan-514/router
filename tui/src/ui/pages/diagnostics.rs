//! 诊断页：checklist 图标 + 健康 meter + 结果摘要。
//!
//! 真实试打仍需弹窗确认（逻辑在 app.rs），这里只负责展示与滚动。

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState};
use ratatui::Frame;

use crate::app::App;

use crate::ui::common::{check_glyph, diagnostic_checks, safe_block, safe_inline, Check};
use crate::ui::layout::Breakpoint;
use crate::ui::theme::{fit_width, Theme, Tone};
use crate::ui::widgets;

pub fn render(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    let checks = diagnostic_checks(app);
    let pass = checks
        .iter()
        .filter(|check| check.tone == Tone::Success)
        .count();
    let total = checks.len().max(1);
    let ratio = pass as f64 / total as f64;

    if breakpoint.is_wide() && area.height >= 18 {
        let chunks = Layout::horizontal([Constraint::Length(34), Constraint::Min(30)]).split(area);
        render_checklist(frame, chunks[0], &checks, pass, total, ratio, theme);
        render_output(frame, chunks[1], app, theme);
    } else {
        // 非宽屏：清单占满它需要的行（标题 + 每项 + meter + 边框），
        // 余下空间全给输出；最小保留 4 行输出。
        let wanted = checks.len() as u16 + 4;
        let checklist_height = wanted.min(area.height.saturating_sub(4)).max(4);
        let chunks = Layout::vertical([Constraint::Length(checklist_height), Constraint::Min(4)])
            .split(area);
        render_checklist(frame, chunks[0], &checks, pass, total, ratio, theme);
        render_output(frame, chunks[1], app, theme);
    }
}

fn render_checklist(
    frame: &mut Frame,
    area: Rect,
    checks: &[Check],
    pass: usize,
    total: usize,
    ratio: f64,
    theme: Theme,
) {
    let block = theme.panel_with_metric("自检清单", Some(format!("{pass}/{total} 通过")));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.is_empty() {
        return;
    }
    let glyphs = theme.glyphs();
    let meter_rows = u16::from(inner.height >= 3);
    let list_height = inner.height.saturating_sub(meter_rows);
    // 标签列按最长标签对齐，避免「provider JSONschema=1」这种黏连。
    let label_column = checks
        .iter()
        .map(|check| crate::ui::theme::text_width(check.label))
        .max()
        .unwrap_or(10)
        .clamp(8, (inner.width as usize).saturating_sub(10).max(8));
    let mut lines = Vec::new();
    for check in checks.iter().take(list_height as usize) {
        let glyph = check_glyph(theme, check.tone);
        let value_width = (inner.width as usize).saturating_sub(label_column + 4);
        lines.push(Line::from(vec![
            Span::styled(glyph, theme.badge(check.tone)),
            Span::raw(" "),
            Span::styled(
                crate::ui::theme::pad_display(check.label, label_column),
                theme.muted(),
            ),
            Span::raw(" "),
            Span::styled(
                fit_width(&check.value, value_width.max(6), glyphs.ellipsis()),
                theme.fg(check.tone),
            ),
        ]));
    }
    // 放不下时最后一行换成「还有 N 项」，不静默截断。
    if checks.len() > list_height as usize && list_height > 0 {
        if let Some(last) = lines.last_mut() {
            *last = Line::from(Span::styled(
                format!(
                    "… 还有 {} 项（窗口放大可见）",
                    checks.len() - list_height as usize + 1
                ),
                theme.muted(),
            ));
        }
    }
    frame.render_widget(
        Paragraph::new(lines),
        Rect {
            height: list_height,
            ..inner
        },
    );

    if meter_rows > 0 {
        let meter_area = Rect {
            y: inner.bottom() - 1,
            height: 1,
            ..inner
        };
        let meter = widgets::meter_string(theme, Some(ratio), meter_area.width as usize);
        let tone = if ratio >= 0.99 {
            Tone::Success
        } else if ratio >= 0.7 {
            Tone::Warning
        } else {
            Tone::Error
        };
        frame.render_widget(
            Paragraph::new(Span::styled(meter, theme.fg(tone))),
            meter_area,
        );
    }
}

fn render_output(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let glyphs = theme.glyphs();
    let title = format!("诊断输出 · {}", safe_inline(&app.diag_title));
    let metric = app
        .diag
        .data
        .as_ref()
        .and_then(|result| result.exit_code)
        .map(|code| format!("退出码 {code}"));
    let block = theme.panel_with_metric(title, metric);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.is_empty() {
        return;
    }

    let mut lines: Vec<Line> = Vec::new();
    if app.diag.refreshing {
        lines.push(Line::from(Span::styled(
            format!("{} 正在运行…", glyphs.bullet()),
            theme.fg(Tone::Info),
        )));
    }
    if let Some(error) = app.diag.error.as_ref() {
        lines.push(Line::from(vec![
            Span::styled(glyphs.bad(), theme.badge(Tone::Error)),
            Span::raw(" "),
            Span::styled(safe_inline(error), theme.fg(Tone::Error)),
        ]));
    }
    if let Some(result) = app.diag.data.as_ref() {
        for raw in safe_block(&result.text).lines() {
            let (tone, _) = crate::ui::common::log_level(raw);
            let tone = match tone {
                Tone::Info => Tone::Normal,
                other => other,
            };
            lines.push(Line::from(Span::styled(
                fit_width(raw, inner.width as usize, glyphs.ellipsis()),
                theme.fg(tone),
            )));
        }
        if result.truncated {
            lines.push(Line::from(Span::styled(
                "[输出已截断]",
                theme.fg(Tone::Warning),
            )));
        }
    } else if !app.diag.refreshing && app.diag.error.is_none() {
        lines.push(Line::from(Span::styled(
            "d 运行 doctor · h 无试打健康检查 · P 真实试打（需确认）",
            theme.muted(),
        )));
    }

    let max_scroll = (lines.len() as u16).saturating_sub(inner.height);
    let scroll = app.diag_scroll.min(max_scroll);
    let line_count = lines.len();
    frame.render_widget(Paragraph::new(lines).scroll((scroll, 0)), inner);

    if max_scroll > 0 {
        let mut state = ScrollbarState::new(line_count)
            .position(scroll as usize)
            .viewport_content_length(inner.height as usize);
        let scrollbar = Scrollbar::new(ScrollbarOrientation::VerticalRight)
            .symbols(glyphs.scrollbar_set())
            .thumb_style(theme.fg(Tone::Accent))
            .track_style(theme.muted());
        frame.render_stateful_widget(scrollbar, inner, &mut state);
    }
}
