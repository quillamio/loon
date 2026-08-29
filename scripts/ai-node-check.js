/*
 * Loon AI 节点实测选择器 v2
 *
 * 解决的问题：
 * - Remote Filter（NameRegex）不会被 $config.getSubPolicies() 稳定展开，因此旧版脚本可能读不到候选节点。
 * - 本版不再尝试枚举 Remote Filter。
 * - 改为读取多个“AI探测组”当前实际选中的真实节点，再逐个实测 OpenAI。
 * - 最后把 AI智能优选 固定到胜出的真实节点，避免 Codex 因 url-test 子组自动切换而重连。
 *
 * 模式：
 * full  = 检查当前节点 + 各 AI 探测组候选节点，选择综合最稳节点。
 * guard = 只检测当前 AI 节点；当前节点失效时才执行 full。
 */

const POLICY = "AI智能优选";

// 这些组必须存在于 [Proxy Group]。
// 每个组由 Loon 自己从对应 Remote Filter 中挑一个候选节点。
const PROBE_GROUPS = [
  "AI探测日韩",
  "AI探测亚洲",
  "AI探测欧洲",
  "AI探测美加澳",
  "AI探测高速"
];

const API_URL = "https://api.openai.com/v1/models";
const CHATGPT_URL = "https://chatgpt.com/";
const REQUEST_TIMEOUT = 6500;
const CONCURRENCY = 5;
const KEEP_CURRENT_MARGIN_MS = 250;
const MODE = String($argument || "full").replace(/^\"|\"$/g, "").trim().toLowerCase();

function now() {
  return Date.now();
}

function str(v) {
  return String(v == null ? "" : v);
}

function lower(v) {
  return str(v).toLowerCase();
}

function isBuiltIn(name) {
  return !name || name === "DIRECT" || name === "REJECT" || name === POLICY;
}

function apiReachable(status, body) {
  const b = lower(body);

  if (b.indexOf("unsupported_country") !== -1) return false;
  if (b.indexOf("unsupported country") !== -1) return false;
  if (b.indexOf("country, region, or territory") !== -1) return false;

  // 401：已经成功到达 OpenAI API，只是没有 API Key。
  // 429：同样已经到达 OpenAI，只是服务端限流。
  return status === 200 || status === 401 || status === 429;
}

function chatgptReachable(status) {
  return status >= 200 && status < 400;
}

function apiProbe(node) {
  return new Promise((resolve) => {
    const start = now();

    $httpClient.get({
      url: API_URL,
      timeout: REQUEST_TIMEOUT,
      node: node,
      "auto-redirect": false,
      "auto-cookie": false,
      alpn: "h2",
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    }, (error, response, data) => {
      const ms = now() - start;
      const status = response ? response.status : 0;

      resolve({
        ok: !error && apiReachable(status, data),
        ms,
        status,
        error: error ? str(error) : "",
        body: str(data)
      });
    });
  });
}

function chatgptProbe(node) {
  return new Promise((resolve) => {
    const start = now();

    $httpClient.head({
      url: CHATGPT_URL,
      timeout: REQUEST_TIMEOUT,
      node: node,
      "auto-redirect": false,
      "auto-cookie": false,
      alpn: "h2",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36"
      }
    }, (error, response) => {
      const ms = now() - start;
      const status = response ? response.status : 0;

      resolve({
        ok: !error && chatgptReachable(status),
        ms,
        status,
        error: error ? str(error) : ""
      });
    });
  });
}

async function testNode(node) {
  // 两次 API + 一次 ChatGPT，降低偶发成功节点被误选的概率。
  const a1 = await apiProbe(node);
  const w1 = await chatgptProbe(node);
  const a2 = await apiProbe(node);

  const apiSuccess = (a1.ok ? 1 : 0) + (a2.ok ? 1 : 0);
  const webSuccess = w1.ok ? 1 : 0;

  const times = [];
  if (a1.ok) times.push(a1.ms);
  if (w1.ok) times.push(w1.ms);
  if (a2.ok) times.push(a2.ms);

  const avg = times.length
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 99999;

  const jitter = times.length > 1
    ? Math.max.apply(null, times) - Math.min.apply(null, times)
    : 99999;

  const strictOK = apiSuccess === 2 && webSuccess === 1;

  // 抖动权重大于纯延迟，优先照顾 Codex 长连接稳定性。
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
    details: {
      api1: { ok: a1.ok, ms: a1.ms, status: a1.status, error: a1.error },
      chatgpt: { ok: w1.ok, ms: w1.ms, status: w1.status, error: w1.error },
      api2: { ok: a2.ok, ms: a2.ms, status: a2.status, error: a2.error }
    }
  };
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;

      try {
        results[i] = await worker(items[i]);
      } catch (e) {
        results[i] = {
          node: items[i],
          strictOK: false,
          apiSuccess: 0,
          webSuccess: 0,
          avg: 99999,
          jitter: 99999,
          score: 999999,
          error: str(e)
        };
      }
    }
  }

  const workers = [];
  const count = Math.min(limit, items.length);
  for (let i = 0; i < count; i++) workers.push(runner());
  await Promise.all(workers);
  return results;
}

