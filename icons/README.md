# 图标

**这四个 PNG 是正式图标**，不是占位图了。它们是从
[`doubak-website`](https://github.com/Doubak/doubak-website) 的
`assets/logos/` 复制过来的字节副本——那边是这套标识的唯一来源，
连同 SVG 母版与生成脚本 `gen_logo.py` 一起放在那里。

| 这里 | 来自 |
|---|---|
| `16.png` | `assets/logos/icon-16.png` |
| `32.png` | `assets/logos/icon-32.png` |
| `48.png` | `assets/logos/icon-48.png` |
| `128.png` | `assets/logos/icon-128.png` |

文件名保持 `<尺寸>.png` 不变，因为 `manifest.json`（`icons` 与
`action.default_icon`）和 `src/ui/notify.js` 的 `iconUrl` 都按这个名字引用。
要更新，就照上表重新复制一遍，别在这里改图。

## 几件要知道的事

- **MV3 只收 PNG。** SVG 在这里不行，所以这四个是光栅化好的成品。
- **四个尺寸都不带「豆」字。** 它们出自小号／中号母版：48px 下那个字最细的一笔
  不足一个设备像素，糊成一团反而更难认。带字的版本只用在 128px 以上的展示场合。
- **别用 cairosvg 重新光栅化。** 母版里定义了多个 mask，cairosvg 会静默忽略它们，
  产出一个看起来还行、但豆脐没了、两颗豆糊在一起的图。要重新生成就用 `rsvg-convert`，
  细节见来源仓库的 `assets/logos/README.md`。
- **`tools/make-icons.py` 已经没用了。** 它是当初用纯 zlib 画占位图的脚本，
  留着只会让人以为图标还是从它生成的。

原来那条设计要求仍然成立，也是这套图标满足的：16px 下认得出来、深浅主题都看得清、
不使用豆瓣的商标或配色到会引起混淆的程度——这是第三方工具，不是豆瓣官方产品。
