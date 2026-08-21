use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use std::{env, fs, io::Read, path::PathBuf, process::{Command, Stdio}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredConfig {
    host: Option<String>,
    port: Option<u16>,
    public_base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAuth {
    owner_token: String,
}

struct DevSpaceConnection {
    base_url: String,
    owner_token: String,
    public_base_url: Option<String>,
    host: String,
    port: u16,
}

fn devspace_dir() -> Result<PathBuf, String> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| "Cannot resolve the current user home directory".to_string())?;
    Ok(PathBuf::from(home).join(".devspace"))
}

fn load_connection() -> Result<DevSpaceConnection, String> {
    let dir = devspace_dir()?;
    let config_text = fs::read_to_string(dir.join("config.json"))
        .map_err(|error| format!("Cannot read DevSpace config: {error}"))?;
    let auth_text = fs::read_to_string(dir.join("auth.json"))
        .map_err(|error| format!("Cannot read DevSpace auth: {error}"))?;

    let config: StoredConfig = serde_json::from_str(&config_text)
        .map_err(|error| format!("Invalid DevSpace config: {error}"))?;
    let auth: StoredAuth = serde_json::from_str(&auth_text)
        .map_err(|error| format!("Invalid DevSpace auth: {error}"))?;

    let host = match config.host.as_deref().unwrap_or("127.0.0.1") {
        "0.0.0.0" | "::" => "127.0.0.1",
        value => value,
    };
    let port = config.port.unwrap_or(7676);

    Ok(DevSpaceConnection {
        base_url: format!("http://{host}:{port}"),
        owner_token: auth.owner_token,
        public_base_url: config.public_base_url,
        host: host.to_string(),
        port,
    })
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|error| format!("Cannot create local HTTP client: {error}"))
}

async fn fetch_runtime_status(connection: &DevSpaceConnection) -> Result<Option<Value>, String> {
    let response = match http_client()?
        .get(format!("{}/statusz", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) if error.is_connect() || error.is_timeout() => return Ok(None),
        Err(error) => return Err(format!("Cannot check DevSpace status: {error}")),
    };

    if !response.status().is_success() {
        return Err(format!(
            "Configured DevSpace address is already reachable, but /statusz returned HTTP {}",
            response.status()
        ));
    }

    response
        .json::<Value>()
        .await
        .map(Some)
        .map_err(|error| format!("Invalid DevSpace status response: {error}"))
}

async fn fetch_health_status(connection: &DevSpaceConnection) -> Result<Option<Value>, String> {
    let response = match http_client()?
        .get(format!("{}/healthz", connection.base_url))
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) if error.is_connect() || error.is_timeout() => return Ok(None),
        Err(error) => return Err(format!("Cannot check DevSpace health: {error}")),
    };

    if !response.status().is_success() {
        return Ok(None);
    }

    response
        .json::<Value>()
        .await
        .map(Some)
        .map_err(|error| format!("Invalid DevSpace health response: {error}"))
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CloudflaredProcess {
    process_id: u32,
    executable_path: Option<String>,
    command_line: Option<String>,
    creation_date: Option<String>,
    uptime_seconds: Option<u64>,
    service_name: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CloudflaredService {
    name: String,
    start_mode: String,
    path_name: String,
}

fn cloudflared_config_path() -> Result<PathBuf, String> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or_else(|| "Cannot resolve the current user home directory".to_string())?;
    let path = PathBuf::from(home).join(".cloudflared").join("config.yml");
    if !path.is_file() {
        return Err(format!("Cloudflare Tunnel config was not found: {}", path.display()));
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
fn cloudflared_service() -> Result<Option<CloudflaredService>, String> {
    let script = r#"
$service = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq 'Cloudflared' -or $_.PathName -match 'cloudflared' } | Select-Object -First 1
if ($service) {
  [pscustomobject]@{
    name = $service.Name
    startMode = $service.StartMode
    pathName = $service.PathName
  } | ConvertTo-Json -Compress
}
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|error| format!("Cannot inspect cloudflared service: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("cloudflared service inspection exited with {}", output.status)
        } else {
            stderr
        });
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Ok(None);
    }
    serde_json::from_str::<CloudflaredService>(&text)
        .map(Some)
        .map_err(|error| format!("Invalid cloudflared service data: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn cloudflared_service() -> Result<Option<CloudflaredService>, String> {
    Ok(None)
}

fn emit_service_log(app: &AppHandle, service: &str, level: &str, message: impl Into<String>) {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let _ = app.emit(
        "service-operation-log",
        serde_json::json!({
            "service": service,
            "level": level,
            "message": message.into(),
            "timestampMs": timestamp_ms,
        }),
    );
}

fn redact_cloudflared_command(command: &str) -> String {
    let mut parts = command.split_whitespace().peekable();
    let mut redacted = Vec::new();
    while let Some(part) = parts.next() {
        if part.eq_ignore_ascii_case("--token") {
            redacted.push(part.to_string());
            if parts.next().is_some() {
                redacted.push("***".to_string());
            }
            continue;
        }
        if part.to_ascii_lowercase().starts_with("--token=") {
            redacted.push("--token=***".to_string());
            continue;
        }
        redacted.push(part.to_string());
    }
    redacted.join(" ")
}

fn cloudflared_target(command: Option<&str>) -> Option<String> {
    let command = command?;
    let parts = command.split_whitespace().collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        if part.eq_ignore_ascii_case("--url") {
            return parts.get(index + 1).map(|value| value.trim_matches('"').to_string());
        }
        if let Some(value) = part.strip_prefix("--url=") {
            return Some(value.trim_matches('"').to_string());
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn cloudflared_processes() -> Result<Vec<CloudflaredProcess>, String> {
    let script = r#"
$items = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cloudflared.exe' } | ForEach-Object {
  $process = $_
  $service = Get-CimInstance Win32_Service | Where-Object { $_.ProcessId -eq $process.ProcessId } | Select-Object -First 1
  [pscustomobject]@{
    processId = [uint32]$process.ProcessId
    executablePath = $process.ExecutablePath
    commandLine = $process.CommandLine
    creationDate = if ($process.CreationDate) { $process.CreationDate.ToUniversalTime().ToString('o') } else { $null }
    uptimeSeconds = if ($process.CreationDate) { [uint64][math]::Max(0, ((Get-Date) - $process.CreationDate).TotalSeconds) } else { $null }
    serviceName = if ($service) { $service.Name } else { $null }
  }
})
ConvertTo-Json -InputObject $items -Compress
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|error| format!("Cannot inspect cloudflared processes: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("cloudflared process inspection exited with {}", output.status)
        } else {
            stderr
        });
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<CloudflaredProcess>>(&text)
        .map_err(|error| format!("Invalid cloudflared process data: {error}"))
}

