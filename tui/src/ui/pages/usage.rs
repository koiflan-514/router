//! 用量页：KPI 卡 + 每日活动图 + Token 构成 + 工具成功率 + 模型表。

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Cell, Row, Table, TableState};
use ratatui::Frame;

use crate::app::App;
use crate::domain::{format_compact, format_percent, ModelUsage};

use crate::ui::common::{
    activity_values, safe_inline, success_label, token_breakdown, tool_success, usage_range_label,
};
use crate::ui::layout::Breakpoint;
use crate::ui::theme::{fit_width, safe_ratio, Theme, Tone};
use crate::ui::widgets::{self, Kpi};

pub fn render(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    if area.height >= 18 {
        // KPI 4 行：最后一行留给工具成功率 gauge。
        let chunks = Layout::vertical([
            Constraint::Length(4),
            Constraint::Length(6),
            Constraint::Min(6),
        ])
        .split(area);
        render_kpis(frame, chunks[0], app, theme, breakpoint);
        render_breakdown(frame, chunks[1], app, theme, breakpoint);
        render_models(frame, chunks[2], app, theme, breakpoint);
    } else if area.height >= 13 {
        let chunks = Layout::vertical([Constraint::Length(3), Constraint::Min(6)]).split(area);
        render_kpis(frame, chunks[0], app, theme, breakpoint);
        render_models(frame, chunks[1], app, theme, breakpoint);
    } else {
        let chunks = Layout::vertical([Constraint::Length(2), Constraint::Min(4)]).split(area);
        render_kpis(frame, chunks[0], app, theme, breakpoint);
        render_models(frame, chunks[1], app, theme, breakpoint);
    }
}

fn render_kpis(frame: &mut Frame, area: Rect, app: &App, theme: Theme, breakpoint: Breakpoint) {
    let snapshot = app.usage.data.as_ref();
    let sessions = snapshot.map(|usage| usage.sessions);
    let steps = snapshot.map(|usage| usage.steps);
    let tokens = snapshot.map(|usage| usage.tokens.visible_total());
    let cost = snapshot.map(|usage| usage.cost).unwrap_or(0.0);
    let active_days = snapshot.map(|usage| usage.active_days).unwrap_or(0);
    let streak = snapshot.map(|usage| usage.streak).unwrap_or(0);
    let (success, succeeded, calls) = tool_success(app);

    let mut items = vec![
        Kpi::new(
            "会话步骤",
            format!(
                "{} / {}",
                sessions.map_or_else(|| "—".into(), |value| value.to_string()),
                steps.map_or_else(|| "—".into(), format_compact),
            ),
            Tone::Accent,
        )
        .detail(usage_range_label(app)),
        Kpi::new(
            "Token",
            tokens.map_or_else(|| "—".into(), format_compact),
            Tone::Info,
        )
        .detail("输入 + 输出 + 推理"),
        Kpi::new(
            "成本",
            format!("${cost:.2}"),
            if cost > 0.0 {
                Tone::Warning
            } else {
                Tone::Muted
            },
        )
        .detail("OpenCode 上报"),
        Kpi::new(
            "活跃日 / 连续",
            format!("{active_days} / {streak}"),
            Tone::Success,
        )
        .detail("天数"),
        Kpi::new(
            "工具成功率",
            format_percent(success),
            if success.is_some_and(|value| value < 0.95) {
                Tone::Warning
            } else {
                Tone::Success
            },
        )
        .detail(success_label(succeeded, calls))
        .ratio(success.unwrap_or(0.0)),
    ];
    if breakpoint.is_compact() {
        items.truncate(3);
    } else if !breakpoint.is_wide() {
        items.truncate(4);
    }
    widgets::render_kpis(frame, area, theme, &items);
}

fn render_breakdown(
    frame: &mut Frame,
    area: Rect,
    app: &App,
    theme: Theme,
    breakpoint: Breakpoint,
) {
    if breakpoint.is_compact() {
        return;
    }
    let chunks = Layout::horizontal([Constraint::Min(28), Constraint::Length(22)]).split(area);
    render_activity(frame, chunks[0], app, theme);
    render_tokens(frame, chunks[1], app, theme);
}

