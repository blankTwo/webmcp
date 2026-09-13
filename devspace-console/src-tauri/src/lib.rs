use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LOCAL_BASE_URL: &str = "http://127.0.0.1:7676";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientStatus {
    connected: bool,
    configured: bool,
    local_url: String,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceControlResult {
    ok: bool,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudflaredTunnelInfo {
    installed: bool,
    running: bool,
    url: Option<String>,
    pid: Option<u32>,
    logs: Vec<String>,
    error: Option<String>,
}

struct TunnelState {
    child: Option<std::process::Child>,
    url: Option<String>,
    logs: Vec<String>,
    error: Option<String>,
}

static MANAGED_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);
static MANAGED_TUNNEL: Mutex<Option<TunnelState>> = Mutex::new(None);
static SERVICE_LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn push_service_log(msg: impl AsRef<str>) {
    let text = msg.as_ref();
    let time_str = chrono::Local::now().format("%H:%M:%S").to_string();
    let formatted = format!("[{time_str}] {text}");
    if let Ok(mut logs) = SERVICE_LOGS.lock() {
        if logs.len() > 500 {
            logs.remove(0);
        }
        logs.push(formatted.clone());
    }
    if let Ok(log_path) = get_log_file_path() {
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&log_path) {
            use std::io::Write;
            let _ = writeln!(f, "{formatted}");
        }
    }
}

fn config_directories() -> Result<Vec<PathBuf>, String> {
    if let Some(path) = env::var_os("WEBMCP_CONFIG_DIR") {
        return Ok(vec![PathBuf::from(path)]);
    }
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot resolve the user configuration directory.".to_string())?;
    Ok(vec![home.join(".webmcp")])
}

fn active_config_dir() -> Result<Option<PathBuf>, String> {
    Ok(config_directories()?.into_iter().find(|directory| {
        directory.join("config.json").is_file() && directory.join("auth.json").is_file()
    }))
}

fn get_log_file_path() -> Result<PathBuf, String> {
    let dirs = config_directories()?;
    let dir = dirs.into_iter().next().ok_or_else(|| "无法获取配置目录".to_string())?;
    let logs_dir = dir.join("logs");
    let _ = fs::create_dir_all(&logs_dir);
    Ok(logs_dir.join("server.log"))
}

fn owner_token() -> Result<String, String> {
    let directory = active_config_dir()?.ok_or_else(|| "Run `webmcp init` before opening the Console.".to_string())?;
    let auth: Value = serde_json::from_slice(
        &fs::read(directory.join("auth.json")).map_err(|error| format!("Cannot read WebMCP auth: {error}"))?,
    ).map_err(|error| format!("Cannot parse WebMCP auth: {error}"))?;
    auth.get("ownerToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "WebMCP auth does not contain an Owner password.".to_string())
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveCandidate {
    drive: String,
    has_project: bool,
    project_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPathInfo {
    current_root: Option<String>,
    custom_root: Option<String>,
    available_drives: Vec<DriveCandidate>,
    cli_exists: bool,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ConsoleSettings {
    custom_project_root: Option<String>,
}

fn load_console_settings() -> ConsoleSettings {
    if let Ok(dirs) = config_directories() {
        for dir in dirs {
            let file = dir.join("console-settings.json");
            if file.is_file() {
                if let Ok(content) = fs::read_to_string(&file) {
                    if let Ok(settings) = serde_json::from_str::<ConsoleSettings>(&content) {
                        return settings;
                    }
                }
            }
        }
    }
    ConsoleSettings::default()
}

fn save_console_settings(settings: &ConsoleSettings) -> Result<(), String> {
    let dirs = config_directories()?;
    let dir = dirs.into_iter().next().ok_or_else(|| "无法获取配置目录".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(dir.join("console-settings.json"), content).map_err(|e| e.to_string())?;
    Ok(())
}

fn is_valid_project_dir(path: &std::path::Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    if path.join("dist").join("cli.js").is_file() {
        return true;
    }
    if path.join("package.json").is_file() && (path.join("src").join("server.ts").is_file() || path.join("src").is_dir()) {
        return true;
    }
    false
}

fn get_system_drives() -> Vec<DriveCandidate> {
    let mut list = Vec::new();
    #[cfg(windows)]
    {
        let candidates = [
            "webmcp-main",
            "webmcp-main",
            "webmcp",
            "webmcp-main",
            "webmcp",
            "webmcp",
        ];
        for letter in b'C'..=b'Z' {
            let drive_str = format!("{}:\\", letter as char);
            let path = PathBuf::from(&drive_str);
            if path.exists() {
                let mut found_project: Option<String> = None;
                for name in candidates {
                    let project_candidate = path.join(name);
                    if is_valid_project_dir(&project_candidate) {
                        found_project = Some(project_candidate.to_string_lossy().to_string());
                        break;
                    }
                }
                list.push(DriveCandidate {
                    drive: drive_str,
                    has_project: found_project.is_some(),
                    project_path: found_project,
                });
            }
        }
    }
    list
}

fn resolve_project_root() -> Option<PathBuf> {
    // 1. User-configured custom project root from persistent settings
    let settings = load_console_settings();
    if let Some(custom) = settings.custom_project_root {
        let p = PathBuf::from(custom);
        if is_valid_project_dir(&p) {
            return Some(p);
        }
    }

    // 2. Explicit environment variable
    if let Some(path) = env::var_os("WEBMCP_PROJECT_DIR") {
        let p = PathBuf::from(path);
        if is_valid_project_dir(&p) {
            return Some(p);
        }
    }

    // 3. Current working directory and its parents (webmcp-console -> parent webmcp-main)
    if let Ok(current) = env::current_dir() {
        if is_valid_project_dir(&current) {
            return Some(current);
        }
        let mut cur = current.clone();
        for _ in 0..4 {
            if let Some(parent) = cur.parent() {
                if is_valid_project_dir(parent) {
                    return Some(parent.to_path_buf());
                }
                cur = parent.to_path_buf();
            } else {
                break;
            }
        }
    }

    // 4. Current executable location and its parents
    if let Ok(exe) = env::current_exe() {
        let mut cur = exe.clone();
        for _ in 0..4 {
            if let Some(parent) = cur.parent() {
                if is_valid_project_dir(parent) {
                    return Some(parent.to_path_buf());
                }
                cur = parent.to_path_buf();
            } else {
                break;
            }
        }
    }

    // 5. Scan all available Windows drive letters
    for candidate in get_system_drives() {
        if let Some(proj) = candidate.project_path {
            let p = PathBuf::from(proj);
            if is_valid_project_dir(&p) {
                return Some(p);
            }
        }
    }

    None
}

fn ensure_default_config(project_root: &std::path::Path) -> Result<PathBuf, String> {
    if let Ok(Some(existing)) = active_config_dir() {
        return Ok(existing);
    }

    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法解析用户主目录".to_string())?;

    let config_dir = home.join(".webmcp");
    let _ = fs::create_dir_all(&config_dir);

    let config_file = config_dir.join("config.json");
    if !config_file.is_file() {
        let allowed_roots = vec![project_root.to_string_lossy().to_string()];
        let default_config = serde_json::json!({
            "host": "127.0.0.1",
            "port": 7676,
            "allowedRoots": allowed_roots,
            "artifactsEnabled": true
        });
        let _ = fs::write(&config_file, serde_json::to_string_pretty(&default_config).unwrap_or_default());
    }

    let auth_file = config_dir.join("auth.json");
    if !auth_file.is_file() {
        use std::time::{SystemTime, UNIX_EPOCH};
        let seed = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let token = format!("webmcp-owner-{:x}", seed);
        let default_auth = serde_json::json!({
            "ownerToken": token
        });
        let _ = fs::write(&auth_file, serde_json::to_string_pretty(&default_auth).unwrap_or_default());
    }

    Ok(config_dir)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| format!("HTTP client error: {error}"))
}

#[tauri::command]
async fn get_project_path_info() -> Result<ProjectPathInfo, String> {
    let settings = load_console_settings();
    let current = resolve_project_root();
    let cli_exists = current
        .as_ref()
        .map(|p| p.join("dist").join("cli.js").is_file())
        .unwrap_or(false);
    Ok(ProjectPathInfo {
        current_root: current.map(|p| p.to_string_lossy().to_string()),
        custom_root: settings.custom_project_root,
        available_drives: get_system_drives(),
        cli_exists,
    })
}

#[tauri::command]
async fn set_custom_project_root(path: Option<String>) -> Result<ProjectPathInfo, String> {
    let mut settings = load_console_settings();
    let clean_path = path.filter(|p| !p.trim().is_empty()).map(|p| p.trim().to_string());
    settings.custom_project_root = clean_path;
    save_console_settings(&settings)?;
    get_project_path_info().await
}

async fn check_health() -> bool {
    if let Ok(client) = http_client() {
        if let Ok(res) = client.get(format!("{LOCAL_BASE_URL}/healthz")).send().await {
            return res.status().is_success();
        }
    }
    false
}

#[tauri::command]
async fn get_client_status() -> Result<ClientStatus, String> {
    let configured = active_config_dir()?.is_some();
    let response = http_client()?.get(format!("{LOCAL_BASE_URL}/healthz")).send().await;
    match response {
        Ok(response) if response.status().is_success() => {
            let payload: Value = response.json().await.unwrap_or(Value::Null);
            let name = payload.get("name").and_then(Value::as_str);
            if name != Some("webmcp") && name != Some("gptmcp") {
                return Ok(ClientStatus {
                    connected: false,
                    configured,
                    local_url: LOCAL_BASE_URL.to_string(),
                    version: None,
                    error: Some("Port 7676 is occupied by a service that is not WebMCP.".to_string()),
                });
            }
            Ok(ClientStatus {
                connected: true,
                configured,
                local_url: LOCAL_BASE_URL.to_string(),
                version: payload.get("version").and_then(Value::as_str).map(str::to_owned),
                error: None,
            })
        }
        Ok(response) => Ok(ClientStatus {
            connected: false,
            configured,
            local_url: LOCAL_BASE_URL.to_string(),
            version: None,
            error: Some(format!("WebMCP returned HTTP {}.", response.status())),
        }),
        Err(error) => Ok(ClientStatus {
            connected: false,
            configured,
            local_url: LOCAL_BASE_URL.to_string(),
            version: None,
            error: Some(format!("WebMCP is not reachable: {error}")),
        }),
    }
}

#[tauri::command]
async fn start_webmcp_service() -> Result<ServiceControlResult, String> {
    push_service_log("🚀 收到启动 WebMCP 服务请求...");
    if check_health().await {
        push_service_log("ℹ️ 服务当前已在 127.0.0.1:7676 处于运行状态。");
        return Ok(ServiceControlResult {
            ok: true,
            message: "服务已处于运行中状态".to_string(),
        });
    }

    let project_root = match resolve_project_root() {
        Some(p) => {
            push_service_log(format!("📁 解析项目根目录: {}", p.display()));
            p
        }
        None => {
            let err = "未找到项目根目录 (请确认代码目录包含 package.json 或在控制台指定路径)".to_string();
            push_service_log(format!("❌ 错误: {err}"));
            return Err(err);
        }
    };

    // 1. Ensure default configuration files (~/.webmcp/config.json & auth.json) exist
    push_service_log("⚙️ 检查配置文件: ~/.webmcp/config.json 就绪");
    let _ = ensure_default_config(&project_root);

    // 2. Automatically build dist/cli.js if missing
    let cli_path = project_root.join("dist").join("cli.js");
    if !cli_path.is_file() {
        push_service_log("📦 未检测到 dist/cli.js，开始自动编译源码 (npm run build)...");
        #[cfg(windows)]
        let mut build_cmd = {
            let mut cmd = std::process::Command::new("cmd");
            cmd.args(["/C", "npm run build"]);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            cmd
        };
        #[cfg(not(windows))]
        let mut build_cmd = {
            let mut cmd = std::process::Command::new("npm");
            cmd.args(["run", "build"]);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd
        };
        build_cmd.current_dir(&project_root);

        let mut build_child = build_cmd.spawn().map_err(|err| {
            let msg = format!("启动构建进程失败 (npm run build): {err}");
            push_service_log(format!("❌ {msg}"));
            msg
        })?;

        if let Some(stdout) = build_child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                push_service_log(format!("📦 [构建] {line}"));
            }
        }
        if let Some(stderr) = build_child.stderr.take() {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                push_service_log(format!("⚠️ [构建输出] {line}"));
            }
        }

        match build_child.wait() {
            Ok(status) if status.success() => {
                push_service_log("✅ npm run build 编译成功！");
            }
            Ok(status) => {
                let msg = format!(
                    "自动构建源码未成功退出 (退出码: {:?})，请确保根目录已执行 npm install",
                    status.code()
                );
                push_service_log(format!("❌ {msg}"));
                return Err(msg);
            }
            Err(err) => {
                let msg = format!("等待构建进程结束失败: {err}");
                push_service_log(format!("❌ {msg}"));
                return Err(msg);
            }
        }

        if !cli_path.is_file() {
            let msg = "自动构建已执行，但未在 dist/ 目录下找到 cli.js".to_string();
            push_service_log(format!("❌ {msg}"));
            return Err(msg);
        }
    } else {
        push_service_log("📦 检测核心程序: dist/cli.js 就绪");
    }

    push_service_log("⚡ 启动独立后台守护进程: node dist/cli.js serve (解耦客户端生命周期)");
    let log_file_path = get_log_file_path().unwrap_or_else(|_| project_root.join("webmcp-server.log"));
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&log_file_path)
        .map_err(|e| format!("创建服务日志文件失败: {e}"))?;
    let log_file_err = log_file.try_clone().map_err(|e| format!("复制日志文件句柄失败: {e}"))?;

    let mut cmd = std::process::Command::new("node");
    cmd.arg(&cli_path).arg("serve");
    cmd.current_dir(&project_root);
    cmd.stdout(log_file);
    cmd.stderr(log_file_err);

    #[cfg(windows)]
    {
        // 0x08000000 = CREATE_NO_WINDOW
        // 0x00000008 = DETACHED_PROCESS (Fully detached from UI console process)
        // 0x00000200 = CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x08000000 | 0x00000008 | 0x00000200);
    }

    let child = cmd.spawn().map_err(|e| {
        let msg = format!("启动服务失败: {e}");
        push_service_log(format!("❌ {msg}"));
        msg
    })?;

    let pid = child.id();
    push_service_log(format!("⚡ 独立后台服务进程已创建 (PID: {pid})，日志记录至: {}", log_file_path.display()));

    if let Ok(mut guard) = MANAGED_CHILD.lock() {
        *guard = Some(child);
    }

    // Poll for up to 8 seconds for health check
    for i in 1..=16 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if check_health().await {
            push_service_log(format!("✅ 健康检查通过！WebMCP 核心服务已在 7676 端口独立运行 (耗时约 {:.1}s)", (i as f32) * 0.5));
            return Ok(ServiceControlResult {
                ok: true,
                message: "WebMCP 服务已成功启动并在 7676 端口独立运行".to_string(),
            });
        }
    }

    let timeout_msg = "服务启动超时，未在指定时间内响应健康检查".to_string();
    push_service_log(format!("❌ {timeout_msg}"));
    Err(timeout_msg)
}

