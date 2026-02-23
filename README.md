# conversion-pipe-to-grid
Markdownファイル内のPipe TableをGrid Tableに変換するプログラム

## 使い方

### 単体ファイルを整形

```bash
node sh/format-grid-table.mjs path/to/file.md
```

### 変更が必要なファイルだけ検出（CI向け）

```bash
node sh/format-grid-table.mjs --check path/to/file.md
```

### `mds` 配下をまとめて処理

```bash
node sh/format-grid-table.mjs --all
```

## Pandoc 変換フローへの組み込みイメージ

運用としては、`docx` 変換の直前にこのスクリプトを挟むだけです。

1. Markdown をパイプテーブルで記述する
2. `sh/format-grid-table.mjs` で Grid Table に整形する
3. Pandoc で `docx` へ変換する

