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

// ---------- 东方财富：股票代码 -> SECUCODE 格式转换 ----------
// 东方财富财务数据接口要求 SECUCODE 格式：代码.SH / 代码.SZ / 代码.BJ
function toSecuCode(code) {
  const normalized = normalizeCode(code); // 如 sz300346
  const pure = normalized.slice(2);
  const exchangeMap = { sz: 'SZ', sh: 'SH', bj: 'BJ' };
  const exchange = exchangeMap[normalized.slice(0, 2)];
  return `${pure}.${exchange}`;
}

// ---------- 东方财富：核心财务指标（业绩报表，含毛利率/营收/净利润/ROE） ----------
async function fetchFinancialIndicators(code, count = 8) {
  const secuCode = toSecuCode(code);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
    `sortColumns=REPORTDATE&sortTypes=-1&pageSize=${count}&pageNumber=1` +
    `&reportName=RPT_LICO_FN_CPD&columns=ALL` +
    `&filter=(SECUCODE="${secuCode}")`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://data.eastmoney.com/',
    },
  });
  const data = await resp.json();
  const rows = data?.result?.data || [];

  return rows.map((row) => ({
    reportDate: row.REPORTDATE ? row.REPORTDATE.slice(0, 10) : null,    // 报告期
    reportType: row.DATATYPE,                                           // 如"2026年 一季报"
    revenue: row.TOTAL_OPERATE_INCOME,                                  // 营业总收入（元）
    revenueYoY: row.YSTZ,                                                // 营收同比%
    revenueQoQ: row.YSHZ,                                                // 营收环比%
    netProfit: row.PARENT_NETPROFIT,                                    // 归母净利润（元）
    netProfitYoY: row.SJLTZ,                                             // 净利润同比%
    netProfitQoQ: row.SJLHZ,                                             // 净利润环比%
    grossMargin: row.XSMLL,                                              // 销售毛利率%（核心：Serenity第三步毛利率拐点）
    roeWeighted: row.WEIGHTAVG_ROE,                                      // 加权净资产收益率%
    eps: row.BASIC_EPS,                                                  // 基本每股收益
    bps: row.BPS,                                                        // 每股净资产
    operatingCashFlowPerShare: row.MGJYXJJE,                             // 每股经营性现金流
    industry: row.PUBLISHNAME,                                           // 所属行业
    noticeDate: row.NOTICE_DATE ? row.NOTICE_DATE.slice(0, 10) : null,   // 公告日期
  }));
}

