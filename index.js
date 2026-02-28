#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Agent, setGlobalDispatcher } from 'undici';

// Create an agent that ignores TLS/SSL issues (for Proxmox self-signed certs)
const agent = new Agent({
    connect: {
        rejectUnauthorized: false,
    },
});
setGlobalDispatcher(agent);

// --- Proxmox API helper & error formatting ---
async function callProxmox(endpoint, method = 'GET', body = null) {
    const base = process.env.PROXMOX_URL?.replace(/\/$/, '') ?? '';
    const url = `${base}/${endpoint.replace(/^\//, '')}`;
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: process.env.PROXMOX_TOKEN ?? '',
            ...(body && { 'Content-Type': 'application/json' }),
        },
        body: body ? JSON.stringify(body) : null,
    });
    if (!response.ok) {
        const errorText = await response.text();
        const err = new Error(`HTTP ${response.status}: ${errorText}`);
        err.status = response.status;
        err.body = errorText;
        console.error(`[Proxmox API] ${method} ${endpoint}: ${response.status} ${errorText.slice(0, 200)}`);
        throw err;
    }
    return response.json();
}

function formatProxmoxError(error) {
    if (error.status === 401) {
        return 'Proxmox API returned 401 Unauthorized. Token expired or invalid — check PROXMOX_TOKEN and re-run your setup script if needed.';
    }
    if (error.status === 403) {
        return "Proxmox API returned 403 Forbidden. Token doesn't have permission for this action.";
    }
    if (error.status >= 500) {
        return `Proxmox server error (${error.status}). Host may be overloaded or the service down.`;
    }
    if (error.status) {
        return `Proxmox API error (${error.status}): ${(error.body || error.message).slice(0, 300)}`;
    }
    const code = error.cause?.code ?? error.code;
    if (code === 'ECONNREFUSED') {
        return 'Proxmox host unreachable (connection refused). Host down, wrong port, or firewall blocking.';
    }
    if (code === 'ETIMEDOUT') {
        return 'Proxmox host unreachable (timeout). Host down or network issue.';
    }
    if (code === 'ENOTFOUND') {
        return 'Proxmox host not found (DNS failed). Check PROXMOX_URL hostname.';
    }
    return `Proxmox request failed: ${error.message}`;
}

// Create the server instance
const server = new McpServer({
    name: 'proxmox-manager',
    version: '1.0.0',
});

// Tool: Get Status
server.tool(
    'get_lxc_status',
    'Gets the current status of a Proxmox LXC container',
    {
        vmid: z.string().describe('The VMID (e.g., 101)'),
        node: z.string().default('pve').describe('The node name'),
    },
    async ({ vmid, node }) => {
        try {
            const data = await callProxmox(`nodes/${node}/lxc/${vmid}/status/current`);
            return {
                content: [{ type: 'text', text: JSON.stringify(data.data, null, 2) }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: formatProxmoxError(error) }],
                isError: true,
            };
        }
    },
);

// Tool: Control Power
server.tool(
    'set_lxc_state',
    'Starts or stops a Proxmox LXC container',
    {
        vmid: z.string(),
        state: z.enum(['start', 'stop']),
        node: z.string().default('pve'),
    },
    async ({ vmid, state, node }) => {
        try {
            await callProxmox(`nodes/${node}/lxc/${vmid}/status/${state}`, 'POST');
            return {
                content: [{ type: 'text', text: `Successfully sent ${state} command to LXC ${vmid}` }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: formatProxmoxError(error) }],
                isError: true,
            };
        }
    },
);

// Tool: List All Resources
server.tool('list_all_resources', 'Lists all VMs, LXCs, and Storage pools on the cluster', {}, async () => {
    try {
        const data = await callProxmox('cluster/resources');
        return {
            content: [{ type: 'text', text: JSON.stringify(data.data, null, 2) }],
        };
    } catch (error) {
        return {
            content: [{ type: 'text', text: formatProxmoxError(error) }],
            isError: true,
        };
    }
});

// Tool: Resource health summary (memory, swap, IO)
server.tool(
    'get_resource_health',
    'Reports memory, swap, and disk IO for a VM or LXC. Use this to spot thrashing (high RAM + swap + IO) before the guest becomes unresponsive.',
    {
        vmid: z.string().describe('The VMID (e.g., 101)'),
        node: z.string().default('pve').describe('The node name'),
        type: z.enum(['lxc', 'qemu']).default('lxc').describe('Type of guest: lxc or qemu'),
    },
    async ({ vmid, node, type }) => {
        try {
            const path = type === 'lxc'
                ? `nodes/${node}/lxc/${vmid}/status/current`
                : `nodes/${node}/qemu/${vmid}/status/current`;
            const res = await callProxmox(path);
            const { data } = res;
            const mem = Number(data.mem ?? 0);
            const maxmem = Number(data.maxmem ?? 1);
            const swap = Number(data.swap ?? 0);
            const maxswap = Number(data.maxswap ?? 0);
            const memPct = maxmem > 0 ? Math.round((mem / maxmem) * 100) : 0;
            const swapPct = maxswap > 0 ? Math.round((swap / maxswap) * 100) : null;
            const formatBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
            const lines = [
                `VMID ${vmid} (${type}) on ${node} — ${data.status ?? 'unknown'}`,
                `Memory: ${formatBytes(mem)} / ${formatBytes(maxmem)} (${memPct}%)`,
            ];
            if (maxswap > 0) lines.push(`Swap:   ${formatBytes(swap)} / ${formatBytes(maxswap)} (${swapPct}%)`);
            lines.push(`Disk R/W: ${formatBytes(data.diskread ?? 0)} / ${formatBytes(data.diskwrite ?? 0)}`);
            if (data.uptime) lines.push(`Uptime: ${Math.round(Number(data.uptime) / 3600)}h`);
            const warnings = [];
            if (memPct >= 90) warnings.push('high memory');
            if (swapPct !== null && swapPct >= 90) warnings.push('swap nearly full');
            if (warnings.length) lines.push(`\n⚠️ Consider: ${warnings.join(' and ')} — risk of thrashing if both are high.`);
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        } catch (error) {
            return {
                content: [{ type: 'text', text: formatProxmoxError(error) }],
                isError: true,
            };
        }
    },
);

// Tool: Get Task Logs
server.tool(
    'get_task_logs',
    'Fetches logs for a specific Proxmox task (UPID) to diagnose failures',
    {
        upid: z.string().describe('The Unique Process ID of the task'),
        node: z.string().default('pve'),
    },
    async ({ upid, node }) => {
        try {
            const data = await callProxmox(`nodes/${node}/tasks/${upid}/log`);
            const logOutput = data.data.map((entry) => entry.t).join('\n');
            return {
                content: [{ type: 'text', text: logOutput || 'No log entries found for this task.' }],
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: formatProxmoxError(error) }],
                isError: true,
            };
        }
    },
);

// Initialize transport
const transport = new StdioServerTransport();

// Verbose Start-up Message (Using stderr to avoid breaking the MCP protocol)
console.error(`[${new Date().toISOString()}] 🚀 Proxmox MCP Server Starting...`);
console.error(`[INFO] URL: ${process.env.PROXMOX_URL}`);
console.error(`[INFO] Token: ${process.env.PROXMOX_TOKEN ? 'REDACTED (Present)' : 'MISSING'}`);

try {
    await server.connect(transport);
    console.error(`[SUCCESS] Proxmox MCP Server is now listening on stdin.`);
} catch (error) {
    console.error(`[FATAL] Failed to connect: ${error.message}`);
    process.exit(1);
}
