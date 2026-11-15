import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// port: 0 can allocate Fetch-blocked ports on hosts with a low dynamic range.
// Bind the real HTTP server directly: do not reserve and release a port first.
export async function listenHttp(server: FastifyInstance, firstPort?: number) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 32; attempt++) {
        const port = attempt === 0 && firstPort !== undefined ? firstPort : randomInt(49152, 65536);
        if (!Number.isInteger(port) || port < 49152 || port > 65535)
            throw new RangeError('Test HTTP ports must be integers in 49152..65535');
        try { return await server.listen({ host: '127.0.0.1', port }); }
        catch (error) {
            const fault = error as NodeJS.ErrnoException;
            if (fault?.syscall !== 'listen' || fault.code !== 'EADDRINUSE' && fault.code !== 'EACCES') throw error;
            lastError = error;
        }
    }
    throw new Error('Could not bind an available loopback HTTP test port', { cause: lastError });
}
