use std::sync::OnceLock;

use regex::{Regex, RegexBuilder};

const MAX_LINE_CHARS: usize = 2_000;
const MAX_TEXT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Default)]
pub struct SafeText {
    pub text: String,
    pub truncated: bool,
}

pub fn sanitize_text(input: &str) -> SafeText {
    let mut output = String::new();
    let mut cleaned = String::with_capacity(input.len().min(MAX_TEXT_BYTES));
    let chars: Vec<char> = input.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '\x1b' {
            index += 1;
            if index >= chars.len() {
                break;
            }
            match chars[index] {
                '[' => {
                    index += 1;
                    while index < chars.len() {
                        let code = chars[index] as u32;
                        index += 1;
                        if (0x40..=0x7e).contains(&code) {
                            break;
                        }
                    }
                }
                ']' | 'P' | 'X' | '^' | '_' => {
                    index += 1;
                    while index < chars.len() {
                        if chars[index] == '\x07' {
                            index += 1;
                            break;
                        }
                        if chars[index] == '\x1b'
                            && index + 1 < chars.len()
                            && chars[index + 1] == '\\'
                        {
                            index += 2;
                            break;
                        }
                        index += 1;
                    }
                }
                _ => index += 1,
            }
            continue;
        }
        if ch == '\r' {
            index += 1;
            continue;
        }
        if ch == '\n' || ch == '\t' || (!ch.is_control() && !is_bidi_control(ch)) {
            cleaned.push(ch);
        }
        index += 1;
    }

    for line in cleaned.lines() {
        let redacted = redact_line(line);
        let mut line = redacted;
        if line.chars().count() > MAX_LINE_CHARS {
            line = line.chars().take(MAX_LINE_CHARS).collect::<String>();
            line.push_str(" … [行已截断]");
        }
        if output.len() + line.len() + 1 > MAX_TEXT_BYTES {
            output.push_str("[输出已截断]\n");
            return SafeText {
                text: output,
                truncated: true,
            };
        }
        output.push_str(&line);
        output.push('\n');
    }
    SafeText {
        text: output,
        truncated: false,
    }
}

pub fn sanitize_lines(input: &str, max_lines: usize) -> SafeText {
    let safe = sanitize_text(input);
    let mut lines: Vec<&str> = safe.text.lines().collect();
    let truncated = safe.truncated || lines.len() > max_lines;
    if lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    SafeText { text, truncated }
}

fn is_bidi_control(ch: char) -> bool {
    matches!(
        ch,
        '\u{200e}'
            | '\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
            | '\u{061c}'
    )
}

fn redact_line(line: &str) -> String {
    let mut result = line.to_string();
    for pattern in secret_patterns() {
        result = pattern.replace_all(&result, "${1}[REDACTED]").into_owned();
    }
    result
}

fn secret_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let case_insensitive = |pattern: &str| {
            RegexBuilder::new(pattern)
                .case_insensitive(true)
                .build()
                .expect("static redaction regex must compile")
        };
        vec![
            case_insensitive(r#"(authorization\s*:\s*bearer\s+)[^\s"']+"#),
            case_insensitive(r"(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
            case_insensitive(
                r#"((?:access_token|refresh_token|api_key|apikey|session|cookie|signature|token|sign)\s*["']?\s*[:=]\s*["']?)[^"'\s,&}]+"#,
            ),
            Regex::new(r"\b(?:sk|pt|pk)-[A-Za-z0-9._-]{8,}").expect("token regex"),
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_osc_and_cursor_sequences() {
        let input = "normal \x1b[31mred\x1b[0m \x1b]0;title\x07 tail";
        let output = sanitize_text(input);
        assert_eq!(output.text, "normal red  tail\n");
        assert!(!output.truncated);
    }

    #[test]
    fn redacts_bearer_and_json_tokens() {
        let input = r#"Authorization: Bearer abcdefghijkl
{"access_token":"super-secret-value","api_key":"sk-example12345678"}"#;
        let output = sanitize_text(input).text;
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("abcdefghijkl"));
        assert!(!output.contains("super-secret-value"));
        assert!(!output.contains("sk-example12345678"));
    }

    #[test]
    fn strips_bidi_controls_and_carriage_returns() {
        let output = sanitize_text("a\r\nb\u{202e}c").text;
        assert_eq!(output, "a\nbc\n");
    }

    #[test]
    fn caps_line_count_keeping_the_tail() {
        let input = (0..100).map(|i| format!("line-{i}\n")).collect::<String>();
        let safe = sanitize_lines(&input, 10);
        assert!(safe.truncated);
        assert!(safe.text.contains("line-99"));
        assert!(!safe.text.contains("line-89"));
    }
}
