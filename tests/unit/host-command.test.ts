// tests/unit/host-command.test.ts
/**
 * src/host/command.ts 单元测试：command 图床 + 两种用户扩展方式 + 图床注册表。
 *
 * 覆盖（配置错误路径全部按机器可读 code 断言，绝不静默回退默认图床）：
 * - CommandHost：模板占位符（{file} 暂存路径 / {name} 文件名）、stdout 提取 URL、
 *   非零退出 / 无 URL 输出 / 超时 → HOST_UPLOAD_FAILED；check 模板退出码语义、
 *   未配置 check 模板时回退 HTTP 探测；
 * - 配置声明（loadDeclaredHosts / parseDeclaredHosts / createHostFromConfig）：
 *   四种内置类型同一接口构造；缺 command / 缺 s3 字段 / 缺 dir / 未知字段 /
 *   未知 type / hosts 非对象 / 坏 YAML / 保留 id / 空声明名 → HOST_CONFIG_INVALID；
 * - 插件加载（loadPluginHosts）：ESM 与 CJS 模块同一接口；未实现接口 / 语法错误 /
 *   占用保留 id → HOST_PLUGIN_INVALID / HOST_PLUGIN_LOAD_FAILED；
 * - 注册表（listHosts / resolveHost）：内置 + 配置 + 插件合并，id 冲突报错，
 *   找不到 id → HOST_NOT_FOUND。
 *
 * 子进程命令统一用 `node -e`（vitest 本身跑在 node 上，PATH 必有 node），
 * 走真实 shell（Windows cmd / POSIX sh），子进程路径与真实用法一致。
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PackError } from '../../src/pack/packyaml.js';
import { CommandHost, createHostFromConfig, loadDeclaredHosts, loadPluginHosts, listHosts, resolveHost } from '../../src/host/command.js';
import { LocalHost } from '../../src/host/local.js';
import { S3Host } from '../../src/host/s3.js';
import { SteamCloudHost } from '../../src/host/steamcloud.js';
import type { File } from '../../src/host/types.js';

// ---------------------------------------------------------------------------
// 临时目录 / 环境变量 / HTTP 服务器管理
// ---------------------------------------------------------------------------

let tempRoot: string;
let savedHttpsProxy: string | undefined;
let savedHTTPS_PROXY: string | undefined;

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), 'tts-toolkit-command-test-'));
  savedHttpsProxy = process.env.https_proxy;
  savedHTTPS_PROXY = process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTPS_PROXY;
});

afterEach(async () => {
  if (savedHttpsProxy === undefined) delete process.env.https_proxy;
  else process.env.https_proxy = savedHttpsProxy;
  if (savedHTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = savedHTTPS_PROXY;
  await rm(tempRoot, { recursive: true, force: true });
});

/** 起一个本地 HTTP 服务器，返回基址与关闭函数 */
async function listen(handler: http.RequestListener): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 断言 fn 抛出指定 code 的 PackError */
async function expectHostError(fn: () => Promise<unknown> | unknown, code: string): Promise<PackError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackError);
    const packError = err as PackError;
    expect(packError.code).toBe(code);
    expect(packError.message.length).toBeGreaterThan(0);
    return packError;
  }
  throw new Error(`预期抛出 code=${code} 的 PackError，但调用成功了`);
}

const oneFile: File[] = [{ name: 'atlas-101.png', data: Buffer.from('atlas-bytes') }];

// ---------------------------------------------------------------------------
// CommandHost：上传
// ---------------------------------------------------------------------------

