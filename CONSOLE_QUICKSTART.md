# DevSpace Console V2 - 快速开始指南

## 🎯 一键启动

### Windows

双击运行：
```
D:\devspace-main\devspace-console\start-console.bat
```

这个脚本会自动：
1. 检查并安装依赖
2. 检查并构建 DevSpace
3. 启动 Tauri 开发服务器

### 手动启动

```bash
cd D:\devspace-main\devspace-console
npm run tauri:dev
```

## 📸 界面预览

启动后你会看到：

```
┌─────────────────────────────────────────┐
│  🖥️  DevSpace Console                   │
│      本地 MCP 服务管理                   │
├─────────────────────────────────────────┤
│                                         │
│  服务状态                                │
│  ⚫ 已停止                               │
│                                         │
│  [▶️ 启动服务]  [🔄 刷新]              │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  操作日志                                │
│  暂无日志                                │
│                                         │
└─────────────────────────────────────────┘
```

## 🎮 使用步骤

### 1. 启动服务

点击 **"启动服务"** 按钮。

控制台会：
- 自动查找 Node.js
- 执行 `node dist/cli.js serve`
- 启动 DevSpace MCP 服务（端口 7676）
- 显示进程 PID

**预期日志**：
```
[14:30:25] 正在启动 DevSpace 服务...
[14:30:27] 服务启动成功
```

### 2. 等待健康检查

服务启动后，控制台会自动进行健康检查（每 3 秒）。

**状态变化**：
```
已停止 → 正在启动... → 启动中 (PID: 12345) → 运行中 (PID: 12345) ✓
```

当显示 **"运行中"** 和 **"健康检查通过"** 时，服务已就绪。

### 3. 访问服务

服务运行后，你可以：

**在控制台中**：
- 点击服务地址链接（`http://127.0.0.1:7676`）

**在 ChatGPT 中**：
- 添加 MCP 服务器
- 输入地址：`https://你的公网域名/mcp`
- 配置 OAuth 认证

**命令行测试**：
```bash
curl http://127.0.0.1:7676/healthz
# 应返回: {"ok":true,...}
```

### 4. 停止服务

点击 **"停止服务"** 按钮。

控制台会：
- 发送终止信号
- 等待进程退出
- 清理资源

**预期日志**：
```
[14:35:12] 正在停止 DevSpace 服务...
[14:35:13] 服务已停止
```

## 🔧 配置

### 修改 DevSpace 路径

如果 DevSpace 不在 `D:\devspace-main`，需要修改配置：

**文件**: `devspace-console/src-tauri/src/lib.rs`

```rust
fn default_devspace_dir() -> Result<PathBuf, String> {
    // 修改为你的路径
    Ok(PathBuf::from("你的路径"))
}
```

重新编译：
```bash
cd D:\devspace-main\devspace-console
npm run tauri:dev
```

### 修改端口

**文件**: `devspace-console/src-tauri/src/lib.rs`

```rust
fn load_config() -> Result<ServiceConfig, String> {
    Ok(ServiceConfig {
        host: "127.0.0.1".to_string(),
        port: 你的端口,  // 默认 7676
        // ...
    })
}
```

## 🐛 故障排除

### 问题 1: "Failed to start DevSpace: ..."

**原因**：找不到 DevSpace CLI

**解决**：
```bash
cd D:\devspace-main
npm run build
ls dist/cli.js  # 确认文件存在
```

### 问题 2: "Failed to start DevSpace: ... node"

**原因**：找不到 Node.js

**解决**：
```bash
node --version  # 确认 Node.js 在 PATH 中
# 如果不在，在 lib.rs 中指定完整路径：
# node_path: Some("C:\Program Files\nodejs\node.exe".to_string())
```

### 问题 3: 服务启动了但健康检查失败

**原因**：服务需要 2-3 秒初始化

**解决**：等待几秒钟，健康检查会自动重试。

如果一直失败：
```bash
# 手动测试
curl http://127.0.0.1:7676/healthz

# 查看端口占用
netstat -ano | findstr 7676
```

### 问题 4: 窗口显示空白

**原因**：前端未构建

**解决**：
```bash
cd D:\devspace-main\devspace-console
npm run build
```

## 📦 构建生产版本

### 完整应用

```bash
cd D:\devspace-main\devspace-console
npm run tauri:build
```

**产物位置**：
```
src-tauri/target/release/
├── devspace-console.exe      # 主程序
└── bundle/
    └── nsis/
        └── devspace-console_1.0.0_x64-setup.exe  # 安装包
```

### 分发

1. 复制 `devspace-console.exe`
2. 确保目标机器有：
   - Node.js (v22+)
   - DevSpace 安装目录

## 🎨 自定义

### 修改主题颜色

**文件**: `devspace-console/src/App.tsx`

```typescript
// 找到并修改这些颜色类
className="bg-green-600"   // 启动按钮
className="bg-red-600"     // 停止按钮
className="bg-blue-600"    // 刷新按钮
```

### 添加新功能

1. 在 Rust 中定义命令：`src-tauri/src/lib.rs`
2. 在 React 中调用：`src/App.tsx`

示例：添加"查看日志"功能

**Rust**:
```rust
#[tauri::command]
async fn get_service_logs() -> Result<Vec<String>, String> {
    // 读取日志文件
    Ok(vec!["log line 1".to_string()])
}

// 注册
.invoke_handler(tauri::generate_handler![
    get_service_logs,
    // ...
])
```

**React**:
```typescript
const logs = await invoke<string[]>("get_service_logs");
```

## 📚 更多资源

- **完整文档**: `devspace-console/CONSOLE_README.md`
- **Tauri 文档**: https://tauri.app
- **DevSpace 主项目**: `D:\devspace-main`

## ✨ 下一步

1. 运行控制台测试基本功能
2. 配置 ChatGPT 连接
3. 尝试工具调用
4. 根据需要自定义界面

---

**享受 DevSpace Console V2！** 🎉
