use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::domain::{
    AccountGroup, AccountSnapshot, Action, ActionKind, CreditsSnapshot, ProviderSnapshot, QuotaRow,
    TextResult, UsageRange, UsageSnapshot,
};
use crate::redact::sanitize_lines;

use super::{BackendError, BackendResult, CommandOutput};

const OUTPUT_LIMIT: usize = 1024 * 1024;
const STATUS_TIMEOUT: Duration = Duration::from_secs(30);
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
const CREDITS_TIMEOUT: Duration = Duration::from_secs(60);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct NodeBackend {
    root: PathBuf,
    node: String,
    opencode: String,
    read_only: bool,
}

impl NodeBackend {
    pub fn new(root: PathBuf, node: String, read_only: bool) -> Self {
        Self {
            root,
            node,
            opencode: resolve_opencode(),
            read_only,
        }
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn root_label(&self) -> String {
        display_path(&self.root)
    }

    pub fn node_label(&self) -> String {
        self.node.clone()
    }

    pub async fn providers(&self) -> BackendResult<ProviderSnapshot> {
        let output = self
            .run_router(&["list".into(), "--json".into()], Some(STATUS_TIMEOUT))
            .await?;
        parse_provider_snapshot(&output)
    }

    pub async fn accounts(&self) -> BackendResult<AccountSnapshot> {
        let output = self
            .run_router(&["account".into(), "--json".into()], Some(LOCAL_TIMEOUT))
            .await?;
        parse_account_snapshot(&output)
    }

    pub async fn credits(&self) -> BackendResult<CreditsSnapshot> {
        let output = self
            .run_node_script(
                &self.qoder2pi_script(),
                &["credits".into(), "json".into()],
                Some(CREDITS_TIMEOUT),
            )
            .await?;
        parse_credits(&output)
    }

    pub async fn usage(&self, range: UsageRange) -> BackendResult<UsageSnapshot> {
        let now_ms = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|error| BackendError::new(format!("系统时间无效：{error}")))?
            .as_millis() as u64;
        let from = range.start_timestamp_ms(now_ms);
        let args = vec![
            "api".to_string(),
            "experimental.session.stats".to_string(),
            "--param".to_string(),
            format!("from={from}"),
            "--param".to_string(),
            format!("to={now_ms}"),
            "--param".to_string(),
            "tools=summary".to_string(),
        ];
        let mut command = Command::new(&self.opencode);
        command
            .args(&args)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = run_capture(
            command,
            Some(Duration::from_secs(90)),
            Path::new("opencode"),
        )
        .await?;
        parse_usage_output(&output, range, now_ms)
    }

    pub async fn logs(&self, provider_id: &str, lines: usize) -> BackendResult<TextResult> {
        validate_identifier("provider", provider_id)?;
        let lines = lines.clamp(10, 2000);
        let output = self
            .run_router(
                &["logs".into(), provider_id.to_string(), lines.to_string()],
                Some(LOCAL_TIMEOUT),
            )
            .await?;
        Ok(text_from_output(&output, 2500))
    }

    pub async fn doctor(&self) -> BackendResult<TextResult> {
        let output = self
            .run_router(&["doctor".into()], Some(Duration::from_secs(90)))
            .await?;
        Ok(text_from_output(&output, 3000))
    }

    pub async fn health(
        &self,
        provider_id: Option<&str>,
        probe: bool,
    ) -> BackendResult<TextResult> {
        if let Some(provider) = provider_id {
            validate_identifier("provider", provider)?;
        }
        let script = self.root.join("scripts").join("health.mjs");
        let mut args = Vec::new();
        if !probe {
            args.push("--no-probe".to_string());
        }
        if let Some(provider) = provider_id {
            args.push(provider.to_string());
        }
        let output = self
            .run_node_script(
                &script,
                &args,
                Some(if probe { PROBE_TIMEOUT } else { HEALTH_TIMEOUT }),
            )
            .await?;
        Ok(text_from_output(&output, 4000))
    }

    pub async fn execute(&self, action: &Action) -> BackendResult<TextResult> {
        if action.is_interactive() {
            return Err(BackendError::new("交互动作必须通过终端挂起执行"));
        }
        if self.read_only && action.is_write() {
            return Err(BackendError::new("当前为只读模式"));
        }
        if action.kind == ActionKind::Checkin {
            return Err(BackendError::new(
                "当前 Node 后端尚未提供按 provider 统一的签到命令",
            ));
        }
        let (script, args) = self.action_command(action)?;
        let output = self.run_node_script(&script, &args, None).await?;
        Ok(text_from_output(&output, 5000))
    }

