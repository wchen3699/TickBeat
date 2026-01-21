import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export default function Stock() {
  const { code } = useParams();
  const [name, setName] = useState("");
  const [file, setFile] = useState(null);

  // 后端返回：{ lastDate, close, pivot, range }
  const [levels, setLevels] = useState(null);
  const [msg, setMsg] = useState("");

  // 盯盘输入
  const [currentPrice, setCurrentPrice] = useState("");

  // A计划：每天最大做T次数（少而精）
  const [maxTTrades, setMaxTTrades] = useState(2);

  // C复盘：今日记录（本地保存）
  const reviewKey = useMemo(() => `sa_review_${code}_${todayStr()}`, [code]);
  const [review, setReview] = useState(() => {
    try {
      const raw = localStorage.getItem(reviewKey);
      return raw
        ? JSON.parse(raw)
        : {
            date: todayStr(),
            tradedOnlyWhenBias: true, // 只在偏强/偏弱出手
            respectedRange: true, // 没有超过T0_max去硬做
            avoidedNeutral: true, // 中性区间忍住
            tCount: 0, // 今日做T次数
            pnl: 0, // 今日收益（元或%）
            note: "",
          };
    } catch {
      return {
        date: todayStr(),
        tradedOnlyWhenBias: true,
        respectedRange: true,
        avoidedNeutral: true,
        tCount: 0,
        pnl: 0,
        note: "",
      };
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(reviewKey, JSON.stringify(review));
    } catch {}
  }, [reviewKey, review]);

  useEffect(() => {
    fetch("http://localhost:8787/api/watchlist")
      .then((r) => r.json())
      .then((list) => {
        const hit = list.find((x) => x.code === code);
        setName(hit ? hit.name : "");
      })
      .catch(() => setName(""));
  }, [code]);

  async function uploadCsv() {
    if (!file) {
      setMsg("请先选择一个 CSV 文件");
      return;
    }

    setMsg("正在上传并计算...");
    setLevels(null);

    const fd = new FormData();
    fd.append("file", file);

    try {
      const r = await fetch(`http://localhost:8787/api/upload/${code}`, {
        method: "POST",
        body: fd,
      });
      const j = await r.json();

      if (!r.ok || !j.ok) {
        setMsg("计算失败：" + (j.error || r.statusText));
        return;
      }

      setLevels({
        lastDate: j.lastDate,
        close: j.levels.close,
        pivot: j.levels.pivot,
        range: j.levels.range,
      });

      setMsg("✅ 计算成功");
    } catch (e) {
      setMsg("计算失败：" + String(e));
    }
  }

  // --- 关键阈值（全部基于 yesterday range 自适应）---
  const t0 = useMemo(() => {
    if (!levels) return null;
    const range = Number(levels.range);
    return {
      min: Number((range * 0.25).toFixed(3)), // 最小可做波段
      good: Number((range * 0.4).toFixed(3)), // 主要目标波段
      max: Number((range * 0.6).toFixed(3)), // 当天上限（过度波动禁止）
    };
  }, [levels]);

  // buffer：过滤pivot附近噪音（range自适应）
  const bias = useMemo(() => {
    if (!levels || !t0) return null;

    const pivot = Number(levels.pivot);
    const price = Number(currentPrice);
    const buffer = Number((t0.min * 0.25).toFixed(3)); // = 0.0625 * range

    if (!Number.isFinite(price)) {
      return { status: "未输入当前价", mode: "none", buffer, pivot };
    }
    if (price >= pivot + buffer) return { status: "偏强（站稳）", mode: "strong", buffer, pivot };
    if (price <= pivot - buffer) return { status: "偏弱（跌破）", mode: "weak", buffer, pivot };
    return { status: "中性（震荡）", mode: "neutral", buffer, pivot };
  }, [levels, t0, currentPrice]);

  // --- 做T区间映射（以 pivot 为锚）---
  const tPlan = useMemo(() => {
    if (!levels || !t0 || !bias) return null;

    const pivot = Number(levels.pivot);
    const good = Number(t0.good);

    // 偏强：对称，执行简单
    const strongBuyL = Number((pivot - 0.5 * good).toFixed(3));
    const strongBuyH = Number(pivot.toFixed(3));
    const strongSellL = Number(pivot.toFixed(3));
    const strongSellH = Number((pivot + 0.5 * good).toFixed(3));

    // 偏弱：缩小目标，提升胜率
    const weakSellL = Number(pivot.toFixed(3));
    const weakSellH = Number((pivot + 0.35 * good).toFixed(3));
    const weakBuyL = Number((pivot - 0.35 * good).toFixed(3));
    const weakBuyH = Number(pivot.toFixed(3));

    const neutralL = Number((pivot - bias.buffer).toFixed(3));
    const neutralH = Number((pivot + bias.buffer).toFixed(3));

    const strongTrigger = Number((pivot + bias.buffer).toFixed(3));
    const weakTrigger = Number((pivot - bias.buffer).toFixed(3));

    return {
      pivot,
      buffer: bias.buffer,
      good,
      max: Number(t0.max),
      // 强
      strongTrigger,
      strongBuyL,
      strongBuyH,
      strongSellL,
      strongSellH,
      // 弱
      weakTrigger,
      weakSellL,
      weakSellH,
      weakBuyL,
      weakBuyH,
      // 中性
      neutralL,
      neutralH,
    };
  }, [levels, t0, bias]);

  // --- 红绿灯硬规则 + 详细提示（B 盯盘型核心）---
  const bSignal = useMemo(() => {
    if (!levels || !tPlan || !bias) return null;

    const price = Number(currentPrice);
    if (!Number.isFinite(price)) {
      return {
        light: "grey",
        title: "请输入当前价",
        line: "输入一个价格后，我会给出 🟢可执行 / 🟡等待 / 🔴禁止。",
        reason: [],
      };
    }

    // 🔴 规则 1：封手（次数用完）
    if (Number(review.tCount || 0) >= Number(maxTTrades || 0)) {
      return {
        light: "red",
        title: "🔴 禁止：今日已封手",
        line: `已做T ${review.tCount} 次 ≥ 上限 ${maxTTrades} 次。今天不再做，避免情绪交易。`,
        reason: ["已用完今日做T次数"],
      };
    }

    // 🔴 规则 2：过度波动（超过T0_max）
    const dist = Math.abs(price - tPlan.pivot);
    if (dist > tPlan.max) {
      return {
        light: "red",
        title: "🔴 禁止：过度波动",
        line: `|当前价 - pivot| = ${dist.toFixed(3)} > T0_max=${tPlan.max}。这通常是“后半段波动”，成功率下降，建议停止。`,
        reason: ["已超出 T0_max（过度波动）"],
      };
    }

    // 🔴 规则 3：中性区间
    if (bias.mode === "neutral") {
      return {
        light: "red",
        title: "🔴 禁止：中性区间不做",
        line: `当前在 pivot±buffer（${tPlan.neutralL}～${tPlan.neutralH}）内，最容易来回打脸。等突破≥${tPlan.strongTrigger} 或 跌破≤${tPlan.weakTrigger} 再做。`,
        reason: ["中性区间（pivot附近噪音）"],
      };
    }

    // 🟢/🟡：偏强/偏弱模式
    if (bias.mode === "strong") {
      // 可执行：进入回踩买入区
      if (price >= tPlan.strongBuyL && price <= tPlan.strongBuyH) {
        return {
          light: "green",
          title: "🟢 可执行：偏强回踩买",
          line: `回踩买入区 ${tPlan.strongBuyL}～${tPlan.strongBuyH}；目标卖出区 ${tPlan.strongSellL}～${tPlan.strongSellH}（目标价差≈${tPlan.good}）。`,
          reason: ["偏强站稳 + 回踩到买入区"],
        };
      }
      // 等待：偏强但未回踩到位
      return {
        light: "yellow",
        title: "🟡 等待：偏强但未到买点",
        line: `已偏强（≥${tPlan.strongTrigger}），等待回踩到 ${tPlan.strongBuyL}～${tPlan.strongBuyH} 再动手，别追价。`,
        reason: ["偏强成立，但未进入买入区"],
      };
    }

    if (bias.mode === "weak") {
      // 可执行：进入反弹卖出区
      if (price >= tPlan.weakSellL && price <= tPlan.weakSellH) {
        return {
          light: "green",
          title: "🟢 可执行：偏弱反弹卖",
          line: `反弹卖出区 ${tPlan.weakSellL}～${tPlan.weakSellH}；目标买回区 ${tPlan.weakBuyL}～${tPlan.weakBuyH}（目标价差≈${Number((0.7 * tPlan.good).toFixed(3))}）。`,
          reason: ["偏弱跌破 + 反弹到卖出区"],
        };
      }
      // 等待：偏弱但未反弹到位
      return {
        light: "yellow",
        title: "🟡 等待：偏弱但未到卖点",
        line: `已偏弱（≤${tPlan.weakTrigger}），等待反弹到 ${tPlan.weakSellL}～${tPlan.weakSellH} 再卖，别在低位乱砍。`,
        reason: ["偏弱成立，但未进入卖出区"],
      };
    }

    return { light: "grey", title: "—", line: "", reason: [] };
  }, [levels, tPlan, bias, currentPrice, review.tCount, maxTTrades]);

  // --- A 计划卡（强/弱/禁止 + 次数上限 + 过度波动提醒）---
  const planCard = useMemo(() => {
    if (!levels || !tPlan || !t0) return null;

    const overWarn =
      `纪律：以 T0_good=${tPlan.good} 为目标；若今天频繁需要 >T0_max=${tPlan.max} 才能成交，视为“过度波动/情绪交易”，建议停止。`;

    const txt =
`【炒股小助手｜A 盘前计划卡】
标的：${code} ${name || ""}
最近交易日：${levels.lastDate}
关键：close=${levels.close}｜pivot=${tPlan.pivot}｜range=${levels.range}
阈值：T0_good=${tPlan.good}｜T0_max=${tPlan.max}｜buffer=${tPlan.buffer}
今日最多做T次数：${maxTTrades} 次（少而精）

【偏强模式】触发：当前价 ≥ ${tPlan.strongTrigger}
- 只做：回踩买入 → 反弹卖出
- 回踩买入区：${tPlan.strongBuyL} ～ ${tPlan.strongBuyH}
- 目标卖出区：${tPlan.strongSellL} ～ ${tPlan.strongSellH}
- 目标价差≈${tPlan.good}

【偏弱模式】触发：当前价 ≤ ${tPlan.weakTrigger}
- 只做：反弹卖出 → 回落买回
- 反弹卖出区：${tPlan.weakSellL} ～ ${tPlan.weakSellH}
- 目标买回区：${tPlan.weakBuyL} ～ ${tPlan.weakBuyH}
- 目标价差≈${Number((0.7 * tPlan.good).toFixed(3))}

【禁止硬做】中性区间：${tPlan.neutralL} ～ ${tPlan.neutralH}
- 在中性里不做，等触发偏强/偏弱再执行

${overWarn}`;

    return { txt };
  }, [levels, tPlan, t0, code, name, maxTTrades]);

  // --- C 复盘：纪律分（只看执行，不看预测）---
  const disciplineScore = useMemo(() => {
    let s = 0;
    s += review.tradedOnlyWhenBias ? 34 : 0;
    s += review.respectedRange ? 33 : 0;
    s += review.avoidedNeutral ? 33 : 0;

    const over = Math.max(0, Number(review.tCount || 0) - Number(maxTTrades || 0));
    s -= over * 5;

    return clamp(Math.round(s), 0, 100);
  }, [review, maxTTrades]);

  const scoreLabel =
    disciplineScore >= 85 ? "优秀（可复制）" : disciplineScore >= 70 ? "合格（继续收敛）" : "偏差（需减频/减冲动）";

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 960, margin: "0 auto" }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/">← 返回</Link>
      </div>

      <h1 style={{ marginTop: 0 }}>个股详情</h1>

      <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 800 }}>股票代码：{code}</div>
        <div style={{ color: "#666", marginTop: 6 }}>股票名称：{name || "未知"}</div>
      </div>

      <hr style={{ margin: "20px 0" }} />

      <h2 style={{ margin: "0 0 10px" }}>导入日线 CSV</h2>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <button onClick={uploadCsv} style={{ padding: "8px 12px", cursor: "pointer" }}>
          上传并计算
        </button>
        <div style={{ color: msg.includes("✅") ? "green" : msg.includes("失败") ? "red" : "#666" }}>{msg}</div>
      </div>

      <div style={{ marginTop: 14, fontSize: 12, color: "#999" }}>
        CSV 列名：date,open,high,low,close,volume（我们目前使用最后一行作为“最近交易日”）。
      </div>

      {levels && t0 && bias && tPlan && (
        <>
          <hr style={{ margin: "20px 0" }} />

          <div style={{ display: "grid", gap: 12 }}>
            {/* A 计划型 */}
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 900 }}>A 计划型（盘前计划卡）</div>

              <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ color: "#666" }}>今日最多做T次数：</div>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={maxTTrades}
                  onChange={(e) => setMaxTTrades(Number(e.target.value || 0))}
                  style={{ width: 80, padding: 6, borderRadius: 8, border: "1px solid #ccc" }}
                />
                <div style={{ fontSize: 12, color: "#999" }}>建议 1–2（少而精；次数越多越容易情绪化）</div>
              </div>

              <textarea
                readOnly
                value={planCard?.txt || ""}
                rows={16}
                style={{
                  width: "100%",
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 10,
                  border: "1px solid #ccc",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontSize: 12,
                }}
              />

              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(planCard?.txt || "");
                    alert("已复制到剪贴板 ✅");
                  } catch {
                    alert("复制失败，请手动全选复制。");
                  }
                }}
                style={{ marginTop: 10, padding: "8px 12px", cursor: "pointer" }}
              >
                一键复制计划卡
              </button>
            </div>

            {/* 关键价位 */}
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 900 }}>关键价位（基准）</div>
              <div style={{ marginTop: 8, color: "#666" }}>
                最近交易日：{levels.lastDate} ｜ close={levels.close} ｜ pivot={levels.pivot} ｜ range={levels.range}
              </div>
              <div style={{ marginTop: 8, color: "#666" }}>
                T0_min={t0.min} ｜ T0_good={t0.good} ｜ T0_max={t0.max} ｜ buffer={bias.buffer}
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>
                解释：全部用昨日 range 自适应，避免今天凭感觉乱设目标。
              </div>
            </div>

            {/* B 盯盘型（红绿灯硬规则 + 丰富信息） */}
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 900 }}>B 盯盘型（红绿灯 + 硬规则）</div>

              <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ color: "#666" }}>当前价：</div>
                <input
                  value={currentPrice}
                  onChange={(e) => setCurrentPrice(e.target.value)}
                  placeholder="例如 10.52"
                  style={{ padding: "8px 10px", border: "1px solid #ccc", borderRadius: 8, width: 140 }}
                />
                <div style={{ color: "#666" }}>判定：{bias.status}</div>
                <div style={{ color: "#666" }}>
                  已做T：{review.tCount} / {maxTTrades}
                </div>
              </div>

              {bSignal && (
                <div
                  style={{
                    marginTop: 12,
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid #eee",
                    background:
                      bSignal.light === "green"
                        ? "#f3fff3"
                        : bSignal.light === "yellow"
                        ? "#fffdf0"
                        : bSignal.light === "red"
                        ? "#fff3f3"
                        : "#f7f7f7",
                  }}
                >
                  <div style={{ fontWeight: 900 }}>
                    {bSignal.light === "green"
                      ? "🟢 "
                      : bSignal.light === "yellow"
                      ? "🟡 "
                      : bSignal.light === "red"
                      ? "🔴 "
                      : "⚪️ "}
                    {bSignal.title}
                  </div>

                  <div style={{ marginTop: 6, color: "#555" }}>{bSignal.line}</div>

                  {bSignal.reason?.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>
                      原因：{bSignal.reason.join("；")}
                    </div>
                  )}

                  <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button
                      onClick={() =>
                        setReview((r) => ({
                          ...r,
                          tCount: Number(r.tCount || 0) + 1,
                        }))
                      }
                      style={{ padding: "8px 12px", cursor: "pointer" }}
                    >
                      完成一次T（+1）
                    </button>

                    <button
                      onClick={() =>
                        setReview((r) => ({
                          ...r,
                          tCount: Math.max(0, Number(r.tCount || 0) - 1),
                        }))
                      }
                      style={{ padding: "8px 12px", cursor: "pointer" }}
                    >
                      误点撤销（-1）
                    </button>

                    <button
                      onClick={() => setCurrentPrice("")}
                      style={{ padding: "8px 12px", cursor: "pointer" }}
                    >
                      清空当前价
                    </button>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10, fontSize: 12, color: "#999" }}>
                用法：只在 🟢 执行；🟡 等待；🔴 直接停止（中性/过度波动/封手）。
              </div>
            </div>

            {/* C 复盘型 */}
            <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 900 }}>C 复盘型（收盘 1 分钟搞定）</div>

              <div style={{ marginTop: 8, color: "#666" }}>
                今日纪律分：<b>{disciplineScore}</b> / 100（{scoreLabel}）
              </div>

              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={!!review.tradedOnlyWhenBias}
                    onChange={(e) => setReview((r) => ({ ...r, tradedOnlyWhenBias: e.target.checked }))}
                  />
                  只在偏强/偏弱时出手（不中性区间硬做）
                </label>

                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={!!review.respectedRange}
                    onChange={(e) => setReview((r) => ({ ...r, respectedRange: e.target.checked }))}
                  />
                  没有为了成交强行追到超过 T0_max（不过度波动硬做）
                </label>

                <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={!!review.avoidedNeutral}
                    onChange={(e) => setReview((r) => ({ ...r, avoidedNeutral: e.target.checked }))}
                  />
                  中性区间忍住了（等待触发再执行）
                </label>

                <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                  <div style={{ color: "#666" }}>今日做T次数：</div>
                  <input
                    type="number"
                    min={0}
                    max={50}
                    value={review.tCount}
                    onChange={(e) => setReview((r) => ({ ...r, tCount: Number(e.target.value || 0) }))}
                    style={{ width: 90, padding: 6, borderRadius: 8, border: "1px solid #ccc" }}
                  />

                  <div style={{ color: "#666" }}>今日收益（元或%自定口径）：</div>
                  <input
                    type="number"
                    value={review.pnl}
                    onChange={(e) => setReview((r) => ({ ...r, pnl: Number(e.target.value || 0) }))}
                    style={{ width: 110, padding: 6, borderRadius: 8, border: "1px solid #ccc" }}
                  />
                </div>

                <div>
                  <div style={{ color: "#666", marginBottom: 6 }}>一句话备注（可空）：</div>
                  <input
                    value={review.note}
                    onChange={(e) => setReview((r) => ({ ...r, note: e.target.value }))}
                    placeholder="例如：两次都在中性硬做，亏损来自冲动"
                    style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ccc" }}
                  />
                </div>

                <div style={{ fontSize: 12, color: "#999" }}>
                  说明：复盘数据只保存在你电脑浏览器本地（localStorage），不上传任何服务器。
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
