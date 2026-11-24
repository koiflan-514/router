//! 可复用的小型可视化控件。
//!
//! 这里只放纯展示、无业务状态的 helper：KPI 卡、行内进度条、分段条、
//! 徽标、迷你图表。所有函数都接受 [`Theme`]，不直接写颜色。
//! 比例类入参统一走 [`safe_ratio`]，保证空数据 / NaN 不 panic。

use ratatui::buffer::Buffer;
use ratatui::layout::{Alignment, Rect};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Sparkline};
use ratatui::Frame;

use super::theme::{fit_width, safe_ratio, text_width, Theme, Tone};

/// 一个 KPI 指标。`value` 是主数字，`detail` 是辅助说明（可空）。
#[derive(Debug, Clone)]
pub struct Kpi {
    pub label: &'static str,
    pub value: String,
    pub detail: String,
    pub tone: Tone,
    /// 0..=1，用于在卡片底部画一条细进度；`None` 不画。
    pub ratio: Option<f64>,
}

impl Kpi {
    pub fn new(label: &'static str, value: impl Into<String>, tone: Tone) -> Self {
        Self {
            label,
            value: value.into(),
            detail: String::new(),
            tone,
            ratio: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = detail.into();
        self
    }

    pub fn ratio(mut self, ratio: f64) -> Self {
        self.ratio = Some(ratio);
        self
    }
}

/// 渲染一行 KPI 卡。宽度不够时自动压缩 detail，再不够只留 value。
pub fn render_kpis(frame: &mut Frame, area: Rect, theme: Theme, items: &[Kpi]) {
    if items.is_empty() || area.is_empty() {
        return;
    }
    let chunks = super::layout::columns(area, items.len());
    let narrow = chunks.first().is_some_and(|rect| rect.width < 16);
    for (item, rect) in items.iter().zip(chunks) {
        render_kpi(frame, rect, theme, item, narrow);
    }
}

fn render_kpi(frame: &mut Frame, area: Rect, theme: Theme, kpi: &Kpi, narrow: bool) {
    let glyphs = theme.glyphs();
    let inner_width = area.width as usize;
    let meter = kpi.ratio.filter(|_| area.height >= 4);
    let text_height = if meter.is_some() {
        area.height.saturating_sub(1)
    } else {
        area.height
    };
    let mut lines = Vec::new();

    let label = if narrow {
        fit_width(kpi.label, inner_width, glyphs.ellipsis())
    } else {
        kpi.label.to_string()
    };
    lines.push(Line::from(vec![
        Span::styled(glyphs.bullet(), theme.muted()),
        Span::raw(" "),
        Span::styled(label, theme.muted()),
    ]));
    lines.push(Line::from(Span::styled(
        fit_width(&kpi.value, inner_width, glyphs.ellipsis()),
        theme.bold(kpi.tone),
    )));
    if !narrow && !kpi.detail.is_empty() && text_height >= 3 {
        lines.push(Line::from(Span::styled(
            fit_width(&kpi.detail, inner_width, glyphs.ellipsis()),
            theme.muted(),
        )));
    }
    lines.truncate(text_height as usize);
    frame.render_widget(Paragraph::new(lines), area);

    if let (Some(ratio), true) = (meter, area.height >= 4) {
        let bar_area = Rect {
            x: area.x,
            y: area.bottom() - 1,
            width: area.width,
            height: 1,
        };
        render_inline_meter(
            frame.buffer_mut(),
            bar_area,
            theme,
            safe_ratio(ratio),
            kpi.tone,
        );
    }
}

/// 行内进度条（用 buffer 直接画，避免 Gauge 的居中标签挤压）。
pub fn render_inline_meter(buffer: &mut Buffer, area: Rect, theme: Theme, ratio: f64, tone: Tone) {
    if area.is_empty() {
        return;
    }
    let glyphs = theme.glyphs();
    let filled = ((area.width as f64) * safe_ratio(ratio)).round() as u16;
    let full = glyphs.bar_full();
    let empty = glyphs.bar_empty();
    for offset in 0..area.width {
        let cell = &mut buffer[(area.x + offset, area.y)];
        if offset < filled {
            cell.set_symbol(full).set_style(theme.fg(tone));
        } else {
            cell.set_symbol(empty).set_style(theme.muted());
        }
    }
}

/// 生成固定宽度的进度条字符串，供表格单元格使用。
pub fn meter_string(theme: Theme, ratio: Option<f64>, width: usize) -> String {
    let glyphs = theme.glyphs();
    let Some(ratio) = ratio else {
        let missing = if theme.ascii() { "-" } else { "─" };
        return missing.repeat(width);
    };
    let filled = ((width as f64) * safe_ratio(ratio)).round() as usize;
    let mut out = String::new();
    for index in 0..width {
        out.push_str(if index < filled {
            glyphs.bar_full()
        } else {
            glyphs.bar_empty()
        });
    }
    out
}

/// 一行「标签 + 条 + 数值」的紧凑排版，用于侧栏 Top 列表。
pub fn meter_line<'a>(
    theme: Theme,
    label: &str,
    ratio: f64,
    value: String,
    width: usize,
) -> Line<'a> {
    let glyphs = theme.glyphs();
    let value_width = text_width(&value).min(width.saturating_sub(4));
    let label_budget = width.saturating_sub(value_width + 3);
    let label = fit_width(label, label_budget.max(4), glyphs.ellipsis());
    let label_width = text_width(&label);
    let bar_width = width
        .saturating_sub(label_width + value_width + 2)
        .clamp(1, 16);
    let filled = ((bar_width as f64) * safe_ratio(ratio)).round() as usize;
    let mut bar = String::new();
    for index in 0..bar_width {
        bar.push_str(if index < filled {
            glyphs.bar_full()
        } else {
            glyphs.bar_empty()
        });
    }
    Line::from(vec![
        Span::raw(label),
        Span::raw(" "),
        Span::styled(bar, theme.fg(Tone::Accent)),
        Span::raw(" "),
        Span::styled(value, theme.muted()),
    ])
}

