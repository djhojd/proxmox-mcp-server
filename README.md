# Proxmox MCP Server

An [MCP](https://modelcontextprotocol.io/) server that exposes your Proxmox VE cluster to AI assistants. List resources, check LXC status, and start/stop containers via natural language.

## Setup

**Requirements:** Node.js **20.6** or later (needed for `--env-file`).

```bash
npm install
```

Create a `.env` file:

```env
PROXMOX_URL=https://your-proxmox-ip:8006/api2/json
PROXMOX_TOKEN=PVEAPIToken=user@realm!token-name=secret
```

Use a [Proxmox API token](https://pve.proxmox.com/wiki/Proxmox_VE_API#API_Tokens) with enough permissions for the actions you need.

**Proxmox setup script:** The [setup-gemini-perms.sh](https://gist.github.com/djhojd/1642df7920528b210d8a0850ea54b641) Gist automates Proxmox setup for API access: it creates the `GeminiAgent` role (with `VM.Audit`, `VM.PowerMgmt`, `Datastore.Audit`, `Sys.Audit`), adds the `gemini-cli@pve` user, applies ACLs at the datacenter root, and creates or rotates the `gemini-token` API token. Run it on your Proxmox node to get the token value for `PROXMOX_TOKEN`.

## Run

```bash
npm start
```

The server uses stdio transport and is intended to be run by an MCP client (e.g. Cursor, Claude Desktop).

## Tools

| Tool | Description |
|------|-------------|
| `list_all_resources` | Lists all VMs, LXCs, and storage on the cluster |
| `get_lxc_status` | Gets the current status of an LXC container (by VMID) |
| `get_resource_health` | Memory, swap, and disk IO summary for a VM/LXC — spot thrashing (high RAM + swap + IO) |
| `set_lxc_state` | Starts or stops an LXC container |
| `get_task_logs` | Fetches logs for a Proxmox task (UPID) |

## License

ISC
