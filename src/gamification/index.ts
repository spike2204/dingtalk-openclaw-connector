/**
 * 西游妖魔榜养成系统 · 入口
 *
 * GamificationEngine 是养成系统的门面类，统一协调所有子系统。
 * 对外暴露两个核心方法：
 * - onDwsCommandResult(): 每次 dws CLI 命令执行后调用（成功或失败）
 * - handleCommand(): 处理聊天命令（/修行 /图鉴 等）
 */

import { createHash } from 'crypto';
import { resolveUid, getShortUid } from './uid-resolver.ts';
import { loadProfile, saveProfile, loadCollection, saveCollection, loadHistory, saveHistory } from './storage.ts';
import { calculateExp, updateSignInStatus } from './exp-calculator.ts';
import { checkLevelUp, applyLevelUp } from './level-system.ts';
import { executeDrop } from './drop-engine.ts';
import { checkEncounter, applyEncounterEffects } from './encounter-system.ts';
import { checkAchievements, triggerSpecialAchievement } from './achievement-engine.ts';
import {
  renderDropResult, renderLevelUp, renderEncounter,
  renderNewAchievements,
} from './renderer.ts';
import { isGamificationCommand, handleGamificationCommand } from './commands.ts';
import type {
  UserProfile, UserCollection, UserHistory,
  GamificationOutput, HistoryRecord, CollectionEntry,
} from './types.ts';

// ============ 单例 ============

let engineInstance: GamificationEngine | null = null;

export class GamificationEngine {
  private profile: UserProfile;
  private collection: UserCollection;
  private history: UserHistory;
  private uidHash: string;

  private constructor(senderId?: string) {
    this.uidHash = resolveUid(senderId);
    this.profile = loadProfile(this.uidHash);
    this.collection = loadCollection(this.uidHash);
    this.history = loadHistory(this.uidHash);
  }

  /**
   * 获取或创建引擎实例
   */
  static getInstance(senderId?: string): GamificationEngine {
    const uidHash = resolveUid(senderId);

    // 如果 senderId 变了（不同用户），重新创建实例
    if (!engineInstance || engineInstance.uidHash !== uidHash) {
      engineInstance = new GamificationEngine(senderId);
    }

    return engineInstance;
  }

  /**
   * 强制重新加载数据（用于多用户场景）
   */
  static getInstanceForUser(senderId: string): GamificationEngine {
    return new GamificationEngine(senderId);
  }

  /**
   * 检查养成系统是否启用
   */
  isEnabled(): boolean {
    return this.profile.settings.enabled;
  }

  /**
   * 检查消息是否是养成系统命令
   */
  isCommand(text: string): boolean {
    return isGamificationCommand(text);
  }

  /**
   * 处理聊天命令，返回 Markdown 响应
   */
  handleCommand(text: string): string | null {
    return handleGamificationCommand(
      text,
      this.profile,
      this.collection,
      () => this.save()
    );
  }

