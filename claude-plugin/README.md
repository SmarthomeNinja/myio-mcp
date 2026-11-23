# myIO Smart Home for Claude

Work with a myIO smart home controller from Claude: answers from the official myIO documentation, step-by-step troubleshooting, and reading and controlling your own controller through the myIO Cloud.

myIO is a smart home controller developed in Hungary by myIO Smart Home Zrt.: one controller for heating and cooling, lighting, blinds and more. See https://myio.hu/en/.

## What the plugin contains

| Part | What it does | Where it works |
|---|---|---|
| **myIO Documentation** (remote MCP server, `https://docs-mcp.myio.hu/mcp`) | Searches and reads the myIO manual, the API reference, the FAQ and the product data. Read-only, no sign-in. | Claude chat, Cowork, Claude Code |
| **myIO Smart Home** (remote MCP server, `https://mcp.myio.hu/mcp`) | Reaches your own myIO controller through the myIO Cloud, from anywhere: temperatures, outputs, inputs and energy; switching, blinds and thermostat targets; names, timers, scenes and settings; logs and diagnostics. You sign in by pairing it with your controller. | Claude chat, Cowork, Claude Code |
| **Skills** `myio-troubleshooting` and `myio-how-to` | The steps Claude follows when it looks for the cause of a problem and when it explains how to set something up. | Claude chat, Cowork, Claude Code |

Both servers are remote: the plugin installs and starts no program on your computer.

## Use it

Ask the way you would ask a person, for example:

- "How do I set up a blind with two buttons in myIO?"
- "A thermometer on my myIO shows 85 degrees. What does that mean?"
- "The living room light does not switch from the wall button. Find out why." (with your controller connected)
- "Run a health check of my myIO." (with your controller connected)

The documentation is mostly in Hungarian; Claude searches it in Hungarian and answers in your language.

## Connect your controller

The documentation and the skills work straight away. To let Claude look at your own controller, connect **myIO Smart Home**: in Claude chat and Cowork on the plugin's **Connectors** tab, in Claude Code with `/mcp`. The myIO authorization page opens.

1. **Pair it with your controller.** On the controller's service display open the Cloud page, or open the myIO Cloud page in its web interface, and ask for a new code. Type the six-character code into the authorization page; the code lives for 5 minutes. Claude then works with the permissions of the controller's own "AI" user. To use another myIO user's permissions instead, start pairing for that user on the myIO Cloud page (the admin cannot be chosen) and paste the pairing link it shows in place of the code.
2. **Choose what Claude may do.** Read only, switch (outputs, blinds, thermostat targets), or change settings too.

What you need: a myIO V4 controller (GIGA or Opta) with a myIO Cloud subscription and firmware 4.26 or newer. There is no separate account and no password to enter.

You can end the connection at any time: delete its key on the controller's myIO Cloud page. Through the cloud Claude cannot reach users, network settings, myIO Cloud settings or passwords, and it writes no files to the controller. Claude asks before it calls a tool that changes something, unless you allow it.

The full guide: https://myio.hu/en/blog/talk-to-your-home

## Without the myIO Cloud, on your home network

myIO MCP is the free, open-source local server in this repository. It works with every myIO controller (V3, V4 GIGA and V4 Opta) over the home network, and it is not part of this plugin. In the Claude desktop app, install it as a desktop extension (`.mcpb`) from the [myIO Downloads](https://myio.hu/en/downloads) page; for Claude Code and other MCP clients, see the [repository README](https://github.com/SmarthomeNinja/myio-mcp#readme). Its tools have the same names, so both skills work with it too.

## What data goes where

- **myIO Documentation** sends Claude's search words and the ids of the sections it reads to myIO's server at docs-mcp.myio.hu, which runs on Cloudflare. We do not save the search words; Cloudflare's operating log keeps the time and outcome of the requests for at most one week.
- **myIO Smart Home** sends what Claude asks of your controller to myIO's server at mcp.myio.hu, which passes it on through the myIO Cloud. Every command is signed with the connection's own key and checked by the controller. The server stores the pairing data, the connection's key, the sign-in tokens (as fingerprints), the last 200 commands of the connection, and an operating log of when a command or a read went to which controller. The controller's answers are kept in memory only, for as long as a reply needs them. Entries of the operating log are deleted after 30 days, and everything else when the connection ends. The server runs on a Rackhost machine in Hungary, and its traffic reaches it through Cloudflare's network.
- What you tell Claude is covered by Anthropic's terms.

The details are in the privacy policy: https://myio.hu/en/privacy

## Support

info@myio.hu · https://myio.hu/en/support · issues: https://github.com/SmarthomeNinja/myio-mcp/issues

## License

MIT, see [LICENSE](LICENSE).