#[cfg(not(target_os = "windows"))]
fn cloudflared_processes() -> Result<Vec<CloudflaredProcess>, String> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,etimes=,command="])
        .output()
        .map_err(|error| format!("Cannot inspect cloudflared processes: {error}"))?;
    if !output.status.success() {
        return Err(format!("cloudflared process inspection exited with {}", output.status));
    }
    let mut processes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if !line.to_ascii_lowercase().contains("cloudflared") {
            continue;
        }
        let mut parts = line.trim().splitn(3, char::is_whitespace).filter(|part| !part.is_empty());
        let Some(pid) = parts.next().and_then(|value| value.parse::<u32>().ok()) else { continue; };
        let uptime = parts.next().and_then(|value| value.parse::<u64>().ok());
        let command = parts.next().map(str::to_string);
        processes.push(CloudflaredProcess {
            process_id: pid,
            executable_path: command.as_ref().and_then(|value| value.split_whitespace().next()).map(str::to_string),
            command_line: command,
            creation_date: None,
            uptime_seconds: uptime,
            service_name: None,
        });
    }
    Ok(processes)
}

fn choose_cloudflared_process(processes: &[CloudflaredProcess], port: u16) -> Option<CloudflaredProcess> {
    let port_text = port.to_string();
    processes
        .iter()
        .find(|process| process.command_line.as_deref().is_some_and(|command| command.contains(&port_text)))
        .or_else(|| processes.iter().find(|process| {
            process.command_line.as_deref().is_some_and(|command| {
                command.to_ascii_lowercase().contains("tunnel run devspace")
            })
        }))
        .or_else(|| processes.iter().find(|process| process.command_line.is_some()))
        .or_else(|| processes.first())
        .cloned()
}

fn cloudflare_status(connection: &DevSpaceConnection) -> Result<Value, String> {
    let processes = cloudflared_processes()?;
    let service = cloudflared_service()?;
    let selected = choose_cloudflared_process(&processes, connection.port);
    let public_address = connection.public_base_url.clone();
    let config_path = cloudflared_config_path().ok();
    let configured_command = service
        .as_ref()
        .map(|item| item.path_name.clone())
        .or_else(|| config_path.as_ref().map(|path| format!("cloudflared --config \"{}\" tunnel run", path.display())));
    if let Some(process) = selected {
        let target_address = cloudflared_target(process.command_line.as_deref())
            .or_else(|| Some(connection.base_url.clone()));
        let command = process
            .command_line
            .as_deref()
            .map(redact_cloudflared_command)
            .or_else(|| configured_command.clone());
        return Ok(serde_json::json!({
            "name": "Cloudflare Tunnel",
            "running": true,
            "pid": process.process_id,
            "executable": process.executable_path,
            "command": command,
            "startedAt": process.creation_date,
            "uptimeSeconds": process.uptime_seconds,
            "serviceName": process.service_name.or_else(|| service.as_ref().map(|item| item.name.clone())),
            "serviceStartMode": service.as_ref().map(|item| item.start_mode.clone()),
            "configPath": config_path.as_ref().map(|path| path.display().to_string()),
            "processCount": processes.len(),
            "targetAddress": target_address,
            "publicAddress": public_address,
        }));
    }
    Ok(serde_json::json!({
        "name": "Cloudflare Tunnel",
        "running": false,
        "processCount": 0,
        "serviceName": service.as_ref().map(|item| item.name.clone()),
        "serviceStartMode": service.as_ref().map(|item| item.start_mode.clone()),
        "configPath": config_path.as_ref().map(|path| path.display().to_string()),
        "command": configured_command,
        "publicAddress": public_address,
        "targetAddress": format!("http://{}:{}", connection.host, connection.port),
    }))
}

fn devspace_status(connection: &DevSpaceConnection, runtime: Option<Value>) -> Value {
    match runtime {
        Some(status) => serde_json::json!({
            "name": "DevSpace",
            "running": true,
            "pid": status.get("pid"),
            "version": status.get("version"),
            "cwd": status.get("cwd"),
            "entry": status.get("entry"),
            "command": status.get("argv"),
            "uptimeSeconds": status.get("uptimeSeconds"),
            "localAddress": connection.base_url,
            "publicAddress": status.get("publicBaseUrl").cloned().or_else(|| connection.public_base_url.clone().map(Value::String)),
            "host": status.get("host"),
            "port": status.get("port"),
        }),
        None => serde_json::json!({
            "name": "DevSpace",
            "running": false,
            "localAddress": connection.base_url,
            "publicAddress": connection.public_base_url,
            "host": connection.host,
            "port": connection.port,
        }),
    }
}

