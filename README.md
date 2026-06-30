# A股实时行情 MCP Server

通过新浪财经 / 腾讯财经公开行情接口，为 Claude 提供 A 股实时行情和历史K线查询能力。
部署在 Cloudflare Workers（免费）上，代码托管在 GitHub。

## 功能

- `get_realtime_quote`：查询一只或多只股票的最新价/收盘价、开高低、成交量额、涨跌幅
- `get_history_kline`：查询单只股票指定日期区间的历史日K线（开盘/收盘/最高/最低/成交量）

## 部署步骤

### 1. 准备账号
- 注册 [GitHub](https://github.com)（已有可跳过）
- 注册 [Cloudflare](https://dash.cloudflare.com/sign-up)（免费）

### 2. 上传代码到 GitHub
1. 在 GitHub 新建一个仓库，例如命名为 `stock-mcp-server`
2. 把本项目文件夹（`stock-mcp-server/`）里的所有文件上传到该仓库
   - 可以直接在 GitHub 网页用 "Add file → Upload files" 拖拽上传
   - 或用 git 命令行：
     ```bash
     git init
     git add .
     git commit -m "init"
     git remote add origin https://github.com/你的用户名/stock-mcp-server.git
     git push -u origin main
     ```

### 3. 连接 Cloudflare 部署（推荐：网页一键集成，无需命令行）
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单选择 **Workers & Pages** → **创建** → **Workers**
3. 选择 **连接到 Git（Connect to Git）**
4. 授权并选择你刚创建的 GitHub 仓库 `stock-mcp-server`
5. 部署配置保持默认（Cloudflare 会自动识别 `wrangler.toml`），点击 **保存并部署**
6. 部署完成后，Cloudflare 会给你一个网址，形如：
   ```
   https://a-share-stock-quote.你的子域名.workers.dev
   ```

之后每次你在 GitHub 更新代码，Cloudflare 会自动重新部署，无需手动操作。

### 4. 验证部署是否成功
浏览器直接打开（替换成你自己的网址）：
```
https://a-share-stock-quote.你的子域名.workers.dev/quote?codes=300346,002428
```
如果返回类似下面的 JSON，说明部署成功：
```json
[
  {"code":"sz300346","name":"南大光电","price":71.43, ...},
  {"code":"sz002428","name":"云南锗业","price":124.0, ...}
]
```

### 5. 把这个 MCP Server 接入 Claude
把部署好的网址（注意路径是 `/mcp`，不是 `/quote`）告诉 Claude 或在 claude.ai 的 Connector 设置里添加：
```
https://a-share-stock-quote.你的子域名.workers.dev/mcp
```
具体添加方式：claude.ai 设置 → Connectors → 添加自定义连接器 → 填入上面的 URL。

## 本地命令行部署（可选，给熟悉命令行的用户）

```bash
npm install
npx wrangler login      # 浏览器授权登录 Cloudflare
npx wrangler deploy     # 部署
```

## 调试接口（不经过MCP，直接用浏览器/curl测试）

- 实时行情：`GET /quote?codes=300346,002428`
- 历史K线：`GET /history?code=300346&start=2026-06-01&end=2026-06-29`

## 数据来源说明

- 实时行情：新浪财经公开接口 `hq.sinajs.cn`
- 历史K线：腾讯财经公开接口 `web.ifzq.gtimg.cn`

均为公开免登录接口，仅供个人学习研究使用，请勿用于高频请求或商业用途。
