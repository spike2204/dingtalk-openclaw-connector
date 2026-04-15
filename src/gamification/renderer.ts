/**
 * Markdown 渲染器
 *
 * 输出纯 Markdown 字符串，适配钉钉 AI Card 渲染。
 * 不关心发送方式，只负责内容生成。
 */

import type {
  DropResult, ExpResult, LevelUpResult, Encounter,
  Achievement, UserProfile, UserCollection, Monster,
} from './types.ts';
import { QUALITY_LABELS, LEVEL_DEFINITIONS } from './types.ts';
import { getMonsterById, getWeeklyUpMonster, getTotalMonsterCount, getAllMonsters } from './monster-pool.ts';
import { getImmortalById, getTreasureName, getTreasureDescription } from './encounter-system.ts';
import { getLevelProgress, getExpToNextLevel, getNextLevel } from './level-system.ts';
import { getUserTreasures, getConsumableTreasures } from './treasure-system.ts';
import { getAllAchievements } from './achievement-engine.ts';

// ============ 掉落结果渲染 ============

/**
 * 渲染普通掉落结果（追加到 agent 回复末尾）
 */
export function renderDropResult(drop: DropResult, expResult: ExpResult, collection: UserCollection): string {
  const qualityLabel = drop.isShiny ? '✨ 闪光' : QUALITY_LABELS[drop.monster.quality];
  const totalMonsters = getTotalMonsterCount();
  const collectedCount = collection.entries.length;

  // 闪光掉落 - 特殊渲染
  if (drop.isShiny) {
    return [
      '',
      '---',
      '🌈🌈🌈 **闪光降临！** 🌈🌈🌈',
      '',
      `✨ **${drop.monster.name} ✨**`,
      `*闪光变体 · 极其稀有*`,
      `> "${drop.monster.captureQuote}"`,
      '',
      `修行值 +${expResult.totalExp} · 图鉴 ${collectedCount}/${totalMonsters}`,
      drop.isPityTriggered ? '🔮 *保底触发*' : '',
      drop.isUpMonster ? '📢 *本周 UP*' : '',
    ].filter(Boolean).join('\n');
  }

  // 史诗及以上 - 华丽渲染
  if (drop.monster.quality === 'epic' || drop.monster.quality === 'legendary') {
    return [
      '',
      '---',
      `✦✦✦ **${qualityLabel}降临！** ✦✦✦`,
      '',
      `**${drop.monster.name}**`,
      `*${drop.monster.origin}*`,
      `> "${drop.monster.captureQuote}"`,
      '',
      `修行值 +${expResult.totalExp} · 图鉴 ${collectedCount}/${totalMonsters}`,
      drop.isPityTriggered ? '🔮 *保底触发*' : '',
      drop.isUpMonster ? '📢 *本周 UP*' : '',
    ].filter(Boolean).join('\n');
  }

  // 新妖怪发现
  if (drop.isNew) {
    return [
      '',
      '---',
      `📖 **图鉴新发现！**`,
      '',
      `${qualityLabel} **${drop.monster.name}** · ${drop.monster.origin}`,
      `> "${drop.monster.captureQuote}"`,
      '',
      `修行值 +${expResult.totalExp}${expResult.firstUseMultiplier > 1 ? ' (首次 ×5)' : ''} · 图鉴 ${collectedCount}/${totalMonsters}`,
    ].join('\n');
  }

  // 普通掉落 - 简洁版
  return [
    '',
    '---',
    `🗡️ **降妖成功！** 收服了 ${qualityLabel} ${drop.monster.name}`,
    `> "${drop.monster.captureQuote}"`,
    '',
    `修行值 +${expResult.totalExp} · 图鉴 ${collectedCount}/${totalMonsters}`,
  ].join('\n');
}

// ============ 升级渲染 ============

