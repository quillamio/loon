/*
 * Loon OpenAI / Codex 链路健康检测
 * 安全原则：只检测、只评分、只提醒，绝不自动切换策略或节点。
 *
 * 默认测试：AI智能优选
 * 如果从某个节点/策略上下文手动运行 generic 脚本，则优先测试该上下文。
 */

const DEFAULT_POLICY = "AI智能优选";
const ARG = String($argument || "").toLowerCase();
const SILENT = ARG.indexOf("silent") !== -1;
const TIMEOUT = 6000;

function s(v) {
  return String(v == null ? "" : v);
}

function getTarget() {
  try {
    if (typeof $environment !== "undefined" &&
        $environment.params &&
        $environment.params.node) {
      return $environment.params.node;
    }
  } catch (e) {}
  return DEFAULT_POLICY;
}

function selectedName() {
  try {
    const x = $config.getSelectedPolicy(DEFAULT_POLICY);
    return x || DEFAULT_POLICY;
  } catch (e) {
    return DEFAULT_POLICY;
  }
}

function request(url, node) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    $httpClient.get({
      url: url,
      node: node,
      timeout: TIMEOUT,
      "auto-redirect": false,
      "auto-cookie": false,
      headers: {
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0"
      }
    }, (error, response, data) => {
      const ms = Date.now() - t0;
      resolve({
        error: error ? s(error) : "",
        status: response ? response.status : 0,
        ms: ms,
        body: s(data)
      });
    });
  });
}

function apiOK(r) {
  if (r.error) return false;
  const b = r.body.toLowerCase();
  if (b.indexOf("unsupported_country") !== -1) return false;
  if (b.indexOf("unsupported country") !== -1) return false;
  if (b.indexOf("country, region, or territory") !== -1) return false;
  // 未带 API Key 时 401 表示已经成功抵达 OpenAI API。
  return r.status === 200 || r.status === 401 || r.status === 429;
}

function edgeOK(r) {
  // 对 ChatGPT / WebSocket 域名这里只检查 DNS/TCP/TLS/HTTP 是否可达。
  // 2xx/3xx/4xx 都说明已抵达远端；5xx/超时视为异常。
  return !r.error && r.status >= 200 && r.status < 500;
}

function avg(arr) {
  if (!arr.length) return 99999;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

async function main() {
  const target = getTarget();
  const current = selectedName();

  // API 连测 3 次，用于观察抖动；另外检查 ChatGPT 与 ws.chatgpt.com 的基础可达性。
  const a1 = await request("https://api.openai.com/v1/models", target);
  const a2 = await request("https://api.openai.com/v1/models", target);
  const a3 = await request("https://api.openai.com/v1/models", target);
  const chat = await request("https://chatgpt.com/robots.txt", target);
  const ws = await request("https://ws.chatgpt.com/", target);

  const apiResults = [a1, a2, a3];
  const goodApi = apiResults.filter(apiOK);
  const times = goodApi.map(x => x.ms);
  const mean = avg(times);
  const jitter = times.length >= 2 ? Math.max.apply(null, times) - Math.min.apply(null, times) : 99999;
  const chatOK = edgeOK(chat);
  const wsOK = edgeOK(ws);

  let grade = "D";
  let summary = "不可用或严重不稳定";

  if (goodApi.length === 3 && chatOK && wsOK) {
    if (mean <= 500 && jitter <= 250) {
      grade = "A";
      summary = "适合 Codex 长连接";
    } else if (mean <= 1000 && jitter <= 600) {
      grade = "B";
      summary = "可用，但延迟或抖动偏高";
    } else {
      grade = "C";
      summary = "可达，但不建议作为 Codex 长期节点";
    }
  } else if (goodApi.length >= 2 && chatOK) {
    grade = "C";
    summary = "存在间歇性失败，可能引起重连";
  }

  const detail = [
    `节点：${current}`,
    `等级：${grade}｜${summary}`,
    `OpenAI API：${goodApi.length}/3`,
    `平均延迟：${mean === 99999 ? "失败" : mean + " ms"}`,
    `抖动：${jitter === 99999 ? "无法计算" : jitter + " ms"}`,
    `ChatGPT：${chatOK ? "可达" : "异常"} (${chat.status || chat.error})`,
    `WebSocket域名：${wsOK ? "可达" : "异常"} (${ws.status || ws.error})`
  ].join("\n");

  console.log(detail);

  // 定时守护只在 C/D 时提醒；手动运行始终显示结果。
  if (!SILENT || grade === "C" || grade === "D") {
    $notification.post("AI链路健康检测", `当前节点等级 ${grade}`, detail);
  }
}

main()
  .catch((e) => {
    const msg = s(e);
    console.log("AI健康检测错误: " + msg);
    if (!SILENT) $notification.post("AI链路健康检测失败", "", msg);
  })
  .finally(() => $done());