#[tauri::command]
async fn fetch_local_service_statuses() -> Result<Value, String> {
    let connection = load_connection()?;

    let devspace = match fetch_runtime_status(&connection).await {
        Ok(runtime) => devspace_status(&connection, runtime),
        Err(status_error) => match fetch_health_status(&connection).await {
            Ok(Some(health)) => serde_json::json!({
                "name": "DevSpace",
                "running": true,
                "version": health.get("version"),
                "localAddress": connection.base_url,
                "publicAddress": connection.public_base_url,
                "host": connection.host,
                "port": connection.port,
                "compatibilityMode": true,
                "statusError": status_error,
            }),
            Ok(None) => serde_json::json!({
                "name": "DevSpace",
                "running": false,
                "localAddress": connection.base_url,
                "publicAddress": connection.public_base_url,
                "host": connection.host,
                "port": connection.port,
                "statusError": status_error,
            }),
            Err(health_error) => serde_json::json!({
                "name": "DevSpace",
                "running": false,
                "localAddress": connection.base_url,
                "publicAddress": connection.public_base_url,
                "host": connection.host,
                "port": connection.port,
                "statusError": format!("{status_error}; {health_error}"),
            }),
        },
    };

    let cloudflare_connection = DevSpaceConnection {
        base_url: connection.base_url.clone(),
        owner_token: connection.owner_token.clone(),
        public_base_url: connection.public_base_url.clone(),
        host: connection.host.clone(),
        port: connection.port,
    };
    let cloudflare = match tauri::async_runtime::spawn_blocking(move || cloudflare_status(&cloudflare_connection)).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => serde_json::json!({
            "name": "Cloudflare Tunnel",
            "running": false,
            "publicAddress": connection.public_base_url,
            "targetAddress": connection.base_url,
            "statusError": error,
        }),
        Err(error) => serde_json::json!({
            "name": "Cloudflare Tunnel",
            "running": false,
            "publicAddress": connection.public_base_url,
            "targetAddress": connection.base_url,
            "statusError": format!("Cannot inspect Cloudflare Tunnel: {error}"),
        }),
    };

    Ok(serde_json::json!({
        "devspace": devspace,
        "cloudflare": cloudflare,
    }))
}

#[cfg(target_os = "windows")]
fn resolve_devspace_cli() -> Result<PathBuf, String> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-Command devspace -ErrorAction Stop).Source",
        ])
        .output()
        .map_err(|error| format!("Cannot resolve DevSpace CLI: {error}"))?;

    if !output.status.success() {
        return Err("DevSpace CLI was not found in PATH. Install DevSpace before starting it from Console.".to_string());
    }

    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err("DevSpace CLI was not found in PATH. Install DevSpace before starting it from Console.".to_string());
    }
    Ok(PathBuf::from(path))
}

#[cfg(not(target_os = "windows"))]
fn resolve_devspace_cli() -> Result<PathBuf, String> {
    let output = Command::new("sh")
        .args(["-lc", "command -v devspace"])
        .output()
        .map_err(|error| format!("Cannot resolve DevSpace CLI: {error}"))?;
    if !output.status.success() {
        return Err("DevSpace CLI was not found in PATH. Install DevSpace before starting it from Console.".to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err("DevSpace CLI was not found in PATH. Install DevSpace before starting it from Console.".to_string());
    }
    Ok(PathBuf::from(path))
}

fn devspace_cli_command(cli: &PathBuf, action: &str) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let extension = cli
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut command = if extension == "ps1" {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]);
            command.arg(cli);
            command.arg(action);
            command
        } else if extension == "cmd" || extension == "bat" {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C"]);
            command.arg(format!("\"{}\" {action}", cli.display()));
            command
        } else {
            let mut command = Command::new(cli);
            command.arg(action);
            command
        };
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut command = Command::new(cli);
        command.arg(action);
        command
    }
}

fn source_devspace_entry() -> Option<(PathBuf, PathBuf)> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir.parent()?.parent()?.to_path_buf();
    let entry = root.join("dist").join("cli.js");
    entry.is_file().then_some((root, entry))
}

