#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

// Grid Table の「内側セル幅（左右の1スペースを除いた幅）」の目標値。
// 例: 120 の場合、3列テーブルならおおむね 120 文字分を列間で配分する。
const DEFAULT_TARGET_INNER_TABLE_WIDTH = 90;

// 固定列（ダッシュ1個）へ加算する安全マージン。
// Word 側の再レイアウトで列がわずかに縮むケースを緩和するため、最小幅へ上乗せする。
const DEFAULT_FIXED_COLUMN_SAFETY_MARGIN = 2;

// 環境変数 GRID_TABLE_TARGET_INNER_WIDTH があればそれを採用する。
// 無効値（未設定/非数値/0以下）はデフォルト値へフォールバックする。
function resolveTargetInnerTableWidth() {
  const raw = process.env.GRID_TABLE_TARGET_INNER_WIDTH;
  if (!raw) {
    return DEFAULT_TARGET_INNER_TABLE_WIDTH;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_TARGET_INNER_TABLE_WIDTH;
  }
  return parsed;
}

// 環境変数 GRID_TABLE_FIXED_COLUMN_MARGIN があれば固定列マージンへ採用する。
// 無効値（未設定/非数値/負数）はデフォルト値へフォールバックする。
function resolveFixedColumnSafetyMargin() {
  const raw = process.env.GRID_TABLE_FIXED_COLUMN_MARGIN;
  if (!raw) {
    return DEFAULT_FIXED_COLUMN_SAFETY_MARGIN;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_FIXED_COLUMN_SAFETY_MARGIN;
  }
  return parsed;
}

const TARGET_INNER_TABLE_WIDTH = resolveTargetInnerTableWidth();
const FIXED_COLUMN_SAFETY_MARGIN = resolveFixedColumnSafetyMargin();

/*
 * Pipe Table を Grid Table に変換するフォーマッタ。
 *
 * 現在の変換ポリシー:
 * - ダッシュが1個の列は固定列として扱い、内容が1行で収まる最小幅を確保する。
 * - 固定列には安全マージン（既定: +2）を上乗せする。
 * - ダッシュが2個以上の列は可変列として扱い、余剰幅をダッシュ数比で按分する。
 * - 固定列合計が TARGET_INNER_TABLE_WIDTH（既定: 90）を超える場合は表全体を拡張する。
 * - セル内容が列幅を超える場合、列幅は拡張せずセル内で自動改行する。
 * - コードフェンス内の表記は変換対象外にする。
 */

// East Asian Width 相当の判定で、全角として扱う文字かどうかを返す。
// 返値は display width 計算（全角=2、半角=1）に使用する。
function isFullWidthCodePoint(codePoint) {
  if (Number.isNaN(codePoint)) {
    return false;
  }

  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (0x2e80 <= codePoint && codePoint <= 0x3247 && codePoint !== 0x303f) ||
      (0x3250 <= codePoint && codePoint <= 0x4dbf) ||
      (0x4e00 <= codePoint && codePoint <= 0xa4c6) ||
      (0xa960 <= codePoint && codePoint <= 0xa97c) ||
      (0xac00 <= codePoint && codePoint <= 0xd7a3) ||
      (0xf900 <= codePoint && codePoint <= 0xfaff) ||
      (0xfe10 <= codePoint && codePoint <= 0xfe19) ||
      (0xfe30 <= codePoint && codePoint <= 0xfe6b) ||
      (0xff01 <= codePoint && codePoint <= 0xff60) ||
      (0xffe0 <= codePoint && codePoint <= 0xffe6) ||
      (0x1b000 <= codePoint && codePoint <= 0x1b001) ||
      (0x1f200 <= codePoint && codePoint <= 0x1f251) ||
      (0x20000 <= codePoint && codePoint <= 0x3fffd))
  );
}

// 文字列の表示幅を計算する。
// 日本語を含む表で列幅を計算するため、length ではなく表示幅を採用する。
function stringDisplayWidth(text) {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0);
    width += isFullWidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

