export class FrameworkError extends Error {
    constructor(public readonly code: string, message: string, public readonly details?: unknown) { super(message); this.name = 'FrameworkError'; }
}
export function fail(code: string, message: string, details?: unknown): never { throw new FrameworkError(code, message, details); }
/** Only trusted admission code creates this: execution has definitely not started. */
export class AdmissionBusyError extends FrameworkError {}
/** Trusted host evidence that the operation never reached its execution boundary. */
export class ActionNotStartedError extends FrameworkError {}
