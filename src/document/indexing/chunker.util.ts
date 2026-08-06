import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface ChunkOptions {
  /** 单块最大字符数，默认 800 */
  chunkSize?: number;
  /** 相邻块重叠字符数，默认 100 */
  overlap?: number;
}

/**
 * LangChain 递归字符分片（Markdown 友好分隔符优先级）。
 * 分隔顺序：段落 → 换行 → 句子标点 → 空白 → 逐字
 */
export async function chunkMarkdown(
  text: string,
  options: ChunkOptions = {},
): Promise<string[]> {
  const chunkSize = options.chunkSize ?? 800;
  const chunkOverlap = Math.min(
    options.overlap ?? 100,
    Math.floor(chunkSize / 2),
  );
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: [
      '\n\n',
      '\n',
      '。',
      '！',
      '？',
      '；',
      '.',
      '!',
      '?',
      ';',
      ' ',
      '',
    ],
  });

  const chunks = await splitter.splitText(normalized);
  return chunks.map((c) => c.trim()).filter(Boolean);
}
