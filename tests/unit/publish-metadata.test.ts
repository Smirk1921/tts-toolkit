// tests/unit/publish-metadata.test.ts
/**
 * src/publish/metadata.ts 单元测试：Steam Web API 免 key 元数据读取。
 *
 * 网络边界：`vi.mock("undici")` 把 undici.fetch 换成 vi.fn()，按用例注入
 * 假响应（全局 Response 构造 JSON / 非 JSON / 非 200）或假拒绝（ENOTFOUND / ETIMEDOUT），
 * **绝不真实请求 Steam API**。
 *
 * 覆盖：
 * - fetchPublishedFileDetails：请求构造（端点 / POST / urlencoded body / 超时信号）、
 *   result=1 正常返回、result=9 → PUBLISH_ITEM_PRIVATE、result=其他 → PUBLISH_API_ERROR、
 *   非 200 → PUBLISH_API_ERROR、fetch 拒绝 → PUBLISH_NETWORK_ERROR（cause 保留）、
 *   响应体非 JSON → PUBLISH_API_ERROR、字段缺失补默认值、数字/字符串互窜归一化；
 * - checkItemUpdated：time_updated > / == / < sinceTimestamp、无 sinceTimestamp、
 *   参数透传与错误传播。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";

import { PackError } from "../../src/pack/packyaml.js";
import { checkItemUpdated, fetchPublishedFileDetails } from "../../src/publish/metadata.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));

const fetchMock = vi.mocked(fetch);

// ---------------------------------------------------------------------------
// 假响应构造（Node 全局 Response，与 undici.fetch 的返回同源）
// ---------------------------------------------------------------------------

/** §2.1 实测字段示例（已按 PublishedFileDetails 声明的类型） */
const SAMPLE_DETAILS = {
  publishedfileid: "2955382975",
  result: 1, // 条目级 result：1=公开可用，9=私有/无权限（窗口 G / Stage D 实测响应形状）
  creator: "76561198090643758",
  creator_app_id: 286160,
  consumer_app_id: 286160,
  filename: "WorkshopUpload",
  file_size: "1215208",
  file_url: "https://cdn.steampusercontent.com/ugc/2294086688335777316/3273/",
  preview_url: "https://images.steamusercontent.com/ugc/2053119138828986501/C10A/",
  title: "第七大陆-蜘蛛脚本增强版",
  description: "完整简介",
  time_created: 1680275775,
  time_updated: 1707226111,
  visibility: 0,
  banned: 0,
  ban_reason: "",
  subscriptions: 779,
  favorited: 14,
  lifetime_subscriptions: 1020,
  tags: [{ tag: "Card Games" }, { tag: "Scripted" }],
};

/** 构造 JSON 假响应 */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** 构造 result=1 的正常假响应（可覆盖条目详情） */
function okResponse(details: Record<string, unknown> = SAMPLE_DETAILS): Response {
  return jsonResponse({ response: { result: 1, resultcount: 1, publishedfiledetails: [details] } });
}

/** 断言 promise 抛出指定 code 的 PackError，并返回它供进一步断言 */
async function expectPackError(promise: Promise<unknown>, code: string): Promise<PackError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    expect((err as PackError).code).toBe(code);
    return err as PackError;
  }
  throw new Error(`期望抛出 PackError("${code}")，但成功返回了`);
}

/** 取第 n 次调用的 RequestInit（测试内都传了 init） */
function callInit(n = 0): RequestInit {
  const init = fetchMock.mock.calls[n]?.[1];
  if (init === undefined) throw new Error(`第 ${n} 次调用没有 RequestInit`);
  return init;
}

beforeEach(() => {
  fetchMock.mockReset();
});

// ---------------------------------------------------------------------------
// fetchPublishedFileDetails
// ---------------------------------------------------------------------------

