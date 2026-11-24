//! 统一视觉规范：语义色、图标、边框与文本宽度工具。
//!
//! 规则（所有页面共用，不要在页面里直接写 `Color`）：
//! - [`Tone`] 是唯一的颜色语义来源：成功 / 警告 / 错误 / 信息 / 静音 / 强调。
//! - `--no-color` 时颜色退化为 BOLD / DIM / REVERSED，配合不同图标，信息不丢失。
//! - `--ascii` 时所有图标换成 ASCII，表格列宽按 ASCII 内容计算，不出现错位。
//! - 中文按显示宽度（CJK 占 2 列）截断并补省略号，数字右对齐。

use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols;
use ratatui::text::Span;
use ratatui::widgets::{Block, BorderType};

use crate::app::App;
use crate::cli::Appearance;

/// 语义色。页面只描述「这是什么状态」，由主题决定怎么画。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Accent,
    Success,
    Warning,
    Error,
    Info,
    Muted,
    Normal,
}

#[derive(Debug, Clone, Copy)]
pub struct Theme {
    color: bool,
    ascii: bool,
    dark: bool,
}

impl Theme {
    pub fn new(app: &App) -> Self {
        Self {
            color: !app.info.no_color,
            ascii: app.info.ascii,
            dark: app.info.appearance == Appearance::Dark,
        }
    }

    /// 测试与纯函数用：显式构造主题，避免依赖 App。
    #[cfg(test)]
    pub fn from_flags(no_color: bool, ascii: bool, dark: bool) -> Self {
        Self {
            color: !no_color,
            ascii,
            dark,
        }
    }

    pub fn ascii(self) -> bool {
        self.ascii
    }

    pub fn glyphs(self) -> Glyphs {
        Glyphs { ascii: self.ascii }
    }

    fn color_for(self, tone: Tone) -> Color {
        match tone {
            Tone::Accent => {
                if self.dark {
                    Color::Cyan
                } else {
                    Color::Blue
                }
            }
            Tone::Success => Color::Green,
            Tone::Warning => Color::Yellow,
            Tone::Error => Color::Red,
            Tone::Info => {
                if self.dark {
                    Color::LightCyan
                } else {
                    Color::Cyan
                }
            }
            Tone::Muted => {
                if self.dark {
                    Color::Gray
                } else {
                    Color::DarkGray
                }
            }
            Tone::Normal => {
                if self.dark {
                    Color::White
                } else {
                    Color::Black
                }
            }
        }
    }

    pub fn fg(self, tone: Tone) -> Style {
        if self.color {
            Style::default().fg(self.color_for(tone))
        } else {
            Style::default()
        }
    }

    pub fn bold(self, tone: Tone) -> Style {
        let style = self.fg(tone).add_modifier(Modifier::BOLD);
        if self.color {
            style
        } else if tone == Tone::Muted {
            Style::default().add_modifier(Modifier::DIM)
        } else {
            style
        }
    }

    pub fn muted(self) -> Style {
        if self.color {
            Style::default().fg(self.color_for(Tone::Muted))
        } else {
            Style::default().add_modifier(Modifier::DIM)
        }
    }

    /// 状态徽标：彩色时用前景色，无色时用反显/加粗兜底。
    pub fn badge(self, tone: Tone) -> Style {
        if self.color {
            Style::default()
                .fg(self.color_for(tone))
                .add_modifier(Modifier::BOLD)
        } else {
            match tone {
                Tone::Error => Style::default()
                    .add_modifier(Modifier::REVERSED)
                    .add_modifier(Modifier::BOLD),
                Tone::Warning | Tone::Success | Tone::Accent | Tone::Info => {
                    Style::default().add_modifier(Modifier::BOLD)
                }
                Tone::Muted | Tone::Normal => Style::default(),
            }
        }
    }

    pub fn selected(self) -> Style {
        if self.color {
            let background = if self.dark { Color::Cyan } else { Color::Blue };
            let foreground = if self.dark {
                Color::Black
            } else {
                Color::White
            };
            Style::default()
                .fg(foreground)
                .bg(background)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
                .add_modifier(Modifier::REVERSED)
                .add_modifier(Modifier::BOLD)
        }
    }