#[tauri::command]
async fn stop_webmcp_service() -> Result<ServiceControlResult, String> {
    push_service_log("⏹️ 收到停止 WebMCP 核心服务请求...");
    if let Ok(mut guard) = MANAGED_CHILD.lock() {
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            push_service_log(format!("🔪 正在终止托管后台进程 (PID: {pid})..."));
            let _ = child.kill();
        }
    }

    #[cfg(windows)]
    {
        push_service_log("🧹 清理 7676 端口占用的网络连接与残留进程...");
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-NetTCPConnection -LocalPort 7676 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"])
            .creation_flags(0x08000000)
            .output();
    }

    tokio::time::sleep(Duration::from_millis(600)).await;

    if !check_health().await {
        push_service_log("✅ WebMCP 核心服务已成功停止，7676 端口已完全释放。");
        Ok(ServiceControlResult {
            ok: true,
            message: "服务已成功停止".to_string(),
        })
    } else {
        let err_msg = "未能完全停止服务，端口可能仍被外部进程占用".to_string();
        push_service_log(format!("⚠️ {err_msg}"));
        Err(err_msg)
    }
}

#[tauri::command]
async fn restart_webmcp_service() -> Result<ServiceControlResult, String> {
    push_service_log("🔄 收到重启 WebMCP 核心服务请求...");
    push_service_log("⏹️ 第一步: 停止现有服务并释放端口...");
    let _ = stop_webmcp_service().await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    push_service_log("🚀 第二步: 重新拉起 WebMCP 核心服务...");
    start_webmcp_service().await
}

#[tauri::command]
fn get_webmcp_service_logs() -> Vec<String> {
    let mut result = Vec::new();
    if let Ok(log_path) = get_log_file_path() {
        if log_path.is_file() {
            if let Ok(file) = fs::File::open(&log_path) {
                let reader = BufReader::new(file);
                let lines: Vec<String> = reader.lines().filter_map(Result::ok).collect();
                let start = if lines.len() > 300 { lines.len() - 300 } else { 0 };
                result.extend_from_slice(&lines[start..]);
            }
        }
    }
    if let Ok(mem_logs) = SERVICE_LOGS.lock() {
        for log in mem_logs.iter() {
            result.push(log.clone());
        }
    }
    result
}

#[tauri::command]
fn clear_webmcp_service_logs() {
    if let Ok(mut logs) = SERVICE_LOGS.lock() {
        logs.clear();
    }
    if let Ok(log_path) = get_log_file_path() {
        let _ = fs::write(log_path, "");
    }
}

