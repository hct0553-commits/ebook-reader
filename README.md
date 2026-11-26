# 重點閱讀 Reader

一個「一套程式、所有裝置通用」的電子書閱讀器（PWA 網頁 App），可安裝到 iPhone、Android、Windows 的主畫面／開始選單。

**線上網址：https://hct0553-commits.github.io/ebook-reader/**

- **格式**：EPUB、PDF、MOBI、AZW3、TXT（自動判斷 UTF-8／Big5／GBK）、DOCX、FB2、CBZ
- **標示重點**：選取文字 → 點顏色（黃／綠／藍／粉紅），可加筆記；點既有重點可改色、改筆記、刪除
- **一鍵匯出重點**：Word（.docx）、PDF、Markdown、複製全文、存成 Google 文件
- **Google Drive 同步**：書檔、閱讀進度、所有重點自動同步到你 Drive 的 `EbookReader` 資料夾
- **離線可讀**：安裝後即使沒有網路也能看已下載的書

> 和 FBReader 的差別：FBReader 無法把重點輸出；這個 App 在書庫每本書的「⋯」選單、或閱讀時右上角的 🖍「閱讀重點」面板，按「一鍵匯出」即可輸出 Word / PDF。

---

## 一、先在電腦上試用（5 分鐘）

需要先安裝 [Node.js](https://nodejs.org/)（你的電腦已安裝）。

```powershell
cd "D:\ClaudeCode練習\ebook-reader"
node tools/serve.mjs
```

然後用 Chrome 或 Edge 開 http://localhost:8080 。`samples` 資料夾裡有 4 個測試檔可以拖進去試。

> 本機模式只有這台電腦能用。要讓手機也能用，請完成下面的「二、放上網路」。

---

## 二、放上網路（免費，讓 iPhone / Android 也能用）

App 必須放在 **https** 網址上，手機才能安裝、Google 才允許登入。擇一即可：

### 方法 A：Netlify Drop（最簡單，不用帳號設定）
1. 開 https://app.netlify.com/drop
2. 把整個 `ebook-reader` 資料夾拖進網頁
3. 會得到一個網址，例如 `https://xxxx-xxxx.netlify.app`（可在 Netlify 免費註冊後改成好記的名字，並讓網址永久保留）

### 方法 B：GitHub Pages（目前使用的方式）
已部署在 https://hct0553-commits.github.io/ebook-reader/ （儲存庫：https://github.com/hct0553-commits/ebook-reader ）。

之後修改程式要更新網站：
```powershell
cd "D:\ClaudeCode練習\ebook-reader"
git add -A
git commit -m "更新"
git push
```
約 1 分鐘後網站就會更新（App 下次開啟時自動載入新版）。

---

## 三、設定 Google Drive 同步（一次性，約 5–10 分鐘）

Google 規定每個 App 都要有自己的「OAuth 用戶端 ID」，這個步驟只需做一次。

1. 開 https://console.cloud.google.com/ ，用你的 Google 帳號登入
2. 上方「選取專案」→「新增專案」，名稱隨意（例如 `ebook-reader`）→ 建立
3. 左側選單「API 和服務」→「程式庫」→ 搜尋 **Google Drive API** → 啟用
4. 「API 和服務」→「OAuth 同意畫面」（或「Google Auth Platform」）
   - 使用者類型選「**外部**」，填 App 名稱、你的 Email
   - 「目標對象 / 測試使用者」加入**你自己的 Gmail**
   - 範圍（Scopes）可以不填（App 只用 `drive.file`，非敏感權限）
5. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」
   - 應用程式類型：**網頁應用程式**
   - 「已授權的 JavaScript 來源」加入：
     - **`https://hct0553-commits.github.io`**（只要網域，不含 `/ebook-reader/` 路徑）
     - （選填，本機測試用）`http://localhost:8080`
   - 建立後複製「用戶端 ID」（長得像 `1234-abcd.apps.googleusercontent.com`）
6. 打開 App → 右上角 ⚙️ 設定 → 貼上用戶端 ID → 「連結 Google Drive」→ 登入並允許

在其他裝置上：打開同一個網址 → ⚙️ 貼上同一個用戶端 ID → 連結 → 書庫就會出現雲端上的書（標示「雲端」，點開時自動下載）。

> 也可以把用戶端 ID 直接寫進 `js/config.js` 的 `GOOGLE_CLIENT_ID` 再上傳，這樣每台裝置就不用再貼。
>
> **權限說明**：App 只使用 `drive.file` 權限，只能存取「它自己建立的檔案」，看不到你 Drive 裡其他任何檔案。
>
> 若同意畫面維持「測試中」狀態，Google 有時會要求每 7 天重新登入一次，屬正常現象。

---

## 四、安裝到各裝置

| 裝置 | 安裝方式 |
|---|---|
| **iPhone 14** | 用 **Safari** 開網址 → 下方「分享」按鈕 → 「加入主畫面」 |
| **Android** | 用 **Chrome** 開網址 → 右上「⋮」→「安裝應用程式」（或「加到主畫面」） |
| **Windows** | 用 **Edge / Chrome** 開網址 → 網址列右側的「安裝」圖示 |

---

## 五、使用方式

- **匯入書**：書庫右下角「＋」（電腦可直接把檔案拖進視窗）。匯入後若已連結 Drive，會自動上傳。
- **標示重點**：選取文字 → 工具列點顏色。「筆記」可同時加上想法，「複製」只複製不標示。
- **修改重點**：點書中已標示的文字 → 改顏色／筆記／刪除。
- **看全部重點**：閱讀畫面右上角 🖍 → 點任一則可跳回原文位置。
- **一鍵匯出**：🖍 面板上方「一鍵匯出」，或書庫中書本右下「⋯」→「一鍵匯出閱讀重點」
  - **Word（.docx）**：電腦直接下載；手機會跳出分享面板，可存到「檔案」、傳 LINE、存 Google Drive
  - **PDF**：開啟列印畫面 → 目的地選「另存為 PDF」。iPhone 上在列印預覽畫面用兩指放大 → 分享 → 儲存到檔案
  - **Markdown**：適合貼到 Notion / Obsidian
  - **Google 文件**：直接在 Drive 的 `EbookReader` 資料夾建立一份可編輯的 Google 文件
- **同步**：自動進行（編輯後幾秒、切換 App 時）。右上雲朵：綠點＝已同步、黃點＝同步中、紅點＝需重新登入（點一下即可）。

---

## 六、已知限制

- **有 DRM 加密的書無法開啟**（例如從 Kindle 商店買的 AZW、Readmoo／Kobo 的加密 EPUB），這是所有第三方閱讀器的共同限制。
- 舊版 Word 的 **.doc** 不支援，請先另存成 .docx。
- 掃描版 PDF（只有圖片、沒有文字層）無法選取文字標示重點。
- FBReader 內既有的重點無法自動匯入。
- 重點以「章節內文字位置」定位；若同一本書換成不同版本的檔案，會被視為另一本書。

---

## 檔案結構

```
index.html              主頁面
css/app.css             樣式（含列印成 PDF 的版面）
js/app.js               主程式：書庫、閱讀器、重點工具列、匯出、同步流程
js/formats.js           各格式解析（EPUB/MOBI 用 foliate-js、PDF 用 pdf.js、DOCX 用 mammoth）
js/reader.js            閱讀畫面（文字流 / PDF 頁面）
js/highlights.js        重點定位與標示
js/export.js            匯出 Word / PDF / Markdown / Google 文件
js/drive.js             Google Drive 登入、上傳下載、雙向合併
js/db.js                本機 IndexedDB
js/zip.js               產生 .docx 用的 ZIP 寫入器
js/config.js            Google 用戶端 ID 設定
sw.js                   離線快取
vendor/                 第三方函式庫（foliate-js: MIT、pdf.js: Apache-2.0、mammoth: BSD-2）
tools/serve.mjs         本機測試伺服器
samples/                測試用電子書
```