    pub async fn execute_interactive(&self, action: &Action) -> BackendResult<TextResult> {
        if self.read_only {
            return Err(BackendError::new("当前为只读模式"));
        }
        if !action.is_interactive() {
            return Err(BackendError::new("该动作不是交互动作"));
        }
        let (script, args) = self.action_command(action)?;
        let mut command = Command::new(&self.node);
        command
            .arg(&script)
            .args(&args)
            .current_dir(&self.root)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(false);
        let status = command
            .status()
            .await
            .map_err(|error| BackendError::new(format!("无法启动交互式 Node 命令：{error}")))?;
        Ok(TextResult {
            text: format!("交互流程已结束（退出码 {}）", status.code().unwrap_or(-1)),
            exit_code: status.code(),
            truncated: false,
        })
    }

    fn action_command(&self, action: &Action) -> BackendResult<(PathBuf, Vec<String>)> {
        if action.provider_ids.len() > 1 {
            return Err(BackendError::new("当前 TUI 只提交单 provider 写动作"));
        }
        let provider = action.provider_ids.first().cloned().unwrap_or_default();
        if !provider.is_empty() {
            validate_identifier("provider", &provider)?;
        }
        if let Some(account) = &action.account_key {
            if account.is_empty() || account.starts_with('-') {
                return Err(BackendError::new("账号 key 不能为空或以 '-' 开头"));
            }
        }

        let router = self.router_script();
        let args = match action.kind {
            ActionKind::Start => vec!["up", &provider, "--no-login"],
            ActionKind::Stop => vec!["down", &provider],
            ActionKind::StopKeepOpenCode => vec!["down", &provider, "--keep-oc"],
            ActionKind::Restart => vec!["restart", &provider, "--no-login"],
            ActionKind::OnlyEnable => vec!["on", &provider, "--no-login"],
            ActionKind::Disable => vec!["off", &provider],
            ActionKind::EnableAll => {
                return Ok((router, vec!["all".into(), "--no-login".into()]));
            }
            ActionKind::DisableAll => return Ok((router, vec!["none".into()])),
            ActionKind::Sync => return Ok((router, vec!["sync".into()])),
            ActionKind::SwitchAccountPreview => {
                let account = action
                    .account_key
                    .as_deref()
                    .ok_or_else(|| BackendError::new("缺少账号 key"))?;
                return Ok((
                    router,
                    vec![
                        "account".into(),
                        provider,
                        account.into(),
                        "--dry-run".into(),
                        "--json".into(),
                    ],
                ));
            }
            ActionKind::SwitchAccount => {
                let account = action
                    .account_key
                    .as_deref()
                    .ok_or_else(|| BackendError::new("缺少账号 key"))?;
                return Ok((
                    router,
                    vec!["account".into(), provider, account.into(), "--json".into()],
                ));
            }
            ActionKind::EnableAllAccounts => {
                return Ok((
                    router,
                    vec!["account".into(), provider, "--all".into(), "--json".into()],
                ));
            }
            ActionKind::Login => vec!["login", &provider],
            ActionKind::AddAccount => vec!["account", "add", &provider],
            ActionKind::Probe => {
                return Ok((self.root.join("scripts").join("health.mjs"), vec![provider]));
            }
            ActionKind::Checkin => {
                return Err(BackendError::new(
                    "当前 Node 后端尚未提供按 provider 统一的签到命令",
                ));
            }
        };
        Ok((router, args.into_iter().map(ToString::to_string).collect()))
    }

    async fn run_router(
        &self,
        args: &[String],
        limit: Option<Duration>,
    ) -> BackendResult<CommandOutput> {
        self.run_node_script(&self.router_script(), args, limit)
            .await
    }

    async fn run_node_script(
        &self,
        script: &Path,
        args: &[String],
        limit: Option<Duration>,
    ) -> BackendResult<CommandOutput> {
        let mut command = Command::new(&self.node);
        command
            .arg(script)
            .args(args)
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        run_capture(command, limit, script).await
    }

    fn router_script(&self) -> PathBuf {
        self.root.join("router.mjs")
    }

