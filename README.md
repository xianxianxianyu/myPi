# myPi

我自己的 pi 扩展集合。**一个子目录一个独立包**，各自有 `package.json`、文档和测试，
互不依赖；根目录只做索引。

```
myPi/
├── myPi-wire-trim/     # 历史推理不再上传（before_provider_request）
└── …                   # 后续
```

## 清单

| 包 | 一句话 | 接缝 | 状态 |
|---|---|---|---|
| [myPi-wire-trim](myPi-wire-trim/) | 请求发出前删掉历史 assistant 的 cot，只省传输，不碰上下文 | `before_provider_request` | 可用 |

## 装入

每个子包独立安装，互不影响：

```bash
pi install /path/to/myPi/myPi-wire-trim
```

或在 `~/.pi/agent/settings.json` 的 `packages` 里指向具体子目录：

```json
{ "packages": ["../../Desktop/project/myPi/myPi-wire-trim"] }
```

> 指向集合根目录不会生效：根目录没有 `package.json`。

## 约定

新增一个包时保持这几条不变：

- 子目录名 = 包名（`package.json` 的 `name`）
- `package.json` 里声明 `pi.extensions`
- `README.md` 开头直接说"解决什么问题"，细节进 `docs/`
- `npm run check` 能在子目录内单独跑通（typecheck + 测试）
- 不跨包 import：每个包都能单独拷走

## License

MIT