// 指定幅に満たない場合にのみ右側へ半角スペースを補う。
// 既に targetWidth 以上ならそのまま返す（切り詰めはしない）。
function padToDisplayWidth(text, targetWidth) {
  const width = stringDisplayWidth(text);
  if (width >= targetWidth) {
    return text;
  }
  return `${text}${" ".repeat(targetWidth - width)}`;
}

// エスケープされていない "|" だけでセル分割する。
// 例: "a\\|b|c" -> ["a|b", "c"]
function splitByUnescapedPipe(text) {
  const segments = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "\\" && text[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (char === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

// 1行が Pipe Table の行かどうかを判定して解析する。
// 解析できたら { indent, cells } を返し、解析不可なら null を返す。
function parsePipeRow(line) {
  const trimmedRight = line.replace(/\s+$/u, "");
  const match = trimmedRight.match(/^(\s*)\|(.*)\|$/u);
  if (!match) {
    return null;
  }

  const [, indent, inside] = match;
  const cells = splitByUnescapedPipe(inside).map((cell) => cell.trim());
  if (cells.length < 2) {
    return null;
  }

  return { indent, cells };
}

// Pipe Table の区切り行（--- / :---: など）を解析する。
// ここで得たダッシュ数は「列幅配分の重み」として使う。
// 例: "| - | -- | ---- |" -> [1, 2, 4]
// 想定列数やインデントが一致しない場合は null を返す。
function parsePipeAlignmentRow(line, expectedColumns, expectedIndent) {
  const parsed = parsePipeRow(line);
  if (!parsed || parsed.indent !== expectedIndent) {
    return null;
  }
  if (parsed.cells.length !== expectedColumns) {
    return null;
  }

  const widths = [];
  for (const cell of parsed.cells) {
    const token = cell.trim();
    if (!/^:?-{1,}:?$/u.test(token)) {
      return null;
    }
    const dashCount = (token.match(/-/gu) || []).length;
    widths.push(Math.max(1, dashCount));
  }
  return widths;
}

// Grid Table 側でセル内容に "|" を保持するためエスケープする。
// 例: "a|b" -> "a\\|b"
function normalizeCellText(text) {
  return text.replace(/\|/gu, "\\|");
}

// 文字列を display width ベースで折り返す。
// - 列幅超過時は次行へ送る（列幅拡張しない）
// - 行頭スペースは落とす
// - 各行末の不要スペースは除去する
// 例: maxWidth=6, "abcdefghi" -> ["abcdef", "ghi"]
function wrapTextByDisplayWidth(text, maxWidth) {
  if (maxWidth <= 0) {
    return [text];
  }

  const lines = [];
  let current = "";
  let currentWidth = 0;

  for (const char of text) {
    if (currentWidth === 0 && /\s/u.test(char)) {
      continue;
    }

    const charWidth = stringDisplayWidth(char);
    if (currentWidth > 0 && currentWidth + charWidth > maxWidth) {
      lines.push(current.replace(/\s+$/u, ""));
      current = "";
      currentWidth = 0;
      if (/\s/u.test(char)) {
        continue;
      }
    }

    current += char;
    currentWidth += charWidth;
  }

  if (current.length > 0) {
    lines.push(current.replace(/\s+$/u, ""));
  }

  return lines.length > 0 ? lines : [""];
}

// ヘッダ行と本文行の全セルを走査し、「各列の1行最小必要幅」を返す。
// 返値は inner width（左右スペースは含まない）。
// 例:
//   header=["ID","Name"], rows=[["A0001","山田太郎"],["B2","佐藤"]]
//   -> [5, 8] （表示幅ベース）
function computeContentMaxInnerWidths(headerCells, bodyRows) {
  const columnCount = headerCells.length;
  const maxWidths = Array.from({ length: columnCount }, () => 1);
  const allRows = [headerCells, ...bodyRows];

  for (const row of allRows) {
    for (let col = 0; col < columnCount; col += 1) {
      const normalized = normalizeCellText((row[col] || "").trim());
      const width = Math.max(stringDisplayWidth(normalized), 1);
      if (width > maxWidths[col]) {
        maxWidths[col] = width;
      }
    }
  }

  return maxWidths;
}

// 重み比で幅を配分する。
// 手順:
// 1) まず minWidths を必ず確保する（これ未満にはしない）
// 2) target までの余剰幅を weights 比で配分する
// 3) 小数点端数は「余りが大きい列」から順に 1 ずつ配る
//
// 例:
//   weights=[2,4], minWidths=[10,12], targetTotalWidth=40
//   min合計=22, 余剰=18
//   余剰配分=6:12 なので結果は [16,24]
function allocateWidthsByRatio(weights, minWidths, targetTotalWidth) {
  if (weights.length === 0) {
    return [];
  }

  const safeWeights = weights.map((weight) => Math.max(1, weight));
  const safeMinWidths = minWidths.map((width) => Math.max(1, width));
  const minTotal = safeMinWidths.reduce((sum, value) => sum + value, 0);
  const effectiveTarget = Math.max(targetTotalWidth, minTotal);
  const totalWeight = safeWeights.reduce((sum, value) => sum + value, 0);
  const additionalWidth = effectiveTarget - minTotal;
  const rawAdds = safeWeights.map((weight) => (additionalWidth * weight) / totalWeight);
  const addFloors = rawAdds.map((value) => Math.floor(value));
  const widths = safeMinWidths.map((width, index) => width + addFloors[index]);
  let usedAdditional = addFloors.reduce((sum, value) => sum + value, 0);

  if (usedAdditional < additionalWidth) {
    const indices = safeWeights
      .map((weight, index) => ({
        index,
        fraction: rawAdds[index] - Math.floor(rawAdds[index]),
        weight,
      }))
      .sort((left, right) => {
        if (right.fraction !== left.fraction) {
          return right.fraction - left.fraction;
        }
        if (right.weight !== left.weight) {
          return right.weight - left.weight;
        }
        return left.index - right.index;
      })
      .map((item) => item.index);

    let cursor = 0;
    while (usedAdditional < additionalWidth) {
      widths[indices[cursor % indices.length]] += 1;
      usedAdditional += 1;
      cursor += 1;
    }
  }

  return widths;
}

// 解析済み Pipe Table（header + body）から Grid Table 文字列群を生成する。
// 生成ルール:
// - ダッシュ数1の列は固定列: 内容が1行で収まる最小幅を確保する
//   （さらに安全マージンを加える）
// - ダッシュ数2以上の列は可変列: 余剰幅をダッシュ数比で配分する
// - 固定列合計がターゲット幅を超えた場合は表全体を拡張する
// - 全列が固定列の場合も、余剰幅は全列へ等分して表全体を広げる
// - Grid 罫線幅は innerWidth + 前後スペース2
// - 各セルは列幅を超えたら wrapTextByDisplayWidth で折り返す
// - 各データ行は必要な行数ぶん縦に展開して出力する
//
// 例:
//   区切り行が "| - | -- | ---- |" の場合
//   - 1列目は固定列（内容1行最小幅 + 安全マージン）
//   - 2/3列目は可変列（重み 2:4 で余剰配分）
function buildGridTable(indent, headerCells, bodyRows, baseWidths) {
  const columnCount = headerCells.length;
  const dashCounts = Array.from({ length: columnCount }, (_, col) => Math.max(baseWidths[col] || 1, 1));
  const contentMaxInnerWidths = computeContentMaxInnerWidths(headerCells, bodyRows);
  const innerWidths = Array.from({ length: columnCount }, () => 1);
  const fixedColumns = [];
  const flexColumns = [];

  for (let col = 0; col < columnCount; col += 1) {
    if (dashCounts[col] === 1) {
      fixedColumns.push(col);
    } else {
      flexColumns.push(col);
    }
  }

  // 固定列は「その列の内容が1行で収まる最小幅 + 安全マージン」を先に確保する。
  for (const col of fixedColumns) {
    innerWidths[col] = contentMaxInnerWidths[col] + FIXED_COLUMN_SAFETY_MARGIN;
  }

  if (flexColumns.length === 0) {
    // 全列固定（全て "-" 1個）のケース。
    // 最小幅を維持しつつ、余剰幅は全列へ等分して表全体を広げる。
    const fixedMinWidths = contentMaxInnerWidths.map((width) => width + FIXED_COLUMN_SAFETY_MARGIN);
    const allWeights = Array.from({ length: columnCount }, () => 1);
    const expandedFixedWidths = allocateWidthsByRatio(
      allWeights,
      fixedMinWidths,
      TARGET_INNER_TABLE_WIDTH,
    );
    for (let col = 0; col < columnCount; col += 1) {
      innerWidths[col] = expandedFixedWidths[col];
    }
  } else {
    // 可変列があるケース。
    // 固定列で必要幅を確保した残りを、可変列へ重み配分する。
    // 可変列ヘッダは1行表示を保証するため、ヘッダ幅を最小幅として使う。
    const fixedTotal = fixedColumns.reduce((sum, col) => sum + innerWidths[col], 0);
    const flexMinWidths = flexColumns.map((col) =>
      Math.max(stringDisplayWidth(normalizeCellText((headerCells[col] || "").trim())), 1),
    );
    const minFlexTotal = flexMinWidths.reduce((sum, width) => sum + width, 0);
    const effectiveTarget = Math.max(TARGET_INNER_TABLE_WIDTH, fixedTotal + minFlexTotal);
    const flexTotalTarget = effectiveTarget - fixedTotal;
    const flexWeights = flexColumns.map((col) => dashCounts[col]);
    const flexWidths = allocateWidthsByRatio(flexWeights, flexMinWidths, flexTotalTarget);

    flexColumns.forEach((col, index) => {
      innerWidths[col] = flexWidths[index];
    });
  }

  const widths = innerWidths.map((innerWidth) => Math.max(innerWidth + 2, 3));

  // 罫線生成。fill は "-" (通常罫線) か "=" (見出し下罫線)。
  const border = (fill) => `${indent}+${widths.map((w) => fill.repeat(w)).join("+")}+`;

  // 1行分の cells を、折り返しを考慮した複数行の Grid Table 行へ変換する。
  const rowLines = (cells) => {
    const wrappedColumns = cells.map((cell, index) => {
      const normalized = normalizeCellText((cell || "").trim());
      const innerWidth = Math.max(widths[index] - 2, 1);
      return wrapTextByDisplayWidth(normalized, innerWidth);
    });

    const lineCount = wrappedColumns.reduce((max, columnLines) => Math.max(max, columnLines.length), 1);
    const lines = [];

    for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
      const segments = wrappedColumns.map((columnLines, index) => {
        const innerWidth = Math.max(widths[index] - 2, 1);
        const value = columnLines[lineIndex] || "";
        return ` ${padToDisplayWidth(value, innerWidth)} `;
      });
      lines.push(`${indent}|${segments.join("|")}|`);
    }

    return lines;
  };

  const lines = [];
  lines.push(border("-"));
  lines.push(...rowLines(headerCells));
  lines.push(border("="));

  for (const row of bodyRows) {
    lines.push(...rowLines(row));
    lines.push(border("-"));
  }

  return lines;
}

// startIndex から Pipe Table の連続ブロックを検出して Grid Table へ変換する。
// 検出条件:
// - 1行目: 通常行（|...|）
// - 2行目: 区切り行（---）
// - 3行目以降: 同列数の本文行が1行以上
// 変換成功時は「次に読む index」と「変換後行群」を返す。
// 条件を満たさない場合は null を返し、通常行として扱わせる。
function tryConvertPipeTable(lines, startIndex) {
  const header = parsePipeRow(lines[startIndex] || "");
  if (!header) {
    return null;
  }

  const alignWidths = parsePipeAlignmentRow(
    lines[startIndex + 1] || "",
    header.cells.length,
    header.indent,
  );
  if (!alignWidths) {
    return null;
  }

  const rows = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length) {
    const parsed = parsePipeRow(lines[cursor]);
    if (!parsed || parsed.indent !== header.indent || parsed.cells.length !== header.cells.length) {
      break;
    }
    rows.push(parsed.cells);
    cursor += 1;
  }

  if (rows.length === 0) {
    return null;
  }

  return {
    nextIndex: cursor,
    convertedLines: buildGridTable(header.indent, header.cells, rows, alignWidths),
  };
}

// コードフェンス開始判定。
// "```" と "~~~" の両方を許容し、種類と長さを記録する。
function shouldOpenFence(line) {
  const match = line.match(/^\s*(`{3,}|~{3,})/u);
  if (!match) {
    return null;
  }
  const marker = match[1];
  return { markerChar: marker[0], markerLength: marker.length };
}

// 現在のフェンス状態に対する終了判定。
// 開始と同じ記号で、同じ長さ以上の単独行のみを終了とみなす。
function shouldCloseFence(line, fenceState) {
  if (!fenceState) {
    return false;
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.startsWith(fenceState.markerChar)) {
    return false;
  }
  let count = 0;
  while (count < trimmed.length && trimmed[count] === fenceState.markerChar) {
    count += 1;
  }
  const rest = trimmed.slice(count).trim();
  return count >= fenceState.markerLength && rest.length === 0;
}

// ファイル内容全体を走査して Pipe Table を Grid Table へ変換する。
// 走査ルール:
// - 改行コード（LF/CRLF）は入力に合わせて保持する
// - コードフェンス内は変換対象外にする
// - 変換で内容が変わった場合だけ changed=true を返す
//
// つまり、通常文章はそのまま通し、表ブロックだけを置き換える。
function convertTables(content) {
  const hasCrlf = content.includes("\r\n");
  const eol = hasCrlf ? "\r\n" : "\n";
  const hasFinalEol = content.endsWith("\n");
  const normalized = content.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");

  const output = [];
  let index = 0;
  let fenceState = null;
  let changed = false;

  while (index < lines.length) {
    const line = lines[index];

    if (fenceState) {
      output.push(line);
      if (shouldCloseFence(line, fenceState)) {
        fenceState = null;
      }
      index += 1;
      continue;
    }

    const openFence = shouldOpenFence(line);
    if (openFence) {
      fenceState = openFence;
      output.push(line);
      index += 1;
      continue;
    }

    const convertedPipe = tryConvertPipeTable(lines, index);
    if (convertedPipe) {
      output.push(...convertedPipe.convertedLines);
      if (
        convertedPipe.convertedLines.length !== convertedPipe.nextIndex - index ||
        convertedPipe.convertedLines.some((value, i) => value !== lines[index + i])
      ) {
        changed = true;
      }
      index = convertedPipe.nextIndex;
      continue;
    }

    output.push(line);
    index += 1;
  }

  let result = output.join(eol);
  if (hasFinalEol) {
    result += eol;
  }

  return { content: result, changed };
}

// 指定ディレクトリ配下の .md を再帰収集する（--all 用）。
function collectMarkdownFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

// CLI 引数から変換対象ファイルを決定する。
// - --all 指定時: mds 配下の .md 全件
// - それ以外: オプションを除いた引数をファイルパスとして解決
function resolveTargets(args) {
  if (args.includes("--all")) {
    return collectMarkdownFiles(path.resolve("mds"));
  }

  return args
    .filter((arg) => !arg.startsWith("--"))
    .map((target) => path.resolve(target))
    .filter((target) => fs.existsSync(target) && fs.statSync(target).isFile());
}

// エントリポイント。
// 動作モード:
// - 通常: 変換結果をファイルへ書き戻す
// - --check: 書き戻さず、差分があれば exit 1 を返す
function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const targets = resolveTargets(args);

  if (targets.length === 0) {
    console.log("format-grid-table: target .md files not found.");
    process.exit(0);
  }

  const changedFiles = [];
  for (const filePath of targets) {
    const original = fs.readFileSync(filePath, "utf8");
    const converted = convertTables(original);
    if (!converted.changed) {
      continue;
    }
    changedFiles.push(filePath);
    if (!checkMode) {
      fs.writeFileSync(filePath, converted.content, "utf8");
    }
  }

  if (changedFiles.length > 0) {
    const prefix = checkMode ? "format-grid-table: needs format" : "format-grid-table: formatted";
    for (const filePath of changedFiles) {
      console.log(`${prefix}: ${path.relative(process.cwd(), filePath)}`);
    }
  }

  if (checkMode && changedFiles.length > 0) {
    process.exit(1);
  }
}

main();