export function renderLevelUp(levelUp: LevelUpResult): string {
  const lines = [
    '',
    '---',
    `⬆️ **修为精进！** ${levelUp.previousTitle} → ${levelUp.newTitle} (Lv.${levelUp.newLevel})`,
  ];

  // 添加升级语录
  const quotes: Record<number, string> = {
    2: '菩提祖师云：尚可造化。',
    3: '菩提祖师云：悟性不错，可堪造化。',
    4: '天庭来报：准予散仙之位。',
    5: '玉帝有旨：封为天兵。',
    6: '托塔天王令：升任天将。',
    7: '太乙真人赞：有哪吒之勇。',
    8: '玉帝惊叹：堪比二郎神。',
    9: '如来佛祖：齐天大圣，名不虚传。',
    10: '如来佛祖：善哉善哉，封斗战胜佛。',
  };

  const quote = quotes[levelUp.newLevel];
  if (quote) {
    lines.push(`> "${quote}"`);
  }

  if (levelUp.unlockDescription) {
    lines.push('', `🔓 解锁：${levelUp.unlockDescription}`);
  }

  return lines.join('\n');
}

// ============ 机缘渲染 ============

export function renderEncounter(encounter: Encounter): string {
  const immortal = getImmortalById(encounter.immortalId);
  if (!immortal) return '';

  const lines = [
    '',
    '---',
    `☁️ **机缘降临！**`,
    '',
    `**${immortal.name}** 驾云而过：`,
    `> "${immortal.guidanceQuote}"`,
  ];

  if (encounter.type === 'treasure' && encounter.treasureId) {
    const treasureName = getTreasureName(encounter.treasureId);
    const treasureDesc = getTreasureDescription(encounter.treasureId);
    lines.push('', `💛 **赐宝**：${treasureName}`, `效果：${treasureDesc}`);
  }

  if (encounter.type === 'apprentice') {
    lines.push('', `💜 **收徒**：${immortal.name}收你为徒，获得永久加成！`);
  }

  return lines.join('\n');
}

// ============ 成就渲染 ============

export function renderNewAchievements(achievements: Achievement[]): string {
  if (achievements.length === 0) return '';

  const lines = ['', '---'];

  for (const achievement of achievements) {
    lines.push(
      `🏆 **成就解锁！** ${achievement.emoji} ${achievement.name}`,
      `*${achievement.description}*`,
      `修行值 +${achievement.expReward}`,
    );
    if (achievement.titleReward) {
      lines.push(`🎖️ 获得称号：「${achievement.titleReward}」`);
    }
  }

  return lines.join('\n');
}

// ============ 面板渲染（命令响应） ============

/**
 * 渲染修行面板 (/修行)
 */
export function renderProfilePanel(profile: UserProfile, collection: UserCollection): string {
  const totalMonsters = getTotalMonsterCount();
  const collectedCount = collection.entries.length;
  const shinyCount = collection.entries.filter(e => e.isShiny).length;
  const progress = getLevelProgress(profile.totalExp);
  const expToNext = getExpToNextLevel(profile.totalExp);
  const nextLevel = getNextLevel(profile.level);
  const upMonster = getWeeklyUpMonster();
  const allAchievementsList = getAllAchievements();

  // 进度条
  const filledBlocks = Math.floor(progress / 5);
  const emptyBlocks = 20 - filledBlocks;
  const progressBar = '▓'.repeat(filledBlocks) + '░'.repeat(emptyBlocks);

  const lines = [
    `### 🐒 西游妖魔榜 · 修行面板`,
    '',
    `**修行者 ID**：${profile.uidHash.slice(0, 8)}`,
    `**称号**：${profile.title} (Lv.${profile.level})`,
  ];

  if (nextLevel) {
    lines.push(
      `**修行值**：${profile.totalExp.toLocaleString()} / ${nextLevel.requiredExp.toLocaleString()} (${progress}%)`,
      '',
      `${progressBar}`,
      '',
      `距离下一级「${nextLevel.title}」还需 ${expToNext?.toLocaleString()} 修行值`,
    );
  } else {
    lines.push(`**修行值**：${profile.totalExp.toLocaleString()} (已满级)`, '', `${'▓'.repeat(20)}`);
  }

  lines.push(
    '',
    `#### 📊 统计`,
    `- **总操作**：${profile.totalOperations} 次`,
    `- **连击中**：${profile.currentCombo} 次${profile.currentCombo >= 3 ? ` (×${getComboDisplay(profile.currentCombo)})` : ''}`,
    `- **连续签到**：${profile.consecutiveSignInDays} 天`,
    `- **最高连击**：${profile.maxCombo} 次`,
  );

  // 图鉴进度
  const qualityCounts = getQualityProgress(collection);
  lines.push(
    '',
    `#### 📖 图鉴 ${collectedCount}/${totalMonsters} (${Math.floor(collectedCount / totalMonsters * 100)}%)`,
    '',
    `| 品质 | 进度 |`,
    `|------|------|`,
  );

  for (const [label, collected, total] of qualityCounts) {
    const status = collected >= total ? ' ✅' : '';
    lines.push(`| ${label} | ${collected}/${total}${status} |`);
  }

  if (shinyCount > 0) {
    lines.push(`| ✨ 闪光 | ${shinyCount} |`);
  }

  // 保底状态
  const pity = profile.pityCounters;
  lines.push(
    '',
    `#### 🔮 保底状态`,
    `- **小保底**：${pity.sinceLastRare}/20 · **大保底**：${pity.sinceLastEpic}/50 · **天命**：${pity.sinceLastLegendary}/100`,
  );

  // UP 妖怪
  if (upMonster) {
    lines.push(
      '',
      `📢 **本周 UP**：${QUALITY_LABELS[upMonster.quality]} ${upMonster.name} (权重 ×5)`,
    );
  }

  // 成就
  lines.push(
    '',
    `🏆 **成就**：${profile.unlockedAchievements.length}/${allAchievementsList.length}`,
    `🎒 **法宝**：${profile.treasures.length} 件`,
  );

  return lines.join('\n');
}