fn spawn_devspace_server(cli: &PathBuf) -> Result<(), String> {
    let mut command = devspace_cli_command(cli, "serve");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start DevSpace: {error}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn spawn_source_devspace(root: &PathBuf, entry: &PathBuf) -> Result<(), String> {
    let mut command = Command::new("node");
    command.arg(entry).arg("serve").current_dir(root);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start DevSpace source runtime: {error}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn listening_pid(port: u16) -> Result<Option<u32>, String> {
    let output = Command::new("netstat.exe")
        .args(["-ano", "-p", "tcp"])
        .output()
        .map_err(|error| format!("Cannot inspect TCP listeners: {error}"))?;
    if !output.status.success() {
        return Err(format!("netstat exited with {}", output.status));
    }
    let suffix = format!(":{port}");
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 5 || !parts[1].ends_with(&suffix) || !parts[3].eq_ignore_ascii_case("LISTENING") {
            continue;
        }
        if let Ok(pid) = parts[4].parse::<u32>() {
            return Ok(Some(pid));
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
fn listening_pid(port: u16) -> Result<Option<u32>, String> {
    let output = Command::new("lsof")
        .args(["-tiTCP", &format!(":{port}"), "-sTCP:LISTEN"])
        .output()
        .map_err(|error| format!("Cannot inspect TCP listeners: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    Ok(String::from_utf8_lossy(&output.stdout).lines().next().and_then(|value| value.trim().parse::<u32>().ok()))
}

fn launch_preferred_devspace(app: &AppHandle) -> Result<String, String> {
    if let Some((root, entry)) = source_devspace_entry() {
        let label = format!("node {} serve", entry.display());
        emit_service_log(app, "devspace", "info", format!("启动源码版：{label}"));
        spawn_source_devspace(&root, &entry)?;
        return Ok(label);
    }

    let cli = resolve_devspace_cli()?;
    let label = format!("{} serve", cli.display());
    emit_service_log(app, "devspace", "info", format!("源码构建不存在，fallback 到 {label}"));
    spawn_devspace_server(&cli)?;
    Ok(label)
}

#[tauri::command]
async fn start_devspace_server(app: AppHandle) -> Result<Value, String> {
    let connection = load_connection()?;
    emit_service_log(&app, "devspace", "info", format!("检查 {}", connection.base_url));

    match fetch_runtime_status(&connection).await {
        Ok(Some(status)) => {
            emit_service_log(&app, "devspace", "success", "DevSpace 已经在运行");
            return Ok(serde_json::json!({
                "started": false,
                "alreadyRunning": true,
                "status": status,
            }));
        }
        Ok(None) => {}
        Err(status_error) => {
            if fetch_health_status(&connection).await?.is_some() {
                emit_service_log(&app, "devspace", "success", "DevSpace 已经在运行，但当前版本不提供 /statusz");
                return Ok(serde_json::json!({
                    "started": false,
                    "alreadyRunning": true,
                    "compatibilityMode": true,
                    "statusError": status_error,
                }));
            }
        }
    }

    let launch_label = launch_preferred_devspace(&app)?;
    emit_service_log(&app, "devspace", "info", "等待 7676 健康检查");

    for _ in 0..12 {
        tokio_sleep().await;
        match fetch_runtime_status(&connection).await {
            Ok(Some(status)) => {
                let pid = status.get("pid").and_then(Value::as_u64).map(|value| value.to_string()).unwrap_or_else(|| "—".to_string());
                emit_service_log(&app, "devspace", "success", format!("DevSpace 启动成功，PID {pid}"));
                return Ok(serde_json::json!({
                    "started": true,
                    "alreadyRunning": false,
                    "status": status,
                }));
            }
            Ok(None) | Err(_) => {}
        }
    }

    let error = format!(
        "DevSpace was launched with {launch_label}, but {} did not become healthy within 12 seconds.",
        connection.base_url
    );
    emit_service_log(&app, "devspace", "error", &error);
    Err(error)
}

#[cfg(target_os = "windows")]
fn terminate_devspace_process(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let status = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Cannot stop DevSpace PID {pid}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill failed for DevSpace PID {pid} with {status}"))
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_devspace_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|error| format!("Cannot stop DevSpace PID {pid}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill failed for DevSpace PID {pid} with {status}"))
    }
}

fn spawn_devspace_runtime(exec_path: &str, cwd: &str, argv: &[String]) -> Result<(), String> {
    let mut command = Command::new(exec_path);
    command.args(argv).current_dir(cwd);

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start DevSpace runtime: {error}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

async fn restart_compatibility_devspace(app: &AppHandle, connection: &DevSpaceConnection, status_error: String) -> Result<Value, String> {
    let Some(pid) = listening_pid(connection.port)? else {
        let error = format!("DevSpace health endpoint is reachable, but PID for port {} was not found. {status_error}", connection.port);
        emit_service_log(app, "devspace", "error", &error);
        return Err(error);
    };

    emit_service_log(app, "devspace", "info", format!("检测到兼容模式 DevSpace，关闭 PID {pid}"));
    tauri::async_runtime::spawn_blocking(move || terminate_devspace_process(pid))
        .await
        .map_err(|error| format!("Cannot wait for compatibility DevSpace shutdown: {error}"))??;

    emit_service_log(app, "devspace", "info", format!("等待 {} 端口释放", connection.port));
    for _ in 0..8 {
        if fetch_health_status(connection).await?.is_none() {
            break;
        }
        tokio_sleep().await;
    }
    if fetch_health_status(connection).await?.is_some() {
        let error = format!("DevSpace PID {pid} 已结束，但 {} 仍然可访问。", connection.base_url);
        emit_service_log(app, "devspace", "error", &error);
        return Err(error);
    }

    let launch_label = launch_preferred_devspace(app)?;
    emit_service_log(app, "devspace", "info", format!("重新启动：{launch_label}"));
    emit_service_log(app, "devspace", "info", "等待 DevSpace 健康检查");

    for _ in 0..12 {
        tokio_sleep().await;
        if let Ok(Some(status)) = fetch_runtime_status(connection).await {
            let new_pid = status.get("pid").and_then(Value::as_u64).map(|value| value.to_string()).unwrap_or_else(|| "—".to_string());
            emit_service_log(app, "devspace", "success", format!("DevSpace 已恢复，PID {new_pid}"));
            return Ok(serde_json::json!({
                "restarted": true,
                "status": status,
            }));
        }
    }

    let error = format!("DevSpace 已重新启动，但 {} 在 12 秒内没有提供 /statusz。", connection.base_url);
    emit_service_log(app, "devspace", "error", &error);
    Err(error)
}

#[tauri::command]
async fn restart_devspace_server(app: AppHandle) -> Result<Value, String> {
    let connection = load_connection()?;
    let current_status = match fetch_runtime_status(&connection).await {
        Ok(Some(status)) => status,
        Ok(None) => {
            let error = "DevSpace is not running. Start it before restarting.".to_string();
            emit_service_log(&app, "devspace", "error", &error);
            return Err(error);
        }
        Err(status_error) => {
            if fetch_health_status(&connection).await?.is_some() {
                return restart_compatibility_devspace(&app, &connection, status_error).await;
            }
            emit_service_log(&app, "devspace", "error", &status_error);
            return Err(status_error);
        }
    };

    let pid = current_status
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "DevSpace status did not include a valid PID.".to_string())?;
    let exec_path = current_status
        .get("execPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "DevSpace status did not include execPath.".to_string())?
        .to_string();
    let cwd = current_status
        .get("cwd")
        .and_then(Value::as_str)
        .ok_or_else(|| "DevSpace status did not include cwd.".to_string())?
        .to_string();
    let argv = current_status
        .get("argv")
        .and_then(Value::as_array)
        .ok_or_else(|| "DevSpace status did not include argv.".to_string())?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if argv.is_empty() {
        return Err("DevSpace status returned an empty argv.".to_string());
    }

    emit_service_log(&app, "devspace", "info", format!("关闭 DevSpace，PID {pid}"));
    let stop_pid = pid;
    tauri::async_runtime::spawn_blocking(move || terminate_devspace_process(stop_pid))
        .await
        .map_err(|error| format!("Cannot wait for DevSpace shutdown: {error}"))??;

    emit_service_log(&app, "devspace", "info", "等待 7676 端口释放");
    for _ in 0..8 {
        if fetch_runtime_status(&connection).await?.is_none() {
            break;
        }
        tokio_sleep().await;
    }
    if fetch_runtime_status(&connection).await?.is_some() {
        let error = format!("DevSpace PID {pid} 已结束，但 {} 仍然被占用。", connection.base_url);
        emit_service_log(&app, "devspace", "error", &error);
        return Err(error);
    }

    let command_label = format!("{} {}", exec_path, argv.join(" "));
    emit_service_log(&app, "devspace", "info", format!("重新启动：{command_label}"));
    spawn_devspace_runtime(&exec_path, &cwd, &argv)?;
    emit_service_log(&app, "devspace", "info", "等待 DevSpace 健康检查");

    for _ in 0..12 {
        tokio_sleep().await;
        if let Some(status) = fetch_runtime_status(&connection).await? {
            let new_pid = status
                .get("pid")
                .and_then(Value::as_u64)
                .map(|value| value.to_string())
                .unwrap_or_else(|| "—".to_string());
            emit_service_log(&app, "devspace", "success", format!("DevSpace 已恢复，PID {new_pid}"));
            return Ok(serde_json::json!({
                "restarted": true,
                "status": status,
            }));
        }
    }

    let error = format!("DevSpace 已重新启动，但 {} 在 12 秒内没有恢复。", connection.base_url);
    emit_service_log(&app, "devspace", "error", &error);
    Err(error)
}

#[cfg(target_os = "windows")]
fn cloudflared_service_action(service_name: &str, action: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let escaped = service_name.replace('\'', "''");
    let verb = if action == "stop" { "Stop-Service" } else { "Start-Service" };
    let script = if action == "stop" {
        format!("{verb} -Name '{escaped}' -Force -ErrorAction Stop")
    } else {
        format!("{verb} -Name '{escaped}' -ErrorAction Stop")
    };
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Cannot {action} cloudflared service: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!("{verb} exited with {}", output.status)
    } else {
        detail
    })
}

#[cfg(not(target_os = "windows"))]
fn cloudflared_service_action(_service_name: &str, _action: &str) -> Result<(), String> {
    Err("Cloudflared service control is only available on Windows in this Console build.".to_string())
}

#[cfg(target_os = "windows")]
fn terminate_cloudflared_process(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Cannot stop cloudflared PID {pid}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if detail.is_empty() {
        format!("taskkill exited with {}", output.status)
    } else {
        detail
    })
}

#[cfg(not(target_os = "windows"))]
fn terminate_cloudflared_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|error| format!("Cannot stop cloudflared PID {pid}: {error}"))?;
    if status.success() { Ok(()) } else { Err(format!("kill exited with {status}")) }
}