    /// 顶栏背景：彩色时铺一层低对比底色，无色时只加粗。
    pub fn tab_active(self) -> Style {
        if self.color {
            Style::default()
                .fg(self.color_for(Tone::Accent))
                .add_modifier(Modifier::BOLD)
                .add_modifier(Modifier::UNDERLINED)
        } else {
            Style::default()
                .add_modifier(Modifier::REVERSED)
                .add_modifier(Modifier::BOLD)
        }
    }

    pub fn table_header(self) -> Style {
        if self.color {
            Style::default()
                .fg(self.color_for(Tone::Accent))
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().add_modifier(Modifier::BOLD)
        }
    }

    pub fn border(self) -> Style {
        if self.color {
            Style::default().fg(if self.dark {
                Color::DarkGray
            } else {
                Color::Gray
            })
        } else {
            Style::default()
        }
    }

    /// 表格选中行的前缀符号。ASCII 下用 `>`，避免宽字符在窄列里错位。
    pub fn highlight_symbol(self) -> &'static str {
        if self.ascii {
            "> "
        } else {
            "▶ "
        }
    }

    pub fn border_type(self) -> BorderType {
        if self.ascii {
            BorderType::Plain
        } else {
            BorderType::Rounded
        }
    }

    /// ASCII 边框字符集：`--ascii` 时连边框都必须是 7-bit，不能残留制表符。
    pub fn border_set(self) -> ratatui::symbols::border::Set<'static> {
        if self.ascii {
            ratatui::symbols::border::Set {
                top_left: "+",
                top_right: "+",
                bottom_left: "+",
                bottom_right: "+",
                vertical_left: "|",
                vertical_right: "|",
                horizontal_top: "-",
                horizontal_bottom: "-",
            }
        } else {
            ratatui::symbols::border::ROUNDED
        }
    }

    /// 统一的 Panel 外观：细边框、左标题、可选右侧指标。
    pub fn panel(self, title: impl Into<ratatui::text::Line<'static>>) -> Block<'static> {
        Block::bordered()
            .border_type(self.border_type())
            .border_set(self.border_set())
            .border_style(self.border())
            .title(Span::styled(
                format!(" {} ", title.into()),
                self.bold(Tone::Accent),
            ))
    }

    /// 带右侧指标的 Panel。标题右侧贴一个 muted 的小指标。
    pub fn panel_with_metric(
        self,
        title: impl Into<String>,
        metric: Option<String>,
    ) -> Block<'static> {
        let block = self.panel(title.into());
        match metric {
            Some(metric) => block.title_top(
                ratatui::text::Line::from(Span::styled(metric, self.muted())).right_aligned(),
            ),
            None => block,
        }
    }

    /// Provider 品牌色；浅色主题下把亮色压回基础色，保证对比度。
    pub fn provider(self, provider_id: &str) -> Style {
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
        let color = if self.dark {
            color
        } else {
            match color {
                Color::LightMagenta => Color::Magenta,
                Color::LightCyan => Color::Cyan,
                Color::LightBlue => Color::Blue,
                Color::LightRed => Color::Red,
                Color::LightGreen => Color::Green,
                Color::LightYellow => Color::Yellow,
                Color::White => Color::Black,
                other => other,
            }
        };
        let style = self.fg(Tone::Normal).fg(color);
        if self.color {
            style.add_modifier(Modifier::BOLD)
        } else {
            Style::default().add_modifier(Modifier::BOLD)
        }
    }
}

/// `--ascii` 下使用的图标集合。宽度尽量与 Unicode 版本一致，避免表格错位。
#[derive(Debug, Clone, Copy)]
pub struct Glyphs {
    ascii: bool,
}

const ASCII_BARS: symbols::bar::Set<'static> = symbols::bar::Set {
    full: "#",
    seven_eighths: "#",
    three_quarters: "#",
    five_eighths: "#",
    half: "+",
    three_eighths: "+",
    one_quarter: ":",
    one_eighth: ".",
    empty: " ",
};

impl Glyphs {
    pub fn ascii(self) -> bool {
        self.ascii
    }

