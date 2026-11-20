# myIO Smart Home for Cursor

Work with a myIO smart home controller from Cursor: read and control your own controller on your home network, answers from the official myIO documentation, and step-by-step troubleshooting.

myIO is a smart home controller developed in Hungary by myIO Smart Home Zrt.: one controller for heating and cooling, lighting, blinds and more. See https://myio.hu/en/.

## What the plugin contains

| Part | What it does |
|---|---|
| **myIO MCP** (local MCP server, started with `npx -y myio-mcp`) | The free, open-source server in this repository. It runs on your computer and reaches your controller over the home network through its HTTP API: temperatures, outputs, inputs and energy; switching, blinds and thermostat targets; names, timers, scenes and settings; Flow rules and scripts; logs and diagnostics. Works with every myIO controller: V3, V4 GIGA and V4 Opta. |
| **myIO Documentation** (remote MCP server, `https://docs-mcp.myio.hu/mcp`) | Searches and reads the myIO manual, the API reference, the FAQ and the product data. Read-only, no sign-in. |
| **Skills** `myio-troubleshooting` and `myio-how-to` | The steps the agent follows when it looks for the cause of a problem and when it explains how to set something up. |

Everything in the plugin is free. myIO MCP needs Node.js 18 or newer on your computer (for `npx`).

## Configuration

Set these plugin variables (**Plugins → Configure**):

| Variable | What to enter |
|---|---|
| `MYIO_BASE_URL` | Address of your controller on the home network, e.g. `http://192.168.1.178` |
| `MYIO_USERNAME` | A myIO user name. Create a separate myIO user for the assistant: its permission level limits what the tools can do. |
| `MYIO_PASSWORD` | Password of that myIO user |
| `MYIO_WRITE` | What the assistant may change: `read` (nothing), `state` (switch outputs, thermostat targets, blinds; the default), `config` (names, timers, scenes, output and input settings too) or `admin` (users and permissions too) |

The documentation and the skills work without a controller. More options of myIO MCP (several controllers, tool groups, timeouts) are in the [repository README](https://github.com/SmarthomeNinja/myio-mcp#configuration).

## Use it

Ask the way you would ask a person, for example:

- "How warm is it in the house right now, room by room?"
- "Switch on the study lamp and lower the blinds upstairs."
- "The living room light does not switch from the wall button. Find out why."
- "How do I set up a blind with two buttons in myIO?"
- "How do I read the myIO controller's state over its HTTP API?"

The documentation is mostly in Hungarian; the agent searches it in Hungarian and answers in your language.

## What data goes where

- **myIO MCP** runs on your computer and talks to your controller directly on the home network. What the agent reads to answer you (for example temperatures and output names) reaches the AI model's provider, like the rest of the conversation.
- **myIO Documentation** sends the search words and the ids of the sections it reads to myIO's server at docs-mcp.myio.hu, which runs on Cloudflare. We do not save the search words; Cloudflare's operating log keeps the time and outcome of the requests for at most one week.

The details are in the privacy policy: https://myio.hu/en/privacy

## Support

info@myio.hu · https://myio.hu/en/support · issues: https://github.com/SmarthomeNinja/myio-mcp/issues

## License

MIT, see [LICENSE](LICENSE).
