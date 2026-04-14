/**
 * 西游妖魔榜养成系统 - 类型定义
 *
 * 核心概念：每次通过 agent 成功调用 dws CLI，就是一次"降妖除魔"。
 * 妖怪按品质随机掉落，神仙按机缘随机现身，所有数据与用户 UID 强绑定。
 */

// ============ 品质与分级 ============

export type MonsterQuality = 'normal' | 'fine' | 'rare' | 'epic' | 'legendary' | 'shiny';

export const QUALITY_LABELS: Record<MonsterQuality, string> = {
  normal: '⬜ 普通',
  fine: '🟢 精良',
  rare: '🔵 稀有',
  epic: '🟣 史诗',
  legendary: '🟡 传说',
  shiny: '✨ 闪光',
};

export const QUALITY_ORDER: MonsterQuality[] = [
  'normal', 'fine', 'rare', 'epic', 'legendary', 'shiny',
];

// ============ 妖怪 ============

export interface Monster {
  id: string;
  name: string;
  quality: MonsterQuality;
  origin: string;
  relatedProduct: string | null;
  captureQuote: string;
}

export interface CapturedMonster {
  monsterId: string;
  capturedAt: number;
  isShiny: boolean;
  commandHash: string;
  comboCount: number;
}

// ============ 神仙 ============

export type EncounterType = 'guidance' | 'treasure' | 'apprentice';

export interface Immortal {
  id: string;
  name: string;
  guidanceQuote: string;
  treasureId: string;
  apprenticeBuff: Buff;
}

export interface Encounter {
  immortalId: string;
  type: EncounterType;
  treasureId?: string;
  buffId?: string;
  occurredAt: number;
}

// ============ 法宝 ============

export type BuffEffect =
  | 'comboBonus'
  | 'expMultiplier'
  | 'pityReduction'
  | 'epicRateBonus'
  | 'rareRateBonus'
  | 'legendaryRateBonus'
  | 'shinyRateBonus'
  | 'allRateBonus'
  | 'signInMultiplier'
  | 'comboLimitBonus'
  | 'normalUpgrade'
  | 'instantExp'
  | 'extraDrop'
  | 'pitySpeed'
  | 'previewNextQuality'
  | 'cliRetry';

export interface Buff {
  id: string;
  source: 'treasure' | 'apprentice' | 'achievement';
  effect: BuffEffect;
  value: number;
}

export interface Treasure {
  id: string;
  name: string;
  source: string;
  description: string;
  effect: BuffEffect;
  value: number;
  consumable: boolean;
}

// ============ 成就 ============

export type AchievementCategory = 'cultivation' | 'collection' | 'product' | 'hidden';

export interface Achievement {
  id: string;
  name: string;
  emoji: string;
  description: string;
  category: AchievementCategory;
  condition: AchievementCondition;
  expReward: number;
  titleReward?: string;
}

export type AchievementCondition =
  | { type: 'totalOperations'; count: number }
  | { type: 'consecutiveSignIn'; days: number }
  | { type: 'maxCombo'; count: number }
  | { type: 'totalRecoveries'; count: number }
  | { type: 'uniqueMonsters'; count: number }
  | { type: 'shinyMonsters'; count: number }
  | { type: 'productUsage'; product: string; count: number }
  | { type: 'allProducts' }
  | { type: 'dailyOperations'; count: number }
  | { type: 'nightOwl' }
  | { type: 'pityTriggered' }
  | { type: 'consecutiveFailThenSuccess'; failCount: number }
  | { type: 'dailyRareOrAbove'; count: number }
  | { type: 'birthday' }
  | { type: 'consecutiveReport'; days: number };

// ============ 等级 ============

export interface LevelDefinition {
  level: number;
  title: string;
  requiredExp: number;
  unlockDescription?: string;
}

export const LEVEL_DEFINITIONS: LevelDefinition[] = [
  { level: 1, title: '凡人', requiredExp: 0, unlockDescription: '基础掉落池' },
  { level: 2, title: '樵夫', requiredExp: 30 },
  { level: 3, title: '修行者', requiredExp: 80, unlockDescription: '解锁"机缘"系统（神仙随机现身）' },
  { level: 4, title: '散仙', requiredExp: 200, unlockDescription: '掉落池扩展：加入稀有妖怪' },
  { level: 5, title: '天兵', requiredExp: 500, unlockDescription: '解锁"法宝"系统' },
  { level: 6, title: '天将', requiredExp: 1000, unlockDescription: '掉落池扩展：加入史诗妖怪' },
  { level: 7, title: '哪吒', requiredExp: 2000, unlockDescription: '连击加成上限提升至 ×4.0' },
  { level: 8, title: '二郎神', requiredExp: 4000, unlockDescription: '掉落池扩展：加入传说妖怪' },
  { level: 9, title: '齐天大圣', requiredExp: 8000, unlockDescription: '解锁"闪光"掉落' },
  { level: 10, title: '斗战胜佛', requiredExp: 15000, unlockDescription: '全图鉴解锁提示、专属称号色' },
];