#[cfg(target_os = "windows")]
fn resolve_cloudflared_executable() -> Result<PathBuf, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "(Get-Command cloudflared -ErrorAction Stop).Source"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("Cannot resolve cloudflared executable: {error}"))?;
    if !output.status.success() {
        return Err("cloudflared was not found in PATH.".to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() { Err("cloudflared was not found in PATH.".to_string()) } else { Ok(PathBuf::from(path)) }
}

#[cfg(not(target_os = "windows"))]
fn resolve_cloudflared_executable() -> Result<PathBuf, String> {
    let output = Command::new("sh")
        .args(["-lc", "command -v cloudflared"])
        .output()
        .map_err(|error| format!("Cannot resolve cloudflared executable: {error}"))?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !path.is_empty() { Ok(PathBuf::from(path)) } else { Err("cloudflared was not found in PATH.".to_string()) }
}

fn spawn_cloudflared_from_config(config_path: &PathBuf) -> Result<(), String> {
    let executable = resolve_cloudflared_executable()?;
    let mut command = Command::new(&executable);
    command.arg("--config").arg(config_path).args(["tunnel", "run"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Cloudflare Tunnel from {}: {error}", config_path.display()))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
async fn start_cloudflare_tunnel(app: AppHandle) -> Result<Value, String> {
    let connection = load_connection()?;
    let config_path = cloudflared_config_path()?;
    let processes = tauri::async_runtime::spawn_blocking(cloudflared_processes)
        .await
        .map_err(|error| format!("Cannot inspect Cloudflare Tunnel: {error}"))??;
    if let Some(current) = choose_cloudflared_process(&processes, connection.port) {
        emit_service_log(&app, "cloudflare", "success", format!("Cloudflare Tunnel 已经在运行，PID {}", current.process_id));
        return cloudflare_status(&connection);
    }

    let service = tauri::async_runtime::spawn_blocking(cloudflared_service)
        .await
        .map_err(|error| format!("Cannot inspect Cloudflare service: {error}"))??;
    emit_service_log(&app, "cloudflare", "info", format!("使用配置文件：{}", config_path.display()));
    if let Some(service) = service {
        let service_name = service.name.clone();
        emit_service_log(&app, "cloudflare", "info", format!("启动 Windows Service：{service_name}"));
        tauri::async_runtime::spawn_blocking(move || cloudflared_service_action(&service_name, "start"))
            .await
            .map_err(|error| format!("Cannot wait for Cloudflare service start: {error}"))??;
    } else {
        let config_for_start = config_path.clone();
        emit_service_log(&app, "cloudflare", "info", format!("启动 cloudflared --config \"{}\" tunnel run", config_path.display()));
        tauri::async_runtime::spawn_blocking(move || spawn_cloudflared_from_config(&config_for_start))
            .await
            .map_err(|error| format!("Cannot wait for Cloudflare Tunnel start: {error}"))??;
    }

    emit_service_log(&app, "cloudflare", "info", "等待 cloudflared 进程启动");
    for _ in 0..12 {
        tokio_sleep().await;
        let port = connection.port;
        let current = tauri::async_runtime::spawn_blocking(move || {
            let processes = cloudflared_processes()?;
            Ok::<_, String>(choose_cloudflared_process(&processes, port))
        })
        .await
        .map_err(|error| format!("Cannot inspect Cloudflare Tunnel after start: {error}"))??;
        if let Some(current) = current {
            emit_service_log(&app, "cloudflare", "success", format!("Cloudflare Tunnel 启动成功，PID {}", current.process_id));
            return cloudflare_status(&connection);
        }
    }

    let error = "Cloudflare Tunnel 启动命令已执行，但 12 秒内没有检测到 cloudflared 进程。".to_string();
    emit_service_log(&app, "cloudflare", "error", &error);
    Err(error)
}

#[tauri::command]
async fn restart_cloudflare_tunnel(app: AppHandle) -> Result<Value, String> {
    let connection = load_connection()?;
    let config_path = cloudflared_config_path()?;
    let service = tauri::async_runtime::spawn_blocking(cloudflared_service)
        .await
        .map_err(|error| format!("Cannot inspect Cloudflare service: {error}"))??;
    let processes = tauri::async_runtime::spawn_blocking(cloudflared_processes)
        .await
        .map_err(|error| format!("Cannot inspect Cloudflare Tunnel: {error}"))??;
    let process = choose_cloudflared_process(&processes, connection.port);
    let old_pid = process.as_ref().map(|item| item.process_id);

    if let Some(pid) = old_pid {
        emit_service_log(&app, "cloudflare", "info", format!("关闭 Cloudflare Tunnel，当前 PID {pid}"));
    } else {
        emit_service_log(&app, "cloudflare", "info", "Cloudflare Tunnel 当前未运行，直接执行启动");
    }

    if let Some(service) = service.as_ref() {
        let service_name = service.name.clone();
        emit_service_log(&app, "cloudflare", "info", format!("停止 Windows Service：{service_name}"));
        tauri::async_runtime::spawn_blocking(move || cloudflared_service_action(&service_name, "stop"))
            .await
            .map_err(|error| format!("Cannot wait for Cloudflare service stop: {error}"))??;
    } else if let Some(pid) = old_pid {
        tauri::async_runtime::spawn_blocking(move || terminate_cloudflared_process(pid))
            .await
            .map_err(|error| format!("Cannot wait for cloudflared shutdown: {error}"))??;
    }

    if let Some(pid) = old_pid {
        emit_service_log(&app, "cloudflare", "info", "等待旧 cloudflared 进程退出");
        for _ in 0..8 {
            let still_running = tauri::async_runtime::spawn_blocking(move || {
                Ok::<_, String>(cloudflared_processes()?.iter().any(|item| item.process_id == pid))
            })
            .await
            .map_err(|error| format!("Cannot inspect cloudflared shutdown: {error}"))??;
            if !still_running {
                break;
            }
            tokio_sleep().await;
        }
        let still_running = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, String>(cloudflared_processes()?.iter().any(|item| item.process_id == pid))
        })
        .await
        .map_err(|error| format!("Cannot inspect cloudflared shutdown: {error}"))??;
        if still_running {
            let error = format!("Cloudflare Tunnel PID {pid} 在 8 秒内没有退出。 ");
            emit_service_log(&app, "cloudflare", "error", &error);
            return Err(error);
        }
    }

    emit_service_log(&app, "cloudflare", "info", format!("使用配置文件：{}", config_path.display()));
    if let Some(service) = service {
        let service_name = service.name.clone();
        emit_service_log(&app, "cloudflare", "info", format!("启动 Windows Service：{service_name}"));
        tauri::async_runtime::spawn_blocking(move || cloudflared_service_action(&service_name, "start"))
            .await
            .map_err(|error| format!("Cannot wait for Cloudflare service start: {error}"))??;
    } else {
        let config_for_start = config_path.clone();
        emit_service_log(&app, "cloudflare", "info", format!("启动 cloudflared --config \"{}\" tunnel run", config_path.display()));
        tauri::async_runtime::spawn_blocking(move || spawn_cloudflared_from_config(&config_for_start))
            .await
            .map_err(|error| format!("Cannot wait for Cloudflare Tunnel start: {error}"))??;
    }

    emit_service_log(&app, "cloudflare", "info", "等待 Cloudflare Tunnel 恢复");
    for _ in 0..12 {
        tokio_sleep().await;
        let port = connection.port;
        let current = tauri::async_runtime::spawn_blocking(move || {
            let processes = cloudflared_processes()?;
            Ok::<_, String>(choose_cloudflared_process(&processes, port))
        })
        .await
        .map_err(|error| format!("Cannot inspect Cloudflare Tunnel after restart: {error}"))??;
        if let Some(current) = current {
            emit_service_log(&app, "cloudflare", "success", format!("Cloudflare Tunnel 已恢复，PID {}", current.process_id));
            return cloudflare_status(&connection);
        }
    }

    let error = "Cloudflare Tunnel 已重新启动，但 12 秒内没有检测到 cloudflared 进程。".to_string();
    emit_service_log(&app, "cloudflare", "error", &error);
    Err(error)
}

#[tauri::command]
async fn fetch_console_snapshot() -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .get(format!("{}/console/snapshot?limit=100", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .send()
        .await
        .map_err(|error| format!("Cannot reach DevSpace: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("DevSpace snapshot failed with HTTP {}", response.status()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid DevSpace snapshot: {error}"))
}

#[tauri::command]
async fn cleanup_console_events() -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .post(format!("{}/console/cleanup", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .send()
        .await
        .map_err(|error| format!("Cannot clean up DevSpace events: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Console cleanup failed with HTTP {}", response.status()));
    }
    response.json::<Value>().await.map_err(|error| format!("Invalid cleanup response: {error}"))
}

#[tauri::command]
async fn clear_console_events() -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .delete(format!("{}/console/events", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .send()
        .await
        .map_err(|error| format!("Cannot clear DevSpace events: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Clear events failed with HTTP {}", response.status()));
    }
    response.json::<Value>().await.map_err(|error| format!("Invalid clear events response: {error}"))
}

#[tauri::command]
async fn add_console_workspace(path: String) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .post(format!("{}/console/workspaces", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .json(&serde_json::json!({ "path": path }))
        .send()
        .await
        .map_err(|error| format!("Cannot add DevSpace workspace: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Add workspace failed with HTTP {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid add workspace response: {error}"))
}

#[tauri::command]
async fn update_console_settings(retention_days: u32) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .put(format!("{}/console/settings", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .json(&serde_json::json!({ "retentionDays": retention_days }))
        .send()
        .await
        .map_err(|error| format!("Cannot update DevSpace console settings: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("DevSpace settings failed with HTTP {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid DevSpace settings response: {error}"))
}

#[tauri::command]
async fn fetch_workspace_memory(workspace_root: String, mode: Option<String>) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .get(format!("{}/console/memory", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .query(&[("workspaceRoot", workspace_root), ("mode", mode.unwrap_or_else(|| "checkout".to_string()))])
        .send()
        .await
        .map_err(|error| format!("Cannot load workspace memory: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Workspace memory failed with HTTP {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid workspace memory response: {error}"))
}

#[tauri::command]
async fn clear_workspace_resume_state(workspace_root: String, mode: Option<String>) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .delete(format!("{}/console/memory/resume", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .query(&[("workspaceRoot", workspace_root), ("mode", mode.unwrap_or_else(|| "checkout".to_string()))])
        .send()
        .await
        .map_err(|error| format!("Cannot clear workspace resume state: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Clear workspace resume state failed with HTTP {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid clear workspace resume response: {error}"))
}

#[tauri::command]
async fn fetch_console_processes(workspace_root: String) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .get(format!("{}/console/processes", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .query(&[("workspaceRoot", workspace_root)])
        .send()
        .await
        .map_err(|error| format!("Cannot load DevSpace processes: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("DevSpace processes failed with HTTP {}", response.status()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid DevSpace processes response: {error}"))
}

#[tauri::command]
async fn fetch_console_process_output(workspace_id: String, session_id: u32) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .get(format!("{}/console/processes/{session_id}/output", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .query(&[("workspaceId", workspace_id)])
        .send()
        .await
        .map_err(|error| format!("Cannot load process output: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Process output failed with HTTP {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid process output response: {error}"))
}

#[tauri::command]
async fn terminate_console_process(workspace_id: String, session_id: u32) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .post(format!("{}/console/processes/{session_id}/terminate", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .json(&serde_json::json!({ "workspaceId": workspace_id }))
        .send()
        .await
        .map_err(|error| format!("Cannot terminate DevSpace process: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Terminate process failed with HTTP {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid terminate process response: {error}"))
}

#[tauri::command]
async fn set_console_event_favorite(id: String, favorite: bool) -> Result<Value, String> {
    let connection = load_connection()?;
    let response = http_client()?
        .put(format!("{}/console/events/{id}/favorite", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .json(&serde_json::json!({ "favorite": favorite }))
        .send()
        .await
        .map_err(|error| format!("Cannot update console event favorite: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Favorite update failed with HTTP {status}: {body}"));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid favorite response: {error}"))
}

#[tauri::command]
async fn fetch_console_history(
    workspace_root: String,
    before: Option<String>,
    limit: Option<u16>,
) -> Result<Value, String> {
    let connection = load_connection()?;
    let mut query = vec![
        ("workspaceRoot".to_string(), workspace_root),
        ("limit".to_string(), limit.unwrap_or(100).clamp(1, 250).to_string()),
    ];
    if let Some(before) = before.filter(|value| !value.is_empty()) {
        query.push(("before".to_string(), before));
    }

    let response = http_client()?
        .get(format!("{}/console/history", connection.base_url))
        .header("x-devspace-owner-token", &connection.owner_token)
        .query(&query)
        .send()
        .await
        .map_err(|error| format!("Cannot load DevSpace history: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("DevSpace history failed with HTTP {}", response.status()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|error| format!("Invalid DevSpace history response: {error}"))
}

#[tauri::command]
fn read_local_file(workspace_root: String, path: String) -> Result<Value, String> {
    const MAX_BYTES: u64 = 512 * 1024;

    let root = fs::canonicalize(PathBuf::from(workspace_root))
        .map_err(|error| format!("Workspace is not available: {error}"))?;
    let requested = PathBuf::from(path);
    let candidate = if requested.is_absolute() { requested } else { root.join(requested) };
    let target = fs::canonicalize(&candidate)
        .map_err(|error| format!("File is not available: {error}"))?;

    if !target.starts_with(&root) {
        return Err("File is outside the current workspace".to_string());
    }

    let metadata = fs::metadata(&target)
        .map_err(|error| format!("Cannot inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }

    let file = fs::File::open(&target)
        .map_err(|error| format!("Cannot open file: {error}"))?;
    let mut bytes = Vec::with_capacity((metadata.len().min(MAX_BYTES) + 1) as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read file: {error}"))?;

    let truncated = bytes.len() as u64 > MAX_BYTES;
    if truncated {
        bytes.truncate(MAX_BYTES as usize);
    }
    let binary = bytes.iter().any(|byte| *byte == 0);
    let content = if binary {
        String::new()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };

    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "content": content,
        "size": metadata.len(),
        "truncated": truncated,
        "binary": binary,
    }))
}

fn spawn_event_stream(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let connection = match load_connection() {
                Ok(connection) => connection,
                Err(error) => {
                    let _ = app.emit("devspace-stream-status", serde_json::json!({
                        "connected": false,
                        "error": error,
                    }));
                    tokio_sleep().await;
                    continue;
                }
            };

            let client = match http_client() {
                Ok(client) => client,
                Err(error) => {
                    let _ = app.emit("devspace-stream-status", serde_json::json!({
                        "connected": false,
                        "error": error,
                    }));
                    tokio_sleep().await;
                    continue;
                }
            };

            let response = client
                .get(format!("{}/console/events", connection.base_url))
                .header("x-devspace-owner-token", &connection.owner_token)
                .send()
                .await;

            let response = match response {
                Ok(response) if response.status().is_success() => response,
                Ok(response) => {
                    let _ = app.emit("devspace-stream-status", serde_json::json!({
                        "connected": false,
                        "error": format!("HTTP {}", response.status()),
                    }));
                    tokio_sleep().await;
                    continue;
                }
                Err(error) => {
                    let _ = app.emit("devspace-stream-status", serde_json::json!({
                        "connected": false,
                        "error": error.to_string(),
                    }));
                    tokio_sleep().await;
                    continue;
                }
            };

            let _ = app.emit("devspace-stream-status", serde_json::json!({ "connected": true }));
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();

            while let Some(chunk) = stream.next().await {
                let chunk = match chunk {
                    Ok(chunk) => chunk,
                    Err(_) => break,
                };
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                buffer = buffer.replace("\r\n", "\n");

                while let Some(index) = buffer.find("\n\n") {
                    let frame = buffer[..index].to_string();
                    buffer.drain(..index + 2);
                    if let Some(payload) = parse_sse_data(&frame) {
                        if let Ok(event) = serde_json::from_str::<Value>(&payload) {
                            let _ = app.emit("devspace-tool-event", event);
                        }
                    }
                }
            }

            let _ = app.emit("devspace-stream-status", serde_json::json!({ "connected": false }));
            tokio_sleep().await;
        }
    });
}

fn parse_sse_data(frame: &str) -> Option<String> {
    let data = frame
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>();
    if data.is_empty() { None } else { Some(data.join("\n")) }
}

async fn tokio_sleep() {
    tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(1)))
        .await
        .ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            spawn_event_stream(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fetch_console_snapshot,
            fetch_local_service_statuses,
            start_devspace_server,
            restart_devspace_server,
            start_cloudflare_tunnel,
            restart_cloudflare_tunnel,
            fetch_console_history,
            fetch_workspace_memory,
            clear_workspace_resume_state,
            add_console_workspace,
            update_console_settings,
            cleanup_console_events,
            clear_console_events,
            set_console_event_favorite,
            fetch_console_processes,
            fetch_console_process_output,
            terminate_console_process,
            read_local_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevSpace Console");
}
