use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

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

fn config_directories() -> Result<Vec<PathBuf>, String> {
    if let Some(path) = env::var_os("GPTMCP_CONFIG_DIR").or_else(|| env::var_os("DEVSPACE_CONFIG_DIR")) {
        return Ok(vec![PathBuf::from(path)]);
    }
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "Cannot resolve the user configuration directory.".to_string())?;
    Ok(vec![home.join(".gptmcp"), home.join(".devspace")])
}

fn active_config_dir() -> Result<Option<PathBuf>, String> {
    Ok(config_directories()?.into_iter().find(|directory| {
        directory.join("config.json").is_file() && directory.join("auth.json").is_file()
    }))
}

fn owner_token() -> Result<String, String> {
    let directory = active_config_dir()?.ok_or_else(|| "Run `gptmcp init` before opening the Console.".to_string())?;
    let auth: Value = serde_json::from_slice(
        &fs::read(directory.join("auth.json")).map_err(|error| format!("Cannot read GPTMCP auth: {error}"))?,
    ).map_err(|error| format!("Cannot parse GPTMCP auth: {error}"))?;
    auth.get("ownerToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "GPTMCP auth does not contain an Owner password.".to_string())
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

fn get_system_drives() -> Vec<DriveCandidate> {
    let mut list = Vec::new();
    #[cfg(windows)]
    {
        for letter in b'C'..=b'Z' {
            let drive_str = format!("{}:\\", letter as char);
            let path = PathBuf::from(&drive_str);
            if path.exists() {
                let default_project = path.join("devspace-main");
                let alt_project = path.join("gptmcp");
                let has_default = default_project.join("dist").join("cli.js").is_file();
                let has_alt = alt_project.join("dist").join("cli.js").is_file();
                let project_path = if has_default {
                    Some(default_project.to_string_lossy().to_string())
                } else if has_alt {
                    Some(alt_project.to_string_lossy().to_string())
                } else {
                    None
                };
                list.push(DriveCandidate {
                    drive: drive_str,
                    has_project: has_default || has_alt,
                    project_path,
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
        if p.join("dist").join("cli.js").is_file() || p.join("package.json").is_file() {
            return Some(p);
        }
    }

    // 2. Explicit environment variable
    if let Some(path) = env::var_os("GPTMCP_PROJECT_DIR").or_else(|| env::var_os("DEVSPACE_PROJECT_DIR")) {
        let p = PathBuf::from(path);
        if p.join("dist").join("cli.js").is_file() {
            return Some(p);
        }
    }

    // 3. Current working directory and its parents (devspace-console -> parent devspace-main)
    if let Ok(current) = env::current_dir() {
        if current.join("dist").join("cli.js").is_file() {
            return Some(current);
        }
        let mut cur = current.clone();
        for _ in 0..4 {
            if let Some(parent) = cur.parent() {
                if parent.join("dist").join("cli.js").is_file() {
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
                if parent.join("dist").join("cli.js").is_file() {
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
            if p.join("dist").join("cli.js").is_file() {
                return Some(p);
            }
        }
    }

    None
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
            if payload.get("name").and_then(Value::as_str) != Some("gptmcp") {
                return Ok(ClientStatus {
                    connected: false,
                    configured,
                    local_url: LOCAL_BASE_URL.to_string(),
                    version: None,
                    error: Some("Port 7676 is occupied by a service that is not GPTMCP.".to_string()),
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
            error: Some(format!("GPTMCP returned HTTP {}.", response.status())),
        }),
        Err(error) => Ok(ClientStatus {
            connected: false,
            configured,
            local_url: LOCAL_BASE_URL.to_string(),
            version: None,
            error: Some(format!("GPTMCP is not reachable: {error}")),
        }),
    }
}

#[tauri::command]
async fn start_gptmcp_service() -> Result<ServiceControlResult, String> {
    if check_health().await {
        return Ok(ServiceControlResult {
            ok: true,
            message: "服务已处于运行中状态".to_string(),
        });
    }

    let project_root = resolve_project_root()
        .ok_or_else(|| "未找到 devspace-main 项目根目录 (dist/cli.js 不存在)".to_string())?;

    let cli_path = project_root.join("dist").join("cli.js");

    let mut cmd = std::process::Command::new("node");
    cmd.arg(cli_path).arg("serve");
    cmd.current_dir(&project_root);

    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let child = cmd.spawn().map_err(|e| format!("启动服务失败: {e}"))?;
    if let Ok(mut guard) = MANAGED_CHILD.lock() {
        *guard = Some(child);
    }

    // Poll for up to 6 seconds for health check
    for _ in 0..12 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if check_health().await {
            return Ok(ServiceControlResult {
                ok: true,
                message: "GPTMCP 服务已成功启动并在 7676 端口运行".to_string(),
            });
        }
    }

    Err("服务启动超时，未在指定时间内响应健康检查".to_string())
}

#[tauri::command]
async fn stop_gptmcp_service() -> Result<ServiceControlResult, String> {
    if let Ok(mut guard) = MANAGED_CHILD.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }

    #[cfg(windows)]
    {
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-NetTCPConnection -LocalPort 7676 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"])
            .creation_flags(0x08000000)
            .output();
    }

    tokio::time::sleep(Duration::from_millis(600)).await;

    if !check_health().await {
        Ok(ServiceControlResult {
            ok: true,
            message: "服务已成功停止".to_string(),
        })
    } else {
        Err("未能完全停止服务，端口可能仍被占用".to_string())
    }
}

#[tauri::command]
async fn restart_gptmcp_service() -> Result<ServiceControlResult, String> {
    let _ = stop_gptmcp_service().await;
    tokio::time::sleep(Duration::from_millis(1000)).await;
    start_gptmcp_service().await
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

#[tauri::command]
async fn proxy_gptmcp_api(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with("/console/") && path != "/statusz" && path != "/statusz/optimizer" {
        return Err("The Console may only call GPTMCP status and console endpoints.".to_string());
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
        .header("x-gptmcp-owner-token", owner_token()?);
    if let Some(body) = body { request = request.json(&body); }
    let response = request.send().await.map_err(|error| format!("GPTMCP request failed: {error}"))?;
    let status = response.status();
    let payload: Value = response.json().await.map_err(|error| format!("GPTMCP returned invalid JSON: {error}"))?;
    if !status.is_success() { return Err(format!("GPTMCP returned HTTP {status}: {payload}")); }
    Ok(payload)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_client_status,
            start_gptmcp_service,
            stop_gptmcp_service,
            restart_gptmcp_service,
            get_cloudflared_status,
            start_cloudflared_tunnel,
            stop_cloudflared_tunnel,
            get_project_path_info,
            set_custom_project_root,
            proxy_gptmcp_api
        ])
        .run(tauri::generate_context!())
        .expect("error while running GPTMCP Console");
}
