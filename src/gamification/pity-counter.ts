/**
 * 保底计数器
 *
 * 借鉴 Gacha 游戏的保底设计，防止"非酋"体验过差。
 * 保底计数器在对应品质或更高品质掉落后重置。
 */

import type { PityCounters, MonsterQuality } from './types.ts';
import { PITY_THRESHOLDS, QUALITY_ORDER } from './types.ts';

/**
 * 检查是否触发保底，返回应强制掉落的品质（如果有）
 */
export function checkPityTrigger(counters: PityCounters): MonsterQuality | null {
  // 按优先级从高到低检查
  if (counters.totalDropsWithoutShiny >= PITY_THRESHOLDS.shiny) {
    return 'shiny';
  }
  if (counters.sinceLastLegendary >= PITY_THRESHOLDS.legendary) {
    return 'legendary';
  }
  if (counters.sinceLastEpic >= PITY_THRESHOLDS.epic) {
    return 'epic';
  }
  if (counters.sinceLastRare >= PITY_THRESHOLDS.rare) {
    return 'rare';
  }
  return null;
}

/**
 * 更新保底计数器
 *
 * 掉落后递增所有计数器，然后重置对应品质及以下的计数器
 */
export function updatePityCounters(counters: PityCounters, droppedQuality: MonsterQuality, isShiny: boolean): void {
  // 递增所有计数器
  counters.sinceLastRare += 1;
  counters.sinceLastEpic += 1;
  counters.sinceLastLegendary += 1;
  counters.totalDropsWithoutShiny += 1;

  // 根据掉落品质重置对应计数器
  const qualityIndex = QUALITY_ORDER.indexOf(droppedQuality);

  if (isShiny || droppedQuality === 'shiny') {
    counters.totalDropsWithoutShiny = 0;
  }

  if (qualityIndex >= QUALITY_ORDER.indexOf('legendary')) {
    counters.sinceLastLegendary = 0;
  }

  if (qualityIndex >= QUALITY_ORDER.indexOf('epic')) {
    counters.sinceLastEpic = 0;
  }

  if (qualityIndex >= QUALITY_ORDER.indexOf('rare')) {
    counters.sinceLastRare = 0;
  }
}

/**
 * 应用保底减半 buff（观音菩萨收徒效果）
 */
export function applyPityReduction(counters: PityCounters, reductionFactor: number): PityCounters {
  return {
    sinceLastRare: Math.floor(counters.sinceLastRare * reductionFactor),
    sinceLastEpic: Math.floor(counters.sinceLastEpic * reductionFactor),
    sinceLastLegendary: Math.floor(counters.sinceLastLegendary * reductionFactor),
    totalDropsWithoutShiny: Math.floor(counters.totalDropsWithoutShiny * reductionFactor),
  };
}
