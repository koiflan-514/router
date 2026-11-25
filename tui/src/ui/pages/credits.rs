//! 额度页：每家一行，余额/总量 + Gauge + 重置日 + 账号/数据时间。
//!
//! 没有总量时用 `─` 占位而不是编造 0；无数据给明确占位。

use ratatui::layout::{Constraint, Rect};
use ratatui::widgets::{Cell, Row, Table, TableState};
use ratatui::Frame;

use crate::app::{App, QuotaLine};
use crate::domain::format_number;

use crate::ui::common::{claimable_count, quota_line_ratio, safe_inline};
use crate::ui::layout::Breakpoint;
use crate::ui::theme::{fit_width, Theme, Tone};
use crate::ui::widgets;

pub fn render(frame: &mut Frame, area: Rect, app: &App, theme: Theme) {
    let breakpoint = Breakpoint::of(area.width);
    let lines = app.quota_lines();
    let claimable = claimable_count(app);

    let (kpi_area, table_area) = if area.height >= 20 && !breakpoint.is_compact() {
        let (kpi, rest) = crate::ui::layout::split_kpi(area, 3);
        (Some(kpi), rest)
    } else {
        (None, area)
    };
    if let Some(kpi_area) = kpi_area {
        render_kpis(frame, kpi_area, app, theme, claimable);
    }

    let Some(credits) = app.credits.data.as_ref() else {
        let block = theme.panel("额度");
        let message = if app.credits.refreshing {
            "正在读取额度…"
        } else if let Some(error) = app.credits.error.as_ref() {
            error.as_str()
        } else {
            "尚未取得额度数据；按 r 重试。"
        };
        frame.render_widget(
            widgets::placeholder(theme, message).block(block),
            table_area,
        );
        return;
    };

    let note = format!("{} 行 · 可领取 {} · 不跨厂商汇总", lines.len(), claimable);
    let block = theme.panel_with_metric("额度", Some(note));
    let (headers, widths) = columns_for(table_area.width, breakpoint);
    let rows = lines
        .iter()
        .map(|line| quota_row(line, table_area.width, breakpoint, theme))
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
    let mut state = TableState::default()
        .with_selected(Some(app.quota_cursor.min(lines.len().saturating_sub(1))));
    frame.render_stateful_widget(table, table_area, &mut state);
    let _ = credits;
}

fn render_kpis(frame: &mut Frame, area: Rect, app: &App, theme: Theme, claimable: usize) {
    let rows = app
        .credits
        .data
        .as_ref()
        .map_or(0, |credits| credits.rows.len());
    let exhausted = app.credits.data.as_ref().map_or(0, |credits| {
        credits
            .rows
            .iter()
            .filter(|row| row.quota_exhausted)
            .count()
    });
    let unavailable = app.credits.data.as_ref().map_or(0, |credits| {
        credits.rows.iter().filter(|row| !row.available).count()
    });
    let items = vec![
        widgets::Kpi::new("来源", rows.to_string(), Tone::Accent).detail("按 provider/账号"),
        widgets::Kpi::new(
            "可领取",
            claimable.to_string(),
            if claimable > 0 {
                Tone::Info
            } else {
                Tone::Muted
            },
        )
        .detail("签到状态"),
        widgets::Kpi::new(
            "额度耗尽",
            exhausted.to_string(),
            if exhausted > 0 {
                Tone::Error
            } else {
                Tone::Success
            },
        )
        .detail("已用尽"),
        widgets::Kpi::new(
            "不可用来源",
            unavailable.to_string(),
            if unavailable > 0 {
                Tone::Warning
            } else {
                Tone::Success
            },
        )
        .detail("凭证/区域限制"),
    ];
    widgets::render_kpis(frame, area, theme, &items);
}

fn columns_for(width: u16, breakpoint: Breakpoint) -> (Vec<&'static str>, Vec<Constraint>) {
    if breakpoint.is_wide() || width >= 100 {
        (
            vec![
                "Provider",
                "来源/账号",
                "余额",
                "总量",
                "进度",
                "重置日",
                "状态",
            ],
            vec![
                Constraint::Min(13),
                Constraint::Min(11),
                Constraint::Length(9),
                Constraint::Length(8),
                Constraint::Length(10),
                Constraint::Length(10),
                Constraint::Min(14),
            ],
        )
    } else if breakpoint.is_compact() {
        (
            vec!["Provider", "余额", "进度", "状态"],
            vec![
                Constraint::Min(12),
                Constraint::Length(9),
                Constraint::Length(9),
                Constraint::Min(8),
            ],
        )
    } else {
        (
            vec!["Provider", "来源", "余额", "总量", "进度", "状态"],
            vec![
                Constraint::Min(12),
                Constraint::Min(10),
                Constraint::Length(9),
                Constraint::Length(8),
                Constraint::Length(9),
                Constraint::Min(10),
            ],
        )
    }
}

