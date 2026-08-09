# 界面里用的标识

**字节副本，来源是 [`doubak-website`](https://github.com/Doubak/doubak-website)
的 `assets/logos/`** —— 那边是这套标识的唯一来源，连同 SVG 母版与生成脚本
`gen_logo.py` 一起。要更新就照下表重新复制一遍，别在这里改图。

| 这里 | 来自 | 用在 |
|---|---|---|
| `logo.svg` | `assets/logos/doubak-icon-mid.svg` | 面板页眉 |
| `logo-large.svg` | `assets/logos/doubak-icon.svg` | 需要大尺寸的场合 |

## 为什么这里是 SVG，而 `icons/` 那四个是 PNG

**MV3 的 `manifest.json` 只收 PNG**（工具栏图标、扩展管理页那些）。但面板本身
就是一张普通网页，`<img src="assets/logo.svg">` 完全正常 —— 而且它在任意缩放、
任意 DPI 下都清晰，不必为每个尺寸各存一份。

两处引用的是**同一套图形的不同产物**，所以看起来是一致的；但它们各自复制、
各自更新，别指望改一个另一个会跟着变。