describe('CommandHost.upload', () => {
  it('构造时缺 command 模板 → HOST_CONFIG_INVALID', async () => {
    await expectHostError(() => new CommandHost({}), 'HOST_CONFIG_INVALID');
    await expectHostError(() => new CommandHost({ command: '   ' }), 'HOST_CONFIG_INVALID');
  });

  it('{name} 占位符展开，stdout 的 URL 作为上传结果', async () => {
    const host = new CommandHost({ id: 'my-cdn', command: `node -e "console.log('https://cdn.test/{name}')"` });
    const results = await host.upload(oneFile, {});
    expect(results).toEqual([
      { file: 'atlas-101.png', status: 'uploaded', url: 'https://cdn.test/atlas-101.png' },
    ]);
  });

  it('{file} 占位符指向暂存文件，内容与入参一致', async () => {
    const host = new CommandHost({
      command: `node -e "const fs=require('fs'); if (fs.readFileSync(process.argv[1],'utf8')==='atlas-bytes') console.log('https://ok.test/content')" "{file}"`,
    });
    const results = await host.upload(oneFile, {});
    expect(results[0]?.url).toBe('https://ok.test/content');
  });

  it('stdout 没有 http(s) URL → HOST_UPLOAD_FAILED', async () => {
    const host = new CommandHost({ command: `node -e "console.log('nothing to see')"`, id: 'no-url' });
    const err = await expectHostError(() => host.upload(oneFile, {}), 'HOST_UPLOAD_FAILED');
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('命令非零退出（stderr 有内容）→ HOST_UPLOAD_FAILED', async () => {
    const host = new CommandHost({ command: `node -e "console.error('boom'); process.exit(2)"`, id: 'fail' });
    await expectHostError(() => host.upload(oneFile, {}), 'HOST_UPLOAD_FAILED');
  });

  it('命令超时 → HOST_UPLOAD_FAILED（不挂死）', async () => {
    const host = new CommandHost({ command: `node -e "setTimeout(()=>{}, 60000)"`, id: 'slow' });
    await expectHostError(() => host.upload(oneFile, { timeoutMs: 800 }), 'HOST_UPLOAD_FAILED');
  });

  it('多文件按序逐个上传；重名 → HOST_INVALID_INPUT', async () => {
    const host = new CommandHost({ command: `node -e "console.log('https://cdn.test/{name}')"` });
    const results = await host.upload(
      [
        { name: 'a.png', data: Buffer.from('1') },
        { name: 'b.png', data: Buffer.from('2') },
      ],
      {},
    );
    expect(results.map((r) => r.url)).toEqual(['https://cdn.test/a.png', 'https://cdn.test/b.png']);

    await expectHostError(
      () => host.upload(
        [
          { name: 'a.png', data: Buffer.from('1') },
          { name: 'a.png', data: Buffer.from('2') },
        ],
        {},
      ),
      'HOST_INVALID_INPUT',
    );
  });
});

// ---------------------------------------------------------------------------
// CommandHost：存活检测
// ---------------------------------------------------------------------------

describe('CommandHost.check', () => {
  it('配置了 check 模板：退出码 0 → 存活；非 0 → 不存活（不抛错）', async () => {
    const okHost = new CommandHost({ command: 'node -e ""', check: `node -e "process.exit(0)"` });
    await expect(okHost.check('https://x.test/a.png')).resolves.toMatchObject({ alive: true });

    const failHost = new CommandHost({ command: 'node -e ""', check: `node -e "console.error('down'); process.exit(3)"` });
    const dead = await failHost.check('https://x.test/a.png');
    expect(dead.alive).toBe(false);
    expect(dead.error).toBeTruthy();
  });

  it('check 模板的 {url} 占位符会被替换', async () => {
    const host = new CommandHost({
      command: 'node -e ""',
      check: `node -e "process.exit(process.argv[1]==='https://x.test/real.png'?0:1)" "{url}"`,
    });
    await expect(host.check('https://x.test/real.png')).resolves.toMatchObject({ alive: true });
    await expect(host.check('https://x.test/other.png')).resolves.toMatchObject({ alive: false });
  });

  it('未配置 check 模板 → 回退 HTTP 探测', async () => {
    const server = await listen((req, res) => {
      res.statusCode = req.url === '/good' ? 200 : 404;
      res.end();
    });
    try {
      const host = new CommandHost({ command: 'node -e ""' });
      await expect(host.check(`${server.base}/good`)).resolves.toMatchObject({ alive: true, status: 200 });
      await expect(host.check(`${server.base}/bad`)).resolves.toMatchObject({ alive: false });
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 配置声明：loadDeclaredHosts / parseDeclaredHosts / createHostFromConfig
// ---------------------------------------------------------------------------

describe('loadDeclaredHosts（配置声明）', () => {
  it('配置文件不存在 → 空数组（未声明不是错误）', async () => {
    await expect(loadDeclaredHosts(path.join(tempRoot, 'missing.yaml'))).resolves.toEqual([]);
  });

  it('四种内置类型走同一接口构造；声明名作为图床 id', async () => {
    const configPath = path.join(tempRoot, 'config.yaml');
    await writeFile(
      configPath,
      [
        'hosts:',
        '  my-cloud:',
        '    type: steamcloud',
        '  my-cdn:',
        '    type: command',
        '    command: "node -e \\"console.log(\'https://cdn.test/{name}\')\\""',
        '  my-disk:',
        '    type: local',
        `    dir: ${JSON.stringify(tempRoot)}`,
        '  my-s3:',
        '    type: s3',
        '    endpoint: https://example.r2.cloudflarestorage.com',
        '    region: auto',
        '    bucket: bkt',
        '    access_key_id: AKID',
        '    secret_access_key: SECRET',
        '',
      ].join('\n'),
      'utf8',
    );

    const hosts = await loadDeclaredHosts(configPath);
    expect(hosts).toHaveLength(4);
    expect(hosts[0]).toBeInstanceOf(SteamCloudHost);
    expect(hosts[0]?.id).toBe('my-cloud');
    expect(hosts[1]).toBeInstanceOf(CommandHost);
    expect(hosts[1]?.id).toBe('my-cdn');
    expect(hosts[2]).toBeInstanceOf(LocalHost);
    expect(hosts[2]?.id).toBe('my-disk');
    expect(hosts[3]).toBeInstanceOf(S3Host);
    expect(hosts[3]?.id).toBe('my-s3');

    // 同一接口直接可用：command 声明实例真的能上传
    const results = await (hosts[1] as CommandHost).upload(oneFile, {});
    expect(results[0]?.url).toBe('https://cdn.test/atlas-101.png');
  });

  it('type command 缺 command 模板 → HOST_CONFIG_INVALID', async () => {
    const configPath = path.join(tempRoot, 'config.yaml');
    await writeFile(configPath, 'hosts:\n  my-cdn:\n    type: command\n', 'utf8');
    await expectHostError(() => loadDeclaredHosts(configPath), 'HOST_CONFIG_INVALID');
  });

  it('type s3 缺必填字段 → HOST_CONFIG_INVALID（detail 列出字段）', async () => {
    const configPath = path.join(tempRoot, 'config.yaml');
    await writeFile(configPath, 'hosts:\n  my-s3:\n    type: s3\n    endpoint: https://x\n', 'utf8');
    const err = await expectHostError(() => loadDeclaredHosts(configPath), 'HOST_CONFIG_INVALID');
    expect(err.message).toContain('region');
  });

  it('type local 缺 dir → HOST_CONFIG_INVALID', async () => {
    const configPath = path.join(tempRoot, 'config.yaml');
    await writeFile(configPath, 'hosts:\n  my-disk:\n    type: local\n', 'utf8');
    await expectHostError(() => loadDeclaredHosts(configPath), 'HOST_CONFIG_INVALID');
  });

  it('未知 type / 未知字段 / hosts 非对象 / 空 / 保留 id / 空 名 → HOST_CONFIG_INVALID', async () => {
    const cases: Array<[string, string]> = [
      ['未知 type', 'hosts:\n  weird:\n    type: imgur\n'],
      ['未知字段（严格 schema）', 'hosts:\n  my-cdn:\n    type: command\n    command: x\n    comand: typo\n'],
      ['hosts 是字符串', 'hosts: not-an-object\n'],
      ['hosts 是数组', 'hosts:\n  - a\n'],
      ['保留 id steamcloud', 'hosts:\n  steamcloud:\n    type: local\n    dir: /tmp\n'],
      ['声明名为空', 'hosts:\n  "":\n    type: local\n    dir: /tmp\n'],
      ['声明值不是对象', 'hosts:\n  my-cdn: just-a-string\n'],
    ];
    for (const [label, yaml] of cases) {
      const configPath = path.join(tempRoot, `case-${label}.yaml`);
      await writeFile(configPath, yaml, 'utf8');
      await expectHostError(() => loadDeclaredHosts(configPath), 'HOST_CONFIG_INVALID');
    }
  });

  it('配置文件不是合法 YAML → HOST_CONFIG_INVALID', async () => {
    const configPath = path.join(tempRoot, 'broken.yaml');
    await writeFile(configPath, 'hosts: [unclosed\n  bad::: {yaml', 'utf8');
    await expectHostError(() => loadDeclaredHosts(configPath), 'HOST_CONFIG_INVALID');
  });

  it('配置根不是键值对象 → HOST_CONFIG_INVALID', async () => {
    const configPath = path.join(tempRoot, 'list.yaml');
    await writeFile(configPath, '- just\n- a\n- list\n', 'utf8');
    await expectHostError(() => loadDeclaredHosts(configPath), 'HOST_CONFIG_INVALID');
  });
});

// ---------------------------------------------------------------------------
// 插件加载：loadPluginHosts
// ---------------------------------------------------------------------------

describe('loadPluginHosts（插件加载）', () => {
  it('目录不存在 → 空数组（没装插件不是错误）', async () => {
    await expect(loadPluginHosts(path.join(tempRoot, 'no-such-dir'))).resolves.toEqual([]);
  });

  it('ESM 插件（export default）加载后与内置图床同接口可用', async () => {
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(
      path.join(hostsDir, 'plug-esm.js'),
      [
        'export default {',
        '  id: "plug-esm",',
        '  async upload(files) {',
        '    return files.map((f) => ({ file: f.name, status: "uploaded", url: "https://plug.test/" + f.name }));',
        '  },',
        '  async check(url) { return { alive: true }; },',
        '  capabilities() { return { deletable: false }; },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const hosts = await loadPluginHosts(hostsDir);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.id).toBe('plug-esm');
    const results = await (hosts[0] as CommandHost).upload(oneFile, {});
    expect(results[0]).toEqual({ file: 'atlas-101.png', status: 'uploaded', url: 'https://plug.test/atlas-101.png' });
    await expect(hosts[0]?.check('https://x.test/a')).resolves.toMatchObject({ alive: true });
    expect(hosts[0]?.capabilities()).toEqual({ deletable: false });
  });

  it('CJS 插件（module.exports）同样可加载', async () => {
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(
      path.join(hostsDir, 'plug-cjs.cjs'),
      [
        'module.exports = {',
        '  id: "plug-cjs",',
        '  async upload(files) {',
        '    return files.map((f) => ({ file: f.name, status: "uploaded", url: "https://cjs.test/" + f.name }));',
        '  },',
        '  async check(url) { return { alive: false, error: "no" }; },',
        '  capabilities() { return { deletable: true }; },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const hosts = await loadPluginHosts(hostsDir);
    expect(hosts[0]?.id).toBe('plug-cjs');
    const results = await (hosts[0] as CommandHost).upload(oneFile, {});
    expect(results[0]?.url).toBe('https://cjs.test/atlas-101.png');
  });

  it('非 .js 系文件被忽略', async () => {
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(path.join(hostsDir, 'readme.md'), '# not a plugin\n', 'utf8');
    await writeFile(path.join(hostsDir, 'notes.txt'), 'nope\n', 'utf8');
    await expect(loadPluginHosts(hostsDir)).resolves.toEqual([]);
  });

  it('未实现 ImageHost 接口 → HOST_PLUGIN_INVALID（detail 指出缺失成员）', async () => {
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(path.join(hostsDir, 'broken.js'), 'export default { id: "broken" };\n', 'utf8');
    const err = await expectHostError(() => loadPluginHosts(hostsDir), 'HOST_PLUGIN_INVALID');
    expect(err.message).toContain('upload');
    expect(err.message).toContain('check');
    expect(err.message).toContain('capabilities');
  });

  it('模块语法错误 → HOST_PLUGIN_LOAD_FAILED', async () => {
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(path.join(hostsDir, 'syntax.js'), 'export default {\n', 'utf8');
    await expectHostError(() => loadPluginHosts(hostsDir), 'HOST_PLUGIN_LOAD_FAILED');
  });

  it('插件占用保留 id steamcloud → HOST_PLUGIN_INVALID', async () => {
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(
      path.join(hostsDir, 'evil.js'),
      [
        'export default {',
        '  id: "steamcloud",',
        '  async upload(files) { return []; },',
        '  async check(url) { return { alive: true }; },',
        '  capabilities() { return { deletable: false }; },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    await expectHostError(() => loadPluginHosts(hostsDir), 'HOST_PLUGIN_INVALID');
  });
});

// ---------------------------------------------------------------------------
// 注册表：listHosts / resolveHost
// ---------------------------------------------------------------------------

describe('listHosts / resolveHost（内置 + 配置 + 插件，同一接口）', () => {
  it('内置 steamcloud 永远在列；配置与插件按来源合并', async () => {
    const configPath = path.join(tempRoot, 'config.yaml');
    await writeFile(configPath, 'hosts:\n  my-disk:\n    type: local\n    dir: /tmp\n', 'utf8');
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(
      path.join(hostsDir, 'plug.js'),
      [
        'export default {',
        '  id: "plug",',
        '  async upload(files) { return []; },',
        '  async check(url) { return { alive: true }; },',
        '  capabilities() { return { deletable: false }; },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const entries = await listHosts({ configPath, hostsDir });
    expect(entries.map((entry) => [entry.source, entry.host.id])).toEqual([
      ['builtin', 'steamcloud'],
      ['config', 'my-disk'],
      ['plugin', 'plug'],
    ]);
  });

  it('配置与插件 id 冲突 → HOST_CONFIG_INVALID（绝不静默覆盖）', async () => {
    const configPath = path.join(tempRoot, 'config.yaml');
    await writeFile(configPath, 'hosts:\n  clash:\n    type: local\n    dir: /tmp\n', 'utf8');
    const hostsDir = path.join(tempRoot, 'hosts');
    await mkdir(hostsDir);
    await writeFile(
      path.join(hostsDir, 'clash.js'),
      [
        'export default {',
        '  id: "clash",',
        '  async upload(files) { return []; },',
        '  async check(url) { return { alive: true }; },',
        '  capabilities() { return { deletable: false }; },',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    await expectHostError(() => listHosts({ configPath, hostsDir }), 'HOST_CONFIG_INVALID');
  });

  it('resolveHost：内置 / 声明 / 插件都能按 id 取到；未知 id → HOST_NOT_FOUND（不回退默认图床）', async () => {
    const configPath = path.join(tempRoot, 'config.yaml');
    await writeFile(configPath, 'hosts:\n  my-disk:\n    type: local\n    dir: /tmp\n', 'utf8');
    const opts = { configPath, hostsDir: path.join(tempRoot, 'empty-hosts') };

    const builtin = await resolveHost('steamcloud', opts);
    expect(builtin).toBeInstanceOf(SteamCloudHost);
    expect(builtin.id).toBe('steamcloud');

    const declared = await resolveHost('my-disk', opts);
    expect(declared).toBeInstanceOf(LocalHost);
    expect(declared.id).toBe('my-disk');

    const err = await expectHostError(() => resolveHost('no-such-host', opts), 'HOST_NOT_FOUND');
    expect(err.message).toContain('no-such-host');
  });

  it('resolveHost 空 id → HOST_INVALID_INPUT；createHostFromConfig 直接构造同一接口', async () => {
    await expectHostError(() => resolveHost('   ', {}), 'HOST_INVALID_INPUT');

    const host = createHostFromConfig('my-cdn', {
      type: 'command',
      command: `node -e "console.log('https://cdn.test/{name}')"`,
    });
    expect(host.id).toBe('my-cdn');
    const results = await host.upload(oneFile, {});
    expect(results[0]?.url).toBe('https://cdn.test/atlas-101.png');
  });

  it('resolveHost 找到的声明实例可真的完成 check（HTTP 探测走本地服务器）', async () => {
    const server = await listen((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    try {
      const configPath = path.join(tempRoot, 'config.yaml');
      await writeFile(
        configPath,
        ['hosts:', '  my-cdn:', '    type: command', '    command: "node -e \\"\\""', ''].join('\n'),
        'utf8',
      );
      const host = await resolveHost('my-cdn', { configPath, hostsDir: path.join(tempRoot, 'no-hosts') });
      await expect(host.check(`${server.base}/ok`)).resolves.toMatchObject({ alive: true });
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 防御性检查：子进程拿到的暂存文件真实存在（防止模板用例静默空转）
// ---------------------------------------------------------------------------

describe('测试自身健全性', () => {
  it('暂存写入真实发生（命令校验暂存文件存在后才输出 URL）', async () => {
    const host = new CommandHost({
      command: `node -e "const fs=require('fs'); if (!fs.existsSync(process.argv[1])) process.exit(9); console.log('https://ok.test/staged')" "{file}"`,
    });
    const results = await host.upload(oneFile, {});
    expect(results[0]?.url).toBe('https://ok.test/staged');
  });
});
