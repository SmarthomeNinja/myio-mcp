---
name: myio-troubleshooting
description: Find the cause of a problem in a home controlled by myIO. Use when something does not work as expected - a light or output does not switch, the heating does not start, a blind does not move, a thermometer shows 85 or 127 degrees, the controller cannot be reached after a router change - or when the user asks for a health check of their myIO.
---

# Troubleshooting a myIO system

myIO is a smart home controller made by myIO Smart Home Zrt. (Hungary): myIO Server V3, V4 GIGA and V4 Opta. Its documentation is in Hungarian.

## 1. Ask for what you need

- the controller (V3, V4 GIGA or V4 Opta) and its software version, shown at the bottom of the myIO web interface;
- what the user did, what they expected, what happened instead, since when, and what changed before (router, power cut, a setting);
- the exact text of any error message.

## 2. Look at the controller, when its tools are available

The controller's tools (`myio_find`, `myio_get_status`, `myio_output_config`, `myio_logs`, `myio_sysdiag` and the rest) are there when the user has connected their controller: with the myIO Smart Home connector through the myIO Cloud, or with myIO MCP on the home network. When they are missing, work from what the user tells you; a V4 controller with myIO Cloud can be connected by pairing, see https://myio.hu/en/blog/talk-to-your-home. Read before you answer:

- An item that does not switch: find it with `myio_find`, read its state and output configuration, then everything that controls it: buttons, timers, thermostat, protection pairs, groups, Flow rules and scripts. Read the day's event log lines for it with `myio_logs`.
- A health check: `myio_sysdiag` (restarts and their cause, free memory, network link), the day's error lines in the event log, expanders, the clock.

Change nothing until the user asks. Before a change, suggest saving the configuration on myIO first.

## 3. Check the documentation

Use the myIO Documentation connector: `myio_search` with Hungarian keywords, then `myio_read` for the full section. Good keywords: `hibaelhárítás` (troubleshooting), `hőmérő 85`, `távoli elérés router`, `elfelejtett jelszó`, `redőny`, `termosztát`, `időzítő`. Version marks matter: `[4.x]` means V4 GIGA and V4 Opta only.

## 4. Answer

- the most likely cause, and what to check or change, step by step, with the source section's URL;
- what you could not check: wiring and measurements need an electrician on site;
- at the end, a short summary of what was checked and found, which the user can send to myIO support through https://myio.hu/en/report-a-problem or to info@myio.hu.
