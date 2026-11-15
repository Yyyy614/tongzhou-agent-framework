try {
    await import('./start.mjs');
} catch (error) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const { homedir } = await import('node:os');
    const directory = resolve(process.env.LOCALAPPDATA ?? homedir(), 'CompanyAgentFramework', 'logs');
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'last-start-error.txt'), new Date().toISOString() + '\n' + String(error.code ?? 'START_FAILED') + '\n' + String(error.message ?? '启动失败').slice(0, 1000));
    console.error('公司 Agent 启动未完成。请查看本机应用数据目录 CompanyAgentFramework/logs/last-start-error.txt。');
    process.exitCode = 1;
}
