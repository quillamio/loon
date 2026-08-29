/*
 * Loon AI 节点实测选择器
 *
 * 用法：
 *   full  - 扫描 AI智能优选 中全部候选节点，实测 OpenAI 后选择综合最稳节点。
 *   guard - 只检测当前节点；当前节点失效时才扫描并切换。
 *
 * 目标：减少 Codex 因节点抖动、OpenAI 地区限制或频繁换节点导致的重连。
 */

const POLICY = "AI智能优选";
const API_URL = "https://api.openai.com/v1/models";
const CHATGPT_URL = "https://chatgpt.com/";
const REQUEST_TIMEOUT = 6000;
const CONCURRENCY = 8;
const KEEP_CURRENT_MARGIN_MS = 250;
const MODE = String($argument || "full").trim().toLowerCase();

function str(v) {
  return String(v == null ? "" : v);
}

function apiOK(status, body) {
  const b = str(body).toLowerCase();
  if (b.includes("unsupported_country")) return false;
  if (b.includes("unsupported country")) return false;
  if (b.includes("country, region, or territory")) return false;
  // 401 说明已经成功抵达 OpenAI API，只是没有提供 API Key。
  // 429 说明已经成功抵达 OpenAI，只是被限流。
  return status === 200 || status === 401 || status === 429;
}

function webOK(status) {
  return status >= 200 && status < 400;
}

function request(method, url, node) {
  return new Promise((resolve) => {
    const started = Date.now();
    const options = {
      url,
      node,
      timeout: REQUEST_TIMEOUT,
      "auto-redirect": false,
      "auto-cookie": false,
      alpn: "h2",
      headers: {
        "Accept": "application/json,text/html,*/*",
        "User-Agent": "Mozilla/5.0"
      }
    };

    const callback = (error, response, data) => {
      resolve({
        error: error ? str(error) : "",
        status: response ? response.status : 0,
        body: str(data),
        ms: Date.now() - started
      });
    };

    if (method === "HEAD") $httpClient.head(options, callback);
    else $httpClient.get(options, callback);
  });
}

async function probeNode(node) {
  const a1 = await request("GET", API_URL, node);
  const w1 = await request("HEAD", CHATGPT_URL, node);
  const a2 = await request("GET", API_URL, node);

  const ok1 = !a1.error && apiOK(a1.status, a1.body);
  const okw = !w1.error && webOK(w1.status);
  const ok2 = !a2.error && apiOK(a2.status, a2.body);

  const times = [];
  if (ok1) times.push(a1.ms);
  if (okw) times.push(w1.ms);
  if (ok2) times.push(a2.ms);

  const avg = times.length
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 99999;
  const jitter = times.length > 1
    ? Math.max(...times) - Math.min(...times)
    : 99999;

  const apiSuccess = (ok1 ? 1 : 0) + (ok2 ? 1 : 0);
  const webSuccess = okw ? 1 : 0;
  const strictOK = apiSuccess === 2 && webSuccess === 1;

  // 越低越好。提高抖动权重，优先选择适合 Codex 长连接的稳定线路。
  const score = strictOK
    ? avg + jitter * 1.8
    : 100000 + (2 - apiSuccess) * 20000 + (1 - webSuccess) * 20000 + avg;

  return {
    node,
    strictOK,
    apiSuccess,
    webSuccess,
    avg,
    jitter,
    score,
    detail: {
      api1: { status: a1.status, ms: a1.ms, error: a1.error },
      chatgpt: { status: w1.status, ms: w1.ms, error: w1.error },
      api2: { status: a2.status, ms: a2.ms, error: a2.error }
    }
  };
}

function getSubPolicies(policy) {
  return new Promise((resolve) => {
    try {
      $config.getSubPolicies(policy, (items) => {
        resolve(Array.isArray(items) ? items : []);
      });
    } catch (_) {
      resolve([]);
    }
  });
}

