# ✈ CheapFly — 最便宜機票查詢網站

同步比較 **Skyscanner**（RapidAPI）和 **Google Flights**（SerpApi）的機票價格，並記錄歷史最低票價。

## 功能

- 🔍 機場即時搜尋（輸入城市名或 IATA 代碼）
- 💰 同步查詢 Skyscanner & Google Flights 最低票價
- 📊 歷史最低票價圖表（自動記錄每次查詢）
- ⭐ 標示歷史最低價航班
- 🔄 單程 / 來回切換
- 📱 響應式設計（手機友好）

## 安裝

```bash
git clone https://github.com/joshlin55688/cheap-flight-finder.git
cd cheap-flight-finder
npm install
```

## 設定 API Keys

```bash
cp .env.example .env
```

編輯 `.env`：

```env
RAPIDAPI_KEY=你的_RapidAPI_Key     # https://rapidapi.com/apiheya/api/sky-scrapper
SERPAPI_KEY=你的_SerpApi_Key       # https://serpapi.com/
PORT=3000
```

> **注意**：未設定 API Key 時會自動使用模擬資料，方便開發測試。

## 啟動

```bash
# 正式模式
npm start

# 開發模式（自動重啟）
npm run dev
```

開啟瀏覽器：[http://localhost:3000](http://localhost:3000)

## 取得 API Keys

### Skyscanner（Sky-Scrapper / RapidAPI）
1. 前往 [RapidAPI - Sky-Scrapper](https://rapidapi.com/apiheya/api/sky-scrapper)
2. 訂閱免費方案（每月 50 次請求）
3. 複製 `X-RapidAPI-Key` 填入 `.env`

### Google Flights（SerpApi）
1. 前往 [SerpApi](https://serpapi.com/)
2. 註冊取得免費 API Key（每月 100 次）
3. 複製 Key 填入 `.env`

## 技術架構

| 層級 | 技術 |
|------|------|
| 後端 | Node.js + Express |
| 前端 | HTML / CSS / Vanilla JS |
| 圖表 | Chart.js |
| 機票 API | Skyscanner (RapidAPI) + Google Flights (SerpApi) |
| 歷史資料 | JSON 檔案（price_history.json） |

## 部署

可直接部署至 Railway、Render、或 Fly.io。記得在平台設定環境變數。