    pub fn on(self) -> &'static str {
        if self.ascii {
            "*"
        } else {
            "●"
        }
    }

    pub fn off(self) -> &'static str {
        if self.ascii {
            "o"
        } else {
            "○"
        }
    }

    pub fn ok(self) -> &'static str {
        if self.ascii {
            "+"
        } else {
            "✔"
        }
    }

    pub fn warn(self) -> &'static str {
        if self.ascii {
            "!"
        } else {
            "▲"
        }
    }

    pub fn bad(self) -> &'static str {
        if self.ascii {
            "x"
        } else {
            "✖"
        }
    }

    pub fn unknown(self) -> &'static str {
        "?"
    }

    pub fn bullet(self) -> &'static str {
        if self.ascii {
            "-"
        } else {
            "·"
        }
    }

    pub fn ellipsis(self) -> &'static str {
        if self.ascii {
            ".."
        } else {
            "…"
        }
    }

    pub fn bar_full(self) -> &'static str {
        if self.ascii {
            "#"
        } else {
            "█"
        }
    }

    pub fn bar_empty(self) -> &'static str {
        if self.ascii {
            "-"
        } else {
            "░"
        }
    }

    pub fn spark_set(self) -> symbols::bar::Set<'static> {
        if self.ascii {
            ASCII_BARS
        } else {
            symbols::bar::NINE_LEVELS
        }
    }

    pub fn scrollbar_set(self) -> symbols::scrollbar::Set<'static> {
        if self.ascii {
            symbols::scrollbar::VERTICAL
        } else {
            symbols::scrollbar::DOUBLE_VERTICAL
        }
    }
}

/// 终端显示宽度（CJK 占 2 列）。
pub fn text_width(text: &str) -> usize {
    Span::raw(text).width()
}

/// 按显示宽度截断并补省略号。`ellipsis` 由主题提供（`…` 或 `..`）。
pub fn fit_width(text: &str, width: usize, ellipsis: &str) -> String {
    if width == 0 {
        return String::new();
    }
    if text_width(text) <= width {
        return text.to_string();
    }
    let ellipsis_width = text_width(ellipsis);
    if ellipsis_width >= width {
        return ellipsis.chars().take(width).collect();
    }
    let budget = width - ellipsis_width;
    let mut out = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let ch_width = text_width(&ch.to_string());
        if used + ch_width > budget {
            break;
        }
        used += ch_width;
        out.push(ch);
    }
    out.push_str(ellipsis);
    out
}

/// 安全比例：NaN / 无穷 / 越界都夹到 [0, 1]，供 Gauge / LineGauge 使用。
/// 按显示宽度右侧补空格（CJK 标签对齐用）。
pub fn pad_display(text: &str, width: usize) -> String {
    let used = text_width(text);
    if used >= width {
        text.to_string()
    } else {
        format!("{}{}", text, " ".repeat(width - used))
    }
}

pub fn safe_ratio(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_width_is_two_columns() {
        assert_eq!(text_width("总览"), 4);
        assert_eq!(text_width("abc"), 3);
        assert_eq!(text_width("a总b"), 4);
    }

    #[test]
    fn fit_width_truncates_on_display_columns_not_chars() {
        // 4 个汉字 = 8 列；预算 5 列 + 省略号 1 列 => 只能放 2 个汉字。
        assert_eq!(fit_width("总览页面", 5, "…"), "总览…");
        assert_eq!(fit_width("abcdef", 4, "…"), "abc…");
        assert_eq!(fit_width("abc", 4, "…"), "abc");
        assert_eq!(fit_width("abc", 0, "…"), "");
    }

    #[test]
    fn safe_ratio_clamps_nan_and_out_of_range() {
        assert_eq!(safe_ratio(f64::NAN), 0.0);
        assert_eq!(safe_ratio(f64::INFINITY), 0.0);
        assert_eq!(safe_ratio(-1.0), 0.0);
        assert_eq!(safe_ratio(2.0), 1.0);
        assert_eq!(safe_ratio(0.25), 0.25);
    }

    #[test]
    fn ascii_glyphs_stay_ascii() {
        let glyphs = Theme::from_flags(true, true, true).glyphs();
        for symbol in [
            glyphs.on(),
            glyphs.off(),
            glyphs.ok(),
            glyphs.warn(),
            glyphs.bad(),
            glyphs.bullet(),
            glyphs.ellipsis(),
            glyphs.bar_full(),
            glyphs.bar_empty(),
        ] {
            assert!(symbol.is_ascii(), "{symbol:?} should be ascii");
        }
    }

    #[test]
    fn no_color_badges_use_modifiers_not_palette() {
        let theme = Theme::from_flags(true, false, true);
        let style = theme.badge(Tone::Error);
        assert!(style.add_modifier.contains(Modifier::REVERSED));
        assert_eq!(style.fg, None);
    }
}
