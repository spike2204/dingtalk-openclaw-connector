/**
 * 概率掉落引擎（核心）
 *
 * 每次 dws CLI 成功执行后触发一次"降妖"事件。
 * 流程：保底判定 → 随机品质 → 等级门槛降级 → 加权选妖 → 闪光判定 → 更新计数器
 */

import { randomBytes } from 'crypto';
import type {
  MonsterQuality, Monster, UserProfile, DropResult,
  Buff, UserCollection,
} from './types.ts';
import {
  DROP_RATES, QUALITY_LEVEL_GATES, QUALITY_ORDER,
} from './types.ts';
import { checkPityTrigger, updatePityCounters } from './pity-counter.ts';
import { getMonstersByQuality, getWeeklyUpMonster, weightedRandomSelect } from './monster-pool.ts';

/**
 * 使用 crypto.randomBytes 生成安全随机数
 */
function cryptoRandom(): number {
  const buffer = randomBytes(4);
  return buffer.readUInt32BE(0) / 0xFFFFFFFF;
}

/**
 * 根据随机数和用户等级判定掉落品质
 */
function resolveQuality(roll: number, level: number, buffs: Buff[]): MonsterQuality {
  // 计算 buff 加成后的掉落率
  const rateBonus: Partial<Record<MonsterQuality, number>> = {};
  for (const buff of buffs) {
    switch (buff.effect) {
      case 'epicRateBonus':
        rateBonus.epic = (rateBonus.epic ?? 0) + buff.value;
        break;
      case 'rareRateBonus':
        rateBonus.rare = (rateBonus.rare ?? 0) + buff.value;
        break;
      case 'legendaryRateBonus':
        rateBonus.legendary = (rateBonus.legendary ?? 0) + buff.value;
        break;
      case 'shinyRateBonus':
        rateBonus.shiny = (rateBonus.shiny ?? 0) + buff.value;
        break;
      case 'allRateBonus':
        for (const quality of QUALITY_ORDER) {
          if (quality !== 'normal' && quality !== 'fine') {
            rateBonus[quality] = (rateBonus[quality] ?? 0) + buff.value;
          }
        }
        break;
    }
  }

  // 从高品质到低品质依次判定
  let cumulative = 0;
  const qualitiesHighToLow: MonsterQuality[] = ['shiny', 'legendary', 'epic', 'rare', 'fine', 'normal'];

  for (const quality of qualitiesHighToLow) {
    const baseRate = DROP_RATES[quality];
    const bonus = rateBonus[quality] ?? 0;
    cumulative += baseRate + bonus;

    if (roll < cumulative) {
      return quality;
    }
  }

  return 'normal';
}

/**
 * 应用等级门槛降级
 */
function applyLevelGate(quality: MonsterQuality, level: number): MonsterQuality {
  const gate = QUALITY_LEVEL_GATES[quality];
  if (gate !== undefined && level < gate) {
    // 降级到最高可用品质
    const qualityIndex = QUALITY_ORDER.indexOf(quality);
    for (let i = qualityIndex - 1; i >= 0; i--) {
      const lowerQuality = QUALITY_ORDER[i];
      const lowerGate = QUALITY_LEVEL_GATES[lowerQuality];
      if (lowerGate === undefined || level >= lowerGate) {
        return lowerQuality;
      }
    }
    return 'normal';
  }
  return quality;
}

/**
 * 检查玲珑宝塔 buff：普通掉落有概率升级为精良
 */
function checkNormalUpgrade(quality: MonsterQuality, buffs: Buff[]): MonsterQuality {
  if (quality !== 'normal') return quality;

  const upgradeChance = buffs
    .filter(b => b.effect === 'normalUpgrade')
    .reduce((sum, b) => sum + b.value, 0);

  if (upgradeChance > 0 && cryptoRandom() < upgradeChance) {
    return 'fine';
  }
  return quality;
}

/**
 * 执行一次掉落
 */
export function executeDrop(
  product: string,
  profile: UserProfile,
  collection: UserCollection
): DropResult {
  const pity = profile.pityCounters;
  let isPityTriggered = false;
  let quality: MonsterQuality;

  // 1. 保底判定（优先级最高）
  const pityQuality = checkPityTrigger(pity);
  if (pityQuality) {
    quality = pityQuality;
    isPityTriggered = true;
  } else {
    // 2. 随机品质判定
    const roll = cryptoRandom();
    quality = resolveQuality(roll, profile.level, profile.buffs);
  }

  // 3. 等级门槛降级
  quality = applyLevelGate(quality, profile.level);

  // 4. 玲珑宝塔 buff 检查
  quality = checkNormalUpgrade(quality, profile.buffs);

  // 5. 闪光判定（独立于品质判定）
  let isShiny = false;
  if (quality === 'shiny') {
    isShiny = true;
    // 闪光是任意妖怪的变体，从所有已解锁品质中随机选一个品质
    const availableQualities = QUALITY_ORDER.filter(q => {
      if (q === 'shiny') return false;
      const gate = QUALITY_LEVEL_GATES[q];
      return gate === undefined || profile.level >= gate;
    });
    quality = availableQualities[Math.floor(cryptoRandom() * availableQualities.length)] || 'normal';
  } else if (profile.level >= 9) {
    // 非闪光品质时，额外 0.1% 概率变为闪光
    const shinyBonus = profile.buffs
      .filter(b => b.effect === 'shinyRateBonus')
      .reduce((sum, b) => sum + b.value, 0);
    if (cryptoRandom() < 0.001 + shinyBonus) {
      isShiny = true;
    }
  }

  // 6. 在品质池中选择妖怪
  const pool = getMonstersByQuality(quality);
  const upMonster = getWeeklyUpMonster();
  const isUpMonster = false;
  let monster: Monster;

  if (pool.length === 0) {
    // 降级到普通池
    const normalPool = getMonstersByQuality('normal');
    monster = weightedRandomSelect(normalPool, product, null, cryptoRandom());
  } else {
    monster = weightedRandomSelect(pool, product, upMonster, cryptoRandom());
  }

  // 7. 判定是否为新妖怪
  const isNew = !collection.entries.some(e =>
    e.monsterId === monster.id && (isShiny ? e.isShiny : !e.isShiny)
  );

  // 8. 更新保底计数器
  updatePityCounters(pity, quality, isShiny);

  return {
    monster,
    isShiny,
    isNew,
    expGained: 0, // 由 GamificationEngine 统一计算
    isPityTriggered,
    isUpMonster: upMonster?.id === monster.id,
  };
}
