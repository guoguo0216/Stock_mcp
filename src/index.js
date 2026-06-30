/**
 * A股实时行情 MCP Server
 * 部署在 Cloudflare Workers 上
 * 通过新浪财经公开行情接口获取A股实时/历史数据
 */

// ---------- 工具函数：股票代码标准化 ----------
function normalizeCode(code) {
  code = code.trim().toLowerCase();
  // 已经带前缀 sz/sh/bj
  if (/^(sz|sh|bj)\d{6}$/.test(code)) return code;
  // 纯数字，按规则推断交易所
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6')) return 'sh' + code;
    if (code.startsWith('0') || code.startsWith('3')) return 'sz' + code;
    if (code.startsWith('8') || code.startsWith('4')) return 'bj' + code;
  }
  throw new Error(`无法识别的股票代码: ${code}`);
}

// ---------- 新浪实时行情 ----------
async function fetchSinaRealtime(codes) {
  const list = codes.map(normalizeCode).join(',');
  const url = `https://hq.sinajs.cn/list=${list}`;
  const resp = await fetch(url, {
    headers: {
      'Referer': 'https://finance.sina.com.cn',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const buf = await resp.arrayBuffer();
  // 新浪接口返回 GBK 编码，需要转换
  const text = new TextDecoder('gbk').decode(buf);

  const lines = text.split('\n').filter(Boolean);
  const results = [];
  for (const line of lines) {
    // var hq_str_sz300346="南大光电,71.43,70.80,...";
    const m = line.match(/hq_str_(\w+)="([^"]*)"/);
    if (!m) continue;
    const code = m[1];
    const fields = m[2].split(',');
    if (fields.length < 32) continue;

    results.push({
      code,
      name: fields[0],
      open: parseFloat(fields[1]),
      prevClose: parseFloat(fields[2]),
      price: parseFloat(fields[3]),       // 当前价/最新价（收盘后即为收盘价）
      high: parseFloat(fields[4]),
      low: parseFloat(fields[5]),
      volume: parseInt(fields[8], 10),     // 成交量（股）
      amount: parseFloat(fields[9]),       // 成交额（元）
      date: fields[30],
      time: fields[31],
      changeAmount: +(parseFloat(fields[3]) - parseFloat(fields[2])).toFixed(2),
      changePercent: fields[2] && parseFloat(fields[2]) !== 0
        ? +(((parseFloat(fields[3]) - parseFloat(fields[2])) / parseFloat(fields[2])) * 100).toFixed(2)
        : null,
    });
  }
  return results;
}

// ---------- 腾讯历史K线（日线） ----------
async function fetchTencentHistory(code, startDate, endDate) {
  const normalized = normalizeCode(code);
  // 腾讯接口参数：股票代码,周期,起始日,结束日,数量,复权方式
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${normalized},day,${startDate},${endDate},640,qfq`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const data = await resp.json();
  const stockData = data?.data?.[normalized];
  const klineData = stockData?.qfqday || stockData?.day;
  if (!klineData) return [];

  return klineData.map((row) => ({
    date: row[0],
    open: parseFloat(row[1]),
    close: parseFloat(row[2]),
    high: parseFloat(row[3]),
    low: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));
}

// ---------- MCP 工具定义 ----------
const TOOLS = [
  {
    name: 'get_realtime_quote',
    description: '获取一个或多个A股股票的实时/最新行情（包括最新价、开盘价、最高最低价、成交量、成交额、涨跌幅）。交易时段内为实时价，收盘后为当日收盘价。',
    inputSchema: {
      type: 'object',
      properties: {
        codes: {
          type: 'array',
          items: { type: 'string' },
          description: '股票代码数组，支持纯数字（如["300346","002428"]）或带交易所前缀（如["sz300346","sh600000"]）',
        },
      },
      required: ['codes'],
    },
  },
  {
    name: 'get_history_kline',
    description: '获取单只A股股票的历史日K线数据（开盘价、收盘价、最高价、最低价、成交量）。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '股票代码，支持纯数字或带前缀',
        },
        start_date: {
          type: 'string',
          description: '起始日期，格式 YYYY-MM-DD',
        },
        end_date: {
          type: 'string',
          description: '结束日期，格式 YYYY-MM-DD',
        },
      },
      required: ['code', 'start_date', 'end_date'],
    },
  },
];

// ---------- MCP 协议处理 ----------
async function handleMcpRequest(body) {
  const { method, params, id } = body;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'a-share-stock-quote', version: '1.0.0' },
      },
    };
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      let resultData;
      if (name === 'get_realtime_quote') {
        resultData = await fetchSinaRealtime(args.codes);
      } else if (name === 'get_history_kline') {
        resultData = await fetchTencentHistory(args.code, args.start_date, args.end_date);
      } else {
        throw new Error(`未知工具: ${name}`);
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(resultData, null, 2) }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `错误: ${err.message}` }],
          isError: true,
        },
      };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
}

// ---------- Worker 入口 ----------
export default {
  async fetch(request) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);

    // 简单健康检查 / 调试用 REST 接口： /quote?codes=300346,002428
    if (url.pathname === '/quote' && request.method === 'GET') {
      const codesParam = url.searchParams.get('codes') || '';
      const codes = codesParam.split(',').filter(Boolean);
      if (codes.length === 0) {
        return jsonResponse({ error: '请提供 codes 参数，如 ?codes=300346,002428' }, 400);
      }
      try {
        const data = await fetchSinaRealtime(codes);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === '/history' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      if (!code || !start || !end) {
        return jsonResponse({ error: '请提供 code, start, end 参数' }, 400);
      }
      try {
        const data = await fetchTencentHistory(code, start, end);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // MCP 协议接口：POST /mcp
    if (url.pathname === '/mcp' && request.method === 'POST') {
      try {
        const body = await request.json();
        const result = await handleMcpRequest(body);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse({
        name: 'A股行情 MCP Server',
        endpoints: {
          mcp: 'POST /mcp  (MCP协议接口，供Claude连接)',
          quote: 'GET /quote?codes=300346,002428  (调试用)',
          history: 'GET /history?code=300346&start=2026-06-01&end=2026-06-29  (调试用)',
        },
      });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
