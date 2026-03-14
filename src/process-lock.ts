/**
 * 进程锁机制，防止同一个账号被多个进程同时监控
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const LOCK_DIR = path.join(os.homedir(), '.openclaw', 'locks');

/**
 * 获取锁文件路径
 */
function getLockFilePath(accountId: string): string {
  return path.join(LOCK_DIR, `dingtalk-${accountId}.lock`);
}

/**
 * 尝试获取进程锁
 * @returns 如果成功获取锁，返回 true；如果锁已被占用，返回 false
 */
export function acquireProcessLock(accountId: string): boolean {
  try {
    // 确保锁目录存在
    if (!fs.existsSync(LOCK_DIR)) {
      fs.mkdirSync(LOCK_DIR, { recursive: true });
    }

    const lockFile = getLockFilePath(accountId);
    const currentPid = process.pid;

    // 检查锁文件是否存在
    if (fs.existsSync(lockFile)) {
      // 读取锁文件中的 PID
      const lockedPid = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);

      // 检查该进程是否还在运行
      try {
        process.kill(lockedPid, 0); // 发送信号 0 检查进程是否存在
        // 进程存在，锁被占用
        console.error(`[ProcessLock] 账号 ${accountId} 已被进程 ${lockedPid} 锁定`);
        return false;
      } catch (err) {
        // 进程不存在，清理旧锁
        console.warn(`[ProcessLock] 清理僵尸锁: ${lockFile} (PID: ${lockedPid})`);
        fs.unlinkSync(lockFile);
      }
    }

    // 写入当前进程的 PID
    fs.writeFileSync(lockFile, currentPid.toString(), 'utf-8');
    console.log(`[ProcessLock] 成功获取锁: ${accountId} (PID: ${currentPid})`);
    return true;
  } catch (err: any) {
    console.error(`[ProcessLock] 获取锁失败: ${err.message}`);
    return false;
  }
}

/**
 * 释放进程锁
 */
export function releaseProcessLock(accountId: string): void {
  try {
    const lockFile = getLockFilePath(accountId);
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log(`[ProcessLock] 释放锁: ${accountId}`);
    }
  } catch (err: any) {
    console.error(`[ProcessLock] 释放锁失败: ${err.message}`);
  }
}

/**
 * 注册进程退出时自动释放锁
 */
export function registerLockCleanup(accountId: string): void {
  const cleanup = () => {
    releaseProcessLock(accountId);
  };

  // 监听各种退出信号
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', (err) => {
    console.error('[ProcessLock] 未捕获的异常:', err);
    cleanup();
    process.exit(1);
  });
}
