/**
 * 子句切分器（Route A 确定性核心）。
 *
 * 反推维度正文天然是逗号/分号/顿号分隔的描述子句链；切分后模型只做
 * 「按用户意图选子句索引」，不做改写——保真且可被确定性校验。
 * 切分粒度偏细（如英文 "A young, androgynous person" 会切成两段）时，
 * 模型多选相邻子句即可还原，不构成正确性问题。
 *
 * 规则：
 *  - 分隔符：中英文逗号/分号、顿号、换行；句号仅在后随空白或行尾时切（避免拆 3.5 这类小数）。
 *  - 切分后吞掉前导连接词（and / or / 以及 / 和 / 与 / 还有）。
 */

const SEPARATORS = /[,，;；、\n]+|\.\s+|。\s*/;
// 词边界必须：否则 "androgynous" 会被剥掉前缀 "and"。
const LEADING_CONJUNCTION = /^(?:and\b|or\b|with\b|以及|和|与|还有)\s*/i;

export function splitClauses(raw: string): string[] {
  return raw
    .split(SEPARATORS)
    .map((clause) => clause.trim().replace(LEADING_CONJUNCTION, "").trim())
    .filter((clause) => clause.length > 0);
}

/** 供模型上下文呈现的带索引子句表（"0: xxx" 形式）。 */
export function indexedClauses(raw: string): string[] {
  return splitClauses(raw).map((clause, index) => `${index}: ${clause}`);
}
