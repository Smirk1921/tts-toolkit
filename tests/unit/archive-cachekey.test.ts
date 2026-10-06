// tests/unit/archive-cachekey.test.ts
/**
 * src/archive/cachekey.ts 单元测试：TTS 素材缓存键（sanitize(url)）。
 *
 * 核心约束（方案设计 §12.2）：sanitize 必须与 TTS 的 `CustomCache.ConvertURL`
 * **逐字符一致**——这是 `.ttsmod` 自包含的全部原理（JSON 里 URL 一个字不改，
 * 靠文件名命中本地缓存），错一个字符接收方就命中不了缓存。
 *
 * 验证策略（全部用真实 URL 钉死）：
 * - 3 份第三方真实 `.ttsmod` 样本（**仓库不自带**，见下方"夹具获取"）里的实测
 *   条目名作为金标准：`sanitize(url) + 扩展名` 必须与样本里的条目名 **逐字符相等**；
 * - 直接读真实样本 ZIP，断言「已知 URL 算出的条目名」确实出现在样本条目里；
 * - 字符类全覆盖 + 幂等性 + 非法输入边界的纯函数行为。
 *
 * 夹具获取：
 * - 设环境变量 `TTS_FIXTURE_DIR` 指向含 `s_dial.ttsmod` 等样本的目录；或
 * - 在 `<repo>/tests/fixtures/` 下手动放置样本（目录已 gitignore）。
 * 两者皆无时，依赖真实夹具的用例自动 skip，纯函数测试不受影响。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cacheFileName, sanitizeUrl } from '../../src/archive/cachekey.js';
import { readZip } from '../../src/archive/ttsmod.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_DIR_CANDIDATES = [
  process.env.TTS_FIXTURE_DIR,
  path.resolve(__dirname, '..', 'fixtures'),
].filter((p): p is string => typeof p === 'string' && p.length > 0);

const FIXTURE_DIR: string | undefined = FIXTURE_DIR_CANDIDATES.find((p) =>
  existsSync(path.join(p, 's_dial.ttsmod')),
);

/** 依赖真实夹具的 describe：无夹具时自动 skip */
const describeFixture = FIXTURE_DIR ? describe : describe.skip;

describeFixture('sanitizeUrl 与 TTS 实测条目逐字符一致（真实 URL）', () => {
  it('s_dial.ttsmod 的图片条目：dial-12-0.jpg（大小写保留，-/ 恒去除）', () => {
    // 实测条目：Mods/Images/httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg.jpg
    expect(sanitizeUrl('https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0.jpg')).toBe(
      'httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg',
    );
  });

  it('s_hex.ttsmod 的图片条目：UV.png（大写字母 UV 原样保留）', () => {
    // 实测条目：Mods/Images/httpnikulaswebscomUVpng.png
    expect(sanitizeUrl('http://nikulas.webs.com/UV.png')).toBe('httpnikulaswebscomUVpng');
  });

  it('sample_diceset.ttsmod 的模型条目：pastebin 查询串 URL（?i= 恒去除）', () => {
    // 实测条目：Mods/Models/httppastebincomrawphpicDn7Eum6.obj
    expect(sanitizeUrl('http://pastebin.com/raw.php?i=cDn7Eum6')).toBe(
      'httppastebincomrawphpicDn7Eum6',
    );
  });

  it('缓存键 + 扩展名拼出的条目名确实存在于真实样本 ZIP 中', () => {
    const zip = readZip(readFileSync(path.join(FIXTURE_DIR!, 's_dial.ttsmod')));
    const expected = cacheFileName(
      'https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0.jpg',
      'jpg',
    );
    expect(zip.some((e) => e.name === `Mods/Images/${expected}`)).toBe(true);
  });
});

describe('sanitizeUrl 字符类全覆盖', () => {
  it('A-Z a-z 0-9 全保留', () => {
    const ascii = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    expect(sanitizeUrl(ascii)).toBe(ascii);
  });

  it('URL 常见符号全部去除（: / ? # [ ] @ ! $ & \' ( ) * + , ; = ~ % . - _）', () => {
    expect(sanitizeUrl('https://user:pw@host.name/a_b~c.d?e=f&g=h#frag')).toBe(
      'httpsuserpwhostnameabcdefghfrag',
    );
  });

  it('空格、中文等非 ASCII 一并去除（ASCII 字母数字判定，见模块头注释）', () => {
    expect(sanitizeUrl('http://ex.com/图 片.png')).toBe('httpexcompng');
  });

  it('幂等：sanitize 的输出再 sanitize 不变（输出只含字母数字）', () => {
    const once = sanitizeUrl('https://host/a-B_1.c?d=e');
    expect(sanitizeUrl(once)).toBe(once);
  });

  it('空字符串返回空字符串', () => {
    expect(sanitizeUrl('')).toBe('');
  });
});

describe('cacheFileName 拼缓存文件名', () => {
  it('扩展名不带点：sanitize(url) + "." + ext', () => {
    expect(cacheFileName('https://raw.githubusercontent.com/DasUmlaut/TTSLibrary/master/dials/dial-12-0.jpg', 'jpg')).toBe(
      'httpsrawgithubusercontentcomDasUmlautTTSLibrarymasterdialsdial120jpg.jpg',
    );
  });

  it('扩展名已带点时幂等（防御调用方写法差异）', () => {
    expect(cacheFileName('http://host/a', '.png')).toBe('httphosta.png');
  });

  it('PDF 的大写约定原样保留（不强行小写）', () => {
    expect(cacheFileName('http://host/rules', 'PDF')).toBe('httphostrules.PDF');
  });
});
