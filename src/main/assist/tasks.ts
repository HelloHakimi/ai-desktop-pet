/**
 * 「选中即处理」的动作表：判断复制来的这段文字该干什么，以及各自动用什么提示词。
 *
 * 分类是**本地启发式**，不是让模型自己判：它要在按下快捷键的那一刻就给出答案，
 * 多一次往返等于让用户对着气泡多等一秒；而且判错的代价很低 ——
 * 结果不满意时，在对话窗口里说一句「翻成英文」就接上了。
 *
 * 提示词刻意都短且指令化：任务要的是准，不是萌。萌那部分由表情承担。
 */
export type TaskKey = 'explain-error' | 'translate' | 'summarize' | 'polish'

export interface AssistTask {
  /** 动作名，只用于日志（出了问题好定位是哪个分支） */
  label: string
  /** 顶替桌宠人设的任务提示词 */
  system: string
  /** 把这坨文本包成一条用户消息 */
  build: (text: string) => string
}

/** 长文阈值：超过就摘要。整段翻译又慢又贵，而用户多半只想知道讲了什么 */
const LONG_CHARS = 800
/** 中文长文阈值：中文信息密度高，200 字已经值得摘要了 */
const MEDIUM_CHARS = 200
/** 汉字占比低于这个值就当外文处理 —— 中文里夹几个英文单词不算外文 */
const CJK_RATIO_FOR_FOREIGN = 0.2

export function classify(text: string): TaskKey {
  if (looksLikeError(text)) return 'explain-error'

  const length = countChars(text)
  if (length >= LONG_CHARS) return 'summarize'
  if (cjkRatio(text) < CJK_RATIO_FOR_FOREIGN) return 'translate'
  if (length >= MEDIUM_CHARS) return 'summarize'
  return 'polish'
}

/**
 * 像报错/日志的形状。
 *
 * 只挑「正常行文里几乎不会出现」的形状，不用「包含 error 这个词」这种弱条件 ——
 * 一句普通英文里出现 error 太常见了，那样会把正常句子判成报错。
 */
const ERROR_PATTERNS = [
  /Traceback \(most recent call last\)/,
  /\b[A-Za-z_][\w.]*(Error|Exception)\b\s*[:\n]/,
  /^\s*at\s+[\w$.<>[\]]+\s*\(/m,
  /\b(Caused by|stack ?trace|panic:|fatal:)\b/i,
  /\b(ERROR|FATAL)\b\s*[:\[]/,
  /\.(js|ts|tsx|jsx|py|java|go|rs|rb|c|cpp|swift|kt):\d+(:\d+)?/
]

function looksLikeError(text: string): boolean {
  return ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

/** 按字符（而非 UTF-16 码元）计数：emoji 是两个码元，按码元算会把长度算虚 */
function countChars(text: string): number {
  return Array.from(text).length
}

/** 汉字在「非空白字符」里的占比，用来区分中文与其它文字 */
function cjkRatio(text: string): number {
  const chars = Array.from(text.replace(/\s/g, ''))
  if (chars.length === 0) return 0
  const cjk = chars.filter((char) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(char)).length
  return cjk / chars.length
}

/**
 * 动作表。
 *
 * 翻译只做一个方向：外文 → 中文。因为 classify 只会把「不像中文」的内容判成翻译，
 * 反过来（中文 → 英文）没有可靠的本地信号，硬判只会把「想润色」的意思也翻掉 ——
 * 想要那个方向，在对话窗口说一句就是了。
 */
export const TASKS: Record<TaskKey, AssistTask> = {
  'explain-error': {
    label: '解释报错',
    system:
      '你是资深工程师。用户会给你一段报错、日志或堆栈。' +
      '直接用中文说清三件事：出了什么问题、最可能的原因、下一步怎么查。' +
      '不要复述原文，不要客套，控制在 200 字以内。',
    build: (text) => `这段报错是什么意思？\n\n${text}`
  },
  translate: {
    label: '翻译',
    system:
      '你是翻译。把用户给你的内容翻译成中文，只输出译文 —— ' +
      '不要解释、不要加引号、不要问候，保留原文的换行与代码格式。',
    build: (text) => `翻译这段。\n\n${text}`
  },
  summarize: {
    label: '摘要',
    system: '你把长文压成要点：3 到 5 条，每条一行，每条不超过 30 字。只输出要点，不要前言。',
    build: (text) => `把这段压成要点。\n\n${text}`
  },
  polish: {
    label: '润色',
    system:
      '你是中文编辑。把用户的文字改得更通顺、更简洁，保持原意与原语气。' +
      '只输出改后的文字，不要说明改了哪里。',
    build: (text) => `把这段改顺一点。\n\n${text}`
  }
}
