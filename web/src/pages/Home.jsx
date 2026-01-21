import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

export default function Home() {
  const [health, setHealth] = useState(null);
  const [watchlist, setWatchlist] = useState([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("http://localhost:8787/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setErr("health: " + String(e)));

    fetch("http://localhost:8787/api/watchlist")
      .then((r) => r.json())
      .then(setWatchlist)
      .catch((e) => setErr("watchlist: " + String(e)));
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 860, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>炒股小助手</h1>

      <div style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 700 }}>后端连接测试</div>

        {!health && !err && <div>正在连接后端...</div>}

        {health && (
          <div style={{ color: "green" }}>
            ✅ 后端连接成功：ok={String(health.ok)} ts={health.ts}
          </div>
        )}

        {err && <div style={{ color: "red" }}>❌ 后端连接失败：{err}</div>}
      </div>

      <hr style={{ margin: "24px 0" }} />

      <div>
        <h2 style={{ margin: "0 0 12px" }}>我的自选股（点击进入详情）</h2>

        {watchlist.length === 0 ? (
          <div style={{ color: "#666" }}>暂无自选股</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {watchlist.map((it) => (
              <Link
                key={it.code}
                to={`/stock/${it.code}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: 12,
                    padding: 12,
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    cursor: "pointer",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>{it.code}</div>
                    <div style={{ color: "#666", marginTop: 4 }}>{it.name}</div>
                  </div>

                  <div style={{ color: "#999", fontSize: 12 }}>点击进入 →</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