fn is_cloudflared_installed() -> bool {
    let mut cmd = std::process::Command::new("cloudflared");
    cmd.arg("--version");
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

fn extract_trycloudflare_url(text: &str) -> Option<String> {
    for word in text.split_whitespace() {
        let clean = word.trim_matches(|c| {
            c == '|' || c == '+' || c == '-' || c == '"' || c == '\'' || c == ',' || c == '<' || c == '>' || c == '(' || c == ')'
        });
        if clean.starts_with("https://") && clean.ends_with(".trycloudflare.com") {
            return Some(clean.to_string());
        }
    }
    if let Some(start) = text.find("https://") {
        let sub = &text[start..];
        if let Some(end) = sub.find(".trycloudflare.com") {
            let full = &sub[..end + ".trycloudflare.com".len()];
            if !full.contains(' ') && !full.contains('|') {
                return Some(full.to_string());
            }
        }
    }
    None
}

#[tauri::command]
async fn get_cloudflared_status() -> Result<CloudflaredTunnelInfo, String> {
    let installed = is_cloudflared_installed();
    let mut guard = MANAGED_TUNNEL.lock().map_err(|e| e.to_string())?;

    if let Some(state) = guard.as_mut() {
        let mut is_alive = false;
        let mut pid = None;
        if let Some(child) = state.child.as_mut() {
            pid = Some(child.id());
            match child.try_wait() {
                Ok(None) => is_alive = true,
                Ok(Some(status)) => {
                    if !status.success() {
                        state.error = Some(format!("进程已退出 (代码: {status})"));
                    }
                }
                Err(e) => {
                    state.error = Some(format!("检测状态失败: {e}"));
                }
            }
        }
        if !is_alive {
            state.url = None;
        }
        Ok(CloudflaredTunnelInfo {
            installed,
            running: is_alive,
            url: state.url.clone(),
            pid,
            logs: state.logs.clone(),
            error: state.error.clone(),
        })
    } else {
        Ok(CloudflaredTunnelInfo {
            installed,
            running: false,
            url: None,
            pid: None,
            logs: Vec::new(),
            error: None,
        })
    }
}

#[tauri::command]
async fn start_cloudflared_tunnel(port: Option<u16>) -> Result<CloudflaredTunnelInfo, String> {
    if !is_cloudflared_installed() {
        return Err("未检测到 cloudflared。请先安装 Cloudflare CLI: 运行 `winget install Cloudflare.cloudflared` 或前往官网下载。".to_string());
    }

    let _ = stop_cloudflared_tunnel().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let target_port = port.unwrap_or(7676);
    let target_url = format!("http://127.0.0.1:{target_port}");
    let host_header = format!("127.0.0.1:{target_port}");

    let mut cmd = std::process::Command::new("cloudflared");
    cmd.args(["tunnel", "--url", &target_url, "--http-host-header", &host_header])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 cloudflared 失败: {e}"))?;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    let shared_logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let shared_url = Arc::new(Mutex::new(None::<String>));

    let logs_clone = shared_logs.clone();
    let url_clone = shared_url.clone();

    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(found) = extract_trycloudflare_url(&line) {
                    if let Ok(mut u) = url_clone.lock() {
                        *u = Some(found);
                    }
                }
                if let Ok(mut l) = logs_clone.lock() {
                    if l.len() > 100 {
                        l.remove(0);
                    }
                    l.push(line);
                }
            }
        });
    }

    let logs_clone2 = shared_logs.clone();
    let url_clone2 = shared_url.clone();
    if let Some(stdout) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(found) = extract_trycloudflare_url(&line) {
                    if let Ok(mut u) = url_clone2.lock() {
                        *u = Some(found);
                    }
                }
                if let Ok(mut l) = logs_clone2.lock() {
                    if l.len() > 100 {
                        l.remove(0);
                    }
                    l.push(line);
                }
            }
        });
    }

    let pid = child.id();
    {
        let mut guard = MANAGED_TUNNEL.lock().map_err(|e| e.to_string())?;
        *guard = Some(TunnelState {
            child: Some(child),
            url: None,
            logs: Vec::new(),
            error: None,
        });
    }

    // Wait up to 14 seconds for URL assignment
    for _ in 0..28 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let maybe_url = {
            shared_url.lock().ok().and_then(|u| u.clone())
        };
        if let Some(url_str) = maybe_url {
            {
                if let Ok(mut guard) = MANAGED_TUNNEL.lock() {
                    if let Some(state) = guard.as_mut() {
                        state.url = Some(url_str.clone());
                        if let Ok(l) = shared_logs.lock() {
                            state.logs = l.clone();
                        }
                    }
                }
            }
            return Ok(CloudflaredTunnelInfo {
                installed: true,
                running: true,
                url: Some(url_str),
                pid: Some(pid),
                logs: shared_logs.lock().map(|l| l.clone()).unwrap_or_default(),
                error: None,
            });
        }
    }

    let logs = shared_logs.lock().map(|l| l.clone()).unwrap_or_default();
    Ok(CloudflaredTunnelInfo {
        installed: true,
        running: true,
        url: None,
        pid: Some(pid),
        logs,
        error: Some("已启动隧道进程，等待分配临时域名超时，请稍后刷新检测".to_string()),
    })
}

#[tauri::command]
async fn stop_cloudflared_tunnel() -> Result<CloudflaredTunnelInfo, String> {
    {
        let mut guard = MANAGED_TUNNEL.lock().map_err(|e| e.to_string())?;
        if let Some(mut state) = guard.take() {
            if let Some(mut child) = state.child.take() {
                let _ = child.kill();
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Process -Name cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"])
            .creation_flags(0x08000000)
            .output();
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    Ok(CloudflaredTunnelInfo {
        installed: is_cloudflared_installed(),
        running: false,
        url: None,
        pid: None,
        logs: Vec::new(),
        error: None,
    })
}

fn extract_tunnel_token(input: &str) -> String {
    let trimmed = input.trim();
    for token in trimmed.split_whitespace() {
        let clean = token.trim_matches(|c| c == '\'' || c == '"' || c == '`' || c == '<' || c == '>');
        if clean.starts_with("eyJ") && clean.len() > 30 {
            return clean.to_string();
        }
    }
    let direct = trimmed.trim_matches(|c| c == '\'' || c == '"' || c == '`');
    if direct.starts_with("eyJ") {
        return direct.to_string();
    }
    trimmed.to_string()
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflaredSystemServiceStatus {
    installed: bool,
    status: String,
}

#[tauri::command]
async fn get_cloudflared_system_service_status() -> Result<CloudflaredSystemServiceStatus, String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("sc");
        cmd.arg("query").arg("Cloudflared");
        cmd.creation_flags(0x08000000);
        match cmd.output() {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                if stdout.contains("RUNNING") {
                    Ok(CloudflaredSystemServiceStatus {
                        installed: true,
                        status: "Running".to_string(),
                    })
                } else if stdout.contains("STOPPED") {
                    Ok(CloudflaredSystemServiceStatus {
                        installed: true,
                        status: "Stopped".to_string(),
                    })
                } else if stdout.contains("PAUSED") {
                    Ok(CloudflaredSystemServiceStatus {
                        installed: true,
                        status: "Paused".to_string(),
                    })
                } else if stdout.contains("START_PENDING") {
                    Ok(CloudflaredSystemServiceStatus {
                        installed: true,
                        status: "Starting".to_string(),
                    })
                } else {
                    Ok(CloudflaredSystemServiceStatus {
                        installed: false,
                        status: "NotInstalled".to_string(),
                    })
                }
            }
            Err(_) => Ok(CloudflaredSystemServiceStatus {
                installed: false,
                status: "Unknown".to_string(),
            }),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(CloudflaredSystemServiceStatus {
            installed: false,
            status: "NotSupported".to_string(),
        })
    }
}

#[tauri::command]
async fn install_cloudflared_system_service(token: String) -> Result<String, String> {
    if !is_cloudflared_installed() {
        return Err("未检测到 cloudflared CLI，请先点击「一键安装 cloudflared」".to_string());
    }
    let clean_token = extract_tunnel_token(&token);
    if clean_token.is_empty() || !clean_token.starts_with("eyJ") {
        return Err("未提取到有效的 Cloudflare 隧道 Token (Token 应以 eyJ 开头)".to_string());
    }

    #[cfg(windows)]
    {
        let script = format!(
            "Start-Process -FilePath 'cloudflared' -ArgumentList @('service', 'uninstall') -Verb runAs -Wait -ErrorAction SilentlyContinue; \
             Start-Process -FilePath 'cloudflared' -ArgumentList @('service', 'install', '{}') -Verb runAs -Wait; \
             Start-Process -FilePath 'net' -ArgumentList @('start', 'Cloudflared') -Verb runAs -Wait -ErrorAction SilentlyContinue",
            clean_token
        );
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        cmd.creation_flags(0x08000000);
        let out = cmd.output().map_err(|e| format!("执行系统提权安装命令失败: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("安装命令执行异常: {err}"));
        }
        tokio::time::sleep(Duration::from_millis(2000)).await;
        let status = get_cloudflared_system_service_status().await?;
        if status.status == "Running" {
            Ok("✅ Cloudflare 隧道 Windows 系统服务已成功安装并启动（已配置开机自启）！".to_string())
        } else {
            Ok(format!("服务安装命令已执行完毕，当前状态: {}", status.status))
        }
    }
    #[cfg(not(windows))]
    {
        Err("系统服务自动安装目前仅支持 Windows 平台".to_string())
    }
}

#[tauri::command]
async fn uninstall_cloudflared_system_service() -> Result<String, String> {
    #[cfg(windows)]
    {
        let script = "Start-Process -FilePath 'cloudflared' -ArgumentList @('service', 'uninstall') -Verb runAs -Wait -ErrorAction SilentlyContinue";
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        cmd.creation_flags(0x08000000);
        let _ = cmd.output();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok("已请求卸载 Cloudflared 系统服务".to_string())
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows 平台".to_string())
    }
}

#[tauri::command]
async fn control_cloudflared_system_service(action: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        let act = match action.as_str() {
            "start" => "start",
            "stop" => "stop",
            "restart" => "restart",
            _ => return Err("Unsupported action".to_string()),
        };
        let script = if act == "restart" {
            "Start-Process -FilePath 'net' -ArgumentList @('stop', 'Cloudflared') -Verb runAs -Wait -ErrorAction SilentlyContinue; Start-Process -FilePath 'net' -ArgumentList @('start', 'Cloudflared') -Verb runAs -Wait -ErrorAction SilentlyContinue".to_string()
        } else {
            format!("Start-Process -FilePath 'net' -ArgumentList @('{}', 'Cloudflared') -Verb runAs -Wait -ErrorAction SilentlyContinue", act)
        };
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        cmd.creation_flags(0x08000000);
        let _ = cmd.output();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let status = get_cloudflared_system_service_status().await?;
        Ok(format!("操作已执行，当前服务状态: {}", status.status))
    }
    #[cfg(not(windows))]
    {
        Err("仅支持 Windows 平台".to_string())
    }
}

#[tauri::command]
async fn install_cloudflared_cli() -> Result<String, String> {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-Command",
            "winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements --silent"
        ]);
        cmd.creation_flags(0x08000000);
        let out = cmd.output().map_err(|e| format!("执行 winget 失败: {e}"))?;
        if out.status.success() {
            Ok("✅ cloudflared CLI 已通过 winget 成功安装！".to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!("通过 winget 安装失败: {err}，建议在终端尝试 `winget install Cloudflare.cloudflared` 或前往官网下载。"))
        }
    }
    #[cfg(not(windows))]
    {
        Err("请在终端运行包管理器安装 cloudflared (例如 brew install cloudflared)".to_string())
    }
}