/// 分段条：多个 (比例, 颜色) 拼成一条，用来画健康度构成。
pub struct Segment {
    pub ratio: f64,
    pub tone: Tone,
}

pub fn render_segments(buffer: &mut Buffer, area: Rect, theme: Theme, segments: &[Segment]) {
    if area.is_empty() || segments.is_empty() {
        return;
    }
    let total: f64 = segments.iter().map(|seg| safe_ratio(seg.ratio)).sum();
    if total <= 0.0 {
        render_inline_meter(buffer, area, theme, 0.0, Tone::Muted);
        return;
    }
    let glyphs = theme.glyphs();
    let mut cursor = area.x;
    let mut used = 0_u16;
    for (index, segment) in segments.iter().enumerate() {
        let share = if index + 1 == segments.len() {
            area.width.saturating_sub(used)
        } else {
            (((safe_ratio(segment.ratio) / total) * area.width as f64).round() as u16)
                .min(area.width.saturating_sub(used))
        };
        for offset in 0..share {
            buffer[(cursor + offset, area.y)]
                .set_symbol(glyphs.bar_full())
                .set_style(theme.fg(segment.tone));
        }
        cursor = cursor.saturating_add(share);
        used = used.saturating_add(share);
        if used >= area.width {
            break;
        }
    }
}

/// 迷你 sparkline。`values` 为空时渲染占位文本而不是空白。
pub fn render_sparkline(
    frame: &mut Frame,
    area: Rect,
    theme: Theme,
    values: &[u64],
    placeholder: &str,
) {
    if values.is_empty() {
        frame.render_widget(
            Paragraph::new(Span::styled(
                fit_width(placeholder, area.width as usize, theme.glyphs().ellipsis()),
                theme.muted(),
            ))
            .alignment(Alignment::Left),
            area,
        );
        return;
    }
    let peak = values.iter().copied().max().unwrap_or(1).max(1);
    frame.render_widget(
        Sparkline::default()
            .data(values)
            .max(peak)
            .bar_set(theme.glyphs().spark_set())
            .style(theme.fg(Tone::Accent)),
        area,
    );
}

/// 自绘环形仪表：用方块字符画一个矩形环，中心放标签。
///
/// 用 buffer 直接画而不是 Canvas，保证 `--ascii` 与 `--no-color` 都稳定。
pub fn render_ring(buffer: &mut Buffer, area: Rect, theme: Theme, ratio: f64, label: &str) {
    if area.width < 7 || area.height < 3 {
        return;
    }
    let (full, part, empty) = if theme.ascii() {
        ("#", "+", ".")
    } else {
        ("█", "▓", "░")
    };
    let filled = safe_ratio(ratio);
    let total_cells = area.width.saturating_sub(2) * 2 + area.height.saturating_sub(2) * 2;
    let filled_cells = ((total_cells as f64) * filled).round() as u16;
    let mut painted = 0_u16;
    let mut paint = |buffer: &mut Buffer, x: u16, y: u16| {
        let symbol = if painted < filled_cells {
            if painted + 1 == filled_cells {
                part
            } else {
                full
            }
        } else {
            empty
        };
        painted += 1;
        buffer[(x, y)].set_symbol(symbol);
    };
    let left = area.x;
    let right = area.right() - 1;
    let top = area.y;
    let bottom = area.bottom() - 1;
    for x in left..=right {
        paint(buffer, x, top);
    }
    for y in (top + 1)..=bottom {
        paint(buffer, right, y);
    }
    for x in (left..right).rev() {
        paint(buffer, x, bottom);
    }
    for y in ((top + 1)..bottom).rev() {
        paint(buffer, left, y);
    }

    let center = Rect {
        x: area.x + 1,
        y: area.y + area.height / 2,
        width: area.width.saturating_sub(2),
        height: 1,
    };
    let text = fit_width(label, center.width as usize, theme.glyphs().ellipsis());
    let offset = (center.width as usize).saturating_sub(text_width(&text)) / 2;
    let span = Span::styled(text, theme.bold(Tone::Accent));
    buffer.set_span(center.x + offset as u16, center.y, &span, center.width);
}

