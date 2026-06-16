# Platform Support

Pi Web UI is a **self-hosted agent workspace**, not just a static web app.

That means platform support is shaped by more than Node.js. It also depends on:
- runtime CLIs installed on the same machine
- local auth state for those CLIs
- long-running local processes
- Unix-style paths and sockets
- how persistently you want the system to stay available

## Support tiers

### Tier 1 — Linux
This is the primary target.

Linux is the best fit for:
- local development
- home-server use
- VPS deployment
- long-running 24/7 use
- reverse-proxied internet access

Most of the repository's operational assumptions were shaped on Linux:
- systemd examples
- journald/log commands
- Unix sockets
- service-user auth patterns
- runtime file locations

If you want the smoothest path, choose Linux.

### Tier 2 — macOS
macOS is a valid adoption path, especially for:
- local development
- personal use on a workstation
- always-on local-network setups such as a Mac mini acting as a small internal server

Why it is viable:
- it is still a Unix-like environment
- the local automation API uses Unix sockets, which macOS supports
- Node, npm, and many CLI runtimes are straightforward to run on macOS

Caveats:
- some deployment guidance in this repo is Linux-specific
- systemd instructions do not apply
- some runtime/tool combinations are less battle-tested than on Linux
- you may need to translate service-management steps into `launchd`, manual backgrounding, or your own preferred process manager

### Windows
Windows is not a primary target today.

The repo may be partially workable under WSL for advanced users, but the docs do not currently claim native Windows parity.

## Local machine vs always-on server

You can run Pi Web UI on a laptop or desktop when you are actively using it.

But if you want it to behave like a persistent personal agent workspace — for example:
- accessible from multiple devices
- available throughout the day
- able to host longer-running workflows
- ready when you are away from your main desk

— then an always-on machine is the better shape.

Common good options:
- a Linux VPS
- a home Linux server
- a Mac mini or other always-on macOS machine inside your network

## VPS guidance

A VPS can be a very practical choice.

For light workloads such as:
- markdown editing
- smaller coding tasks
- lightweight orchestration
- general browser-based agent usage

you do not need an extreme machine.

For heavier workloads such as:
- bigger builds
- dependency installation
- repo-wide code generation
- multiple concurrent sessions
- long-running agent tool use

you will want more CPU and RAM headroom.

In other words: **size the machine for the workflows, not just for the web app process.**

## Reverse proxy recommendation

The maintainer's preferred production shape uses a reverse proxy in front of Pi Web UI, and **Caddy** is a very good fit for that.

Why Caddy fits well:
- simple HTTPS setup
- good reverse-proxy defaults
- convenient for self-hosted personal services

Nginx is also viable, and the repo documents both approaches.

See [`../DEPLOYMENT.md`](../DEPLOYMENT.md).

## Practical platform recommendations

### If you want the easiest serious setup
Use:
- **Linux**
- one runtime first
- an always-on server if you want persistent availability

### If you want a good personal/local-network setup
Use:
- **macOS or Linux**
- one or two runtimes first
- a machine you can leave on reliably

### If you want mobile access and long-running workflows
Use:
- **Linux VPS or home Linux server**
- a reverse proxy such as **Caddy**
- careful reading of [`../SECURITY.md`](../SECURITY.md)

## Related docs

- [`GETTING-STARTED.md`](./GETTING-STARTED.md)
- [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md)
- [`../DEPLOYMENT.md`](../DEPLOYMENT.md)
- [`../SECURITY.md`](../SECURITY.md)
