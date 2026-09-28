# GitHub 发布说明

建议仓库名：`pixiv-bookmark-classifier`

建议描述：`Plan category coverage across your Pixiv bookmarks, inspect gaps, verify tag capacity and keep updating saved classifications. 中文 / 日本語 / English.`

## 上传源码

1. 解压 `pixiv-bookmark-classifier-github.zip`。解压后可直接看到 README、用户脚本、测试和文档。
2. 在 GitHub 新建仓库，填写名字、描述及可见性。如果导入这份现成目录，不必另外初始化 README。
3. 上传解压后的文件及子目录。上传源码时不要只把整份 ZIP 作为唯一文件提交。
4. 查看首页的英文 README，并检查中文和日文链接。
5. 当前没有代你选定分发许可证。如要授权他人使用、修改或分发，在仓库中添加你选定的 `LICENSE`，并同步 README 与 `package.json` 的说明。

本包没有配置指向未知仓库的 `@updateURL`、`@downloadURL`、`@homepageURL` 或 `@supportURL`。仓库建好后再填写真实地址；不要修改基础 `@name` 或 `@namespace`，以保留已有安装的数据身份。

参考：[GitHub 新建仓库说明](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)。

## 验证与安装包

用 Node.js 20 或更新版本，在源码根目录运行：

```sh
npm test
```

测试不需要 npm 依赖、Pixiv 登录或真实收藏数据。需要重新生成安装包时运行：

```sh
python3 scripts/package.py
```

安装包生成到 `dist/pixiv-bookmark-analyzer-install.zip`，根目录只包含一个 `.user.js`。用户可在 Tampermonkey 导入这个安装包；GitHub 源码 ZIP 用于分发仓库源码。

## 发布 v0.4.0

可将 GitHub Release 标题和标签设为 `v0.4.0`，附上 `dist` 中的安装 ZIP 及根目录的 `.user.js`。仓库自动生成的源码下载供开发者使用。

可使用下面的发布摘要：

> Discover a compact category set across your readable Pixiv bookmarks, inspect coverage and uncovered works, then check tag capacity before appending. Keep original bookmarks, tags and visibility, verify the result, and reuse saved rules for later updates. Version 0.4.0 adds English and Japanese UI with browser-language detection and remembered manual selection. Includes three-language documentation and offline regression tests.

发布前在自己的已安装条目上替换为 0.4.0，刷新后切换三种语言，确认原分类参数仍在即可。此前 0.3.0 的实际运行已验证追加与保留核对；0.4.0 的自动化验证是模拟页面测试，没有替代本机浏览器的显示检查。

## 公开附件范围

本源码包按明确文件清单打包，只含程序、文档、安装包和模拟测试。个人收藏导出、项目参数与执行日志均不在其中。

`pixiv-classification-project*.json`、`pixiv-bookmark-records*.json` 和 `parameters*.txt` 可能包含个人收藏信息，不要作为公开样例上传。报告问题时，可提供版本、浏览器、界面语言、错误代码和删去个人数据的截图。