/// 图例：`● 运行 9` 这类小段，用于环形/分段条下方。
pub fn legend_line<'a>(theme: Theme, items: &[(Tone, String)]) -> Line<'a> {
    let glyphs = theme.glyphs();
    let mut spans = Vec::new();
    for (index, (tone, text)) in items.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(
                format!(" {} ", glyphs.bullet()),
                theme.muted(),
            ));
        }
        spans.push(Span::styled(glyphs.on(), theme.fg(*tone)));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(text.clone(), theme.muted()));
    }
    Line::from(spans)
}

/// 纯文本占位：用于空数据 / 加载 / 失败三态。
pub fn placeholder<'a>(theme: Theme, text: &str) -> Paragraph<'a> {
    Paragraph::new(Line::from(Span::styled(
        fit_width(text, 200, theme.glyphs().ellipsis()),
        theme.muted(),
    )))
    .alignment(Alignment::Center)
}

/// 计算一组数值的峰值，空集返回 0。
pub fn peak(values: &[u64]) -> u64 {
    values.iter().copied().max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::theme::Theme;

    fn buffer(width: u16, height: u16) -> Buffer {
        Buffer::empty(Rect::new(0, 0, width, height))
    }

    fn row_text(buf: &Buffer, y: u16) -> String {
        (0..buf.area.width)
            .map(|x| buf.cell((x, y)).unwrap().symbol().to_string())
            .collect()
    }

    #[test]
    fn inline_meter_handles_nan_and_full_ratio() {
        let theme = Theme::from_flags(true, true, true);
        let mut buf = buffer(10, 1);
        let area = buf.area;
        render_inline_meter(&mut buf, area, theme, f64::NAN, Tone::Success);
        assert_eq!(row_text(&buf, 0), "----------");

        render_inline_meter(&mut buf, area, theme, 1.0, Tone::Success);
        assert_eq!(row_text(&buf, 0), "##########");
    }

    #[test]
    fn segments_never_paint_outside_the_area() {
        let theme = Theme::from_flags(false, false, true);
        let mut buf = buffer(20, 1);
        let area = buf.area;
        render_segments(
            &mut buf,
            area,
            theme,
            &[
                Segment {
                    ratio: 2.0,
                    tone: Tone::Success,
                },
                Segment {
                    ratio: 2.0,
                    tone: Tone::Error,
                },
            ],
        );
        assert_eq!(row_text(&buf, 0).chars().count(), 20);
        assert!(!row_text(&buf, 0).trim().is_empty());
    }

    #[test]
    fn meter_line_stays_within_width() {
        let theme = Theme::from_flags(true, true, true);
        let line = meter_line(
            theme,
            "很长很长的额度来源名称",
            0.4,
            "96 credits".into(),
            40,
        );
        assert!(line.width() <= 40, "width was {}", line.width());
    }

    #[test]
    fn ring_renders_without_panic_on_tiny_area() {
        let theme = Theme::from_flags(true, true, true);
        let mut buf = buffer(4, 2);
        let area = buf.area;
        render_ring(&mut buf, area, theme, 0.5, "50%");
        let mut buf = buffer(12, 5);
        let area = buf.area;
        render_ring(&mut buf, area, theme, 0.5, "50%");
        assert!(!row_text(&buf, 2).trim().is_empty());
    }

    #[test]
    fn meter_string_is_stable_width_and_handles_missing() {
        let theme = Theme::from_flags(true, true, true);
        assert_eq!(meter_string(theme, None, 6), "------");
        assert_eq!(meter_string(theme, Some(0.5), 6), "###---");
        assert_eq!(meter_string(theme, Some(f64::NAN), 6), "------");
    }

    #[test]
    fn empty_sparkline_shows_placeholder() {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;
        let backend = TestBackend::new(20, 1);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                render_sparkline(
                    frame,
                    frame.area(),
                    Theme::from_flags(true, true, true),
                    &[],
                    "无数据",
                );
            })
            .unwrap();
        let rendered = terminal.backend().buffer().clone();
        let row: String = (0..20)
            .map(|x| rendered.cell((x, 0)).unwrap().symbol().to_string())
            .collect();
        let row: String = row.chars().filter(|ch| !ch.is_whitespace()).collect();
        assert!(row.contains("无数据") || row.contains(".."));
    }
}
