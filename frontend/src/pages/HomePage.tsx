import { useNavigate } from "react-router-dom";

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: "32px",
        padding: "24px",
        paddingTop: "calc(24px + env(safe-area-inset-top, 0px))",
      }}
    >
      <img
        src="/logo.png"
        alt="方舟剧场"
        style={{
          width: "128px",
          height: "128px",
          filter: "drop-shadow(0 8px 24px rgba(0, 0, 0, 0.5))",
        }}
      />
      <h1
        style={{
          fontSize: "36px",
          color: "var(--accent)",
          fontWeight: "bold",
          textAlign: "center",
        }}
      >
        方舟剧场
      </h1>
      <p
        style={{
          color: "var(--text-secondary)",
          fontSize: "16px",
          textAlign: "center",
          maxWidth: "500px",
          lineHeight: "1.6",
        }}
      >
        明日方舟剧情 · 离线演出回放
        <br />
        从 PRTS Wiki 获取全部游戏内剧情，支持本地缓存
      </p>

      <div style={{ display: "flex", gap: "16px" }}>
        <button className="btn-primary" onClick={() => navigate("/browse")}>
          浏览剧情
        </button>
        <button className="nav-btn" onClick={() => navigate("/settings")}>
          设置
        </button>
      </div>
    </div>
  );
}
