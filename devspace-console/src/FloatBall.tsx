import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ExternalLink,
  RotateCw,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useState } from "react";
import { consoleApi } from "./console-api";
import "./float-ball.css";

interface OptimizerStatus {
  concurrent: {
    active: number;
    limit: number;
  };
  cache: {
    hits: number;
    misses: number;
    size: number;
    writes: number;
  };
}

export function FloatBall() {
  const [optimizer, setOptimizer] = useState<OptimizerStatus | null>(null);
  const [shape, setShape] = useState<"circle" | "square">(() => {
    return (localStorage.getItem("webmcp-float-shape") as "circle" | "square") || "circle";
  });
  const [isOnline, setIsOnline] = useState(true);

  // Apply root classes
  useEffect(() => {
    document.documentElement.classList.add("float-ball-window");
    document.body.classList.add("float-ball-window");
    document.getElementById("root")?.classList.add("float-ball-root");
    return () => {
      document.documentElement.classList.remove("float-ball-window");
      document.body.classList.remove("float-ball-window");
      document.getElementById("root")?.classList.remove("float-ball-root");
    };
  }, []);

  // Poll optimizer status
  useEffect(() => {
    let disposed = false;
    const fetchStatus = async () => {
      try {
        const res = await consoleApi<OptimizerStatus>("GET", "/statusz/optimizer");
        if (!disposed) {
          setOptimizer(res);
          setIsOnline(true);
        }
      } catch {
        if (!disposed) {
          setIsOnline(false);
        }
      }
    };

    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, 2500);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);

  const handleToggleShape = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const next = shape === "circle" ? "square" : "circle";
    setShape(next);
    localStorage.setItem("webmcp-float-shape", next);
  };

  const handleOpenMain = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await invoke("show_main_window");
    } catch {
      // ignore
    }
  };

  const handleCloseFloat = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await invoke("toggle_float_ball", { show: false });
    } catch {
      // ignore
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    // Left click on non-button triggers native window dragging
    if (e.button === 0) {
      const appWindow = getCurrentWindow();
      void appWindow.startDragging();
    }
  };

  const hits = optimizer?.cache.hits ?? 0;
  const misses = optimizer?.cache.misses ?? 0;
  const total = hits + misses;
  const hitRate = total > 0 ? Math.round((hits / total) * 100) : 0;
  const active = optimizer?.concurrent.active ?? 0;
  const limit = optimizer?.concurrent.limit ?? 6;
  const usagePct = limit > 0 ? Math.round((active / limit) * 100) : 0;

  // Circular gauge calculations (radius 36, circumference ~ 226.19)
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference - (Math.min(100, Math.max(0, usagePct)) / 100) * circumference;

  const statusClass = !isOnline ? "idle" : active >= limit ? "busy" : active > 0 ? "active" : "idle";

  return (
    <div className="float-ball-wrapper" data-tauri-drag-region>
      <div
        className={`float-widget ${shape} ${statusClass}`}
        data-tauri-drag-region
        onMouseDown={handleMouseDown}
        onDoubleClick={handleOpenMain}
        title="按住任意拖动，双击呼出主控制台"
      >
        {shape === "circle" ? (
          <>
            <svg className="float-circle-svg" viewBox="0 0 82 82">
              <circle
                cx="41"
                cy="41"
                r={radius}
                fill="none"
                stroke="rgba(255, 255, 255, 0.08)"
                strokeWidth="4.5"
              />
              <circle
                cx="41"
                cy="41"
                r={radius}
                fill="none"
                stroke={active >= limit ? "#f59e0b" : "#3b82f6"}
                strokeWidth="4.5"
                strokeDasharray={circumference}
                strokeDashoffset={strokeOffset}
                strokeLinecap="round"
                transform="rotate(-90 41 41)"
                style={{ transition: "stroke-dashoffset 0.35s ease" }}
              />
            </svg>
            <div className="float-circle-content">
              <span className="float-val-concurrency">
                <Zap size={12} /> {active}/{limit}
              </span>
              <span className="float-val-cache">
                {hitRate}% 命中
              </span>
              <span className="float-label-status">
                {active > 0 ? "运行中" : "待命"}
              </span>
            </div>

            {/* Circle Hover Actions */}
            <div
              className="float-circle-actions"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="float-mini-btn"
                title="切换为方形气泡"
                onClick={handleToggleShape}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <RotateCw size={12} />
              </button>
              <button
                className="float-mini-btn danger"
                title="关闭桌面悬浮球"
                onClick={handleCloseFloat}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <X size={12} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="float-square-row">
              <span style={{ color: "#93c5fd" }}>
                <Zap size={11} color="#60a5fa" /> 并发: <strong>{active}/{limit}</strong>
              </span>
              <span style={{ color: isOnline ? "#34d399" : "#94a3b8", fontSize: 10 }}>
                {isOnline ? (active > 0 ? "● 运行" : "● 空闲") : "○ 离线"}
              </span>
            </div>

            <div className="float-square-row">
              <span style={{ color: "#34d399" }}>
                💾 命中率
              </span>
              <strong style={{ color: "#34d399" }}>{hitRate}%</strong>
            </div>

            <div className="float-square-bar">
              <div className="float-square-bar-fill" style={{ width: `${Math.max(usagePct, 4)}%` }} />
            </div>

            {/* Square Hover Actions */}
            <div
              className="float-square-actions"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                className="float-action-pill"
                onClick={handleOpenMain}
                onMouseDown={(e) => e.stopPropagation()}
                title="呼出主控制台"
              >
                <ExternalLink size={10} /> 控制台
              </button>
              <button
                className="float-action-pill"
                onClick={handleToggleShape}
                onMouseDown={(e) => e.stopPropagation()}
                title="切换为圆形水球"
              >
                <RotateCw size={10} /> 切换
              </button>
              <button
                className="float-action-pill danger"
                onClick={handleCloseFloat}
                onMouseDown={(e) => e.stopPropagation()}
                title="关闭悬浮球"
              >
                <X size={10} /> 关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
export default FloatBall;