    fn qoder2pi_script(&self) -> PathBuf {
        self.root
            .join("integrations")
            .join("qodbuddy2pi")
            .join("assets")
            .join("qoder2pi")
    }
}

async fn run_capture(
    mut command: Command,
    limit: Option<Duration>,
    script: &Path,
) -> BackendResult<CommandOutput> {
    let mut child = command.spawn().map_err(|error| {
        BackendError::new(format!("无法启动 Node.js（{}）：{error}", script.display()))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| BackendError::new("Node 子进程没有 stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| BackendError::new("Node 子进程没有 stderr"))?;
    let stdout_task = tokio::spawn(read_capped(stdout));
    let stderr_task = tokio::spawn(read_capped(stderr));

    let status = if let Some(limit) = limit {
        match timeout(limit, child.wait()).await {
            Ok(result) => Some(result),
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                return Err(BackendError::new(format!(
                    "Node 命令超时（{} 秒）",
                    limit.as_secs()
                )));
            }
        }
    } else {
        Some(child.wait().await)
    };

    let status = match status {
        Some(Ok(status)) => status,
        Some(Err(error)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            return Err(BackendError::new(format!("等待 Node 子进程失败：{error}")));
        }
        None => unreachable!("status branch always sets a result"),
    };

    let (stdout, stdout_truncated) = join_reader(stdout_task).await?;
    let (stderr, stderr_truncated) = join_reader(stderr_task).await?;
    Ok(CommandOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: status.code(),
        truncated: stdout_truncated || stderr_truncated,
    })
}

async fn join_reader(
    handle: JoinHandle<std::io::Result<(Vec<u8>, bool)>>,
) -> BackendResult<(Vec<u8>, bool)> {
    handle
        .await
        .map_err(|error| BackendError::new(format!("读取 Node 输出任务失败：{error}")))?
        .map_err(|error| BackendError::new(format!("读取 Node 输出失败：{error}")))
}

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = OUTPUT_LIMIT.saturating_sub(output.len());
        if remaining > 0 {
            let take = remaining.min(read);
            output.extend_from_slice(&buffer[..take]);
            if take < read {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }
    Ok((output, truncated))
}

fn parse_usage_output(
    output: &CommandOutput,
    range: UsageRange,
    now_ms: u64,
) -> BackendResult<UsageSnapshot> {
    let envelope = parse_json(output, "OpenCode 用量")?;
    let data = envelope.get("data").cloned().unwrap_or(envelope);
    let mut snapshot = UsageSnapshot::deserialize(data)
        .map_err(|error| BackendError::new(format!("OpenCode 用量字段解析失败：{error}")))?;
    snapshot.range_kind = range;
    snapshot.range.from = range.start_timestamp_ms(now_ms);
    snapshot.range.to = now_ms;
    snapshot.received_at = Some(SystemTime::now());
    snapshot.models.sort_by(|left, right| {
        right
            .steps
            .cmp(&left.steps)
            .then_with(|| left.model.provider_id.cmp(&right.model.provider_id))
            .then_with(|| left.model.id.cmp(&right.model.id))
    });
    if !output.stderr.trim().is_empty() {
        let safe = sanitize_lines(&output.stderr, 5);
        if !safe.text.trim().is_empty() {
            snapshot
                .warnings
                .push(format!("OpenCode stderr：{}", safe.text.trim()));
        }
    }
    if output.truncated {
        snapshot.warnings.push("OpenCode 用量输出已截断".into());
    }
    Ok(snapshot)
}

fn parse_provider_snapshot(output: &CommandOutput) -> BackendResult<ProviderSnapshot> {
    let value = parse_json(output, "provider 状态")?;
    check_schema_version(&value)?;
    let providers_value = value
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| BackendError::new("provider JSON 缺少 providers 数组"))?;
    let mut warnings = Vec::new();
    let mut providers = Vec::new();
    for (index, provider) in providers_value.iter().enumerate() {
        if !provider
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        {
            warnings.push(format!("忽略第 {} 个没有 id 的 provider", index + 1));
            continue;
        }
        match crate::domain::Provider::deserialize(provider.clone()) {
            Ok(provider) => providers.push(provider),
            Err(error) => warnings.push(format!(
                "provider {} 解析失败：{}",
                provider.get("id").and_then(Value::as_str).unwrap_or("?"),
                error
            )),
        }
    }
    let enabled = value
        .get("enabled")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    Ok(ProviderSnapshot {
        schema_version: value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        generated_at: value
            .get("generatedAt")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        enabled,
        providers,
        received_at: Some(SystemTime::now()),
        warnings,
    })
}