async function getNodes() {
  const nodes = await getSubPolicies(POLICY);
  return nodes.filter((n, i, arr) =>
    n &&
    n !== POLICY &&
    n !== "DIRECT" &&
    n !== "REJECT" &&
    arr.indexOf(n) === i
  );
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i]);
      } catch (e) {
        results[i] = {
          node: items[i], strictOK: false, apiSuccess: 0, webSuccess: 0,
          avg: 99999, jitter: 99999, score: 999999, error: str(e)
        };
      }
    }
  }

  const jobs = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) jobs.push(run());
  await Promise.all(jobs);
  return results;
}

function eligibleResults(results) {
  const strict = results
    .filter((x) => x && x.strictOK)
    .sort((a, b) => a.score - b.score);
  if (strict.length) return { mode: "严格", list: strict };

  const loose = results
    .filter((x) => x && x.apiSuccess >= 1 && x.webSuccess === 1)
    .sort((a, b) => a.score - b.score);
  return { mode: "宽松", list: loose };
}

function persist(results, eligible) {
  try {
    $persistentStore.write(JSON.stringify(results), "ai_node_last_results");
    $persistentStore.write(JSON.stringify(eligible.map((x) => ({
      node: x.node,
      avg: x.avg,
      jitter: x.jitter,
      score: Math.round(x.score)
    }))), "ai_node_valid_list");
  } catch (e) {
    console.log("保存检测结果失败：" + str(e));
  }
}

async function fullScan(current, notify) {
  const nodes = await getNodes();
  if (!nodes.length) {
    throw new Error("AI智能优选 中没有读取到候选节点。请确认全球节点筛选正常。 ");
  }

  console.log(`开始检测 ${nodes.length} 个 AI 候选节点`);
  const results = await mapLimit(nodes, CONCURRENCY, probeNode);
  const ranked = eligibleResults(results);
  const eligible = ranked.list;
  persist(results, eligible);

  if (!eligible.length) {
    $notification.post(
      "AI节点检测",
      "没有找到可用节点",
      "候选节点均未通过 OpenAI API + ChatGPT 实测。"
    );
    return;
  }

  const best = eligible[0];
  const currentResult = eligible.find((x) => x.node === current);
  let chosen = best;
  let reason = "选择综合稳定性最佳节点";

  if (currentResult && currentResult.score <= best.score + KEEP_CURRENT_MARGIN_MS) {
    chosen = currentResult;
    reason = "当前节点仍稳定，保持不变以减少 Codex 重连";
  }

  let switched = true;
  if (chosen.node !== current) {
    switched = $config.getConfig(POLICY, chosen.node);
  }

  const top = eligible.slice(0, 10).map((x, i) =>
    `${i + 1}. ${x.node}｜均值 ${x.avg}ms｜抖动 ${x.jitter}ms`
  ).join("\n");

  console.log(`最终节点：${chosen.node}；${reason}`);

  if (notify) {
    $notification.post(
      "AI节点检测完成",
      `${ranked.mode}可用 ${eligible.length}/${nodes.length}`,
      `当前：${chosen.node}\n${reason}\n切换：${switched ? "正常" : "失败"}\n\n${top}`
    );
  }
}

async function guard() {
  const current = $config.getSelectedPolicy(POLICY);
  if (!current || current === POLICY) {
    await fullScan(current || "", false);
    return;
  }

  const result = await probeNode(current);
  if (result.strictOK) {
    console.log(`当前AI节点正常：${current}｜均值 ${result.avg}ms｜抖动 ${result.jitter}ms`);
    return;
  }

  $notification.post(
    "AI节点守护",
    "当前节点异常",
    `${current} 未通过稳定性检测，开始寻找替代节点。`
  );
  await fullScan(current, false);
}

async function main() {
  if (MODE === "guard") await guard();
  else await fullScan($config.getSelectedPolicy(POLICY) || "", true);
}

main()
  .catch((e) => {
    console.log("AI节点检测失败：" + str(e));
    $notification.post("AI节点检测失败", "", str(e));
  })
  .finally(() => $done());
