import express from "express";
import cors from "cors";
import multer from "multer";

function parseCsv(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, i) => {
      row[h.trim()] = cols[i];
    });
    return row;
  });
}


const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// 临时自选股列表（下一步会接数据库）
const watchlist = [
  { code: "600519", name: "贵州茅台" },
  { code: "000001", name: "平安银行" }
];

app.get("/api/watchlist", (_req, res) => {
  res.json(watchlist);
});

app.post("/api/upload/:code", upload.single("file"), (req, res) => {
  const { code } = req.params;
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "no file" });
  }

  const text = req.file.buffer.toString("utf-8");
  const rows = parseCsv(text);

  if (rows.length === 0) {
    return res.status(400).json({ ok: false, error: "empty csv" });
  }

  // 取最近一天（日线最后一行）
  const last = rows[rows.length - 1];

  const H = Number(last.high);
  const L = Number(last.low);
  const C = Number(last.close);

  if (![H, L, C].every((v) => Number.isFinite(v))) {
    return res.status(400).json({ ok: false, error: "invalid price data" });
  }

  const pivot = (H + L + C) / 3;
  const range = H - L;

  res.json({
    ok: true,
    code,
    lastDate: last.date,
    levels: {
      close: C,
      pivot: Number(pivot.toFixed(3)),
      range: Number(range.toFixed(3)),
    },
  });
});



const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