fn parse_account_snapshot(output: &CommandOutput) -> BackendResult<AccountSnapshot> {
    let value = parse_json(output, "账号状态")?;
    check_schema_version(&value)?;
    let groups_value = value
        .get("providers")
        .and_then(Value::as_array)
        .ok_or_else(|| BackendError::new("账号 JSON 缺少 providers 数组"))?;
    let mut warnings = Vec::new();
    let mut providers = Vec::new();
    for (index, group) in groups_value.iter().enumerate() {
        if !group
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
        {
            warnings.push(format!("忽略第 {} 个没有 id 的账号分组", index + 1));
            continue;
        }
        match AccountGroup::deserialize(group.clone()) {
            Ok(group) => providers.push(group),
            Err(error) => warnings.push(format!(
                "账号分组 {} 解析失败：{}",
                group.get("id").and_then(Value::as_str).unwrap_or("?"),
                error
            )),
        }
    }
    Ok(AccountSnapshot {
        schema_version: value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .map(|value| value as u32),
        generated_at: value
            .get("generatedAt")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        providers,
        received_at: Some(SystemTime::now()),
        warnings,
    })
}

fn parse_credits(output: &CommandOutput) -> BackendResult<CreditsSnapshot> {
    let values: Vec<Value> = match serde_json::from_str(&output.stdout) {
        Ok(values) => values,
        Err(error) => return Err(output_error("额度", output, &error.to_string())),
    };
    let rows_value = if values.len() == 1 && values[0].is_object() {
        if let Some(rows) = values[0].get("rows").and_then(Value::as_array) {
            rows.clone()
        } else {
            values
        }
    } else {
        values
    };
    let mut warnings = Vec::new();
    let mut rows = Vec::new();
    for (index, row) in rows_value.iter().enumerate() {
        if !row
            .get("provider")
            .and_then(Value::as_str)
            .is_some_and(|provider| !provider.is_empty())
        {
            warnings.push(format!("忽略第 {} 个没有 provider 的额度行", index + 1));
            continue;
        }
        match QuotaRow::deserialize(row.clone()) {
            Ok(mut row) => {
                // 额度采集器对 Trae 用 `trae`，provider 表用 `trae-local`。
                // 不归一化会让额度列、跳转和详情都对不上 provider。
                let canonical = crate::domain::canonical_provider_id(&row.provider).to_owned();
                row.provider = canonical;
                rows.push(row);
            }
            Err(error) => warnings.push(format!(
                "额度来源 {} 解析失败：{}",
                row.get("provider").and_then(Value::as_str).unwrap_or("?"),
                error
            )),
        }
    }
    if !output.stderr.trim().is_empty() {
        let safe = sanitize_lines(&output.stderr, 5);
        if !safe.text.trim().is_empty() {
            warnings.push(format!("额度命令 stderr：{}", safe.text.trim()));
        }
    }
    if output.truncated {
        warnings.push("额度输出超过上限，已截断".to_string());
    }
    Ok(CreditsSnapshot {
        rows,
        received_at: Some(SystemTime::now()),
        warnings,
    })
}

fn parse_json(output: &CommandOutput, label: &str) -> BackendResult<Value> {
    match serde_json::from_str(&output.stdout) {
        Ok(value) => Ok(value),
        Err(error) => Err(output_error(label, output, &error.to_string())),
    }
}

fn check_schema_version(value: &Value) -> BackendResult<()> {
    if let Some(version) = value.get("schemaVersion").and_then(Value::as_u64) {
        if version > 1 {
            return Err(BackendError::new(format!(
                "后端 JSON schemaVersion={version} 高于本 TUI 支持的版本 1，请升级 router-tui"
            )));
        }
    }
    Ok(())
}

fn output_error(label: &str, output: &CommandOutput, parse_error: &str) -> BackendError {
    let stderr = sanitize_lines(&output.stderr, 12);
    let stdout_preview = sanitize_lines(&output.stdout, 4);
    let detail = if !stderr.text.trim().is_empty() {
        stderr.text.trim().to_string()
    } else if !stdout_preview.text.trim().is_empty() {
        stdout_preview.text.trim().to_string()
    } else {
        parse_error.to_string()
    };
    BackendError::new(format!(
        "{label}读取失败（退出码 {}）：{detail}",
        output
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "unknown".to_string())
    ))
}

