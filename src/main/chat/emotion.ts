/**
 * 本地关键词情绪判定：用户说了什么 → 它该是什么表情。
 *
 * 为什么不用模型打情绪标签：那要给 systemPrompt 加一套输出格式约束，还要在流式管道里
 * 扣住开头的标签、决定哪些字先不吐给界面 —— 为了一张脸不值得把最稳的那条链路改复杂。
 * 关键词判定零成本、零延迟、判错了改一行就行，而且**输入是用户说的话**：
 * 这只宠物先对你说的话有反应，再开口回你 —— 这个顺序比「跟着自己回复的情绪走」自然。
 *
 * 规则是**有顺序的**，先命中的赢。两轮：情绪词优先于配件道具词（「工作好累」该是难过，
 * 而不是摆一张桌子出来），最后才是疑问句与极短消息这类兜底。
 */
import { loadConfig } from '../config'
import { listExpressions } from '../models'

export interface EmotionHit {
  /** 表情名（已确认当前形象里有这个表情） */
  name: string
  /** 挂多久（毫秒） */
  holdMs: number
}

interface Rule {
  name: string
  /** 出现这些词就套上这个表情 */
  pattern: RegExp
}

const EMOTION_HOLD_MS = 3500
/** 配件和道具是「陪着你做这件事」，挂久一点才像那么回事 */
const ACCESSORY_HOLD_MS = 60_000
const FALLBACK_HOLD_MS = 2500

/** 情绪词：先判「它现在什么心情」 */
const EMOTION_RULES: Rule[] = [
  { name: '大哭', pattern: /大哭|哭了|哭死|呜呜|分手|被辞|崩溃|委屈死了/ },
  { name: '悲伤', pattern: /难过|伤心|不开心|沮丧|失落|失败|好累|累了|郁闷|委屈|难受|想哭|emo|丧/ },
  { name: '生气', pattern: /讨厌|笨蛋|好笨|真笨|傻|滚|闭嘴|烦人|垃圾|好丑|不喜欢你|气死/ },
  { name: '爱心眼', pattern: /喜欢你|爱你|亲亲|抱抱|么么|想你|最爱/ },
  { name: '星星眼', pattern: /太厉害|好厉害|崇拜|大神|无敌|哇塞|太强|牛逼|好牛|羡慕/ },
  { name: '脸红', pattern: /害羞|好可爱|真可爱|可爱|好萌|漂亮|好乖/ },
  { name: '调皮', pattern: /嘿嘿|嘻嘻|你坏|调皮|捉弄|骗我|坏蛋|捣蛋/ },
  { name: '心跳', pattern: /紧张|害怕|担心|期待|面试|考试|约会/ },
  { name: '情绪花花', pattern: /恭喜|生日快乐|周年|庆祝|纪念日/ },
  { name: '开心兴奋', pattern: /哈哈|太棒|好棒|太好了|好耶|开心|谢谢|加油|不错|你好|哈喽|嗨|hello|\bhi\b/ },
  { name: '晕晕', pattern: /好晕|晕了|头晕|听不懂|太复杂|信息量|一大堆|看不懂/ },
  { name: '吐魂', pattern: /记不住|忘了|榨干|累死|灵魂|好多事/ },
  { name: '闭眼口水', pattern: /晚安|睡了|睡觉|困了|好困|打盹/ },
  { name: '流汗', pattern: /尴尬|无语|打扰了|抱歉|对不起|不好意思|丢人/ }
]

/** 配件和道具词：它在陪你做某件事 */
const ACCESSORY_RULES: Rule[] = [
  { name: '我会出手', pattern: /帮我|怎么办|救命|搞不定|求助|教教我|不会做|救救/ },
  { name: '奶茶', pattern: /奶茶|下午茶|点个外卖|想喝|饿了|饿死|好饿|想吃/ },
  { name: '爆肝', pattern: /加班|通宵|赶工|ddl|deadline|熬夜|肝爆/i },
  { name: '手敲琴', pattern: /唱歌|音乐|弹琴|钢琴|敲琴|听歌/ },
  { name: '举喇叭', pattern: /提醒我|大声点|叫我一下|喊我/ },
  { name: '圆木桌', pattern: /陪我工作|陪我学习|陪我干|干活|工作|学习|写作业|复习|写文档/ },
  { name: '方眼镜', pattern: /写代码|代码|程序|bug|debug|编译/i },
  { name: '圆眼镜', pattern: /看书|读书|看论文|阅读/ },
  { name: '椭圆眼镜', pattern: /仔细观察|仔细看|盯着看|观察/ },
  { name: '戴帽子', pattern: /上班|出门|好冷|降温|下雪|帽子/ },
  { name: '墨镜', pattern: /装酷|好酷|好帅|太阳|好晒/ },
  { name: '猫猫贴纸', pattern: /猫|喵/ },
  { name: '兔兔贴纸', pattern: /兔子|兔兔/ },
  { name: '蝴蝶结贴纸', pattern: /蝴蝶结|蝴蝶/ }
]

/** 两轮规则 + 各自挂多久：情绪是当下的反应，配件是「陪你做这件事」，挂得久一些 */
const TIERS: Array<{ holdMs: number; rules: Rule[] }> = [
  { holdMs: EMOTION_HOLD_MS, rules: EMOTION_RULES },
  { holdMs: ACCESSORY_HOLD_MS, rules: ACCESSORY_RULES }
]

/**
 * 判一判这句话该让它摆什么脸。判不出来就返回 null（不动脸）——
 * 大部分普通消息本来就不该让桌宠变脸，一直乱变才是噪音。
 */
export function detectEmotion(text: string): EmotionHit | null {
  const input = text.trim()
  if (input.length === 0) return null

  const available = availableExpressions()
  for (const tier of TIERS) {
    for (const rule of tier.rules) {
      if (rule.pattern.test(input) && available.has(rule.name)) {
        return { name: rule.name, holdMs: tier.holdMs }
      }
    }
  }

  if (/[？?]/.test(input) && available.has('问号')) {
    return { name: '问号', holdMs: FALLBACK_HOLD_MS }
  }
  // 「嗯」「哦」「……」：它不装懂，就呆呆看着你
  if (input.length <= 2 && available.has('呆呆眼')) {
    return { name: '呆呆眼', holdMs: FALLBACK_HOLD_MS }
  }
  return null
}

/**
 * 当前形象有哪些表情（按模型路径缓存）。
 *
 * 判出名字必须先对一遍清单：换个形象之后「奶茶」可能根本不存在，
 * 那时候每次聊天都在渲染层刷一句「没有这个表情」的警告，属于自己给自己找的噪音。
 */
let cache: { path: string; names: Set<string> } | null = null

function availableExpressions(): Set<string> {
  const path = loadConfig().model.path
  if (!cache || cache.path !== path) {
    cache = { path, names: new Set(listExpressions(path).map((item) => item.name)) }
  }
  return cache.names
}
