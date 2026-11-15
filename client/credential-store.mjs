import { spawn } from 'node:child_process';

// Windows' built-in DPAPI binds the identity to the signed-in OS user.
// Prefer PowerShell 7; the preinstalled Windows PowerShell is a portable-client
// compatibility fallback, with the same DPAPI cmdlets and no extra installation.
async function secureString(mode, value, shell = 'pwsh.exe') {
    const expression = mode === 'encrypt'
        ? '$value | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString'
        : '$secure = ConvertTo-SecureString $value; $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }';
    const command = '[Console]::InputEncoding = [Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference="Stop"; $value=[Console]::In.ReadToEnd().Trim(); ' + expression;
    return new Promise((resolve, reject) => {
        const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('Windows credential protection timed out')); }, 15000);
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 16000) child.kill(); });
        child.stderr.resume();
        child.on('error', error => { clearTimeout(timer); if (error.code === 'ENOENT' && shell === 'pwsh.exe') secureString(mode, value, 'powershell.exe').then(resolve, reject); else reject(new Error('Windows credential protection is unavailable')); });
        child.on('close', code => { clearTimeout(timer); if (code === 0 && output.trim() && output.length < 16000) resolve(output.trim()); else if (code !== -4058) reject(new Error('Windows credential protection failed')); });
        child.stdin.on('error', () => {});
        child.stdin.end(value);
    });
}
export const windowsProtection = {
    encrypt: value => { if (process.platform !== 'win32') throw new Error('This employee client requires Windows'); return secureString('encrypt', value); },
    decrypt: value => secureString('decrypt', value),
};
