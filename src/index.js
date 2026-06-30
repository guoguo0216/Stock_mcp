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

// ---------- 东方财富：十大流通股东 ----------
async function fetchTopShareholders(code, date = null) {
  const normalized = normalizeCode(code);
  const pureCode = normalized.slice(2);
  const exchangePrefix = normalized.slice(0, 2).toUpperCase(); // SH / SZ / BJ
  const symbol = `${exchangePrefix}${pureCode}`;

  let targetDate = date;
  if (!targetDate) {
    // 未指定日期，使用最近的报告期（粗略推算）
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1; // 1-12
    if (m <= 3) targetDate = `${y - 1}-09-30`;
    else if (m <= 6) targetDate = `${y - 1}-12-31`;
    else if (m <= 9) targetDate = `${y}-03-31`;
    else targetDate = `${y}-06-30`;
  }

  const url = 'https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageSDLTGD';
  const params = new URLSearchParams({ code: symbol, date: targetDate });
  const resp = await fetch(`${url}?${params.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const data = await resp.json();
  const list = data?.sdltgd || [];

  return {
    code: pureCode,
    reportDate: targetDate,
    shareholders: list.map((row, idx) => ({
      rank: idx + 1,
      holderName: row.HOLDER_NAME || row[5] || null,
      holderType: row.HOLDER_TYPE || row[6] || null,
      shareType: row.SHARES_TYPE || row[7] || null,
      holdNum: row.HOLD_NUM != null ? Number(row.HOLD_NUM) : (row[8] != null ? Number(row[8]) : null),
      holdRatio: row.FREE_HOLDNUM_RATIO != null ? Number(row.FREE_HOLDNUM_RATIO) : (row[9] != null ? Number(row[9]) : null),
      changeType: row.IS_HOLDNUM_CHANGE || row[10] || null,
      changeRatio: row.HOLDNUM_CHANGE_RATIO != null ? Number(row.HOLDNUM_CHANGE_RATIO) : (row[11] != null ? Number(row[11]) : null),
    })),
    rawSample: list.length > 0 ? list[0] : null, // 保留首条原始数据，便于核对字段是否解析正确
  };
}

// ---------- 东方财富：主要财务指标（含资本性支出相关字段，用于CapEx趋势分析） ----------
async function fetchCapexIndicators(code, count = 8, debug = false) {
  const secuCode = toSecuCode(code);
  const url = `https://datacenter.eastmoney.com/securities/api/data/get?` +
    `type=RPT_F10_FINANCE_MAINFINADATA&sty=APP_F10_MAINFINADATA` +
    `&quoteColumns=&filter=(SECUCODE="${secuCode}")` +
    `&p=1&ps=${count}&sr=-1&st=REPORT_DATE&source=HSF10&client=PC`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://data.eastmoney.com/',
    },
  });
  const data = await resp.json();
  const rows = data?.result?.data || [];

  if (debug) {
    return rows.length > 0 ? rows[0] : { error: '无数据返回', raw: data };
  }

  return rows.map((row) => ({
    reportDate: row.REPORT_DATE ? row.REPORT_DATE.slice(0, 10) : null,
    operatingCashFlow: row.NETCASH_OPERATE ?? null,
    investingCashFlow: row.NETCASH_INVEST ?? null,
    capexProxy: row.FIXED_ASSET ?? row.TOTAL_FIXED_ASSET ?? null,
    debtRatio: row.DEBT_ASSET_RATIO ?? null,
    currentRatio: row.CURRENT_RATIO ?? null,
  }));
}