fn quota_row(line: &QuotaLine, width: u16, breakpoint: Breakpoint, theme: Theme) -> Row<'static> {
    let glyphs = theme.glyphs();
    let tone = status_tone(&line.status);
    let ratio = quota_line_ratio(line);
    let meter = widgets::meter_string(theme, ratio, 8);
    let remaining = remaining_text(line);
    // 没有总量（或上游用 0 表示分母未知）时不显示 0；每天额度尤其不能被读成 credits。
    let total = total_text(line);
    let wide = breakpoint.is_wide() || width >= 100;
    let status = compact_status(line, 12, glyphs.ellipsis());
    let status_icon = match tone {
        Tone::Error => glyphs.bad(),
        Tone::Warning => glyphs.warn(),
        Tone::Success => glyphs.ok(),
        _ => glyphs.bullet(),
    };
    // 重置日优先；没有就退回采集时间，两者都缺才显示「—」。
    let reset = line
        .reset_date
        .as_deref()
        .or(line.fetched_at.as_deref())
        .map(|value| value.chars().take(10).collect::<String>())
        .unwrap_or_else(|| "—".into());

    let mut cells = vec![cell(
        fit_width(&safe_inline(&line.title), 16, glyphs.ellipsis()),
        theme.provider(&line.provider),
    )];
    if !breakpoint.is_compact() {
        cells.push(cell(
            fit_width(&safe_inline(&line.source), 14, glyphs.ellipsis()),
            theme.muted(),
        ));
    }
    cells.push(cell(format!("{remaining:>8}"), theme.bold(Tone::Success)));
    if !breakpoint.is_compact() {
        let total = if wide {
            total.clone().unwrap_or_else(|| "—".into())
        } else {
            // 窄表不展示总量列内容，避免把 days 的 0 误读成额度总量。
            total.clone().unwrap_or_default()
        };
        cells.push(cell(format!("{total:>7}"), theme.muted()));
    }
    cells.push(cell(
        meter,
        theme.fg(if ratio.is_some() {
            Tone::Accent
        } else {
            Tone::Muted
        }),
    ));
    if wide {
        cells.push(cell(reset, theme.muted()));
        cells.push(cell(
            format!(
                "{status_icon} {}",
                fit_width(&safe_inline(&line.status), 12, glyphs.ellipsis())
            ),
            theme.fg(tone),
        ));
        // 宽表 7 列：Provider / 来源 / 余额 / 总量 / 进度 / 重置日 / 状态
    } else {
        cells.push(cell(format!("{status_icon} {status}"), theme.fg(tone)));
    }
    Row::new(cells)
}

/// days / day / d / 天 表示凭证有效期，不是 credits 总量。
fn is_day_unit(unit: &str) -> bool {
    matches!(
        unit.trim().to_ascii_lowercase().as_str(),
        "days" | "day" | "d" | "天"
    )
}

/// 余额文本：days 类额度带 `d` 后缀，避免 `29 / 0` 被读成 29 credits。
fn remaining_text(line: &QuotaLine) -> String {
    match line.remaining {
        Some(value) => {
            let text = format_number(value);
            if is_day_unit(&line.unit) {
                format!("{text}d")
            } else {
                text
            }
        }
        None => "—".into(),
    }
}

/// 总量文本：只有真正大于 0 的总量才显示；0 / 负数 / NaN 都视为「未知」。
fn total_text(line: &QuotaLine) -> Option<String> {
    line.total
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(format_number)
}

fn compact_status(line: &QuotaLine, width: usize, ellipsis: &str) -> String {
    if line.remaining.is_none() && line.total.is_none() {
        return fit_width(&safe_inline(&line.status), width, ellipsis);
    }
    if line.status == "正常" {
        return "正常".into();
    }
    fit_width(&safe_inline(&line.status), width, ellipsis)
}

fn status_tone(status: &str) -> Tone {
    if status.contains("不可用")
        || status.contains("失败")
        || status.contains("已过期")
        || status.contains("耗尽")
    {
        Tone::Error
    } else if status.contains("可领取")
        || status.contains("即将过期")
        || status.contains("未运行")
        || status.contains("冷却")
    {
        Tone::Warning
    } else if status.contains("正常") || status.contains("已签到") {
        Tone::Success
    } else {
        Tone::Muted
    }
}

fn cell(text: impl Into<String>, style: ratatui::style::Style) -> Cell<'static> {
    Cell::from(text.into()).style(style)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(remaining: Option<f64>, total: Option<f64>, unit: &str) -> QuotaLine {
        QuotaLine {
            provider: "workbuddy".into(),
            title: "WorkBuddy 国内版".into(),
            source: "凭证有效期".into(),
            remaining,
            total,
            unit: unit.into(),
            status: "凭证可读".into(),
            reset_date: None,
            fetched_at: None,
            detail: String::new(),
        }
    }

    #[test]
    fn day_units_are_recognized() {
        for unit in ["days", "day", "d", "D", "天", " Days "] {
            assert!(is_day_unit(unit), "{unit:?} should be a day unit");
        }
        for unit in ["credits", "tokens", "M tok", "", "hour"] {
            assert!(!is_day_unit(unit), "{unit:?} should not be a day unit");
        }
    }

    #[test]
    fn zero_or_negative_totals_are_not_rendered() {
        assert_eq!(remaining_text(&line(Some(29.0), Some(0.0), "days")), "29d");
        assert_eq!(total_text(&line(Some(29.0), Some(0.0), "days")), None);
        assert_eq!(total_text(&line(Some(29.0), None, "days")), None);
        assert_eq!(total_text(&line(Some(1.0), Some(-5.0), "credits")), None);
        assert_eq!(
            total_text(&line(Some(1.0), Some(f64::NAN), "credits")),
            None
        );
        assert_eq!(
            total_text(&line(Some(96.0), Some(800.0), "credits")).as_deref(),
            Some("800")
        );
    }
}