fn render_activity(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let values = activity_values(app, 30);
    let stale = if app.usage.error.is_some() {
        " · 旧数据"
    } else {
        ""
    };
    let block = theme.panel_with_metric(
        "每日活动",
        Some(format!("{}{stale}", usage_range_label(app))),
    );
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.is_empty() {
        return;
    }
    if values.is_empty() {
        let message = if app.usage.refreshing {
            "正在读取 OpenCode 会话统计…"
        } else if app.usage.data.is_some() {
            "当前时间范围没有活动记录"
        } else if let Some(error) = app.usage.error.as_ref() {
            error.as_str()
        } else {
            "OpenCode 统计尚未返回"
        };
        frame.render_widget(widgets::placeholder(theme, message), inner);
        return;
    }
    let label_height = u16::from(inner.height >= 4);
    let chart_area = Rect {
        height: inner.height.saturating_sub(label_height),
        ..inner
    };
    widgets::render_sparkline(frame, chart_area, theme, &values, "无活动");

    if label_height > 0 {
        let peak = widgets::peak(&values);
        let days = values.len();
        let label = Line::from(vec![
            Span::styled("峰值 ", theme.muted()),
            Span::styled(format_compact(peak), theme.bold(Tone::Accent)),
            Span::styled(format!(" · {days} 天"), theme.muted()),
        ]);
        frame.render_widget(
            ratatui::widgets::Paragraph::new(label),
            Rect {
                y: inner.bottom() - 1,
                height: 1,
                ..inner
            },
        );
    }
}

fn render_tokens(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let block = theme.panel("Token 构成");
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let entries = token_breakdown(app);
    if entries.is_empty() {
        frame.render_widget(widgets::placeholder(theme, "无 Token 数据"), inner);
        return;
    }
    let total: u64 = entries.iter().map(|(_, value, _)| *value).sum();
    let mut lines = Vec::new();
    let width = inner.width as usize;
    for (label, value, tone) in entries.iter().take(inner.height as usize) {
        let ratio = if total == 0 {
            0.0
        } else {
            safe_ratio(*value as f64 / total as f64)
        };
        lines.push(widgets::meter_line(
            theme,
            label,
            ratio,
            format_compact(*value),
            width,
        ));
        let _ = tone;
    }
    frame.render_widget(ratatui::widgets::Paragraph::new(lines), inner);
}

fn render_models(frame: &mut Frame, area: Rect, app: &App, theme: Theme, breakpoint: Breakpoint) {
    let Some(snapshot) = app.usage.data.as_ref() else {
        let block = theme.panel("模型 / Provider");
        let message = if app.usage.refreshing {
            "正在加载 OpenCode 模型统计…"
        } else if let Some(error) = app.usage.error.as_ref() {
            error.as_str()
        } else {
            "尚无 OpenCode 用量数据；按 r 重试。"
        };
        frame.render_widget(widgets::placeholder(theme, message).block(block), area);
        return;
    };

    let indices = app.sorted_model_indices();
    let selected = app.usage_model_cursor.min(indices.len().saturating_sub(1));
    let visible_rows = area.height.saturating_sub(4).max(1) as usize;
    let start = selected.saturating_sub(visible_rows.saturating_sub(1));
    let end = (start + visible_rows).min(indices.len());

    let max_steps = snapshot
        .models
        .iter()
        .map(|model| model.steps)
        .max()
        .unwrap_or(1)
        .max(1);

    let block = theme.panel_with_metric(
        "模型 / Provider",
        Some(format!(
            "{}-{} / {} · 排序 {} · t 时间",
            if indices.is_empty() { 0 } else { start + 1 },
            end,
            indices.len(),
            app.usage_sort.label()
        )),
    );

    let mode = LayoutMode::of(area.width, breakpoint);
    let (headers, widths) = columns_for(mode);
    let rows = indices[start..end]
        .iter()
        .filter_map(|index| snapshot.models.get(*index))
        .map(|model| model_row(model, max_steps, mode, area.width, theme))
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
    let mut state = TableState::default().with_selected(Some(selected.saturating_sub(start)));
    frame.render_stateful_widget(table, area, &mut state);
}

/// 模型表的列集合。表头与数据行必须用同一个枚举，否则列会错位。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LayoutMode {
    Full,
    Medium,
    Narrow,
}

