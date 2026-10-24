// tests/setup/no-proxy.ts — 坑 46：全局 fetch 会遵循 HTTP(S)_PROXY 环境变量，
// 开发机的（可能是坏的）代理会让 127.0.0.1 的 hub 单测以 "fetch failed / bad port" 挂掉。
// 测试进程统一剥掉代理变量；必须在任何 fetch 发生前执行（setupFiles 时点满足）。
for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
  delete process.env[k];
}
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
