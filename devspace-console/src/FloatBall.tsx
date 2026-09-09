import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity,
  Database,
  ExternalLink,
  RotateCw,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [showDetails, setShowDetails] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const clickTimerRef = useRef<NodeJS.Timeout | null>(null);

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

  // Dragging and Click Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    dragStartPos.current = { x: e.screenX, y: e.screenY };
    isDraggingRef.current = false;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragStartPos.current) return;
    const dx = Math.abs(e.screenX - dragStartPos.current.x);
    const dy = Math.abs(e.screenY - dragStartPos.current.y);
    if (dx > 4 || dy > 4) {
      isDraggingRef.current = true;
      const appWindow = getCurrentWindow();
      void appWindow.startDragging();
      dragStartPos.current = null;
    }
  };

  const handleMouseUp = () => {
    dragStartPos.current = null;
  };

  const handleClick = (e: React.MouseEvent) => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      return;
    }

    if (clickTimerRef.current) {
      // Double click detected!
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      void handleOpenMain(e);
    } else {
      // Single click: toggle details popover after short delay
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        setShowDetails((prev) => !prev);
      }, 240);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setShowDetails((prev) => !prev);
  };

  const hits = optimizer?.cache.hits ?? 0;
  const misses = optimizer?.cache.misses ?? 0;
  const total = hits + misses;
  const hitRate = total > 0 ? Math.round((hits / total) * 100) : 0;
  const active = optimizer?.concurrent.active ?? 0;
  const limit = optimizer?.concurrent.limit ?? 4;
  const usagePct = limit > 0 ? Math.round((active / limit) * 100) : 0;

  // Circular gauge calculations
  const radius = 33;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference - (Math.min(100, Math.max(0, usagePct)) / 100) * circumference;

  const statusClass = !isOnline ? "idle" : active >= limit ? "busy" : active > 0 ? "active" : "idle";

  return (
    <div className="float-ball-container" onContextMenu={handleContextMenu}>
      {/* Popover Details Card */}
      {showDetails && (
        <div className="float-ball-popover" onClick={(e) => e.stopPropagation()}>
          <div className="float-popover-header">
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <Zap size={13} color="#60a5fa" /> WebMCP 实时遥测
            </span>
            <span style={{ color: isOnline ? "#34d399" : "#f87171" }}>
              {isOnline ? "● 在线" : "○ 离线"}
            </span>
          </div>

          <div className="float-popover-stat-row">
            <span><Activity size={12} /> 并发负载</span>
            <strong style={{ color: "#93c5fd" }}>{active} / {limit} ({usagePct}%)</strong>
          </div>

          <div className="float-popover-stat-row">
            <span><Database size={12} /> 缓存命中率</span>
            <strong style={{ color: "#34d399" }}>{hitRate}% ({hits} 命中)</strong>
          </div>

          <div className="float-popover-stat-row">
            <span>缓存条目 / 写入</span>
            <strong>{optimizer?.cache.size ?? 0} / {optimizer?.cache.writes ?? 0}</strong>
          </div>

          <div className="float-popover-actions">
            <button className="float-popover-btn" onClick={handleOpenMain} title="双击悬浮球亦可呼出主面板">
              <ExternalLink size={11} /> 主控制台
            </button>
            <button className="float-popover-btn" onClick={handleToggleShape} title="切换圆形 / 方块形态">
              <RotateCw size={11} /> 切换形态
            </button>
            <button className="float-popover-btn danger" onClick={handleCloseFloat} title="隐藏桌面悬浮球">
              <X size={11} /> 关闭
            </button>
          </div>
        </div>
      )}

      {/* Floating Ball Widget */}
      <div
        className={`float-ball-widget ${shape} ${statusClass}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={handleClick}
        title="按住随意拖动，双击呼出主控制台，单击展开遥测详情"
      >
        {shape === "circle" ? (
          <>
            <svg className="float-ball-ring-svg" viewBox="0 0 78 78">
              <circle
                cx="39"
                cy="39"
                r={radius}
                fill="none"
                stroke="rgba(255, 255, 255, 0.08)"
                strokeWidth="4"
              />
              <circle
                cx="39"
                cy="39"
                r={radius}
                fill="none"
                stroke={active >= limit ? "#f59e0b" : "#3b82f6"}
                strokeWidth="4"
                strokeDasharray={circumference}
                strokeDashoffset={strokeOffset}
                strokeLinecap="round"
                transform="rotate(-90 39 39)"
                style={{ transition: "stroke-dashoffset 0.35s ease" }}
              />
            </svg>
            <div className="float-ball-inner-circle">
              <span className="float-ball-val-concurrency">
                <Zap size={11} /> {active}/{limit}
              </span>
              <span className="float-ball-val-cache">
                {hitRate}%
              </span>
              <span className="float-ball-label-sub">
                {active > 0 ? "运行中" : "待命"}
              </span>
            </div>
          </>
        ) : (
          <div className="float-ball-inner-square">
            <div className="float-square-row">
              <span style={{ color: "#94a3b8", display: "flex", alignItems: "center", gap: 3 }}>
                <Zap size={11} color="#60a5fa" /> 并发
              </span>
              <strong style={{ color: "#93c5fd" }}>{active}/{limit}</strong>
            </div>
            <div className="float-square-row">
              <span style={{ color: "#94a3b8", display: "flex", alignItems: "center", gap: 3 }}>
                <Database size={11} color="#34d399" /> 命中
              </span>
              <strong style={{ color: "#34d399" }}>{hitRate}%</strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
export default FloatBall;
