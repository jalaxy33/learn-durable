# 图片适配：入库前缩到模型的上限

图片有两种进入 transcript 的路径：**人附上的输入**和**工具返回的结果**。两种都要在**提交之前**适配到模型的上限——因为条目不可变、每次请求都要重放，事后再改就等于改写历史、并让 provider 的 prompt cache 全部失效。

## 两个入口

```ts
// ① 宿主的输入：提交前自己调
const photo = await fitImage(bytes, "image/png", imageLimits(model), images);

// ② 工具结果：装一个扩展搞定
registry.install(createFitImagesExtension(images));
```

- `fitImage(bytes, mimeType, limits, processor)` 是纯工具函数，宿主在 `submit` 之前调用。
- `createFitImagesExtension(processor)` 是 `afterTool` 钩子：任何模型调用的工具结果里带图片，都会在提交前被适配，并附一条 `[info]` 诊断。

`read` 工具自己也做同样的事（模型不支持图片时放占位符，支持则按上限缩放）。

## 结果形状

```ts
if (photo.kind === "omitted") throw new Error(photo.note);
const text = ["Compare this photo with the screen.", ...photo.notes].join("\n");
```

`fitImage` 返回带标签的联合：

| 返回 | 含义 |
|---|---|
| `{ kind: "image", image, notes }` | 适配后的图片 + 人类可读的说明 |
| `{ kind: "omitted", note }` | 无法处理，被丢弃 + 原因 |

`notes` 是给模型的定位信息，例如：

```
Resized from 4000x3000 to 1000x750. Multiply coordinates by 4.00 to map them to the original.
```

模型据此把看图得到的像素坐标换算回原图——截图/UI 自动化场景离了这句就没法点东西。

## 上限从哪来

```ts
const model = models.getModel("faux", "faux-1");
imageLimits(model);
```

`imageLimits(model)` 读模型条目的 `inputLimits.images`（这里是 `{ resize: { maxWidth: 1000 } }`），解析成 `read` 用的同一套限制。所以“适配到多少”是模型目录决定的，不是写死的常量。

## 处理器

```ts
const images = await createNodePhotonImages();
```

Photon（WebAssembly）在**worker 线程**里做缩放，大图不会阻塞事件循环；线程空闲 30 秒后退出。同一个处理器给扩展和宿主复用即可。

## 实测

```
status: done
user: "Compare this photo with the screen.\nResized from 4000x3000 to 1000x750. Multiply coordinates by 4.00 …"
user: 1000x750 image/png
tool result: 1000x333 image/png
tool result: "<harness>\n[info] Resized from 3000x1000 to 1000x333. Multiply coordinates by 3.00 …\n</harness>"
```

两点值得注意：

- 4000×3000 → **1000×750**：按宽度上限等比缩放（高度跟着变，不是裁切）。
- 工具结果那条的说明在 `<harness>[info]</harness>` 诊断块里（扩展加的是诊断），而用户输入那条是宿主自己拼进文本的——两种呈现方式，因为一个由框架写、一个由宿主写。

## 为什么不能在请求时临时缩

- 条目一旦提交就不可变，请求时改等于每次请求都不同，provider 的 prompt cache 永远打不中。
- 崩溃恢复后重放的是**存储里的图片**，临时缩放的结果不会被保存，前后不一致。
- 账单按实际发送的像素算，早缩早省钱。

所以规则只有一条：**图片在进入 transcript 之前就已经是最终形态。**

## 类型与语法

- `ImageContent = { type: "image", data: base64, mimeType }`：图片在消息里就是 base64 字符串。
- `UserMessage.content` 是 `string | (TextContent | ImageContent)[]`，取图片要先判 `typeof content === "string"`。
- `Buffer.from(png).toString("base64")`：二进制转 base64（工具输出要的是 base64）。
- 手工造 PNG 的示例代码演示了 PNG 结构：签名 + `IHDR`/`IDAT`/`IEND` 块，每块带 CRC；`size()` 直接按偏移读宽高（`getUint32(16)` / `getUint32(20)`）。
- `fauxProvider({ models: [{ …, input: ["text", "image"], inputLimits: … }] })`：假模型也能声明“支持图片 + 上限”，用来测适配逻辑。