/**
 * 渲染图鉴面板 (/图鉴)
 */
export function renderCollectionPanel(collection: UserCollection): string {
  const allMonstersList = getAllMonsters();
  const totalMonsters = getTotalMonsterCount();
  const collectedCount = collection.entries.length;

  const lines = [
    `### 📖 妖怪图鉴 · ${collectedCount}/${totalMonsters}`,
    '',
  ];

  const qualityGroups: Array<{ quality: string; label: string; monsters: Monster[] }> = [
    { quality: 'normal', label: '⬜ 普通', monsters: allMonstersList.filter(m => m.quality === 'normal') },
    { quality: 'fine', label: '🟢 精良', monsters: allMonstersList.filter(m => m.quality === 'fine') },
    { quality: 'rare', label: '🔵 稀有', monsters: allMonstersList.filter(m => m.quality === 'rare') },
    { quality: 'epic', label: '🟣 史诗', monsters: allMonstersList.filter(m => m.quality === 'epic') },
    { quality: 'legendary', label: '🟡 传说', monsters: allMonstersList.filter(m => m.quality === 'legendary') },
  ];

  for (const group of qualityGroups) {
    const collected = group.monsters.filter(m =>
      collection.entries.some(e => e.monsterId === m.id && !e.isShiny)
    );
    const uncollectedCount = group.monsters.length - collected.length;

    lines.push(`#### ${group.label} ${collected.length}/${group.monsters.length}${collected.length >= group.monsters.length ? ' ✅' : ''}`);

    if (collected.length > 0) {
      lines.push(collected.map(m => m.name).join(' · '));
    }

    if (uncollectedCount > 0) {
      lines.push(`${'❓'.repeat(Math.min(uncollectedCount, 5))} *还有 ${uncollectedCount} 只未发现*`);
    }

    lines.push('');
  }

  // 闪光
  const shinyEntries = collection.entries.filter(e => e.isShiny);
  lines.push(`#### ✨ 闪光 ${shinyEntries.length}`);
  if (shinyEntries.length > 0) {
    const shinyNames = shinyEntries.map(e => {
      const monster = getMonsterById(e.monsterId);
      return monster ? `${monster.name} ✨` : e.monsterId;
    });
    lines.push(shinyNames.join(' · '));
  } else {
    lines.push('*等级 ≥ 9 后解锁闪光掉落*');
  }

  return lines.join('\n');
}

/**
 * 渲染成就面板 (/成就)
 */