function getCandidateNodes() {
  const candidates = [];

  // 当前 AI 节点也参加比较，避免无意义切换。
  const current = $config.getSelectedPolicy(POLICY);
  if (!isBuiltIn(current)) candidates.push(current);

  // 关键修复：不再调用 getSubPolicies() 展开 Remote Filter。
  // 直接读取各探测组已经选出的真实节点。
  for (const group of PROBE_GROUPS) {
    try {
      const selected = $config.getSelectedPolicy(group);
      if (!isBuiltIn(selected) && selected !== group) {
        candidates.push(selected);
      } else {
        console.log(`${group} 暂未解析出真实节点：${selected}`);
      }
    } catch (e) {
      console.log(`${group} 读取失败：${str(e)}`);
    }
  }

  return candidates.filter((n, i, arr) => n && arr.indexOf(n) === i);
}

function rankEligible(results) {
  const strict = results
    .filter((x) => x && x.strictOK)
    .sort((a, b) => a.score - b.score);

  if (strict.length) return { mode: "严格", list: strict };

  const loose = results
    .filter((x) => x && x.apiSuccess >= 1 && x.webSuccess === 1)
    .sort((a, b) => a.score - b.score);

  return { mode: "宽松", list: loose };
}

function saveResults(results, eligible) {
  try {
    $persistentStore.write(JSON.stringify(results), "ai_node_last_results");
    $persistentStore.write(
      JSON.stringify(eligible.map((x) => ({
        node: x.node,
        avg: x.avg,
        jitter: x.jitter,
        score: Math.round(x.score)
      }))),
      "ai_node_valid_list"
    );
  } catch (e) {
    console.log("保存结果失败：" + str(e));
  }
}

async function fullScan(notifyAlways) {
  const current = $config.getSelectedPolicy(POLICY);
  const nodes = getCandidateNodes();

  if (!nodes.length) {
    throw new Error("没有读取到 AI 探测组候选节点。请先等待各 AI探测* url-test 组完成一次测速。 ");
  }

  console.log("AI候选真实节点：" + JSON.stringify(nodes));
  console.log("当前AI节点：" + current);

  const results = await mapLimit(nodes, CONCURRENCY, testNode);
  const ranked = rankEligible(results);
  const eligible = ranked.list;

  saveResults(results, eligible);

  if (!eligible.length) {
    $notification.post(
      "AI节点检测",
      "没有找到可用节点",
      `已检测 ${nodes.length} 个区域候选节点，但均未通过 OpenAI API + ChatGPT 实测。`
    );
    return;
  }

  const best = eligible[0];
  const currentResult = eligible.find((x) => x.node === current);

  let chosen = best;
  let reason = "选择综合稳定性最佳真实节点";

  if (currentResult && currentResult.score <= best.score + KEEP_CURRENT_MARGIN_MS) {
    chosen = currentResult;
    reason = "当前节点仍属优质节点，保持不变以减少 Codex 重连";
  }

  let switched = true;
  if (chosen.node !== current) {
    switched = $config.getConfig(POLICY, chosen.node);
  }

  const top = eligible.slice(0, 8)
    .map((x, i) => `${i + 1}. ${x.node}｜均值 ${x.avg}ms｜抖动 ${x.jitter}ms`)
    .join("\n");

  console.log("最终选择：" + chosen.node);
  console.log("原因：" + reason);

  if (notifyAlways) {
    $notification.post(
      "AI节点检测完成",
      `${ranked.mode}可用 ${eligible.length}/${nodes.length}`,
      `当前：${chosen.node}\n${reason}\n切换：${switched ? "正常" : "失败"}\n\n${top}`
    );
  }
}

async function guardCurrent() {
  const current = $config.getSelectedPolicy(POLICY);

  if (isBuiltIn(current)) {
    console.log("当前 AI 节点无效，执行候选扫描。 ");
    await fullScan(false);
    return;
  }

  console.log("守护检测当前节点：" + current);
  const result = await testNode(current);

  if (result.strictOK) {
    console.log(`当前节点稳定：${current}｜均值 ${result.avg}ms｜抖动 ${result.jitter}ms`);
    return;
  }

  $notification.post(
    "AI节点守护",
    "当前节点异常",
    `${current} 未通过 OpenAI 稳定性检测，将重新选择候选节点。`
  );

  await fullScan(false);
}

async function main() {
  if (MODE === "guard") {
    await guardCurrent();
  } else {
    await fullScan(true);
  }
}

main()
  .catch((e) => {
    console.log("AI节点检测错误：" + str(e));
    $notification.post("AI节点检测失败", "", str(e));
  })
  .finally(() => $done());