// ---------- 新浪财经：利润表关键科目（含扣非净利润，按中文科目名匹配，不依赖猜测英文字段名） ----------
async function fetchDeductedNetProfit(code, count = 8) {
  const normalized = normalizeCode(code);
  const pureCode = normalized.slice(2);

  const url = 'https://quotes.sina.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022';
  const params = new URLSearchParams({
    paperCode: normalized, // sz300346 / sh600000 格式
    source: 'lrb', // 利润表
    type: '0', // 0=全部报告期
    page: '1',
    num: String(count),
  });
  const resp = await fetch(`${url}?${params.toString()}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const data = await resp.json();
  const reportList = data?.result?.data?.report_list;
  if (!reportList) return { error: '未获取到利润表数据', raw: data };

  // 按报告期日期降序排列（key形如 "20260331"）
  const reportDates = Object.keys(reportList).sort((a, b) => b.localeCompare(a)).slice(0, count);

  // 中文科目名关键词匹配规则，避免依赖猜测的英文字段名
  const matchRules = {
    deductedNetProfit: ['扣除非经常性损益后的净利润', '扣非净利润', '扣除非经常性损益'],
    netProfit: ['净利润', '归属于母公司所有者的净利润', '归属于上市公司股东的净利润'],
    operatingRevenue: ['营业总收入', '营业收入'],
    operatingProfit: ['营业利润'],
  };

  function findValue(items, keywords) {
    for (const kw of keywords) {
      const hit = items.find((it) => (it.item_title || '').includes(kw));
      if (hit) return hit.item_value;
    }
    return null;
  }

  return reportDates.map((dateKey) => {
    const items = reportList[dateKey]?.data || [];
    return {
      reportDate: `${dateKey.slice(0, 4)}-${dateKey.slice(4, 6)}-${dateKey.slice(6, 8)}`,
      deductedNetProfit: findValue(items, matchRules.deductedNetProfit),
      netProfit: findValue(items, matchRules.netProfit),
      operatingRevenue: findValue(items, matchRules.operatingRevenue),
      operatingProfit: findValue(items, matchRules.operatingProfit),
      // 保留全部科目名称，便于核对是否有遗漏或更精确的匹配项
      allItemTitles: items.map((it) => it.item_title),
    };
  });
}

// ---------- 东方财富：查询公司类型代码（资产负债表/现金流量表接口的必要前置参数） ----------
async function fetchCompanyType(symbol) {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code=${symbol.toLowerCase()}`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await resp.text();
  const m = html.match(/id=["']hidctype["']\s+value=["']([^"']+)["']/i)
    || html.match(/<input[^>]*id=["']hidctype["'][^>]*value=["']([^"']+)["']/i);
  if (!m) throw new Error('未能解析公司类型代码(companyType)，页面结构可能已变化');
  return m[1];
}

// ---------- 东方财富：在建工程趋势（资产负债表，作为CapEx的早期代理信号） ----------
async function fetchConstructionInProgress(code, count = 8) {
  const normalized = normalizeCode(code);
  const pureCode = normalized.slice(2);
  const exchangePrefix = normalized.slice(0, 2).toUpperCase();
  const symbol = `${exchangePrefix}${pureCode}`;

  const companyType = await fetchCompanyType(symbol);

  const dateUrl = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/zcfzbDateAjaxNew';
  const dateResp = await fetch(`${dateUrl}?${new URLSearchParams({ companyType, reportDateType: '0', code: symbol })}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const dateData = await dateResp.json();
  const allDates = (dateData?.data || []).map((d) => (d.REPORT_DATE || '').slice(0, 10)).filter(Boolean);
  const dates = allDates.slice(0, count);
  if (dates.length === 0) return [];

  const url = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/zcfzbAjaxNew';
  const params = new URLSearchParams({
    companyType, reportDateType: '0', reportType: '1', dates: dates.join(','), code: symbol,
  });
  const resp = await fetch(`${url}?${params.toString()}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await resp.json();
  const rows = data?.data || [];

  return rows.map((row) => ({
    reportDate: row.REPORT_DATE ? row.REPORT_DATE.slice(0, 10) : null,
    constructionInProgress: row.CIP ?? row.CONSTRUCTION_MATERIALS ?? null,
    fixedAssets: row.FIXED_ASSET ?? null,
    totalAssets: row.TOTAL_ASSETS ?? null,
    rawSample: row,
  }));
}

// ---------- 东方财富：CapEx标准科目（现金流量表，购建固定资产/无形资产支付的现金） ----------
async function fetchCapexCashflow(code, count = 8) {
  const normalized = normalizeCode(code);
  const pureCode = normalized.slice(2);
  const exchangePrefix = normalized.slice(0, 2).toUpperCase();
  const symbol = `${exchangePrefix}${pureCode}`;

  const companyType = await fetchCompanyType(symbol);

  const dateUrl = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/xjllbDateAjaxNew';
  const dateResp = await fetch(`${dateUrl}?${new URLSearchParams({ companyType, reportDateType: '0', code: symbol })}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  const dateData = await dateResp.json();
  const allDates = (dateData?.data || []).map((d) => (d.REPORT_DATE || '').slice(0, 10)).filter(Boolean);
  const dates = allDates.slice(0, count);
  if (dates.length === 0) return [];

  const url = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/xjllbAjaxNew';
  const params = new URLSearchParams({
    companyType, reportDateType: '0', reportType: '1', dates: dates.join(','), code: symbol,
  });
  const resp = await fetch(`${url}?${params.toString()}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await resp.json();
  const rows = data?.data || [];

  return rows.map((row) => ({
    reportDate: row.REPORT_DATE ? row.REPORT_DATE.slice(0, 10) : null,
    capexStandard: row.CONSTRUCT_LONG_ASSET ?? row.FIX_INTAN_OTHER_ASSET_ACQUI_CASH ?? null,
    operatingCashFlowNet: row.NETCASH_OPERATE ?? null,
    investingCashFlowNet: row.NETCASH_INVEST ?? null,
    rawSample: row,
  }));
}

// ---------- 巨潮资讯/深交所互动易：根据股票代码查询 orgId（互动易接口的必要参数，与公告orgId是不同的体系） ----------
async function fetchIrmOrgId(code) {
  const normalized = normalizeCode(code);
  const pureCode = normalized.slice(2);
  const url = 'https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo';
  const params = new URLSearchParams({ _t: String(Date.now()) });
  const resp = await fetch(`${url}?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://irm.cninfo.com.cn/',
    },
    body: `keyWord=${pureCode}`,
  });
  const data = await resp.json();
  const list = data?.data || [];
  const match = list.find((item) => item.code === pureCode) || list[0];
  if (!match) throw new Error(`未找到股票代码 ${pureCode} 对应的互动易组织代码(orgId)`);
  return match.secid;
}

// ---------- 深交所互动易：投资者问答（问董秘） ----------
async function fetchInvestorQA(code, count = 30, keyword = '') {
  const normalized = normalizeCode(code);
  const pureCode = normalized.slice(2);
  const orgId = await fetchIrmOrgId(code);

  const url = 'https://irm.cninfo.com.cn/newircs/company/question';
  const params = new URLSearchParams({
    _t: String(Date.now()),
    stockcode: pureCode,
    orgId,
    pageSize: String(count),
    pageNum: '1',
    keyWord: keyword,
    startDay: '',
    endDay: '',
  });
  const resp = await fetch(`${url}?${params.toString()}`, {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://irm.cninfo.com.cn/',
    },
  });
  const data = await resp.json();
  const rows = data?.rows || [];

  return rows.map((row) => ({
    questionId: row.indexId,
    question: row.mainContent,
    questionTime: row.pubDate ? row.pubDate.slice(0, 10) : null,
    asker: row.authorName || null,
    answer: row.attachedContent || null,
    answerer: row.attachedAuthor || null,
    companyName: row.companyShortName,
  }));
}

// ---------- 东方财富：机构调研活动详细（单只股票） ----------
async function fetchInstitutionSurvey(code, startDate, count = 30) {
  const secuCode = toSecuCode(code);
  const pureCode = secuCode.split('.')[0];

  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
  const params = new URLSearchParams({
    sortColumns: 'NOTICE_DATE,RECEIVE_START_DATE',
    sortTypes: '-1,-1',
    pageSize: String(count),
    pageNumber: '1',
    reportName: 'RPT_ORG_SURVEY',
    columns: 'SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,NOTICE_DATE,RECEIVE_START_DATE,' +
      'RECEIVE_OBJECT,RECEIVE_PLACE,RECEIVE_WAY_EXPLAIN,INVESTIGATORS,RECEPTIONIST,ORG_TYPE',
    source: 'WEB',
    client: 'WEB',
    filter: `(SECURITY_CODE="${pureCode}")(RECEIVE_START_DATE>='${startDate}')`,
  });
  const resp = await fetch(`${url}?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://data.eastmoney.com/',
    },
  });
  const data = await resp.json();
  const rows = data?.result?.data || [];

  return rows.map((row) => ({
    noticeDate: row.NOTICE_DATE ? row.NOTICE_DATE.slice(0, 10) : null,
    surveyDate: row.RECEIVE_START_DATE ? row.RECEIVE_START_DATE.slice(0, 10) : null,
    participants: row.RECEIVE_OBJECT || null,
    orgType: row.ORG_TYPE || null,
    receivePlace: row.RECEIVE_PLACE || null,
    receiveWay: row.RECEIVE_WAY_EXPLAIN || null,
    investigators: row.INVESTIGATORS || null,
    receptionist: row.RECEPTIONIST || null,
  }));
}

// ---------- 根据公告标题推断分类（announcementTypeName字段在巨潮接口里经常为null，不可靠） ----------
function inferAnnouncementType(title) {
  const rules = [
    { keyword: ['年度报告', '年报'], type: '年报' },
    { keyword: ['一季度报告', '一季报', '第一季度报告'], type: '一季报' },
    { keyword: ['半年度报告', '半年报', '中期报告'], type: '半年报' },
    { keyword: ['三季度报告', '三季报', '第三季度报告'], type: '三季报' },
    { keyword: ['业绩预告', '业绩快报'], type: '业绩预告' },
    { keyword: ['股东大会'], type: '股东大会' },
    { keyword: ['减持计划', '减持股份', '减持进展'], type: '股东减持' },
    { keyword: ['增持计划', '增持股份'], type: '股东增持' },
    { keyword: ['权益变动', '权益分布'], type: '权益变动' },
    { keyword: ['解除限售', '限售解禁', '解禁'], type: '限售解禁' },
    { keyword: ['股权激励', '激励计划'], type: '股权激励' },
    { keyword: ['董事', '监事', '高级管理人员'], type: '人事变动' },
    { keyword: ['关联交易'], type: '关联交易' },
    { keyword: ['对外投资', '投资公告', '募投项目'], type: '对外投资' },
    { keyword: ['诉讼', '仲裁'], type: '诉讼仲裁' },
    { keyword: ['问询函', '关注函', '监管函'], type: '监管问询' },
    { keyword: ['独立董事述职'], type: '独立董事述职' },
    { keyword: ['内部控制'], type: '内控报告' },
    { keyword: ['风险提示'], type: '风险提示' },
  ];
  for (const rule of rules) {
    if (rule.keyword.some((k) => title.includes(k))) return rule.type;
  }
  return '其他';
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
    announcements: list.map((item) => {
      const title = (item.announcementTitle || '').replace(/<\/?em>/g, ''); // 去除高亮标签
      return {
        title,
        time: item.announcementTime ? new Date(item.announcementTime).toISOString().slice(0, 10) : null,
        type: item.announcementTypeName || inferAnnouncementType(title),
        pdfUrl: item.adjunctUrl ? `http://static.cninfo.com.cn/${item.adjunctUrl}` : null,
        sizeKB: item.adjunctSize || null,
      };
    }),
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
  {
    name: 'get_top_shareholders',
    description: '获取单只A股股票最新报告期的十大流通股东名单，包括股东名称、类型、持股数量、占流通股比例、较上期持股变动情况。用于分析大客户/机构集中度、判断股东结构变化信号，对应Serenity方法论第四步"大客户自研/集中度"风险评估。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '股票代码，支持纯数字或带前缀',
        },
        date: {
          type: 'string',
          description: '报告期日期，格式 YYYY-MM-DD（如"2026-03-31"），可选，不填则自动取最近报告期',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_construction_in_progress',
    description: '获取单只A股股票的在建工程余额季度序列（来自资产负债表）。在建工程是CapEx的早期领先信号，余额连续多季度上升通常意味着产能扩张正在进行中，比现金流量表里的实际CapEx支出更早反映投资动作。适合作为Serenity方法论第三步CapEx爬坡信号的初筛指标，尤其适用于重资产制造业。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '股票代码，支持纯数字或带前缀' },
        count: { type: 'integer', description: '获取最近几期数据，默认8期' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_capex_cashflow',
    description: '获取单只A股股票的标准CapEx科目季度序列（来自现金流量表"购建固定资产、无形资产和其他长期资产支付的现金"），同时附带经营/投资活动现金流净额。这是CapEx的官方会计口径，全市场可比，适合作为在建工程初筛信号之后的精确复核指标，对应Serenity方法论第三步CapEx爬坡信号的确认环节。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '股票代码，支持纯数字或带前缀' },
        count: { type: 'integer', description: '获取最近几期数据，默认8期' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_investor_qa',
    description: '获取单只A股股票在深交所"互动易"平台的投资者问答记录（问董秘），包括投资者提问内容、提问时间、公司回答内容、回答时间。这是了解管理层对经营细节、行业景气度、订单情况等问题真实表态的渠道，可用于辅助第三步财务拐点和第四步红队测试的定性验证。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '股票代码，支持纯数字或带前缀' },
        count: { type: 'integer', description: '获取最近几条问答，默认30条' },
        keyword: { type: 'string', description: '按问题内容关键词筛选，可选（如"订单"、"产能"、"客户"）' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_institution_survey',
    description: '获取单只A股股票的机构调研活动详细记录，包括调研日期、参与调研的机构名单及类型、接待方式（现场/电话会议/线上交流）、公司接待人员。机构调研频次的异常上升、参与机构的质地，是市场关注度变化的早期领先信号，对应Serenity方法论"在市场普遍关注之前发现信号"的核心诉求，也可作为第二步候选池筛选和第五步熔断机制的辅助验证。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '股票代码，支持纯数字或带前缀' },
        start_date: { type: 'string', description: '起始日期，格式 YYYY-MM-DD，默认取近6个月' },
        count: { type: 'integer', description: '获取最近几条调研记录，默认30条' },
      },
      required: ['code'],
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
      } else if (name === 'get_top_shareholders') {
        resultData = await fetchTopShareholders(args.code, args.date || null);
      } else if (name === 'get_construction_in_progress') {
        resultData = await fetchConstructionInProgress(args.code, args.count || 8);
      } else if (name === 'get_capex_cashflow') {
        resultData = await fetchCapexCashflow(args.code, args.count || 8);
      } else if (name === 'get_investor_qa') {
        resultData = await fetchInvestorQA(args.code, args.count || 30, args.keyword || '');
      } else if (name === 'get_institution_survey') {
        const defaultStart = new Date();
        defaultStart.setMonth(defaultStart.getMonth() - 6);
        const startDate = args.start_date || defaultStart.toISOString().slice(0, 10);
        resultData = await fetchInstitutionSurvey(args.code, startDate, args.count || 30);
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

    if (url.pathname === '/shareholders' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const date = url.searchParams.get('date');
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346（可选 &date=2026-03-31）' }, 400);
      }
      try {
        const data = await fetchTopShareholders(code, date);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
      }
    }

    if (url.pathname === '/cip' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const count = parseInt(url.searchParams.get('count') || '8', 10);
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346  (在建工程趋势)' }, 400);
      }
      try {
        const data = await fetchConstructionInProgress(code, count);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
      }
    }

    if (url.pathname === '/capex' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const count = parseInt(url.searchParams.get('count') || '8', 10);
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346  (标准CapEx现金流科目)' }, 400);
      }
      try {
        const data = await fetchCapexCashflow(code, count);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
      }
    }

    if (url.pathname === '/deductedprofit' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const count = parseInt(url.searchParams.get('count') || '8', 10);
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346  (扣非净利润，含allItemTitles用于核对科目名)' }, 400);
      }
      try {
        const data = await fetchDeductedNetProfit(code, count);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
      }
    }

    if (url.pathname === '/investorqa' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const count = parseInt(url.searchParams.get('count') || '30', 10);
      const keyword = url.searchParams.get('keyword') || '';
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346  (互动易投资者问答)' }, 400);
      }
      try {
        const data = await fetchInvestorQA(code, count, keyword);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
      }
    }

    if (url.pathname === '/survey' && request.method === 'GET') {
      const code = url.searchParams.get('code');
      const count = parseInt(url.searchParams.get('count') || '30', 10);
      let startDate = url.searchParams.get('start');
      if (!startDate) {
        const d = new Date();
        d.setMonth(d.getMonth() - 6);
        startDate = d.toISOString().slice(0, 10);
      }
      if (!code) {
        return jsonResponse({ error: '请提供 code 参数，如 ?code=300346&start=2026-01-01  (机构调研活动详细)' }, 400);
      }
      try {
        const data = await fetchInstitutionSurvey(code, startDate, count);
        return jsonResponse(data);
      } catch (err) {
        return jsonResponse({ error: err.message, stack: err.stack }, 500);
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
          shareholders: 'GET /shareholders?code=300346&date=2026-03-31  (调试用：十大流通股东)',
          capex: 'GET /capex?code=300346  (调试用：标准CapEx现金流科目，含rawSample原始字段)',
          deductedprofit: 'GET /deductedprofit?code=300346  (调试用：扣非净利润，含allItemTitles核对科目名)',
          investorqa: 'GET /investorqa?code=300346  (调试用：互动易投资者问答)',
          survey: 'GET /survey?code=300346&start=2026-01-01  (调试用：机构调研活动详细)',
          cip: 'GET /cip?code=300346  (调试用：在建工程趋势，含rawSample原始字段)',
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