fn text_from_output(output: &CommandOutput, max_lines: usize) -> TextResult {
    let mut combined = String::new();
    if !output.stdout.trim().is_empty() {
        combined.push_str(&output.stdout);
    }
    if !output.stderr.trim().is_empty() {
        if !combined.is_empty() && !combined.ends_with('\n') {
            combined.push('\n');
        }
        combined.push_str("[stderr]\n");
        combined.push_str(&output.stderr);
    }
    let safe = sanitize_lines(&combined, max_lines);
    TextResult {
        text: safe.text,
        exit_code: output.exit_code,
        truncated: output.truncated || safe.truncated,
    }
}

fn resolve_opencode() -> String {
    if let Some(program) = env::var("ROUTER_OPENCODE")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return program;
    }
    if cfg!(windows) {
        if let Some(app_data) = env::var_os("APPDATA") {
            let candidate = PathBuf::from(app_data)
                .join("npm")
                .join("node_modules")
                .join("@opencode")
                .join("cli")
                .join("bin")
                .join("opencode.exe");
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    "opencode".to_string()
}

/// Windows 的 `canonicalize` 会返回 `\\?\D:\...`，直接显示在标题栏里既长又不像
/// 用户输入的路径。这里只去掉这个扩展前缀，不改动其它平台。
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => text,
    }
}