#[tauri::command]
async fn start_cloudflared_named_tunnel(token: String) -> Result<CloudflaredTunnelInfo, String> {
    if !is_cloudflared_installed() {
        return Err("未检测到 cloudflared。请先安装 Cloudflare CLI。".to_string());
    }

    let clean_token = extract_tunnel_token(&token);
    if clean_token.is_empty() || !clean_token.starts_with("eyJ") {
        return Err("请输入有效的 Cloudflare 隧道 Token (以 eyJ 开头)".to_string());
    }

    let _ = stop_cloudflared_tunnel().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut cmd = std::process::Command::new("cloudflared");
    cmd.args(["tunnel", "run", "--token", &clean_token])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 cloudflared 失败: {e}"))?;
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();

    let shared_logs = Arc::new(Mutex::new(Vec::<String>::new()));
    let logs_clone = shared_logs.clone();

    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut l) = logs_clone.lock() {
                    if l.len() > 200 {
                        l.remove(0);
                    }
                    l.push(line);
                }
            }
        });
    }

    let logs_clone2 = shared_logs.clone();
    if let Some(stdout) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut l) = logs_clone2.lock() {
                    if l.len() > 200 {
                        l.remove(0);
                    }
                    l.push(line);
                }
            }
        });
    }

    let pid = child.id();
    {
        let mut guard = MANAGED_TUNNEL.lock().map_err(|e| e.to_string())?;
        *guard = Some(TunnelState {
            child: Some(child),
            url: None,
            logs: Vec::new(),
            error: None,
        });
    }

    tokio::time::sleep(Duration::from_millis(1000)).await;

    Ok(CloudflaredTunnelInfo {
        installed: true,
        running: true,
        url: None,
        pid: Some(pid),
        logs: shared_logs.lock().map(|l| l.clone()).unwrap_or_default(),
        error: None,
    })
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflareLoginStatus {
    logged_in: bool,
    account_id: Option<String>,
    zone_id: Option<String>,
    has_api_token: bool,
    cert_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflareZoneItem {
    id: String,
    name: String,
    status: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudflareAutoSetupResult {
    ok: bool,
    domain: String,
    full_endpoint: String,
    tunnel_id: String,
    message: String,
}

struct CloudflareCertToken {
    account_id: String,
    api_token: String,
    zone_id: String,
    cert_path: PathBuf,
}

fn get_cloudflare_cert_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).map(PathBuf::from) {
        paths.push(home.join(".cloudflared").join("cert.pem"));
        paths.push(home.join(".webmcp").join("cert.pem"));
    }
    paths
}

fn parse_cloudflare_cert() -> Option<CloudflareCertToken> {
    use base64::Engine;
    for path in get_cloudflare_cert_paths() {
        if !path.is_file() {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if let Some(start_idx) = content.find("-----BEGIN ARGO TUNNEL TOKEN-----") {
                let rest = &content[start_idx + 33..];
                if let Some(end_idx) = rest.find("-----END ARGO TUNNEL TOKEN-----") {
                    let b64 = rest[..end_idx].replace(|c: char| c.is_whitespace(), "");
                    if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) {
                        if let Ok(val) = serde_json::from_slice::<Value>(&decoded) {
                            let account_id = val.get("accountID").and_then(Value::as_str).unwrap_or("").trim().to_string();
                            let api_token = val.get("apiToken").and_then(Value::as_str).unwrap_or("").trim().to_string();
                            let zone_id = val.get("zoneID").and_then(Value::as_str).unwrap_or("").trim().to_string();
                            if !account_id.is_empty() && !api_token.is_empty() {
                                return Some(CloudflareCertToken {
                                    account_id,
                                    api_token,
                                    zone_id,
                                    cert_path: path,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn regex_find_uuid(s: &str) -> Option<String> {
    for part in s.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '`') {
        let trimmed = part.trim();
        if trimmed.len() == 36 {
            let parts: Vec<&str> = trimmed.split('-').collect();
            if parts.len() == 5 
                && parts[0].len() == 8 
                && parts[1].len() == 4 
                && parts[2].len() == 4 
                && parts[3].len() == 4 
                && parts[4].len() == 12 
                && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_hexdigit())) {
                return Some(trimmed.to_lowercase());
            }
        }
    }
    None
}

#[tauri::command]
async fn get_cloudflare_login_status() -> Result<CloudflareLoginStatus, String> {
    if let Some(token) = parse_cloudflare_cert() {
        Ok(CloudflareLoginStatus {
            logged_in: true,
            account_id: Some(token.account_id),
            zone_id: if token.zone_id.is_empty() { None } else { Some(token.zone_id) },
            has_api_token: !token.api_token.is_empty(),
            cert_path: Some(token.cert_path.to_string_lossy().to_string()),
        })
    } else {
        Ok(CloudflareLoginStatus {
            logged_in: false,
            account_id: None,
            zone_id: None,
            has_api_token: false,
            cert_path: None,
        })
    }
}

#[tauri::command]
async fn start_cloudflare_login(force: Option<bool>) -> Result<CloudflareLoginStatus, String> {
    if !is_cloudflared_installed() {
        return Err("未检测到 cloudflared CLI。请先点击安装 cloudflared 运行时。".to_string());
    }

    if force != Some(true) {
        if let Some(token) = parse_cloudflare_cert() {
            return Ok(CloudflareLoginStatus {
                logged_in: true,
                account_id: Some(token.account_id),
                zone_id: if token.zone_id.is_empty() { None } else { Some(token.zone_id) },
                has_api_token: true,
                cert_path: Some(token.cert_path.to_string_lossy().to_string()),
            });
        }
    }

    push_service_log("🌐 正在启动 cloudflared login 并唤起浏览器完成 Cloudflare 授权...");

    let mut cmd = std::process::Command::new("cloudflared");
    cmd.arg("login")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 cloudflared login 失败: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let browser_opened = Arc::new(Mutex::new(false));

    let scan_and_open = |line: &str, opened_flag: Arc<Mutex<bool>>| {
        if let Some(start) = line.find("https://dash.cloudflare.com/argotunnel") {
            let url = line[start..].split_whitespace().next().unwrap_or("").trim().to_string();
            if !url.is_empty() {
                if let Ok(mut opened) = opened_flag.lock() {
                    if !*opened {
                        *opened = true;
                        let _ = open_url_in_browser(url);
                    }
                }
            }
        }
    };

    if let Some(out) = stdout {
        let flag = browser_opened.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                scan_and_open(&line, flag.clone());
            }
        });
    }

    if let Some(err) = stderr {
        let flag = browser_opened.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                scan_and_open(&line, flag.clone());
            }
        });
    }

    // Wait up to 180 seconds for cert.pem
    for _ in 0..180 {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        if let Some(token) = parse_cloudflare_cert() {
            if let Some(home) = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).map(PathBuf::from) {
                let _ = fs::create_dir_all(home.join(".webmcp"));
                let webmcp_cert = home.join(".webmcp").join("cert.pem");
                let _ = fs::copy(&token.cert_path, &webmcp_cert);
            }
            push_service_log("✅ Cloudflare 浏览器授权成功，已成功捕获证书凭据！");
            let _ = child.kill();
            return Ok(CloudflareLoginStatus {
                logged_in: true,
                account_id: Some(token.account_id),
                zone_id: if token.zone_id.is_empty() { None } else { Some(token.zone_id) },
                has_api_token: true,
                cert_path: Some(token.cert_path.to_string_lossy().to_string()),
            });
        }
        if let Ok(Some(_)) = child.try_wait() {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if let Some(token) = parse_cloudflare_cert() {
                return Ok(CloudflareLoginStatus {
                    logged_in: true,
                    account_id: Some(token.account_id),
                    zone_id: if token.zone_id.is_empty() { None } else { Some(token.zone_id) },
                    has_api_token: true,
                    cert_path: Some(token.cert_path.to_string_lossy().to_string()),
                });
            }
            break;
        }
    }

    let _ = child.kill();
    if let Some(token) = parse_cloudflare_cert() {
        Ok(CloudflareLoginStatus {
            logged_in: true,
            account_id: Some(token.account_id),
            zone_id: if token.zone_id.is_empty() { None } else { Some(token.zone_id) },
            has_api_token: true,
            cert_path: Some(token.cert_path.to_string_lossy().to_string()),
        })
    } else {
        Err("Cloudflare 浏览器授权超时或未在网页完成点击授权，请重试。".to_string())
    }
}