// ============ 产品修行值 ============

export const PRODUCT_BASE_EXP: Record<string, number> = {
  aitable: 3,
  calendar: 2,
  chat: 2,
  contact: 1,
  todo: 2,
  approval: 4,
  attendance: 2,
  report: 3,
  ding: 1,
  workbench: 3,
  devdoc: 1,
};

// ============ 保底计数器 ============

export interface PityCounters {
  sinceLastRare: number;
  sinceLastEpic: number;
  sinceLastLegendary: number;
  totalDropsWithoutShiny: number;
}

export const PITY_THRESHOLDS = {
  rare: 20,
  epic: 50,
  legendary: 100,
  shiny: 500,
} as const;

// ============ 用户档案 ============

export interface GamificationSettings {
  enabled: boolean;
  showDropAnimation: boolean;
  muteNormalDrops: boolean;
}

export interface UserProfile {
  uidHash: string;
  level: number;
  title: string;
  totalExp: number;
  totalOperations: number;
  currentCombo: number;
  maxCombo: number;
  consecutiveSignInDays: number;
  lastSignInDate: string;
  totalRecoveries: number;
  consecutiveFailures: number;
  productUsage: Record<string, number>;
  pityCounters: PityCounters;
  buffs: Buff[];
  settings: GamificationSettings;
  encounters: Encounter[];
  unlockedAchievements: string[];
  treasures: string[];
  consumedTreasures: string[];
  createdAt: number;
  checksum: string;
}

export interface CollectionEntry {
  monsterId: string;
  firstCapturedAt: number;
  captureCount: number;
  isShiny: boolean;
}

export interface UserCollection {
  uidHash: string;
  entries: CollectionEntry[];
}

export interface HistoryRecord {
  timestamp: number;
  product: string;
  commandHash: string;
  success: boolean;
  expGained: number;
  monsterId?: string;
  isShiny?: boolean;
  encounterId?: string;
  achievementIds?: string[];
}

export interface UserHistory {
  uidHash: string;
  records: HistoryRecord[];
}

// ============ 掉落结果 ============

export interface DropResult {
  monster: Monster;
  isShiny: boolean;
  isNew: boolean;
  expGained: number;
  isPityTriggered: boolean;
  isUpMonster: boolean;
}

export interface ExpResult {
  baseExp: number;
  comboMultiplier: number;
  firstUseMultiplier: number;
  signInBonus: number;
  consecutiveSignInBonus: number;
  buffMultiplier: number;
  totalExp: number;
}

export interface LevelUpResult {
  previousLevel: number;
  previousTitle: string;
  newLevel: number;
  newTitle: string;
  unlockDescription?: string;
}

// ============ 引擎输出 ============

export interface GamificationOutput {
  expResult: ExpResult;
  dropResult: DropResult;
  encounter: Encounter | null;
  newAchievements: Achievement[];
  levelUp: LevelUpResult | null;
}

// ============ 掉落概率配置 ============

export const DROP_RATES: Record<MonsterQuality, number> = {
  shiny: 0.001,
  legendary: 0.009,
  epic: 0.04,
  rare: 0.10,
  fine: 0.25,
  normal: 0.60,
};

/** 等级门槛：低于此等级的品质会降级 */
export const QUALITY_LEVEL_GATES: Partial<Record<MonsterQuality, number>> = {
  rare: 4,
  epic: 6,
  legendary: 8,
  shiny: 9,
};

/** 连击加成倍率 */
export const COMBO_MULTIPLIERS: Array<{ threshold: number; multiplier: number }> = [
  { threshold: 10, multiplier: 3.0 },
  { threshold: 5, multiplier: 2.0 },
  { threshold: 3, multiplier: 1.5 },
];

/** 机缘触发概率 */
export const ENCOUNTER_RATES: Record<EncounterType, number> = {
  guidance: 0.08,
  treasure: 0.03,
  apprentice: 0.005,
};

/** 产品关联权重倍数 */
export const PRODUCT_WEIGHT_MULTIPLIER = 3;

/** UP 池权重倍数 */
export const UP_WEIGHT_MULTIPLIER = 5;