fn validate_identifier(kind: &str, value: &str) -> BackendResult<()> {
    if value.is_empty()
        || value.starts_with('-')
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(BackendError::new(format!("非法 {kind} 标识：{value}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::env;

    use super::*;

    fn output(stdout: &str, stderr: &str, code: i32) -> CommandOutput {
        CommandOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            exit_code: Some(code),
            truncated: false,
        }
    }

    #[test]
    fn parses_legacy_provider_json_and_keeps_partial_rows() {
        let json = r#"{
          "enabled":["a"],
          "providers":[
            {"id":"a","title":"A","on":true,"up":false,"models":0,"auth":{"ok":true,"label":"x"}},
            {"title":"missing id"}
          ]
        }"#;
        let snapshot = parse_provider_snapshot(&output(json, "", 0)).unwrap();
        assert_eq!(snapshot.providers.len(), 1);
        assert_eq!(snapshot.providers[0].models, Some(0));
        assert_eq!(snapshot.warnings.len(), 1);
    }

    #[test]
    fn rejects_future_schema_major() {
        let output = output(r#"{"schemaVersion":2,"providers":[]}"#, "", 0);
        let error = parse_provider_snapshot(&output).unwrap_err();
        assert!(error.message.contains("高于"));
    }

    #[test]
    fn parses_quota_array_including_zero() {
        let json =
            r#"[{"provider":"a","available":true,"buckets":[{"remaining":0,"unit":"credits"}]}]"#;
        let snapshot = parse_credits(&output(json, "", 0)).unwrap();
        assert_eq!(snapshot.rows.len(), 1);
        assert_eq!(snapshot.rows[0].buckets[0].remaining, Some(0.0));
    }

    #[test]
    fn identifiers_cannot_smuggle_flags() {
        assert!(validate_identifier("provider", "--all").is_err());
        assert!(validate_identifier("provider", "a b").is_err());
        assert!(validate_identifier("provider", "qoder-cn").is_ok());
    }

    #[test]
    fn node_action_mapping_uses_safe_flags() {
        let backend = NodeBackend::new(PathBuf::from("."), "node".into(), false);
        let (_, args) = backend
            .action_command(&Action::one(ActionKind::Start, "qoder-cn"))
            .unwrap();
        assert!(args.contains(&"--no-login".to_string()));
        let (_, args) = backend
            .action_command(&Action::one(ActionKind::StopKeepOpenCode, "qoder-cn"))
            .unwrap();
        assert!(args.contains(&"--keep-oc".to_string()));
        let (_, args) = backend
            .action_command(&Action::account(
                ActionKind::SwitchAccountPreview,
                "workbuddy",
                "slot-a",
            ))
            .unwrap();
        assert!(args.contains(&"--dry-run".to_string()));
        assert!(args.contains(&"--json".to_string()));
    }

    #[tokio::test]
    #[ignore = "requires a local router checkout and Node.js"]
    async fn local_readonly_smoke() {
        let root = PathBuf::from(
            env::var("ROUTER_TUI_TEST_ROOT")
                .expect("set ROUTER_TUI_TEST_ROOT to the router checkout for this ignored test"),
        );
        let backend = NodeBackend::new(root, "node".into(), true);
        let providers = backend.providers().await.expect("provider snapshot");
        assert!(!providers.providers.is_empty());
        assert!(providers
            .providers
            .iter()
            .all(|provider| !provider.id.is_empty()));
        let accounts = backend.accounts().await.expect("account snapshot");
        assert!(!accounts.providers.is_empty());
        let credits = backend.credits().await.expect("credit snapshot");
        assert!(!credits.rows.is_empty() || !credits.warnings.is_empty());
        for row in credits
            .rows
            .iter()
            .filter(|row| row.kind == "workbuddy" && row.available)
        {
            for bucket in &row.buckets {
                assert!(
                    bucket.expires_at.is_some(),
                    "WorkBuddy bucket should include an absolute expiry"
                );
                assert!(
                    crate::domain::format_expiry_at(bucket.expires_at.as_ref().unwrap()).is_some()
                );
            }
        }
        let provider_id = providers.providers[0].id.clone();
        let logs = backend.logs(&provider_id, 20).await.expect("logs");
        assert!(logs.exit_code.is_some());
        println!(
            "read-only smoke: {} providers, {} account groups, {} quota rows, {} log bytes",
            providers.providers.len(),
            accounts.providers.len(),
            credits.rows.len(),
            logs.text.len()
        );
    }

    #[test]
    fn parses_opencode_usage_and_sorts_models() {
        let json = r#"{
          "data": {
            "range": {"from": 0, "to": 1000},
            "sessions": 2,
            "subagents": 1,
            "prompts": 4,
            "steps": 8,
            "tokens": {"input": 100, "output": 20, "reasoning": 5, "cache": {"read": 50, "write": 0}},
            "cost": 0,
            "tools": {"mode": "summary", "totals": {"calls": 4, "succeeded": 3, "failed": 1, "unfinished": 0}},
            "activeDays": 2,
            "streak": 2,
            "activity": [{"date": "2026-11-05", "steps": 8}],
            "models": [
              {"model": {"id": "b", "providerID": "qoder", "variant": "default"}, "steps": 1, "tokens": {"input": 2, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "cost": 0},
              {"model": {"id": "a", "providerID": "codearts", "variant": "high"}, "steps": 7, "tokens": {"input": 98, "output": 19, "reasoning": 5, "cache": {"read": 50, "write": 0}}, "cost": 0}
            ]
          }
        }"#;
        let snapshot =
            parse_usage_output(&output(json, "", 0), UsageRange::Week, 8 * 86_400_000).unwrap();
        assert_eq!(snapshot.steps, 8);
        assert_eq!(snapshot.models[0].model.provider_id, "codearts");
        assert_eq!(snapshot.tools.totals.success_rate(), Some(0.75));
        assert_eq!(snapshot.range.from, 86_400_000);
    }

    #[tokio::test]
    #[ignore = "requires OpenCode CLI and local session statistics"]
    async fn local_usage_smoke() {
        let root = PathBuf::from(
            env::var("ROUTER_TUI_TEST_ROOT")
                .expect("set ROUTER_TUI_TEST_ROOT to the router checkout for this ignored test"),
        );
        let backend = NodeBackend::new(root, "node".into(), true);
        let usage = backend
            .usage(UsageRange::Week)
            .await
            .expect("usage snapshot");
        println!(
            "OpenCode usage: sessions={} steps={} models={} toolCalls={}",
            usage.sessions,
            usage.steps,
            usage.models.len(),
            usage.tools.totals.calls
        );
        assert!(usage.range.from < usage.range.to);
    }

    #[test]
    fn text_output_is_sanitized_and_limited() {
        let text = text_from_output(
            &output(
                "\x1b[31mhello\x1b[0m\nAuthorization: Bearer abcdefghijk\n",
                "",
                0,
            ),
            20,
        );
        assert!(text.text.contains("hello"));
        assert!(!text.text.contains("abcdefghijk"));
        assert!(!text.text.contains("\x1b"));
    }
}