impl LayoutMode {
    fn of(width: u16, breakpoint: Breakpoint) -> Self {
        if breakpoint.is_wide() && width >= 120 {
            Self::Full
        } else if width >= 96 {
            Self::Medium
        } else {
            Self::Narrow
        }
    }
}

fn columns_for(mode: LayoutMode) -> (Vec<&'static str>, Vec<Constraint>) {
    match mode {
        LayoutMode::Full => (
            vec![
                "Model",
                "Provider",
                "Steps",
                "输入",
                "输出",
                "推理",
                "缓存读",
                "成本",
                "占比",
            ],
            vec![
                Constraint::Min(14),
                Constraint::Length(11),
                Constraint::Length(6),
                Constraint::Length(8),
                Constraint::Length(8),
                Constraint::Length(7),
                Constraint::Length(8),
                Constraint::Length(7),
                Constraint::Min(12),
            ],
        ),
        LayoutMode::Medium => (
            vec!["Model", "Provider", "Steps", "输入", "输出", "成本", "占比"],
            vec![
                Constraint::Min(14),
                Constraint::Length(11),
                Constraint::Length(6),
                Constraint::Length(8),
                Constraint::Length(8),
                Constraint::Length(7),
                Constraint::Min(12),
            ],
        ),
        LayoutMode::Narrow => (
            vec!["Model", "Steps", "输出", "成本"],
            vec![
                Constraint::Min(12),
                Constraint::Length(6),
                Constraint::Length(8),
                Constraint::Length(8),
            ],
        ),
    }
}

fn model_row(
    model: &ModelUsage,
    max_steps: u64,
    mode: LayoutMode,
    table_width: u16,
    theme: Theme,
) -> Row<'static> {
    let glyphs = theme.glyphs();
    let ratio = safe_ratio(model.steps as f64 / max_steps as f64);
    let bar = widgets::meter_string(theme, Some(ratio), 6);
    let share = format!("{:>3.0}%", ratio * 100.0);
    // 名字列吃掉剩余宽度：固定列 + 列间距 + 两侧边框都先扣掉，避免过早省略。
    let fixed = match mode {
        LayoutMode::Full => 11 + 6 + 8 + 8 + 7 + 8 + 7 + 12,
        LayoutMode::Medium => 11 + 6 + 8 + 8 + 7 + 12,
        LayoutMode::Narrow => 6 + 8 + 8,
    };
    let columns = match mode {
        LayoutMode::Full => 9,
        LayoutMode::Medium => 7,
        LayoutMode::Narrow => 4,
    };
    let name_width = (table_width as usize)
        .saturating_sub(fixed + columns)
        .max(10);
    let mut cells = vec![cell(
        fit_width(&safe_inline(&model.model.id), name_width, glyphs.ellipsis()),
        theme.bold(Tone::Accent),
    )];
    if mode != LayoutMode::Narrow {
        cells.push(cell(
            fit_width(
                &safe_inline(&model.model.provider_id),
                10,
                glyphs.ellipsis(),
            ),
            theme.provider(&model.model.provider_id),
        ));
    }
    cells.push(cell(format!("{:>5}", model.steps), theme.muted()));
    if mode != LayoutMode::Narrow {
        cells.push(cell(
            format!("{:>7}", format_compact(model.tokens.input)),
            theme.muted(),
        ));
    }
    cells.push(cell(
        format!("{:>7}", format_compact(model.tokens.output)),
        theme.fg(Tone::Success),
    ));
    if mode == LayoutMode::Full {
        cells.push(cell(
            format!("{:>7}", format_compact(model.tokens.reasoning)),
            theme.muted(),
        ));
        cells.push(cell(
            format!("{:>7}", format_compact(model.tokens.cache.read)),
            theme.muted(),
        ));
    }
    cells.push(cell(
        format!("{:>7}", format!("${:.2}", model.cost)),
        theme.muted(),
    ));
    if mode != LayoutMode::Narrow {
        cells.push(cell(
            format!("{bar} {share}"),
            theme.fg(if ratio > 0.5 {
                Tone::Accent
            } else {
                Tone::Muted
            }),
        ));
    }
    Row::new(cells)
}

fn cell(text: impl Into<String>, style: ratatui::style::Style) -> Cell<'static> {
    Cell::from(text.into()).style(style)
}