// ---------- 东方财富：估值指标（PE/PB/市值，用于核对行情接口数据） ----------
async function fetchValuationMetrics(code, debug = false) {
  const secuCode = toSecuCode(code);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?` +
    `sortColumns=TRADE_DATE&sortTypes=-1&pageSize=1&pageNumber=1` +
    `&reportName=RPT_VALUEANALYSIS_DET&columns=ALL` +
    `&filter=(SECUCODE="${secuCode}")`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://data.eastmoney.com/',
    },
  });
  const data = await resp.json();
  const rows = data?.result?.data || [];
  if (rows.length === 0) return null;
  const row = rows[0];

  if (debug) {
    // 调试模式：返回原始全部字段，用于核对正确字段名
    return row;
  }

  return {
    tradeDate: row.TRADE_DATE ? row.TRADE_DATE.slice(0, 10) : null,
    closePrice: row.CLOSE_PRICE,
    peTTM: row.PE_TTM,           // 市盈率(TTM)
    peStatic: row.PE_LAR,         // 市盈率(静态)
    pb: row.PB_MRQ,                // 市净率(MRQ)
    totalMarketCap: row.TOTAL_MARKET_CAP,                // 总市值
    circulatingMarketCap: row.NOTLIMITED_MARKETCAP_A,    // 无限售流通市值（A股口径）
    totalShares: row.TOTAL_SHARES,                        // 总股本
    circulatingShares: row.FREE_SHARES_A,                 // 无限售流通股数
    psTTM: row.PS_TTM,            // 市销率(TTM)
    pcfOcfTTM: row.PCF_OCF_TTM,   // 市现率(经营现金流TTM)
  };
}

// ---------- 巨潮资讯：根据股票代码查询 orgId（公告接口的必要参数） ----------
async function fetchCninfoOrgId(code) {
  const normalized = normalizeCode(code);
  const pureCode = normalized.slice(2);
  const url = 'http://www.cninfo.com.cn/new/information/topSearch/query';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'http://www.cninfo.com.cn/',
    },
    body: `keyWord=${pureCode}`,
  });
  const data = await resp.json();
  // 返回结果通常是数组，匹配股票代码精确对应的那一条
  const list = Array.isArray(data) ? data : (data?.keyBoardList || []);
  const match = list.find((item) => item.code === pureCode) || list[0];
  if (!match) throw new Error(`未找到股票代码 ${pureCode} 对应的机构ID(orgId)`);
  return { orgId: match.orgId, code: pureCode, name: match.zwjc };
}

// ---------- 巨潮资讯：公司公告列表 ----------
function exchangeToColumn(normalizedCode) {
  // 巨潮 column 参数：深市 szse，沪市 sse，北交所 bj
  const prefix = normalizedCode.slice(0, 2);
  if (prefix === 'sz') return 'szse';
  if (prefix === 'sh') return 'sse';
  if (prefix === 'bj') return 'bj';
  return 'szse';
}

async function fetchAnnouncements(code, startDate, endDate, keyword = '', pageSize = 20) {
  const normalized = normalizeCode(code);
  const { orgId, code: pureCode, name } = await fetchCninfoOrgId(code);
  const column = exchangeToColumn(normalized);

  const url = 'http://www.cninfo.com.cn/new/hisAnnouncement/query';
  const params = new URLSearchParams({
    pageNum: '1',
    pageSize: String(pageSize),
    column,
    tabName: 'fulltext',
    stock: `${pureCode},${orgId}`,
    searchkey: keyword,
    category: '',
    seDate: `${startDate}~${endDate}`,
    sortName: '',
    sortType: '',
    isHLtitle: 'true',
  });

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'http://www.cninfo.com.cn/',
    },
    body: params.toString(),
  });
  const data = await resp.json();
  const list = data?.announcements || [];

  return {
    company: name,
    code: pureCode,
    totalCount: data?.totalAnnouncement || list.length,
    announcements: list.map((item) => ({
      title: (item.announcementTitle || '').replace(/<\/?em>/g, ''), // 去除高亮标签
      time: item.announcementTime ? new Date(item.announcementTime).toISOString().slice(0, 10) : null,
      type: item.announcementTypeName || null,
      pdfUrl: item.adjunctUrl ? `http://static.cninfo.com.cn/${item.adjunctUrl}` : null,
      sizeKB: item.adjunctSize || null,
    })),
  };
}


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
  {
    name: 'get_financial_indicators',
    description: '获取单只A股股票的核心财务指标历史数据（季度序列），包括营业收入、归母净利润、销售毛利率、加权ROE、营收/利润同比环比增速、每股经营现金流等。用于分析毛利率拐点、营收利润趋势。数据来源为上市公司定期财报。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '股票代码，支持纯数字（如"300346"）或带前缀（如"sz300346"）',
        },
        count: {
          type: 'integer',
          description: '获取最近几期数据，默认8期（约2年的季度数据）',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_valuation_metrics',
    description: '获取单只A股股票最新的估值指标，包括市盈率(TTM/静态)、市净率、总市值、流通市值。用于核对实时行情接口的市值数据，或快速判断估值水平。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '股票代码，支持纯数字或带前缀',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_announcements',
    description: '获取单只A股股票指定日期范围内的公司公告列表，包括公告标题、日期、类型、PDF链接。用于追踪重大事项、业绩预告、股东大会、解禁公告、监管问询等信息披露，是Serenity方法论第四步红队测试和第五步熔断机制验证的关键数据源。',
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
        keyword: {
          type: 'string',
          description: '公告标题关键词筛选，可选（如"业绩预告"、"股东大会"）',
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
      } else if (name === 'get_financial_indicators') {
        resultData = await fetchFinancialIndicators(args.code, args.count || 8);
      } else if (name === 'get_valuation_metrics') {
        resultData = await fetchValuationMetrics(args.code);
      } else if (name === 'get_announcements') {
        resultData = await fetchAnnouncements(args.code, args.start_date, args.end_date, args.keyword || '');
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

    if (url.pathname === '/financials' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const count = parseInt(url.searchParams.get('count') || '8', 10);
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346&count=8' }, 400);
      }
      try {
        const data = await fetchFinancialIndicators(code, count);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === '/valuation' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const debug = url.searchParams.get('debug') === '1';
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346（加 &debug=1 查看原始字段）' }, 400);
      }
      try {
        const data = await fetchValuationMetrics(code, debug);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    if (url.pathname === '/announcements' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const start = url.searchParams.get('start');
      const end = url.searchParams.get('end');
      const keyword = url.searchParams.get('keyword') || '';
      if (!code || !start || !end) {
        return jsonResponse({ error: '请提供 code, start, end 参数，如 ?code=300346&start=2026-01-01&end=2026-06-30' }, 400);
      }
      try {
        const data = await fetchAnnouncements(code, start, end, keyword);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
      }
    }

    if (url.pathname === '/orgid' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数（调试用，查orgId）' }, 400);
      }
      try {
        const data = await fetchCninfoOrgId(code);
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
          quote: 'GET /quote?codes=300346,002428  (调试用：实时行情)',
          history: 'GET /history?code=300346&start=2026-06-01&end=2026-06-29  (调试用：历史K线)',
          financials: 'GET /financials?code=300346&count=8  (调试用：财务指标季度序列)',
          valuation: 'GET /valuation?code=300346  (调试用：估值指标PE/PB/市值)',
          announcements: 'GET /announcements?code=300346&start=2026-01-01&end=2026-06-30  (调试用：公告列表)',
          orgid: 'GET /orgid?code=300346  (调试用：查询巨潮资讯orgId)',
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
