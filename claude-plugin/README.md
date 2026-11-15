# myIO Smart Home for Claude

Work with a myIO smart home controller from Claude: answers from the official myIO documentation, step-by-step troubleshooting and, in Claude Code, reading and controlling your own controller.

myIO is a smart home controller developed in Hungary by myIO Smart Home Zrt.: one controller for heating and cooling, lighting, blinds and more. See https://myio.hu/en/.

## What the plugin contains

| Part | What it does | Where it works |
|---|---|---|
| **myIO Documentation** (remote MCP server, `https://docs-mcp.myio.hu/mcp`) | Searches and reads the myIO manual, the API reference, the FAQ and the product data. Read-only, no sign-in. | Claude chat, Cowork, Claude Code |
| **myIO MCP** (local MCP server, npm package [`myio-mcp`](https://www.npmjs.com/package/myio-mcp) 1.6.2, open source in this repository) | Reads and controls your own myIO controller over your home network: outputs, heating, blinds, timers, scenes, Flow rules, scripts, the event log and diagnostics. | Claude Code |
| **Skills** `myio-troubleshooting` and `myio-how-to` | The steps Claude follows when it looks for the cause of a problem and when it explains how to set something up. | Claude chat, Cowork, Claude Code |

## Use it

Ask the way you would ask a person, for example:

- "How do I set up a blind with two buttons in myIO?"
- "A thermometer on my myIO shows 85 degrees. What does that mean?"
- "The living room light does not switch from the wall button. Find out why." (Claude Code, with your controller connected)
- "Run a health check of my myIO." (Claude Code, with your controller connected)

The documentation is mostly in Hungarian; Claude searches it in Hungarian and answers in your language.

## Connect your controller (Claude Code)

When you enable the plugin, Claude Code asks for:

- **myIO controller URL**, for example `http://192.168.1.178`;
- **myIO user name** and **password**. The password is kept in your system's secure credential store. Use a myIO user whose permissions match what Claude may do: Claude can only do what that user is allowed to;
- **Write level**: `state` (default; switch only), `config` (also settings) or `admin` (also users, network and updates);
- **Tool groups** (optional, default `all`), to load fewer tools.

**Several controllers:** fill in *Several controllers* with a JSON array, for example `[{"name":"Ground floor","url":"http://192.168.1.178","username":"admin","password":"..."},{"name":"First floor","url":"http://192.168.1.177","username":"admin","password":"..."}]`, and leave the single URL empty. Claude then names the controller in each request.

**From outside your home:** the best way is your router's VPN, so your computer is part of the home network. A port-forwarded address (for example a DDNS name) also works, but the connection is not encrypted, so use a strong password; the controller also answers remote clients' heavier requests at most every few seconds.

The local server needs Node.js 18 or later. Claude asks before it calls a tool that changes something, unless you allow it.

**In the Claude desktop app's chat**, plugins don't start local servers; there, install myIO MCP as a desktop extension (`.mcpb`) from the [myIO Downloads](https://myio.hu/en/downloads) page instead.

## What data goes where

- **myIO Documentation** sends Claude's search words and the ids of the sections it reads to myIO's server at docs-mcp.myio.hu, which runs on Cloudflare. We do not save the search words; Cloudflare's operating log keeps the time and outcome of the requests for at most one week. Privacy policy: https://myio.hu/en/privacy
- **myIO MCP** runs on your computer. On first start, `npx` downloads the `myio-mcp` package from the npm registry. The server then talks only to the controller address you entered, with the user name and password you gave it. It sends nothing to myIO Smart Home Zrt. or anyone else.
- What you tell Claude is covered by Anthropic's terms.

## Support

info@myio.hu · https://myio.hu/en/support · issues: https://github.com/SmarthomeNinja/myio-mcp/issues

## License

MIT, see [LICENSE](LICENSE).