#[tauri::command]
async fn get_cloudflare_zones() -> Result<Vec<CloudflareZoneItem>, String> {
    let token = parse_cloudflare_cert().ok_or_else(|| "未检测到有效 Cloudflare 授权凭据，请先在步骤 1 点击「打开浏览器授权」".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("构建 HTTP 请求失败: {e}"))?;

    let resp = client
        .get("https://api.cloudflare.com/client/v4/zones?per_page=50")
        .header("Authorization", format!("Bearer {}", token.api_token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("连接 Cloudflare 官方 API 失败: {e}"))?;

    let body = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    let val: Value = serde_json::from_str(&body).map_err(|e| format!("解析响应失败: {e}"))?;

    if val.get("success").and_then(Value::as_bool) != Some(true) {
        let err_msg = val.get("errors").and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|obj| obj.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("读取域名列表失败");
        return Err(format!("Cloudflare API 错误: {err_msg}"));
    }

    let mut zones = Vec::new();
    if let Some(arr) = val.get("result").and_then(Value::as_array) {
        for z in arr {
            if let (Some(id), Some(name)) = (z.get("id").and_then(Value::as_str), z.get("name").and_then(Value::as_str)) {
                let status = z.get("status").and_then(Value::as_str).unwrap_or("active").to_string();
                zones.push(CloudflareZoneItem {
                    id: id.to_string(),
                    name: name.to_string(),
                    status,
                });
            }
        }
    }

    Ok(zones)
}

#[tauri::command]
async fn setup_cloudflare_auto_tunnel(
    zone_id: String,
    zone_name: String,
    subdomain: String,
    mode: String,
) -> Result<CloudflareAutoSetupResult, String> {
    let token = parse_cloudflare_cert().ok_or_else(|| "未找到有效 Cloudflare 授权凭据，请先在步骤 1 点击授权".to_string())?;

    let clean_sub = subdomain.trim().trim_matches('.').to_string();
    let clean_zone = zone_name.trim().trim_matches('.').to_string();
    if clean_sub.is_empty() || clean_zone.is_empty() {
        return Err("二级前缀和主域名不能为空".to_string());
    }
    let target_hostname = format!("{clean_sub}.{clean_zone}");
    push_service_log(format!("🚀 开始全自动配置专属域名隧道: {target_hostname} (模式: {mode})..."));

    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME")).map(PathBuf::from)
        .ok_or_else(|| "无法获取用户主目录".to_string())?;
    let cloudflared_dir = home.join(".cloudflared");
    let _ = fs::create_dir_all(&cloudflared_dir);

    // 1. Check existing tunnel or create new tunnel
    push_service_log("📦 [1/5] 检查或创建 Cloudflare Tunnel 隧道...");
    let tunnel_base_name = format!("webmcp-{}", clean_sub);
    let mut tid: Option<String> = None;

    if let Ok(entries) = fs::read_dir(&cloudflared_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(file_stem) = path.file_stem().and_then(|s| s.to_str()) {
                    if let Some(uuid_str) = regex_find_uuid(file_stem) {
                        if let Ok(content) = fs::read_to_string(&path) {
                            if let Ok(val) = serde_json::from_str::<Value>(&content) {
                                if val.get("TunnelID").and_then(Value::as_str) == Some(&uuid_str) {
                                    tid = Some(uuid_str);
                                    push_service_log(format!("ℹ️ 找到本机已有隧道凭据: {}", tid.as_ref().unwrap()));
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let tunnel_id = match tid {
        Some(id) => id,
        None => {
            let create_name = format!("{}-{}", tunnel_base_name, &chrono::Local::now().format("%m%d%H%M"));
            let mut create_cmd = std::process::Command::new("cloudflared");
            create_cmd.args(["tunnel", "create", &create_name]);
            #[cfg(windows)]
            {
                create_cmd.creation_flags(0x08000000);
            }
            let out = create_cmd.output().map_err(|e| format!("执行 cloudflared tunnel create 失败: {e}"))?;
            let combined = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            let new_uuid = regex_find_uuid(&combined).ok_or_else(|| format!("创建隧道失败: {combined}"))?;
            push_service_log(format!("✅ 新隧道创建成功: {new_uuid}"));
            new_uuid
        }
    };

    let creds_file = cloudflared_dir.join(format!("{tunnel_id}.json"));
    if !creds_file.is_file() {
        return Err(format!("未找到隧道凭据文件: {}", creds_file.display()));
    }

    // 2. DNS CNAME upsert via Cloudflare API
    push_service_log(format!("🌐 [2/5] 正在配置 Cloudflare DNS: {target_hostname} ➔ {tunnel_id}.cfargotunnel.com..."));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let cname_target = format!("{tunnel_id}.cfargotunnel.com");

    let dns_search_url = format!("https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records?name={target_hostname}");
    let dns_resp = client
        .get(&dns_search_url)
        .header("Authorization", format!("Bearer {}", token.api_token))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("查询 Cloudflare DNS 失败: {e}"))?;
    let dns_body: Value = dns_resp.json().await.map_err(|e| format!("解析 DNS 查询失败: {e}"))?;

    let existing_records = dns_body.get("result").and_then(Value::as_array);
    let mut record_updated = false;

    if let Some(records) = existing_records {
        for r in records {
            if let Some(rid) = r.get("id").and_then(Value::as_str) {
                let put_url = format!("https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records/{rid}");
                let put_resp = client
                    .put(&put_url)
                    .header("Authorization", format!("Bearer {}", token.api_token))
                    .json(&serde_json::json!({
                        "type": "CNAME",
                        "name": target_hostname,
                        "content": cname_target,
                        "ttl": 1,
                        "proxied": true
                    }))
                    .send()
                    .await
                    .map_err(|e| format!("更新 DNS 记录失败: {e}"))?;
                if put_resp.status().is_success() {
                    record_updated = true;
                    push_service_log(format!("✅ 成功更新已存在的 DNS 解析 ➔ {cname_target} (已开启 CDN 代理)"));
                    break;
                }
            }
        }
    }

    if !record_updated {
        let post_url = format!("https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records");
        let post_resp = client
            .post(&post_url)
            .header("Authorization", format!("Bearer {}", token.api_token))
            .json(&serde_json::json!({
                "type": "CNAME",
                "name": target_hostname,
                "content": cname_target,
                "ttl": 1,
                "proxied": true
            }))
            .send()
            .await
            .map_err(|e| format!("写入 DNS 记录失败: {e}"))?;
        let post_val: Value = post_resp.json().await.unwrap_or_default();
        if post_val.get("success").and_then(Value::as_bool) != Some(true) {
            let err = post_val.get("errors").and_then(Value::as_array)
                .and_then(|a| a.first()).and_then(|o| o.get("message")).and_then(Value::as_str)
                .unwrap_or("DNS 创建失败");
            return Err(format!("Cloudflare DNS 配置失败: {err}"));
        }
        push_service_log(format!("✅ 成功新建 DNS CNAME 解析: {target_hostname} ➔ {cname_target} (已开启 CDN 代理)"));
    }

    // 3. Write config.yml
    push_service_log("📝 [3/5] 写入本地 cloudflared 路由配置指向 http://127.0.0.1:7676...");
    let creds_posix = creds_file.to_string_lossy().replace('\\', "/");
    let yml_content = format!(
        "tunnel: {tunnel_id}\ncredentials-file: {creds_posix}\n\ningress:\n  - hostname: {target_hostname}\n    service: http://127.0.0.1:7676\n  - service: http_status:404\n"
    );
    let config_yml_path = cloudflared_dir.join("config.yml");
    let _ = fs::write(&config_yml_path, &yml_content);
    let webmcp_dir = home.join(".webmcp");
    let _ = fs::create_dir_all(&webmcp_dir);
    let _ = fs::write(webmcp_dir.join("cloudflared.yml"), &yml_content);

    // 4. Update WebMCP config & restart service
    push_service_log("🔄 [4/5] 同步 WebMCP 域名白名单与 OAuth 签名并平滑重启服务...");
    let target_public_url = format!("https://{target_hostname}");
    let _ = set_webmcp_public_url(Some(target_public_url.clone()), None).await;

    // 5. Start tunnel
    push_service_log(format!("⚡ [5/5] 启动 Cloudflare 隧道 (方式: {mode})..."));
    let _ = stop_cloudflared_tunnel().await;

    if mode == "service" {
        push_service_log("正在以 Windows 系统服务方式安装并启动...");
        let _ = std::process::Command::new("cloudflared")
            .args(["service", "uninstall"])
            .output();
        let _ = std::process::Command::new("cloudflared")
            .args(["--config", &config_yml_path.to_string_lossy(), "service", "install"])
            .output();
        let _ = control_cloudflared_system_service("restart".to_string()).await;
    } else {
        // Managed process mode
        let mut cmd = std::process::Command::new("cloudflared");
        cmd.args(["--config", &config_yml_path.to_string_lossy(), "tunnel", "run", &tunnel_id])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000);
        }
        let child = cmd.spawn().map_err(|e| format!("启动托管隧道失败: {e}"))?;
        let pid = child.id();
        {
            if let Ok(mut guard) = MANAGED_TUNNEL.lock() {
                *guard = Some(TunnelState {
                    child: Some(child),
                    url: Some(target_public_url.clone()),
                    logs: Vec::new(),
                    error: None,
                });
            }
        }
        push_service_log(format!("✅ 托管隧道进程已启动 (PID: {pid})"));
    }

    let full_endpoint = format!("{target_public_url}/mcp");
    push_service_log(format!("🎉 全自动配置圆满成功！ChatGPT MCP 专属端点: {full_endpoint}"));

    Ok(CloudflareAutoSetupResult {
        ok: true,
        domain: target_hostname,
        full_endpoint,
        tunnel_id,
        message: "固定域名已全自动配置成功并上线！".to_string(),
    })
}

#[tauri::command]
async fn proxy_webmcp_api(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with("/console/") && path != "/statusz" && path != "/statusz/optimizer" {
        return Err("The Console may only call WebMCP status and console endpoints.".to_string());
    }
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err(format!("Unsupported method: {method}")),
    };
    let mut request = http_client()?
        .request(method, format!("{LOCAL_BASE_URL}{path}"))
        .header("x-webmcp-owner-token", owner_token()?);
    if let Some(body) = body { request = request.json(&body); }
    let response = request.send().await.map_err(|error| format!("连接 WebMCP 后台服务失败 (服务可能未启动): {error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| format!("读取 WebMCP 响应内容失败: {error}"))?;
    let payload: Value = serde_json::from_str(&text).map_err(|_| {
        if text.contains("<html") || text.contains("<!DOCTYPE") || text.contains("<title>") {
            format!("WebMCP 服务返回了 HTML 错误页 (HTTP {status})，请在客户端点击「重启服务」")
        } else if text.trim().is_empty() {
            format!("WebMCP 服务返回了空响应 (HTTP {status})，请检查服务运行状态")
        } else {
            format!("WebMCP 服务返回了非 JSON 格式响应 (HTTP {status}): {text}")
        }
    })?;
    if !status.is_success() {
        let err_msg = payload.get("error").and_then(Value::as_str).unwrap_or("");
        if !err_msg.is_empty() {
            return Err(err_msg.to_string());
        }
        return Err(format!("WebMCP 返回错误 (HTTP {status}): {payload}"));
    }
    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffFile {
    path: String,
    status: String,
    additions: usize,
    removals: usize,
    diff: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffSnapshot {
    workspace_root: String,
    is_git: bool,
    clean: bool,
    total_files: usize,
    total_additions: usize,
    total_removals: usize,
    files: Vec<GitDiffFile>,
    full_patch: String,
}

#[tauri::command]
async fn get_workspace_git_diff(workspace_path: Option<String>) -> Result<GitDiffSnapshot, String> {
    let root = workspace_path
        .map(PathBuf::from)
        .or_else(resolve_project_root)
        .ok_or_else(|| "无法解析工作区路径".to_string())?;

    let root_str = root.to_string_lossy().to_string();

    let mut check_cmd = std::process::Command::new("git");
    check_cmd.args(["rev-parse", "--is-inside-work-tree"]).current_dir(&root);
    #[cfg(windows)]
    check_cmd.creation_flags(0x08000000);

    let check_res = check_cmd.output();
    let is_git = match check_res {
        Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "true",
        Err(_) => false,
    };

    if !is_git {
        return Ok(GitDiffSnapshot {
            workspace_root: root_str,
            is_git: false,
            clean: true,
            total_files: 0,
            total_additions: 0,
            total_removals: 0,
            files: Vec::new(),
            full_patch: String::new(),
        });
    }

    let mut status_cmd = std::process::Command::new("git");
    status_cmd.args(["status", "--porcelain=v1"]).current_dir(&root);
    #[cfg(windows)]
    status_cmd.creation_flags(0x08000000);

    let status_output = status_cmd.output().map_err(|e| format!("执行 git status 失败: {e}"))?;
    let status_str = String::from_utf8_lossy(&status_output.stdout);

    let mut changed_paths = Vec::new();
    for line in status_str.lines() {
        let trimmed = line.trim();
        if trimmed.len() >= 3 {
            let status_code = line[0..2].trim().to_string();
            let file_path = line[3..].trim().to_string();
            changed_paths.push((status_code, file_path));
        }
    }

    let mut diff_cmd = std::process::Command::new("git");
    diff_cmd.args(["diff", "HEAD"]).current_dir(&root);
    #[cfg(windows)]
    diff_cmd.creation_flags(0x08000000);

    let diff_output = diff_cmd.output().map_err(|e| format!("执行 git diff 失败: {e}"))?;
    let full_patch = String::from_utf8_lossy(&diff_output.stdout).to_string();

    let mut files = Vec::new();
    let mut total_additions = 0;
    let mut total_removals = 0;

    for (status, path) in changed_paths {
        let mut f_diff_cmd = std::process::Command::new("git");
        f_diff_cmd.args(["diff", "HEAD", "--", &path]).current_dir(&root);
        #[cfg(windows)]
        f_diff_cmd.creation_flags(0x08000000);

        let f_diff_out = f_diff_cmd.output().ok();
        let mut file_diff = f_diff_out
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        let mut additions = 0;
        let mut removals = 0;

        if file_diff.is_empty() && (status.contains('?') || status.contains('A')) {
            let abs_file = root.join(&path);
            if let Ok(content) = fs::read_to_string(&abs_file) {
                let lines_count = content.lines().count();
                additions = lines_count;
                file_diff = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{lines_count} @@\n{}", content.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"));
            }
        } else {
            for line in file_diff.lines() {
                if line.starts_with('+') && !line.starts_with("+++") {
                    additions += 1;
                } else if line.starts_with('-') && !line.starts_with("---") {
                    removals += 1;
                }
            }
        }

        total_additions += additions;
        total_removals += removals;

        files.push(GitDiffFile {
            path,
            status,
            additions,
            removals,
            diff: file_diff,
        });
    }

    let clean = files.is_empty();
    let total_files = files.len();

    Ok(GitDiffSnapshot {
        workspace_root: root_str,
        is_git: true,
        clean,
        total_files,
        total_additions,
        total_removals,
        files,
        full_patch,
    })
}

#[tauri::command]
async fn revert_workspace_file(workspace_path: Option<String>, file_path: String) -> Result<bool, String> {
    let root = workspace_path
        .map(PathBuf::from)
        .or_else(resolve_project_root)
        .ok_or_else(|| "无法解析工作区路径".to_string())?;

    let target = root.join(&file_path);
    let mut check_untracked = std::process::Command::new("git");
    check_untracked.args(["status", "--porcelain", "--", &file_path]).current_dir(&root);
    #[cfg(windows)]
    check_untracked.creation_flags(0x08000000);

    if let Ok(out) = check_untracked.output() {
        let text = String::from_utf8_lossy(&out.stdout);
        if text.starts_with("??") {
            if target.is_file() {
                let _ = fs::remove_file(&target);
                return Ok(true);
            }
        }
    }

    let mut cmd = std::process::Command::new("git");
    cmd.args(["checkout", "HEAD", "--", &file_path]).current_dir(&root);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);

    let output = cmd.output().map_err(|e| format!("回滚文件失败: {e}"))?;
    if output.status.success() {
        Ok(true)
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        Err(format!("回滚失败: {err}"))
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolsPolicyInfo {
    git_status: bool,
    git_diff: bool,
    git_log: bool,
    git_add: bool,
    git_commit: bool,
    git_pull: bool,
    git_push: bool,
    checkpoint: bool,
    history_search: bool,
    run_build_and_test: bool,
}

impl Default for ToolsPolicyInfo {
    fn default() -> Self {
        Self {
            git_status: true,
            git_diff: true,
            git_log: true,
            git_add: true,
            git_commit: true,
            git_pull: true,
            git_push: true,
            checkpoint: true,
            history_search: true,
            run_build_and_test: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebmcpConfigInfo {
    public_base_url: Option<String>,
    owner_token: Option<String>,
    allowed_roots: Vec<String>,
    config_dir: Option<String>,
    tools_policy: ToolsPolicyInfo,
    cloudflare_tunnel_token: Option<String>,
}

#[tauri::command]
async fn get_webmcp_config() -> Result<WebmcpConfigInfo, String> {
    let dir = if let Ok(Some(existing)) = active_config_dir() {
        existing
    } else {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .ok_or_else(|| "无法解析用户主目录".to_string())?;
        home.join(".webmcp")
    };

    let config_file = dir.join("config.json");
    let mut public_base_url = None;
    let mut cloudflare_tunnel_token = None;
    let mut allowed_roots = Vec::new();
    let mut tools_policy = ToolsPolicyInfo::default();

    if config_file.is_file() {
        if let Ok(content) = fs::read_to_string(&config_file) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                public_base_url = v.get("publicBaseUrl").and_then(Value::as_str).map(str::to_owned);
                cloudflare_tunnel_token = v.get("cloudflareTunnelToken").and_then(Value::as_str).map(str::to_owned);
                if let Some(roots) = v.get("allowedRoots").and_then(Value::as_array) {
                    allowed_roots = roots.iter().filter_map(|r| r.as_str().map(str::to_owned)).collect();
                }
                if let Some(tp) = v.get("toolsPolicy") {
                    if let Ok(parsed_tp) = serde_json::from_value::<ToolsPolicyInfo>(tp.clone()) {
                        tools_policy = parsed_tp;
                    }
                }
            }
        }
    }

    let auth_file = dir.join("auth.json");
    let mut token = None;
    if auth_file.is_file() {
        if let Ok(content) = fs::read_to_string(&auth_file) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                token = v.get("ownerToken").and_then(Value::as_str).map(str::to_owned);
            }
        }
    }

    Ok(WebmcpConfigInfo {
        public_base_url,
        owner_token: token,
        allowed_roots,
        config_dir: Some(dir.to_string_lossy().to_string()),
        tools_policy,
        cloudflare_tunnel_token,
    })
}

#[tauri::command]
async fn set_webmcp_public_url(url: Option<String>, tunnel_token: Option<String>) -> Result<WebmcpConfigInfo, String> {
    let dir = if let Ok(Some(existing)) = active_config_dir() {
        existing
    } else {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .ok_or_else(|| "无法解析用户主目录".to_string())?;
        let config_dir = home.join(".webmcp");
        let _ = fs::create_dir_all(&config_dir);
        config_dir
    };

    let config_file = dir.join("config.json");
    let mut config_val: Value = if config_file.is_file() {
        fs::read_to_string(&config_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({
            "host": "127.0.0.1",
            "port": 7676,
            "artifactsEnabled": true
        })
    };

    let clean_url = url.filter(|u| !u.trim().is_empty()).map(|u| u.trim().trim_end_matches('/').to_string());
    if let Some(ref u) = clean_url {
        config_val["publicBaseUrl"] = Value::String(u.clone());
        if let Ok(parsed_url) = reqwest::Url::parse(u) {
            if let Some(host) = parsed_url.host_str() {
                let mut hosts = vec![
                    "localhost".to_string(),
                    "127.0.0.1".to_string(),
                    "::1".to_string(),
                    host.to_string(),
                ];
                if let Some(existing_hosts) = config_val.get("allowedHosts").and_then(Value::as_array) {
                    for eh in existing_hosts.iter().filter_map(|v| v.as_str()) {
                        if !hosts.iter().any(|h| h == eh) {
                            hosts.push(eh.to_string());
                        }
                    }
                }
                config_val["allowedHosts"] = serde_json::json!(hosts);
            }
        }
    } else {
        config_val["publicBaseUrl"] = Value::Null;
    }

    if let Some(tok) = tunnel_token.filter(|t| !t.trim().is_empty()) {
        config_val["cloudflareTunnelToken"] = Value::String(extract_tunnel_token(&tok));
    }

    let _ = fs::write(&config_file, serde_json::to_string_pretty(&config_val).unwrap_or_default());

    // Auto restart service if currently running so new URL/host immediately takes effect
    if check_health().await {
        let _ = restart_webmcp_service().await;
    }

    get_webmcp_config().await
}

#[tauri::command]
async fn save_cloudflare_tunnel_token(token: Option<String>) -> Result<WebmcpConfigInfo, String> {
    let dir = if let Ok(Some(existing)) = active_config_dir() {
        existing
    } else {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .ok_or_else(|| "无法解析用户主目录".to_string())?;
        let config_dir = home.join(".webmcp");
        let _ = fs::create_dir_all(&config_dir);
        config_dir
    };

    let config_file = dir.join("config.json");
    let mut config_val: Value = if config_file.is_file() {
        fs::read_to_string(&config_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({
            "host": "127.0.0.1",
            "port": 7676,
            "artifactsEnabled": true
        })
    };

    let clean = token.filter(|t| !t.trim().is_empty()).map(|t| extract_tunnel_token(&t));
    if let Some(tok) = clean {
        config_val["cloudflareTunnelToken"] = Value::String(tok);
    } else {
        config_val["cloudflareTunnelToken"] = Value::Null;
    }

    let _ = fs::write(&config_file, serde_json::to_string_pretty(&config_val).unwrap_or_default());
    get_webmcp_config().await
}

#[tauri::command]
async fn save_webmcp_allowed_roots(roots: Vec<String>) -> Result<WebmcpConfigInfo, String> {
    let dir = if let Ok(Some(existing)) = active_config_dir() {
        existing
    } else {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .ok_or_else(|| "无法解析用户主目录".to_string())?;
        let config_dir = home.join(".webmcp");
        let _ = fs::create_dir_all(&config_dir);
        config_dir
    };

    let config_file = dir.join("config.json");
    let mut config_val: Value = if config_file.is_file() {
        fs::read_to_string(&config_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({
            "host": "127.0.0.1",
            "port": 7676,
            "artifactsEnabled": true
        })
    };

    config_val["allowedRoots"] = serde_json::json!(roots);
    let _ = fs::write(&config_file, serde_json::to_string_pretty(&config_val).unwrap_or_default());

    get_webmcp_config().await
}

#[tauri::command]
async fn save_webmcp_tools_policy(policy: ToolsPolicyInfo) -> Result<WebmcpConfigInfo, String> {
    let dir = if let Ok(Some(existing)) = active_config_dir() {
        existing
    } else {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .ok_or_else(|| "无法解析用户主目录".to_string())?;
        let config_dir = home.join(".webmcp");
        let _ = fs::create_dir_all(&config_dir);
        config_dir
    };

    let config_file = dir.join("config.json");
    let mut config_val: Value = if config_file.is_file() {
        fs::read_to_string(&config_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({
            "host": "127.0.0.1",
            "port": 7676,
            "artifactsEnabled": true
        })
    };

    config_val["toolsPolicy"] = serde_json::to_value(&policy).unwrap_or_default();
    let _ = fs::write(&config_file, serde_json::to_string_pretty(&config_val).unwrap_or_default());

    // Auto restart service if currently running so updated prompt/policies take effect immediately
    if check_health().await {
        let _ = restart_webmcp_service().await;
    }

    get_webmcp_config().await
}

#[tauri::command]
async fn select_folder_dialog() -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                r#"[System.Reflection.Assembly]::LoadWithPartialName("System.windows.forms") | Out-Null; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = "选择要授权给 ChatGPT 的工作区目录"; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }"#,
            ])
            .output()
            .map_err(|e| format!("打开文件夹选择框失败: {e}"))?;

        if output.status.success() {
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Ok(Some(path_str));
            }
        }
        Ok(None)
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

#[tauri::command]
async fn toggle_float_ball(app_handle: tauri::AppHandle, show: bool) -> Result<bool, String> {
    if let Some(w) = app_handle.get_webview_window("float-ball") {
        if show {
            let _ = w.show();
            let _ = w.set_focus();
            Ok(true)
        } else {
            let _ = w.hide();
            Ok(false)
        }
    } else if show {
        let builder = tauri::WebviewWindowBuilder::new(
            &app_handle,
            "float-ball",
            tauri::WebviewUrl::App("index.html?window=float-ball".into()),
        )
        .title("WebMCP Telemetry Ball")
        .inner_size(240.0, 240.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false);

        let window = builder.build().map_err(|e| e.to_string())?;
        let _ = window.show();
        let _ = window.set_focus();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn is_float_ball_visible(app_handle: tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app_handle.get_webview_window("float-ball") {
        w.is_visible().map_err(|e| e.to_string())
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn show_main_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn open_url_in_browser(url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn open_logs_directory() -> Result<(), String> {
    let log_file = get_log_file_path()?;
    let logs_dir = log_file.parent().ok_or_else(|| "无法获取日志目录".to_string())?;
    
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer")
            .arg(logs_dir)
            .spawn()
            .map_err(|e| format!("打开日志目录失败: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(logs_dir)
            .spawn()
            .map_err(|e| format!("打开日志目录失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open")
            .arg(logs_dir)
            .spawn()
            .map_err(|e| format!("打开日志目录失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn open_sqlite_location(path: Option<String>) -> Result<(), String> {
    let sqlite_path = if let Some(p) = path.filter(|s| !s.trim().is_empty()) {
        PathBuf::from(p)
    } else {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)
            .ok_or_else(|| "无法获取用户主目录".to_string())?;
        let p1 = home.join(".local").join("share").join("webmcp").join("webmcp.sqlite");
        if p1.exists() {
            p1
        } else {
            let p2 = home.join(".webmcp").join("webmcp.sqlite");
            if p2.exists() {
                p2
            } else {
                p1
            }
        }
    };

    #[cfg(windows)]
    {
        if sqlite_path.exists() {
            // Windows explorer /select,"<path>" directly selects and highlights the file!
            let _ = std::process::Command::new("explorer")
                .arg(format!("/select,{}", sqlite_path.display()))
                .spawn()
                .map_err(|e| format!("打开 SQLite 文件目录失败: {e}"))?;
        } else if let Some(parent) = sqlite_path.parent() {
            let _ = fs::create_dir_all(parent);
            let _ = std::process::Command::new("explorer")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("打开目录失败: {e}"))?;
        } else {
            return Err("未找到 SQLite 文件路径".to_string());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if sqlite_path.exists() {
            let _ = std::process::Command::new("open")
                .arg("-R")
                .arg(&sqlite_path)
                .spawn()
                .map_err(|e| format!("定位 SQLite 文件失败: {e}"))?;
        } else if let Some(parent) = sqlite_path.parent() {
            let _ = fs::create_dir_all(parent);
            let _ = std::process::Command::new("open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("打开目录失败: {e}"))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let parent = sqlite_path.parent().unwrap_or(&sqlite_path);
        let _ = fs::create_dir_all(parent);
        let _ = std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("打开目录失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn export_diagnostic_report() -> Result<String, String> {
    let mut report = String::new();
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    report.push_str(&format!("=== WebMCP 诊断报告 (生成时间: {now}) ===\n\n"));

    // 1. WebMCP Configuration
    if let Ok(dirs) = config_directories() {
        if let Some(dir) = dirs.into_iter().next() {
            let cfg_path = dir.join("config.json");
            if let Ok(content) = fs::read_to_string(&cfg_path) {
                report.push_str(&format!("--- [1. WebMCP 配置: {}] ---\n{}\n\n", cfg_path.display(), content));
            }
        }
    }

    // 2. WebMCP Core Server Logs (last 100 lines)
    if let Ok(log_path) = get_log_file_path() {
        if log_path.is_file() {
            if let Ok(content) = fs::read_to_string(&log_path) {
                let lines: Vec<&str> = content.lines().collect();
                let start = if lines.len() > 120 { lines.len() - 120 } else { 0 };
                let tail = lines[start..].join("\n");
                report.push_str(&format!("--- [2. 核心服务运行与工具调用日志 (最后 {} 行)] ---\n{}\n\n", lines.len() - start, tail));
            }
        }
    }

    // 3. Console In-Memory Service Logs
    if let Ok(srv_logs) = SERVICE_LOGS.lock() {
        report.push_str(&format!("--- [3. 控制台服务生命周期日志 (最近 {} 条)] ---\n{}\n\n", srv_logs.len(), srv_logs.join("\n")));
    }

    // 4. Cloudflared Tunnel Logs
    if let Ok(tunnel_guard) = MANAGED_TUNNEL.lock() {
        if let Some(tunnel) = tunnel_guard.as_ref() {
            report.push_str(&format!("--- [4. 托管隧道运行日志 (URL: {:?})] ---\n{}\n\n", tunnel.url, tunnel.logs.join("\n")));
        }
    }

    // 5. WebMCP Local SQLite Database status
    let sqlite_path = (|| -> Option<PathBuf> {
        let home = env::var_os("USERPROFILE")
            .or_else(|| env::var_os("HOME"))
            .map(PathBuf::from)?;
        let p1 = home.join(".local").join("share").join("webmcp").join("webmcp.sqlite");
        if p1.exists() {
            Some(p1)
        } else {
            let p2 = home.join(".webmcp").join("webmcp.sqlite");
            if p2.exists() { Some(p2) } else { Some(p1) }
        }
    })();

    if let Some(ref path) = sqlite_path {
        report.push_str(&format!("--- [5. WebMCP 本地 SQLite 数据库: {}] ---\n", path.display()));
        if path.exists() {
            if let Ok(meta) = fs::metadata(path) {
                report.push_str(&format!("文件状态: 存在 | 文件大小: {:.2} MB ({} 字节)\n", meta.len() as f64 / 1024.0 / 1024.0, meta.len()));
            }
        } else {
            report.push_str("文件状态: 数据库文件尚不存在\n");
        }
        report.push_str("\n");
    }

    // 6. Recent MCP Tool Failures from snapshot
    if let Ok(snapshot_val) = proxy_webmcp_api("GET".to_string(), "/console/snapshot?limit=100".to_string(), None).await {
        if let Some(events) = snapshot_val.get("events").and_then(|v| v.as_array()) {
            let mut failed_events = Vec::new();
            for ev in events {
                let success = ev.get("success").and_then(|s| s.as_bool()).unwrap_or(true);
                let has_err = ev.get("error").and_then(|e| e.as_str()).map(|s| !s.trim().is_empty()).unwrap_or(false);
                if !success || has_err {
                    failed_events.push(ev);
                }
            }
            if !failed_events.is_empty() {
                report.push_str(&format!("--- [6. 最近 MCP 工具执行异常汇总 (最近 {} 项异常)] ---\n", failed_events.len()));
                for ev in failed_events.iter().take(25) {
                    let ts = ev.get("timestamp").and_then(|v| v.as_str()).unwrap_or("—");
                    let tool = ev.get("tool").and_then(|v| v.as_str()).unwrap_or("—");
                    let error = ev.get("error").and_then(|v| v.as_str()).unwrap_or("未捕获具体错误信息");
                    let cmd = ev.get("commandPreview").and_then(|v| v.as_str()).unwrap_or("");
                    let path_str = ev.get("path").and_then(|v| v.as_str()).unwrap_or("");
                    report.push_str(&format!("[{ts}] 工具: {tool} | 错误: {error}\n"));
                    if !cmd.is_empty() {
                        report.push_str(&format!("      命令行: {cmd}\n"));
                    }
                    if !path_str.is_empty() {
                        report.push_str(&format!("      路径: {path_str}\n"));
                    }
                }
                report.push_str("\n");
            }
        }
    }

    Ok(report)
}

#[tauri::command]
async fn exit_app(app_handle: tauri::AppHandle, stop_service: bool) -> Result<(), String> {
    if stop_service {
        let _ = stop_webmcp_service().await;
        let _ = stop_cloudflared_tunnel().await;
    }
    app_handle.exit(0);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "打开 WebMCP 控制台", true, None::<&str>)?;
            let float_i = MenuItem::with_id(app, "toggle_float", "切换桌面悬浮球", true, None::<&str>)?;
            let restart_i = MenuItem::with_id(app, "restart", "重启 WebMCP 服务", true, None::<&str>)?;
            let quit_console_i = MenuItem::with_id(app, "quit_console", "关闭控制台 (保持后台服务运行)", true, None::<&str>)?;
            let quit_all_i = MenuItem::with_id(app, "quit_all", "停止服务并退出", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &show_i,
                    &float_i,
                    &restart_i,
                    &quit_console_i,
                    &quit_all_i,
                ],
            )?;

            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("WebMCP Console (本地开发执行层)")
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "toggle_float" => {
                            let handle = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let is_vis = is_float_ball_visible(handle.clone()).await.unwrap_or(false);
                                let _ = toggle_float_ball(handle, !is_vis).await;
                            });
                        }
                        "restart" => {
                            tauri::async_runtime::spawn(async move {
                                let _ = restart_webmcp_service().await;
                            });
                        }
                        "quit_console" => {
                            app.exit(0);
                        }
                        "quit_all" => {
                            tauri::async_runtime::spawn(async move {
                                let _ = stop_webmcp_service().await;
                                let _ = stop_cloudflared_tunnel().await;
                                std::process::exit(0);
                            });
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _tray = tray_builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // Hide main window instead of closing whole app so services & floating ball stay alive!
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_client_status,
            start_webmcp_service,
            stop_webmcp_service,
            restart_webmcp_service,
            get_webmcp_service_logs,
            clear_webmcp_service_logs,
            get_cloudflared_status,
            start_cloudflared_tunnel,
            stop_cloudflared_tunnel,
            get_project_path_info,
            set_custom_project_root,
            proxy_webmcp_api,
            get_workspace_git_diff,
            revert_workspace_file,
            get_webmcp_config,
            set_webmcp_public_url,
            save_webmcp_allowed_roots,
            save_webmcp_tools_policy,
            save_cloudflare_tunnel_token,
            get_cloudflared_system_service_status,
            install_cloudflared_system_service,
            uninstall_cloudflared_system_service,
            control_cloudflared_system_service,
            install_cloudflared_cli,
            start_cloudflared_named_tunnel,
            get_cloudflare_login_status,
            start_cloudflare_login,
            get_cloudflare_zones,
            setup_cloudflare_auto_tunnel,
            select_folder_dialog,
            toggle_float_ball,
            is_float_ball_visible,
            show_main_window,
            open_url_in_browser,
            open_logs_directory,
            open_sqlite_location,
            export_diagnostic_report,
            exit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running WebMCP Console");
}