  /**
   * dws CLI 命令执行后调用（核心方法）
   *
   * @param product - dws 产品名（如 "aitable"、"calendar"）
   * @param success - 命令是否成功
   * @param commandStr - 原始命令字符串（用于生成 hash）
   * @param isRecovery - 是否为 recovery 成功
   * @returns Markdown 字符串（追加到 agent 回复末尾），或空字符串
   */
  onDwsCommandResult(
    product: string,
    success: boolean,
    commandStr: string = '',
    isRecovery: boolean = false
  ): string {
    if (!this.isEnabled()) return '';

    const commandHash = createHash('sha256').update(commandStr).digest('hex').slice(0, 16);

    // 处理失败情况
    if (!success) {
      this.profile.currentCombo = 0;
      this.profile.consecutiveFailures += 1;
      this.save();
      return '';
    }

    // ===== 以下为成功执行的处理 =====

    // 1. 更新基础统计
    this.profile.totalOperations += 1;
    this.profile.currentCombo += 1;
    if (this.profile.currentCombo > this.profile.maxCombo) {
      this.profile.maxCombo = this.profile.currentCombo;
    }
    this.profile.productUsage[product] = (this.profile.productUsage[product] ?? 0) + 1;

    if (isRecovery) {
      this.profile.totalRecoveries += 1;
    }

    // 2. 更新签到状态
    updateSignInStatus(this.profile);

    // 3. 计算修行值
    const expResult = calculateExp(product, this.profile);

    // 4. 检查升级
    const levelUp = checkLevelUp(this.profile, expResult.totalExp);

    // 5. 应用修行值
    this.profile.totalExp += expResult.totalExp;
    applyLevelUp(this.profile);

    // 6. 执行掉落
    const dropResult = executeDrop(product, this.profile, this.collection);
    dropResult.expGained = expResult.totalExp;

    // 7. 更新图鉴
    this.updateCollection(dropResult.monster.id, dropResult.isShiny, commandHash);

    // 8. 检查机缘
    const encounter = checkEncounter(this.profile);
    if (encounter) {
      applyEncounterEffects(this.profile, encounter);
    }

    // 9. 获取今日记录用于成就判定
    const today = new Date().toISOString().slice(0, 10);
    const todayRecords = this.history.records.filter(r => {
      const recordDate = new Date(r.timestamp).toISOString().slice(0, 10);
      return recordDate === today;
    });

    // 10. 检查成就
    const newAchievements = checkAchievements(this.profile, this.collection, todayRecords);

    // 特殊成就：保底触发
    if (dropResult.isPityTriggered) {
      const pityAchievement = triggerSpecialAchievement(this.profile, 'A302');
      if (pityAchievement) {
        newAchievements.push(pityAchievement);
      }
    }

    // 特殊成就：屡败屡战
    if (this.profile.consecutiveFailures >= 10) {
      const failAchievement = triggerSpecialAchievement(this.profile, 'A303');
      if (failAchievement) {
        newAchievements.push(failAchievement);
      }
    }

    // 成就修行值奖励
    for (const achievement of newAchievements) {
      this.profile.totalExp += achievement.expReward;
    }
    // 成就可能导致再次升级
    applyLevelUp(this.profile);

    // 重置连续失败计数
    this.profile.consecutiveFailures = 0;

    // 11. 记录历史
    const historyRecord: HistoryRecord = {
      timestamp: Date.now(),
      product,
      commandHash,
      success: true,
      expGained: expResult.totalExp,
      monsterId: dropResult.monster.id,
      isShiny: dropResult.isShiny,
      encounterId: encounter?.immortalId,
      achievementIds: newAchievements.map(a => a.id),
    };
    this.history.records.push(historyRecord);

    // 12. 持久化
    this.save();

    // 13. 渲染输出
    return this.renderOutput(dropResult, expResult, levelUp, encounter, newAchievements);
  }

  /**
   * 更新图鉴
   */
  private updateCollection(monsterId: string, isShiny: boolean, commandHash: string): void {
    const existingEntry = this.collection.entries.find(
      e => e.monsterId === monsterId && e.isShiny === isShiny
    );

    if (existingEntry) {
      existingEntry.captureCount += 1;
    } else {
      const newEntry: CollectionEntry = {
        monsterId,
        firstCapturedAt: Date.now(),
        captureCount: 1,
        isShiny,
      };
      this.collection.entries.push(newEntry);
    }
  }

  /**
   * 渲染完整输出（追加到 agent 回复末尾的 Markdown）
   */
  private renderOutput(
    dropResult: any,
    expResult: any,
    levelUp: any,
    encounter: any,
    newAchievements: any[]
  ): string {
    const parts: string[] = [];

    // 掉落结果（如果设置了静默普通掉落，则跳过）
    const shouldShowDrop = !(
      this.profile.settings.muteNormalDrops &&
      dropResult.monster.quality === 'normal' &&
      !dropResult.isNew &&
      !dropResult.isShiny
    );

    if (shouldShowDrop) {
      parts.push(renderDropResult(dropResult, expResult, this.collection));
    }

    // 升级通知
    if (levelUp) {
      parts.push(renderLevelUp(levelUp));
    }

    // 机缘事件
    if (encounter) {
      parts.push(renderEncounter(encounter));
    }

    // 新成就
    if (newAchievements.length > 0) {
      parts.push(renderNewAchievements(newAchievements));
    }

    return parts.join('\n');
  }

  /**
   * 持久化所有数据
   */
  private save(): void {
    saveProfile(this.profile);
    saveCollection(this.collection);
    saveHistory(this.history);
  }
}

// ============ 便捷导出 ============

export { isGamificationCommand } from './commands.ts';
export type { GamificationOutput } from './types.ts';
