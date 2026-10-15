## 个人综合版本：上游 1.4.1 与长文解析优化

当前自用来源分支：personal/all-in-one，已同步上游 dev 的 5d5d9cb（1.4.1，2026-10-15）。保留 hidePopupAutomatically=false、skipFurigana=true、个人显示名称及缓存/长文调度优化。API 请求采用上游分阶段超时：等待响应头 10 秒、下载停滞 15 秒、下载总上限 300 秒；每次收到数据都会重置停滞计时，停滞最多额外重试一次，整体最多三次尝试。原超时输入框已移除，旧 jitenApiTimeout 配置忽略，不覆盖 API Key 或其他已保存设置。贡献分支及已有 PR 不变。

本地仓库：D:\Documents\Github\JitenReader；Chrome 构建目录：D:\Documents\Github\JitenReader\jiten.reader。个人源码发布到 [Tainiraito/JitenReader](https://github.com/Tainiraito/JitenReader) 的 personal/* 分支；构建产物及 node_modules 仅保留本地。独立贡献工作目录位于 D:\Documents\Github\JitenReader-configurable-timeout。旧安装目录仅保留 jiten.reader 的兼容链接，现有 Chrome 安装可继续重新加载。

### 长文缓存与调度

- 稳定数据与学习状态分离：缓存段落 token 偏移及词典释义；复习、标记词汇和词库操作仅刷新相关词汇状态。没有明确词汇范围的操作刷新全部状态，但保留解析结果。
- IndexedDB 持久化：后台工作线程休眠、刷新页面、重新加载扩展和关闭浏览器后仍可恢复内容；词典按服务/解析版本去重。磁盘数据约 64 MiB 上限，按最近使用淘汰，内存约 8 MiB / 2000 段上限。大小为序列化数据估算，不等于浏览器数据库物理文件大小。
- 稳定数据无固定时间过期：相同服务地址、解析版本和完整文本可复用。学习状态按账户/配置档隔离，5 分钟后或收到变更时，通过 reader/lookup-vocabulary 刷新。重启后台后状态首次使用也需轻量查询，不重新调用 reader/parse。账户凭据仅在缓存命名空间中使用 SHA-256 摘要，内容缓存不保存明文 API Key 或学习状态。
- Ttsu 自动解析优先处理与视口相交的完整段落，每批最多 12 段、目标 3000 UTF-8 字节，逐批显示。停留 800ms 后预加载邻近未显示内容，每批最多 3 段、目标 600 字节。后台可见内容优先于排队的预加载；纯缓存命中不等待网络批次间隔。翻页取消旧页面等待，已发出的请求可能完成并填充缓存。

段落是最小缓存和提交单位：跨屏段落会完整提交，单个超长段落允许超过批次目标，保证 token 偏移一致。Ttsu 分页模式只挂载当前章节，因此预加载当前章的后续段落；连续阅读模式可处理已挂载的后续章节。不会主动切章下载未挂载内容。其他阅读器仍沿用原触发机制，后台使用小批次和共享缓存。

Ttsu 空白预处理保持幂等，高亮渲染完成后再确认该批次完成。词汇在其他设备上的修改最迟在下次使用且状态超过 5 分钟时查询；当前页面已显示的颜色不会仅因时间经过自动更新。

内容缓存保存书籍段落和词典结果，仅存在本地。数据库为 jiten-parser-content-v2。需要强制重新解析时，可在扩展后台 DevTools 的 Application → IndexedDB 中删除该数据库，再重新加载扩展并刷新阅读页；一般复习无需清空它。卸载扩展也会删除其本地数据。存储不可用时退回内存缓存。

### Chrome 错误排查

重新加载扩展后，已打开页面中的旧 content script 会失效，可能记录 Extension context invalidated；随后刷新全部已打开的 Ttsu 阅读页。Chrome 的扩展错误列表会保留历史记录，可点击“全部清除”后重新测试；清除错误记录不会删除解析缓存。

停止语音播放现在先检查 offscreen 播放页面，缺少接收方时直接结束，并处理页面关闭竞态，避免未捕获的消息拒绝。截图中无调用栈的 Receiving end does not exist 不足以确认唯一来源，此修复覆盖代码中确认的一处缺口。解析响应头等待与响应体下载超时包含接口名、对应阶段的固定秒数和阶段；超时仍可能由网络或服务处理引起，需结合新错误和 Network Timing 判断。

### 验证与试用

node --test --test-isolation=none scripts/parse-cache.test.cjs scripts/api-timeout.test.cjs：28 项全部通过，包括原缓存覆盖、上游注音与缓存组合以及五项分阶段超时测试。全仓 ESLint 通过，Chrome 构建成功。完整 TypeScript 检查为 20 项既有诊断，最新上游为 23 项，对比无新增；TYPECHECK-UPSTREAM.txt 已更新到本次上游基线。

综合版设置页使用实际构建产物在隔离 Chrome 中验证：超时输入框移除、个人默认值保留、已保存 API Key 与显示设置保持、旧超时值无影响，以及桌面/390px 手机布局均通过，无相关页面错误。实际 TtsuParser、段落读取、高亮、调度和 IndexedDB 组合验证了同一容器 ID 的 TXT 内容替换、章节返回、横竖排翻页、浏览器重启缓存恢复和磁盘 LRU。扩展接口及 API 使用模拟数据；记录位于 ../JitenReader-validation/上游同步-2026-10-15。

独立 Chrome 的 Ttsu 布局测试使用真实段落读取、高亮、调度及 IndexedDB 实现，API 返回模拟数据：横排/竖排翻页、1→2→1 缓存复用、浏览器重启恢复、词典去重及磁盘 LRU 均通过，无页面脚本错误。测试没有调用用户账户或线上 Jiten API；用户真实书籍与网络环境仍待验收。详情见 LONG-TEXT-VALIDATION.md。

在 chrome://extensions 重新加载自定义扩展，再刷新 Ttsu。依次检查首次可见文字、下一页、第 2 章→第 1 章、复习一个词后返回，以及关闭/重新开启 Chrome。已缓存内容不应重复调用 reader/parse；状态失效时可能调用 reader/lookup-vocabulary。首次进入、文本变更、版本变更或 LRU 淘汰后仍会解析。

构建：npm ci，然后 npm run build chrome。可加载目录为本仓库的 jiten.reader。保持目录位置固定；先停用商店版，开启 Chrome 开发者模式后加载此目录，并在自定义版填写自己的 API Key。两个版本设置独立，不要同时启用。

---

# Jiten Reader

A browser extension to parse Japanese texts anywhere, get your coverage and keep track of words you know, powered by [Jiten](https://jiten.moe).

This extension is a fork of [Kagu-chan's Anki JPDB Reader](https://github.com/Kagu-chan/anki-jpdb.reader) which is itself a fork of [JPDB Web Reader extension](https://github.com/max-kamps/jpd-breader). It is not associated with their authors in any way.

![Screenshot](store/screenshot_01.jpg)

## Contents

- [Jiten Reader](#jiten-reader)
  - [Contents](#contents)
  - [Downloads](#downloads)
  - [Features](#features)
    - [Please note:](#please-note)
  - [Custom parsers](#custom-parsers)
  - [Installation](#installation)
    - [Chrome](#chrome)
    - [Firefox](#firefox)
  - [Setup](#setup)
  - [Usage](#usage)
  - [Customize parsing](#customize-parsing)
  - [Customize text colors and furigana](#customize-text-colors-and-furigana)
  - [Integrating with other extensions](#integrating-with-other-extensions)
  - [Building](#building)
  - [Contributing](#contributing)
  - [License](#license)

## Downloads

* [Chrome (Browser Extension) for Chromium-based browsers](https://chromewebstore.google.com/detail/jiten-reader/fkegmlkjkenojfiplaclhlmncfeooaeo)
* [Firefox (Browser Extension) for Firefox and Firefox Android](https://addons.mozilla.org/en-US/firefox/addon/jiten-reader/)
* [All Releases](https://github.com/Sirush/JitenReader/releases)



Thanks to Kagu-chan, Max, and all of those that contributed to the original projects and made a solid foundation for this fork!

## Features
- Parse Japanese text on any website and supported apps including ttsu reader and asbplayer
- View the coverage of the content you're currently engaging with
- Keep track of the words you know and review them
- Customise the theme to your liking
- Easily switch profile to support multiple users or presets

### Please note:

* Currently, only Chromium-based browsers and Firefox (including Android) are supported.
* This extension is able to run on mobile devices as reported by users, but this usage is not officially supported.
* Custom parsers and support for specific websites in general can break because of 3rd party changes. Please report any issues you encounter.

## Custom parsers

Some web apps and sites require special attention to work properly; therefore, they parse automatically on certain triggers. These can be disabled or extended in the settings.

| App                                                  | URLs                                                                                                                                                                                                                                                                                       |
|------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [ッツ Reader](https://github.com/ttu-ttu/ebook-reader) | [reader.ttsu.app](https://reader.ttsu.app), [ttu-ebook.web.app](https://ttu-ebook.web.app)                                                                                                                                                                                                 |
| Mokuro                                               | [reader.mokuro.app](https://reader.mokuro.app)                                                                                                                                                                                                                                             |
| Yatsu Reader                                         | [app.yatsu.moe](https://app.yatsu.moe)                                                                                                                                                                                                                                                     |
| Texthooker pages                                     | [anacreondjt texthooker](https://anacreondjt.gitlab.io/texthooker.html), [learnjapanese.moe texthooker](https://learnjapanese.moe/texthooker.html), [exSTATic tracker](https://kamwithk.github.io/exSTATic/tracker.html), [renji-xd texthooker](https://renji-xd.github.io/texthooker-ui/), [Kizuna Texthooker](https://kizuna-texthooker-ui.app) |
| Mokuro (Legacy)                                      | [Mokuro](https://github.com/kha-white/mokuro): **IMPORTANT**: File path must contain `mokuro`, and file name must end in `.html`                                                                                                                                                           |
| Readwok                                              | [app.readwok.com](https://app.readwok.com/)                                                                                                                                                                                                                                                |
| Satori Reader                                        | [satorireader.com](https://www.satorireader.com/)                                                                                                                                                                                                                                          |
| NHK News (web easy)                                  | [news.web.nhk/newsweb](https://news.web.nhk/newsweb/) and [news.web.nhk/news/easy](https://news.web.nhk/news/easy/)                                                                                                                                                                        |
| Wikipedia                                            | [ja.wikipedia.org](https://ja.wikipedia.org/)                                                                                                                                                                                                                                              |
| Bunpro                                               | [bunpro.jp](https://bunpro.jp) (Experimental)                                                                                                                                                                                                                                              |
| asbplayer                                            | [github.com/killergerbah/asbplayer](https://github.com/killergerbah/asbplayer)                                                                                                                                                                                                             |
| JPDB Custom Dictionaries                             | [CDM by Nakura Nakamoto](https://gitlab.com/nakura/jpdb_cdm)                                                                                                                                                                                                                               |
| LunaTranslator                                       | [Luna Translator](https://docs.lunatranslator.org/en/) with WebView2 enabled                                                                                                                                                                                                               |

## Installation

### Chrome

[Chrome Browser Extension](https://chromewebstore.google.com/detail/jiten-reader/fkegmlkjkenojfiplaclhlmncfeooaeo) **or**

1. Download the latest `*-chromium.zip` file from the releases page.
2. Unpack the zip file in a location of your choosing.
3. Open your browser and navigate to `chrome://extensions/`.
4. Enable `Developer mode` (top right).
5. Click the `Load unpacked` button (top left).
6. In the file picker dialog, navigate to the folder you unpacked earlier. You should see a file called `manifest.json` inside the folder.
7. Click select/open/choose to exit the dialog and load the extension.
8. Continue with the [Setup](#setup) section.

### Firefox

[Firefox Browser Extension](https://addons.mozilla.org/en-US/firefox/addon/jiten-reader/), or install it via Firefox for Android **or**

1. Download the latest `-firefox.xpi` file from the releases page.
2. Open your browser and navigate to `about:debugging`.
3. Click on `This Firefox`, then `Load Temporary Add-on`.
4. In the file picker dialog, navigate to the folder where you downloaded the xpi file.
5. Click select/open/choose to exit the dialog and load the extension.
6. Continue with the [Setup](#setup) section.

Please note that if you use the manual setup, the extension will be unloaded the next time you open Firefox. Your settings will be preserved. This is only for testing and debugging!

## Setup

Upon installation, the settings page will open. You can also find it by clicking on the reader icon (読) in the browser menu bar. It might be hidden behind the extension overflow menu, which looks like a little puzzle piece (🧩).

Here you will need to enter your Jiten API key. It can be found at the very bottom of the [Jiten settings page](https://jiten.moe/settings).  
You can also change various hotkeys.

Jiten API requests use upstream timeouts: 10 seconds until response headers, 15 seconds without download progress, and a 300-second overall body download cap. Progress resets the stall timer; a stalled download can retry once within the three-attempt limit. The former personal timeout setting has been removed; stored values are ignored. Audio playback retains its separate timeout.

## Usage

You can use the reader on any website. Just select some text, right-click, and choose the "Jiten Reader > Parse Election" option. Alternatively, use the shortcut (Alt+P) or the extension menu at the top right corner.

Words will be colored according to their state (known, new, etc.). Hover over words while holding Shift to see their meaning, and to mine or review them.

## Customize parsing

Parsing can be enabled or disabled per integration. You can also add custom URLs to automatically parse in the settings.

Additionally, you can add complete meta definitions in JSON format - refer to [the typings](https://github.com/Sirush/JitenReader/blob/dev/src/shared/host-meta/public-api.ts) or see [the docs](docs/custom-meta.md)

## Customize text colors and furigana

Customization is currently done with custom CSS, as it is the simplest way to offer a flexible framework. [See the docs on it here](docs/custom-css.md).

## Integrating with other extensions

JitenReader broadcasts events (word interactions, mining, grading, parsing) to the page via `window.postMessage`, so other extensions and userscripts can react to them. [See the page events docs](docs/page-events.md).

## Building

Node version 22.x is used!

You can run the following commands to build the extension locally:

```sh
npm install
npm run build
```

The resulting files will be located in the `jiten.reader/` folder.

For development, you can also run the build in watch mode:

```sh
npm install
npm run watch
```

This will continuously rebuild the source code as it changes, and place the output in the `jiten.reader/` folder.
It can be loaded as an unpacked extension from there.
Please remember to wait until building is done, and reload the extension on the "Manage Extensions" page before testing your changes.

Reloading is not required for the browser popup (top right) or the settings page.

Also, please look at the [Contributing](#contributing) section if you plan on contributing your changes.

## Contributing

Issues with feedback or ideas for new features are very welcome. Don't be afraid to join [Jiten's Discord server](https://discord.gg/cZWM7b4wzk) and ask there!

The following commands may be of interest to you:

* `npm run lint`: Checks your code for formatting issues, linter warnings, and type errors. The CI also runs this, so your pull request will only be accepted if it passes. You can use eslint ignore comments if you get false positives, but leave a comment explaining why you think the error is false and safe to ignore.
* `npm run lint:fix`: Reformats your code, as well as fixing any fixable lint issues. Note: if your editor has a `prettier` plugin, installing that and turning on "format on save" will be more convenient.
* `npm run build`: Compiles the code for Chrome, putting the compiled code into `jiten.reader/`.
* `npm run build [target]`: Builds for a specific target.
* `npm run watch`: Automatically recompiles the code for Chrome when it changes, putting the output into `jiten.reader/`. Using this is recommended during development.
* `npm run watch [target]`: Recompiles for the specified target.
* `npm run pack`: Builds, then packs the extension for all targets. The archives are placed inside `packages/`.
* `npm run pack [target, [target...]]`: Builds for specified targets.

Currently, `chrome|chromium` and `firefox` are supported.

## License

[MIT](https://choosealicense.com/licenses/mit/)

This project uses [Font Awesome 4](https://fontawesome.com/v4.7.0/), which is licensed under the [MIT License](https://opensource.org/licenses/MIT). Please ensure compliance with its license when using or distributing this project.