describe("fetchPublishedFileDetails", () => {
  it("用 POST + urlencoded body 请求 GetPublishedFileDetails v1 端点，并带超时信号", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    await fetchPublishedFileDetails({ itemId: "2955382975" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/",
    );
    const init = callInit();
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init.body ?? ""));
    expect(body.get("itemcount")).toBe("1");
    expect(body.get("publishedfileids[0]")).toBe("2955382975");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("result=1 时返回归一化后的 details（number 形式的 itemId 同样可用）", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    const details = await fetchPublishedFileDetails({ itemId: 2955382975 });

    // normalizeDetails 不透传条目级 result 字段（它是判定元数据，不是 details 本身），
    // 所以期望里去掉它再深度比较（窗口 G / Stage D 修复后的契约）
    const { result: _result, ...expectedDetails } = SAMPLE_DETAILS;
    expect(details).toEqual(expectedDetails);
    // body 里用的也是这个条目 ID
    const body = new URLSearchParams(String(callInit().body ?? ""));
    expect(body.get("publishedfileids[0]")).toBe("2955382975");
  });

  it("result=9（条目私有/无权限）时抛 PUBLISH_ITEM_PRIVATE", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        response: {
          result: 1,
          resultcount: 1,
          publishedfiledetails: [{ publishedfileid: "12345", result: 9 }],
        },
      }),
    );

    await expectPackError(fetchPublishedFileDetails({ itemId: "12345" }), "PUBLISH_ITEM_PRIVATE");
  });

  it("result=其他值（如 42）时抛 PUBLISH_API_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ response: { result: 42 } }));

    await expectPackError(fetchPublishedFileDetails({ itemId: "12345" }), "PUBLISH_API_ERROR");
  });

  it("非 200 响应时抛 PUBLISH_API_ERROR（不尝试解析响应体）", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

    await expectPackError(fetchPublishedFileDetails({ itemId: "12345" }), "PUBLISH_API_ERROR");
  });

  it("fetch 拒绝（ENOTFOUND）时抛 PUBLISH_NETWORK_ERROR，cause 保留原始错误", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND api.steampowered.com"), { code: "ENOTFOUND" });
    fetchMock.mockRejectedValueOnce(cause);

    const err = await expectPackError(fetchPublishedFileDetails({ itemId: "12345" }), "PUBLISH_NETWORK_ERROR");
    expect(err.cause).toBe(cause);
  });

  it("200 但响应体不是 JSON 时抛 PUBLISH_API_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>502 Bad Gateway</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );

    await expectPackError(fetchPublishedFileDetails({ itemId: "12345" }), "PUBLISH_API_ERROR");
  });

  it("result=1 但没有条目详情时抛 PUBLISH_API_ERROR", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ response: { result: 1, resultcount: 0, publishedfiledetails: [] } }));

    await expectPackError(fetchPublishedFileDetails({ itemId: "12345" }), "PUBLISH_API_ERROR");
  });

  it("字段缺失时补默认值（subscriptions=0、file_size=0、tags/preview_url 缺省）", async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ publishedfileid: "12345", result: 1 }));

    const details = await fetchPublishedFileDetails({ itemId: "12345" });

    expect(details).toEqual({
      publishedfileid: "12345",
      creator: "",
      creator_app_id: 0,
      consumer_app_id: 0,
      filename: "",
      file_size: "0",
      file_url: "",
      title: "",
      description: "",
      time_created: 0,
      time_updated: 0,
      visibility: 0,
      banned: 0,
      ban_reason: "",
      subscriptions: 0,
      favorited: 0,
      lifetime_subscriptions: 0,
    });
  });

  it("数字/字符串互窜的字段按声明类型归一化（§2.1 实测 file_size 是字符串）", async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ ...SAMPLE_DETAILS, subscriptions: "779", file_size: 1215208, time_updated: "1707226111" }),
    );

    const details = await fetchPublishedFileDetails({ itemId: "2955382975" });

    expect(details.subscriptions).toBe(779);
    expect(details.file_size).toBe("1215208");
    expect(details.time_updated).toBe(1707226111);
    expect(details.tags).toEqual([{ tag: "Card Games" }, { tag: "Scripted" }]);
  });
});

// ---------------------------------------------------------------------------
// checkItemUpdated
// ---------------------------------------------------------------------------

describe("checkItemUpdated", () => {
  it("time_updated > sinceTimestamp 时返回 updated: true，并带上完整 details", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    const result = await checkItemUpdated({ itemId: "2955382975", sinceTimestamp: 1700000000 });

    expect(result.updated).toBe(true);
    expect(result.timeUpdated).toBe(1707226111);
    expect(result.details.publishedfileid).toBe("2955382975");
    expect(result.details.title).toBe(SAMPLE_DETAILS.title);
  });

  it("time_updated == / < sinceTimestamp 时返回 updated: false", async () => {
    // ==：时间戳相同视为未更新
    fetchMock.mockResolvedValueOnce(okResponse());
    const equal = await checkItemUpdated({ itemId: "2955382975", sinceTimestamp: 1707226111 });
    expect(equal.updated).toBe(false);

    // <：远端比本地旧
    fetchMock.mockResolvedValueOnce(okResponse());
    const older = await checkItemUpdated({ itemId: "2955382975", sinceTimestamp: 1800000000 });
    expect(older.updated).toBe(false);
  });

  it("无 sinceTimestamp 时无法比较，直接返回 updated: true", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());

    const result = await checkItemUpdated({ itemId: "2955382975" });

    expect(result.updated).toBe(true);
    expect(result.timeUpdated).toBe(1707226111);
  });

  it("itemId / timeoutMs 透传给底层请求，错误原样传播为 PUBLISH_NETWORK_ERROR", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));

    const err = await expectPackError(
      checkItemUpdated({ itemId: "777", timeoutMs: 1234 }),
      "PUBLISH_NETWORK_ERROR",
    );
    expect(err.cause).toBeInstanceOf(Error);

    const init = callInit();
    expect(new URLSearchParams(String(init.body ?? "")).get("publishedfileids[0]")).toBe("777");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