export function renderAchievementPanel(profile: UserProfile): string {
  const allAchievementsList = getAllAchievements();
  const lines = [
    `### 🏆 成就列表 · ${profile.unlockedAchievements.length}/${allAchievementsList.length}`,
    '',
  ];

  const categories = [
    { key: 'cultivation', label: '修行成就' },
    { key: 'collection', label: '收集成就' },
    { key: 'product', label: '产品成就' },
    { key: 'hidden', label: '隐藏成就' },
  ];

  for (const category of categories) {
    const categoryAchievements = allAchievementsList.filter(a => a.category === category.key);
    lines.push(`#### ${category.label}`);

    for (const achievement of categoryAchievements) {
      const unlocked = profile.unlockedAchievements.includes(achievement.id);
      const status = unlocked ? '✅' : '⬜';
      const desc = category.key === 'hidden' && !unlocked ? '???' : achievement.description;
      lines.push(`- ${status} ${achievement.emoji} **${achievement.name}** — ${desc} (+${achievement.expReward})`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 渲染法宝面板 (/法宝)
 */
export function renderTreasurePanel(profile: UserProfile): string {
  const treasures = getUserTreasures(profile);
  const consumable = getConsumableTreasures(profile);

  const lines = [
    `### 🎒 法宝背包 · ${treasures.length} 件`,
    '',
  ];

  if (treasures.length === 0) {
    lines.push('*背包空空如也，等待神仙赐宝...*');
    return lines.join('\n');
  }

  for (const treasure of treasures) {
    const consumed = profile.consumedTreasures.includes(treasure.id);
    const status = consumed ? '（已使用）' : treasure.consumable ? '（可使用）' : '（永久生效）';
    lines.push(`- **${treasure.name}** ${status}`, `  ${treasure.description}`, `  *来源：${treasure.source}*`, '');
  }

  if (consumable.length > 0) {
    lines.push('', `💡 发送 \`/使用 法宝名\` 来使用一次性法宝`);
  }

  return lines.join('\n');
}

/**
 * 渲染保底面板 (/保底)
 */
export function renderPityPanel(profile: UserProfile): string {
  const pity = profile.pityCounters;
  return [
    `### 🔮 保底计数器`,
    '',
    `| 保底类型 | 当前计数 | 触发阈值 | 进度 |`,
    `|---------|---------|---------|------|`,
    `| 小保底（稀有） | ${pity.sinceLastRare} | 20 | ${Math.floor(pity.sinceLastRare / 20 * 100)}% |`,
    `| 大保底（史诗） | ${pity.sinceLastEpic} | 50 | ${Math.floor(pity.sinceLastEpic / 50 * 100)}% |`,
    `| 天命保底（传说） | ${pity.sinceLastLegendary} | 100 | ${Math.floor(pity.sinceLastLegendary / 100 * 100)}% |`,
    `| 闪光保底 | ${pity.totalDropsWithoutShiny} | 500 | ${Math.floor(pity.totalDropsWithoutShiny / 500 * 100)}% |`,
    '',
    `*保底计数器在对应品质或更高品质掉落后重置*`,
  ].join('\n');
}

/**
 * 渲染机缘面板 (/机缘)
 */
export function renderEncounterPanel(profile: UserProfile): string {
  const lines = [
    `### ☁️ 神仙机缘录`,
    '',
  ];

  if (profile.level < 3) {
    lines.push('*等级 ≥ 3（修行者）后解锁机缘系统*');
    return lines.join('\n');
  }

  if (profile.encounters.length === 0) {
    lines.push('*尚未遇到任何神仙，继续修行吧...*');
    return lines.join('\n');
  }

  for (const encounter of profile.encounters) {
    const immortal = getImmortalById(encounter.immortalId);
    if (!immortal) continue;

    const typeLabel = encounter.type === 'guidance' ? '🤍 点化' :
      encounter.type === 'treasure' ? '💛 赐宝' : '💜 收徒';
    const date = new Date(encounter.occurredAt).toLocaleDateString('zh-CN');

    lines.push(`- ${typeLabel} **${immortal.name}** — ${date}`);
    if (encounter.type === 'treasure' && encounter.treasureId) {
      lines.push(`  赐宝：${getTreasureName(encounter.treasureId)}`);
    }
  }

  return lines.join('\n');
}

/**
 * 渲染妖魔榜 (/妖魔榜)
 */
export function renderLeaderboard(profile: UserProfile, collection: UserCollection): string {
  const upMonster = getWeeklyUpMonster();
  const totalMonsters = getTotalMonsterCount();

  const lines = [
    `### 🐒 西游妖魔榜`,
    '',
  ];

  if (upMonster) {
    lines.push(
      `#### 📢 本周 UP`,
      `${QUALITY_LABELS[upMonster.quality]} **${upMonster.name}** · ${upMonster.origin}`,
      `> "${upMonster.captureQuote}"`,
      `*在对应品质池中掉落权重 ×5*`,
      '',
    );
  }

  lines.push(
    `#### 📊 掉落统计`,
    `- **总掉落**：${profile.totalOperations} 次`,
    `- **图鉴完成度**：${collection.entries.length}/${totalMonsters}`,
    `- **闪光收服**：${collection.entries.filter(e => e.isShiny).length} 只`,
    '',
    `#### 🔮 保底状态`,
    `- 小保底：${profile.pityCounters.sinceLastRare}/20`,
    `- 大保底：${profile.pityCounters.sinceLastEpic}/50`,
    `- 天命：${profile.pityCounters.sinceLastLegendary}/100`,
  );

  return lines.join('\n');
}

/**
 * 渲染法宝使用结果
 */
export function renderTreasureUse(treasureName: string, expGained: number, currentExp: number, nextLevelExp: number | null): string {
  const emojiMap: Record<string, string> = {
    '蟠桃': '🍑',
    '人参果': '🍐',
  };
  const emoji = emojiMap[treasureName] ?? '✨';

  const lines = [
    '---',
    `${emoji} **使用了${treasureName}！**`,
    `修行值 +${expGained}${nextLevelExp ? ` · 当前 ${currentExp}/${nextLevelExp}` : ''}`,
    `> "仙物入腹，周身舒泰。"`,
  ];

  return lines.join('\n');
}

/**
 * 渲染群聊炫耀 (/炫耀)
 */
export function renderShowOff(profile: UserProfile, collection: UserCollection): string {
  const shinyCount = collection.entries.filter(e => e.isShiny).length;
  const rarest = findRarestMonster(collection);

  const lines = [
    `### 🐒 ${profile.title} (Lv.${profile.level}) 的西游妖魔榜`,
    '',
    `图鉴：${collection.entries.length}/${getTotalMonsterCount()} · 闪光：${shinyCount}`,
  ];

  if (rarest) {
    lines.push(`最稀有：${QUALITY_LABELS[rarest.quality]} ${rarest.name}`);
  }

  lines.push('', `> "此人修为不浅，诸位小心。"`);

  return lines.join('\n');
}

// ============ 辅助函数 ============

function getComboDisplay(combo: number): string {
  if (combo >= 10) return '3.0';
  if (combo >= 5) return '2.0';
  if (combo >= 3) return '1.5';
  return '1.0';
}

function getQualityProgress(collection: UserCollection): Array<[string, number, number]> {
  const allMonstersList = getAllMonsters();
  const qualities: Array<{ label: string; quality: string }> = [
    { label: '⬜ 普通', quality: 'normal' },
    { label: '🟢 精良', quality: 'fine' },
    { label: '🔵 稀有', quality: 'rare' },
    { label: '🟣 史诗', quality: 'epic' },
    { label: '🟡 传说', quality: 'legendary' },
  ];

  return qualities.map(({ label, quality }) => {
    const total = allMonstersList.filter(m => m.quality === quality).length;
    const collected = allMonstersList.filter(m =>
      m.quality === quality && collection.entries.some(e => e.monsterId === m.id && !e.isShiny)
    ).length;
    return [label, collected, total];
  });
}

function findRarestMonster(collection: UserCollection): Monster | null {
  const qualityPriority = ['legendary', 'epic', 'rare', 'fine', 'normal'];

  for (const quality of qualityPriority) {
    const entry = collection.entries.find(e => {
      const monster = getMonsterById(e.monsterId);
      return monster?.quality === quality;
    });
    if (entry) {
      return getMonsterById(entry.monsterId) ?? null;
    }
  }

  return null;
}
